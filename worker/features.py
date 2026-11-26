"""Cálculo determinista: todo número que ve el LLM o la web sale de aquí."""
from __future__ import annotations

import math

import pandas as pd

from trend_risk import analyze, Config
from trend_risk.indicators import enrich

# Mapeo orden del motor -> señal de la app
SENAL_MOTOR = {
    "COMPRAR_EN_RETROCESO": "COMPRAR",
    "TOMA_PARCIAL_GANANCIAS": "VENDER_TOMA_GANANCIAS",
    "VENDER_CERRAR_POSICIONES": "VENDER_CERRAR",
    "NO_OPERAR": "NO_COMPRAR",
}


def _num(x, nd=2):
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else round(x, nd)


def serie_grafico(df: pd.DataFrame, dias: int) -> list[dict]:
    e = enrich(df)
    e["ema21"] = e["close"].ewm(span=21, adjust=False).mean()
    e = e.iloc[-dias:]
    return [{"t": str(i)[:10], "o": _num(r.open, 4), "h": _num(r.high, 4), "l": _num(r.low, 4), "c": _num(r.close, 4),
             "v": _num(r.volume, 0), "sma20": _num(r.sma20, 4), "sma50": _num(r.sma50, 4), "sma200": _num(r.sma200, 4),
             "ema21": _num(r.ema21, 4)} for i, r in e.iterrows()]


def snapshot_activo(df: pd.DataFrame, ticker: str, cfg: Config, dias_grafico: int) -> dict:
    plan = analyze(df, ticker, cfg).to_dict()
    if plan["orden"] == "ESPERAR_MEJOR_TIMING":
        senal = "ESPERAR_RUPTURA" if plan["fase"] == "ACUMULACION" else "ESPERAR_SOPORTE"
    else:
        senal = SENAL_MOTOR.get(plan["orden"], "NO_COMPRAR")
    e = enrich(df)
    c = e["close"]
    contexto = {
        "ret_5d_%": _num((c.iloc[-1] / c.iloc[-6] - 1) * 100),
        "ret_20d_%": _num((c.iloc[-1] / c.iloc[-21] - 1) * 100),
        "ret_60d_%": _num((c.iloc[-1] / c.iloc[-61] - 1) * 100),
        "max_52s": _num(e["high"].iloc[-252:].max()),
        "min_52s": _num(e["low"].iloc[-252:].min()),
        "macd": _num(e["macd"].iloc[-1], 4),
        "macd_senal": _num(e["macd_sig"].iloc[-1], 4),
        "ultimas_10_velas": [
            {"t": str(i)[:10], "o": _num(r.open), "h": _num(r.high), "l": _num(r.low), "c": _num(r.close), "v": _num(r.volume, 0)}
            for i, r in e.iloc[-10:].iterrows()
        ],
    }
    niveles = {k: plan[k] for k in ("entrada", "soporte", "stop_loss", "resistencia_1", "objetivo_2", "trailing_stop")}
    niveles.update(sma20=plan["indicadores"]["SMA20"], sma50=plan["indicadores"]["SMA50"],
                   sma200=plan["indicadores"]["SMA200"], precio=plan["precio"])
    return {"ticker": ticker, "motor": plan, "senal_motor": senal, "niveles": niveles,
            "contexto": contexto, "serie": serie_grafico(df, dias_grafico)}


def snapshot_mercado(precios: dict[str, pd.DataFrame], indices: list[str], activos: list[str],
                     enriquecidos: dict[str, pd.DataFrame] | None = None) -> dict:
    """Variables de régimen + topes deterministas de exposición.
    `enriquecidos` (opcional): indicadores ya calculados y cortados a la fecha (backtest); deben ser causales."""
    _e = (lambda t: enriquecidos[t]) if enriquecidos is not None else (lambda t: enrich(precios[t]))
    filas = {}
    for t in indices:
        if t not in precios:
            continue
        e = _e(t)
        l = e.iloc[-1]
        filas[t] = {
            "precio": _num(l.close), "sma50": _num(l.sma50), "sma200": _num(l.sma200), "rsi14": _num(l.rsi14, 1),
            "sobre_sma50": bool(l.close > l.sma50), "sobre_sma200": bool(l.close > l.sma200),
            "dist_sma200_%": _num((l.close / l.sma200 - 1) * 100),
            "ret_5d_%": _num((l.close / e.close.iloc[-6] - 1) * 100),
            "ret_20d_%": _num((l.close / e.close.iloc[-21] - 1) * 100),
            "atr_%": _num(l.atr14 / l.close * 100),
            "macd_hist": _num(l.macd_hist, 4),
        }
    univ = [t for t in activos + indices if t in precios and not t.startswith("^") and "=" not in t]
    sobre50 = [bool(_e(t).iloc[-1].pipe(lambda r: r.close > r.sma50)) for t in univ]
    amplitud = round(100 * sum(sobre50) / len(sobre50), 1) if sobre50 else None

    # ---- Topes duros (el LLM solo puede ser MÁS conservador que esto)
    tope, razones = 100, []
    spy, vix = filas.get("SPY"), filas.get("^VIX")
    if spy and not spy["sobre_sma200"]:
        tope = min(tope, 30); razones.append("SPY bajo SMA200 -> exposición máx. 30%")
    elif spy and not spy["sobre_sma50"]:
        tope = min(tope, 60); razones.append("SPY bajo SMA50 -> exposición máx. 60%")
    if vix:
        if vix["precio"] > 30:
            tope = min(tope, 25); razones.append("VIX > 30 -> exposición máx. 25%")
        elif vix["precio"] > 20:
            tope = min(tope, 60); razones.append("VIX > 20 -> exposición máx. 60%")
    if amplitud is not None and amplitud < 40:
        tope = min(tope, 50); razones.append(f"Amplitud {amplitud}% < 40% -> exposición máx. 50%")
    verde_permitido = bool(spy and spy["sobre_sma200"] and (not vix or vix["precio"] <= 25))
    rojo_forzado = bool(spy and not spy["sobre_sma200"] and vix and vix["precio"] > 30)
    return {"indices": filas, "amplitud_sobre_sma50_%": amplitud, "tope_exposicion_pct": tope,
            "razones_tope": razones, "verde_permitido": verde_permitido, "rojo_forzado": rojo_forzado}
