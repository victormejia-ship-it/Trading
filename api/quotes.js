const { proteger } = require("../lib/auth");
const { cotizaciones } = require("../lib/market");
const lista = (q) => String(q || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=\-]{1,15}$/.test(s)).slice(0, 80);
module.exports = proteger(async (req, res) => {
  const syms = lista(req.query.symbols);
  if (!syms.length) return res.status(400).json({ error: "Indica ?symbols=AAPL,WALMEX.MX" });
  res.json({ ...(await cotizaciones(syms)), servidor: new Date().toISOString() });
});
module.exports.lista = lista;
