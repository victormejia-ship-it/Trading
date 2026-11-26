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
  try { const pl = JSON.parse(fs.readFileSync(path.join(RAIZ, "public/data/plan.json"), "utf8")); pl.procesos.forEach((x) => x.simbolo && s.add(x.simbolo)); } catch {}
  try { const mu = JSON.parse(fs.readFileSync(path.join(RAIZ, "public/data/mundo.json"), "utf8")); Object.keys(mu.mercados).forEach((t) => s.add(t)); } catch {}
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

// Control de calidad: lo que la página y los avisos necesitan para confiar en los datos.
function controlCalidad(syms, cot, series, generado) {
  const problemas = [], ahora = Date.now();
  for (const s of syms) {
    const q = cot[s], h = series[s];
    if (!q) problemas.push({ simbolo: s, tipo: "sin_cotizacion" });
    else if (!(q.price > 0)) problemas.push({ simbolo: s, tipo: "precio_invalido" });
    if (!h) { problemas.push({ simbolo: s, tipo: "sin_historico" }); continue; }
    if (h.c.length < 260) problemas.push({ simbolo: s, tipo: "historia_corta", velas: h.c.length });
    const dias = (ahora - Date.parse(h.t[h.t.length - 1] + "T21:00:00Z")) / 864e5;
    if (dias > 5) problemas.push({ simbolo: s, tipo: "historico_viejo", ultima: h.t[h.t.length - 1] });
    for (let i = Math.max(1, h.c.length - 30); i < h.c.length; i++) {
      const salto = Math.abs(h.c[i] / h.c[i - 1] - 1);
      if (salto > 0.25 && !s.startsWith("^")) { problemas.push({ simbolo: s, tipo: "salto_sospechoso", fecha: h.t[i], pct: Math.round(salto * 1000) / 10 }); break; }
    }
  }
  const criticos = ["SPY", "MXN=X"].filter((s) => !cot[s] || !series[s]);
  return { generado, simbolos: syms.length, cotizaciones: Object.keys(cot).length, historicos: Object.keys(series).length,
    problemas, critico: criticos.length > 0, criticos, ok: problemas.length === 0 };
}

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
  fs.writeFileSync(path.join(SALIDA, "data/estado.json"), JSON.stringify(controlCalidad(syms, cotizaciones, series, generado)));
  fs.writeFileSync(path.join(SALIDA, "data/vivo.json"), JSON.stringify({ generado, cotizaciones, errores }));
  fs.writeFileSync(path.join(SALIDA, "data/series.json"), JSON.stringify({ generado, series, errores: errSeries }));
  fs.writeFileSync(path.join(SALIDA, ".nojekyll"), "");
  console.log(`Sitio en ${SALIDA}: ${Object.keys(cotizaciones).length}/${syms.length} cotizaciones, ${Object.keys(series).length} series.`);
  if (Object.keys(errores).length) console.log("Sin cotización:", errores);
  if (Object.keys(errSeries).length) console.log("Sin histórico:", errSeries);
  const est = JSON.parse(fs.readFileSync(path.join(SALIDA, "data/estado.json"), "utf8"));
  if (est.problemas.length) console.log("Control de calidad:", JSON.stringify(est.problemas));
  if (est.critico) { console.error("Faltan datos críticos (" + est.criticos.join(", ") + "): no se publica."); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
