// Análisis bajo demanda con el precio más reciente: motor determinista + Claude (opcional) + guardrails.
const { proteger } = require("../lib/auth");
const mk = require("../lib/market");
const claude = require("../lib/claude");
const Motor = require("../public/engine.js");
const { lista } = require("./quotes");

const usarClaude = (body) => body.claude === true && !!process.env.ANTHROPIC_API_KEY;

async function serieViva(sym) {
  const { serie, meta } = await mk.historico(sym);
  let q = null;
  try { q = await mk.cotizacion(sym); } catch { /* sin cotización: se usa la vela de Yahoo */ }
  return { serie: q?.fuente === "finnhub" ? mk.aplicarCotizacion(serie, q, meta.tz) : serie, cotiz: q, meta };
}

async function mercado(body) {
  const indices = lista((body.indices || []).join(",")), activos = lista((body.activos || []).join(","));
  const series = {}, errores = {};
  await Promise.all([...new Set([...indices, ...activos])].map(async (s) => { try { series[s] = (await serieViva(s)).serie; } catch (e) { errores[s] = e.message; } }));
  const m = Motor.mercado(series, indices, activos);
  if (m.falta_spy) return { error: "Sin datos de SPY: no se puede evaluar el mercado.", errores };
  const fecha = Object.values(series).map((s) => s.t.at(-1)).sort().at(-1);
  const nots = await mk.noticias("MACRO", body.horas || 24).catch(() => []);
  let estado;
  if (usarClaude(body)) {
    try { const r = await claude.analizarMercado(m, nots, fecha); estado = { ...Motor.validarMercado(r.data, m), fuente: "CLAUDE", modelo: r.modelo }; }
    catch (e) { estado = { ...Motor.fallbackMercado(m), error_llm: e.message }; }
  } else estado = Motor.fallbackMercado(m);
  return { estado, datos: m, noticias: nots, fecha, errores };
}

async function activo(body) {
  const [t] = lista(body.ticker);
  if (!t) return { error: "ticker inválido" };
  const est = body.estado && typeof body.estado === "object" ? body.estado : { semaforo: "AMARILLO_CAUTELA", exposicion_maxima_pct: 50 };
  const cfg = { riesgo: Math.min(5, Math.max(0.1, +body.riesgo || 1)) / 100, maxPos: Math.min(100, Math.max(1, +body.maxPos || 25)) / 100 };
  const { serie, cotiz } = await serieViva(t);
  const plan = Motor.analizar(serie, t, cfg);
  const nots = await mk.noticias(t, body.horas || 24).catch(() => []);
  let analisis;
  if (usarClaude(body)) {
    try { const r = await claude.analizarActivo(plan, cotiz, nots, est); analisis = { ...Motor.validarActivo(r.data, plan, est, new Set(nots.map((n) => n.id))), fuente: "CLAUDE", modelo: r.modelo }; }
    catch (e) { analisis = { ...Motor.fallbackActivo(plan, est), error_llm: e.message }; }
  } else analisis = Motor.fallbackActivo(plan, est);
  const { _serie, ...planLimpio } = plan;
  return { ticker: t, analisis, plan: planLimpio, noticias: nots, cotizacion: cotiz };
}

module.exports = proteger(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const out = body.tipo === "mercado" ? await mercado(body) : await activo(body);
  res.status(out.error ? 422 : 200).json(out);
});
module.exports._interno = { mercado, activo };
