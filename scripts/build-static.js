// Genera el sitio estático para GitHub Pages: copia public/ y agrega datos frescos (sin servidor ni claves obligatorias).
//   data/vivo.json    cotizaciones más recientes (Finnhub si hay FINNHUB_API_KEY; si no, Yahoo)
//   data/series.json  histórico diario (400 velas) para gráficos, motor y estrategia
// Uso: node scripts/build-static.js [_site]
const fs = require("fs");
const path = require("path");
const mk = require("../lib/market");

const RAIZ = path.join(__dirname, "..");
const SALIDA = path.resolve(process.argv[2] || path.join(RAIZ, "_site"));

// Mismos valores por defecto que la página (public/index.html) + watchlist.json + estrategia.
const DEF_INDICES = ["SPY", "QQQ", "IWM", "^VIX", "^MXX", "MXN=X", "TLT"];
const DEF_ACTIVOS = ["AAPL", "MSFT", "NVDA", "AMZN", "WALMEX.MX", "GFNORTEO.MX", "AMXB.MX", "FEMSAUBD.MX"];

function simbolos() {
  const s = new Set([...DEF_INDICES, ...DEF_ACTIVOS]);
  try { const w = JSON.parse(fs.readFileSync(path.join(RAIZ, "watchlist.json"), "utf8")); [...w.indices, ...w.activos].forEach((x) => s.add(x)); } catch {}
  try { const e = JSON.parse(fs.readFileSync(path.join(RAIZ, "public/data/estrategia.json"), "utf8")); Object.values(e.mangas).forEach((m) => s.add(m.simbolo)); } catch {}
  s.add("MXN=X");
  return [...s];
}

function copiar(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, f.name), b = path.join(dst, f.name);
    if (f.isDirectory()) copiar(a, b); else fs.copyFileSync(a, b);
  }
}

const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);

async function main() {
  fs.rmSync(SALIDA, { recursive: true, force: true });
  copiar(path.join(RAIZ, "public"), SALIDA);
  const syms = simbolos();
  const { cotizaciones, errores } = await mk.cotizaciones(syms);
  const series = {}, errSeries = {};
  for (const s of syms) {
    try {
      const { serie, meta } = await mk.historico(s);
      series[s] = { t: serie.t, o: r4(serie.o), h: r4(serie.h), l: r4(serie.l), c: r4(serie.c), v: serie.v, meta };
    } catch (e) { errSeries[s] = e.message; }
  }
  const generado = new Date().toISOString();
  fs.mkdirSync(path.join(SALIDA, "data"), { recursive: true });
  fs.writeFileSync(path.join(SALIDA, "data/vivo.json"), JSON.stringify({ generado, cotizaciones, errores }));
  fs.writeFileSync(path.join(SALIDA, "data/series.json"), JSON.stringify({ generado, series, errores: errSeries }));
  fs.writeFileSync(path.join(SALIDA, ".nojekyll"), "");
  console.log(`Sitio en ${SALIDA}: ${Object.keys(cotizaciones).length}/${syms.length} cotizaciones, ${Object.keys(series).length} series.`);
  if (Object.keys(errores).length) console.log("Sin cotización:", errores);
  if (Object.keys(errSeries).length) console.log("Sin histórico:", errSeries);
  if (!series.SPY) { console.error("Sin datos de SPY: no se publica."); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
