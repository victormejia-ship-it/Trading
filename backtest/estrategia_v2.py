"""Estrategia v2 (seguimiento de tendencia) con validación en dos tramos.

Qué conserva de las reglas originales: compra solo en tendencia alcista (precio > SMA200, SMA50 > SMA200 con pendiente
positiva), PROHIBIDO comprar extendido (>15% sobre SMA50 o RSI>72), riesgo 1% por operación, tope 25% por posición,
filtro de mercado (topes de exposición y ROJO = no comprar), 50% en objetivo 1, trailing para el resto, invalidación
temporal y salida por fase bajista.
Qué corrige: el R:R ya no se mide contra la resistencia más cercana (bloqueaba el 100% de las entradas). El objetivo 1
es 2R por construcción (asimetría 1:2) y el resto corre con un trailing de volatilidad (chandelier).

Señales con datos hasta el cierre de d; ejecución a la apertura de d+1. P&L en MXN (SIC convertido con MXN=X).

  python -m backtest.estrategia_v2 --datos data/historico --out reports/backtest_v2
"""
from __future__ import annotations

import argparse
import itertools
import json
import pathlib
from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

from trend_risk.indicators import enrich
from worker.features import snapshot_mercado

COSTO = 0.0029 + 0.0005          # comisión GBM 0.25% + IVA, más deslizamiento, por lado
SESIONES_TRAMO = 252


@dataclass(frozen=True)
class Params:
    entrada: str = "retroceso"   # "retroceso" (rebote en EMA21) | "ruptura55" (máximo de 55 sesiones)
    k_stop: float = 2.0          # stop inicial y trailing = k × ATR14
    parcial: bool = True         # vender 50% en +2R
    riesgo: float = 0.01
    max_pos: float = 0.25
    sesiones_1r: int = 20        # invalidación temporal: si en N sesiones no llega a +1R, salir
    filtro_mercado: bool = True

    def nombre(self):
        return f"{self.entrada}·stop {self.k_stop:g}×ATR·{'50% en 2R' if self.parcial else 'sin parcial'}"


def cargar(dirp: str | pathlib.Path) -> dict[str, pd.DataFrame]:
    out = {}
    for p in pathlib.Path(dirp).glob("*.csv"):
        df = pd.read_csv(p, parse_dates=["date"]).set_index("date").sort_index()
        df = df[~df.index.duplicated(keep="last")]
        nombre = p.stem if p.stem not in ("VIX", "MXX") else "^" + p.stem
        out[nombre] = df[["open", "high", "low", "close", "volume"]].astype(float)
    return out


def senales(df: pd.DataFrame) -> pd.DataFrame:
    """Columnas causales por día: tendencia, setups, extensión."""
    e = enrich(df)
    e["ema21"] = e["close"].ewm(span=21, adjust=False).mean()
    e["pend50"] = e["sma50"] / e["sma50"].shift(10) - 1
    e["tendencia"] = (e.close > e.sma200) & (e.sma50 > e.sma200) & (e.pend50 > 0)
    e["extendido"] = (e.close / e.sma50 - 1 > 0.15) | (e.rsi14 > 72)
    toque = (e.low <= e.ema21 + 0.25 * e.atr14).rolling(5).max().astype(bool)
    e["retroceso"] = toque & (e.close > e.high.shift(1)) & (e.close > e.ema21) & e.rsi14.between(40, 70)
    e["ruptura55"] = (e.close > e.high.shift(1).rolling(55).max()) & (e.volume >= e.vol20.fillna(0))
    e["mom60"] = e.close / e.close.shift(60) - 1
    return e


def simular(sen, precios, fx, cal, activos, mercado, P: Params, capital=100_000.0):
    efectivo, pos, pend, trades, curva = capital, {}, [], [], []
    a_mxn = lambda t, d, px: px * (fx.loc[:d].iloc[-1] if not t.endswith(".MX") else 1.0)

    def valor(d):
        return efectivo + sum(p["u"] * a_mxn(t, d, sen[t].close.loc[:d].iloc[-1]) for t, p in pos.items())

    def salir(t, d, motivo, frac, px):
        nonlocal efectivo
        p = pos[t]
        u = p["u"] if frac >= 1 else p["u_ini"] * frac
        u = min(u, p["u"])
        bruto = u * a_mxn(t, d, px)
        efectivo += bruto * (1 - COSTO)
        p["u"] -= u
        p["ingreso"] += bruto * (1 - COSTO)
        p["salidas"].append(motivo)
        if p["u"] <= 1e-9:
            pnl = p["ingreso"] - p["costo_mxn"]
            pnl = float(pnl)
            trades.append({"ticker": t, "mercado": "BMV" if t.endswith(".MX") else "SIC", "entrada_fecha": p["f"], "salida_fecha": str(d.date()),
                           "entrada": round(p["e"], 4), "stop_ini": round(p["s0"], 4), "dias": p["dias"], "salidas": p["salidas"],
                           "pnl_mxn": round(pnl, 2), "r": round(pnl / p["riesgo_mxn"], 3)})
            del pos[t]

    for d in cal:
        # 1. entradas pendientes a la apertura
        for t, peso_max, atr in pend:
            if t in pos or d not in sen[t].index:
                continue
            b = sen[t].loc[d]
            ref = sen[t].close.loc[:d].iloc[-2]
            if b.open > ref + 1.0 * atr:            # gap excesivo: no perseguir
                continue
            e = b.open
            stop = e - P.k_stop * atr
            eq = valor(d)
            riesgo_mxn = P.riesgo * eq
            u = riesgo_mxn / a_mxn(t, d, e - stop)
            monto = u * a_mxn(t, d, e)
            tope = peso_max * eq
            if monto > tope:
                u *= tope / monto; monto = tope
            if monto > efectivo / (1 + COSTO):
                u *= (efectivo / (1 + COSTO)) / monto; monto = efectivo / (1 + COSTO)
            if monto < 0.005 * eq:
                continue
            efectivo -= monto * (1 + COSTO)
            pos[t] = {"e": e, "s0": stop, "stop": stop, "R": e - stop, "u": u, "u_ini": u, "f": str(d.date()), "dias": 0, "max": b.high,
                      "parcial": False, "costo_mxn": monto * (1 + COSTO), "ingreso": 0.0, "riesgo_mxn": u * a_mxn(t, d, e - stop) + 2 * monto * COSTO, "salidas": []}
        pend = []

        # 2. gestión con la vela de d (stop primero: conservador)
        for t in list(pos):
            if d not in sen[t].index:
                continue
            b, p = sen[t].loc[d], pos[t]
            p["dias"] += 1
            if b.low <= p["stop"]:
                salir(t, d, "stop" if p["stop"] <= p["s0"] + 1e-9 else "trailing", 1, min(b.open, p["stop"]) if p["dias"] > 1 else p["stop"])
                continue
            if P.parcial and not p["parcial"] and b.high >= p["e"] + 2 * p["R"]:
                salir(t, d, "objetivo_2R", 0.5, max(b.open, p["e"] + 2 * p["R"]))
                p["parcial"] = True
                if t not in pos:
                    continue
            p["max"] = max(p["max"], b.high)
            if b.close < b.sma50 and not b.tendencia:
                salir(t, d, "fase_bajista", 1, b.close); continue
            if p["dias"] >= P.sesiones_1r and p["max"] < p["e"] + p["R"]:
                salir(t, d, "tiempo", 1, b.close); continue
            p["stop"] = max(p["stop"], p["max"] - P.k_stop * b.atr14)     # chandelier, vale desde mañana

        # 3. señales al cierre -> órdenes para la apertura de d+1
        m = mercado[d]
        expo = m["tope_exposicion_pct"] / 100 if P.filtro_mercado else 1.0
        if P.filtro_mercado and m["rojo_forzado"]:
            curva.append({"fecha": str(d.date()), "equity": valor(d)}); continue
        eq = valor(d)
        invertido = eq - efectivo
        cand = []
        for t in activos:
            if t in pos or d not in sen[t].index:
                continue
            r = sen[t].loc[d]
            if r.tendencia and not r.extendido and r[P.entrada] and np.isfinite(r.atr14):
                cand.append((r.mom60 if np.isfinite(r.mom60) else 0, t, r.atr14))
        for _, t, atr in sorted(cand, reverse=True):
            libre = expo - invertido / eq
            if libre < 0.02:
                break
            peso = min(P.max_pos, libre)
            pend.append((t, peso, atr))
            invertido += peso * eq                   # reserva conservadora
        curva.append({"fecha": str(d.date()), "equity": valor(d)})

    d = cal[-1]
    for t in list(pos):
        salir(t, d, "fin_tramo", 1, sen[t].close.loc[:d].iloc[-1])
    curva[-1]["equity"] = efectivo
    return trades, curva


def metricas(curva, trades, capital=100_000.0):
    eq = pd.Series([c["equity"] for c in curva], index=pd.to_datetime([c["fecha"] for c in curva]))
    ret = eq.pct_change().dropna()
    años = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    dd = float((eq / eq.cummax() - 1).min())
    r = [t["r"] for t in trades]
    gan = [t["pnl_mxn"] for t in trades if t["pnl_mxn"] > 0]
    per = [t["pnl_mxn"] for t in trades if t["pnl_mxn"] <= 0]
    cagr = (eq.iloc[-1] / capital) ** (1 / años) - 1
    cagr, fin = float(cagr), float(eq.iloc[-1])
    return {"rendimiento_pct": round(100 * (fin / capital - 1), 2), "cagr_pct": round(100 * cagr, 2), "max_dd_pct": round(100 * dd, 2),
            "mar": round(cagr / max(abs(dd), 0.05), 2), "sharpe": round(float(ret.mean() / ret.std() * np.sqrt(252)), 2) if ret.std() > 0 else None,
            "operaciones": len(trades), "ganadoras_pct": round(100 * len(gan) / len(trades), 1) if trades else None,
            "r_promedio": round(float(np.mean(r)), 3) if r else None, "r_total": round(float(np.sum(r)), 2) if r else 0,
            "factor_beneficio": round(float(sum(gan) / -sum(per)), 2) if per and sum(per) < 0 else None}


def buy_hold(precios, fx, tickers, cal, capital=100_000.0):
    vals = []
    for t in tickers:
        if t not in precios:
            continue
        c = precios[t]["close"].reindex(cal).ffill().bfill()
        if not t.endswith(".MX") and t in precios and fx is not None and not t.startswith("^"):
            c = c * fx.reindex(cal).ffill().bfill()
        vals.append(c / c.iloc[0])
    eq = capital * pd.concat(vals, axis=1).mean(axis=1)
    años = (cal[-1] - cal[0]).days / 365.25
    fin = float(eq.iloc[-1])
    return {"rendimiento_pct": round(100 * (fin / capital - 1), 2), "cagr_pct": round(100 * ((fin / capital) ** (1 / años) - 1), 2),
            "max_dd_pct": round(100 * float((eq / eq.cummax() - 1).min()), 2)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data/historico")
    ap.add_argument("--universo", default="backtest/universo.json")
    ap.add_argument("--out", default="reports/backtest_v2")
    a = ap.parse_args(argv)
    u = json.loads(pathlib.Path(a.universo).read_text())
    precios = cargar(a.datos)
    indices = [t for t in u["indices"] if t in precios]
    activos = [t for t in u["sic"] + u["bmv"] if t in precios and len(precios[t]) >= 220 + 2 * SESIONES_TRAMO]
    fx = precios["MXN=X"]["close"]
    sen = {t: senales(precios[t]) for t in activos}
    cal_total = precios["SPY"].index[-2 * SESIONES_TRAMO:]
    tramos = {"tramo1_ajuste": cal_total[:SESIONES_TRAMO], "tramo2_validacion": cal_total[SESIONES_TRAMO:]}
    ind = {t: enrich(precios[t]) for t in set(indices + activos)}
    mercado = {d: snapshot_mercado({t: precios[t].loc[:d] for t in ind}, indices, activos, {t: ind[t].loc[:d] for t in ind}) for d in cal_total}

    rejilla = [Params(entrada=e, k_stop=k, parcial=pc) for e, k, pc in itertools.product(["retroceso", "ruptura55"], [2.0, 3.0], [True, False])]
    out = {"tramos": {k: {"inicio": str(v[0].date()), "fin": str(v[-1].date())} for k, v in tramos.items()},
           "activos": activos, "costos_por_lado_pct": round(100 * COSTO, 2), "protocolo":
           "Se elige la combinación con mejor MAR (CAGR / caída máx.) en el tramo 1 con al menos 10 operaciones. El tramo 2 se mide una sola vez con esa combinación; los demás resultados del tramo 2 se muestran solo como referencia.",
           "rejilla": []}
    for P in rejilla:
        fila = {"params": asdict(P), "nombre": P.nombre()}
        for k, cal in tramos.items():
            tr, cu = simular(sen, precios, fx, cal, activos, mercado, P)
            fila[k] = {"metricas": metricas(cu, tr), "trades": tr, "curva": [{"fecha": c["fecha"], "equity": round(c["equity"], 2)} for c in cu]}
        out["rejilla"].append(fila)
        print(P.nombre(), "| T1", fila["tramo1_ajuste"]["metricas"], "| T2", fila["tramo2_validacion"]["metricas"])

    validas = [f for f in out["rejilla"] if f["tramo1_ajuste"]["metricas"]["operaciones"] >= 10]
    elegida = max(validas or out["rejilla"], key=lambda f: f["tramo1_ajuste"]["metricas"]["mar"])
    out["elegida"] = elegida["nombre"]
    # Sin filtro de mercado, misma combinación (para medir el valor del filtro)
    Pf = Params(**{**elegida["params"], "filtro_mercado": False})
    out["elegida_sin_filtro"] = {k: metricas(*reversed(simular(sen, precios, fx, cal, activos, mercado, Pf))) for k, cal in tramos.items()}
    out["benchmarks"] = {k: {"SPY (en MXN)": buy_hold(precios, fx, ["SPY"], cal), "IPC": buy_hold(precios, None, ["^MXX"], cal),
                             "Universo igual ponderado (MXN)": buy_hold(precios, fx, activos, cal)} for k, cal in tramos.items()}
    o = pathlib.Path(a.out); o.mkdir(parents=True, exist_ok=True)
    (o / "resultado.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str))
    print("ELEGIDA (por tramo 1):", out["elegida"])
    print("Benchmarks:", json.dumps(out["benchmarks"], ensure_ascii=False))


if __name__ == "__main__":
    main()
