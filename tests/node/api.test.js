const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

process.env.APP_TOKEN = "secreto-prueba";
process.env.ANTHROPIC_API_KEY = "sk-falsa";
delete process.env.FINNHUB_API_KEY;

// --- Yahoo simulado a partir de los CSV de prueba
function yahooDesdeCSV(sym) {
  const f = path.join(__dirname, "fixtures", sym.replace("^", "") + ".csv");
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const ts = rows.map((r) => Date.parse(r[0].slice(0, 10) + "T14:30:00Z") / 1000);
  const col = (i) => rows.map((r) => +r[i]);
  return { chart: { result: [{ meta: { symbol: sym, currency: "USD", exchangeTimezoneName: "America/New_York", regularMarketPrice: col(4).at(-1), chartPreviousClose: col(4).at(-2), regularMarketTime: ts.at(-1) },
    timestamp: ts, indicators: { quote: [{ open: col(1), high: col(2), low: col(3), close: col(4), volume: col(5) }], adjclose: [{ adjclose: col(4) }] } }], error: null } };
}
const llamadas = [];
global.fetch = async (url) => {
  llamadas.push(String(url));
  const u = new URL(url);
  if (u.host.includes("yahoo") && u.pathname.includes("/chart/")) return { ok: true, json: async () => yahooDesdeCSV(decodeURIComponent(u.pathname.split("/").pop())) };
  if (u.pathname.includes("/search")) return { ok: true, json: async () => ({ news: [{ title: "Noticia de prueba", publisher: "Agencia", link: "https://ejemplo.com/n", providerPublishTime: Math.floor(Date.now() / 1000) - 3600 }] }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

const mk = require("../../lib/market");
const claude = require("../../lib/claude");
const analyze = require("../../api/analyze");
const quotes = require("../../api/quotes");
const { MERCADO_SCHEMA, ACTIVO_SCHEMA } = require("../../lib/schemas");

function resFalsa() { const r = { code: 200, body: null }; r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r); return r; }

test("auth: sin token o token incorrecto -> 401; APP_TOKEN ausente -> 503", async () => {
  let r = resFalsa(); await quotes({ headers: {}, query: { symbols: "SPY" } }, r); assert.equal(r.code, 401);
  r = resFalsa(); await quotes({ headers: { authorization: "Bearer otro-token-xx" }, query: { symbols: "SPY" } }, r); assert.equal(r.code, 401);
  const t = process.env.APP_TOKEN; delete process.env.APP_TOKEN;
  r = resFalsa(); await quotes({ headers: { authorization: "Bearer x" }, query: { symbols: "SPY" } }, r); assert.equal(r.code, 503);
  process.env.APP_TOKEN = t;
});

test("Yahoo: parseo, ajuste y cotización con edad del dato", async () => {
  const { serie, meta } = await mk.historico("AAPL");
  assert.ok(serie.c.length >= 220 && serie.c.length <= 400);
  assert.equal(meta.currency, "USD");
  const r = resFalsa(); await quotes({ headers: { authorization: "Bearer secreto-prueba" }, query: { symbols: "AAPL,MSFT,<script>" } }, r);
  assert.equal(r.code, 200); assert.deepEqual(Object.keys(r.body.cotizaciones).sort(), ["AAPL", "MSFT"]);
  assert.equal(r.body.cotizaciones.AAPL.fuente, "yahoo"); assert.ok(Number.isFinite(r.body.cotizaciones.AAPL.edadMin));
});

test("aplicarCotizacion solo corrige la vela del mismo día", () => {
  const s = { t: ["2026-11-24", "2026-11-25"], o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2], v: [0, 0] };
  const a = mk.aplicarCotizacion(s, { price: 3, time: "2026-11-25T18:00:00Z" });
  assert.equal(a.c[1], 3); assert.equal(a.h[1], 3); assert.equal(s.c[1], 2);
  const b = mk.aplicarCotizacion(s, { price: 3, time: "2026-11-26T18:00:00Z" });
  assert.equal(b.c.length, 2); assert.equal(b.c[1], 2);
});

test("analyze activo: Claude con json_schema + guardrails corrigen violaciones", async () => {
  let pedido = null;
  claude._set({ beta: { messages: { create: async (p) => { pedido = p; return { stop_reason: "end_turn", model: p.model, usage: {}, content: [{ type: "text", text: JSON.stringify({
    ticker: "AAPL", fase: "TENDENCIA_ALCISTA_TEMPRANA", coincide_con_motor: true, discrepancia_fase: "", senal: "COMPRAR", horizonte: "SWING_MEDIO",
    escenarios: { alcista: { probabilidad: 70, nivel_ref: "resistencia_1", tesis: "a" }, lateral: { probabilidad: 20, nivel_ref: "precio", tesis: "b" }, bajista: { probabilidad: 20, nivel_ref: "stop_loss", tesis: "c" } },
    gatillo_compra: "g", gatillo_venta: "v", invalidacion_temporal_sesiones: 40, invalidacion_temporal_texto: "i", contra_tesis: "ct", riesgos_invalidacion: [],
    noticias_relevantes: [{ news_id: "NINVENTADA", sentimiento: "POSITIVO", impacto: "x" }], sentimiento_noticias: 0.7, ajuste_tamano: "COMPLETO", razon_ajuste: "", confianza: "MEDIA", datos_faltantes: [] }) }] }; } } } });
  const out = await analyze._interno.activo({ ticker: "AAPL", claude: true, estado: { semaforo: "ROJO_NO_COMPRAR", regimen: "RISK_OFF", exposicion_maxima_pct: 20 } });
  assert.deepEqual(pedido.output_config.format, { type: "json_schema", schema: ACTIVO_SCHEMA });
  assert.equal(pedido.model, "claude-opus-5-5");
  assert.ok(pedido.messages[0].content.includes("<noticias>"));
  const a = out.analisis;
  assert.equal(a.fuente, "CLAUDE");
  assert.notEqual(a.senal, "COMPRAR");                       // semáforo ROJO bloquea compra
  assert.equal(Object.values(a.escenarios).reduce((s, e) => s + e.probabilidad, 0), 100);
  assert.equal(a.invalidacion_temporal_sesiones, 30);
  assert.equal(a.noticias_relevantes.length, 0);
  assert.equal(a.tamano_posicion_final_pct, 0);
  assert.ok(!("_serie" in out.plan));
});

test("analyze mercado: topes duros sobre la respuesta de Claude", async () => {
  claude._set({ beta: { messages: { create: async (p) => { assert.deepEqual(p.output_config.format.schema, MERCADO_SCHEMA); return { stop_reason: "end_turn", model: p.model, usage: {}, content: [{ type: "text", text: JSON.stringify({
    semaforo: "VERDE_COMPRAR", regimen: "RISK_ON", exposicion_maxima_pct: 100, resumen: "r", drivers: [], noticias_clave: [], riesgos_macro: [], contra_tesis: "c", que_cambiaria_la_lectura: [], confianza: "ALTA", datos_faltantes: [] }) }] }; } } } });
  const out = await analyze._interno.mercado({ claude: true, indices: ["SPY", "^VIX"], activos: ["AAPL", "MSFT"] });
  assert.ok(out.estado.exposicion_maxima_pct <= out.datos.tope_exposicion_pct);
  if (!out.datos.verde_permitido) assert.notEqual(out.estado.semaforo, "VERDE_COMPRAR");
});

test("si Claude falla, responde el motor determinista con el error visible", async () => {
  claude._set({ beta: { messages: { create: async () => { throw new Error("timeout simulado"); } } } });
  const out = await analyze._interno.activo({ ticker: "MSFT", claude: true });
  assert.equal(out.analisis.fuente, "MOTOR_DETERMINISTA");
  assert.match(out.analisis.error_llm, /timeout simulado/);
});
