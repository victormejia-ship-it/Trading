"""Orquestador diario: datos -> motor determinista -> Claude (2 esquemas) -> guardrails -> almacenamiento.

  python -m worker.run_daily                 # producción (yfinance + Claude)
  python -m worker.run_daily --no-llm        # solo motor determinista (sin API key)
  python -m worker.run_daily --offline data  # CSVs locales en data/<TICKER>.csv
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import logging
import pathlib
import sys

from trend_risk import Config
from . import data_sources as ds
from .features import snapshot_activo, snapshot_mercado
from .guardrails import validar_mercado, validar_activo, fallback_mercado, fallback_activo
from .storage import guardar_json, guardar_supabase

log = logging.getLogger("worker")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default="watchlist.json")
    ap.add_argument("--offline", metavar="DIR", help="leer CSVs en vez de yfinance")
    ap.add_argument("--no-llm", action="store_true", help="no llamar a Claude")
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    wl = json.loads(pathlib.Path(a.watchlist).read_text())
    indices, activos = wl["indices"], wl["activos"]
    cfg = Config(riesgo_por_operacion=wl.get("riesgo_por_operacion_pct", 1.0) / 100,
                 max_posicion=wl.get("max_posicion_pct", 25) / 100)
    horas = wl.get("horas_noticias", 24)

    precios = ds.precios_csv(a.offline, indices + activos) if a.offline else ds.precios_yfinance(indices + activos)
    if "SPY" not in precios:
        log.error("Sin datos de SPY: no se puede evaluar el mercado. Abortando sin sobrescribir latest.json.")
        return 2
    fecha = str(max(df.index[-1] for df in precios.values()))[:10]

    # ---- Motor determinista
    mercado = snapshot_mercado(precios, indices, activos)
    snaps, errores = {}, []
    for t in activos:
        if t not in precios:
            errores.append({"ticker": t, "error": "sin datos de precio"}); continue
        try:
            snaps[t] = snapshot_activo(precios[t], t, cfg, wl.get("historial_dias_grafico", 260))
        except Exception as e:
            errores.append({"ticker": t, "error": str(e)})

    usar_llm = not a.no_llm
    noticias_macro = [] if a.offline else ds.noticias(None, horas) + ds.noticias("SPY", horas, 10)
    nots = {t: ([] if a.offline else ds.noticias(t, horas)) for t in snaps}

    # ---- Motor 1: Estado de mercado
    if usar_llm:
        from . import llm
        try:
            est = validar_mercado(llm.analizar_mercado(mercado, noticias_macro, fecha), mercado)
            est["fuente"] = "CLAUDE"
        except Exception as e:
            log.exception("Motor de mercado falló; se usa fallback determinista")
            est = fallback_mercado(mercado); est["error_llm"] = str(e)
    else:
        est = fallback_mercado(mercado)
    est["datos"] = mercado

    # ---- Motor 2: Timing y riesgo por activo (en paralelo)
    def _uno(t):
        snap = snaps[t]
        if usar_llm:
            try:
                r = llm.analizar_activo(snap, nots[t], est, fecha)
                r = validar_activo(r, snap, est, {n["id"] for n in nots[t]})
                r["fuente"] = "CLAUDE"
            except Exception as e:
                log.exception("%s: LLM falló; fallback determinista", t)
                r = fallback_activo(snap, est); r["error_llm"] = str(e)
        else:
            r = fallback_activo(snap, est)
        return {"ticker": t, "analisis": r, "motor": snap["motor"], "niveles": snap["niveles"],
                "senal_motor": snap["senal_motor"], "contexto": snap["contexto"], "serie": snap["serie"],
                "noticias": nots[t]}

    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        resultados = list(ex.map(_uno, list(snaps)))

    reporte = {
        "version": 1, "fecha": fecha, "generado_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "modelo": None if not usar_llm else llm.MODEL, "config": wl,
        "mercado": est, "noticias_macro": noticias_macro, "activos": resultados, "errores": errores,
    }
    p = guardar_json(reporte, a.out)
    log.info("Guardado %s (%d activos, %d errores)", p, len(resultados), len(errores))
    try:
        guardar_supabase(reporte)
    except Exception:
        log.exception("Supabase falló (el JSON ya está guardado)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
