// Protege los endpoints (sobre todo /api/analyze, que gasta créditos de Claude).
//  - Firebase (AUTH_MODE=firebase): token de Firebase Auth (inicio de sesión con Google) + lista de correos autorizados.
//  - Vercel / local: APP_TOKEN compartido.
const crypto = require("crypto");

let verificador = null;   // inyectable en pruebas
function verificarIdToken(token) {
  if (verificador) return verificador(token);
  const { initializeApp, getApps } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  if (!getApps().length) initializeApp();
  return getAuth().verifyIdToken(token);
}

const correosAutorizados = () => String(process.env.ALLOWED_EMAILS || "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

async function autorizado(req) {
  const h = String(req.headers?.authorization || "");
  const dado = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (process.env.AUTH_MODE === "firebase") {
    const lista = correosAutorizados();
    if (!lista.length) return { ok: false, status: 503, error: "Falta configurar ALLOWED_EMAILS (correos autorizados)." };
    if (!dado) return { ok: false, status: 401, error: "Inicia sesión con Google." };
    try {
      const t = await verificarIdToken(dado);
      const email = String(t.email || "").toLowerCase();
      if (!t.email_verified || !lista.includes(email)) return { ok: false, status: 403, error: `La cuenta ${email || "sin correo"} no está autorizada.` };
      return { ok: true, usuario: email };
    } catch {
      return { ok: false, status: 401, error: "Sesión inválida o vencida; vuelve a iniciar sesión." };
    }
  }
  const token = process.env.APP_TOKEN;
  if (!token) return { ok: false, status: 503, error: "Falta configurar APP_TOKEN." };
  const a = Buffer.from(dado), b = Buffer.from(token);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, status: 401, error: "Token inválido." };
}

function proteger(handler) {
  return async (req, res) => {
    const a = await autorizado(req);
    if (!a.ok) return res.status(a.status).json({ error: a.error, auth: process.env.AUTH_MODE === "firebase" ? "firebase" : "token" });
    try { await handler(req, res); }
    catch (e) { console.error(e); res.status(500).json({ error: e.message || "Error interno" }); }
  };
}

module.exports = { autorizado, proteger, _setVerificador: (f) => (verificador = f) };
