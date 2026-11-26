# Arquitectura de la Terminal de Riesgo

Sitio: https://victormejia-ship-it.github.io/Trading/ · Repositorio público (no hay claves en el código).

## Capas

```
 1. DATOS            backtest/descargar.py, lib/market.js
    Yahoo Finance (precios ajustados), Finnhub opcional (tiempo real EE. UU.), FRED (tasas; respaldo: tabla CETES aprox.)
    Universo único: backtest/universo.json (índices, SIC, BMV y 21 ETFs globales)
            │
 2. INVESTIGACIÓN    backtest/*.py  (Python, 20 años, validación 2006-2015 → 2016-2026)
    cartera_nucleo, plan, mundo, patrones, retiros, estrategia_v2, run_backtest
    Salida: reports/*.json y public/data/*.json  (contratos verificados en tests/test_contratos.py)
            │
 3. MOTOR            public/engine.js  (el mismo archivo lo usan la página, el servidor y los avisos)
    regimen() · patronesVela() · analizar() · mercado() · guardrails
    Paridad exacta con Python verificada en tests/test_paridad.py con datos reales
            │
 4. PUBLICACIÓN      scripts/build-static.js → GitHub Pages
    Copia public/ + data/vivo.json (cotizaciones) + data/series.json (400 velas) + data/estado.json (calidad)
            │
 5. PRESENTACIÓN     public/index.html (estructura) · app.css (estilos) · app.js (lógica)
    Tu plan · Meta US$1,000/mes · Dónde invertir · Contexto · Mercados del mundo · Laboratorio de trading · Terminal avanzada
            │
 6. AVISOS           scripts/senales.js → ntfy/Telegram (último día hábil del mes) + avisos si falla un proceso
```

## Procesos automáticos (GitHub Actions)

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `pages.yml` | Cada 10 min en sesión, al cierre y en cada cambio | Publica la web con precios frescos y control de calidad |
| `alertas.yml` | Días 25-31 (el script valida el último día hábil) | Señal preliminar y confirmada al celular |
| `investigacion.yml` | Día 2 de cada mes o a mano | Descarga 20 años y regenera TODA la evidencia; corre pruebas antes de publicar |
| `ci.yml` | En cada cambio de código | Pruebas de Python, Node, paridad del motor y contratos de datos |
| `daily.yml` | Lunes a viernes | Análisis diario del motor (y de Claude si hay clave) → `public/data/latest.json` |
| `historico20.yml`, `backtest.yml` | A mano | Descargas y backtest de 2 años (histórico) |

Todos avisan al celular si fallan (secreto `NTFY_TOPIC`).

## Contratos de datos (public/data)

| Archivo | Lo genera | Lo usa |
|---|---|---|
| `plan.json` | `backtest/publicar_plan.py` | Tarjetas del plan, ventanas emergentes |
| `retiros.json` | `backtest/retiros.py` | Meta de US$1,000/mes |
| `mundo.json` | `backtest/mundo.py` | Mercados del mundo |
| `patrones.json` | `backtest/patrones.py` | Velas y laboratorio de estrategias |
| `estrategia.json` | `backtest/publicar_evidencia.py` | Terminal avanzada (estrategia original 50/50) |
| `contexto.json` | Manual, con fuentes y fecha | Contexto y casas de bolsa (revisar cada mes) |
| `vivo.json`, `series.json`, `estado.json` | `scripts/build-static.js` en cada publicación | Precios, gráficos y aviso de datos viejos |

## Principios

1. **Toda regla que se muestra como recomendación pasó validación fuera de muestra;** las que fallaron se muestran como descartadas.
2. **Una sola implementación por regla en vivo** (`engine.js`), comprobada contra la investigación.
3. **Los datos se verifican antes de usarse:** si faltan SPY o el dólar, no se publica; si algo está viejo, la página lo dice.
4. **Nada guarda claves en el repositorio;** el laboratorio guarda las operaciones solo en el navegador del usuario.

## Limitaciones conocidas

- Yahoo es una fuente no oficial (el control de calidad marca saltos sospechosos; p. ej. NVDA +31.5% el 23-nov-2026 está sin confirmar).
- Si FRED no responde, las tasas históricas de CETES son aproximadas (`data/tasas_cetes_anual_aprox.csv`).
- Hay sesgo de supervivencia: el universo se eligió hoy.
- Las opciones con servidor (Vercel: `api/`; Firebase: `firebase.js`) existen pero no están activas; el sitio vivo es estático.
