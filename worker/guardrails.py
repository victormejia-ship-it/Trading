"""Validación post-LLM. El LLM propone; estas reglas deciden. Cada corrección queda registrada."""
from __future__ import annotations

import re

import numpy as np

AJUSTE_FACTOR = {"COMPLETO": 1.0, "MEDIO": 0.5, "CUARTO": 0.25, "CERO": 0.0}
SENALES_COMPRA = {"COMPRAR"}


def _normalizar_100(vals: list[int]) -> list[int]:
    v = np.clip(np.array(vals, dtype=float), 0, None)
    if v.sum() == 0:
        v = np.ones(3)
    raw = v / v.sum() * 100
    ent = np.floor(raw).astype(int)
    for i in np.argsort(-(raw - ent))[: 100 - ent.sum()]:
        ent[i] += 1
    return [int(x) for x in ent]


def validar_mercado(llm: dict, mercado: dict) -> dict:
    corr = []
    tope = mercado["tope_exposicion_pct"]
    exp = int(llm.get("exposicion_maxima_pct", 0))
    if exp > tope or exp < 0:
        corr.append(f"Exposición {exp}% fuera de [0, {tope}] (tope duro) -> {min(max(exp, 0), tope)}%")
        exp = min(max(exp, 0), tope)
    sem = llm["semaforo"]
    if sem == "VERDE_COMPRAR" and not mercado["verde_permitido"]:
        corr.append("VERDE no permitido por reglas duras (SPY<SMA200 o VIX>25) -> AMARILLO_CAUTELA")
        sem = "AMARILLO_CAUTELA"
    if mercado["rojo_forzado"] and sem != "ROJO_NO_COMPRAR":
        corr.append("Reglas duras fuerzan ROJO (SPY<SMA200 y VIX>30)")
        sem = "ROJO_NO_COMPRAR"
    if sem == "ROJO_NO_COMPRAR":
        exp = min(exp, 25)
    return {**llm, "semaforo": sem, "exposicion_maxima_pct": exp, "correcciones_guardrail": corr}


def validar_activo(llm: dict, snap: dict, estado_mercado: dict, ids_noticias: set[str]) -> dict:
    corr = []
    m = snap["motor"]
    out = dict(llm)

    # 1) Escenarios: suman 100 y niveles resueltos SOLO desde el motor
    esc = out["escenarios"]
    nombres = ["alcista", "lateral", "bajista"]
    probs = [int(esc[n]["probabilidad"]) for n in nombres]
    if sum(probs) != 100 or min(probs) < 0:
        nuevas = _normalizar_100(probs)
        corr.append(f"Probabilidades {probs} no sumaban 100 -> {nuevas}")
        probs = nuevas
    out["escenarios"] = {n: {**esc[n], "probabilidad": p, "nivel": snap["niveles"].get(esc[n]["nivel_ref"])}
                         for n, p in zip(nombres, probs)}

    # 2) Señal de compra: R:R >= 2, fase compatible, mercado no ROJO, motor de acuerdo
    senal = out["senal"]
    if senal in SENALES_COMPRA:
        motivos = []
        if m["rr"] is None or m["rr"] < 2.0:
            motivos.append(f"R:R motor {m['rr']} < 2.0")
        if m["fase"] in ("TENDENCIA_EXTENDIDA", "DISTRIBUCION_O_BAJISTA"):
            motivos.append(f"fase {m['fase']} prohíbe comprar")
        if estado_mercado.get("semaforo") == "ROJO_NO_COMPRAR":
            motivos.append("semáforo ROJO")
        if snap["senal_motor"] != "COMPRAR":
            motivos.append(f"motor determinista dice {snap['senal_motor']}")
        if motivos:
            nueva = snap["senal_motor"] if snap["senal_motor"] != "COMPRAR" else "ESPERAR_SOPORTE"
            corr.append(f"COMPRAR bloqueado ({'; '.join(motivos)}) -> {nueva}")
            senal = nueva
    out["senal"] = senal

    # 3) Tamaño: el LLM solo reduce; el mercado aplica factor por exposición
    base = m["tamano_posicion_pct"] or 0.0
    f_llm = AJUSTE_FACTOR.get(out.get("ajuste_tamano"), 0.0)
    f_mkt = (estado_mercado.get("exposicion_maxima_pct") or 0) / 100
    out["tamano_posicion_final_pct"] = round(base * f_llm * f_mkt, 2) if senal in SENALES_COMPRA else 0.0
    out["tamano_calculo"] = (f"{base}% (1%/dist. stop {m['distancia_stop_pct']}%) x {f_llm} (ajuste LLM) "
                             f"x {f_mkt:.2f} (exposición mercado)")

    # 4) Invalidación temporal en rango y noticias solo con IDs existentes
    s = int(out.get("invalidacion_temporal_sesiones", 10))
    if not 3 <= s <= 30:
        corr.append(f"Invalidación temporal {s} sesiones fuera de [3,30]")
        out["invalidacion_temporal_sesiones"] = min(30, max(3, s))
    malas = [n["news_id"] for n in out.get("noticias_relevantes", []) if n["news_id"] not in ids_noticias]
    if malas:
        corr.append(f"Noticias citadas inexistentes eliminadas: {malas}")
        out["noticias_relevantes"] = [n for n in out["noticias_relevantes"] if n["news_id"] in ids_noticias]
    out["sentimiento_noticias"] = max(-1.0, min(1.0, float(out.get("sentimiento_noticias", 0))))
    if not out["noticias_relevantes"] and out["sentimiento_noticias"] != 0:
        corr.append("Sentimiento sin noticias citadas -> 0")
        out["sentimiento_noticias"] = 0.0

    if not out.get("contra_tesis", "").strip():
        corr.append("Contra-tesis vacía: se bloquea cualquier compra")
        out["senal"] = "NO_COMPRAR" if out["senal"] in SENALES_COMPRA else out["senal"]
        out["tamano_posicion_final_pct"] = 0.0
    out["correcciones_guardrail"] = corr
    return out


# ------------------------------------------------------------------ modo sin LLM

def fallback_mercado(mercado: dict) -> dict:
    tope = mercado["tope_exposicion_pct"]
    sem = "ROJO_NO_COMPRAR" if mercado["rojo_forzado"] else ("VERDE_COMPRAR" if mercado["verde_permitido"] and tope >= 80 else "AMARILLO_CAUTELA")
    return {"semaforo": sem, "regimen": {"VERDE_COMPRAR": "RISK_ON", "AMARILLO_CAUTELA": "NEUTRAL", "ROJO_NO_COMPRAR": "RISK_OFF"}[sem],
            "exposicion_maxima_pct": tope, "resumen": "Modo determinista (sin LLM): semáforo por reglas duras.",
            "drivers": [{"factor": "Reglas", "lectura": r, "impacto": "NEGATIVO", "dato_citado": r} for r in mercado["razones_tope"]],
            "noticias_clave": [], "riesgos_macro": [], "contra_tesis": "No evaluada (sin LLM).",
            "que_cambiaria_la_lectura": [], "confianza": "BAJA", "datos_faltantes": ["análisis de noticias"],
            "correcciones_guardrail": [], "fuente": "MOTOR_DETERMINISTA"}


def _sesiones(texto: str, defecto: int = 10) -> int:
    m = re.search(r"(\d+)\s+sesiones", texto or "")
    return int(m.group(1)) if m else defecto


def fallback_activo(snap: dict, estado_mercado: dict) -> dict:
    m = snap["motor"]
    e = {x["nombre"]: x for x in m["escenarios"]}
    llm = {
        "ticker": snap["ticker"], "fase": m["fase"], "coincide_con_motor": True, "discrepancia_fase": "",
        "senal": snap["senal_motor"], "horizonte": "SWING_MEDIO",
        "escenarios": {
            "alcista": {"probabilidad": e["Alcista"]["probabilidad"], "nivel_ref": "resistencia_1", "tesis": e["Alcista"]["descripcion"]},
            "lateral": {"probabilidad": e["Base/Consolidación"]["probabilidad"], "nivel_ref": "precio", "tesis": e["Base/Consolidación"]["descripcion"]},
            "bajista": {"probabilidad": e["Bajista"]["probabilidad"], "nivel_ref": "stop_loss", "tesis": e["Bajista"]["descripcion"]},
        },
        "gatillo_compra": m["gatillo_compra"], "gatillo_venta": " ".join(m["gatillo_salida"]),
        "invalidacion_temporal_sesiones": _sesiones(m["invalidacion_temporal"]),
        "invalidacion_temporal_texto": m["invalidacion_temporal"],
        "contra_tesis": f"Cierre bajo soporte {m['soporte']} activa stop {m['stop_loss']}.",
        "riesgos_invalidacion": m["alertas"], "noticias_relevantes": [], "sentimiento_noticias": 0.0,
        "ajuste_tamano": "COMPLETO", "razon_ajuste": "Sin LLM.", "confianza": "BAJA", "datos_faltantes": ["análisis de noticias"],
    }
    out = validar_activo(llm, snap, estado_mercado, set())
    out["fuente"] = "MOTOR_DETERMINISTA"
    return out
