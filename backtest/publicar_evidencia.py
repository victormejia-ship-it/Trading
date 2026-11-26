"""Resume los backtests en public/data/estrategia.json: la evidencia histórica que la web muestra junto a cada señal.

  python -m backtest.publicar_evidencia
"""
import json
import pathlib
from datetime import date

import pandas as pd

SIMBOLO_WEB = {"IPC": "NAFTRACISHRS.MX", "S&P 500 (SIC, MXN)": "SPY"}
COMO_COMPRAR = {"IPC": "NAFTRAC (NAFTRACISHRS) en la BMV desde GBM+",
                "S&P 500 (SIC, MXN)": "SPY (o IVV/VOO, que replican el mismo índice) en el SIC desde GBM+"}


def falsas_alarmas(episodios, manga, dias=92):
    """Salidas a efectivo que se revirtieron (nueva entrada) en menos de `dias` días."""
    eps = sorted([e for e in episodios if e["manga"] == manga], key=lambda e: e["entrada"])
    salidas = [e for e in eps if e["salida"]]
    if not salidas:
        return None
    revertidas = 0
    for a, b in zip(eps, eps[1:]):
        if a["salida"] and (pd.Timestamp(b["entrada"]) - pd.Timestamp(a["salida"])).days < dias:
            revertidas += 1
    return {"salidas": len(salidas), "revertidas_menos_3_meses": revertidas,
            "pct": round(100 * revertidas / len(salidas), 1)}


def main(cn="reports/cartera_nucleo/resultado.json", v2="reports/backtest_v2_20a/resultado.json", out="public/data/estrategia.json"):
    r = json.loads(pathlib.Path(cn).read_text())
    filas = {(f["cartera"], f["regla"]): f for f in r["resultados"]}
    # Recomendada: mejor MAR en el tramo 1 entre todas las carteras y reglas con filtro (protocolo fijado antes de ver el tramo 2)
    candidatas = [f for f in r["resultados"] if f["regla"] != "comprar_y_mantener"]
    rec = max(candidatas, key=lambda f: f["tramo1_ajuste"]["mar"])
    bh = filas[(rec["cartera"], "comprar_y_mantener")]
    resumen = lambda f: {k: {x: f[k][x] for x in ("cagr_pct", "max_dd_pct", "mar", "cambios", "crisis") if x in f[k]} for k in ("completo", "tramo1_ajuste", "tramo2_validacion")}
    mangas = {}
    for m in SIMBOLO_WEB:
        f, b = filas[(m, rec["regla"])], filas[(m, "comprar_y_mantener")]
        mangas[m] = {"simbolo": SIMBOLO_WEB[m], "como_comprar": COMO_COMPRAR[m], "regla": rec["regla"],
                     "con_regla": resumen(f), "comprar_y_mantener": resumen(b), "episodios": f["episodios_stats"],
                     "falsas_alarmas": falsas_alarmas(f["episodios"], m),
                     "ultimos_cambios": [e for e in f["episodios"]][-6:]}
    pesos = {"IPC": 0.5, "S&P 500 (SIC, MXN)": 0.5} if rec["cartera"].startswith("50%") else {rec["cartera"]: 1.0}
    out_d = {
        "generado": str(date.today()), "periodo": r["periodo"], "fuentes": r["fuentes"], "costos_por_lado_pct": r["costos_por_lado_pct"],
        "protocolo": "Reglas elegidas con 2006-2015 (mejor MAR) y medidas una sola vez en 2016-2026.",
        "recomendada": {"cartera": rec["cartera"], "regla": rec["regla"], "pesos": pesos, "con_regla": resumen(rec), "comprar_y_mantener": resumen(bh),
                        "curva": rec["curva"], "curva_bh": bh["curva"]},
        "mangas": mangas,
        "tabla": [{"cartera": f["cartera"], "regla": f["regla"], **resumen(f)} for f in r["resultados"]],
    }
    p = pathlib.Path(v2)
    if p.exists():
        s = json.loads(p.read_text())
        el = next(f for f in s["rejilla"] if f["nombre"] == s["elegida"])
        out_d["swing_v2"] = {"elegida": s["elegida"], "tramos": s["tramos"],
                             "tramo1": el["tramo1_ajuste"]["metricas"], "tramo2": el["tramo2_validacion"]["metricas"],
                             "benchmarks": s["benchmarks"], "todas_t2_negativas": all(f["tramo2_validacion"]["metricas"]["cagr_pct"] < 0 for f in s["rejilla"])}
    pathlib.Path(out).write_text(json.dumps(out_d, ensure_ascii=False, separators=(",", ":")))
    print("Recomendada:", rec["cartera"], rec["regla"], "| T2", rec["tramo2_validacion"]["cagr_pct"], rec["tramo2_validacion"]["max_dd_pct"],
          "| B&H T2", bh["tramo2_validacion"]["cagr_pct"], bh["tramo2_validacion"]["max_dd_pct"])
    for m, v in mangas.items():
        print(m, "episodios", v["episodios"], "falsas alarmas", v["falsas_alarmas"])


if __name__ == "__main__":
    main()
