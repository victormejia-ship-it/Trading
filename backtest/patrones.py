"""Patrones de velas y estrategias de traders: estudio de eventos a 20 años con validación en dos tramos.

Para cada aparición (señal al cierre del día t) se mide el rendimiento desde la apertura de t+1 hasta el cierre de
t+5/t+10/t+20, con costos de ida y vuelta, contra el rendimiento normal del mismo activo en el mismo tramo.
Protocolo fijado ANTES de ver resultados: un patrón está "validado" si en 2006-2015 tiene n ≥ 30, ventaja a 10 días > 0
con t > 2, y en 2016-2026 n ≥ 30 y ventaja a 10 días > 0. Los patrones bajistas se miden como señal de venta/no compra.

  python -m backtest.patrones --datos data/historico20 --out public/data/patrones.json
"""
from __future__ import annotations

import argparse
import json
import pathlib

import numpy as np
import pandas as pd

from backtest.estrategia_v2 import cargar

COSTO_RT = 2 * (0.0029 + 0.0005)
CORTE = pd.Timestamp("2016-01-01")
INICIO = pd.Timestamp("2006-11-27")
HORIZONTES = (5, 10, 20)
UMBRAL = {5: 0.02, 10: 0.03, 20: 0.05}      # escenarios: sube > +u, lateral, baja < -u

PATRONES = {
    "martillo": ("Martillo", "Steve Nison (velas japonesas)", "alcista", "Mecha inferior ≥ 2× el cuerpo tras 5 sesiones de caída: rechazo de precios bajos."),
    "envolvente_alcista": ("Envolvente alcista", "Steve Nison", "alcista", "Vela alcista cuyo cuerpo envuelve el de la vela bajista previa, tras caída."),
    "estrella_manana": ("Estrella de la mañana", "Steve Nison", "alcista", "Vela bajista larga, vela pequeña y vela alcista que cierra sobre la mitad de la primera, tras caída."),
    "linea_penetrante": ("Línea penetrante", "Steve Nison", "alcista", "Tras vela bajista larga, abre por debajo de su cierre y cierra sobre la mitad de su cuerpo."),
    "tres_soldados": ("Tres soldados blancos", "Steve Nison", "alcista", "Tres velas alcistas seguidas con cierres crecientes y sombras superiores cortas."),
    "estrella_fugaz": ("Estrella fugaz", "Steve Nison", "bajista", "Mecha superior ≥ 2× el cuerpo tras 5 sesiones de subida: rechazo de precios altos."),
    "envolvente_bajista": ("Envolvente bajista", "Steve Nison", "bajista", "Vela bajista cuyo cuerpo envuelve el de la vela alcista previa, tras subida."),
    "estrella_tarde": ("Estrella de la tarde", "Steve Nison", "bajista", "Vela alcista larga, vela pequeña y vela bajista que cierra bajo la mitad de la primera, tras subida."),
    "nube_oscura": ("Nube oscura", "Steve Nison", "bajista", "Tras vela alcista larga, abre por encima de su cierre y cierra bajo la mitad de su cuerpo."),
    "tres_cuervos": ("Tres cuervos negros", "Steve Nison", "bajista", "Tres velas bajistas seguidas con cierres decrecientes y sombras inferiores cortas."),
    "inside_ruptura": ("Ruptura de vela interna", "Price action (harami / inside bar)", "alcista", "Ayer fue vela interna; hoy cierra sobre el máximo de la vela madre, en tendencia alcista."),
    "nr7_ruptura": ("Ruptura NR7", "Toby Crabel", "alcista", "Ayer tuvo el rango más estrecho de 7 sesiones; hoy cierra sobre su máximo."),
    "holy_grail": ("Holy Grail", "Linda Raschke", "alcista", "Tendencia fuerte (ADX > 30, +DI > -DI) y retroceso que toca la EMA20 y cierra sobre ella."),
    "rsi2_connors": ("RSI(2) en sobreventa", "Larry Connors", "alcista", "Precio sobre su SMA200 y RSI de 2 periodos < 10: retroceso corto dentro de tendencia."),
    "spring_wyckoff": ("Spring", "Richard Wyckoff", "alcista", "Perfora el mínimo de 20 sesiones y cierra de regreso dentro del rango con volumen alto."),
    "oops_williams": ("Oops", "Larry Williams", "alcista", "Abre por debajo del mínimo de ayer y cierra por encima de él: trampa bajista."),
    "ruptura_52s": ("Ruptura de máximos de 52 semanas", "William O'Neil / Mark Minervini", "alcista", "Cierra en máximo de 52 semanas con SMA50 > SMA150 > SMA200 y volumen ≥ 1.4× su media."),
}


def wilder(s, n):
    return s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def detectar(df: pd.DataFrame) -> pd.DataFrame:
    """Columnas booleanas por patrón, evaluadas al cierre de cada día (solo datos pasados)."""
    o, h, l, c, v = df.open, df.high, df.low, df.close, df.volume
    cuerpo, rango = (c - o), (h - l).replace(0, np.nan)
    acu = cuerpo.abs()
    sup, inf = h - np.maximum(o, c), np.minimum(o, c) - l
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr = wilder(tr, 14)
    cae, sube = c < c.shift(5), c > c.shift(5)
    sma50, sma150, sma200 = c.rolling(50).mean(), c.rolling(150).mean(), c.rolling(200).mean()
    ema20 = c.ewm(span=20, adjust=False).mean()
    alc1, baj1 = cuerpo.shift(1) > 0, cuerpo.shift(1) < 0
    largo1, largo2 = acu.shift(1) > 0.6 * atr.shift(1), acu.shift(2) > 0.6 * atr.shift(2)
    mitad1 = (o.shift(1) + c.shift(1)) / 2
    mitad2 = (o.shift(2) + c.shift(2)) / 2
    # ADX / DI (Wilder)
    up, dn = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    ndm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    atr14 = wilder(tr, 14)
    pdi, ndi = 100 * wilder(pdm, 14) / atr14, 100 * wilder(ndm, 14) / atr14
    dx = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, np.nan)
    adx = wilder(dx, 14)
    # RSI(2)
    d = c.diff()
    g, p = wilder(d.clip(lower=0), 2), wilder(-d.clip(upper=0), 2)
    rsi2 = 100 - 100 / (1 + g / p.replace(0, np.nan))
    rsi2 = rsi2.where(p != 0, 100)
    vol20, vol50 = v.rolling(20).mean(), v.rolling(50).mean()
    rng7 = (h - l).rolling(7).min()

    out = pd.DataFrame(index=df.index)
    out["martillo"] = (acu > 0) & (inf >= 2 * acu) & (sup <= 0.1 * rango) & cae
    out["estrella_fugaz"] = (acu > 0) & (sup >= 2 * acu) & (inf <= 0.1 * rango) & sube
    out["envolvente_alcista"] = baj1 & (cuerpo > 0) & (o <= c.shift(1)) & (c >= o.shift(1)) & (acu > acu.shift(1)) & cae
    out["envolvente_bajista"] = alc1 & (cuerpo < 0) & (o >= c.shift(1)) & (c <= o.shift(1)) & (acu > acu.shift(1)) & sube
    peq1 = acu.shift(1) < 0.3 * acu.shift(2)
    out["estrella_manana"] = (cuerpo.shift(2) < 0) & largo2 & peq1 & (cuerpo > 0) & (c > mitad2) & (c.shift(2) < c.shift(7))
    out["estrella_tarde"] = (cuerpo.shift(2) > 0) & largo2 & peq1 & (cuerpo < 0) & (c < mitad2) & (c.shift(2) > c.shift(7))
    out["linea_penetrante"] = baj1 & largo1 & (o < c.shift(1)) & (c > mitad1) & (c < o.shift(1)) & cae
    out["nube_oscura"] = alc1 & largo1 & (o > c.shift(1)) & (c < mitad1) & (c > o.shift(1)) & sube
    s3 = (cuerpo > 0) & (cuerpo.shift(1) > 0) & (cuerpo.shift(2) > 0) & (c > c.shift(1)) & (c.shift(1) > c.shift(2))
    out["tres_soldados"] = s3 & (sup <= 0.25 * acu) & (sup.shift(1) <= 0.25 * acu.shift(1)) & (o > o.shift(1)) & (o.shift(1) > o.shift(2)) & (acu > 0.5 * atr)
    b3 = (cuerpo < 0) & (cuerpo.shift(1) < 0) & (cuerpo.shift(2) < 0) & (c < c.shift(1)) & (c.shift(1) < c.shift(2))
    out["tres_cuervos"] = b3 & (inf <= 0.25 * acu) & (inf.shift(1) <= 0.25 * acu.shift(1)) & (o < o.shift(1)) & (o.shift(1) < o.shift(2)) & (acu > 0.5 * atr)
    interna = (h.shift(1) < h.shift(2)) & (l.shift(1) > l.shift(2))
    out["inside_ruptura"] = interna & (c > h.shift(2)) & (c > sma50)
    out["nr7_ruptura"] = ((h - l).shift(1) <= rng7.shift(1)) & (c > h.shift(1))
    out["holy_grail"] = (adx > 30) & (pdi > ndi) & (l <= ema20) & (c > ema20)
    out["rsi2_connors"] = (c > sma200) & (rsi2 < 10)
    out["spring_wyckoff"] = (l < l.shift(1).rolling(20).min()) & (c > l.shift(1).rolling(20).min()) & (v > vol20)
    out["oops_williams"] = (o < l.shift(1)) & (c > l.shift(1))
    out["ruptura_52s"] = (c >= h.shift(1).rolling(252).max()) & (sma50 > sma150) & (sma150 > sma200) & (v >= 1.4 * vol50)
    out = out.fillna(False).astype(bool)
    out["_sobre_sma200"] = c > sma200
    out["_atr_pct"] = atr / c
    return out


def rend_futuros(df: pd.DataFrame) -> pd.DataFrame:
    o1 = df.open.shift(-1)
    return pd.DataFrame({h: df.close.shift(-h) / o1 - 1 for h in HORIZONTES}, index=df.index)


def resumen(ret: pd.Series, base: pd.Series, h: int, tipo: str, costo=True):
    ret = ret.dropna()
    n = len(ret)
    if n == 0:
        return {"n": 0}
    r = ret - (COSTO_RT if (costo and tipo == "alcista") else 0)
    signo = 1 if tipo == "alcista" else -1
    exceso = signo * (r - base.mean())
    t = float(exceso.mean() / (exceso.std(ddof=1) / np.sqrt(n))) if n > 2 and exceso.std(ddof=1) > 0 else None
    u = UMBRAL[h]
    return {"n": n, "ret_medio_pct": round(100 * float(r.mean()), 2), "base_pct": round(100 * float(base.mean()), 2),
            "ventaja_pct": round(100 * float(exceso.mean()), 2), "t": round(t, 2) if t is not None else None,
            "acierto_pct": round(100 * float((r > 0).mean() if tipo == "alcista" else (r < 0).mean()), 1),
            "acierto_base_pct": round(100 * float((base > 0).mean() if tipo == "alcista" else (base < 0).mean()), 1),
            "p_sube": round(100 * float((ret > u).mean()), 1), "p_lateral": round(100 * float(((ret >= -u) & (ret <= u)).mean()), 1),
            "p_baja": round(100 * float((ret < -u).mean()), 1),
            "p10": round(100 * float(ret.quantile(0.1)), 2), "p50": round(100 * float(ret.quantile(0.5)), 2), "p90": round(100 * float(ret.quantile(0.9)), 2)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="data/historico20")
    ap.add_argument("--universo", default="backtest/universo.json")
    ap.add_argument("--out", default="public/data/patrones.json")
    a = ap.parse_args(argv)
    u = json.loads(pathlib.Path(a.universo).read_text())
    precios = cargar(a.datos)
    activos = [t for t in u["sic"] + u["bmv"] + ["SPY", "QQQ", "IWM", "NAFTRACISHRS.MX", "EWW"] if t in precios]

    filas = []          # (patrón, tramo, activo, ret_h..., base_h...)
    base_por_activo = {}
    for t in activos:
        df = precios[t]
        df = df[(df.close > 0) & (df.high >= df.low)]
        det, fut = detectar(df), rend_futuros(df)
        rango = df.index >= INICIO
        tramo = np.where(df.index < CORTE, "t1", "t2")
        for tr in ("t1", "t2"):
            m = rango & (tramo == tr)
            for hz in HORIZONTES:
                base_por_activo.setdefault(t, {}).setdefault(tr, {})[hz] = fut.loc[m, hz].dropna()
        # base por régimen (todo el periodo) para escenarios del activo
        for p in PATRONES:
            idx = det.index[det[p] & rango]
            for d in idx:
                filas.append({"patron": p, "activo": t, "tramo": "t1" if d < CORTE else "t2", "fecha": d,
                              **{f"r{hz}": fut.at[d, hz] for hz in HORIZONTES}, "sobre200": bool(det.at[d, "_sobre_sma200"])})
        sob = det["_sobre_sma200"]
        base_por_activo[t]["regimen"] = {k: {hz: resumen(fut.loc[rango & (sob == (k == "sobre")), hz], fut.loc[rango, hz].dropna(), hz, "alcista", costo=False)
                                             for hz in HORIZONTES} for k in ("sobre", "bajo")}
    ev = pd.DataFrame(filas)

    salida = {"generado": str(pd.Timestamp.today().date()), "periodo": {"inicio": str(INICIO.date()), "corte": str(CORTE.date())},
              "activos": activos, "costo_ida_vuelta_pct": round(100 * COSTO_RT, 2), "umbrales_escenario_pct": {str(k): v * 100 for k, v in UMBRAL.items()},
              "protocolo": "Validado = 2006-2015: n ≥ 30, ventaja a 10 días > 0 y t > 2; y 2016-2026: n ≥ 30 y ventaja a 10 días > 0. Ventaja = rendimiento tras el patrón (con costos) menos el rendimiento normal del mismo activo y tramo; en patrones bajistas, cuánto se evitó perder.",
              "patrones": {}, "base_activos": {}}
    for p, (nombre, autor, tipo, desc) in PATRONES.items():
        e = ev[ev.patron == p] if len(ev) else ev
        info = {"nombre": nombre, "autor": autor, "tipo": tipo, "descripcion": desc, "tramos": {}}
        for tr in ("t1", "t2", "todo"):
            et = e if tr == "todo" else e[e.tramo == tr]
            info["tramos"][tr] = {}
            for hz in HORIZONTES:
                if len(et) == 0:
                    info["tramos"][tr][str(hz)] = {"n": 0}; continue
                # ventaja frente a la base de CADA activo en su tramo (se promedian excesos individuales)
                rets, bases = [], []
                for (act, tm), g in et.groupby(["activo", "tramo"]):
                    b = base_por_activo[act][tm][hz]
                    rets.append(g[f"r{hz}"]); bases.append(pd.Series(b.mean(), index=g.index))
                ret = pd.concat(rets); base_al = pd.concat(bases)
                ret_ok = ret.dropna(); base_al = base_al.loc[ret_ok.index]
                r = ret_ok - (COSTO_RT if tipo == "alcista" else 0)
                signo = 1 if tipo == "alcista" else -1
                exceso = signo * (r - base_al)
                n = len(r)
                tval = float(exceso.mean() / (exceso.std(ddof=1) / np.sqrt(n))) if n > 2 and exceso.std(ddof=1) > 0 else None
                uu = UMBRAL[hz]
                info["tramos"][tr][str(hz)] = {
                    "n": n, "ret_medio_pct": round(100 * float(r.mean()), 2), "base_pct": round(100 * float(base_al.mean()), 2),
                    "ventaja_pct": round(100 * float(exceso.mean()), 2), "t": round(tval, 2) if tval is not None else None,
                    "acierto_pct": round(100 * float((r > 0).mean() if tipo == "alcista" else (r < 0).mean()), 1),
                    "p_sube": round(100 * float((ret_ok > uu).mean()), 1), "p_lateral": round(100 * float(((ret_ok >= -uu) & (ret_ok <= uu)).mean()), 1),
                    "p_baja": round(100 * float((ret_ok < -uu).mean()), 1),
                    "p10": round(100 * float(ret_ok.quantile(0.1)), 2), "p50": round(100 * float(ret_ok.quantile(0.5)), 2), "p90": round(100 * float(ret_ok.quantile(0.9)), 2)}
        t1, t2 = info["tramos"]["t1"]["10"], info["tramos"]["t2"]["10"]
        info["validado"] = bool(t1.get("n", 0) >= 30 and t2.get("n", 0) >= 30 and t1["ventaja_pct"] > 0 and (t1["t"] or 0) > 2 and t2["ventaja_pct"] > 0)
        # por mercado (todo el periodo, 10 días)
        info["por_mercado"] = {}
        for mk, filtro in (("SIC", lambda s: ~s.str.endswith(".MX")), ("BMV", lambda s: s.str.endswith(".MX"))):
            g = e[filtro(e.activo)] if len(e) else e
            info["por_mercado"][mk] = {"n": int(len(g)), "ret10_pct": round(100 * float((g.r10.dropna() - (COSTO_RT if tipo == "alcista" else 0)).mean()), 2) if len(g) else None}
        salida["patrones"][p] = info
        print(f"{nombre:34s} {tipo:7s} T1 n={t1.get('n',0):5d} ventaja10={t1.get('ventaja_pct')}% t={t1.get('t')}  |  T2 n={t2.get('n',0):5d} ventaja10={t2.get('ventaja_pct')}% t={t2.get('t')}  -> {'VALIDADO' if info['validado'] else 'sin evidencia'}")
    for t in activos:
        salida["base_activos"][t] = base_por_activo[t]["regimen"]
    pathlib.Path(a.out).write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")))
    print("Guardado", a.out)


if __name__ == "__main__":
    main()
