// Terminal de Riesgo: lógica de la página (plan, meta, laboratorio, terminal avanzada, avisos).
// Depende de: lightweight-charts (CDN) y engine.js (motor compartido). Se carga al final del <body>.
{
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v == null || !Number.isFinite(+v) ? "—" : Number(v).toLocaleString("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || !Number.isFinite(+v) ? "—" : (v > 0 ? "+" : "") + fmt(v, d) + "%");
const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : null);
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const FASE = { ACUMULACION: ["◐", "b", "Acumulación"], TENDENCIA_ALCISTA_TEMPRANA: ["▲", "g", "Alcista temprana"], TENDENCIA_EXTENDIDA: ["⚠", "y", "Extendida"], DISTRIBUCION_O_BAJISTA: ["▼", "r", "Distribución"], TRANSICION_SIN_FASE_CLARA: ["◇", "n", "Transición"] };
const SENAL = { COMPRAR: ["●", "g", "Comprar"], ESPERAR_SOPORTE: ["◷", "y", "Esperar soporte"], ESPERAR_RUPTURA: ["◷", "b", "Esperar ruptura"], VENDER_TOMA_GANANCIAS: ["◑", "y", "Tomar ganancias"], VENDER_CERRAR: ["■", "r", "Vender/cerrar"], NO_COMPRAR: ["✕", "n", "No comprar"] };
const SEM = { VERDE_COMPRAR: ["g", "Verde · comprar"], AMARILLO_CAUTELA: ["y", "Amarillo · cautela"], ROJO_NO_COMPRAR: ["r", "Rojo · no comprar"] };
const chip = (map, k) => { const [i, c, t] = map[k] || ["?", "n", k]; return `<span class="chip ${c}">${i} ${esc(t)}</span>`; };

const DEF = { indices: ["SPY", "QQQ", "IWM", "^VIX", "^MXX", "MXN=X", "TLT"], activos: ["AAPL", "MSFT", "NVDA", "AMZN", "WALMEX.MX", "GFNORTEO.MX", "AMXB.MX", "FEMSAUBD.MX"], riesgo: 1, maxPos: 25, poll: 15 };
const S = { cfg: { ...DEF, ...ls.get("tr_cfg", {}) }, token: ls.get("tr_token", ""), srv: null, q: {}, series: {}, rep: null, sel: null, jsonTab: "analisis", abort: null, alertas: ls.get("tr_alertas", {}) };

// ---------------- API
// ---------------- acceso: Google (Firebase) o token (Vercel/local)
S.fb = null;
function cargarScript(src) { return new Promise((ok, mal) => { const e = document.createElement("script"); e.src = src; e.onload = ok; e.onerror = mal; document.head.append(e); }); }
async function detectarFirebase() {
  try {
    const r = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return false;
    const cfg = await r.json();
    await cargarScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
    await cargarScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
    firebase.initializeApp(cfg);
    S.fb = { auth: firebase.auth(), user: null };
    $("#loginToken").hidden = true; $("#btnEntrar").hidden = true; $("#loginGoogle").hidden = false; $("#btnGoogle").hidden = false;
    S.fb.auth.onAuthStateChanged((u) => { S.fb.user = u; if (u) { if ($("#dlgLogin").open) $("#dlgLogin").close(); arrancar(); } else pedirToken(); });
    return true;
  } catch { return false; }
}
$("#btnGoogle").onclick = async () => {
  try { await S.fb.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (e) { $("#tokErr").textContent = "No se pudo iniciar sesión: " + (e.message || e.code); }
};
// ---------------- modo estático (GitHub Pages): sin servidor; datos que publica GitHub Actions cada ~10 min
S.estatico = false; S.paquete = { vivo: null, series: null, tv: 0, ts: 0 };
async function detectarEstatico() {
  try {
    const sonda = await fetch("/api/estado", { cache: "no-store" });
    if (sonda.status !== 404 && sonda.status !== 405) return false;
    const r = await fetch("data/vivo.json", { cache: "no-store" });
    if (!r.ok) return false;
    S.estatico = true; return true;
  } catch { return false; }
}
async function jsonEstatico(nombre, campo, ttl) {
  const k = campo === "vivo" ? "tv" : "ts";
  if (!S.paquete[campo] || Date.now() - S.paquete[k] > ttl) {
    S.paquete[campo] = await (await fetch(`data/${nombre}?t=${Date.now()}`, { cache: "no-store" })).json(); S.paquete[k] = Date.now();
  }
  return S.paquete[campo];
}
async function apiEstatica(path) {
  const u = new URL(path, location.href), syms = (u.searchParams.get("symbols") || "").split(",").filter(Boolean);
  if (u.pathname.endsWith("/api/estado")) return { claude: false, finnhub: false, estatico: true, modelo: "—", effort: "—" };
  if (u.pathname.endsWith("/api/quotes")) {
    const v = await jsonEstatico("vivo.json", "vivo", 55000), out = {}, err = {};
    for (const s of syms) { const q = v.cotizaciones[s]; if (q) out[s] = { ...q, edadMin: q.time ? Math.round((Date.now() - Date.parse(q.time)) / 60000) : null }; else err[s] = "no incluido en la publicación"; }
    S.generadoEstatico = v.generado;
    return { cotizaciones: out, errores: err };
  }
  if (u.pathname.endsWith("/api/history")) {
    const d = await jsonEstatico("series.json", "series", 15 * 60000), out = {}, err = {};
    for (const s of syms) { if (d.series[s]) out[s] = d.series[s]; else err[s] = "no incluido; agrégalo a watchlist.json"; }
    return { series: out, errores: err };
  }
  throw new Error("El análisis con Claude no está disponible en la versión de GitHub Pages; usa «Analizar (motor)» o la página de claude.ai.");
}
async function tokenActual() { return S.fb ? (S.fb.user ? await S.fb.user.getIdToken() : "") : S.token; }

async function api(path, opts = {}) {
  if (S.estatico) return apiEstatica(path, opts);
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await tokenActual()), ...(opts.headers || {}) } });
  if (r.status === 401 || r.status === 403 || r.status === 503) { const j = await r.json().catch(() => ({})); pedirToken(j.error); throw new Error(j.error || "No autorizado"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function pedirToken(msg) { $("#tokErr").textContent = msg || ""; if (!$("#dlgLogin").open) $("#dlgLogin").showModal(); }
$("#fLogin").addEventListener("submit", (ev) => { if (S.fb) { ev.preventDefault(); return; } S.token = $("#tok").value.trim(); ls.set("tr_token", S.token); arrancar(); });

// ---------------- horario de mercado (NYSE; BMV abre a la misma hora casi todo el año)
function mercadoAbierto() {
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = ny.getDay(), m = ny.getHours() * 60 + ny.getMinutes();
  if (!(d >= 1 && d <= 5 && m >= 570 && m < 960)) return false;
  // Feriados de EE. UU. (p. ej. Acción de Gracias): en horario hábil, si el último precio de SPY no es de hoy, está cerrado
  const t = S.q?.SPY?.time;
  if (t && new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) !== new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) && m > 600) return false;
  return true;
}

// ---------------- cotizaciones en vivo
const todos = () => [...new Set([...S.cfg.indices, ...S.cfg.activos, ...simbolosEstrategia()])];
const simbolosEstrategia = () => [...(S.evid ? [...Object.values(S.evid.mangas).map((m) => m.simbolo), "MXN=X"] : []), ...simbolosPlan()];
let pollTimer = null;
async function refrescar() {
  clearTimeout(pollTimer);
  const abierto = mercadoAbierto();
  $("#dotMkt").classList.toggle("on", abierto); $("#mktTxt").textContent = abierto ? "Mercado abierto" : "Mercado cerrado";
  if (document.visibilityState === "visible") {
    try {
      const j = await api("/api/quotes?symbols=" + encodeURIComponent(todos().join(",")));
      S.q = { ...S.q, ...j.cotizaciones };
      const tq = S.q.SPY?.time ? Date.parse(S.q.SPY.time) : null, abiertoAhora = mercadoAbierto();
      $("#dotMkt").classList.toggle("on", abiertoAhora); $("#mktTxt").textContent = abiertoAhora ? "Mercado abierto" : "Mercado cerrado";
      $("#actTxt").textContent = !tq ? "Sin precios todavía"
        : abiertoAhora ? `· precios de hace ${Math.max(0, Math.round((Date.now() - tq) / 60000))} min`
        : `· precios del cierre del ${new Date(tq).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "America/New_York" })}`;
      pintarVivo(); revisarAlertas(); evaluarEstrategia(); evaluarPlan(); pintarLab();
    } catch (e) { $("#actTxt").textContent = "Error de precios: " + e.message; }
  }
  pollTimer = setTimeout(refrescar, (abierto ? (S.estatico ? 60 : S.cfg.poll) : 300) * 1000);
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refrescar());
function edadChip(q) {
  if (!q) return `<span class="chip n">sin precio</span>`;
  const e = q.edadMin ?? 999;
  if (!mercadoAbierto()) return `<span class="chip n">cierre</span>`;
  return e <= 3 ? `<span class="chip g">vivo</span>` : `<span class="chip y">retraso ${e} min</span>`;
}

// ---------------- análisis
function cfgMotor() { return { riesgo: S.cfg.riesgo / 100, maxPos: S.cfg.maxPos / 100 }; }
async function cargarSeries(syms) {
  const falt = syms.filter((s) => !S.series[s] || Date.now() - S.series[s]._t > 5 * 60000);
  for (let i = 0; i < falt.length; i += 10) {
    const j = await api("/api/history?symbols=" + encodeURIComponent(falt.slice(i, i + 10).join(",")));
    for (const [k, v] of Object.entries(j.series)) S.series[k] = { ...v, _t: Date.now() };
    if (Object.keys(j.errores || {}).length) showErr("Sin histórico: " + Object.entries(j.errores).map(([k, v]) => `${k} (${v})`).join(" · "));
  }
}
function progreso(items) {
  const estado = Object.fromEntries(items.map((k) => [k, "…"]));
  const pinta = () => ($("#prog").innerHTML = items.map((k) => `<span class="chip ${estado[k] === "✓" ? "g" : estado[k] === "✕" ? "r" : "n"}">${esc(k)} ${estado[k]}</span>`).join(""));
  pinta(); return (k, v) => { estado[k] = v; pinta(); };
}
async function analizar(conClaude) {
  hideErr(); const c = S.cfg;
  if (conClaude && !S.srv?.claude) return showErr(S.estatico ? "El análisis con Claude no está disponible en la versión de GitHub Pages; usa «Analizar (motor)» o tu página de claude.ai." : "Falta la clave de Claude en el servidor; usa «Analizar (motor)».");
  $("#btnClaude").disabled = $("#btnMotor").disabled = true; $("#progBox").hidden = false;
  $("#progTit").textContent = conClaude ? "Analizando con Claude (≈20-50 s por activo)…" : "Calculando con precios actuales…";
  const marca = progreso(["MERCADO", ...c.activos]);
  S.abort = new AbortController(); $("#btnStop").hidden = !conClaude;
  const rep = { fecha: "", generado: new Date().toLocaleString("es-MX"), fuente: conClaude ? "CLAUDE" : "MOTOR_DETERMINISTA", activos: [], errores: [] };
  try {
    if (!conClaude) {
      await cargarSeries(todos());
      const series = Object.fromEntries(Object.entries(S.series).map(([k, v]) => [k, v]));
      const m = Motor.mercado(series, c.indices, c.activos);
      if (m.falta_spy) throw new Error("Sin datos de SPY: no se puede evaluar el mercado.");
      rep.mercado = Motor.fallbackMercado(m); rep.datos = m; rep.noticias_macro = []; marca("MERCADO", "✓");
      rep.fecha = Object.values(series).map((s) => s.t.at(-1)).sort().at(-1);
      for (const t of c.activos) {
        try { const p = Motor.analizar(S.series[t], t, cfgMotor()); const { _serie, ...plan } = p; rep.activos.push({ ticker: t, analisis: Motor.fallbackActivo(p, rep.mercado), plan, noticias: [] }); marca(t, "✓"); }
        catch (e) { rep.errores.push(`${t}: ${e.message}`); marca(t, "✕"); }
      }
    } else {
      const body = (o) => ({ method: "POST", body: JSON.stringify({ claude: true, riesgo: c.riesgo, maxPos: c.maxPos, ...o }), signal: S.abort.signal });
      const mk = await api("/api/analyze", body({ tipo: "mercado", indices: c.indices, activos: c.activos }));
      rep.mercado = mk.estado; rep.datos = mk.datos; rep.noticias_macro = mk.noticias || []; rep.fecha = mk.fecha; marca("MERCADO", mk.estado.fuente === "CLAUDE" ? "✓" : "✕");
      const cola = [...c.activos];
      await Promise.all([0, 1].map(async () => {
        while (cola.length) {
          const t = cola.shift();
          try { const a = await api("/api/analyze", body({ tipo: "activo", ticker: t, estado: { semaforo: mk.estado.semaforo, regimen: mk.estado.regimen, exposicion_maxima_pct: mk.estado.exposicion_maxima_pct } })); rep.activos.push(a); marca(t, a.analisis.fuente === "CLAUDE" ? "✓" : "✕"); }
          catch (e) { if (e.name === "AbortError") throw e; rep.errores.push(`${t}: ${e.message}`); marca(t, "✕"); }
        }
      }));
      rep.activos.sort((x, y) => c.activos.indexOf(x.ticker) - c.activos.indexOf(y.ticker));
      cargarSeries(c.activos).then(() => S.sel && seleccionar(S.sel)).catch(() => {});
    }
    guardarReporte(rep);
    if (rep.errores.length) showErr("Omitidos: " + rep.errores.join(" · "));
  } catch (e) { showErr(e.name === "AbortError" ? "Análisis detenido." : "Error: " + e.message); }
  finally { $("#progBox").hidden = true; $("#btnMotor").disabled = false; $("#btnClaude").disabled = !S.srv?.claude; $("#btnStop").hidden = true; }
}
$("#btnMotor").onclick = () => analizar(false);
$("#btnClaude").onclick = () => analizar(true);
$("#btnStop").onclick = () => S.abort?.abort();

// ---------------- historial local + reporte diario del worker
function guardarReporte(rep) {
  rep.id = Date.now().toString(36); S.rep = rep;
  const h = ls.get("tr_hist", []); h.unshift(rep); ls.set("tr_hist", h.slice(0, 10));
  pintarHist(); render();
}
function pintarHist() {
  const h = ls.get("tr_hist", []);
  $("#hist").innerHTML = h.map((r) => `<option value="${esc(r.id)}">${esc(r.generado)} · ${esc(r.fuente === "CLAUDE" ? "Claude" : "motor")}</option>`).join("") + `<option value="__worker">Cierre diario (worker)</option>`;
  if (S.rep?.id) $("#hist").value = S.rep.id;
}
$("#hist").onchange = async (e) => {
  if (e.target.value === "__worker") return cargarWorker(true);
  S.rep = ls.get("tr_hist", []).find((r) => r.id === e.target.value) || S.rep; render();
};
async function cargarWorker(mostrarError) {
  try {
    const r = await (await fetch("data/latest.json", { cache: "no-store" })).json();
    S.rep = { id: "__worker", fecha: r.fecha, generado: r.generado_utc, fuente: "WORKER " + (r.mercado?.fuente || ""), mercado: r.mercado, datos: r.mercado?.datos || {}, noticias_macro: r.noticias_macro || [], errores: r.errores || [],
      activos: r.activos.map((a) => ({ ticker: a.ticker, analisis: a.analisis, noticias: a.noticias || [], plan: { ...a.motor, niveles: a.niveles, senal_motor: a.senal_motor } })) };
    render();
  } catch (e) { if (mostrarError) showErr("No hay reporte diario del worker todavía."); }
}

// ---------------- alertas
function revisarAlertas() {
  if (!S.rep?.activos) return;
  const hoy = new Date().toISOString().slice(0, 10), nuevas = [];
  for (const a of S.rep.activos) {
    const q = S.q[a.ticker], n = a.plan.niveles || {}, atr = a.plan.indicadores?.ATR14, s = a.analisis.senal, p = q?.price;
    if (!Number.isFinite(p)) continue;
    const ref = a.plan.niveles?.precio ?? a.plan.precio;
    if (!ref || Math.abs(p / ref - 1) > 0.25) continue;   // análisis desfasado o de otra fuente: no alertar
    const ev = [];
    if (n.stop_loss && p <= n.stop_loss) ev.push(["stop", "r", `${a.ticker} tocó el stop ${fmt(n.stop_loss)} (precio ${fmt(p)})`]);
    if (n.resistencia_1 && p >= n.resistencia_1) ev.push(["obj1", "g", `${a.ticker} alcanzó el objetivo 1 ${fmt(n.resistencia_1)}: vender 50%`]);
    if ((s === "COMPRAR" || s === "ESPERAR_SOPORTE") && atr && n.entrada && Math.abs(p - n.entrada) <= 0.25 * atr) ev.push(["entrada", "b", `${a.ticker} en zona de entrada del swing ${fmt(n.entrada)} (precio ${fmt(p)}). Informativa: el swing no pasó la validación`]);
    if (s === "ESPERAR_RUPTURA" && n.entrada && p > n.entrada) ev.push(["ruptura", "b", `${a.ticker} rompe ${fmt(n.entrada)}: confirmar con cierre diario y volumen`]);
    if (s === "VENDER_TOMA_GANANCIAS" && n.trailing_stop && p < n.trailing_stop) ev.push(["trailing", "y", `${a.ticker} perdió el trailing ${fmt(n.trailing_stop)}`]);
    for (const [tipo, c, txt] of ev) { const k = `${hoy}|${a.ticker}|${tipo}`; if (!S.alertas[k]) { S.alertas[k] = { c, txt, t: new Date().toLocaleTimeString("es-MX") }; nuevas.push(txt); } }
  }
  for (const k of Object.keys(S.alertas)) if (!k.startsWith(hoy)) delete S.alertas[k];
  ls.set("tr_alertas", S.alertas); pintarAlertas();
  if (nuevas.length) avisar(nuevas);
}
function pintarAlertas() {
  const it = Object.values(S.alertas);
  $("#alertas").innerHTML = it.length ? it.reverse().map((a) => `<li class="${a.c}">${esc(a.t)} · ${esc(a.txt)}</li>`).join("") : `<li class="mut">Sin alertas hoy.</li>`;
}
let audio = null;
function avisar(msgs) {
  try { if (Notification?.permission === "granted") msgs.forEach((m) => new Notification("Terminal de Riesgo", { body: m })); } catch {}
  try { audio ||= new AudioContext(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = 0.05; o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.25); } catch {}
}
$("#btnAlert").onclick = async () => {
  try { const r = await Notification.requestPermission(); $("#alEstado").textContent = r === "granted" ? "notificaciones activas" : "notificaciones bloqueadas por el navegador"; } catch { $("#alEstado").textContent = "este navegador no admite notificaciones"; }
  try { audio ||= new AudioContext(); await audio.resume(); } catch {}
};

// ---------------- render
function showErr(msg, ok) { $("#errBox").hidden = false; $("#err").className = "note " + (ok ? "ok" : "crit"); $("#err").textContent = msg; }
function hideErr() { $("#errBox").hidden = true; }

function render() {
  const R = S.rep;
  $("#repTxt").textContent = R ? `Análisis: ${R.generado} · ${R.fuente}` : "";
  renderMercado(); renderWatch(); pintarAlertas();
  $("#emptyCard").hidden = !!R?.activos?.length; $("#detBody").hidden = !R?.activos?.length;
  if (R?.activos?.length) seleccionar(R.activos.find((a) => a.ticker === S.sel) ? S.sel : R.activos[0].ticker);
}
function renderMercado() {
  const m = S.rep?.mercado, d = S.rep?.datos || {};
  const [b, txt] = SEM[m?.semaforo] || ["", "—"];
  document.querySelectorAll(".bulb").forEach((x) => x.classList.toggle("on", !!b && x.classList.contains(b)));
  $("#semTxt").textContent = txt; $("#semTxt").className = "big " + b;
  pintarIndices();
  if (!m) return;
  $("#mkFuente").textContent = m.fuente || "";
  $("#semReg").textContent = `Régimen ${m.regimen} · confianza ${m.confianza}`;
  $("#expTxt").textContent = m.exposicion_maxima_pct + "%"; $("#expTope").textContent = d.tope_exposicion_pct != null ? `(tope duro ${d.tope_exposicion_pct}%)` : "";
  $("#expBar").style.width = m.exposicion_maxima_pct + "%"; $("#mkRes").textContent = m.resumen || "";
  $("#mkCorr").innerHTML = [...(m.correcciones_guardrail || []).map((c) => `<div class="note crit">Corrección: ${esc(c)}</div>`), ...(d.razones_tope || []).map((c) => `<div class="note">${esc(c)}</div>`)].join("") + (m.error_llm ? `<div class="note crit">Claude falló: ${esc(m.error_llm)}</div>` : "");
  const imp = { POSITIVO: "▲", NEGATIVO: "▼", NEUTRAL: "◇" }, nm = Object.fromEntries((S.rep.noticias_macro || []).map((n) => [n.id, n]));
  const lst = (t, a) => (a?.length ? `<b class="small">${t}</b><ul class="t">${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  $("#mkDet").innerHTML = `<ul class="t">${(m.drivers || []).map((x) => `<li>${imp[x.impacto] || ""} <b>${esc(x.factor)}</b>: ${esc(x.lectura)} <span class="mut">[${esc(x.dato_citado)}]</span></li>`).join("")}</ul>
    ${(m.noticias_clave || []).length ? `<b class="small">Noticias clave</b><ul class="t">${m.noticias_clave.map((n) => `<li>${imp[n.impacto] || ""} ${esc(nm[n.news_id]?.titulo || n.news_id)}: ${esc(n.por_que_importa)}</li>`).join("")}</ul>` : ""}
    ${lst("Riesgos macro", m.riesgos_macro)}<div class="note"><b>Contra-tesis:</b> ${esc(m.contra_tesis)}</div>${lst("Qué cambiaría la lectura", m.que_cambiaria_la_lectura)}${lst("Datos faltantes", m.datos_faltantes)}`;
}
function pintarIndices() {
  const d = S.rep?.datos?.indices || {};
  $("#tIdx tbody").innerHTML = S.cfg.indices.map((t) => { const q = S.q[t], r = d[t] || {};
    return `<tr data-q="${esc(t)}"><td>${esc(t)}</td><td class="num">${fmt(q?.price ?? r.precio)} ${q ? edadChip(q) : ""}</td><td class="num ${q?.changePct >= 0 ? "g" : "r"}">${pct(q?.changePct, 2)}</td><td class="num ${r["dist_sma200_%"] >= 0 ? "g" : "r"}">${pct(r["dist_sma200_%"])}</td><td class="num">${fmt(r.rsi14, 1)}</td></tr>`; }).join("")
    + (S.rep?.datos?.["amplitud_sobre_sma50_%"] != null ? `<tr><td class="mut">Amplitud &gt; SMA50</td><td class="num" colspan="4">${fmt(S.rep.datos["amplitud_sobre_sma50_%"], 1)}%</td></tr>` : "");
}
function filaActivo(t) {
  const a = S.rep?.activos?.find((x) => x.ticker === t), q = S.q[t];
  const x = a?.analisis, n = a?.plan?.niveles || {}, p = q?.price;
  const dist = (lvl) => (Number.isFinite(p) && lvl ? pct((p / lvl - 1) * 100) : "—");
  return `<td><b>${esc(t)}</b><br>${fmt(p)} <span class="${q?.changePct >= 0 ? "g" : "r"}">${pct(q?.changePct, 2)}</span><br>${edadChip(q)}</td>
    <td>${x ? chip(FASE, x.fase) + "<br>" + chip(SENAL, x.senal) : '<span class="mut">sin analizar</span>'}${(() => { const v = S.pat && velasDe(t); return v && v.lista.length ? `<br><span class="small mut">Velas: ${v.lista.map((p) => esc(S.pat.patrones[p.clave].nombre)).join(", ")}</span>` : ""; })()}</td>
    <td class="num">${dist(n.entrada)}</td><td class="num">${dist(n.stop_loss)}</td>
    <td class="num">${a?.plan?.rr != null ? "1:" + fmt(a.plan.rr) : "—"}</td><td class="num">${x ? fmt(x.tamano_posicion_final_pct, 1) + "%" : "—"}</td>`;
}
function renderWatch() {
  $("#watch tbody").innerHTML = S.cfg.activos.map((t) => `<tr data-t="${esc(t)}">${filaActivo(t)}</tr>`).join("");
  document.querySelectorAll("#watch tbody tr").forEach((tr) => { tr.classList.toggle("sel", tr.dataset.t === S.sel); tr.onclick = () => seleccionar(tr.dataset.t); });
}
function pintarVivo() {
  document.querySelectorAll("#watch tbody tr").forEach((tr) => { const html = filaActivo(tr.dataset.t); if (tr.innerHTML !== html) { tr.innerHTML = html; tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash"); } });
  pintarIndices();
  if (S.sel) { const q = S.q[S.sel]; if (q) { $("#dPx").textContent = linePx(S.sel); actualizarVela(q); } calc(); }
}
function linePx(t) {
  const a = S.rep?.activos?.find((x) => x.ticker === t), q = S.q[t], I = a?.plan?.indicadores || {};
  return `${fmt(q?.price ?? a?.plan?.niveles?.precio)} ${q?.currency || ""} ${q ? pct(q.changePct, 2) : ""} · ATR14 ${fmt(I.ATR14)} (${fmt(I["ATR%"])}%) · RSI ${fmt(I.RSI14, 1)}`;
}
function seleccionar(t) {
  S.sel = t; const a = S.rep?.activos?.find((x) => x.ticker === t);
  document.querySelectorAll("#watch tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.t === t));
  if (!a) return;
  const x = a.analisis, p = a.plan, n = p.niveles || {}, I = p.indicadores || {};
  $("#dTk").textContent = t; $("#dPx").textContent = linePx(t);
  $("#dChips").innerHTML = chip(FASE, x.fase) + chip(SENAL, x.senal) + (x.fase !== p.fase ? `<span class="chip y">Motor: ${esc(FASE[p.fase]?.[2] || p.fase)}</span>` : "") + `<span class="chip n">${esc(x.fuente || "")}</span>`;
  pintarGrafico(a);
  const col = { alcista: "var(--up)", lateral: "var(--mut)", bajista: "var(--dn)" };
  $("#dEsc").innerHTML = ["alcista", "lateral", "bajista"].map((k) => { const s = x.escenarios[k];
    return `<div class="esc"><span>${k[0].toUpperCase() + k.slice(1)}</span><div class="track"><div class="fill" style="width:${+s.probabilidad || 0}%;background:${col[k]}"></div></div><b class="num">${+s.probabilidad || 0}%</b></div><div class="desc">${esc(s.nivel_ref)} ${fmt(s.nivel)} · ${esc(s.tesis)}</div>`; }).join("");
  $("#dConf").textContent = `Confianza ${x.confianza} · horizonte ${x.horizonte}${x.discrepancia_fase ? " · " + x.discrepancia_fase : ""}`;
  const filas = [["Fase motor", FASE[p.fase]?.[2] || p.fase], ["Entrada", fmt(n.entrada)], ["Soporte estructural", fmt(n.soporte)], [`Stop (${I.Mult_ATR_stop}×ATR)`, fmt(n.stop_loss)], ["Distancia al stop", fmt(p.distancia_stop_pct) + "%"],
    ["Objetivo 1 (50%)", fmt(n.resistencia_1)], ["Objetivo 2", fmt(n.objetivo_2)], ["R:R a objetivo 1", p.rr != null ? "1:" + fmt(p.rr) : "—"], ["Trailing stop", fmt(n.trailing_stop)], ["Tamaño motor", p.tamano_posicion_pct != null ? fmt(p.tamano_posicion_pct) + "%" : "—"], ["Tamaño final", fmt(x.tamano_posicion_final_pct) + "%"]];
  $("#dPlan").innerHTML = filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + `<dt>Cálculo</dt><dd class="mut small" style="white-space:normal">${esc(x.tamano_calculo)}</dd>`;
  $("#dTim").innerHTML = `<p><b class="g">Gatillo de compra</b><br>${esc(x.gatillo_compra)}</p><p><b class="r">Gatillo de venta / salida</b><br>${esc(x.gatillo_venta)}</p><p><b class="y">Invalidación temporal · ${esc(x.invalidacion_temporal_sesiones)} sesiones</b><br>${esc(x.invalidacion_temporal_texto)}</p>`;
  $("#dCon").innerHTML = `<div class="note">${esc(x.contra_tesis)}</div><ul class="t">${(x.riesgos_invalidacion || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    + (x.correcciones_guardrail || []).map((c) => `<div class="note crit">Corrección: ${esc(c)}</div>`).join("") + (p.alertas || []).map((c) => `<div class="note">Motor: ${esc(c)}</div>`).join("")
    + (x.error_llm ? `<div class="note crit">Claude falló: ${esc(x.error_llm)}</div>` : "") + ((x.datos_faltantes || []).length ? `<p class="small mut">Datos faltantes: ${esc(x.datos_faltantes.join(", "))}</p>` : "");
  const rel = Object.fromEntries((x.noticias_relevantes || []).map((r) => [r.news_id, r])), CS = { POSITIVO: ["▲", "g", "Positiva"], NEGATIVO: ["▼", "r", "Negativa"], NEUTRAL: ["◇", "n", "Neutral"] };
  $("#dNews").innerHTML = (a.noticias || []).length ? `<p class="mono small">Sentimiento ${fmt(x.sentimiento_noticias)} · ajuste de tamaño ${esc(x.ajuste_tamano)}${x.razon_ajuste ? " · " + esc(x.razon_ajuste) : ""}</p><ul class="t">`
    + a.noticias.map((nn) => { const r = rel[nn.id], u = safeUrl(nn.url); return `<li>${r ? chip(CS, r.sentimiento) + " " : ""}${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(nn.titulo)}</a>` : esc(nn.titulo)} <span class="mut">${esc(nn.fuente)} ${esc((nn.fecha || "").slice(0, 16).replace("T", " "))}</span>${r?.impacto ? `<br><span class="mut">${esc(r.impacto)}</span>` : ""}</li>`; }).join("") + "</ul>"
    : `<p class="mut">${x.fuente === "CLAUDE" ? "No hubo noticias de las últimas 24 h para " + esc(t) + "." : "El análisis con motor no lee noticias; usa «Analizar con Claude»."}</p>`;
  $("#kEnt").value = n.entrada ?? ""; $("#kStop").value = n.stop_loss ?? ""; $("#kTgt").value = n.resistencia_1 ?? ""; $("#kRisk").value = S.cfg.riesgo;
  calc(); pintarJSON(); pintarEscHist(t); pintarVelas(t);
}
// Calculadora en MXN: SIC convierte con MXN=X
function calc() {
  const cap = +$("#kCap").value, r = +$("#kRisk").value / 100, e = +$("#kEnt").value, s = +$("#kStop").value, t = +$("#kTgt").value;
  const a = S.rep?.activos?.find((x) => x.ticker === S.sel), q = S.q[S.sel];
  const usd = (q?.currency || (S.sel && !S.sel.endsWith(".MX") ? "USD" : "MXN")) === "USD", fx = S.q["MXN=X"]?.price;
  const k = usd ? fx : 1;
  $("#kFx").textContent = usd ? (fx ? `SIC: 1 USD = ${fmt(fx, 4)} MXN` : "SIC: agrega MXN=X a índices para convertir") : "BMV: precios en MXN";
  const out = [];
  if (e > 0 && s > 0 && e > s && Number.isFinite(k)) {
    const ru = (e - s) * k, u = Math.floor((cap * r) / ru), noc = u * e * k;
    out.push(["Riesgo en dinero", "$" + fmt(cap * r) + " MXN"], ["Distancia al stop", fmt(((e - s) / e) * 100) + "%"], ["Títulos por riesgo", fmt(u, 0)], ["Monto", `$${fmt(noc)} MXN (${fmt((noc / cap) * 100, 1)}% del capital)`]);
    if (a && a.analisis.senal !== "COMPRAR") out.push(["Plan", `<span class="y">Señal «${esc(SENAL[a.analisis.senal]?.[2] || a.analisis.senal)}»: no autoriza abrir posición.</span>`]);
    else if (a) { const tope = (cap * a.analisis.tamano_posicion_final_pct) / 100, ut = Math.floor(Math.min(noc, tope) / (e * k)); out.push([`Con tope del plan (${fmt(a.analisis.tamano_posicion_final_pct, 1)}%)`, `${fmt(ut, 0)} títulos · $${fmt(ut * e * k)} MXN`]); }
    if (t > e) { const rr = (t - e) / (e - s); out.push(["R:R", `<span class="${rr >= 2 ? "g" : "r"}">1:${fmt(rr)} ${rr >= 2 ? "✓" : "✕ menor a 1:2"}</span>`]); }
    out.push(["Orden en GBM+", `<span class="ink2">Límite ${fmt(e)} · stop ${fmt(s)} · objetivo ${fmt(t)}</span>`]);
  } else out.push(["", `<span class="mut">${!Number.isFinite(k) ? "Falta el tipo de cambio para convertir a MXN." : "La entrada debe ser mayor que el stop (posición larga)."}</span>`]);
  $("#kOut").innerHTML = out.map(([kk, v]) => `<dt>${esc(kk)}</dt><dd>${v}</dd>`).join("");
}
["#kCap", "#kRisk", "#kEnt", "#kStop", "#kTgt"].forEach((id) => $(id).addEventListener("input", calc));
$("#kCap").value = ls.get("tr_cap", 100000); $("#kCap").addEventListener("change", () => ls.set("tr_cap", +$("#kCap").value));
function pintarJSON() { const a = S.rep?.activos?.find((x) => x.ticker === S.sel); $("#json").textContent = JSON.stringify(S.jsonTab === "analisis" ? a?.analisis : S.jsonTab === "plan" ? a?.plan : { ...S.rep?.mercado, datos: S.rep?.datos }, null, 2); }
document.querySelectorAll(".tabs button[data-j]").forEach((b) => (b.onclick = () => { S.jsonTab = b.dataset.j; document.querySelectorAll(".tabs button[data-j]").forEach((x) => x.classList.toggle("on", x === b)); pintarJSON(); }));
$("#copy").onclick = () => navigator.clipboard?.writeText($("#json").textContent).then(() => ($("#copy").textContent = "Copiado"), () => ($("#copy").textContent = "No se pudo copiar"));

// ---------------- gráfico
let chart = null, velas = null, ultima = null;
function colorDe(v) { const el = document.createElement("span"); el.style.color = `var(${v})`; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c; }
async function pintarGrafico(a) {
  const el = $("#chart"); if (chart) { chart.remove(); chart = null; } el.textContent = "";
  if (!window.LightweightCharts) { el.textContent = "No se pudo cargar la librería del gráfico."; return; }
  if (!S.series[a.ticker]) { el.innerHTML = `<p class="mut" style="padding:20px">Cargando histórico…</p>`; try { await cargarSeries([a.ticker]); } catch (e) { el.textContent = e.message; return; } if (S.sel !== a.ticker) return; el.textContent = ""; }
  const s = S.series[a.ticker]; if (!s) return;
  const e = Motor.enrich(s), N = s.t.length, desde = Math.max(0, N - 260);
  const C = { bg: colorDe("--s1"), ink: colorDe("--ink2"), line: colorDe("--line"), up: colorDe("--up"), dn: colorDe("--dn") };
  chart = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: C.bg }, textColor: C.ink, fontFamily: "IBM Plex Mono" },
    grid: { vertLines: { visible: false }, horzLines: { color: C.line } }, rightPriceScale: { borderColor: C.line }, timeScale: { borderColor: C.line }, crosshair: { mode: LightweightCharts.CrosshairMode.Normal } });
  velas = chart.addCandlestickSeries({ upColor: C.up, downColor: C.dn, borderVisible: false, wickUpColor: C.up, wickDownColor: C.dn });
  const idx = [...Array(N - desde)].map((_, i) => desde + i);
  velas.setData(idx.map((i) => ({ time: s.t[i], open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i] })));
  ultima = { time: s.t[N - 1], open: s.o[N - 1], high: s.h[N - 1], low: s.l[N - 1], close: s.c[N - 1] };
  const MAS = [["sma20", "SMA 20", "--ma1"], ["ema21", "EMA 21", "--ma2"], ["sma50", "SMA 50", "--ma3"], ["sma200", "SMA 200", "--ma4"]];
  MAS.forEach(([k, , v]) => { const l = chart.addLineSeries({ color: colorDe(v), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); l.setData(idx.filter((i) => Number.isFinite(e[k][i])).map((i) => ({ time: s.t[i], value: e[k][i] }))); });
  const n = a.plan.niveles || {}, LS = LightweightCharts.LineStyle;
  const niv = [["Entrada", n.entrada, colorDe("--acc"), LS.Solid], ["Soporte", n.soporte, colorDe("--mut"), LS.Dotted], ["Stop ATR", n.stop_loss, C.dn, LS.Dashed], ["Objetivo 1", n.resistencia_1, C.up, LS.Dashed], ["Objetivo 2", n.objetivo_2, C.up, LS.Dotted], ["Trailing", n.trailing_stop, colorDe("--warn"), LS.Dotted]].filter((x) => x[1] != null);
  niv.forEach(([t, p, c, st]) => velas.createPriceLine({ price: p, color: c, lineWidth: 1, lineStyle: st, axisLabelVisible: true, title: t }));
  chart.timeScale().fitContent();
  const base = MAS.map(([, nm, v]) => `<span><i style="border-color:${colorDe(v)}"></i>${nm}</span>`).join("");
  const leyenda = (i) => ($("#leg").innerHTML = base + (i != null ? `<span style="color:var(--ink)">${esc(s.t[i])} A ${fmt(s.o[i])} M ${fmt(s.h[i])} m ${fmt(s.l[i])} C ${fmt(s.c[i])}</span>` : ""));
  const pos = Object.fromEntries(s.t.map((t, i) => [t, i])); leyenda(N - 1);
  chart.subscribeCrosshairMove((ev) => { const t = typeof ev.time === "string" ? ev.time : ev.time ? `${ev.time.year}-${String(ev.time.month).padStart(2, "0")}-${String(ev.time.day).padStart(2, "0")}` : null; leyenda(t && pos[t] != null ? pos[t] : N - 1); });
  $("#legNiv").innerHTML = niv.map(([t, p, c, st]) => `<span><i style="border-color:${c};border-top-style:${st === LS.Solid ? "solid" : "dashed"}"></i>${esc(t)} ${fmt(p)}</span>`).join("");
  const q = S.q[a.ticker]; if (q) actualizarVela(q);
  pintarEscHist(a.ticker); pintarVelas(a.ticker);
}
function actualizarVela(q) {
  if (!velas || !ultima || !Number.isFinite(q.price) || !q.time) return;
  const dia = new Date(q.time).toLocaleDateString("en-CA", { timeZone: S.sel?.endsWith(".MX") ? "America/Mexico_City" : "America/New_York" });
  if (dia !== ultima.time) return;
  ultima = { ...ultima, close: q.price, high: Math.max(ultima.high, q.price), low: Math.min(ultima.low, q.price) };
  velas.update(ultima);
}

// ---------------- configuración
$("#btnCfg").onclick = () => {
  const c = S.cfg; $("#cIdx").value = c.indices.join(", "); $("#cAct").value = c.activos.join(", "); $("#cRisk").value = c.riesgo; $("#cMax").value = c.maxPos; $("#cPoll").value = c.poll;
  $("#cSrv").textContent = S.srv ? `Servidor: Claude ${S.srv.claude ? "configurado (" + S.srv.modelo + ", esfuerzo " + S.srv.effort + ")" : "SIN clave"} · Finnhub ${S.srv.finnhub ? "configurado (EE. UU. en tiempo real)" : "sin clave (EE. UU. vía Yahoo)"}` : "";
  $("#dlgCfg").showModal();
};
$("#fCfg").addEventListener("submit", (ev) => {
  if (ev.submitter?.value !== "ok") return;
  const lista = (s) => s.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9.^=\-]{1,15}$/.test(x)).slice(0, 30);
  S.cfg = { indices: lista($("#cIdx").value), activos: lista($("#cAct").value), riesgo: Math.min(5, Math.max(0.1, +$("#cRisk").value || 1)), maxPos: Math.min(100, Math.max(1, +$("#cMax").value || 25)), poll: Math.min(300, Math.max(10, +$("#cPoll").value || 15)) };
  ls.set("tr_cfg", S.cfg); renderWatch(); refrescar();
});
$("#btnSalir").onclick = async () => { ls.set("tr_token", ""); S.token = ""; $("#dlgCfg").close(); if (S.fb) await S.fb.auth.signOut(); else pedirToken(); };

// ---------------- estrategia validada: filtro de régimen sobre la cartera núcleo
S.evid = null; S.reg = {}; S.colaModal = []; S.senales = ls.get("tr_senales", {}); S.bitacora = ls.get("tr_bitacora", []);
async function cargarEvidencia() {
  try { S.evid = await (await fetch("data/estrategia.json", { cache: "no-store" })).json(); } catch { S.evid = null; }
  if (!S.evid) { $("#estDesc").textContent = "No se encontró data/estrategia.json (genera la evidencia con python -m backtest.publicar_evidencia)."; return; }
  const rec = S.evid.recomendada, c = rec.con_regla.completo, b = rec.comprar_y_mantener.completo, v = rec.con_regla.tramo2_validacion, vb = rec.comprar_y_mantener.tramo2_validacion;
  $("#estFuente").textContent = `${S.evid.periodo.inicio} → ${S.evid.periodo.fin}`;
  $("#estDesc").textContent = `${rec.cartera}. Regla: mantener cada parte mientras su precio cierre el mes por encima de su media de 200 días; si cierra por debajo, pasar esa parte a CETES. Se decide solo al cierre del último día hábil del mes.`;
  $("#estEvid").innerHTML = `20 años: <b>${fmt(c.cagr_pct)}% anual</b>, peor caída <b class="g">${fmt(c.max_dd_pct, 1)}%</b> · sin regla: ${fmt(b.cagr_pct)}% anual, peor caída <span class="r">${fmt(b.max_dd_pct, 1)}%</span>. Validación 2016-2026 (no usada para elegir): ${fmt(v.cagr_pct)}% vs ${fmt(vb.cagr_pct)}% sin regla; caída ${fmt(v.max_dd_pct, 1)}% vs ${fmt(vb.max_dd_pct, 1)}%. <span class="mut">Es un seguro: cuesta rendimiento en años buenos y protege en crisis.</span>`;
  const crisis = Object.keys(rec.con_regla.completo.crisis || {});
  $("#estDet").innerHTML = `<div class="scroll"><table><thead><tr><th>Crisis</th><th class="num">Con regla</th><th class="num">Sin regla</th></tr></thead><tbody>${crisis.map((k) => `<tr><td>${esc(k)}</td><td class="num g">${fmt(rec.con_regla.completo.crisis[k], 1)}%</td><td class="num r">${fmt(rec.comprar_y_mantener.completo.crisis[k], 1)}%</td></tr>`).join("")}</tbody></table></div>
    <div class="scroll" style="margin-top:8px"><table><thead><tr><th>Cartera · regla</th><th class="num">20a CAGR</th><th class="num">Caída</th><th class="num">2016-26</th></tr></thead><tbody>${S.evid.tabla.map((f) => `<tr><td>${esc(f.cartera)} · ${esc(f.regla.replace("sma200_", "200d ").replace("comprar_y_mantener", "comprar y mantener"))}</td><td class="num">${fmt(f.completo.cagr_pct)}%</td><td class="num">${fmt(f.completo.max_dd_pct, 1)}%</td><td class="num">${fmt(f.tramo2_validacion.cagr_pct)}%</td></tr>`).join("")}</tbody></table></div>
    <p class="small mut">Costos ${esc(S.evid.costos_por_lado_pct)}% por operación. Efectivo: ${esc(S.evid.fuentes.tasa_efectivo)}. IPC: ${esc(S.evid.fuentes.ipc)}. ${S.evid.swing_v2 ? `El swing por emisora NO pasó la validación: en 2016-2026 rindió ${fmt(S.evid.swing_v2.tramo2.cagr_pct)}% anual (menos que CETES) con R medio ${fmt(S.evid.swing_v2.tramo2.r_promedio, 3)}. Por eso la watchlist y sus alertas son solo informativas.` : ""}</p>`;
  pintarBitacora();
}
function proximoCierreMes() {
  const d = new Date(); for (let i = 0; i < 40; i++) { const f = d.toISOString().slice(0, 10); if (d.getUTCDay() % 6 !== 0 && Motor.ultimoHabilDelMes(f)) return f; d.setUTCDate(d.getUTCDate() + 1); } return "—";
}
function serieConVivo(sym) {
  const s = S.series[sym], q = S.q[sym]; if (!s) return null;
  if (!q || !Number.isFinite(q.price) || !q.time) return s;
  const dia = new Date(q.time).toLocaleDateString("en-CA", { timeZone: sym.endsWith(".MX") ? "America/Mexico_City" : "America/New_York" });
  const n = s.t.length; if (s.t[n - 1] !== dia) return s;        // nunca se inventa una vela
  const c = [...s.c]; c[n - 1] = q.price; return { ...s, c };
}
const capital = () => +$("#pCap").value || ls.get("tr_cap", 100000);
function montoManga(nombre) {
  if (S.plan) { const pr = S.plan.procesos.find((x) => x.nombre === nombre); if (pr) return capital() * (S.plan.perfiles[S.perfil].pesos[pr.id] ?? 0); }
  return capital() * (S.evid?.recomendada.pesos[nombre] ?? 0);
}
function titulos(nombre, m, r) { const fx = m.simbolo.endsWith(".MX") ? 1 : S.q["MXN=X"]?.price; const px = S.q[m.simbolo]?.price ?? r.precio; return fx ? Math.floor(montoManga(nombre) / (px * fx)) : null; }
function evaluarEstrategia() {
  if (!S.evid) return;
  const abierto = mercadoAbierto();
  for (const [nombre, m] of Object.entries(S.evid.mangas)) {
    const s = serieConVivo(m.simbolo); if (!s || s.c.length < 220) continue;
    const r = Motor.regimen(s, m.regla); S.reg[nombre] = r;
    let tipo = null;
    if (r.senal !== "MANTENER" && r.hoy_decide) tipo = abierto ? "preliminar" : "confirmada";
    else if (r.hoy_decide && abierto && Math.abs(r.distancia_pct) < 1.5) tipo = "cerca";
    if (tipo && !S.q[m.simbolo]) tipo = null;     // esperar el primer precio en vivo antes de avisar
    if (S.plan) tipo = null;                       // con plan cargado, los avisos los emite evaluarPlan()
    if (tipo) { const k = `${r.fecha}|${nombre}|${tipo}|${r.senal}`; if (!S.senales[k]) { S.senales[k] = Date.now(); ls.set("tr_senales", S.senales); S.colaModal.push({ nombre, m, r, tipo }); } }
  }
  pintarEstrategia(); siguienteModal();
}
function pintarEstrategia() {
  if (!S.evid) return;
  const prox = proximoCierreMes();
  $("#mangas").innerHTML = Object.entries(S.evid.mangas).map(([nombre, m]) => {
    const r = S.reg[nombre], q = S.q[m.simbolo];
    if (!r) return `<div class="manga"><h3>${esc(nombre)}</h3><span class="mut small">Cargando histórico de ${esc(m.simbolo)}…</span></div>`;
    const est = r.estado === "INVERTIDO" ? `<span class="chip g">● Invertido</span>` : `<span class="chip n">○ En CETES</span>`;
    const sen = r.senal === "MANTENER" ? `<span class="chip n">Mantener</span>` : r.senal === "COMPRAR" ? `<span class="chip g">▲ Comprar${r.hoy_decide ? "" : ""}</span>` : `<span class="chip r">▼ Vender</span>`;
    return `<div class="manga"><h3><span>${esc(nombre)}</span><span class="mono small mut">${esc(m.simbolo)}</span></h3>${est} ${sen} ${edadChip(q)}
      <dl class="kv" style="margin-top:6px"><dt>Precio</dt><dd>${fmt(q?.price ?? r.precio)}</dd><dt>Media 200 días</dt><dd>${fmt(r.sma200)}</dd>
      <dt>Distancia</dt><dd class="${r.distancia_pct >= 0 ? "g" : "r"}">${pct(r.distancia_pct)}</dd><dt>Próxima decisión</dt><dd>${r.hoy_decide ? "<b class='y'>HOY al cierre</b>" : esc(prox)}</dd>
      <dt>Monto objetivo</dt><dd>$${fmt(montoManga(nombre), 0)} MXN</dd><dt>Último cambio</dt><dd>${esc(r.ultimo_cambio || "—")}</dd></dl></div>`;
  }).join("");
}
function siguienteModal() {
  if ($("#dlgSenal").open || !S.colaModal.length) return;
  const { nombre, m, r, tipo } = S.colaModal.shift(), q = S.q[m.simbolo];
  const accion = tipo === "cerca" ? (r.estado === "INVERTIDO" ? "VIGILAR: posible VENTA" : "VIGILAR: posible COMPRA") : r.senal;
  $("#sgTipo").textContent = { preliminar: "SEÑAL PRELIMINAR · se confirma con el cierre de hoy", confirmada: "SEÑAL CONFIRMADA · ejecutar en la próxima apertura", cerca: "ATENCIÓN · hoy se decide al cierre" }[tipo];
  $("#sgTit").textContent = `${accion} ${nombre}`; $("#sgTit").className = "accion " + (r.senal === "COMPRAR" ? "g" : r.senal === "VENDER" ? "r" : "y");
  $("#sgSub").textContent = m.como_comprar;
  const n = titulos(nombre, m, r);
  $("#sgGrid").innerHTML = [["Precio", `${fmt(q?.price ?? r.precio)} ${q?.currency || ""}`], ["Dato", q ? (q.edadMin <= 3 ? "en vivo" : `${q.edadMin} min de retraso`) : "último cierre"],
    ["Media 200 días", fmt(r.sma200)], ["Distancia a la media", pct(r.distancia_pct)], ["Monto de esta parte", `$${fmt(montoManga(nombre), 0)} MXN`], ["Títulos aprox.", n != null ? fmt(n, 0) : "—"]]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#sgQue").textContent = tipo === "cerca"
    ? `Hoy es el último día hábil del mes y el precio está a ${pct(r.distancia_pct)} de su media de 200 días. Revisa 10 minutos antes del cierre: si cierra ${r.estado === "INVERTIDO" ? "por debajo, la señal será VENDER" : "por encima, la señal será COMPRAR"}.`
    : r.senal === "VENDER"
      ? `En GBM+: vende tu posición de ${m.simbolo} ${tipo === "preliminar" ? "solo si el cierre de hoy confirma (precio bajo la media)" : "en la apertura de mañana"} y deja ese dinero en CETES o en un fondo de deuda de corto plazo.`
      : `En GBM+: compra ~${n != null ? fmt(n, 0) : "—"} títulos de ${m.simbolo} (≈ $${fmt(montoManga(nombre), 0)} MXN) ${tipo === "preliminar" ? "solo si el cierre de hoy confirma (precio sobre la media)" : "en la apertura de mañana"}, con orden limitada cercana al precio de apertura.`;
  const e = m.episodios || {}, fa = m.falsas_alarmas || {}, cr = m.con_regla.completo, bh = m.comprar_y_mantener.completo;
  $("#sgEvid").innerHTML = `<b>Qué dice la historia (${esc(S.evid.periodo.inicio.slice(0, 4))}-${esc(S.evid.periodo.fin.slice(0, 4))}):</b> esta regla en ${esc(nombre)} rindió ${fmt(cr.cagr_pct)}% anual con peor caída de ${fmt(cr.max_dd_pct, 1)}% (sin regla: ${fmt(bh.cagr_pct)}% y ${fmt(bh.max_dd_pct, 1)}%). ${e.n ? `Hubo ${e.n} periodos invertidos; ${fmt(e.ganadores_pct, 0)}% terminaron con ganancia, con resultado medio de ${pct(e.ret_medio_pct)} y duración media de ${fmt(e.dias_medios, 0)} días.` : ""} En 2008 la caída fue ${fmt(cr.crisis?.["Crisis 2008"], 1)}% con la regla y ${fmt(bh.crisis?.["Crisis 2008"], 1)}% sin ella.`;
  $("#sgRiesgo").textContent = fa.salidas ? `Riesgo conocido: ${fa.revertidas_menos_3_meses} de ${fa.salidas} salidas (${fmt(fa.pct, 0)}%) se revirtieron en menos de 3 meses (falsas alarmas con costo). La regla protege de caídas largas, no acierta cada movimiento. No es asesoría personalizada.` : "";
  S.modalActual = { nombre, m, r, tipo, accion };
  try { $("#dlgSenal").showModal(); avisar([`${accion} ${nombre}`]); } catch {}
}
$("#sgOk").onclick = () => { const a = S.modalActual; if (a) { S.bitacora.unshift({ fecha: new Date().toLocaleString("es-MX"), accion: a.accion, parte: a.nombre, simbolo: a.m.simbolo, precio: S.q[a.m.simbolo]?.price ?? a.r.precio, monto: Math.round(montoManga(a.nombre)) }); ls.set("tr_bitacora", S.bitacora.slice(0, 100)); pintarBitacora(); } $("#dlgSenal").close(); };
$("#sgLuego").onclick = () => { const a = S.modalActual; if (a) { const k = `${a.r.fecha}|${a.nombre}|${a.tipo}|${a.r.senal}`; delete S.senales[k]; ls.set("tr_senales", S.senales); setTimeout(() => evaluarEstrategia(), 30 * 60000); } $("#dlgSenal").close(); };
$("#sgCerrar").onclick = () => $("#dlgSenal").close();
$("#dlgSenal").addEventListener("close", () => setTimeout(siguienteModal, 400));
function pintarBitacora() {
  $("#bitacora").innerHTML = `<h3 class="small" style="margin:12px 0 4px">Bitácora de ejecuciones</h3>` + (S.bitacora.length ? `<div class="scroll"><table><thead><tr><th>Fecha</th><th>Acción</th><th class="num">Precio</th><th class="num">Monto</th></tr></thead><tbody>${S.bitacora.map((b) => `<tr><td>${esc(b.fecha)}</td><td>${esc(b.accion)} ${esc(b.simbolo)}</td><td class="num">${fmt(b.precio)}</td><td class="num">$${fmt(b.monto, 0)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small mut">Aún no registras ejecuciones.</p>`);
}

// ---------------- patrones de velas: evidencia de 20 años (data/patrones.json) + detección en vivo
S.pat = null; S.hz = "10"; S.velasCache = {};
async function cargarPatrones() {
  try { S.pat = await (await fetch("data/patrones.json", { cache: "no-store" })).json(); } catch { S.pat = null; }
  pintarLaboratorio();
}
const VEREDICTO = (info) => info.validado ? `<span class="chip g">✓ Validado</span>` : `<span class="chip n">✕ Sin ventaja</span>`;
function pintarLaboratorio() {
  if (!S.pat) { $("#labResumen").textContent = "Sin datos del laboratorio."; return; }
  const P = Object.values(S.pat.patrones), val = P.filter((x) => x.validado).length;
  $("#labPeriodo").textContent = `${S.pat.periodo.inicio.slice(0, 4)}-2026 · ${S.pat.activos.length} activos`;
  $("#labResumen").textContent = `${P.length} estrategias de lectura de velas medidas en 20 años, con costos de GBM. Validadas: ${val}. Ventaja = rendimiento a 10 días tras la señal menos el rendimiento normal del activo.`;
  $("#tLab tbody").innerHTML = P.map((x) => { const a = x.tramos.t1["10"], b = x.tramos.t2["10"], n = (a.n || 0) + (b.n || 0);
    return `<tr><td><b>${esc(x.nombre)}</b><br><span class="mut">${esc(x.autor)} · ${x.tipo === "alcista" ? "compra" : "venta"}</span></td><td class="num">${fmt(n, 0)}</td>
      <td class="num ${a.ventaja_pct > 0 ? "g" : "r"}">${pct(a.ventaja_pct, 2)}</td><td class="num ${b.ventaja_pct > 0 ? "g" : "r"}">${pct(b.ventaja_pct, 2)}</td><td>${VEREDICTO(x)}</td></tr>`; }).join("");
  $("#labNota").textContent = `Conclusión: ninguna superó a mantener el activo después de costos (${S.pat.costo_ida_vuelta_pct}% por operación completa). La única con señal bruta constante en ambos tramos es el RSI(2) de Connors (~+0.2-0.3% a 5 días antes de costos), insuficiente con las comisiones actuales. Úsalas como contexto, no como gatillo.`;
}
function velasDe(t) {
  const s = S.series[t]; if (!s || s.c.length < 260) return null;
  const k = `${t}|${s.t.at(-1)}|${s.c.at(-1)}`;
  if (!S.velasCache[k]) S.velasCache[k] = Motor.patronesRecientes(s, 3);
  return S.velasCache[k];
}
function pintarVelas(t) {
  const r = velasDe(t), el = $("#dVelas");
  if (!S.pat) { el.innerHTML = `<p class="mut">Sin datos de patrones.</p>`; return; }
  if (!r) { el.innerHTML = `<p class="mut">Cargando histórico…</p>`; return; }
  if (!r.lista.length) { el.innerHTML = `<p class="mut">Ningún patrón de los ${Object.keys(S.pat.patrones).length} estudiados apareció en las últimas 3 sesiones de ${esc(t)}.</p>`; return; }
  el.innerHTML = r.lista.map(({ clave, fecha, hace }) => {
    const x = S.pat.patrones[clave], h = S.hz, a = x.tramos.todo[h], v = x.tramos.t2[h];
    return `<div class="manga" style="margin-bottom:8px"><h3><span>${esc(x.nombre)} <span class="chip ${x.tipo === "alcista" ? "g" : "r"}">${x.tipo === "alcista" ? "▲ señal de compra" : "▼ señal de venta"}</span></span>${VEREDICTO(x)}</h3>
      <div class="small mut">${esc(x.autor)} · ${hace === 0 ? "hoy" : `hace ${hace} sesión${hace > 1 ? "es" : ""}`} (${esc(fecha)})</div>
      <p class="small ink2" style="margin:6px 0">${esc(x.descripcion)}</p>
      <dl class="kv"><dt>Apariciones en 20 años</dt><dd>${fmt(a.n, 0)}</dd><dt>Rendimiento medio a ${h} días (con costos)</dt><dd>${pct(a.ret_medio_pct, 2)}</dd>
      <dt>Rendimiento normal del activo</dt><dd>${pct(a.base_pct, 2)}</dd><dt>Ventaja</dt><dd class="${a.ventaja_pct > 0 ? "g" : "r"}">${pct(a.ventaja_pct, 2)}</dd>
      <dt>Acierto</dt><dd>${fmt(a.acierto_pct, 1)}%</dd><dt>Validación 2016-26</dt><dd class="${v.ventaja_pct > 0 ? "g" : "r"}">${pct(v.ventaja_pct, 2)}</dd>
      <dt>Escenarios tras el patrón</dt><dd>▲ ${fmt(a.p_sube, 0)}% · ◇ ${fmt(a.p_lateral, 0)}% · ▼ ${fmt(a.p_baja, 0)}%</dd></dl></div>`;
  }).join("") + `<p class="small mut">Escenarios: sube más de ${S.pat.umbrales_escenario_pct[S.hz]}%, lateral o baja más de ${S.pat.umbrales_escenario_pct[S.hz]}% en ${S.hz} días, medidos en todas las apariciones del patrón en ${S.pat.activos.length} activos.</p>`;
}
function pintarEscHist(t) {
  const el = $("#dEscHist"), b = S.pat?.base_activos?.[t];
  const r = velasDe(t);
  if (!S.pat) { el.innerHTML = `<p class="mut">Sin datos históricos.</p>`; return; }
  if (!b) { el.innerHTML = `<p class="mut">${esc(t)} no está en el estudio de 20 años (agrégalo a backtest/universo.json para incluirlo).</p>`; return; }
  const reg = r ? (r.sobre200 ? "sobre" : "bajo") : "sobre", e = b[reg][S.hz], u = S.pat.umbrales_escenario_pct[S.hz];
  const fila = (nom, p, col) => `<div class="esc"><span>${nom}</span><div class="track"><div class="fill" style="width:${p}%;background:${col}"></div></div><b class="num">${fmt(p, 0)}%</b></div>`;
  el.innerHTML = fila("Sube", e.p_sube, "var(--up)") + `<div class="desc">más de +${u}% en ${S.hz} días</div>` + fila("Lateral", e.p_lateral, "var(--mut)") + `<div class="desc">entre −${u}% y +${u}%</div>`
    + fila("Baja", e.p_baja, "var(--dn)") + `<div class="desc">más de −${u}%</div>`
    + `<p class="small ink2" style="margin-top:8px">Con el precio <b>${reg === "sobre" ? "por encima" : "por debajo"}</b> de su media de 200 días, en 20 años (${fmt(e.n, 0)} casos) ${esc(t)} tuvo a ${S.hz} días: mediana ${pct(e.p50, 2)}, 1 de cada 10 veces peor que ${pct(e.p10, 1)} y 1 de cada 10 mejor que ${pct(e.p90, 1)}.</p>`;
}
document.querySelectorAll("#hzTabs button").forEach((b) => (b.onclick = () => { S.hz = b.dataset.h; document.querySelectorAll("#hzTabs button").forEach((x) => x.classList.toggle("on", x === b)); if (S.sel) { pintarEscHist(S.sel); pintarVelas(S.sel); } }));

// ---------------- TU PLAN: caminos de inversión con reglas simples (data/plan.json)
S.plan = null; S.perfil = ls.get("tr_perfil", "moderado"); S.planReg = {};
async function cargarPlan() {
  try { S.plan = await (await fetch("data/plan.json", { cache: "no-store" })).json(); } catch { S.plan = null; }
  try { S.retiros = await (await fetch("data/retiros.json", { cache: "no-store" })).json(); } catch { S.retiros = null; }
  try { S.ctx = await (await fetch("data/contexto.json", { cache: "no-store" })).json(); } catch { S.ctx = null; }
  try { S.mundo = await (await fetch("data/mundo.json", { cache: "no-store" })).json(); } catch { S.mundo = null; }
  pintarContexto();
  if (!S.plan) { $("#planResumen").textContent = "No se encontró data/plan.json."; return; }
  $("#descartados").innerHTML = S.plan.descartados.map((d) => `<li><b>${esc(d.nombre)}:</b> ${esc(d.razon)}</li>`).join("");
  $("#planNota").textContent = `${S.plan.nota} Periodo ${S.plan.periodo.inicio.slice(0, 4)}-${S.plan.periodo.fin.slice(0, 4)}. Herramienta de análisis basada en datos históricos; no garantiza resultados futuros ni es asesoría personalizada.`;
  document.querySelectorAll("#pPerfil button").forEach((b) => b.classList.toggle("on", b.dataset.p === S.perfil));
  pintarPlan();
}
const simbolosPlan = () => [...(S.plan ? S.plan.procesos.filter((x) => x.simbolo).map((x) => x.simbolo) : []), ...(S.mundo ? Object.keys(S.mundo.mercados) : [])];
function fechaLarga(f) { try { return new Date(f + "T12:00:00Z").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }); } catch { return f; } }
function estadoProceso(p) {
  if (p.tipo === "cetes") return null;
  const s = serieConVivo(p.simbolo); if (!s || s.c.length < 220) return null;
  const r = Motor.regimen(s, p.regla); S.planReg[p.id] = r; return r;
}
function vista(p, r) {
  const prox = fechaCorta(proximoCierreMes()), dist = r ? pct(r.distancia_pct) : "", prelim = r && r.hoy_decide && mercadoAbierto();
  if (!r) return { cls: "n", accion: "Cargando…", paso: "" };
  if (r.senal === "VENDER") return { cls: "r", accion: "VENDER", paso: prelim ? "Vende mañana si hoy cierra así." : "Vende en la próxima apertura." };
  if (r.senal === "COMPRAR") return { cls: "g", accion: "COMPRAR", paso: prelim ? "Compra mañana si hoy cierra así." : "Compra en la próxima apertura." };
  if (r.estado === "INVERTIDO") return r.distancia_pct >= 0
    ? { cls: "g", accion: "MANTENER", paso: "Si no tienes, puedes comprar hoy.", detalle: `${dist} sobre su media de 200 días.` }
    : { cls: "y", accion: "VIGILAR", paso: `Se decide el ${prox}.`, detalle: `${dist} bajo su media: si cierra así, VENDER.` };
  return r.distancia_pct > 0
    ? { cls: "b", accion: "EN PAUSA", paso: `Podría comprarse el ${prox}.`, detalle: `${dist} sobre su media: si cierra así, COMPRAR.` }
    : { cls: "n", accion: "EN PAUSA", paso: "Espera en CETES.", detalle: `${dist} bajo su media de 200 días.` };
}
function fechaCorta(f) { try { return new Date(f + "T12:00:00Z").toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "UTC" }); } catch { return f; } }
function pintarPlan() {
  if (!S.plan) return;
  const pesos = S.plan.perfiles[S.perfil].pesos, cap = capital();
  const items = S.plan.procesos.filter((p) => (pesos[p.id] ?? 0) > 0);
  let enPausa = 0; const grupos = { comprar: [], vigilar: [], vender: [], pausa: [] };
  const tarjetas = items.map((p) => {
    const r = estadoProceso(p), w = pesos[p.id], monto = cap * w;
    if (p.tipo === "cetes") return { p, w, monto };
    const v = vista(p, r);
    if (r && r.estado === "EFECTIVO" && r.senal !== "COMPRAR") enPausa += monto;
    if (v.accion === "VENDER") grupos.vender.push(p.nombre);
    else if (v.accion === "COMPRAR" || v.paso.startsWith("Si no tienes")) grupos.comprar.push(p.nombre);
    else if (v.accion === "VIGILAR" || v.cls === "b") grupos.vigilar.push(p.nombre);
    else if (r) grupos.pausa.push(p.nombre);
    return { p, r, w, monto, v };
  });
  const plazoCorto = (x) => x.split(" (")[0];
  $("#procesos").innerHTML = tarjetas.map(({ p, r, w, monto, v }) => {
    if (p.tipo === "cetes") {
      return `<div class="proc k-g"><div class="tags"><span>${esc(plazoCorto(p.plazo))}</span><span>${fmt(w * 100, 0)}%</span></div><h3>${esc(p.nombre)}</h3>
        <div class="accion g">MANTENER</div><div class="monto">$${fmt(monto + enPausa, 0)}</div>
        <p class="que">Colchón${enPausa ? " + índices en pausa" : ""}. ~${fmt(p.evidencia.t2.con_regla.cagr_pct, 1)}% al año, sin caídas.</p>
        <details><summary>Reglas y evidencia</summary><p class="reglas"><b>Compra:</b> ${esc(p.compra)}<br><b>Vende:</b> ${esc(p.venta)}</p><p class="small mut">${esc(p.como)}</p></details></div>`;
    }
    const ev = p.evidencia.todo.con_regla, sin = p.evidencia.todo.sin_regla, q = S.q[p.simbolo];
    return `<div class="proc k-${v.cls}"><div class="tags"><span>${esc(plazoCorto(p.plazo))}</span><span>${fmt(w * 100, 0)}%</span></div><h3>${esc(p.nombre)}</h3>
      <div class="accion ${v.cls}">${esc(v.accion)}</div><div class="monto">$${fmt(monto, 0)}</div>
      <p class="que"><b>${esc(v.paso)}</b></p>
      <details><summary>Reglas y evidencia</summary>
        ${v.detalle ? `<p class="small">${esc(v.detalle)}</p>` : ""}
        <p class="reglas"><b>Compra:</b> ${esc(p.compra)}<br><b>Vende:</b> ${esc(p.venta)}</p>
        <p class="small ink2">20 años con la regla: <b>${fmt(ev.cagr_pct, 1)}% al año</b>, peor caída ${fmt(ev.max_dd_pct, 0)}% (sin regla: ${fmt(sin.cagr_pct, 1)}% y ${fmt(sin.max_dd_pct, 0)}%).${p.falsas_alarmas ? ` Falsas alarmas: ${fmt(p.falsas_alarmas.pct, 0)}% de las salidas.` : ""}</p>
        <p class="small mut">${esc(p.como)}${q ? ` · ${fmt(q.price)} ${q.currency || ""}` : ""}</p></details></div>`;
  }).join("");
  const ch = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;
  $("#planResumen").innerHTML = (grupos.vender.length ? ch("r", "▼ Vender: " + esc(grupos.vender.join(", "))) : "")
    + (grupos.comprar.length ? ch("g", "● Comprar: " + esc(grupos.comprar.join(", "))) : "")
    + (grupos.vigilar.length ? ch("y", "◷ Vigilar: " + esc(grupos.vigilar.join(", "))) : "")
    + (grupos.pausa.length ? ch("n", "○ En pausa: " + esc(grupos.pausa.join(", "))) : "")
    + ch("g", `CETES: $${fmt(cap * (pesos.CETES || 0) + enPausa, 0)}`);
  const prox = proximoCierreMes(), hoy = new Date().toISOString().slice(0, 10);
  $("#planAviso").innerHTML = prox === hoy || Object.values(S.planReg).some((r) => r.hoy_decide)
    ? `<b>Hoy se decide</b> · revisa antes de las 15:00 (CDMX). Si algo cambia, aparecerá un aviso.`
    : `<b>Próxima decisión: ${esc(fechaLarga(prox))}</b> · 15:00 CDMX. Mientras, no tienes que hacer nada.`;
  const pf = S.plan.perfiles[S.perfil], cf = pf.con_filtro.todo, sf = pf.sin_filtro.todo;
  $("#planEspera").innerHTML = `<b>${{ conservador: "Conservador", moderado: "Moderado", agresivo: "Agresivo" }[S.perfil]}</b>, en 20 años: <b>~${fmt(cf.cagr_pct, 1)}% al año</b> · peor caída <b>${fmt(cf.max_dd_pct, 0)}%</b> <span class="mut">(sin reglas: ${fmt(sf.cagr_pct, 1)}% y ${fmt(sf.max_dd_pct, 0)}%)</span>`;
  pintarMeta();
}
// ---------------- meta: US$1,000 al mes (data/retiros.json)
function pintarMeta() {
  const R = S.retiros; if (!R) return;
  const pr = R.perfiles[S.perfil]?.sma200_mensual; if (!pr) return;
  const fx = S.q["MXN=X"]?.price || R.supuestos.tipo_cambio_hoy, esc2 = fx / R.supuestos.tipo_cambio_hoy;
  const K = pr.renta_perpetua.mediana_mxn * esc2, Kpeor = pr.renta_perpetua.peor_mxn * esc2, K10 = pr.no_se_acaba.peor_mxn * esc2;
  const cap = capital(), av = Math.min(100, (100 * cap) / K);
  $("#metaK").textContent = `$${fmt(K / 1e6, 1)} millones`;
  $("#metaKsub").textContent = `para una renta para siempre (caso típico) · peor caso $${fmt(Kpeor / 1e6, 1)} M · solo 10 años: $${fmt(K10 / 1e6, 1)} M`;
  $("#metaBar").style.width = av + "%";
  $("#metaAvance").innerHTML = `Llevas <b>${fmt(av, 0)}%</b>. Hoy tu capital daría ~<b>US$${fmt((1000 * cap) / K, 0)} al mes</b> sostenibles.`;
  const ah = +$("#pAhorro").value || 0, r = Math.max(0.01, (S.plan.perfiles[S.perfil].con_filtro.todo.cagr_pct - 3) / 100) / 12;
  let v = cap, m = 0; while (v < K && m < 600) { v = v * (1 + r) + ah; m++; }
  $("#metaAnios").innerHTML = m >= 600 ? "Con ese ahorro no se alcanza en 50 años: aumenta el ahorro mensual." : `Ahorrando $${fmt(ah, 0)} al mes llegas en <b>~${fmt(m / 12, 1)} años</b>.`;
  $("#metaNota").textContent = `Retiros de US$1,000 al tipo de cambio real de cada mes, probando cada mes de arranque entre 2006 y 2016 (incluye empezar justo antes de 2008), con 1% anual de impuestos y comisiones, conservando el valor real (inflación de 4%). La proyección de ahorro usa el rendimiento histórico del perfil menos 3 puntos, por prudencia. Pasado no garantiza futuro.`;
}
function evaluarPlan() {
  if (!S.plan) return;
  const abierto = mercadoAbierto();
  for (const p of S.plan.procesos) {
    if (p.tipo !== "filtro" || !(S.plan.perfiles[S.perfil].pesos[p.id] > 0)) continue;
    const r = estadoProceso(p); if (!r || !S.q[p.simbolo]) continue;
    let tipo = null;
    if (r.senal !== "MANTENER" && r.hoy_decide) tipo = abierto ? "preliminar" : "confirmada";
    else if (r.hoy_decide && abierto && Math.abs(r.distancia_pct) < 1.5) tipo = "cerca";
    if (!tipo) continue;
    const k = `${r.fecha}|${p.nombre}|${tipo}|${r.senal}`;
    if (S.senales[k]) continue;
    S.senales[k] = Date.now(); ls.set("tr_senales", S.senales);
    const m = { simbolo: p.simbolo, como_comprar: p.como, regla: p.regla, episodios: p.episodios, falsas_alarmas: p.falsas_alarmas,
      con_regla: { completo: p.evidencia.todo.con_regla }, comprar_y_mantener: { completo: p.evidencia.todo.sin_regla } };
    S.colaModal.push({ nombre: p.nombre, m, r, tipo });
  }
  pintarPlan(); pintarMundo(); siguienteModal();
}
document.querySelectorAll("#pPerfil button").forEach((b) => (b.onclick = () => { S.perfil = b.dataset.p; ls.set("tr_perfil", S.perfil); document.querySelectorAll("#pPerfil button").forEach((x) => x.classList.toggle("on", x === b)); pintarPlan(); }));
$("#pCap").value = ls.get("tr_cap", 100000);
$("#pCap").addEventListener("input", () => { ls.set("tr_cap", +$("#pCap").value || 0); $("#kCap").value = $("#pCap").value; pintarPlan(); pintarEstrategia(); });
// mover controles técnicos a la terminal avanzada para que el encabezado quede limpio
["#hist", "#btnMotor", "#btnClaude", "#btnStop"].forEach((id) => $("#avzBar").append($(id)));

function pintarContexto() {
  const C = S.ctx; if (!C) return;
  const col = { negativo: "r", positivo: "g", mixto: "y" };
  const link = (u) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(new URL(u).hostname.replace("www.", ""))}</a>` : "");
  $("#ctxFecha").textContent = new Date(C.actualizado + "T12:00:00Z").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  $("#ctxLista").innerHTML = C.puntos.map((x) => `<li><span class="chip ${col[x.impacto] || "n"}">${esc(x.tema)}</span> ${esc(x.para_ti)}
    <details><summary class="small">Qué pasó</summary><span class="ink2">${esc(x.texto)}</span> ${x.fuentes.map(link).join(" · ")}</details></li>`).join("");
  $("#ctxNota").textContent = C.nota;
  const B = C.casas_de_bolsa, vcol = (v) => (v.startsWith("Recomendada") ? "g" : v.startsWith("Alternativa") ? "b" : "n");
  $("#dondeRec").innerHTML = `<b>${esc(B.recomendacion)}</b>`;
  $("#dondeLista").innerHTML = B.opciones.map((o) => `<li><b>${esc(o.nombre)}</b> <span class="chip ${vcol(o.veredicto)}">${esc(o.veredicto)}</span><details><summary class="small">Por qué</summary><span class="ink2">${esc(o.por_que)}</span></details></li>`).join("");
  $("#dondeImp").innerHTML = esc(B.impuestos) + "<br>" + B.fuentes.map(link).join(" · ");
}
$("#pAhorro").value = ls.get("tr_ahorro", 10000);
$("#pAhorro").addEventListener("input", () => { ls.set("tr_ahorro", +$("#pAhorro").value || 0); pintarMeta(); });

// ---------------- LABORATORIO DE TRADING (localStorage; candados de riesgo; meta)
const LB_DEF = { cap: 100000, riesgo: 1, maxMes: 5, com: 0.29, metaUsd: 5000, metaMeses: 6, inicio: new Date().toISOString().slice(0, 10) };
const LB = { cfg: { ...LB_DEF, ...ls.get("tr_lab_cfg", {}) }, ops: ls.get("tr_lab_ops", []) };
const lbFx = () => S.q["MXN=X"]?.price || S.retiros?.supuestos?.tipo_cambio_hoy || 19.5;
const lbGuardar = () => { ls.set("tr_lab_cfg", LB.cfg); ls.set("tr_lab_ops", LB.ops); };
function lbAMxn(op, px) { return op.mon === "USD" ? px * lbFx() : px; }
function lbResultado(op, salida) {
  const c = LB.cfg.com / 100, ent = lbAMxn(op, op.ent), sal = lbAMxn(op, salida);
  const pnl = op.tit * (sal * (1 - c) - ent * (1 + c)), riesgo = op.tit * (ent - lbAMxn(op, op.stop));
  return { pnl, r: riesgo > 0 ? pnl / riesgo : 0 };
}
function lbMesActual(op) { return (op.cierre || "").slice(0, 7) === new Date().toISOString().slice(0, 7); }
function lbStats() {
  const cerr = LB.ops.filter((o) => o.salida != null), reales = cerr.filter((o) => o.modo === "real");
  const sumar = (arr) => arr.reduce((a, o) => a + lbResultado(o, o.salida).pnl, 0);
  const pnlMesReal = sumar(reales.filter(lbMesActual));
  const base = cerr.filter((o) => o.modo === (reales.length ? "real" : "sim"));
  const rs = base.map((o) => lbResultado(o, o.salida).r), pnl = sumar(base);
  let eq = 0, pico = 0, dd = 0; for (const o of base.slice().sort((a, b) => (a.cierre < b.cierre ? -1 : 1))) { eq += lbResultado(o, o.salida).pnl; pico = Math.max(pico, eq); dd = Math.min(dd, eq - pico); }
  const dias = Math.max(1, (Date.now() - Date.parse(LB.cfg.inicio)) / 864e5), cetes = LB.cfg.cap * 0.063 * dias / 365;
  return { n: base.length, modo: reales.length ? "real" : "sim", gan: rs.length ? (100 * rs.filter((r) => r > 0).length) / rs.length : null,
    rMedio: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, pnl, dd, cetes, pnlMesReal, pnlRealTotal: sumar(reales) };
}
function lbCandado() {
  const st = lbStats(), lim = -(LB.cfg.cap * LB.cfg.maxMes) / 100;
  return { activo: st.pnlMesReal <= lim, st, lim };
}
function lbCalcular() {
  const e = +$("#lbEnt").value, s = +$("#lbStop").value, o = +$("#lbObj").value, mon = $("#lbMon").value, fx = mon === "USD" ? lbFx() : 1;
  if (!(e > 0 && s > 0 && e > s)) { $("#lbCalc").textContent = "El stop debe estar por debajo de la entrada."; return null; }
  const riesgoMxn = (LB.cfg.cap * LB.cfg.riesgo) / 100, tit = Math.floor(riesgoMxn / ((e - s) * fx));
  if (!$("#lbTit").dataset.manual) $("#lbTit").value = tit;
  const t = +$("#lbTit").value || tit, rr = o > e ? (o - e) / (e - s) : null, monto = t * e * fx;
  $("#lbCalc").innerHTML = `Arriesgas <b>$${fmt(t * (e - s) * fx, 0)}</b> (${fmt((100 * t * (e - s) * fx) / LB.cfg.cap, 2)}% del laboratorio) · monto $${fmt(monto, 0)}`
    + (rr != null ? ` · R:R <b class="${rr >= 2 ? "g" : "r"}">1:${fmt(rr, 2)}</b>${rr < 2 ? " (menor a 1:2)" : ""}` : "")
    + (monto > LB.cfg.cap ? ` · <b class="r">supera tu capital</b>` : "");
  return { tit: t, rr, monto };
}
["#lbEnt", "#lbStop", "#lbObj", "#lbMon"].forEach((id) => $(id).addEventListener("input", () => { delete $("#lbTit").dataset.manual; lbCalcular(); }));
$("#lbTit").addEventListener("input", () => { $("#lbTit").dataset.manual = "1"; lbCalcular(); });
$("#lbForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const c = lbCalcular(); if (!c || !(c.tit > 0)) return;
  const modo = $("#lbModo").value;
  if (modo === "real" && lbCandado().activo) { $("#lbCalc").innerHTML = `<b class="r">Candado activo: alcanzaste tu pérdida máxima del mes. Solo puedes registrar simulaciones hasta el día 1.</b>`; return; }
  if (modo === "real" && LB.ops.filter((o) => o.modo === "sim" && o.salida != null).length < 20 && !confirm2()) return;
  LB.ops.unshift({ id: Date.now().toString(36), modo, tk: $("#lbTk").value.trim().toUpperCase(), est: $("#lbEst").value, ent: +$("#lbEnt").value, stop: +$("#lbStop").value,
    obj: +$("#lbObj").value || null, tit: c.tit, mon: $("#lbMon").value, apertura: new Date().toISOString().slice(0, 10), salida: null, cierre: null });
  lbGuardar(); $("#lbForm").reset(); delete $("#lbTit").dataset.manual; $("#lbCalc").textContent = ""; pintarLab();
});
let lbAvisoReal = false;
function confirm2() {   // aviso (sin window.confirm): primer intento real sin 20 simulaciones cerradas
  if (lbAvisoReal) return true;
  lbAvisoReal = true;
  $("#lbCalc").innerHTML = `<b class="y">Recomendación: cierra al menos 20 operaciones simuladas antes de usar dinero real. Si aun así quieres continuar, vuelve a pulsar «Registrar operación».</b>`;
  return false;
}
function lbCerrar(id) {
  const op = LB.ops.find((o) => o.id === id); if (!op) return;
  const fila = document.querySelector(`tr[data-lb="${id}"] input`); const px = +fila?.value;
  if (!(px > 0)) { fila?.focus(); return; }
  op.salida = px; op.cierre = new Date().toISOString().slice(0, 10); lbGuardar(); pintarLab();
}
function lbBorrar(id) { LB.ops = LB.ops.filter((o) => o.id !== id); lbGuardar(); pintarLab(); }
function pintarLab() {
  const c = LB.cfg, st = lbStats(), cand = lbCandado(), fx = lbFx();
  // meta
  const metaMxn = c.metaUsd * fx, fin = new Date(Date.parse(c.inicio) + c.metaMeses * 30.44 * 864e5), restanMeses = Math.max(0, (fin - Date.now()) / (30.44 * 864e5));
  const ganado = st.modo === "real" ? st.pnlRealTotal : st.pnl, falta = Math.max(0, metaMxn - ganado), av = Math.max(0, Math.min(100, (100 * ganado) / metaMxn));
  const reqTotal = (100 * metaMxn) / c.cap, reqMes = restanMeses > 0 ? (Math.pow(1 + falta / c.cap, 1 / restanMeses) - 1) * 100 : null;
  $("#lbMetaFechas").textContent = `${c.inicio} → ${fin.toISOString().slice(0, 10)}`;
  $("#lbMeta").innerHTML = [[`US$${fmt(c.metaUsd, 0)}`, `meta (≈ $${fmt(metaMxn, 0)} MXN)`], [`$${fmt(ganado, 0)}`, `ganado (${st.modo === "real" ? "real" : "simulado"})`],
    [`${fmt(reqTotal, 0)}%`, "rendimiento total necesario"], [reqMes != null ? `${fmt(reqMes, 1)}%` : "—", "necesario por mes desde hoy"]]
    .map(([b, t]) => `<div class="kpi"><b>${b}</b><span>${t}</span></div>`).join("");
  $("#lbMetaBar").style.width = av + "%";
  const nivel = reqMes == null ? "" : reqMes <= 1 ? `<b class="g">Alcanzable con disciplina.</b>` : reqMes <= 3 ? `<b class="y">Excepcional: muy pocos lo sostienen.</b>` : `<b class="r">Irreal: perseguirlo empuja a arriesgar de más y perder la cuenta.</b>`;
  $("#lbMetaTxt").innerHTML = `${nivel} Como referencia, el plan moderado ha dado ~0.9% al mes en promedio. Con este capital, una meta sostenible en ${c.metaMeses} meses sería ~US$${fmt((c.cap * (Math.pow(1.009, c.metaMeses) - 1)) / fx, 0)}.`;
  // candado
  $("#labCandado").innerHTML = cand.activo ? `<div class="candado">Candado activo: perdiste $${fmt(-st.pnlMesReal, 0)} este mes (límite $${fmt(-cand.lim, 0)}). Hasta el día 1, solo simulación.</div>` : "";
  // KPIs
  const ventaja = st.n >= 50 ? (st.rMedio > 0 && st.pnl > st.cetes ? `<span class="chip g">✓ Con ventaja en ${st.n} operaciones</span>` : `<span class="chip r">✕ Sin ventaja: considera dejarlo</span>`) : `<span class="chip n">Faltan ${50 - st.n} operaciones para juzgar</span>`;
  $("#lbVeredicto").innerHTML = ventaja;
  $("#lbKpis").innerHTML = [[st.n, `operaciones cerradas (${st.modo === "real" ? "reales" : "simuladas"})`], [st.gan != null ? fmt(st.gan, 0) + "%" : "—", "ganadoras"],
    [st.rMedio != null ? fmt(st.rMedio, 2) + "R" : "—", "ganancia media por operación"], [`$${fmt(st.pnl, 0)}`, "resultado neto de comisiones"],
    [`$${fmt(st.cetes, 0)}`, "lo que habría dado CETES"], [`$${fmt(st.dd, 0)}`, "peor racha"],
    [`$${fmt(st.pnlMesReal, 0)}`, `real este mes (límite −$${fmt(-cand.lim, 0)})`]].map(([b, t]) => `<div class="kpi"><b>${b}</b><span>${t}</span></div>`).join("");
  // tabla
  $("#lbTabla tbody").innerHTML = LB.ops.map((o) => {
    const q = S.q[o.tk], abierta = o.salida == null;
    const res = abierta ? (q ? lbResultado(o, q.price) : null) : lbResultado(o, o.salida);
    const estado = abierta ? (q ? `${fmt(q.price)} ahora` : "abierta") : `cerrada ${esc(o.cierre)}`;
    return `<tr data-lb="${esc(o.id)}"><td><b>${esc(o.tk)}</b><br><span class="mut">${esc(o.est)} · ${esc(o.apertura)}</span></td><td>${o.modo === "real" ? `<span class="chip y">Real</span>` : `<span class="chip n">Sim</span>`}</td>
      <td class="num">${fmt(o.ent, 2)} ${esc(o.mon)}</td><td class="num">${fmt(o.stop, 2)} / ${o.obj ? fmt(o.obj, 2) : "—"}</td><td class="num">${fmt(o.tit, 0)}</td>
      <td class="num ${res ? (res.pnl >= 0 ? "g" : "r") : ""}">${res ? `$${fmt(res.pnl, 0)} · ${fmt(res.r, 2)}R` : "—"}<br><span class="mut">${estado}</span></td>
      <td>${abierta ? `<input type="number" step="0.0001" placeholder="precio salida" style="width:8em"> <button data-cerrar="${esc(o.id)}">Cerrar</button>` : ""} <button data-borrar="${esc(o.id)}" title="Borrar">✕</button></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="mut">Aún no registras operaciones. Empieza en modo Simulación.</td></tr>`;
  document.querySelectorAll("[data-cerrar]").forEach((b) => (b.onclick = () => lbCerrar(b.dataset.cerrar)));
  document.querySelectorAll("[data-borrar]").forEach((b) => (b.onclick = () => lbBorrar(b.dataset.borrar)));
  $("#labResumenTop").textContent = `· ${st.n} cerradas · $${fmt(st.pnl, 0)} · meta ${fmt(av, 0)}%${cand.activo ? " · CANDADO" : ""}`;
  lbRevisarAbiertas();
}
const lbAvisados = ls.get("tr_lab_avisos", {});
function lbRevisarAbiertas() {
  for (const o of LB.ops.filter((x) => x.salida == null)) {
    const q = S.q[o.tk]; if (!q) continue;
    const ev = q.price <= o.stop ? "stop" : o.obj && q.price >= o.obj ? "objetivo" : null;
    if (ev && !lbAvisados[o.id + ev]) { lbAvisados[o.id + ev] = 1; ls.set("tr_lab_avisos", lbAvisados); avisar([`${o.tk}: tocó su ${ev} (${fmt(q.price)}). Registra el cierre en el laboratorio.`]); }
  }
}
function lbCfgEnForm() { const c = LB.cfg; $("#lbCap").value = c.cap; $("#lbRiesgo").value = c.riesgo; $("#lbMaxMes").value = c.maxMes; $("#lbCom").value = c.com; $("#lbMetaUsd").value = c.metaUsd; $("#lbMetaMeses").value = c.metaMeses; $("#lbInicio").value = c.inicio; }
$("#lbGuardarCfg").onclick = () => {
  LB.cfg = { cap: Math.max(0, +$("#lbCap").value || 0), riesgo: Math.min(3, Math.max(0.1, +$("#lbRiesgo").value || 1)), maxMes: Math.min(20, Math.max(1, +$("#lbMaxMes").value || 5)),
    com: Math.max(0, +$("#lbCom").value || 0), metaUsd: Math.max(0, +$("#lbMetaUsd").value || 0), metaMeses: Math.max(1, +$("#lbMetaMeses").value || 6), inicio: $("#lbInicio").value || LB_DEF.inicio };
  lbGuardar(); pintarLab();
};
$("#lbExport").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ cfg: LB.cfg, ops: LB.ops }, null, 1)], { type: "application/json" })); a.download = `laboratorio-trading-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
$("#lbImport").onchange = async (e) => { try { const d = JSON.parse(await e.target.files[0].text()); if (Array.isArray(d.ops)) { LB.ops = d.ops; LB.cfg = { ...LB_DEF, ...(d.cfg || {}) }; lbGuardar(); lbCfgEnForm(); pintarLab(); } } catch { $("#lbCalc").textContent = "Archivo de respaldo inválido."; } e.target.value = ""; };
lbCfgEnForm(); pintarLab();

// ---------------- MERCADOS DEL MUNDO: estado en vivo con la regla validada + evidencia de 20 años (data/mundo.json)
function pintarMundo() {
  const M = S.mundo; if (!M) return;
  const grupos = {}; let sanos = 0, total = 0;
  for (const [t, m] of Object.entries(M.mercados)) {
    const s = serieConVivo(t); let r = null;
    if (s && s.c.length >= 220) r = Motor.regimen(s, M.regla);
    let cls = "n", est = "Sin datos";
    if (r) {
      total++;
      if (r.estado === "INVERTIDO" && r.distancia_pct >= 0) { cls = "g"; est = "Tendencia sana"; sanos++; }
      else if (r.estado === "INVERTIDO") { cls = "y"; est = "Vigilar"; }
      else if (r.distancia_pct > 0) { cls = "b"; est = "Recuperándose"; }
      else { cls = "r"; est = "Bajo su media"; }
    }
    const td = m.tramos.todo; const ev = td ? `Con la regla: ${fmt(td.filtro.cagr_pct, 1)}% al año, caída máx. ${fmt(td.filtro.max_dd_pct, 0)}%. Sin regla: ${fmt(td.comprar_y_mantener.cagr_pct, 1)}% y ${fmt(td.comprar_y_mantener.max_dd_pct, 0)}%. Desde ${m.desde.slice(0, 4)}.` : "Historia corta.";
    (grupos[m.grupo] ||= []).push(`<div class="mtile k-${cls}"><b>${esc(m.nombre)}</b><span class="est ${cls}">${est}</span>${r ? ` <span class="small mut">${pct(r.distancia_pct)}</span>` : ""}
      <details><summary>${esc(t)}</summary><span class="small ink2">${esc(ev)}${m.reduce_caida_ambos === false ? " La regla no redujo la caída aquí." : ""}</span></details></div>`);
  }
  $("#mundoResumen").textContent = total ? `· ${sanos} de ${total} en tendencia sana` : "";
  const R = M.resumen, acwi = M.mercados.ACWI?.tramos?.todo;
  $("#mundoNota").innerHTML = `La regla de 200 días redujo la peor caída en <b>${R.filtro_reduce_caida_en_ambos} de ${R.mercados_con_dos_tramos}</b> mercados en ambos periodos. En pesos, casi todo fuera de EE. UU. rindió 5-8% al año en 20 años.${acwi ? ` Alternativa diversificada al S&P 500: <b>Mundo entero (ACWI)</b>, ${fmt(acwi.filtro.cagr_pct, 1)}% al año con caída de ${fmt(acwi.filtro.max_dd_pct, 0)}% desde 2008.` : ""}`;
  $("#mundoGrid").innerHTML = Object.entries(grupos).map(([g, tiles]) => `<div class="mgrupo">${esc(g)}</div><div class="mtiles">${tiles.join("")}</div>`).join("");
}

// ---------------- arranque
let arrancando = false;
// ---------------- calidad de datos (data/estado.json, generado en cada publicación)
async function revisarCalidad() {
  if (!S.estatico) return;
  try {
    const e = await (await fetch("data/estado.json?t=" + Date.now(), { cache: "no-store" })).json();
    const horas = (Date.now() - Date.parse(e.generado)) / 36e5, finde = [0, 6].includes(new Date().getDay());
    const viejos = e.problemas.filter((p) => p.tipo === "historico_viejo" || p.tipo === "sin_cotizacion" || p.tipo === "sin_historico").map((p) => p.simbolo);
    let msg = "";
    if (horas > (finde ? 72 : 26)) msg = `Los datos tienen ${Math.round(horas)} horas sin actualizarse. No tomes decisiones hasta que se actualicen.`;
    else if (viejos.length) msg = `Sin datos recientes de: ${[...new Set(viejos)].join(", ")}. Sus señales pueden no ser confiables.`;
    if (msg) showErr(msg);
  } catch { /* sin reporte: sitio anterior a esta versión */ }
}
async function arrancar() {
  if (!S.estatico && (S.fb ? !S.fb.user : !S.token)) return pedirToken();
  if (arrancando) return; arrancando = true;
  try { S.srv = await api("/api/estado"); } catch { arrancando = false; return; }
  $("#btnClaude").disabled = !S.srv.claude; $("#btnClaude").title = S.srv.claude ? "" : S.estatico ? "No disponible en GitHub Pages (requiere servidor)" : "Configura ANTHROPIC_API_KEY";
  if (S.estatico) { $("#btnSalir").hidden = true; }
  await cargarEvidencia(); await cargarPlan(); cargarPatrones(); revisarCalidad();
  cargarSeries(simbolosEstrategia()).then(() => { evaluarEstrategia(); evaluarPlan(); }).catch((e) => showErr("Estrategia: " + e.message));
  const h = ls.get("tr_hist", []);
  if (h.length) S.rep = h[0]; else await cargarWorker(false);
  pintarHist(); render(); refrescar(); arrancando = false;
}
render();
detectarFirebase().then(async (fb) => { if (fb) return; await detectarEstatico(); arrancar(); });
}
