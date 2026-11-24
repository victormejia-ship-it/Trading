"""Persistencia: JSON estático (siempre) + Supabase/PostgREST (opcional)."""
from __future__ import annotations

import json
import logging
import os
import pathlib

import requests

log = logging.getLogger(__name__)


def guardar_json(reporte: dict, raiz: str | pathlib.Path = "public/data") -> pathlib.Path:
    raiz = pathlib.Path(raiz)
    (raiz / "history").mkdir(parents=True, exist_ok=True)
    txt = json.dumps(reporte, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    (raiz / "latest.json").write_text(txt)
    hist = raiz / "history" / f"{reporte['fecha']}.json"
    hist.write_text(txt)
    idx = sorted(p.stem for p in (raiz / "history").glob("*.json"))
    (raiz / "history" / "index.json").write_text(json.dumps(idx))
    return hist


def guardar_supabase(reporte: dict) -> None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates,return=minimal"}
    filas = [{"fecha": reporte["fecha"], "tipo": "MERCADO", "ticker": "_MERCADO", "payload": reporte["mercado"]}]
    filas += [{"fecha": reporte["fecha"], "tipo": "ACTIVO", "ticker": a["ticker"], "payload": a} for a in reporte["activos"]]
    r = requests.post(f"{url}/rest/v1/analisis_diario?on_conflict=fecha,ticker", headers=h, json=filas, timeout=60)
    r.raise_for_status()
    log.info("Supabase: %d filas upsert", len(filas))
