// Datos de mercado gratuitos:
//  - Finnhub (FINNHUB_API_KEY, plan gratis): cotización en tiempo real de acciones/ETFs de EE. UU. (SIC) y noticias.
//  - Yahoo Finance (sin clave, no oficial): históricos diarios de todo, cotización BMV (.MX, ~15-20 min de retraso),
//    índices (^VIX, ^MXX), divisas (MXN=X), cripto (BTC-USD) y noticias de emisoras mexicanas.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function getJSON(url, { headers = {}, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${new URL(url).host}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const esEEUU = (s) => /^[A-Z.]{1,6}$/.test(s) && !s.endsWith(".MX") && !s.includes("=") && !s.startsWith("^");

// --------------------------------------------------------------- Yahoo
function parseYahooChart(json, symbol) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`${symbol}: Yahoo no devolvió datos (${json?.chart?.error?.description || "sin resultado"})`);
  const q = r.indicators?.quote?.[0] || {}, adj = r.indicators?.adjclose?.[0]?.adjclose;
  const s = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const tz = r.meta?.exchangeTimezoneName || "America/New_York";
  (r.timestamp || []).forEach((ts, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every(Number.isFinite) || c <= 0) return;
    const k = Number.isFinite(adj?.[i]) && adj[i] > 0 ? adj[i] / c : 1;   // ajuste por dividendos y splits
    const fecha = new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: tz });
    if (s.t.length && s.t[s.t.length - 1] === fecha) { s.t.pop(); s.o.pop(); s.h.pop(); s.l.pop(); s.c.pop(); s.v.pop(); }
    s.t.push(fecha); s.o.push(o * k); s.h.push(h * k); s.l.push(l * k); s.c.push(c * k); s.v.push(q.volume?.[i] || 0);
  });
  const m = r.meta || {};
  const meta = { symbol: m.symbol || symbol, currency: m.currency || "", exchange: m.exchangeName || "", tz,
    price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
  return { serie: s, meta };
}

async function yahooChart(symbol, range, interval, opts) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  return parseYahooChart(await getJSON(url, opts), symbol);
}

// --------------------------------------------------------------- Finnhub
async function finnhub(path, params, opts) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !/^[a-z0-9]{10,}$/i.test(key)) return null;
  const qs = new URLSearchParams(params).toString();
  return getJSON(`https://finnhub.io/api/v1/${path}?${qs}`, { ...opts, headers: { "X-Finnhub-Token": key } });
}

// --------------------------------------------------------------- API pública del módulo
function cotizacionDesdeMeta(meta, fuente) {
  const p = meta.price, pc = meta.prevClose;
  const t = meta.time ? Date.parse(meta.time) : null;
  return { symbol: meta.symbol, price: p, prevClose: pc, change: Number.isFinite(pc) ? p - pc : null,
    changePct: Number.isFinite(pc) && pc ? ((p / pc) - 1) * 100 : null, currency: meta.currency, time: meta.time,
    edadMin: t ? Math.round((Date.now() - t) / 60000) : null, fuente };
}

async function cotizacion(symbol, opts = {}) {
  return cached(`q:${symbol}`, 15000, async () => {
    if (esEEUU(symbol) && /^[a-z0-9]{10,}$/i.test(process.env.FINNHUB_API_KEY || "")) {
      try {
        const q = await finnhub("quote", { symbol }, opts);
        if (q && Number.isFinite(q.c) && q.c > 0) {
          return cotizacionDesdeMeta({ symbol, price: q.c, prevClose: q.pc, currency: "USD", time: q.t ? new Date(q.t * 1000).toISOString() : null }, "finnhub");
        }
      } catch (e) { /* cae a Yahoo */ }
    }
    const { meta } = await yahooChart(symbol, "1d", "1m", opts);
    return cotizacionDesdeMeta(meta, "yahoo");
  });
}

async function cotizaciones(symbols, opts) {
  const out = {}, errores = {};
  const cola = [...new Set(symbols)];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cola.length) {
      const s = cola.shift();
      try { out[s] = await cotizacion(s, opts); } catch (e) { errores[s] = e.message; }
    }
  }));
  return { cotizaciones: out, errores };
}

async function historico(symbol, opts = {}) {
  return cached(`h:${symbol}`, 5 * 60000, async () => {
    const { serie, meta } = await yahooChart(symbol, "2y", "1d", opts);
    const N = serie.t.length, k = Math.max(0, N - 400);
    for (const key of Object.keys(serie)) serie[key] = serie[key].slice(k);
    return { serie, meta };
  });
}

// La vela de hoy usa el precio más reciente disponible (Finnhub en tiempo real para EE. UU.).
// Solo se corrige la vela del mismo día (Yahoo ya incluye la vela en formación); nunca se inventa una vela nueva.
function aplicarCotizacion(serie, q, tz = "America/New_York") {
  if (!q || !Number.isFinite(q.price) || !q.time || !serie.t.length) return serie;
  const s = { ...serie, t: [...serie.t], o: [...serie.o], h: [...serie.h], l: [...serie.l], c: [...serie.c], v: [...serie.v] };
  const i = s.t.length - 1, dia = new Date(q.time).toLocaleDateString("en-CA", { timeZone: tz });
  if (s.t[i] === dia) { s.c[i] = q.price; s.h[i] = Math.max(s.h[i], q.price); s.l[i] = Math.min(s.l[i], q.price); }
  return s;
}

const limpia = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
function idNoticia(titulo, fuente) {
  let h = 2166136261; for (const ch of `${fuente}|${titulo}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return "N" + (h >>> 0).toString(16).padStart(8, "0");
}

async function noticias(symbol, horas = 24, opts = {}) {
  return cached(`n:${symbol}:${horas}`, 10 * 60000, async () => {
    const limite = Date.now() - horas * 3600e3, items = [];
    const hoy = new Date(), desde = new Date(Date.now() - Math.max(1, Math.ceil(horas / 24)) * 864e5);
    try {
      let data = null;
      if (symbol === "MACRO") data = await finnhub("news", { category: "general" }, opts);
      else if (esEEUU(symbol)) data = await finnhub("company-news", { symbol, from: desde.toISOString().slice(0, 10), to: hoy.toISOString().slice(0, 10) }, opts);
      for (const n of data || []) {
        if (!n.headline || n.datetime * 1000 < limite) continue;
        items.push({ titulo: limpia(n.headline, 300), fuente: limpia(n.source, 80), fecha: new Date(n.datetime * 1000).toISOString(), resumen: limpia(n.summary, 600), url: String(n.url || "") });
      }
    } catch (e) { /* sin Finnhub: seguimos con Yahoo */ }
    if (symbol !== "MACRO" && items.length < 3) {
      try {
        const j = await getJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10`, opts);
        for (const n of j?.news || []) {
          if (!n.title || n.providerPublishTime * 1000 < limite) continue;
          items.push({ titulo: limpia(n.title, 300), fuente: limpia(n.publisher, 80), fecha: new Date(n.providerPublishTime * 1000).toISOString(), resumen: "", url: String(n.link || "") });
        }
      } catch (e) { /* sin noticias */ }
    }
    const vistos = new Set();
    return items.map((n) => ({ id: idNoticia(n.titulo, n.fuente), ...n, url: n.url.startsWith("https://") ? n.url : "" }))
      .filter((n) => !vistos.has(n.id) && vistos.add(n.id))
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 12);
  });
}

module.exports = { parseYahooChart, yahooChart, cotizacion, cotizaciones, historico, aplicarCotizacion, noticias, esEEUU, _cache: cache };
