// Servidor local equivalente a Vercel: sirve public/ y monta api/*.js con req.query, res.status().json().
// Uso: APP_TOKEN=... ANTHROPIC_API_KEY=... FINNHUB_API_KEY=... node scripts/dev-server.js   (http://localhost:3000)
const http = require("http"), fs = require("fs"), path = require("path");
if (process.env.MOCK_PROVIDERS) require(path.resolve(process.env.MOCK_PROVIDERS));
const ROOT = path.join(__dirname, ".."), PUB = path.join(ROOT, "public");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const f = path.join(ROOT, "api", path.basename(url.pathname) + ".js");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    req.query = Object.fromEntries(url.searchParams); try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = body; }
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    return require(f)(req, res);
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const f = path.normalize(path.join(PUB, rel));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("no encontrado"); }
  res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`Terminal en http://localhost:${process.env.PORT || 3000}`));
