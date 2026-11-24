"""Render del Plan de Ejecución en Markdown (español)."""
from .engine import Plan


def _f(x, suf=""):
    return "—" if x is None else f"{x:,.2f}{suf}"


def plan_md(p: Plan) -> str:
    i = p.indicadores
    L = [f"## {p.activo} — {p.fase}", "",
         f"**Fecha de datos:** {p.fecha} · **Precio:** {_f(p.precio)} · **Orden:** `{p.orden}` · **Horizonte:** {p.horizonte}", "",
         "**Evidencia de fase:** " + " ".join(p.evidencia_fase), "",
         "| SMA20 | SMA50 | SMA200 | RSI14 | MACD hist | ATR14 (ATR%) | Ext. vs SMA50 | Vol/Vol20 |",
         "|---|---|---|---|---|---|---|---|",
         f"| {i['SMA20']} | {i['SMA50']} | {i['SMA200']} | {i['RSI14']} | {i['MACD_hist']} | {i['ATR14']} ({i['ATR%']}%) | {i['Ext_vs_SMA50_%']}% | {i['Vol/Vol20']} |", "",
         "### Escenarios ponderados (suma = 100%)", "",
         "| Escenario | Prob. | Nivel | Descripción |", "|---|---|---|---|"]
    for e in p.escenarios:
        L.append(f"| {e['nombre']} | {e['probabilidad']}% | {_f(e['objetivo'])} | {e['descripcion']} |")
    L += ["", "### Parámetros de riesgo", "",
          "| Entrada | Soporte | Stop Loss | Dist. stop | Tamaño posición | Objetivo 1 | Objetivo 2 | R:R | Trailing |",
          "|---|---|---|---|---|---|---|---|---|",
          f"| {_f(p.entrada)} | {_f(p.soporte)} | {_f(p.stop_loss)} ({i['Mult_ATR_stop']}xATR) | {_f(p.distancia_stop_pct, '%')} | "
          f"{_f(p.tamano_posicion_pct, '%')} | {_f(p.resistencia_1)} | {_f(p.objetivo_2)} | "
          f"{'1:' + format(p.rr, '.2f') if p.rr else '—'} | {_f(p.trailing_stop)} |", "",
          f"Objetivo 1: {p.resistencia_1_origen}. Tamaño = 1% / {_f(p.distancia_stop_pct, '%')} = {_f(p.tamano_posicion_formula_pct, '%')}.", "",
          "### Timing", "", f"- **Gatillo de COMPRA:** {p.gatillo_compra}"]
    L += [f"- **Salida:** {s}" for s in p.gatillo_salida]
    L += [f"- **Invalidación temporal:** {p.invalidacion_temporal}"]
    if p.noticias:
        L += [f"- **Noticias:** score {p.noticias['score']:+.2f} — {p.noticias['nota']}"]
    if p.alertas:
        L += ["", "**Alertas CRO:**"] + [f"- {a}" for a in p.alertas]
    return "\n".join(L) + "\n"


def report_md(plans) -> str:
    head = ["# Plan de Ejecución — Gestión de Riesgo y Timing", "",
            "| Activo | Fase | Orden | Precio | Stop | Tamaño | R:R | P(Alc/Base/Baj) |", "|---|---|---|---|---|---|---|---|"]
    for p in plans:
        pr = "/".join(str(e["probabilidad"]) for e in p.escenarios)
        head.append(f"| {p.activo} | {p.fase} | `{p.orden}` | {_f(p.precio)} | {_f(p.stop_loss)} | "
                    f"{_f(p.tamano_posicion_pct, '%')} | {'1:' + format(p.rr, '.2f') if p.rr else '—'} | {pr} |")
    nota = ["", "> Probabilidades = scoring heurístico (tendencia, pendiente, MACD, RSI, noticias), no un modelo calibrado. "
            "Riesgo máx. 1% por operación; tope de concentración 25%. No es asesoría de inversión.", ""]
    return "\n".join(head + nota) + "\n" + "\n".join(plan_md(p) for p in plans)
