"""Imprime un resumen legible de reports/backtest/resultado.json."""
import json, sys
r = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "reports/backtest/resultado.json"))
print("Periodo", r["periodo"], "| activos", r["activos"], "| sin datos", r["activos_sin_datos"])
print("Mercado: días ROJO", r.get("mercado_dias_rojo"), "tope medio", r.get("mercado_tope_medio"))
for k, desc in r["variantes"].items():
    m = r[k]["metricas"]
    print(f"\n[{k}] {desc}\n  " + " | ".join(f"{a}={b}" for a, b in m.items()))
    for t in r[k]["trades"][:40]:
        print("   ", t["ticker"], t["tipo"], t["entrada_fecha"], "->", t["salida_fecha"], t["salidas"], "R", t["r"], "ret%", t["ret_pct"])
print("\nBenchmarks:")
for k, v in r["benchmarks"].items():
    print(" ", k, v and {a: b for a, b in v.items() if a != "curva"})
print("\nEstados del motor:", r["estados_motor"])
print("Por activo:", r["por_activo"])
