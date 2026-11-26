"""Enfoque A: cartera núcleo con filtro de régimen (tendencia de largo plazo), 20 años, en MXN.

Mangas (sleeves): IPC (NAFTRAC si hay historia, si no ^MXX), S&P 500 vía SIC (SPY × MXN=X) y 50/50 de ambas.
Reglas:
  - comprar_y_mantener
  - sma200_mensual: el último día hábil del mes, si el cierre > SMA200 se mantiene; si no, a CETES. Se ejecuta en la
    apertura siguiente.
  - sma200_banda: diario; sale si cierre < SMA200 × (1 - 2%), vuelve si cierre > SMA200 × (1 + 2%).
Fuera del mercado el efectivo rinde la tasa de México a 3 meses (FRED IR3TIB01MXM156N, aproxima CETES).
Costos 0.34% por lado en cada cambio. Validación: ajuste 2006-2015, validación 2016-2026.

  python -m backtest.cartera_nucleo --datos data/historico20 --out reports/cartera_nucleo
"""
from __future__ import annotations

import argparse
import os
import json
import pathlib

import numpy as np
import pandas as pd

COSTO = 0.0029 + 0.0005
BANDA = 0.02
CORTE = "2016-01-01"
CRISIS = {"Crisis 2008": ("2007-10-01", "2009-06-30"), "COVID 2020": ("2020-01-15", "2020-06-30"),
          "Inflación 2022": ("2022-01-01", "2022-12-31"), "Aranceles 2025": ("2025-02-01", "2025-05-31")}


def leer(dirp, nombre):
    p = pathlib.Path(dirp) / f"{nombre.replace('^', '')}.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p, parse_dates=["date"]).set_index("date").sort_index()
    return df[~df.index.duplicated(keep="last")]


def tasa_diaria(dirp, cal):
    """Tasa de México a 3 meses (% anual mensual) -> rendimiento diario del efectivo en el calendario."""
    t = None
    for n in ("tasa_mx_3m", "tasa_mx_descuento"):
        p = pathlib.Path(dirp) / f"{n}.csv"
        if p.exists():
            s = pd.read_csv(p, parse_dates=["date"]).set_index("date")["tasa"]
            t = s if t is None else t.combine_first(s)
    if t is None:
        aprox = pathlib.Path("data/tasas_cetes_anual_aprox.csv")
        if os.environ.get("EFECTIVO_CERO") or not aprox.exists():
            return pd.Series(0.0, index=cal), "efectivo al 0% (sensibilidad)"
        a = pd.read_csv(aprox).set_index("anio")["tasa"]
        anual = pd.Series([a.get(d.year, a.iloc[-1]) for d in cal], index=cal)
        return (1 + anual / 100) ** (1 / 252) - 1, "CETES 28 días, promedios anuales aproximados (tabla manual; FRED no respondió)"
    t = t.reindex(t.index.union(cal)).ffill().reindex(cal).bfill()
    return (1 + t / 100) ** (1 / 252) - 1, "FRED IR3TIB01MXM156N (México 3 meses) con respaldo INTDSRMXM193N"


def mangas(dirp):
    spy, fx = leer(dirp, "SPY"), leer(dirp, "MXN=X")
    naf, ipc = leer(dirp, "NAFTRACISHRS.MX"), leer(dirp, "^MXX")
    ipc_src = "NAFTRAC" if naf is not None and naf.index[0] < pd.Timestamp("2005-06-01") else "IPC (^MXX, sin dividendos)"
    ipc_df = naf if ipc_src == "NAFTRAC" else ipc
    cal = spy.index.intersection(ipc_df.index)
    cal = cal[cal >= fx.index[0]]
    fxs = fx["close"].reindex(cal).ffill()
    # señal sobre el precio nativo; valor en MXN
    s = {"IPC": {"senal": ipc_df.reindex(cal).ffill(), "mxn": ipc_df.reindex(cal).ffill()},
         "S&P 500 (SIC, MXN)": {"senal": spy.reindex(cal).ffill(), "mxn": spy.reindex(cal).ffill().mul(fxs, axis=0)}}
    return s, cal, ipc_src


def posicion_objetivo(senal: pd.DataFrame, regla: str) -> pd.Series:
    """1 = invertido, 0 = efectivo; decidido al cierre de cada día (se ejecuta al día siguiente)."""
    c = senal["close"]
    sma = c.rolling(200, min_periods=200).mean()
    if regla == "comprar_y_mantener":
        return pd.Series(1.0, index=c.index)
    if regla == "sma200_mensual":
        fin_mes = c.index.to_series().groupby(c.index.to_period("M")).transform("max") == c.index.to_series()
        dec = pd.Series(np.where(c > sma, 1.0, 0.0), index=c.index).where(fin_mes & sma.notna())
        return dec.ffill().fillna(1.0)
    if regla == "sma200_banda":
        out, est = [], 1.0
        for ci, si in zip(c.values, sma.values):
            if np.isfinite(si):
                if est == 1.0 and ci < si * (1 - BANDA):
                    est = 0.0
                elif est == 0.0 and ci > si * (1 + BANDA):
                    est = 1.0
            out.append(est)
        return pd.Series(out, index=c.index)
    raise ValueError(regla)


def simular(mg: dict, pesos: dict, regla: str, cal, tasa, capital=100_000.0):
    """Cada manga con su propia señal. Devuelve curva de equity y episodios (entradas/salidas)."""
    valor = pd.Series(0.0, index=cal)
    episodios, cambios = [], 0
    for nombre, w in pesos.items():
        dfm = mg[nombre]["mxn"].reindex(cal)
        obj = posicion_objetivo(mg[nombre]["senal"], regla).shift(1).reindex(cal).ffill().fillna(1.0)  # se ejecuta al día siguiente
        eq, dentro, unidades, efectivo = capital * w, None, 0.0, capital * w
        ep_ini = None
        curva = []
        for d in cal:
            o, op, cl = obj.loc[d], dfm.at[d, "open"], dfm.at[d, "close"]
            if dentro is None or (o == 1.0) != dentro:
                if o == 1.0:      # comprar a la apertura
                    unidades = efectivo * (1 - COSTO) / op; efectivo = 0.0; ep_ini = (d, op)
                elif dentro:      # vender a la apertura (solo si estaba invertido)
                    efectivo = unidades * op * (1 - COSTO)
                    if ep_ini:
                        episodios.append({"manga": nombre, "entrada": str(ep_ini[0].date()), "salida": str(d.date()),
                                          "ret_pct": round(100 * (op / ep_ini[1] * (1 - COSTO) ** 2 - 1), 2), "dias": int((d - ep_ini[0]).days)})
                    unidades = 0.0; ep_ini = None
                if dentro is not None:
                    cambios += 1
                dentro = o == 1.0
            if not dentro:
                efectivo *= 1 + tasa.loc[d]
            curva.append(efectivo + unidades * cl)
        valor += pd.Series(curva, index=cal)
        if ep_ini:
            episodios.append({"manga": nombre, "entrada": str(ep_ini[0].date()), "salida": None,
                              "ret_pct": round(100 * (dfm["close"].iloc[-1] / ep_ini[1] - 1), 2), "dias": int((cal[-1] - ep_ini[0]).days)})
    return valor, episodios, cambios


def metricas(eq: pd.Series, capital=100_000.0):
    ret = eq.pct_change().dropna()
    años = (eq.index[-1] - eq.index[0]).days / 365.25
    dd = float((eq / eq.cummax() - 1).min())
    cagr = float((eq.iloc[-1] / capital) ** (1 / años) - 1)
    return {"rendimiento_pct": round(100 * (float(eq.iloc[-1]) / capital - 1), 1), "cagr_pct": round(100 * cagr, 2), "max_dd_pct": round(100 * dd, 1),
            "mar": round(cagr / max(abs(dd), 0.05), 3), "volatilidad_pct": round(float(ret.std() * np.sqrt(252) * 100), 1),
            "sharpe_aprox": round(float(ret.mean() / ret.std() * np.sqrt(252)), 2) if ret.std() > 0 else None}


def en_crisis(eq: pd.Series):
    out = {}
    for k, (a, b) in CRISIS.items():
        s = eq.loc[a:b]
        if len(s) > 5:
            out[k] = round(100 * float((s / s.cummax() - 1).min()), 1)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data/historico20")
    ap.add_argument("--out", default="reports/cartera_nucleo")
    ap.add_argument("--corte", default=CORTE)
    ap.add_argument("--inicio", default="2006-11-27")
    a = ap.parse_args(argv)
    mg, cal_all, ipc_src = mangas(a.datos)
    inicio = max(cal_all[0] + pd.Timedelta(days=300), pd.Timestamp(a.inicio))
    cal = cal_all[cal_all >= inicio]
    tasa, tasa_src = tasa_diaria(a.datos, cal)
    tramos = {"completo": cal, "tramo1_ajuste": cal[cal < a.corte], "tramo2_validacion": cal[cal >= a.corte]}
    carteras = {"IPC": {"IPC": 1.0}, "S&P 500 (SIC, MXN)": {"S&P 500 (SIC, MXN)": 1.0},
                "50% IPC / 50% S&P 500": {"IPC": 0.5, "S&P 500 (SIC, MXN)": 0.5}}
    reglas = ["comprar_y_mantener", "sma200_mensual", "sma200_banda"]
    out = {"fuentes": {"ipc": ipc_src, "tasa_efectivo": tasa_src, "sp500": "SPY ajustado (con dividendos) × MXN=X"},
           "periodo": {"inicio": str(cal[0].date()), "fin": str(cal[-1].date()), "corte_validacion": a.corte},
           "costos_por_lado_pct": round(100 * COSTO, 2), "resultados": [],
           "protocolo": "Para cada cartera se elige la regla con mejor MAR en 2006-2015; 2016-2026 se reporta como validación."}
    for cn, pesos in carteras.items():
        for r in reglas:
            fila = {"cartera": cn, "regla": r}
            for tn, c in tramos.items():
                eq, eps, cambios = simular(mg, pesos, r, c, tasa.reindex(c))
                fila[tn] = {**metricas(eq), "cambios": cambios, "crisis": en_crisis(eq)}
                if tn == "completo":
                    fila["curva"] = [[str(d.date()), round(float(v), 0)] for d, v in eq.iloc[::5].items()]
                    fila["episodios"] = eps
                    cerrados = [e for e in eps if e["salida"]]
                    fila["episodios_stats"] = {"n": len(cerrados), "ganadores_pct": round(100 * np.mean([e["ret_pct"] > 0 for e in cerrados]), 1) if cerrados else None,
                                               "ret_medio_pct": round(float(np.mean([e["ret_pct"] for e in cerrados])), 2) if cerrados else None,
                                               "dias_medios": round(float(np.mean([e["dias"] for e in cerrados])), 0) if cerrados else None}
            out["resultados"].append(fila)
            print(f"{cn:24s} {r:20s} T1 {fila['tramo1_ajuste']['cagr_pct']:6.2f}%/{fila['tramo1_ajuste']['max_dd_pct']:6.1f}  "
                  f"T2 {fila['tramo2_validacion']['cagr_pct']:6.2f}%/{fila['tramo2_validacion']['max_dd_pct']:6.1f}  "
                  f"20a {fila['completo']['cagr_pct']:6.2f}%/{fila['completo']['max_dd_pct']:6.1f}  crisis {fila['completo']['crisis']}")
    elegidas = {}
    for cn in carteras:
        filas = [f for f in out["resultados"] if f["cartera"] == cn]
        elegidas[cn] = max(filas, key=lambda f: f["tramo1_ajuste"]["mar"])["regla"]
    out["elegidas_por_tramo1"] = elegidas
    print("Elegidas (por tramo 1):", elegidas)
    o = pathlib.Path(a.out); o.mkdir(parents=True, exist_ok=True)
    (o / "resultado.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
