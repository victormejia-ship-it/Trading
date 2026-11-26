const test = require("node:test");
const assert = require("node:assert");
const M = require("../../public/engine.js");

function serie(cierres, inicio = "2024-01-01") {
  const t = [], d = new Date(inicio + "T12:00:00Z");
  while (t.length < cierres.length) { if (d.getUTCDay() % 6 !== 0) t.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return { t, o: cierres, h: cierres, l: cierres, c: cierres, v: cierres.map(() => 1) };
}

test("último día hábil del mes", () => {
  assert.equal(M.ultimoHabilDelMes("2026-11-30"), true);
  assert.equal(M.ultimoHabilDelMes("2026-11-27"), false);
  assert.equal(M.ultimoHabilDelMes("2026-10-30"), true);     // viernes 30; 31 es sábado
});

test("mensual: la venta solo se decide a fin de mes y se ejecuta después", () => {
  const sube = Array.from({ length: 260 }, (_, i) => 100 + i * 0.2);
  const s = serie([...sube, ...Array.from({ length: 40 }, (_, i) => 150 - i * 1.5)]);
  const r = M.regimen(s, "sma200_mensual");
  const cambios = r.estados.map((e, i) => (i && e !== r.estados[i - 1] ? s.t[i] : null)).filter(Boolean);
  assert.ok(cambios.length >= 1);
  for (const f of cambios) assert.ok(M.ultimoHabilDelMes(f) || f.slice(0, 7) !== s.t[s.t.indexOf(f) + 1]?.slice(0, 7));
  assert.equal(r.estado, "EFECTIVO");
});

test("señal VENDER el día de decisión cuando el cierre queda bajo la media", () => {
  const base = Array.from({ length: 300 }, (_, i) => 100 + i * 0.1);
  const s = serie(base, "2025-01-01");
  // forzar que la última vela sea fin de mes y cierre muy por debajo de la media
  s.t[s.t.length - 1] = "2026-11-30"; s.t[s.t.length - 2] = "2026-11-27"; s.c[s.c.length - 1] = 90;
  const r = M.regimen(s, "sma200_mensual");
  assert.equal(r.estado, "INVERTIDO"); assert.equal(r.hoy_decide, true); assert.equal(r.senal, "VENDER");
  assert.ok(r.distancia_pct < 0);
});
