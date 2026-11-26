// Calcula con el motor JS (public/engine.js) lo mismo que el Python, para comparar en tests/test_paridad.py.
// Uso: node tests/js/paridad.js <archivo.csv> [velas]
const fs = require("fs");
const M = require("../../public/engine.js");
const [archivo, velas = "400"] = process.argv.slice(2);
const rows = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).filter((r) => +r[4] > 0 && +r[2] >= +r[3]);
const R = rows.slice(-Number(velas));
const s = { t: R.map((r) => r[0].slice(0, 10)), o: R.map((r) => +r[1]), h: R.map((r) => +r[2]), l: R.map((r) => +r[3]), c: R.map((r) => +r[4]), v: R.map((r) => +r[5]) };
const full = { t: rows.map((r) => r[0].slice(0, 10)), o: rows.map((r) => +r[1]), h: rows.map((r) => +r[2]), l: rows.map((r) => +r[3]), c: rows.map((r) => +r[4]), v: rows.map((r) => +r[5]) };
const plan = M.analizar(s, "X");
const { P } = M.patronesVela(s);
console.log(JSON.stringify({
  fechas: s.t,
  regimen: M.regimen(full, "sma200_mensual").estados.join(""),
  patrones: Object.fromEntries(Object.entries(P).map(([k, a]) => [k, a.map(Number).join("")])),
  plan: { fase: plan.fase, orden: plan.orden, stop: plan.niveles.stop_loss, entrada: plan.niveles.entrada, r1: plan.niveles.resistencia_1, rr: plan.rr, rsi: plan.indicadores.RSI14, atr: plan.indicadores.ATR14 },
}));
