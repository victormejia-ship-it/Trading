# Terminal de Riesgo · Trend Timing

App web privada de estado de mercado, timing de tendencias y gestión de riesgo. Los números los calcula un
motor determinista; Claude interpreta y redacta con salida JSON validada; unos guardrails en código tienen
la última palabra.

```
 yfinance / Finnhub ──► worker/data_sources.py      precios OHLCV 2 años + noticias 24h (con ID)
                              │
                              ▼
 trend_risk/ + worker/features.py                   MOTOR DETERMINISTA: SMA/EMA, RSI, MACD, ATR, fase,
                              │                     stop por ATR, tamaño 1%, R:R, topes de exposición
                              ▼
 worker/llm.py  ── Claude (output_config.format = json_schema)
   1) Motor de Estado de Mercado   → MERCADO_SCHEMA
   2) Motor de Timing y Riesgo     → ACTIVO_SCHEMA (uno por activo, en paralelo)
                              │
                              ▼
 worker/guardrails.py                               reglas duras: probabilidades = 100, COMPRAR solo con
                              │                     R:R ≥ 2 + fase válida + semáforo no ROJO, el LLM solo
                              ▼                     reduce tamaño/exposición, se descartan noticias inventadas
 public/data/latest.json (+ history/)  y/o  Supabase (tabla analisis_diario)
                              │
                              ▼
 public/index.html                                  semáforo, watchlist, gráfico, escenarios, calculadora, JSON
```

## Terminal en vivo (web propia en Vercel, plan gratuito)

`public/index.html` + `api/*.js` + `lib/*.js` forman una web con precios en vivo:

| Dato | Fuente gratuita | Frescura |
|---|---|---|
| Acciones/ETFs de EE. UU. (SIC) | Finnhub `quote` (con `FINNHUB_API_KEY`) | Tiempo real |
| Emisoras BMV (`.MX`), IPC (`^MXX`), VIX, dólar (`MXN=X`) | Yahoo Finance (sin clave, no oficial) | ~15-20 min de retraso en BMV |
| Históricos diarios (2 años) | Yahoo Finance | La vela de hoy se actualiza durante la sesión |
| Noticias | Finnhub (EE. UU. y macro) + Yahoo (BMV) | Últimas 24 h |

Cada precio muestra si está en vivo, con cuántos minutos de retraso o al cierre. La watchlist se actualiza cada 15 s con el mercado abierto. Hay alertas en pantalla, por notificación del navegador y con sonido cuando el precio toca la zona de entrada, el stop, el objetivo 1, la ruptura o el trailing. La calculadora da títulos y monto en MXN (el SIC se convierte con `MXN=X`).

### Desplegar (una vez)
1. **Finnhub**: crea una cuenta gratuita en finnhub.io y copia tu API key.
2. **Claude (opcional)**: crea una API key en console.anthropic.com. Sin ella funciona «Analizar (motor)», que es gratis.
3. **Vercel**: *Add New → Project → Import* este repo. Framework preset: **Other**. `vercel.json` ya fija `public/` como salida y 60 s por función.
   Variables de entorno:
   - `APP_TOKEN`: contraseña larga inventada por ti. Protege la app y tus créditos.
   - `FINNHUB_API_KEY`
   - `ANTHROPIC_API_KEY` (opcional)
   - Opcional: `CLAUDE_MODEL` (por defecto `claude-opus-5-5`) y `CLAUDE_EFFORT` (por defecto `medium`).
4. En *Settings → Git*, define la rama de producción (la de este trabajo o `main` tras fusionar). Cada commit del worker diario redespliega con el reporte nuevo.
5. Abre la URL, escribe tu `APP_TOKEN` y en *Configuración* revisa que Claude y Finnhub aparezcan como configurados.

No pude consultar la documentación de Vercel desde el entorno de desarrollo: si el panel de Vercel te pide otro directorio de salida, usa `public`.

### Costo orientativo de Claude por API
Un análisis completo es 1 llamada de mercado + 1 por activo. Con 8 activos y `claude-opus-5-5` son ~0.8 USD (estimado; revisa tu consumo en la consola). Para bajarlo: `CLAUDE_MODEL=claude-sonnet-5-5` (~la mitad), menos activos, o el análisis con Claude desde la página de claude.ai (lo cubre tu plan).

### Probar en tu computadora
```bash
npm install
```
```bash
APP_TOKEN=prueba FINNHUB_API_KEY=... ANTHROPIC_API_KEY=... node scripts/dev-server.js
```
Abre http://localhost:3000. Pruebas: `npm test` (servidor) y `python -m pytest -q tests` (motor Python).

## Versión web en claude.ai (como tus otros proyectos)

`web/index.html` + `public/engine.js` se publican como página de claude.ai:
https://claude.ai/artifact/LZSrR67PKiE26iqqR9mtz5

- **Motor determinista en el navegador** (`web/engine.js`): da los mismos resultados que `trend_risk/`, comprobado con 16 series de prueba.
- **Claude con tu cuenta de claude.ai**: no hace falta clave de API. Las mismas reglas anti-alucinación y los mismos guardrails, en JavaScript.
- **Historial** en la base de datos de la página. Solo tú (o tus editores) pueden escribir.
- **Datos**: la página no puede descargar de internet. Sube CSV de Yahoo/Stooq, importa el `latest.json` del worker o pega titulares.

## Medidas anti-alucinación

| Medida | Dónde |
|---|---|
| Claude no escribe precios: referencia niveles por clave (`nivel_ref`: `stop_loss`, `resistencia_1`…), que el worker resuelve con valores del motor | `schemas.py`, `guardrails.py` |
| Solo usa lo que está en `<datos>`; lo que falte va en `datos_faltantes` | `llm.py` (prompt del sistema) |
| Las noticias van delimitadas como contenido de terceros; se citan por ID y se eliminan los ID que no existen | `llm.py`, `guardrails.py` |
| Tope duro de exposición (SPY < SMA200 → 30%, VIX > 30 → 25%, etc.); no puede haber VERDE si SPY < SMA200 o VIX > 25 | `features.py`, `guardrails.py` |
| Contra-tesis obligatoria; si viene vacía, se bloquea la compra | esquema + `guardrails.py` |
| Cada corrección queda visible en `correcciones_guardrail` (también en la web) | `guardrails.py`, `index.html` |
| Si Claude falla o rechaza la petición, se usa el motor determinista (`fuente: MOTOR_DETERMINISTA`) | `run_daily.py` |

## Puesta en marcha

### 1. Local
```bash
pip install -r requirements.txt
cp .env.example .env               # pon ANTHROPIC_API_KEY
set -a; source .env; set +a
python -m worker.run_daily --no-llm   # prueba sin coste: solo motor determinista
python -m worker.run_daily            # con Claude
python -m http.server -d public 8000  # abre http://localhost:8000
```
Edita `watchlist.json` para cambiar índices, activos, % de riesgo y tope por posición.

### 2. Automatización diaria (GitHub Actions)
1. En el repo: **Settings → Secrets and variables → Actions**, añade `ANTHROPIC_API_KEY` (y opcionalmente
   `FINNHUB_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
2. `.github/workflows/daily.yml` se ejecuta de lunes a viernes a las 22:17 UTC. Corre los tests y el worker,
   y hace commit de `public/data/`. GitHub solo lanza los workflows programados desde la **rama por defecto**;
   para probarlo antes, usa *Run workflow* (workflow_dispatch).

### 3. Supabase (opcional, recomendado para la app privada)
1. Ejecuta `supabase/schema.sql` en el SQL Editor (crea la tabla con RLS: solo usuarios autenticados leen).
2. El worker hace upsert si existen `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (la service role key va **solo**
   en secrets, nunca en el frontend).
3. En la web, define antes del script principal:
   `window.APP_CONFIG = { supabaseUrl, supabaseAnonKey, supabaseToken }` (`supabaseToken` = JWT de la sesión
   del usuario tras iniciar sesión con Supabase Auth).

### Privacidad del hosting
`public/` es estático. Si el repo o GitHub Pages son públicos, el JSON también lo es. Opciones privadas:
Cloudflare Pages + Cloudflare Access, Vercel con protección por contraseña, o Supabase con RLS + login.

## Coste orientativo
Una llamada de mercado + una por activo al día. Con 8 activos son unas 9 llamadas de unos 6-10k tokens de
entrada cada una. Usa `CLAUDE_MODEL` y `CLAUDE_EFFORT` para ajustar coste y calidad.

## Tests
```bash
python -m pytest -q tests     # motor, guardrails y capa LLM con un cliente falso (sin red)
```

> Las probabilidades no están calibradas con resultados históricos. No es asesoría de inversión.
