# Validación en dos tramos: estrategia v2 (seguimiento de tendencia)

- Tramo 1 (ajuste): 2024-11-21 → 2025-11-24. Tramo 2 (validación, medido una sola vez): 2025-11-25 → 2026-11-25.
- 26 emisoras operables en GBM+ (13 SIC, 13 BMV), P&L en MXN, costos 0.34% por lado (comisión + IVA + deslizamiento).
- Combinación elegida en el tramo 1 (mejor MAR con ≥ 10 operaciones): **retroceso a EMA21 · stop 3×ATR · sin venta parcial**.

| | Tramo 1 (ajuste) | Tramo 2 (validación) |
|---|---|---|
| Estrategia elegida | +2.4% · caída máx. −13.6% · 85 ops · 41% ganadoras | **−8.4%** · caída máx. −15.9% · 93 ops · 39% ganadoras |
| Universo igual ponderado (comprar y mantener, MXN) | +19.5% · −14.2% | +17.2% · −7.4% |
| IPC | +24.6% · −7.6% | +12.9% · −11.5% |
| SPY en MXN | +3.9% · −20.2% | +12.8% · −8.8% |

Conclusión: **la estrategia no pasó la validación.** Las 8 combinaciones perdieron dinero en el tramo 2, y ninguna superó a comprar y mantener en ningún tramo.
Detalle por operación y curvas: `resultado.json`.
