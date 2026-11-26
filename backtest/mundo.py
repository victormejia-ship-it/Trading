"""Mercados del mundo: la misma regla validada (filtro mensual de 200 días) en regiones, países y activos, en MXN.

Para cada ETF operable en el SIC: comprar y mantener contra filtro, en 2006-2015, 2016-2026 y completo, con crisis.
No se elige nada con estos datos: es una prueba de generalización de una regla ya fijada.

  python -m backtest.mundo --datos data/historico20 --out public/data/mundo.json
"""
import argparse
import json
import pathlib

import numpy as np
import pandas as pd

from backtest.cartera_nucleo import simular as simular_filtro, metricas, en_crisis, tasa_diaria
from backtest.estrategia_v2 import cargar
from backtest.plan import a_mxn, CORTE, INICIO

MERCADOS = {
    # región/país: (nombre, grupo, cómo comprarlo)
    "SPY": ("Estados Unidos (S&P 500)", "América", "acciones"),
    "QQQ": ("EE. UU. tecnología (Nasdaq 100)", "América", "acciones"),
    "IWM": ("EE. UU. empresas pequeñas", "América", "acciones"),
    "EWC": ("Canadá", "América", "acciones"),
    "NAFTRACISHRS.MX": ("México (IPC)", "América", "acciones"),
    "EWZ": ("Brasil", "América", "acciones"),
    "VGK": ("Europa", "Europa", "acciones"),
    "EWU": ("Reino Unido", "Europa", "acciones"),
    "EWG": ("Alemania", "Europa", "acciones"),
    "EWJ": ("Japón", "Asia-Pacífico", "acciones"),
    "FXI": ("China", "Asia-Pacífico", "acciones"),
    "INDA": ("India", "Asia-Pacífico", "acciones"),
    "EWY": ("Corea del Sur", "Asia-Pacífico", "acciones"),
    "EWT": ("Taiwán", "Asia-Pacífico", "acciones"),
    "EWA": ("Australia", "Asia-Pacífico", "acciones"),
    "EFA": ("Desarrollados sin EE. UU.", "Global", "acciones"),
    "EEM": ("Mercados emergentes", "Global", "acciones"),
    "ACWI": ("Mundo entero", "Global", "acciones"),
    "GLD": ("Oro", "Materias primas", "refugio"),
    "SLV": ("Plata", "Materias primas", "materias primas"),
    "DBC": ("Canasta de materias primas", "Materias primas", "materias primas"),
    "IEF": ("Bonos EE. UU. 7-10 años", "Bonos", "bonos"),
    "TLT": ("Bonos EE. UU. 20+ años", "Bonos", "bonos"),
    "LQD": ("Bonos corporativos EE. UU.", "Bonos", "bonos"),
    "EMB": ("Bonos de emergentes", "Bonos", "bonos"),
    "VNQ": ("Inmuebles EE. UU. (REITs)", "Inmuebles", "inmuebles"),
}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data/historico20")
    ap.add_argument("--out", default="public/data/mundo.json")
    a = ap.parse_args(argv)
    P = cargar(a.datos)
    fx = P["MXN=X"]["close"]
    spy = P["SPY"].index
    cal = spy[(spy >= INICIO) & (spy >= fx.index[0])]
    tasa, tasa_src = tasa_diaria(a.datos, cal)
    tramos = {"t1": cal[cal < CORTE], "t2": cal[cal >= CORTE], "todo": cal}
    out = {"periodo": {"inicio": str(cal[0].date()), "fin": str(cal[-1].date()), "corte": str(CORTE.date())}, "tasa_efectivo": tasa_src,
           "regla": "sma200_mensual", "mercados": {}, "nota": "Todo en pesos, con comisiones; fuera del mercado el dinero rinde CETES. Mercados con historia corta solo se miden desde que existen."}
    redujo, mejor_mar = 0, 0
    for t, (nombre, grupo, clase) in MERCADOS.items():
        if t not in P:
            continue
        df = P[t]
        dfm = a_mxn(df, fx, t).reindex(cal).ffill()
        inicio_ok = df.index[0] + pd.Timedelta(days=300)
        fila = {"nombre": nombre, "grupo": grupo, "clase": clase, "desde": str(df.index[0].date()), "tramos": {}}
        for k, c in tramos.items():
            c2 = c[c >= inicio_ok]
            if len(c2) < 252:
                continue
            eqf, _, cambios = simular_filtro({t: {"senal": df, "mxn": dfm}}, {t: 1.0}, "sma200_mensual", c2, tasa.reindex(c2))
            cb = dfm.close.reindex(c2).ffill()
            eqb = 100_000 * cb / cb.iloc[0]
            fila["tramos"][k] = {"filtro": {**metricas(eqf), "cambios": cambios, "crisis": en_crisis(eqf)}, "comprar_y_mantener": {**metricas(eqb), "crisis": en_crisis(eqb)}}
        tr = fila["tramos"]
        if "t1" in tr and "t2" in tr:
            fila["reduce_caida_ambos"] = all(tr[k]["filtro"]["max_dd_pct"] > tr[k]["comprar_y_mantener"]["max_dd_pct"] for k in ("t1", "t2"))
            fila["mejor_mar_t2"] = tr["t2"]["filtro"]["mar"] > tr["t2"]["comprar_y_mantener"]["mar"]
            redujo += fila["reduce_caida_ambos"]; mejor_mar += fila["mejor_mar_t2"]
        out["mercados"][t] = fila
        if "todo" in tr:
            f, b = tr["todo"]["filtro"], tr["todo"]["comprar_y_mantener"]
            print(f"{nombre:34s} desde {fila['desde']}  filtro {f['cagr_pct']:6.2f}%/{f['max_dd_pct']:6.1f}  B&H {b['cagr_pct']:6.2f}%/{b['max_dd_pct']:6.1f}"
                  + (f"  reduce caída en ambos tramos: {fila.get('reduce_caida_ambos')}" if "reduce_caida_ambos" in fila else "  (historia corta)"))
    n = sum(1 for f in out["mercados"].values() if "reduce_caida_ambos" in f)
    out["resumen"] = {"mercados_con_dos_tramos": n, "filtro_reduce_caida_en_ambos": redujo, "filtro_mejor_mar_2016_26": mejor_mar}
    print("RESUMEN:", out["resumen"])
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
