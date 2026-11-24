"""Esquemas JSON para output_config.format (structured outputs).

Regla anti-alucinación clave: el LLM NO escribe precios. Referencia niveles por
clave (`NIVEL_REF`) que el motor determinista ya calculó; el worker los resuelve.
"""

NIVEL_REF = ["precio", "entrada", "soporte", "stop_loss", "resistencia_1", "objetivo_2",
             "trailing_stop", "sma20", "sma50", "sma200"]
FASES = ["ACUMULACION", "TENDENCIA_ALCISTA_TEMPRANA", "TENDENCIA_EXTENDIDA",
         "DISTRIBUCION_O_BAJISTA", "TRANSICION_SIN_FASE_CLARA"]
SENALES = ["COMPRAR", "ESPERAR_SOPORTE", "ESPERAR_RUPTURA", "VENDER_TOMA_GANANCIAS",
           "VENDER_CERRAR", "NO_COMPRAR"]
IMPACTO = ["POSITIVO", "NEGATIVO", "NEUTRAL"]
CONFIANZA = ["BAJA", "MEDIA", "ALTA"]


def _obj(props: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": props,
            "required": required if required is not None else list(props), "additionalProperties": False}


_S = {"type": "string"}
_I = {"type": "integer"}
_N = {"type": "number"}
_LS = {"type": "array", "items": _S}

MERCADO_SCHEMA = _obj({
    "semaforo": {"type": "string", "enum": ["VERDE_COMPRAR", "AMARILLO_CAUTELA", "ROJO_NO_COMPRAR"]},
    "regimen": {"type": "string", "enum": ["RISK_ON", "NEUTRAL", "RISK_OFF"]},
    "exposicion_maxima_pct": _I,
    "resumen": _S,
    "drivers": {"type": "array", "items": _obj({
        "factor": _S, "lectura": _S, "impacto": {"type": "string", "enum": IMPACTO},
        "dato_citado": _S,
    })},
    "noticias_clave": {"type": "array", "items": _obj({
        "news_id": _S, "impacto": {"type": "string", "enum": IMPACTO}, "por_que_importa": _S,
    })},
    "riesgos_macro": _LS,
    "contra_tesis": _S,
    "que_cambiaria_la_lectura": _LS,
    "confianza": {"type": "string", "enum": CONFIANZA},
    "datos_faltantes": _LS,
})

_ESC = _obj({"probabilidad": _I, "nivel_ref": {"type": "string", "enum": NIVEL_REF}, "tesis": _S})

ACTIVO_SCHEMA = _obj({
    "ticker": _S,
    "fase": {"type": "string", "enum": FASES},
    "coincide_con_motor": {"type": "boolean"},
    "discrepancia_fase": _S,
    "senal": {"type": "string", "enum": SENALES},
    "horizonte": {"type": "string", "enum": ["INTRADIA_SWING_CORTO", "SWING_MEDIO", "POSICIONAL"]},
    "escenarios": _obj({"alcista": _ESC, "lateral": _ESC, "bajista": _ESC}),
    "gatillo_compra": _S,
    "gatillo_venta": _S,
    "invalidacion_temporal_sesiones": _I,
    "invalidacion_temporal_texto": _S,
    "contra_tesis": _S,
    "riesgos_invalidacion": _LS,
    "noticias_relevantes": {"type": "array", "items": _obj({
        "news_id": _S, "sentimiento": {"type": "string", "enum": IMPACTO}, "impacto": _S,
    })},
    "sentimiento_noticias": _N,
    "ajuste_tamano": {"type": "string", "enum": ["COMPLETO", "MEDIO", "CUARTO", "CERO"]},
    "razon_ajuste": _S,
    "confianza": {"type": "string", "enum": CONFIANZA},
    "datos_faltantes": _LS,
})
