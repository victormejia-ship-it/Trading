// Señales de fin de mes del plan (mismo motor que la web) y envío al celular.
// Corre en GitHub Actions; también localmente:  node scripts/senales.js [--forzar] [--prueba]
//   --forzar  evalúa aunque hoy no sea el último día hábil del mes
//   --prueba  envía un mensaje de prueba
// Envío (opcional, por secretos de GitHub): NTFY_TOPIC (app ntfy) y/o TELEGRAM_TOKEN + TELEGRAM_CHAT_ID.
// Montos: variables PLAN_CAPITAL (MXN) y PLAN_PERFIL (conservador | moderado | agresivo).
const fs = require("fs");
const path = require("path");
const mk = require("../lib/market");
const Motor = require("../public/engine.js");

const RAIZ = path.join(__dirname, "..");
const args = new Set(process.argv.slice(2));
const fmt = (x, d = 0) => Number(x).toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d });

function hoyNY() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function horaNY() { const p = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }); const [h, m] = p.split(":").map(Number); return h * 60 + m; }

async function calcular() {
  const plan = JSON.parse(fs.readFileSync(path.join(RAIZ, "public/data/plan.json"), "utf8"));
  const perfil = process.env.PLAN_PERFIL && plan.perfiles[process.env.PLAN_PERFIL] ? process.env.PLAN_PERFIL : "moderado";
  const capital = +process.env.PLAN_CAPITAL || 100000;
  const pesos = plan.perfiles[perfil].pesos;
  let fx = null; try { fx = (await mk.cotizacion("MXN=X")).price; } catch {}
  const filas = [];
  for (const p of plan.procesos) {
    if (p.tipo !== "filtro" || !(pesos[p.id] > 0)) continue;
    const { serie } = await mk.historico(p.simbolo);
    let q = null; try { q = await mk.cotizacion(p.simbolo); } catch {}
    const s = q?.fuente === "finnhub" ? mk.aplicarCotizacion(serie, q) : serie;
    const r = Motor.regimen(s, p.regla);
    const monto = capital * pesos[p.id], px = q?.price ?? r.precio, k = p.simbolo.endsWith(".MX") ? 1 : fx;
    filas.push({ p, r, monto, titulos: k ? Math.floor(monto / (px * k)) : null, px });
  }
  return { plan, perfil, capital, fx, filas };
}

function mensaje({ perfil, capital, filas }, confirmado) {
  const cambios = filas.filter((f) => f.r.senal !== "MANTENER"), cerca = filas.filter((f) => f.r.senal === "MANTENER" && Math.abs(f.r.distancia_pct) < 1.5);
  const lineas = [];
  for (const f of cambios) {
    const accion = f.r.senal === "VENDER" ? "VENDER" : "COMPRAR";
    lineas.push(`${accion === "VENDER" ? "🔴" : "🟢"} ${accion} ${f.p.nombre} (${f.p.simbolo}): ${accion === "VENDER" ? "toda tu posición" : `~${fmt(f.titulos)} títulos (≈ $${fmt(f.monto)} MXN)`}. ${f.r.distancia_pct > 0 ? "+" : ""}${fmt(f.r.distancia_pct, 1)}% vs su media de 200 días.`);
  }
  for (const f of filas.filter((x) => x.r.senal === "MANTENER")) {
    lineas.push(`${f.r.estado === "INVERTIDO" ? "⚪ Mantener" : "⏸ En pausa (CETES)"} ${f.p.nombre}: ${f.r.distancia_pct > 0 ? "+" : ""}${fmt(f.r.distancia_pct, 1)}% vs su media.`);
  }
  const titulo = cambios.length ? `${confirmado ? "Señal CONFIRMADA" : "Señal PRELIMINAR"}: ${cambios.map((f) => `${f.r.senal} ${f.p.nombre}`).join(", ")}` : "Fin de mes: sin cambios en tu plan";
  const pie = cambios.length
    ? (confirmado ? "Ejecuta en GBM+ en la apertura del próximo día hábil. Lo que vendas, pásalo a CETES." : "Se confirma con el cierre de hoy: si al cierre sigue igual, ejecuta mañana en la apertura.")
    : cerca.length ? `Atención: ${cerca.map((f) => f.p.nombre).join(", ")} cerca de su media; revisa el cierre.` : "No tienes que hacer nada este mes.";
  return { titulo, cuerpo: [`Perfil ${perfil}, capital $${fmt(capital)} MXN.`, ...lineas, pie, "https://victormejia-ship-it.github.io/Trading/"].join("\n"), urgente: cambios.length > 0 };
}

async function enviar({ titulo, cuerpo, urgente }) {
  const enviados = [];
  if (process.env.NTFY_TOPIC) {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, { method: "POST", body: cuerpo,
      headers: { Title: Buffer.from(titulo).toString("latin1") === titulo ? titulo : titulo.normalize("NFD").replace(/[̀-ͯ]/g, ""), Priority: urgente ? "high" : "default", Tags: urgente ? "rotating_light" : "chart_with_upwards_trend" } });
    enviados.push(`ntfy ${r.status}`);
  }
  if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${titulo}\n\n${cuerpo}` }) });
    enviados.push(`telegram ${r.status}`);
  }
  return enviados;
}

async function main() {
  if (args.has("--prueba")) {
    const m = { titulo: "Prueba: avisos de tu Terminal de Riesgo", cuerpo: "Si ves este mensaje, los avisos de fin de mes llegarán a este celular.", urgente: false };
    console.log(m, await enviar(m)); return;
  }
  const hoy = hoyNY();
  if (!args.has("--forzar") && !Motor.ultimoHabilDelMes(hoy)) { console.log(`${hoy}: no es el último día hábil del mes; nada que avisar.`); return; }
  const datos = await calcular();
  const confirmado = horaNY() >= 16 * 60 + 15 || args.has("--confirmado");
  const m = mensaje(datos, confirmado);
  console.log(`${m.titulo}\n${m.cuerpo}`);
  const env = await enviar(m);
  console.log(env.length ? `Enviado: ${env.join(", ")}` : "Sin canal configurado (NTFY_TOPIC o TELEGRAM_*): solo se imprimió.");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { mensaje };
