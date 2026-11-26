"""Genera public/data/plan.json: los caminos de inversión con reglas simples y su evidencia de 20 años.

  python -m backtest.plan && python -c "from backtest.plan import carteras; carteras()" && python -m backtest.publicar_plan
"""
import json
import pathlib
from datetime import date

import pandas as pd

from backtest.cartera_nucleo import simular, tasa_diaria
from backtest.estrategia_v2 import cargar
from backtest.plan import a_mxn, INICIO, PERFILES
from backtest.publicar_evidencia import falsas_alarmas

PROCESOS = [
    {"id": "CETES", "nombre": "CETES", "rol": "Colchón y refugio", "plazo": "Corto plazo", "tipo": "cetes",
     "como": "CETES en cetesdirecto.com o un fondo de deuda de corto plazo en GBM+",
     "compra": "Siempre. Aquí va tu colchón y el dinero de cualquier índice que esté en pausa.",
     "venta": "Al vencimiento, o cuando necesites el dinero."},
    {"id": "SPY", "nombre": "S&P 500", "rol": "Núcleo", "plazo": "Largo plazo (5+ años)", "tipo": "filtro",
     "como": "SPY, IVV o VOO en el SIC desde GBM+"},
    {"id": "QQQ", "nombre": "Nasdaq 100", "rol": "Crecimiento (tecnología)", "plazo": "Largo plazo (5+ años)", "tipo": "filtro",
     "como": "QQQ (o QQQM) en el SIC desde GBM+"},
    {"id": "NAFTRACISHRS.MX", "nombre": "IPC México", "rol": "Diversificación en pesos", "plazo": "Largo plazo (5+ años)", "tipo": "filtro",
     "como": "NAFTRAC en la BMV desde GBM+"},
    {"id": "IWM", "nombre": "Russell 2000", "rol": "Empresas pequeñas de EE. UU.", "plazo": "Mediano-largo plazo (3+ años)", "tipo": "filtro",
     "como": "IWM en el SIC desde GBM+"},
]
DESCARTADOS = [
    ("Bonos largos de EE. UU. (TLT)", "En 2016-2026 rindieron 0.3% al año en pesos con una caída de −62%. CETES dio ~7% sin caídas."),
    ("RSI(2) de Connors en ETFs (corto plazo)", "Probado en 6 ETFs: en 2016-2026 rindió 3-6% al año, menos que CETES. Las comisiones se comen su pequeña ventaja."),
    ("Swing por emisora (tendencia, rupturas)", "Probado en 26 emisoras durante 20 años: 3.9% al año en la validación, por debajo de CETES."),
    ("Patrones de velas japonesas y de traders (17 estrategias)", "Ninguno superó a mantener el activo después de costos (Nison, Raschke, Wyckoff, Williams, Crabel, O'Neil…)."),
]


def main(res="reports/plan/resultado.json", perf="reports/plan/perfiles.json", datos="data/historico20", out="public/data/plan.json"):
    r = json.loads(pathlib.Path(res).read_text())
    pf = json.loads(pathlib.Path(perf).read_text())
    P = cargar(datos)
    fx = P["MXN=X"]["close"]
    spy = P["SPY"].index
    cal = spy[(spy >= INICIO) & (spy >= fx.index[0])]
    tasa, _ = tasa_diaria(datos, cal)
    procesos = []
    for p in PROCESOS:
        q = dict(p)
        if p["tipo"] == "filtro":
            t = p["id"]
            f = r["filtro_200"][t]
            c2 = cal[cal >= P[t].index[0] + pd.Timedelta(days=300)]
            _, eps, _ = simular({t: {"senal": P[t], "mxn": a_mxn(P[t], fx, t).reindex(cal).ffill()}}, {t: 1.0}, "sma200_mensual", c2, tasa.reindex(c2))
            cerrados = [e for e in eps if e["salida"]]
            q.update({"simbolo": t, "regla": "sma200_mensual",
                      "compra": "Cuando cierre el mes por ENCIMA de su media de 200 días.",
                      "venta": "Cuando cierre el mes por DEBAJO de su media de 200 días: vende y pasa ese dinero a CETES.",
                      "evidencia": {k: {"con_regla": f[k]["filtro"], "sin_regla": f[k]["comprar_y_mantener"]} for k in ("t1", "t2", "todo")},
                      "episodios": {"n": len(cerrados), "ganadores_pct": round(100 * sum(e["ret_pct"] > 0 for e in cerrados) / max(len(cerrados), 1), 1),
                                    "ret_medio_pct": round(sum(e["ret_pct"] for e in cerrados) / max(len(cerrados), 1), 2)},
                      "falsas_alarmas": falsas_alarmas(eps, t)})
        else:
            q["evidencia"] = {k: {"con_regla": r["cetes"][k]} for k in ("t1", "t2", "todo")}
        procesos.append(q)
    perfiles = {k: {"pesos": v["pesos"], "con_filtro": {t: {x: v["sma200_mensual"][t][x] for x in ("cagr_pct", "max_dd_pct", "crisis")} for t in ("t1", "t2", "todo")},
                    "sin_filtro": {t: {x: v["comprar_y_mantener"][t][x] for x in ("cagr_pct", "max_dd_pct", "crisis")} for t in ("t1", "t2", "todo")},
                    "curva": v["sma200_mensual"]["todo"]["curva"], "curva_sin": v["comprar_y_mantener"]["todo"]["curva"]} for k, v in pf.items()}
    d = {"generado": str(date.today()), "periodo": r["periodo"], "tasa_efectivo": r["tasa_efectivo"], "procesos": procesos,
         "perfiles": perfiles, "descartados": [{"nombre": n, "razon": z} for n, z in DESCARTADOS],
         "nota": "Pesos por perfil fijados por diversificación, no optimizados con los datos. Rendimientos en pesos, con comisiones de GBM; el dinero en pausa rinde CETES."}
    pathlib.Path(out).write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    for q in procesos:
        print(q["nombre"], q.get("episodios"), q.get("falsas_alarmas"))


if __name__ == "__main__":
    main()
