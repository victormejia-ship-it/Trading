// Qué está configurado (sin revelar claves).
const { proteger } = require("../lib/auth");
const { MODEL, EFFORT } = require("../lib/claude");
module.exports = proteger(async (req, res) => {
  res.json({ claude: !!process.env.ANTHROPIC_API_KEY, finnhub: !!process.env.FINNHUB_API_KEY, modelo: MODEL, effort: EFFORT });
});
