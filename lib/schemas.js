// Esquemas para output_config.format (json_schema). Mismo contrato que worker/schemas.py.
const NIVEL_REF = ["precio", "entrada", "soporte", "stop_loss", "resistencia_1", "objetivo_2", "trailing_stop", "sma20", "sma50", "sma200"];
const FASES = ["ACUMULACION", "TENDENCIA_ALCISTA_TEMPRANA", "TENDENCIA_EXTENDIDA", "DISTRIBUCION_O_BAJISTA", "TRANSICION_SIN_FASE_CLARA"];
const SENALES = ["COMPRAR", "ESPERAR_SOPORTE", "ESPERAR_RUPTURA", "VENDER_TOMA_GANANCIAS", "VENDER_CERRAR", "NO_COMPRAR"];
const IMPACTO = ["POSITIVO", "NEGATIVO", "NEUTRAL"];
const CONF = ["BAJA", "MEDIA", "ALTA"];

const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const S = { type: "string" }, I = { type: "integer" }, N = { type: "number" }, LS = { type: "array", items: S };
const en = (e) => ({ type: "string", enum: e });

const MERCADO_SCHEMA = obj({
  semaforo: en(["VERDE_COMPRAR", "AMARILLO_CAUTELA", "ROJO_NO_COMPRAR"]), regimen: en(["RISK_ON", "NEUTRAL", "RISK_OFF"]),
  exposicion_maxima_pct: I, resumen: S,
  drivers: { type: "array", items: obj({ factor: S, lectura: S, impacto: en(IMPACTO), dato_citado: S }) },
  noticias_clave: { type: "array", items: obj({ news_id: S, impacto: en(IMPACTO), por_que_importa: S }) },
  riesgos_macro: LS, contra_tesis: S, que_cambiaria_la_lectura: LS, confianza: en(CONF), datos_faltantes: LS,
});
const ESC = obj({ probabilidad: I, nivel_ref: en(NIVEL_REF), tesis: S });
const ACTIVO_SCHEMA = obj({
  ticker: S, fase: en(FASES), coincide_con_motor: { type: "boolean" }, discrepancia_fase: S, senal: en(SENALES),
  horizonte: en(["INTRADIA_SWING_CORTO", "SWING_MEDIO", "POSICIONAL"]),
  escenarios: obj({ alcista: ESC, lateral: ESC, bajista: ESC }),
  gatillo_compra: S, gatillo_venta: S, invalidacion_temporal_sesiones: I, invalidacion_temporal_texto: S,
  contra_tesis: S, riesgos_invalidacion: LS,
  noticias_relevantes: { type: "array", items: obj({ news_id: S, sentimiento: en(IMPACTO), impacto: S }) },
  sentimiento_noticias: N, ajuste_tamano: en(["COMPLETO", "MEDIO", "CUARTO", "CERO"]), razon_ajuste: S,
  confianza: en(CONF), datos_faltantes: LS,
});
module.exports = { MERCADO_SCHEMA, ACTIVO_SCHEMA };
