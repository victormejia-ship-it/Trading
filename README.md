# Trading — Motor CRO de Riesgo + Trend Following

Genera un **Plan de Ejecución con Gestión de Riesgo y Timing** por activo, con reglas deterministas:

| Regla | Implementación |
|---|---|
| Fase del ciclo | `ACUMULACION`, `TENDENCIA_ALCISTA_TEMPRANA`, `TENDENCIA_EXTENDIDA` (>15% sobre SMA50 o RSI>72), `DISTRIBUCION_O_BAJISTA`; si no encaja: `TRANSICION_SIN_FASE_CLARA` |
| Stop Loss | Soporte estructural (pivote) − 1.5×ATR14 (2.0× si ATR% > 3.5%); se desplaza bajo números redondos |
| Tamaño | `1% / distancia% al stop`, tope de concentración 25% |
| Asimetría | R:R a la 1ª resistencia < 1:2 → `ESPERAR_MEJOR_TIMING` / `NO_OPERAR` (indica la entrada que sí cumpliría) |
| Escenarios | Alcista / Base / Bajista, enteros que suman exactamente 100% |
| Salidas | 50% en Objetivo 1, 50% con trailing en SMA20; invalidación temporal en N sesiones |
| Noticias | `news.json` con score [-1,1]; ≤ −0.6 fuerza fase defensiva |

## Uso
```bash
pip install -r requirements.txt
python analyze.py --csv data/AAPL.csv --news news.json --out reportes/plan.md
python analyze.py --tickers AAPL NVDA SPY BTC-USD   # requiere yfinance + internet
python -m pytest -q tests
```
CSV: `date,open,high,low,close,volume` diario, ≥ 220 filas. `data/DEMO_SINTETICO.csv` es una serie **sintética** solo para pruebas.

> Las probabilidades son un scoring heurístico, no un modelo calibrado. No es asesoría de inversión.
