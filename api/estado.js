// Qué está configurado (sin revelar claves).
const { proteger } = require("../lib/auth");
const { MODEL, EFFORT, claudeConfigurado } = require("../lib/claude");
module.exports = proteger(async (req, res) => {
  res.json({ claude: claudeConfigurado(), finnhub: /^[a-z0-9]{10,}$/i.test(process.env.FINNHUB_API_KEY || ""), modelo: MODEL, effort: EFFORT });
});
