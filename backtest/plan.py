"""Investigación para el plan de inversión (20 años, MXN, costos GBM, efectivo en CETES, validación en dos tramos).

1) Filtro mensual de 200 días aplicado a cada ETF (¿la regla validada se generaliza?).
2) RSI(2) de Larry Connors en ETFs: compra al cierre si precio > SMA200 y RSI(2) < umbral; ejecución en la apertura
   siguiente; salida cuando el cierre supera la SMA5 (o RSI(2) > 70), también en la apertura siguiente.
   Se elige UNA combinación con el promedio de MAR de todos los ETFs en 2006-2015 y se mide una sola vez en 2016-2026.

  python -m backtest.plan --datos data/historico20 --out reports/plan/resultado.json
"""
from __future__ import annotations

import argparse
import itertools
import json
import pathlib

import numpy as np
import pandas as pd

from backtest.cartera_nucleo import simular as simular_filtro, metricas, en_crisis, tasa_diaria, COSTO
from backtest.estrategia_v2 import cargar

ETFS = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000 (pequeñas EE. UU.)", "NAFTRACISHRS.MX": "IPC México (NAFTRAC)",
        "EWW": "México en dólares (EWW)", "TLT": "Bonos del Tesoro EE. UU. 20+ años"}
CORTE = pd.Timestamp("2016-01-01")
INICIO = pd.Timestamp("2006-11-27")


def a_mxn(df, fx, t):
    if t.endswith(".MX"):
        return df
    f = fx.reindex(df.index).ffill()
    return df[["open", "high", "low", "close"]].mul(f, axis=0).assign(volume=df.volume)


def wilder(s, n):
    return s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def rsi2(c):
    d = c.diff()
    g, p = wilder(d.clip(lower=0), 2), wilder(-d.clip(upper=0), 2)
    r = 100 - 100 / (1 + g / p.replace(0, np.nan))
    return r.where(p != 0, 100)


def simular_rsi2(df, dfm, cal, tasa, umbral, salida, capital=100_000.0):
    """df: precios nativos (señal); dfm: precios en MXN (valuación)."""
    c = df.close
    sma200, sma5, r2 = c.rolling(200).mean(), c.rolling(5).mean(), rsi2(c)
    entrar = ((c > sma200) & (r2 < umbral)).reindex(cal).fillna(False)
    salir = ((c > sma5) if salida == "sma5" else (r2 > 70)).reindex(cal).fillna(False)
    efectivo, u, dentro, pend, trades, curva = capital, 0.0, False, None, [], []
    ent = None
    for i, d in enumerate(cal):
        op, cl = dfm.at[d, "open"], dfm.at[d, "close"]
        if pend == "comprar" and not dentro:
            u = efectivo * (1 - COSTO) / op; efectivo = 0.0; dentro = True; ent = (d, op)
        elif pend == "vender" and dentro:
            efectivo = u * op * (1 - COSTO); trades.append({"entrada": str(ent[0].date()), "salida": str(d.date()), "ret_pct": round(100 * (op / ent[1] * (1 - COSTO) ** 2 - 1), 2), "dias": int((d - ent[0]).days)})
            u = 0.0; dentro = False
        pend = None
        if not dentro:
            efectivo *= 1 + tasa.loc[d]
            if entrar.loc[d]:
                pend = "comprar"
        elif salir.loc[d]:
            pend = "vender"
        curva.append(efectivo + u * cl)
    if dentro:
        trades.append({"entrada": str(ent[0].date()), "salida": None, "ret_pct": round(100 * (dfm.close.iloc[-1] / ent[1] - 1), 2), "dias": None})
    eq = pd.Series(curva, index=cal)
    cerr = [t for t in trades if t["salida"]]
    dias_dentro = sum((pd.Timestamp(t["salida"]) - pd.Timestamp(t["entrada"])).days for t in cerr)
    return eq, {"operaciones": len(cerr), "ganadoras_pct": round(100 * np.mean([t["ret_pct"] > 0 for t in cerr]), 1) if cerr else None,
                "ret_medio_op_pct": round(float(np.mean([t["ret_pct"] for t in cerr])), 2) if cerr else None,
                "exposicion_pct": round(100 * dias_dentro / max((cal[-1] - cal[0]).days, 1), 1), "ultimas": trades[-5:]}


def bh(dfm, cal, capital=100_000.0):
    c = dfm.close.reindex(cal).ffill()
    return capital * c / c.iloc[0]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data/historico20")
    ap.add_argument("--out", default="reports/plan/resultado.json")
    a = ap.parse_args(argv)
    P = cargar(a.datos)
    fx = P["MXN=X"]["close"]
    spy = P["SPY"].index
    cal_all = spy[(spy >= INICIO) & (spy >= fx.index[0])]
    tasa, tasa_src = tasa_diaria(a.datos, cal_all)
    tramos = {"t1": cal_all[cal_all < CORTE], "t2": cal_all[cal_all >= CORTE], "todo": cal_all}
    cetes = {k: metricas(pd.Series(100_000.0 * np.cumprod(1 + tasa.reindex(c).values), index=c)) for k, c in tramos.items()}
    out = {"periodo": {"inicio": str(cal_all[0].date()), "fin": str(cal_all[-1].date()), "corte": str(CORTE.date())},
           "tasa_efectivo": tasa_src, "cetes": cetes, "filtro_200": {}, "rsi2": {"rejilla": {}, "elegida": None}}

    # ---- 1) filtro mensual 200d por ETF
    for t, nombre in ETFS.items():
        if t not in P:
            continue
        df = P[t]
        dfm = a_mxn(df, fx, t).reindex(cal_all).ffill()
        mg = {t: {"senal": df, "mxn": dfm}}
        fila = {"nombre": nombre}
        for k, c in tramos.items():
            c2 = c[c >= df.index[0] + pd.Timedelta(days=300)]
            eqf, eps, cambios = simular_filtro(mg, {t: 1.0}, "sma200_mensual", c2, tasa.reindex(c2))
            eqb = bh(dfm, c2)
            fila[k] = {"filtro": {**metricas(eqf), "cambios": cambios, "crisis": en_crisis(eqf)}, "comprar_y_mantener": {**metricas(eqb), "crisis": en_crisis(eqb)}}
        out["filtro_200"][t] = fila
        f1, f2 = fila["t1"], fila["t2"]
        print(f"FILTRO {nombre:32s} T1 {f1['filtro']['cagr_pct']:6.2f}%/{f1['filtro']['max_dd_pct']:6.1f} vs B&H {f1['comprar_y_mantener']['cagr_pct']:6.2f}%/{f1['comprar_y_mantener']['max_dd_pct']:6.1f} | "
              f"T2 {f2['filtro']['cagr_pct']:6.2f}%/{f2['filtro']['max_dd_pct']:6.1f} vs B&H {f2['comprar_y_mantener']['cagr_pct']:6.2f}%/{f2['comprar_y_mantener']['max_dd_pct']:6.1f}")

    # ---- 2) RSI(2) en ETFs
    combos = list(itertools.product([5, 10], ["sma5", "rsi70"]))
    for um, sal in combos:
        clave = f"rsi2<{um}·salida {sal}"
        res = {}
        for t in ETFS:
            if t not in P:
                continue
            df = P[t]; dfm = a_mxn(df, fx, t).reindex(cal_all).ffill()
            res[t] = {}
            for k, c in tramos.items():
                c2 = c[c >= df.index[0] + pd.Timedelta(days=300)]
                eq, st = simular_rsi2(df, dfm, c2, tasa.reindex(c2), um, sal)
                res[t][k] = {**metricas(eq), **st, "crisis": en_crisis(eq)}
        mar1 = float(np.mean([res[t]["t1"]["mar"] for t in res]))
        out["rsi2"]["rejilla"][clave] = {"umbral": um, "salida": sal, "mar_medio_t1": round(mar1, 3), "etfs": res}
        print(f"RSI2 {clave:24s} MAR medio T1 {mar1:.3f} | " + " ".join(f"{t.split('.')[0]}:T1 {res[t]['t1']['cagr_pct']:.1f}%/T2 {res[t]['t2']['cagr_pct']:.1f}% (n={res[t]['t2']['operaciones']})" for t in res))
    el = max(out["rsi2"]["rejilla"], key=lambda k: out["rsi2"]["rejilla"][k]["mar_medio_t1"])
    out["rsi2"]["elegida"] = el
    e = out["rsi2"]["rejilla"][el]["etfs"]
    print("ELEGIDA RSI2:", el)
    for t in e:
        b2 = out["filtro_200"][t]["t2"]["comprar_y_mantener"]
        print(f"  {ETFS[t]:32s} T2 RSI2 {e[t]['t2']['cagr_pct']:6.2f}%/{e[t]['t2']['max_dd_pct']:6.1f} ops={e[t]['t2']['operaciones']} gan={e[t]['t2']['ganadoras_pct']}% expo={e[t]['t2']['exposicion_pct']}% | B&H {b2['cagr_pct']:.2f}%/{b2['max_dd_pct']:.1f} | CETES {cetes['t2']['cagr_pct']:.2f}%")
    pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()


# ---------------- Carteras modelo por perfil (pesos fijados por criterio de diversificación, NO optimizados con datos)
PERFILES = {
    "conservador": {"CETES": 0.50, "SPY": 0.30, "NAFTRACISHRS.MX": 0.10, "QQQ": 0.10},
    "moderado": {"CETES": 0.25, "SPY": 0.40, "NAFTRACISHRS.MX": 0.10, "QQQ": 0.15, "IWM": 0.10},
    "agresivo": {"CETES": 0.10, "SPY": 0.40, "NAFTRACISHRS.MX": 0.10, "QQQ": 0.25, "IWM": 0.15},
}


def carteras(datos="data/historico20", out="reports/plan/perfiles.json"):
    P = cargar(datos)
    fx = P["MXN=X"]["close"]
    spy = P["SPY"].index
    cal_all = spy[(spy >= INICIO) & (spy >= fx.index[0])]
    tasa, _ = tasa_diaria(datos, cal_all)
    tramos = {"t1": cal_all[cal_all < CORTE], "t2": cal_all[cal_all >= CORTE], "todo": cal_all}
    res = {}
    for perfil, pesos in PERFILES.items():
        res[perfil] = {"pesos": pesos}
        for regla in ("sma200_mensual", "comprar_y_mantener"):
            res[perfil][regla] = {}
            for k, c in tramos.items():
                mg = {t: {"senal": P[t], "mxn": a_mxn(P[t], fx, t).reindex(cal_all).ffill()} for t in pesos if t != "CETES"}
                eq, _, cambios = simular_filtro(mg, {t: w for t, w in pesos.items() if t != "CETES"}, regla, c, tasa.reindex(c))
                eq = eq + 100_000.0 * pesos["CETES"] * np.cumprod(1 + tasa.reindex(c).values)
                res[perfil][regla][k] = {**metricas(eq), "cambios": cambios, "crisis": en_crisis(eq),
                                         "curva": [[str(d.date()), round(float(v))] for d, v in eq.iloc[::10].items()] if k == "todo" else None}
        f, b = res[perfil]["sma200_mensual"], res[perfil]["comprar_y_mantener"]
        print(f"{perfil:11s} con filtro: 20a {f['todo']['cagr_pct']:5.2f}%/{f['todo']['max_dd_pct']:6.1f}  T2 {f['t2']['cagr_pct']:5.2f}%/{f['t2']['max_dd_pct']:6.1f}  2008 {f['todo']['crisis'].get('Crisis 2008')}"
              f"  | sin filtro: 20a {b['todo']['cagr_pct']:5.2f}%/{b['todo']['max_dd_pct']:6.1f}  T2 {b['t2']['cagr_pct']:5.2f}%/{b['t2']['max_dd_pct']:6.1f}  2008 {b['todo']['crisis'].get('Crisis 2008')}")
    pathlib.Path(out).write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    return res
