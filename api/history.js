const { proteger } = require("../lib/auth");
const { historico } = require("../lib/market");
const { lista } = require("./quotes");
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
module.exports = proteger(async (req, res) => {
  const syms = lista(req.query.symbols).slice(0, 30);
  if (!syms.length) return res.status(400).json({ error: "Indica ?symbols=SPY,^VIX" });
  const series = {}, errores = {};
  await Promise.all(syms.map(async (s) => {
    try { const { serie, meta } = await historico(s); series[s] = { t: serie.t, o: r4(serie.o), h: r4(serie.h), l: r4(serie.l), c: r4(serie.c), v: serie.v, meta }; }
    catch (e) { errores[s] = e.message; }
  }));
  res.json({ series, errores });
});
