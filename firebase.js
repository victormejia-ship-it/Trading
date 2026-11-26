// Entrada de Cloud Functions (Firebase). Reutiliza los mismos manejadores de api/*.js que usa Vercel.
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");

const FINNHUB_API_KEY = defineSecret("FINNHUB_API_KEY");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ALLOWED_EMAILS = defineString("ALLOWED_EMAILS", { description: "Correos de Google autorizados, separados por coma" });

const rutas = {
  estado: require("./api/estado"),
  quotes: require("./api/quotes"),
  history: require("./api/history"),
  analyze: require("./api/analyze"),
};

exports.api = onRequest(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", maxInstances: 3, secrets: [FINNHUB_API_KEY, ANTHROPIC_API_KEY] },
  async (req, res) => {
    process.env.AUTH_MODE = "firebase";
    process.env.ALLOWED_EMAILS = ALLOWED_EMAILS.value();
    res.set("Cache-Control", "no-store");
    const nombre = req.path.replace(/^\/api\//, "").replace(/\/+$/, "");
    const h = rutas[nombre];
    if (!h) return res.status(404).json({ error: "Ruta no encontrada" });
    return h(req, res);
  }
);
