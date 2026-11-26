"""Backtest del motor determinista + reglas duras (sin Claude: no se puede evaluar sin sesgo de futuro).

Cada sesión d, con datos SOLO hasta el cierre de d:
  1. Se ejecutan las órdenes creadas al cierre anterior (límite en retroceso, o ruptura confirmada al cierre).
  2. Se gestionan posiciones con la vela de d: stop (prioridad conservadora si stop y objetivo ocurren el mismo día),
     50% en objetivo 1, resto con trailing (cierre < SMA20), invalidación temporal y salida por fase bajista.
  3. Al cierre de d el motor recalcula fase/plan y el filtro de mercado; se crean órdenes para d+1.
Costos: comisión GBM 0.25% + IVA = 0.29% por lado, más 0.05% de deslizamiento.

  python -m backtest.run_backtest                      # descarga 4 años con yfinance (GitHub Actions)
  python -m backtest.run_backtest --csv DIR            # CSVs locales <TICKER>.csv
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from trend_risk import analyze, Config
from trend_risk.indicators import enrich
from worker.features import snapshot_mercado

COSTO = 0.0029 + 0.0005
SESIONES_TEST = 504          # ~2 años de bolsa


@dataclass
class Orden:
    ticker: str
    tipo: str                # "limite" | "ruptura"
    precio: float
    stop: float
    objetivo: float
    sesiones: int
    peso: float
    fase: str
    rr: float
    vigencia: int = 1        # sesiones que la orden sigue viva si no se ejecuta


@dataclass
class Posicion:
    ticker: str
    tipo: str
    entrada: float
    fecha_entrada: str
    unidades: float
    unidades_ini: float
    stop: float
    objetivo: float
    sesiones: int
    riesgo_inicial: float    # dinero en riesgo al entrar
    rr: float
    fase: str
    dias: int = 0
    t1: bool = False
    flujos: list = field(default_factory=list)   # (fecha, motivo, unidades, precio)
    costo: float = 0.0


def cargar(args, tickers):
    if args.csv:
        out = {}
        for t in tickers:
            p = pathlib.Path(args.csv) / f"{t.replace('^', '')}.csv"
            if p.exists():
                df = pd.read_csv(p, parse_dates=["date"]).set_index("date")
                out[t] = df[["open", "high", "low", "close", "volume"]]
        return out
    import yfinance as yf
    out = {}
    for t in tickers:
        df = yf.download(t, period="4y", interval="1d", auto_adjust=True, progress=False, multi_level_index=False, threads=False)
        if len(df):
            df.columns = [c.lower() for c in df.columns]
            df = df[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
            df["volume"] = df["volume"].fillna(0)
            df.index = pd.to_datetime(df.index).tz_localize(None)
            out[t] = df
        else:
            print(f"[aviso] {t}: sin datos", file=sys.stderr)
    return out


_PLANES: dict = {}
_MERCADO: dict = {}


def plan_en(corte, t, d, cfg):
    k = (t, d, cfg.rr_minimo, cfg.riesgo_por_operacion, cfg.max_posicion)
    if k not in _PLANES:
        try:
            _PLANES[k] = analyze(corte[t], t, cfg).to_dict()
        except Exception:
            _PLANES[k] = None
    return _PLANES[k]


def simular(precios: dict, indices: list, activos: list, cfg: Config, filtro_mercado: bool = True, capital: float = 100_000.0,
            vigencia: int = 1):
    cal = precios["SPY"].index
    cal = cal[-SESIONES_TEST:]
    ind = {t: enrich(df) for t, df in precios.items()}   # indicadores causales: el valor en d solo usa datos <= d
    efectivo, pos, ordenes, trades, curva, log_mkt = capital, {}, [], [], [], []

    def valor(d):
        v = efectivo
        for p in pos.values():
            df = precios[p.ticker]
            c = df["close"].loc[:d].iloc[-1]
            v += p.unidades * c
        return v

    def cerrar(p, d, motivo, unidades, precio):
        nonlocal efectivo
        bruto = unidades * precio
        c = bruto * COSTO
        efectivo += bruto - c
        p.costo += c
        p.unidades -= unidades
        p.flujos.append((str(d.date()), motivo, unidades, precio))
        if p.unidades <= 1e-9:
            ingreso = sum(u * px for _, _, u, px in p.flujos)
            pnl = ingreso - p.unidades_ini * p.entrada - p.costo
            trades.append({"ticker": p.ticker, "tipo": p.tipo, "fase": p.fase, "entrada_fecha": p.fecha_entrada, "salida_fecha": str(d.date()),
                           "entrada": round(p.entrada, 4), "stop": round(p.stop, 4), "objetivo": round(p.objetivo, 4), "rr_plan": p.rr,
                           "dias": p.dias, "t1": p.t1, "salidas": [f[1] for f in p.flujos], "pnl": round(pnl, 2),
                           "r": round(pnl / p.riesgo_inicial, 3) if p.riesgo_inicial else None,
                           "ret_pct": round(100 * pnl / (p.unidades_ini * p.entrada), 3)})
            del pos[p.ticker]

    for d in cal:
        # ---- 1. órdenes pendientes
        nuevas, siguen = [], []
        for o in ordenes:
            df = precios[o.ticker]
            if o.ticker in pos:
                continue
            if d not in df.index:
                siguen.append(o)
                continue
            bar = df.loc[d]
            px = None
            if o.tipo == "limite" and bar.low <= o.precio:
                px = min(bar.open, o.precio)
            elif o.tipo == "ruptura":
                v20 = ind[o.ticker]["vol20"].loc[d]
                if bar.close > o.precio and (not v20 or bar.volume > cfg.vol_confirmacion * v20):
                    px = bar.close
            if px is None or px <= o.stop:
                o.vigencia -= 1
                if o.vigencia > 0 and px is None:
                    siguen.append(o)
                continue
            eq = valor(d)
            monto = min(o.peso * eq, efectivo / (1 + COSTO))
            if monto < 0.005 * eq:
                continue
            u = monto / px
            c = monto * COSTO
            efectivo -= monto + c
            p = Posicion(o.ticker, o.tipo, px, str(d.date()), u, u, o.stop, o.objetivo, o.sesiones, u * (px - o.stop) + 2 * c, o.rr, o.fase, costo=c)
            pos[o.ticker] = p
            nuevas.append(p)
        ordenes = siguen

        # ---- 2. gestión de posiciones con la vela de d
        for p in list(pos.values()):
            df = precios[p.ticker]
            if d not in df.index:
                continue
            bar, e = df.loc[d], ind[p.ticker].loc[d]
            hoy_entrada = p.fecha_entrada == str(d.date())
            if not hoy_entrada:
                p.dias += 1
            if bar.low <= p.stop:                                   # stop primero (conservador)
                cerrar(p, d, "stop", p.unidades, p.stop if hoy_entrada else min(bar.open, p.stop))
                continue
            if not p.t1 and bar.high >= p.objetivo:
                cerrar(p, d, "objetivo1", p.unidades_ini * 0.5, p.objetivo if hoy_entrada else max(bar.open, p.objetivo))
                p.t1 = True
                if p.ticker not in pos:
                    continue
            if p.t1 and bar.close < e.sma20:
                cerrar(p, d, "trailing_sma20", p.unidades, bar.close)
            elif not p.t1 and p.dias >= p.sesiones:
                cerrar(p, d, "tiempo", p.unidades, bar.close)

        # ---- 3. motor al cierre de d -> órdenes para d+1
        corte = {t: df.loc[:d] for t, df in precios.items()}
        corte = {t: df for t, df in corte.items() if len(df) >= 220}
        if d not in _MERCADO:
            _MERCADO[d] = snapshot_mercado(corte, indices, activos, {t: ind[t].loc[:d] for t in corte})
        m = _MERCADO[d]
        expo = m["tope_exposicion_pct"] / 100 if filtro_mercado else 1.0
        rojo = m["rojo_forzado"] if filtro_mercado else False
        log_mkt.append({"fecha": str(d.date()), "tope": m["tope_exposicion_pct"], "rojo": m["rojo_forzado"]})
        eq = valor(d)
        invertido = sum(p.unidades * precios[p.ticker]["close"].loc[:d].iloc[-1] for p in pos.values()) + sum(o.peso * eq for o in ordenes)
        for t in activos:
            if t not in corte or corte[t].index[-1] != d:
                continue
            plan = plan_en(corte, t, d, cfg)
            if plan is None:
                continue
            if t in pos:
                if plan["fase"] == "DISTRIBUCION_O_BAJISTA":
                    cerrar(pos[t], d, "fase_bajista", pos[t].unidades, corte[t]["close"].iloc[-1])
                continue
            if rojo:
                continue
            tipo = None
            if plan["orden"] == "COMPRAR_EN_RETROCESO":
                tipo = "limite"
            elif plan["fase"] == "ACUMULACION" and plan["orden"] == "ESPERAR_MEJOR_TIMING":
                tipo = "ruptura"
            if not tipo or not plan["tamano_posicion_pct"]:
                if plan["fase"] in ("DISTRIBUCION_O_BAJISTA", "TENDENCIA_EXTENDIDA"):
                    ordenes = [o for o in ordenes if o.ticker != t]
                continue
            eq_reserva = sum(o.peso for o in ordenes if o.ticker == t) * eq
            invertido -= eq_reserva
            peso = plan["tamano_posicion_pct"] / 100 * expo
            if invertido / eq + peso > expo + 1e-9:
                peso = max(0.0, expo - invertido / eq)
            if peso < 0.01:
                continue
            ses = int(math.floor(float(next((s for s in plan["invalidacion_temporal"].split() if s.isdigit()), 10))))
            ordenes = [o for o in ordenes if o.ticker != t]          # la orden nueva reemplaza a la anterior
            ordenes.append(Orden(t, tipo, plan["entrada"], plan["stop_loss"], plan["resistencia_1"], ses, peso, plan["fase"], plan["rr"], vigencia))
            invertido += peso * eq

        curva.append({"fecha": str(d.date()), "equity": round(valor(d), 2), "invertido_pct": round(100 * invertido / max(eq, 1), 1)})

    # cerrar lo abierto al final al último cierre
    d = cal[-1]
    for p in list(pos.values()):
        cerrar(p, d, "fin_backtest", p.unidades, precios[p.ticker]["close"].loc[:d].iloc[-1])
    curva[-1]["equity"] = round(efectivo, 2)
    return trades, curva, log_mkt


def metricas(curva, trades, capital=100_000.0):
    eq = pd.Series([c["equity"] for c in curva], index=pd.to_datetime([c["fecha"] for c in curva]))
    ret = eq.pct_change().dropna()
    años = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    dd = (eq / eq.cummax() - 1).min()
    r = [t["r"] for t in trades if t["r"] is not None]
    gan = [t["pnl"] for t in trades if t["pnl"] > 0]
    per = [t["pnl"] for t in trades if t["pnl"] <= 0]
    return {
        "capital_inicial": capital, "capital_final": round(float(eq.iloc[-1]), 2),
        "rendimiento_total_pct": round(100 * (eq.iloc[-1] / capital - 1), 2),
        "cagr_pct": round(100 * ((eq.iloc[-1] / capital) ** (1 / años) - 1), 2),
        "max_drawdown_pct": round(100 * float(dd), 2),
        "sharpe": round(float(ret.mean() / ret.std() * np.sqrt(252)), 2) if ret.std() > 0 else None,
        "operaciones": len(trades), "ganadoras_pct": round(100 * len(gan) / len(trades), 1) if trades else None,
        "r_promedio": round(float(np.mean(r)), 3) if r else None,
        "factor_beneficio": round(sum(gan) / -sum(per), 2) if per and sum(per) < 0 else None,
        "ganancia_media": round(float(np.mean(gan)), 2) if gan else None, "perdida_media": round(float(np.mean(per)), 2) if per else None,
        "exposicion_media_pct": round(float(np.mean([c["invertido_pct"] for c in curva])), 1),
        "dias_promedio": round(float(np.mean([t["dias"] for t in trades])), 1) if trades else None,
    }


def buy_hold(precios, tickers, cal, capital=100_000.0):
    vals = []
    for t in tickers:
        if t not in precios:
            continue
        c = precios[t]["close"].reindex(cal).ffill().bfill()
        vals.append(c / c.iloc[0])
    if not vals:
        return None
    eq = capital * pd.concat(vals, axis=1).mean(axis=1)
    años = (cal[-1] - cal[0]).days / 365.25
    return {"rendimiento_total_pct": round(100 * (eq.iloc[-1] / capital - 1), 2), "cagr_pct": round(100 * ((eq.iloc[-1] / capital) ** (1 / años) - 1), 2),
            "max_drawdown_pct": round(100 * float((eq / eq.cummax() - 1).min()), 2), "curva": [round(float(x), 2) for x in eq]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default="watchlist.json")
    ap.add_argument("--csv")
    ap.add_argument("--out", default="reports/backtest")
    a = ap.parse_args(argv)
    wl = json.loads(pathlib.Path(a.watchlist).read_text())
    indices, activos = wl["indices"], wl["activos"]
    cfg = Config(riesgo_por_operacion=wl.get("riesgo_por_operacion_pct", 1.0) / 100, max_posicion=wl.get("max_posicion_pct", 25) / 100)
    precios = cargar(a, list(dict.fromkeys(indices + activos)))
    faltan = [t for t in activos if t not in precios]
    if "SPY" not in precios:
        sys.exit("Sin SPY no hay backtest.")
    activos = [t for t in activos if t in precios and len(precios[t]) >= 220 + SESIONES_TEST // 2]
    cal = precios["SPY"].index[-SESIONES_TEST:]

    out = {"periodo": {"inicio": str(cal[0].date()), "fin": str(cal[-1].date()), "sesiones": len(cal)},
           "activos": activos, "activos_sin_datos": faltan, "costos_por_lado_pct": round(100 * COSTO, 2),
           "config": {"riesgo_por_operacion_pct": cfg.riesgo_por_operacion * 100, "max_posicion_pct": cfg.max_posicion * 100, "rr_minimo": cfg.rr_minimo}}
    from dataclasses import replace
    variantes = (
        ("con_filtro_mercado", "Tus reglas: R:R ≥ 2, filtro de mercado", True, cfg),
        ("limite_5_sesiones", "Tus reglas, pero la orden límite queda viva 5 sesiones", True, cfg),
        ("sin_filtro_mercado", "Sin filtro de mercado (R:R ≥ 2)", False, cfg),
        ("rr_1_5", "R:R ≥ 1.5 con filtro de mercado (sensibilidad)", True, replace(cfg, rr_minimo=1.5)),
    )
    out["variantes"] = {k: desc for k, desc, _, _ in variantes}
    for nombre, _, filtro, c_ in variantes:
        trades, curva, log_mkt = simular(precios, indices, activos, c_, filtro, vigencia=5 if nombre == "limite_5_sesiones" else 1)
        out[nombre] = {"metricas": metricas(curva, trades), "trades": trades,
                       "curva": [{"fecha": c["fecha"], "equity": c["equity"]} for c in curva]}
        if nombre == "con_filtro_mercado":
            out["mercado_dias_rojo"] = sum(1 for x in log_mkt if x["rojo"])
            out["mercado_tope_medio"] = round(float(np.mean([x["tope"] for x in log_mkt])), 1)
        print(nombre, json.dumps(out[nombre]["metricas"], ensure_ascii=False))
    out["benchmarks"] = {
        "SPY": buy_hold(precios, ["SPY"], cal), "IPC (^MXX)": buy_hold(precios, ["^MXX"], cal),
        "Watchlist igual ponderada": buy_hold(precios, activos, cal),
        "Acciones EE. UU. de la watchlist": buy_hold(precios, [t for t in activos if not t.endswith(".MX")], cal),
        "Emisoras BMV de la watchlist": buy_hold(precios, [t for t in activos if t.endswith(".MX")], cal),
    }
    from collections import Counter
    estados = Counter()
    for (tk, d, rr, *_), p in _PLANES.items():
        if p and rr == cfg.rr_minimo and d in cal:
            estados[f"{p['fase']} / {p['orden']}"] += 1
    out["estados_motor"] = dict(estados.most_common())
    por = {}
    for t in out["con_filtro_mercado"]["trades"]:
        x = por.setdefault(t["ticker"], {"operaciones": 0, "pnl": 0.0, "ganadoras": 0})
        x["operaciones"] += 1; x["pnl"] = round(x["pnl"] + t["pnl"], 2); x["ganadoras"] += t["pnl"] > 0
    out["por_activo"] = por
    o = pathlib.Path(a.out); o.mkdir(parents=True, exist_ok=True)
    (o / "resultado.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=str))
    print("Guardado", o / "resultado.json")


if __name__ == "__main__":
    main()
