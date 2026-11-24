"""Motor de decisión: fase del ciclo, niveles, riesgo, escenarios y timing.

Todas las reglas son deterministas y trazables. Las probabilidades de escenarios
son HEURÍSTICAS (scoring técnico + noticias), no un modelo calibrado.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict

import numpy as np
import pandas as pd

from .indicators import enrich, pivots

ACUMULACION = "ACUMULACION"
TEMPRANA = "TENDENCIA_ALCISTA_TEMPRANA"
EXTENDIDA = "TENDENCIA_EXTENDIDA"
BAJISTA = "DISTRIBUCION_O_BAJISTA"
NEUTRAL = "TRANSICION_SIN_FASE_CLARA"


@dataclass
class Config:
    riesgo_por_operacion: float = 0.01      # 1% del portafolio
    rr_minimo: float = 2.0                  # filtro de asimetría 1:2
    atr_mult_normal: float = 1.5
    atr_mult_alta_vol: float = 2.0
    umbral_alta_vol: float = 0.035          # ATR% > 3.5% -> usar 2.0x
    extension_max: float = 0.15             # >15% sobre SMA50
    rsi_extendido: float = 72.0
    rsi_sobreventa: float = 35.0
    vol_confirmacion: float = 1.5           # volumen ruptura > 1.5x media 20
    max_posicion: float = 0.25              # tope de concentración (25% del capital)
    pivot_k: int = 5


@dataclass
class Escenario:
    nombre: str
    probabilidad: int
    objetivo: float
    descripcion: str


@dataclass
class Plan:
    activo: str
    fecha: str
    precio: float
    fase: str
    evidencia_fase: list
    indicadores: dict
    orden: str
    horizonte: str
    entrada: float | None
    stop_loss: float | None
    soporte: float | None
    resistencia_1: float | None
    resistencia_1_origen: str
    objetivo_2: float | None
    distancia_stop_pct: float | None
    tamano_posicion_pct: float | None
    tamano_posicion_formula_pct: float | None
    rr: float | None
    trailing_stop: float | None
    gatillo_compra: str
    gatillo_salida: list
    invalidacion_temporal: str
    escenarios: list = field(default_factory=list)
    noticias: dict | None = None
    alertas: list = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        return d


# ---------------------------------------------------------------- utilidades

def _r(x, nd=2):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), nd)


def _paso_redondo(precio: float) -> float:
    """Escala de los 'números redondos obvios' según magnitud del precio."""
    mag = 10 ** math.floor(math.log10(max(precio, 1e-9)))
    return mag / 2 if precio / mag < 3 else mag  # ej. 187 -> 50 ; 45 -> 5 ; 920 -> 100


def evitar_numero_redondo(stop: float, atr: float, precio: float) -> float:
    """Si el stop cae cerca de un número redondo (zona de barrido de liquidez), lo
    desplaza por debajo del nivel: nivel redondo - 0.25*ATR."""
    for paso in (_paso_redondo(precio), _paso_redondo(precio) / 5, _paso_redondo(precio) / 10):
        if paso <= 0:
            continue
        nivel = round(stop / paso) * paso
        if abs(stop - nivel) <= 0.15 * atr:
            return nivel - 0.25 * atr
    return stop


def _probabilidades(score: float, extension: float, cfg: Config) -> tuple[int, int, int]:
    """score en [-1,1] -> (alcista, base, bajista) enteros que suman exactamente 100."""
    score = max(-1.0, min(1.0, score))
    bull = 0.33 + 0.27 * score
    bear = 0.33 - 0.27 * score
    if extension > cfg.extension_max:  # reversión a la media: se recorta el alcista
        exceso = min(0.15, (extension - cfg.extension_max))
        bull -= exceso
        bear += exceso / 2
    bull, bear = max(0.05, bull), max(0.05, bear)
    base = max(0.10, 1 - bull - bear)
    raw = np.array([bull, base, bear])
    raw = raw / raw.sum() * 100
    ent = np.floor(raw).astype(int)
    resto = 100 - ent.sum()
    for i in np.argsort(-(raw - ent))[:resto]:
        ent[i] += 1
    assert ent.sum() == 100
    return tuple(int(v) for v in ent)


# ---------------------------------------------------------------- análisis

def analyze(df: pd.DataFrame, activo: str, cfg: Config | None = None, noticias: dict | None = None) -> Plan:
    """df: índice fecha, columnas open/high/low/close/volume (diario). >= 220 velas."""
    cfg = cfg or Config()
    df = df.sort_index()
    if len(df) < 220:
        raise ValueError(f"{activo}: se requieren >= 220 velas diarias (hay {len(df)}) para SMA200 con pendiente.")
    d = enrich(df)
    last = d.iloc[-1]
    c, atr = float(last.close), float(last.atr14)
    s20, s50, s200 = float(last.sma20), float(last.sma50), float(last.sma200)
    rsi = float(last.rsi14)
    hist = float(last.macd_hist)
    atr_pct = atr / c
    ext50 = c / s50 - 1
    pend50 = s50 / float(d["sma50"].iloc[-11]) - 1
    pend200 = s200 / float(d["sma200"].iloc[-21]) - 1
    macd_cruce_alcista = hist > 0 and (d["macd_hist"].iloc[-15:] <= 0).any()
    vol_ok = "volume" in d and d["volume"].iloc[-20:].sum() > 0
    vol_ratio = float(last.volume / last.vol20) if vol_ok and last.vol20 else float("nan")

    # volumen vendedor: vol medio en días bajistas vs alcistas (últimas 10 sesiones)
    vol_vendedor = float("nan")
    if vol_ok:
        w = d.iloc[-10:]
        dn = w[w.close < w.close.shift(1).fillna(w.close.iloc[0])]["volume"].mean()
        up = w[w.close >= w.close.shift(1).fillna(w.close.iloc[0])]["volume"].mean()
        vol_vendedor = float(dn / up) if up and not np.isnan(dn) else float("nan")

    news_score = float((noticias or {}).get("score", 0.0))
    news_nota = (noticias or {}).get("nota", "")

    # rango de acumulación / contracción de volatilidad
    rango20_hi = float(d["high"].iloc[-20:].max())
    rango20_lo = float(d["low"].iloc[-20:].min())
    contraccion = float(last.atr14 / last.atr50) < 0.9 if last.atr50 else False
    rsi_min_reciente = float(d["rsi14"].iloc[-30:].min())
    dd_60 = c / float(d["close"].iloc[-120:].max()) - 1

    # ---------------- Fase del ciclo (orden de prioridad = prudencia del CRO)
    ev: list[str] = []
    if news_score <= -0.6:
        fase = BAJISTA
        ev.append(f"Catalizador de noticias negativo severo (score {news_score:+.2f}) prevalece sobre la técnica.")
    elif c > s50 and (ext50 > cfg.extension_max or rsi > cfg.rsi_extendido):
        fase = EXTENDIDA
        ev.append(f"Precio {ext50:+.1%} vs SMA50 (umbral +{cfg.extension_max:.0%}); RSI {rsi:.1f} (umbral {cfg.rsi_extendido:.0f}).")
    elif (c < s50 and c < s200) or (c < s50 and vol_vendedor > 1.2):
        fase = BAJISTA
        if c < s50 and c < s200:
            ev.append("Precio por debajo de SMA50 y SMA200.")
        if not np.isnan(vol_vendedor) and vol_vendedor > 1.2:
            ev.append(f"Volumen en días bajistas {vol_vendedor:.2f}x el de días alcistas (10 sesiones).")
    elif c > s50 and c > s200 and pend50 > 0 and hist > 0:
        fase = TEMPRANA
        ev.append(f"Precio > SMA50 y SMA200; pendiente SMA50 {pend50:+.2%} (10 ses.); MACD hist {hist:+.3f}"
                  + (" (cruce alcista reciente)." if macd_cruce_alcista else "."))
    elif (dd_60 < -0.12 or c < s200) and contraccion and rsi_min_reciente < cfg.rsi_sobreventa and rsi > cfg.rsi_sobreventa:
        fase = ACUMULACION
        ev.append(f"Drawdown {dd_60:.1%} desde máx. 6m; ATR14/ATR50 {last.atr14 / last.atr50:.2f} (contracción); "
                  f"RSI salió de {rsi_min_reciente:.1f} a {rsi:.1f}.")
    else:
        fase = NEUTRAL
        ev.append("No cumple de forma completa ningún patrón de fase; se trata como transición.")

    # ---------------- Niveles estructurales
    lows = pivots(d["low"].iloc[-120:], cfg.pivot_k, "low")
    highs = pivots(d["high"].iloc[-252:], cfg.pivot_k, "high")

    if fase == ACUMULACION:
        entrada = rango20_hi + 0.1 * atr          # compra en ruptura del rango
        soporte = rango20_lo
    elif fase == TEMPRANA:
        entrada = s20 if c > s20 + 0.5 * atr else c   # retroceso a SMA20
        cand = lows[lows < entrada]
        soporte = float(cand.iloc[-1]) if len(cand) else min(s50, entrada - 2 * atr)
        soporte = min(soporte, entrada - 0.5 * atr)
    else:
        entrada = c
        cand = lows[lows < c]
        soporte = float(cand.iloc[-1]) if len(cand) else float(d["low"].iloc[-20:].min())

    mult = cfg.atr_mult_alta_vol if atr_pct > cfg.umbral_alta_vol else cfg.atr_mult_normal
    stop = evitar_numero_redondo(soporte - mult * atr, atr, c)
    dist = (entrada - stop) / entrada

    # resistencias ya superadas por el precio actual no cuentan (niveles rotos)
    res_cand = highs[highs > max(entrada, c) * 1.005]
    if len(res_cand):
        r1 = float(res_cand.min())
        r1_origen = "máximo de pivote (12 meses)"
        mayores = res_cand[res_cand > r1 + atr]
        r2 = float(mayores.min()) if len(mayores) else r1 + 2 * atr
    else:
        r1 = entrada + 3 * atr
        r1_origen = "proyección 3xATR (sin resistencia previa: zona de máximos)"
        r2 = entrada + 5 * atr

    rr = (r1 - entrada) / (entrada - stop) if entrada > stop else None
    size_formula = cfg.riesgo_por_operacion / dist if dist > 0 else None
    size = min(size_formula, cfg.max_posicion) if size_formula else None

    hh22 = float(d["high"].iloc[-22:].max())
    trailing = max(s20, hh22 - 2 * atr)

    # ---------------- Orden, horizonte y timing
    alertas: list[str] = []
    rr_ok = rr is not None and rr >= cfg.rr_minimo
    sesiones = int(min(20, max(5, round(1.5 * (r1 - entrada) / atr))))
    salida = [
        f"TP escalonado: vender 50% en Objetivo 1 = {r1:.2f}.",
        f"50% restante con Trailing Stop en SMA20 (hoy {s20:.2f}); salir con cierre diario por debajo.",
        f"Stop Loss duro: {stop:.2f} (cierre diario o toque intradía, según disciplina definida).",
    ]
    invalid = (f"Si en {sesiones} sesiones el precio no supera {r1:.2f}, cerrar por costo de oportunidad.")

    if fase == EXTENDIDA:
        orden = "TOMA_PARCIAL_GANANCIAS"
        horizonte = "Intradía/Swing corto (1-5 días) — gestión de posición existente"
        gatillo = "PROHIBIDO comprar. Nueva entrada solo tras retroceso a SMA20 con RSI < 60 y R:R >= 2."
        salida = [
            f"Vender 33% ahora / 33% si RSI diario > 78 o precio > SMA50 x1.20 ({s50 * 1.2:.2f}).",
            f"Resto con Trailing Stop = max(SMA20, máx.22 - 2xATR) = {trailing:.2f}; salir con cierre diario por debajo.",
        ]
        invalid = "Si en 5 sesiones no hace nuevo máximo, subir el trailing a SMA20 estricto."
        size = size_formula = None
    elif fase == BAJISTA:
        orden = "VENDER_CERRAR_POSICIONES" if c < s50 else "NO_OPERAR"
        horizonte = "Inmediato (1-5 días) — protección en liquidez"
        gatillo = (f"Sin compras. Re-evaluar solo con cierre diario > SMA50 ({s50:.2f}) y SMA50 con pendiente positiva.")
        salida = [f"Cerrar posiciones largas; si se escalona, todo fuera con cierre < {stop:.2f}."]
        invalid = "N/A — fase defensiva."
        size = size_formula = None
    elif fase == ACUMULACION:
        horizonte = "Posicional (1-3 meses)"
        gatillo = (f"Cierre DIARIO > {entrada:.2f} (máx. rango 20 ses. + 0.1xATR) con volumen > "
                   f"{cfg.vol_confirmacion:.1f}x media 20 ({(last.vol20 or 0) * cfg.vol_confirmacion:,.0f}).")
        orden = "ESPERAR_MEJOR_TIMING" if rr_ok else "NO_OPERAR"
        alertas.append("Orden condicional: la entrada solo existe si se confirma la ruptura con volumen.")
        invalid = f"Si en {max(sesiones, 10)} sesiones tras la ruptura no supera {r1:.2f}, cerrar; si vuelve dentro del rango y cierra < {rango20_lo:.2f}, salida inmediata."
    elif fase == TEMPRANA:
        horizonte = "Swing medio (2-6 semanas)"
        gatillo = (f"Orden límite en zona SMA20 {entrada:.2f} (±0.25xATR = {entrada - .25 * atr:.2f}-{entrada + .25 * atr:.2f}); "
                   f"confirmar con cierre diario que respete la SMA20 o vela de rechazo en H4.")
        orden = "COMPRAR_EN_RETROCESO" if rr_ok else "ESPERAR_MEJOR_TIMING"
    else:
        horizonte = "Sin horizonte — observar"
        gatillo = f"Esperar definición: cierre > SMA50 ({s50:.2f}) con MACD > señal, o pérdida de SMA200 ({s200:.2f})."
        orden = "ESPERAR_MEJOR_TIMING" if c > s200 else "NO_OPERAR"

    if fase in (ACUMULACION, TEMPRANA, NEUTRAL) and not rr_ok:
        e_req = (r1 + cfg.rr_minimo * stop) / (1 + cfg.rr_minimo)
        alertas.append(f"Filtro de asimetría: R:R {rr:.2f} < 1:{cfg.rr_minimo:.1f} -> no se ejecuta. "
                       f"Con este stop/objetivo, la entrada debería ser <= {e_req:.2f} "
                       f"(o esperar ruptura de {r1:.2f} y recalcular).")
    if size_formula and size_formula > cfg.max_posicion:
        alertas.append(f"Fórmula 1%/dist = {size_formula:.1%}; recortada al tope de concentración {cfg.max_posicion:.0%}.")
    if r1_origen.startswith("proyección"):
        alertas.append("Activo en máximos: Objetivo 1 es proyección por volatilidad, no resistencia observada.")
    if news_score <= -0.3 and fase != BAJISTA:
        alertas.append(f"Flujo de noticias negativo ({news_score:+.2f}): reducir tamaño a la mitad o esperar.")

    # ---------------- Escenarios ponderados
    score = (
        0.30 * np.sign(c - s50) + 0.20 * np.sign(c - s200) + 0.15 * np.sign(pend50)
        + 0.15 * np.sign(hist) + 0.10 * ((rsi - 50) / 50) + 0.10 * news_score
    )
    pb, pn, pd_ = _probabilidades(float(score), ext50, cfg)
    esc = [
        Escenario("Alcista", pb, _r(r1), f"Continuación hacia {r1:.2f}; extensión a {r2:.2f} si rompe con volumen."),
        Escenario("Base/Consolidación", pn, _r(c), f"Rango {c - 1.5 * atr:.2f} - {c + 1.5 * atr:.2f} (±1.5xATR)."),
        Escenario("Bajista", pd_, _r(stop), f"Pérdida de soporte {soporte:.2f}; activa stop {stop:.2f}"
                  + (f", siguiente referencia SMA200 {s200:.2f}." if s200 < stop else ".")),
    ]

    return Plan(
        activo=activo, fecha=str(d.index[-1])[:10], precio=_r(c), fase=fase, evidencia_fase=ev,
        indicadores={
            "SMA20": _r(s20), "SMA50": _r(s50), "SMA200": _r(s200), "RSI14": _r(rsi, 1),
            "MACD_hist": _r(hist, 4), "ATR14": _r(atr), "ATR%": _r(atr_pct * 100), "Ext_vs_SMA50_%": _r(ext50 * 100),
            "Pend_SMA50_10s_%": _r(pend50 * 100), "Pend_SMA200_20s_%": _r(pend200 * 100),
            "Vol/Vol20": _r(vol_ratio), "Vol_vendedor_ratio": _r(vol_vendedor), "Mult_ATR_stop": mult,
        },
        orden=orden, horizonte=horizonte, entrada=_r(entrada), stop_loss=_r(stop), soporte=_r(soporte),
        resistencia_1=_r(r1), resistencia_1_origen=r1_origen, objetivo_2=_r(r2),
        distancia_stop_pct=_r(dist * 100), tamano_posicion_pct=_r(size * 100) if size else None,
        tamano_posicion_formula_pct=_r(size_formula * 100) if size_formula else None,
        rr=_r(rr), trailing_stop=_r(trailing), gatillo_compra=gatillo, gatillo_salida=salida,
        invalidacion_temporal=invalid, escenarios=[asdict(e) for e in esc],
        noticias={"score": news_score, "nota": news_nota} if noticias else None, alertas=alertas,
    )
