const test = require("node:test");
const assert = require("node:assert");
const { mensaje } = require("../../scripts/senales.js");

const fila = (nombre, simbolo, senal, estado, dist) => ({ p: { nombre, simbolo }, r: { senal, estado, distancia_pct: dist }, monto: 40000, titulos: 3 });

test("mensaje con venta confirmada indica ejecutar en la apertura", () => {
  const m = mensaje({ perfil: "moderado", capital: 100000, filas: [fila("S&P 500", "SPY", "VENDER", "INVERTIDO", -1.9), fila("IPC México", "NAFTRACISHRS.MX", "MANTENER", "INVERTIDO", 7)] }, true);
  assert.match(m.titulo, /CONFIRMADA: VENDER S&P 500/);
  assert.match(m.cuerpo, /apertura del próximo día hábil/);
  assert.equal(m.urgente, true);
});

test("sin cambios: no hay que hacer nada (o vigilar si está cerca)", () => {
  const a = mensaje({ perfil: "moderado", capital: 100000, filas: [fila("IPC México", "NAFTRACISHRS.MX", "MANTENER", "INVERTIDO", 7)] }, true);
  assert.match(a.titulo, /sin cambios/); assert.match(a.cuerpo, /No tienes que hacer nada/);
  const b = mensaje({ perfil: "moderado", capital: 100000, filas: [fila("S&P 500", "SPY", "MANTENER", "INVERTIDO", 0.8)] }, false);
  assert.match(b.cuerpo, /cerca de su media/);
});
