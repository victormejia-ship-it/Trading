"""Descarga de precios y noticias. Todo lo que entra al LLM sale de aquí (ancla anti-alucinación)."""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
import pathlib

import pandas as pd
import requests

log = logging.getLogger(__name__)
COLS = ["open", "high", "low", "close", "volume"]


# ------------------------------------------------------------------ precios

def precios_yfinance(tickers: list[str], periodo: str = "2y") -> dict[str, pd.DataFrame]:
    import yfinance as yf
    out = {}
    for t in tickers:
        try:
            df = yf.download(t, period=periodo, interval="1d", auto_adjust=True,
                             progress=False, multi_level_index=False, threads=False)
            df.columns = [c.lower() for c in df.columns]
            df = df[COLS].dropna(subset=["close"])
            df["volume"] = df["volume"].fillna(0)
            if len(df) < 220:
                log.warning("%s: solo %d velas, se omite", t, len(df))
                continue
            out[t] = df
        except Exception as e:  # red, ticker delistado, etc.
            log.error("%s: fallo de descarga: %s", t, e)
    return out


def precios_csv(directorio: str | pathlib.Path, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """Modo offline: data/<TICKER>.csv con date,open,high,low,close,volume."""
    out = {}
    for t in tickers:
        p = pathlib.Path(directorio) / f"{t.replace('^', '')}.csv"
        if p.exists():
            df = pd.read_csv(p, parse_dates=["date"]).set_index("date")
            df.columns = [c.lower() for c in df.columns]
            out[t] = df[COLS]
    return out


# ------------------------------------------------------------------ noticias

def _nid(titulo: str, fuente: str) -> str:
    return "N" + hashlib.sha1(f"{fuente}|{titulo}".encode()).hexdigest()[:8]


def _limpio(txt: str | None, n: int) -> str:
    return " ".join((txt or "").split())[:n]


def noticias_yfinance(ticker: str, horas: int) -> list[dict]:
    import yfinance as yf
    limite = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=horas)
    out = []
    try:
        items = yf.Ticker(ticker).news or []
    except Exception as e:
        log.warning("noticias %s: %s", ticker, e)
        return out
    for it in items:
        c = it.get("content", it)  # yfinance >= 0.2.50 anida en 'content'
        titulo = c.get("title")
        fecha = c.get("pubDate") or c.get("displayTime")
        if not fecha and it.get("providerPublishTime"):
            fecha = dt.datetime.fromtimestamp(it["providerPublishTime"], dt.timezone.utc).isoformat()
        if not titulo or not fecha:
            continue
        ts = pd.Timestamp(fecha)
        ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts
        if ts.to_pydatetime() < limite:
            continue
        fuente = (c.get("provider") or {}).get("displayName", "") if isinstance(c.get("provider"), dict) else c.get("publisher", "")
        url = (c.get("canonicalUrl") or {}).get("url", "") if isinstance(c.get("canonicalUrl"), dict) else c.get("link", "")
        out.append({"id": _nid(titulo, fuente), "ticker": ticker, "fecha": ts.isoformat(), "fuente": fuente,
                    "titulo": _limpio(titulo, 300), "resumen": _limpio(c.get("summary"), 600), "url": url})
    return out


def noticias_finnhub(ticker: str | None, horas: int) -> list[dict]:
    """Opcional (FINNHUB_API_KEY). ticker=None -> noticias macro generales."""
    key = os.environ.get("FINNHUB_API_KEY")
    if not key:
        return []
    hoy = dt.date.today()
    desde = hoy - dt.timedelta(days=max(1, horas // 24 + 1))
    if ticker:
        url, params = "https://finnhub.io/api/v1/company-news", {"symbol": ticker, "from": str(desde), "to": str(hoy)}
    else:
        url, params = "https://finnhub.io/api/v1/news", {"category": "general"}
    try:
        r = requests.get(url, params=params, headers={"X-Finnhub-Token": key}, timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.warning("finnhub %s: %s", ticker, e)
        return []
    limite = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=horas)).timestamp()
    return [{"id": _nid(n["headline"], n.get("source", "")), "ticker": ticker or "MACRO",
             "fecha": dt.datetime.fromtimestamp(n["datetime"], dt.timezone.utc).isoformat(),
             "fuente": n.get("source", ""), "titulo": _limpio(n["headline"], 300),
             "resumen": _limpio(n.get("summary"), 600), "url": n.get("url", "")}
            for n in r.json() if n.get("datetime", 0) >= limite and n.get("headline")]


def noticias(ticker: str | None, horas: int, max_items: int = 15) -> list[dict]:
    items = noticias_finnhub(ticker, horas)
    if ticker:
        items += noticias_yfinance(ticker, horas)
    vistos, out = set(), []
    for n in sorted(items, key=lambda x: x["fecha"], reverse=True):
        if n["id"] not in vistos:
            vistos.add(n["id"])
            out.append(n)
    return out[:max_items]
