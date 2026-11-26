// Protege los endpoints (sobre todo /api/analyze, que gasta créditos de Claude).
const crypto = require("crypto");

function autorizado(req) {
  const token = process.env.APP_TOKEN;
  if (!token) return { ok: false, status: 503, error: "Falta configurar APP_TOKEN en Vercel." };
  const h = String(req.headers?.authorization || "");
  const dado = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(dado), b = Buffer.from(token);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, status: 401, error: "Token inválido." };
}

function proteger(handler) {
  return async (req, res) => {
    const a = autorizado(req);
    if (!a.ok) return res.status(a.status).json({ error: a.error });
    try { await handler(req, res); }
    catch (e) { console.error(e); res.status(500).json({ error: e.message || "Error interno" }); }
  };
}

module.exports = { autorizado, proteger };
