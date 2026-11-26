/* Motor determinista (port de trend_risk/engine.py + worker/features.py + worker/guardrails.py).
   Todo número que ve Claude o la pantalla sale de aquí. Sin dependencias. */
(function (root) {
  "use strict";
  const NaN_ = Number.NaN;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const rnd = (x, nd = 2) => (isNum(x) ? Math.round(x * 10 ** nd) / 10 ** nd : null);

  // ---------- indicadores (misma semántica que pandas: rolling con min_periods = n, ewm adjust=False)
  function sma(a, n) {
    const out = new Array(a.length).fill(NaN_); let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }
  function ewm(a, alpha, minP) {
    const out = new Array(a.length).fill(NaN_); let y = NaN_, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (!isNum(x)) { if (cnt >= minP) out[i] = y; continue; }
      y = cnt === 0 ? x : (1 - alpha) * y + alpha * x; cnt++;
      if (cnt >= minP) out[i] = y;
    }
    return out;
  }
  const ema = (a, n) => ewm(a, 2 / (n + 1), n);
  const wilder = (a, n) => ewm(a, 1 / n, n);
  function rsi(c, n = 14) {
    const up = [NaN_], dn = [NaN_];
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); }
    const u = wilder(up, n), w = wilder(dn, n);
    return u.map((x, i) => (!isNum(x) || !isNum(w[i]) ? NaN_ : w[i] === 0 ? 100 : 100 - 100 / (1 + x / w[i])));
  }
  function atr(h, l, c, n) {
    const tr = h.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    return wilder(tr, n);
  }
  function enrich(s) {
    const { o, h, l, c, v } = s;
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const line = e12.map((x, i) => x - e26[i]);
    const sig = ema(line, 9);
    return { t: s.t, o, h, l, c, v, sma20: sma(c, 20), sma50: sma(c, 50), sma200: sma(c, 200), ema21: ewm(c, 2 / 22, 1),
      rsi14: rsi(c, 14), macd: line, macd_sig: sig, macd_hist: line.map((x, i) => x - sig[i]),
      atr14: atr(h, l, c, 14), atr50: atr(h, l, c, 50), vol20: sma(v, 20) };
  }
  // pivotes: extremo de ventana centrada 2k+1 (completa) dentro del tramo dado
  function pivots(arr, k, kind) {
    const out = [];
    for (let i = k; i < arr.length - k; i++) {
      const w = arr.slice(i - k, i + k + 1);
      const ext = kind === "low" ? Math.min(...w) : Math.max(...w);
      if (arr[i] === ext) out.push(arr[i]);
    }
    return out;
  }
  const last = (a, n = 1) => a[a.length - n];
  const tail = (a, n) => a.slice(Math.max(0, a.length - n));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN_);

  const CFG = { riesgo: 0.01, rrMin: 2.0, atrNormal: 1.5, atrAlta: 2.0, umbralAltaVol: 0.035, extMax: 0.15,
    rsiExt: 72, rsiSobreventa: 35, volConf: 1.5, maxPos: 0.25, pivotK: 5 };

  function pasoRedondo(p) { const mag = 10 ** Math.floor(Math.log10(Math.max(p, 1e-9))); return p / mag < 3 ? mag / 2 : mag; }
  function evitarRedondo(stop, a, p) {
    const base = pasoRedondo(p);
    for (const paso of [base, base / 5, base / 10]) {
      const nivel = Math.round(stop / paso) * paso;
      if (Math.abs(stop - nivel) <= 0.15 * a) return nivel - 0.25 * a;
    }
    return stop;
  }
  function a100(vals) {
    let v = vals.map((x) => Math.max(0, x)); const s = v.reduce((x, y) => x + y, 0) || 3;
    if (!vals.some((x) => x > 0)) v = [1, 1, 1];
    const raw = v.map((x) => (x / s) * 100), ent = raw.map(Math.floor);
    const ord = raw.map((x, i) => [x - ent[i], i]).sort((a, b) => b[0] - a[0]);
    const resto = 100 - ent.reduce((x, y) => x + y, 0);
    for (let j = 0; j < resto; j++) ent[ord[j][1]]++;
    return ent;
  }
  function probabilidades(score, ext, cfg) {
    score = Math.max(-1, Math.min(1, score));
    let bull = 0.33 + 0.27 * score, bear = 0.33 - 0.27 * score;
    if (ext > cfg.extMax) { const ex = Math.min(0.15, ext - cfg.extMax); bull -= ex; bear += ex / 2; }
    bull = Math.max(0.05, bull); bear = Math.max(0.05, bear);
    const base = Math.max(0.1, 1 - bull - bear);
    return a100([bull, base, bear]);
  }
  const f2 = (x) => (isNum(x) ? x.toFixed(2) : "—");

  // ---------- plan por activo
  function analizar(s, ticker, cfgIn) {
    const cfg = Object.assign({}, CFG, cfgIn || {});
    if (s.c.length < 220) throw new Error(`${ticker}: se requieren >= 220 velas diarias (hay ${s.c.length}).`);
    const d = enrich(s);
    const c = last(d.c), A = last(d.atr14), s20 = last(d.sma20), s50 = last(d.sma50), s200 = last(d.sma200);
    const R = last(d.rsi14), hist = last(d.macd_hist), atrPct = A / c, ext50 = c / s50 - 1;
    const pend50 = s50 / last(d.sma50, 11) - 1, pend200 = s200 / last(d.sma200, 21) - 1;
    const cruce = hist > 0 && tail(d.macd_hist, 15).some((x) => x <= 0);
    const volOk = tail(d.v, 20).reduce((x, y) => x + y, 0) > 0;
    const volRatio = volOk && last(d.vol20) ? last(d.v) / last(d.vol20) : NaN_;
    let volVend = NaN_;
    if (volOk) {
      const cc = tail(d.c, 10), vv = tail(d.v, 10), dnv = [], upv = [];
      cc.forEach((x, i) => { const prev = i === 0 ? cc[0] : cc[i - 1]; (x < prev ? dnv : upv).push(vv[i]); });
      const dn = mean(dnv), up = mean(upv);
      volVend = up && isNum(dn) ? dn / up : NaN_;
    }
    const hi20 = Math.max(...tail(d.h, 20)), lo20 = Math.min(...tail(d.l, 20));
    const contr = last(d.atr50) ? last(d.atr14) / last(d.atr50) < 0.9 : false;
    const rsiMin = Math.min(...tail(d.rsi14, 30).filter(isNum));
    const dd = c / Math.max(...tail(d.c, 120)) - 1;

    let fase; const ev = [];
    if (c > s50 && (ext50 > cfg.extMax || R > cfg.rsiExt)) {
      fase = "TENDENCIA_EXTENDIDA"; ev.push(`Precio ${(ext50 * 100).toFixed(1)}% vs SMA50 (umbral +15%); RSI ${R.toFixed(1)} (umbral 72).`);
    } else if ((c < s50 && c < s200) || (c < s50 && volVend > 1.2)) {
      fase = "DISTRIBUCION_O_BAJISTA";
      if (c < s50 && c < s200) ev.push("Precio por debajo de SMA50 y SMA200.");
      if (volVend > 1.2) ev.push(`Volumen en días bajistas ${volVend.toFixed(2)}x el de días alcistas (10 sesiones).`);
    } else if (c > s50 && c > s200 && pend50 > 0 && hist > 0) {
      fase = "TENDENCIA_ALCISTA_TEMPRANA"; ev.push(`Precio > SMA50 y SMA200; pendiente SMA50 ${(pend50 * 100).toFixed(2)}% (10 ses.); MACD hist ${hist.toFixed(3)}${cruce ? " (cruce alcista reciente)" : ""}.`);
    } else if ((dd < -0.12 || c < s200) && contr && rsiMin < cfg.rsiSobreventa && R > cfg.rsiSobreventa) {
      fase = "ACUMULACION"; ev.push(`Drawdown ${(dd * 100).toFixed(1)}% desde máx. 6m; ATR14/ATR50 ${(last(d.atr14) / last(d.atr50)).toFixed(2)}; RSI salió de ${rsiMin.toFixed(1)} a ${R.toFixed(1)}.`);
    } else { fase = "TRANSICION_SIN_FASE_CLARA"; ev.push("No cumple de forma completa ningún patrón de fase; se trata como transición."); }

    const lows = pivots(tail(d.l, 120), cfg.pivotK, "low"), highs = pivots(tail(d.h, 252), cfg.pivotK, "high");
    let entrada, soporte;
    if (fase === "ACUMULACION") { entrada = hi20 + 0.1 * A; soporte = lo20; }
    else if (fase === "TENDENCIA_ALCISTA_TEMPRANA") {
      entrada = c > s20 + 0.5 * A ? s20 : c;
      const cand = lows.filter((x) => x < entrada);
      soporte = cand.length ? last(cand) : Math.min(s50, entrada - 2 * A);
      soporte = Math.min(soporte, entrada - 0.5 * A);
    } else { entrada = c; const cand = lows.filter((x) => x < c); soporte = cand.length ? last(cand) : lo20; }
    const mult = atrPct > cfg.umbralAltaVol ? cfg.atrAlta : cfg.atrNormal;
    const stop = evitarRedondo(soporte - mult * A, A, c);
    const dist = (entrada - stop) / entrada;
    const resC = highs.filter((x) => x > Math.max(entrada, c) * 1.005);
    let r1, r1o, r2;
    if (resC.length) { r1 = Math.min(...resC); r1o = "máximo de pivote (12 meses)"; const may = resC.filter((x) => x > r1 + A); r2 = may.length ? Math.min(...may) : r1 + 2 * A; }
    else { r1 = entrada + 3 * A; r1o = "proyección 3xATR (sin resistencia previa: zona de máximos)"; r2 = entrada + 5 * A; }
    const rr = entrada > stop ? (r1 - entrada) / (entrada - stop) : null;
    let sizeF = dist > 0 ? cfg.riesgo / dist : null, size = sizeF ? Math.min(sizeF, cfg.maxPos) : null;
    const trailing = Math.max(s20, Math.max(...tail(d.h, 22)) - 2 * A);

    const alertas = [], rrOk = rr !== null && rr >= cfg.rrMin;
    const ses = Math.min(20, Math.max(5, Math.round(1.5 * (r1 - entrada) / A)));
    let salida = [`TP escalonado: vender 50% en Objetivo 1 = ${f2(r1)}.`, `50% restante con Trailing Stop en SMA20 (hoy ${f2(s20)}); salir con cierre diario por debajo.`, `Stop Loss duro: ${f2(stop)}.`];
    let invalid = `Si en ${ses} sesiones el precio no supera ${f2(r1)}, cerrar por costo de oportunidad.`, sesiones = ses;
    let orden, horizonte, gatillo;
    if (fase === "TENDENCIA_EXTENDIDA") {
      orden = "TOMA_PARCIAL_GANANCIAS"; horizonte = "INTRADIA_SWING_CORTO";
      gatillo = "PROHIBIDO comprar. Nueva entrada solo tras retroceso a SMA20 con RSI < 60 y R:R >= 2.";
      salida = [`Vender 33% ahora / 33% si RSI diario > 78 o precio > SMA50 x1.20 (${f2(s50 * 1.2)}).`, `Resto con Trailing Stop = max(SMA20, máx.22 - 2xATR) = ${f2(trailing)}; salir con cierre diario por debajo.`];
      invalid = "Si en 5 sesiones no hace nuevo máximo, subir el trailing a SMA20 estricto."; sesiones = 5; size = sizeF = null;
    } else if (fase === "DISTRIBUCION_O_BAJISTA") {
      orden = c < s50 ? "VENDER_CERRAR_POSICIONES" : "NO_OPERAR"; horizonte = "INTRADIA_SWING_CORTO";
      gatillo = `Sin compras. Re-evaluar solo con cierre diario > SMA50 (${f2(s50)}) y SMA50 con pendiente positiva.`;
      salida = [`Cerrar posiciones largas; si se escalona, todo fuera con cierre < ${f2(stop)}.`]; invalid = "N/A: fase defensiva."; sesiones = 5; size = sizeF = null;
    } else if (fase === "ACUMULACION") {
      horizonte = "POSICIONAL"; sesiones = Math.max(ses, 10);
      gatillo = `Cierre DIARIO > ${f2(entrada)} (máx. rango 20 ses. + 0.1xATR) con volumen > 1.5x media 20 (${Math.round((last(d.vol20) || 0) * 1.5).toLocaleString("es-MX")}).`;
      orden = rrOk ? "ESPERAR_MEJOR_TIMING" : "NO_OPERAR"; alertas.push("Orden condicional: la entrada solo existe si se confirma la ruptura con volumen.");
      invalid = `Si en ${sesiones} sesiones tras la ruptura no supera ${f2(r1)}, cerrar; si vuelve al rango y cierra < ${f2(lo20)}, salida inmediata.`;
    } else if (fase === "TENDENCIA_ALCISTA_TEMPRANA") {
      horizonte = "SWING_MEDIO";
      gatillo = `Orden límite en zona SMA20 ${f2(entrada)} (±0.25xATR = ${f2(entrada - 0.25 * A)}-${f2(entrada + 0.25 * A)}); confirmar con cierre diario que respete la SMA20.`;
      orden = rrOk ? "COMPRAR_EN_RETROCESO" : "ESPERAR_MEJOR_TIMING";
    } else {
      horizonte = "SWING_MEDIO"; gatillo = `Esperar definición: cierre > SMA50 (${f2(s50)}) con MACD > señal, o pérdida de SMA200 (${f2(s200)}).`;
      orden = c > s200 ? "ESPERAR_MEJOR_TIMING" : "NO_OPERAR";
    }
    if (["ACUMULACION", "TENDENCIA_ALCISTA_TEMPRANA", "TRANSICION_SIN_FASE_CLARA"].includes(fase) && !rrOk) {
      const eReq = (r1 + cfg.rrMin * stop) / (1 + cfg.rrMin);
      alertas.push(`Filtro de asimetría: R:R ${rr === null ? "—" : rr.toFixed(2)} < 1:2 → no se ejecuta. La entrada debería ser <= ${f2(eReq)} (o esperar ruptura de ${f2(r1)}).`);
    }
    if (sizeF && sizeF > cfg.maxPos) alertas.push(`Fórmula 1%/dist = ${(sizeF * 100).toFixed(1)}%; recortada al tope de ${(cfg.maxPos * 100).toFixed(0)}%.`);
    if (r1o.startsWith("proyección")) alertas.push("Activo en máximos: Objetivo 1 es proyección por volatilidad, no resistencia observada.");

    const sign = Math.sign;
    const score = 0.3 * sign(c - s50) + 0.2 * sign(c - s200) + 0.15 * sign(pend50) + 0.15 * sign(hist) + 0.1 * ((R - 50) / 50);
    const [pb, pn, pd] = probabilidades(score, ext50, cfg);
    let senal;
    if (orden === "ESPERAR_MEJOR_TIMING") senal = fase === "ACUMULACION" ? "ESPERAR_RUPTURA" : "ESPERAR_SOPORTE";
    else senal = { COMPRAR_EN_RETROCESO: "COMPRAR", TOMA_PARCIAL_GANANCIAS: "VENDER_TOMA_GANANCIAS", VENDER_CERRAR_POSICIONES: "VENDER_CERRAR" }[orden] || "NO_COMPRAR";

    const N = s.c.length;
    return {
      ticker, fecha: last(s.t), precio: rnd(c), fase, evidencia_fase: ev, orden, senal_motor: senal, horizonte,
      indicadores: { SMA20: rnd(s20), SMA50: rnd(s50), SMA200: rnd(s200), RSI14: rnd(R, 1), MACD: rnd(last(d.macd), 4), MACD_senal: rnd(last(d.macd_sig), 4),
        MACD_hist: rnd(hist, 4), ATR14: rnd(A), "ATR%": rnd(atrPct * 100), "Ext_vs_SMA50_%": rnd(ext50 * 100), "Pend_SMA50_10s_%": rnd(pend50 * 100),
        "Pend_SMA200_20s_%": rnd(pend200 * 100), "Vol/Vol20": rnd(volRatio), Vol_vendedor_ratio: rnd(volVend), Mult_ATR_stop: mult },
      niveles: { precio: rnd(c), entrada: rnd(entrada), soporte: rnd(soporte), stop_loss: rnd(stop), resistencia_1: rnd(r1), objetivo_2: rnd(r2),
        trailing_stop: rnd(trailing), sma20: rnd(s20), sma50: rnd(s50), sma200: rnd(s200) },
      resistencia_1_origen: r1o, distancia_stop_pct: rnd(dist * 100), tamano_posicion_pct: size ? rnd(size * 100) : null,
      tamano_posicion_formula_pct: sizeF ? rnd(sizeF * 100) : null, rr: rnd(rr), gatillo_compra: gatillo, gatillo_salida: salida,
      invalidacion_temporal: invalid, invalidacion_sesiones: sesiones, alertas,
      escenarios_heuristicos: { alcista: pb, lateral: pn, bajista: pd },
      contexto: { "ret_5d_%": rnd((c / last(d.c, 6) - 1) * 100), "ret_20d_%": rnd((c / last(d.c, 21) - 1) * 100), "ret_60d_%": rnd((c / last(d.c, 61) - 1) * 100),
        max_52s: rnd(Math.max(...tail(d.h, 252))), min_52s: rnd(Math.min(...tail(d.l, 252))),
        ultimas_10_velas: tail(s.t, 10).map((t, i) => { const j = N - 10 + i; return { t, o: rnd(s.o[j]), h: rnd(s.h[j]), l: rnd(s.l[j]), c: rnd(s.c[j]), v: Math.round(s.v[j]) }; }) },
      _serie: d,
    };
  }

  // ---------- estado de mercado + topes duros
  function mercado(series, indices, activos) {
    const filas = {};
    for (const t of indices) {
      const s = series[t]; if (!s || s.c.length < 220) continue;
      const e = enrich(s), c = last(e.c);
      filas[t] = { precio: rnd(c), sma50: rnd(last(e.sma50)), sma200: rnd(last(e.sma200)), rsi14: rnd(last(e.rsi14), 1),
        sobre_sma50: c > last(e.sma50), sobre_sma200: c > last(e.sma200), "dist_sma200_%": rnd((c / last(e.sma200) - 1) * 100),
        "ret_5d_%": rnd((c / last(e.c, 6) - 1) * 100), "ret_20d_%": rnd((c / last(e.c, 21) - 1) * 100),
        "atr_%": rnd((last(e.atr14) / c) * 100), macd_hist: rnd(last(e.macd_hist), 4) };
    }
    const univ = [...activos, ...indices].filter((t) => series[t] && series[t].c.length >= 220 && !t.startsWith("^") && !t.includes("=") && t !== "VIX");
    const sobre = univ.map((t) => { const e = enrich(series[t]); return last(e.c) > last(e.sma50); });
    const amplitud = sobre.length ? rnd((100 * sobre.filter(Boolean).length) / sobre.length, 1) : null;
    let tope = 100; const razones = [];
    const spy = filas.SPY, vix = filas["^VIX"] || filas.VIX;
    if (spy && !spy.sobre_sma200) { tope = Math.min(tope, 30); razones.push("SPY bajo SMA200 → exposición máx. 30%"); }
    else if (spy && !spy.sobre_sma50) { tope = Math.min(tope, 60); razones.push("SPY bajo SMA50 → exposición máx. 60%"); }
    if (vix) {
      if (vix.precio > 30) { tope = Math.min(tope, 25); razones.push("VIX > 30 → exposición máx. 25%"); }
      else if (vix.precio > 20) { tope = Math.min(tope, 60); razones.push("VIX > 20 → exposición máx. 60%"); }
    }
    if (amplitud !== null && amplitud < 40) { tope = Math.min(tope, 50); razones.push(`Amplitud ${amplitud}% < 40% → exposición máx. 50%`); }
    return { indices: filas, "amplitud_sobre_sma50_%": amplitud, tope_exposicion_pct: tope, razones_tope: razones,
      verde_permitido: !!(spy && spy.sobre_sma200 && (!vix || vix.precio <= 25)), rojo_forzado: !!(spy && !spy.sobre_sma200 && vix && vix.precio > 30),
      falta_spy: !spy };
  }

  // ---------- guardrails post-LLM
  const ENUM = {
    semaforo: ["VERDE_COMPRAR", "AMARILLO_CAUTELA", "ROJO_NO_COMPRAR"], regimen: ["RISK_ON", "NEUTRAL", "RISK_OFF"],
    fase: ["ACUMULACION", "TENDENCIA_ALCISTA_TEMPRANA", "TENDENCIA_EXTENDIDA", "DISTRIBUCION_O_BAJISTA", "TRANSICION_SIN_FASE_CLARA"],
    senal: ["COMPRAR", "ESPERAR_SOPORTE", "ESPERAR_RUPTURA", "VENDER_TOMA_GANANCIAS", "VENDER_CERRAR", "NO_COMPRAR"],
    horizonte: ["INTRADIA_SWING_CORTO", "SWING_MEDIO", "POSICIONAL"], ajuste: ["COMPLETO", "MEDIO", "CUARTO", "CERO"],
    confianza: ["BAJA", "MEDIA", "ALTA"], impacto: ["POSITIVO", "NEGATIVO", "NEUTRAL"],
    nivel: ["precio", "entrada", "soporte", "stop_loss", "resistencia_1", "objetivo_2", "trailing_stop", "sma20", "sma50", "sma200"],
  };
  const str = (x, max = 1200) => (typeof x === "string" ? x.slice(0, max) : "");
  const arrStr = (x, n = 8) => (Array.isArray(x) ? x.filter((y) => typeof y === "string").slice(0, n).map((y) => y.slice(0, 400)) : []);
  const pick = (x, list, def) => (list.includes(x) ? x : def);

  function validarMercado(llm, m) {
    const corr = [], o = llm && typeof llm === "object" ? llm : {};
    let sem = pick(o.semaforo, ENUM.semaforo, null);
    if (!sem) { corr.push("Semáforo inválido o ausente → AMARILLO_CAUTELA"); sem = "AMARILLO_CAUTELA"; }
    let exp = Number.isFinite(+o.exposicion_maxima_pct) ? Math.round(+o.exposicion_maxima_pct) : 0;
    if (exp > m.tope_exposicion_pct || exp < 0) { const n = Math.min(Math.max(exp, 0), m.tope_exposicion_pct); corr.push(`Exposición ${exp}% fuera de [0, ${m.tope_exposicion_pct}] (tope duro) → ${n}%`); exp = n; }
    if (sem === "VERDE_COMPRAR" && !m.verde_permitido) { corr.push("VERDE no permitido por reglas duras (SPY<SMA200 o VIX>25) → AMARILLO_CAUTELA"); sem = "AMARILLO_CAUTELA"; }
    if (m.rojo_forzado && sem !== "ROJO_NO_COMPRAR") { corr.push("Reglas duras fuerzan ROJO (SPY<SMA200 y VIX>30)"); sem = "ROJO_NO_COMPRAR"; }
    if (sem === "ROJO_NO_COMPRAR") exp = Math.min(exp, 25);
    let regimen = pick(o.regimen, ENUM.regimen, "NEUTRAL");
    if (sem === "ROJO_NO_COMPRAR" && regimen !== "RISK_OFF") { corr.push(`Régimen ${regimen} incoherente con ROJO → RISK_OFF`); regimen = "RISK_OFF"; }
    if (sem === "AMARILLO_CAUTELA" && regimen === "RISK_ON") { corr.push("Régimen RISK_ON incoherente con AMARILLO → NEUTRAL"); regimen = "NEUTRAL"; }
    const drivers = (Array.isArray(o.drivers) ? o.drivers : []).slice(0, 10).map((d) => ({ factor: str(d?.factor, 120), lectura: str(d?.lectura, 400), impacto: pick(d?.impacto, ENUM.impacto, "NEUTRAL"), dato_citado: str(d?.dato_citado, 200) }));
    return { semaforo: sem, regimen, exposicion_maxima_pct: exp, resumen: str(o.resumen, 1500), drivers,
      noticias_clave: (Array.isArray(o.noticias_clave) ? o.noticias_clave : []).slice(0, 10).map((n) => ({ news_id: str(n?.news_id, 40), impacto: pick(n?.impacto, ENUM.impacto, "NEUTRAL"), por_que_importa: str(n?.por_que_importa, 400) })),
      riesgos_macro: arrStr(o.riesgos_macro), contra_tesis: str(o.contra_tesis, 1200) || "Sin contra-tesis.", que_cambiaria_la_lectura: arrStr(o.que_cambiaria_la_lectura),
      confianza: pick(o.confianza, ENUM.confianza, "BAJA"), datos_faltantes: arrStr(o.datos_faltantes), correcciones_guardrail: corr };
  }

  function validarActivo(llm, p, est, idsNoticias) {
    const corr = [], o = llm && typeof llm === "object" ? llm : {};
    const out = { ticker: p.ticker, fase: pick(o.fase, ENUM.fase, p.fase), coincide_con_motor: o.fase === p.fase,
      discrepancia_fase: str(o.discrepancia_fase, 600), horizonte: pick(o.horizonte, ENUM.horizonte, p.horizonte),
      gatillo_compra: str(o.gatillo_compra) || p.gatillo_compra, gatillo_venta: str(o.gatillo_venta) || p.gatillo_salida.join(" "),
      invalidacion_temporal_texto: str(o.invalidacion_temporal_texto) || p.invalidacion_temporal, contra_tesis: str(o.contra_tesis, 1500),
      riesgos_invalidacion: arrStr(o.riesgos_invalidacion), razon_ajuste: str(o.razon_ajuste, 400),
      confianza: pick(o.confianza, ENUM.confianza, "BAJA"), datos_faltantes: arrStr(o.datos_faltantes) };
    // 1) escenarios: suman 100, niveles solo del motor
    const E = o.escenarios || {}, nom = ["alcista", "lateral", "bajista"];
    let probs = nom.map((k) => Math.round(+E[k]?.probabilidad || 0));
    if (probs.reduce((a, b) => a + b, 0) !== 100 || probs.some((x) => x < 0)) { const nv = a100(probs); corr.push(`Probabilidades [${probs}] no sumaban 100 → [${nv}]`); probs = nv; }
    const defRef = { alcista: "resistencia_1", lateral: "precio", bajista: "stop_loss" };
    out.escenarios = {};
    nom.forEach((k, i) => { const ref = pick(E[k]?.nivel_ref, ENUM.nivel, defRef[k]); out.escenarios[k] = { probabilidad: probs[i], nivel_ref: ref, nivel: p.niveles[ref], tesis: str(E[k]?.tesis, 600) }; });
    // 2) compra
    let senal = pick(o.senal, ENUM.senal, p.senal_motor);
    if (senal === "COMPRAR") {
      const mot = [];
      if (p.rr === null || p.rr < 2) mot.push(`R:R motor ${p.rr} < 2.0`);
      if (["TENDENCIA_EXTENDIDA", "DISTRIBUCION_O_BAJISTA"].includes(p.fase)) mot.push(`fase ${p.fase} prohíbe comprar`);
      if (est.semaforo === "ROJO_NO_COMPRAR") mot.push("semáforo ROJO");
      if (p.senal_motor !== "COMPRAR") mot.push(`motor determinista dice ${p.senal_motor}`);
      if (mot.length) { const nv = p.senal_motor !== "COMPRAR" ? p.senal_motor : "ESPERAR_SOPORTE"; corr.push(`COMPRAR bloqueado (${mot.join("; ")}) → ${nv}`); senal = nv; }
    }
    if (!out.contra_tesis.trim()) { corr.push("Contra-tesis vacía: se bloquea cualquier compra"); out.contra_tesis = "Sin contra-tesis."; if (senal === "COMPRAR") senal = "NO_COMPRAR"; }
    out.senal = senal;
    // 3) tamaño: el LLM solo reduce; el mercado escala
    const ajuste = pick(o.ajuste_tamano, ENUM.ajuste, "CERO"), fL = { COMPLETO: 1, MEDIO: 0.5, CUARTO: 0.25, CERO: 0 }[ajuste];
    const fM = (est.exposicion_maxima_pct || 0) / 100, base = p.tamano_posicion_pct || 0;
    out.ajuste_tamano = ajuste;
    out.tamano_posicion_final_pct = senal === "COMPRAR" ? rnd(base * fL * fM) : 0;
    out.tamano_calculo = `${base}% (1%/dist. stop ${p.distancia_stop_pct}%) × ${fL} (ajuste) × ${fM.toFixed(2)} (exposición mercado)`;
    // 4) sesiones y noticias
    let ses = Math.round(+o.invalidacion_temporal_sesiones || p.invalidacion_sesiones);
    if (ses < 3 || ses > 30) { corr.push(`Invalidación temporal ${ses} sesiones fuera de [3,30]`); ses = Math.min(30, Math.max(3, ses)); }
    out.invalidacion_temporal_sesiones = ses;
    const rel = (Array.isArray(o.noticias_relevantes) ? o.noticias_relevantes : []).map((n) => ({ news_id: str(n?.news_id, 40), sentimiento: pick(n?.sentimiento, ENUM.impacto, "NEUTRAL"), impacto: str(n?.impacto, 400) }));
    const malas = rel.filter((n) => !idsNoticias.has(n.news_id)).map((n) => n.news_id);
    if (malas.length) corr.push(`Noticias citadas inexistentes eliminadas: ${malas.join(", ")}`);
    out.noticias_relevantes = rel.filter((n) => idsNoticias.has(n.news_id));
    let sent = Math.max(-1, Math.min(1, +o.sentimiento_noticias || 0));
    if (!out.noticias_relevantes.length && sent !== 0) { corr.push("Sentimiento sin noticias citadas → 0"); sent = 0; }
    out.sentimiento_noticias = sent;
    out.correcciones_guardrail = corr;
    return out;
  }

  function fallbackMercado(m) {
    const t = m.tope_exposicion_pct, sem = m.rojo_forzado ? "ROJO_NO_COMPRAR" : m.verde_permitido && t >= 80 ? "VERDE_COMPRAR" : "AMARILLO_CAUTELA";
    return { semaforo: sem, regimen: { VERDE_COMPRAR: "RISK_ON", AMARILLO_CAUTELA: "NEUTRAL", ROJO_NO_COMPRAR: "RISK_OFF" }[sem], exposicion_maxima_pct: t,
      resumen: "Modo determinista (sin Claude): semáforo por reglas duras.", drivers: m.razones_tope.map((r) => ({ factor: "Regla dura", lectura: r, impacto: "NEGATIVO", dato_citado: r })),
      noticias_clave: [], riesgos_macro: [], contra_tesis: "No evaluada sin Claude.", que_cambiaria_la_lectura: [], confianza: "BAJA", datos_faltantes: ["lectura de noticias"], correcciones_guardrail: [], fuente: "MOTOR_DETERMINISTA" };
  }
  function fallbackActivo(p, est) {
    const e = p.escenarios_heuristicos;
    const o = validarActivo({ fase: p.fase, senal: p.senal_motor, horizonte: p.horizonte,
      escenarios: { alcista: { probabilidad: e.alcista, nivel_ref: "resistencia_1", tesis: "Continuación hacia la primera resistencia." },
        lateral: { probabilidad: e.lateral, nivel_ref: "precio", tesis: "Consolidación alrededor del precio actual (±1.5×ATR)." },
        bajista: { probabilidad: e.bajista, nivel_ref: "stop_loss", tesis: "Pérdida del soporte estructural; se activa el stop." } },
      invalidacion_temporal_sesiones: p.invalidacion_sesiones, contra_tesis: `Cierre bajo soporte ${f2(p.niveles.soporte)} activa stop ${f2(p.niveles.stop_loss)}.`,
      riesgos_invalidacion: [], ajuste_tamano: "COMPLETO", razon_ajuste: "Sin Claude.", confianza: "BAJA", datos_faltantes: ["lectura de noticias"] }, p, est, new Set());
    o.fuente = "MOTOR_DETERMINISTA"; return o;
  }

  // ---------- filtro de régimen (estrategia validada a 20 años: backtest/cartera_nucleo.py)
  // regla "sma200_mensual": se decide SOLO al cierre del último día hábil del mes; "sma200_banda": diario con banda ±2%.
  function esFinDeMes(fechas, i) { return i === fechas.length - 1 ? null : fechas[i].slice(0, 7) !== fechas[i + 1].slice(0, 7); }
  function ultimoHabilDelMes(fecha) {   // aproximación sin feriados: el siguiente día hábil cae en otro mes
    const d = new Date(fecha + "T12:00:00Z"); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 7) !== fecha.slice(0, 7);
  }
  function regimen(s, regla = "sma200_mensual", banda = 0.02) {
    const c = s.c, n = c.length, m200 = sma(c, 200);
    const estados = new Array(n).fill(1);
    let est = 1;
    for (let i = 0; i < n; i++) {
      if (isNum(m200[i])) {
        if (regla === "sma200_mensual") { if (esFinDeMes(s.t, i)) est = c[i] > m200[i] ? 1 : 0; }
        else if (regla === "sma200_banda") { if (est === 1 && c[i] < m200[i] * (1 - banda)) est = 0; else if (est === 0 && c[i] > m200[i] * (1 + banda)) est = 1; }
      }
      estados[i] = est;
    }
    const i = n - 1, S = m200[i], estado = estados[n - 2] ?? 1;   // posición vigente antes de evaluar la última vela
    let decision = estado, umbral;
    const hoyEsDecision = regla === "sma200_banda" || ultimoHabilDelMes(s.t[i]);
    if (regla === "sma200_mensual") { umbral = S; if (hoyEsDecision && isNum(S)) decision = c[i] > S ? 1 : 0; }
    else { umbral = estado === 1 ? S * (1 - banda) : S * (1 + banda); if (isNum(S)) decision = estados[i]; }
    // fecha del último cambio
    let ultimoCambio = null; for (let j = n - 1; j > 0; j--) if (estados[j] !== estados[j - 1]) { ultimoCambio = s.t[j]; break; }
    return { regla, fecha: s.t[i], precio: rnd(c[i], 4), sma200: rnd(S, 4), umbral: rnd(umbral, 4), estado: estado ? "INVERTIDO" : "EFECTIVO",
      senal: decision === estado ? "MANTENER" : decision === 1 ? "COMPRAR" : "VENDER", hoy_decide: hoyEsDecision,
      distancia_pct: isNum(umbral) ? rnd((c[i] / umbral - 1) * 100) : null, ultimo_cambio: ultimoCambio, estados };
  }

  // ---------- patrones de velas y estrategias de traders (port exacto de backtest/patrones.py: detectar)
  function rollMin(a, n) { return a.map((_, i) => (i < n - 1 ? NaN_ : Math.min(...a.slice(i - n + 1, i + 1)))); }
  function rollMax(a, n) { return a.map((_, i) => (i < n - 1 ? NaN_ : Math.max(...a.slice(i - n + 1, i + 1)))); }
  const sh = (a, k) => a.map((_, i) => (i - k >= 0 && i - k < a.length ? a[i - k] : NaN_));
  function patronesVela(s) {
    const { o, h, l, c, v } = s, N = c.length;
    const cuerpo = c.map((x, i) => x - o[i]), acu = cuerpo.map(Math.abs), rango = h.map((x, i) => (x - l[i]) || NaN_);
    const sup = h.map((x, i) => x - Math.max(o[i], c[i])), inf = l.map((x, i) => Math.min(o[i], c[i]) - x);
    const tr = h.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const atr = wilder(tr, 14), c5 = sh(c, 5), c1 = sh(c, 1), o1 = sh(o, 1), o2 = sh(o, 2), c2 = sh(c, 2), c7 = sh(c, 7);
    const sma50 = sma(c, 50), sma150 = sma(c, 150), sma200 = sma(c, 200), ema20 = ewm(c, 2 / 21, 1);
    const cu1 = sh(cuerpo, 1), cu2 = sh(cuerpo, 2), ac1 = sh(acu, 1), ac2 = sh(acu, 2), at1 = sh(atr, 1), at2 = sh(atr, 2);
    const up = h.map((x, i) => (i ? x - h[i - 1] : NaN_)), dn = l.map((x, i) => (i ? l[i - 1] - x : NaN_));
    const pdm = up.map((u, i) => (u > dn[i] && u > 0 ? u : 0)), ndm = dn.map((d, i) => (d > up[i] && d > 0 ? d : 0));
    const atr14 = wilder(tr, 14), pdi = wilder(pdm, 14).map((x, i) => 100 * x / atr14[i]), ndi = wilder(ndm, 14).map((x, i) => 100 * x / atr14[i]);
    const dx = pdi.map((x, i) => { const sm = x + ndi[i]; return sm ? 100 * Math.abs(x - ndi[i]) / sm : NaN_; });
    const adx = wilder(dx, 14), r2 = rsi(c, 2), vol20 = sma(v, 20), vol50 = sma(v, 50);
    const rngs = h.map((x, i) => x - l[i]), rng7 = rollMin(rngs, 7), minL20 = sh(rollMin(l, 20), 1), maxH252 = sh(rollMax(h, 252), 1);
    const P = {}; const k = Object.keys(PAT_INFO); k.forEach((x) => (P[x] = new Array(N).fill(false)));
    for (let i = 0; i < N; i++) {
      const cae = c[i] < c5[i], sube = c[i] > c5[i], m1 = (o1[i] + c1[i]) / 2, m2 = (o2[i] + c2[i]) / 2;
      const largo1 = ac1[i] > 0.6 * at1[i], largo2 = ac2[i] > 0.6 * at2[i], peq1 = ac1[i] < 0.3 * ac2[i];
      P.martillo[i] = acu[i] > 0 && inf[i] >= 2 * acu[i] && sup[i] <= 0.1 * rango[i] && cae;
      P.estrella_fugaz[i] = acu[i] > 0 && sup[i] >= 2 * acu[i] && inf[i] <= 0.1 * rango[i] && sube;
      P.envolvente_alcista[i] = cu1[i] < 0 && cuerpo[i] > 0 && o[i] <= c1[i] && c[i] >= o1[i] && acu[i] > ac1[i] && cae;
      P.envolvente_bajista[i] = cu1[i] > 0 && cuerpo[i] < 0 && o[i] >= c1[i] && c[i] <= o1[i] && acu[i] > ac1[i] && sube;
      P.estrella_manana[i] = cu2[i] < 0 && largo2 && peq1 && cuerpo[i] > 0 && c[i] > m2 && c2[i] < c7[i];
      P.estrella_tarde[i] = cu2[i] > 0 && largo2 && peq1 && cuerpo[i] < 0 && c[i] < m2 && c2[i] > c7[i];
      P.linea_penetrante[i] = cu1[i] < 0 && largo1 && o[i] < c1[i] && c[i] > m1 && c[i] < o1[i] && cae;
      P.nube_oscura[i] = cu1[i] > 0 && largo1 && o[i] > c1[i] && c[i] < m1 && c[i] > o1[i] && sube;
      const s3 = cuerpo[i] > 0 && cu1[i] > 0 && cu2[i] > 0 && c[i] > c1[i] && c1[i] > c2[i];
      P.tres_soldados[i] = s3 && sup[i] <= 0.25 * acu[i] && sup[i - 1] <= 0.25 * ac1[i] && o[i] > o1[i] && o1[i] > o2[i] && acu[i] > 0.5 * atr[i];
      const b3 = cuerpo[i] < 0 && cu1[i] < 0 && cu2[i] < 0 && c[i] < c1[i] && c1[i] < c2[i];
      P.tres_cuervos[i] = b3 && inf[i] <= 0.25 * acu[i] && inf[i - 1] <= 0.25 * ac1[i] && o[i] < o1[i] && o1[i] < o2[i] && acu[i] > 0.5 * atr[i];
      P.inside_ruptura[i] = i >= 2 && h[i - 1] < h[i - 2] && l[i - 1] > l[i - 2] && c[i] > h[i - 2] && c[i] > sma50[i];
      P.nr7_ruptura[i] = i >= 1 && rngs[i - 1] <= rng7[i - 1] && c[i] > h[i - 1];
      P.holy_grail[i] = adx[i] > 30 && pdi[i] > ndi[i] && l[i] <= ema20[i] && c[i] > ema20[i];
      P.rsi2_connors[i] = c[i] > sma200[i] && r2[i] < 10;
      P.spring_wyckoff[i] = l[i] < minL20[i] && c[i] > minL20[i] && v[i] > vol20[i];
      P.oops_williams[i] = i >= 1 && o[i] < l[i - 1] && c[i] > l[i - 1];
      P.ruptura_52s[i] = c[i] >= maxH252[i] && sma50[i] > sma150[i] && sma150[i] > sma200[i] && v[i] >= 1.4 * vol50[i];
    }
    return { P, sobre200: c.map((x, i) => x > sma200[i]), atr };
  }
  const PAT_INFO = { martillo: 1, estrella_fugaz: 1, envolvente_alcista: 1, envolvente_bajista: 1, estrella_manana: 1, estrella_tarde: 1, linea_penetrante: 1,
    nube_oscura: 1, tres_soldados: 1, tres_cuervos: 1, inside_ruptura: 1, nr7_ruptura: 1, holy_grail: 1, rsi2_connors: 1, spring_wyckoff: 1, oops_williams: 1, ruptura_52s: 1 };
  // Patrones presentes en las últimas `dias` velas: [{clave, fecha, hace}]
  function patronesRecientes(s, dias = 3) {
    const { P, sobre200 } = patronesVela(s), N = s.c.length, out = [];
    for (const k of Object.keys(P)) for (let j = N - 1; j >= Math.max(0, N - dias); j--) if (P[k][j]) { out.push({ clave: k, fecha: s.t[j], hace: N - 1 - j }); break; }
    return { lista: out, sobre200: sobre200[N - 1] };
  }

  const api = { enrich, analizar, mercado, validarMercado, validarActivo, fallbackMercado, fallbackActivo, a100, ENUM, CFG, regimen, ultimoHabilDelMes, patronesVela, patronesRecientes };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Motor = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
