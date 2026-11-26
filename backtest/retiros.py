"""¿Cuánto capital se necesita para retirar US$1,000 al mes? (perfiles del plan, 20 años de datos reales, en MXN)

- Retiro mensual fijo de US$1,000 convertido al tipo de cambio real de cada fin de mes (incluye depreciación del peso).
- Arrastre adicional de 1% anual por impuestos (ISR 10% sobre ganancias), diferencial cambiario y comisiones.
- Se prueba cada mes de arranque entre dic-2006 y nov-2016 con horizonte de 10 años (incluye arrancar justo antes de 2008).
- Meta A "no se acaba": el saldo nunca llega a cero en 10 años.
- Meta B "renta perpetua": además, al final conserva su valor real (inflación México supuesta de 4% anual).

  python -m backtest.retiros
"""
import json
import pathlib

import numpy as np
import pandas as pd

from backtest.cartera_nucleo import simular as simular_filtro, tasa_diaria
from backtest.estrategia_v2 import cargar
from backtest.plan import a_mxn, PERFILES, INICIO

RETIRO_USD, ARRASTRE, INFL, MESES = 1000.0, 0.01, 0.04, 120


def curva_diaria(P, fx, tasa, cal, pesos, regla):
    mg = {t: {"senal": P[t], "mxn": a_mxn(P[t], fx, t).reindex(cal).ffill()} for t in pesos if t != "CETES"}
    eq, _, _ = simular_filtro(mg, {t: w for t, w in pesos.items() if t != "CETES"}, regla, cal, tasa.reindex(cal))
    return eq + 100_000.0 * pesos.get("CETES", 0) * np.cumprod(1 + tasa.reindex(cal).values)


def simular_retiros(crec, fxm, K):
    """crec: crecimiento mensual (array), fxm: tipo de cambio al cierre de cada mes. Devuelve saldos."""
    V, sal = K, []
    for g, f in zip(crec, fxm):
        V = V * g * (1 - ARRASTRE / 12) - RETIRO_USD * f
        sal.append(V)
        if V <= 0:
            break
    return sal


def capital_minimo(crec, fxm, meta):
    lo, hi = 1e5, 5e8
    for _ in range(60):
        K = (lo + hi) / 2
        s = simular_retiros(crec, fxm, K)
        ok = len(s) == len(crec) and min(s) > 0 and (meta == "A" or s[-1] >= K * (1 + INFL) ** (len(crec) / 12))
        hi, lo = (K, lo) if ok else (hi, K)
    return hi


def main(datos="data/historico20", out="public/data/retiros.json"):
    P = cargar(datos)
    fx = P["MXN=X"]["close"]
    spy = P["SPY"].index
    cal = spy[(spy >= INICIO) & (spy >= fx.index[0])]
    tasa, _ = tasa_diaria(datos, cal)
    fin_mes = cal.to_series().groupby(cal.to_period("M")).max().values
    fxm_all = fx.reindex(pd.DatetimeIndex(fin_mes), method="ffill").values
    fx_hoy = float(fx.iloc[-1])
    res = {"supuestos": {"retiro_usd_mensual": RETIRO_USD, "arrastre_anual_pct": ARRASTRE * 100, "inflacion_mx_pct": INFL * 100,
                         "horizonte_anios": MESES // 12, "tipo_cambio_hoy": round(fx_hoy, 2),
                         "arranques": f"cada mes de {pd.Timestamp(fin_mes[0]).date()} a {pd.Timestamp(fin_mes[-MESES - 1]).date()}"}, "perfiles": {}}
    for perfil, pesos in {**PERFILES, "solo_cetes": {"CETES": 1.0}}.items():
        res["perfiles"][perfil] = {}
        for regla in ("sma200_mensual", "comprar_y_mantener"):
            if perfil == "solo_cetes" and regla == "comprar_y_mantener":
                continue
            eq = curva_diaria(P, fx, tasa, cal, pesos, regla)
            em = eq.reindex(pd.DatetimeIndex(fin_mes)).values
            crec = em[1:] / em[:-1]
            fxm = fxm_all[1:]
            KA, KB = [], []
            for s in range(0, len(crec) - MESES + 1):
                KA.append(capital_minimo(crec[s:s + MESES], fxm[s:s + MESES], "A"))
                KB.append(capital_minimo(crec[s:s + MESES], fxm[s:s + MESES], "B"))
            # escalar a pesos de hoy: el retiro de cada ventana se midió con el tipo de cambio de su época
            esc = [fx_hoy / fxm[s] for s in range(len(KA))]
            KA = np.array(KA) * esc; KB = np.array(KB) * esc
            peor_b = int(np.argmax(KB))
            res["perfiles"][perfil][regla] = {
                "no_se_acaba": {"peor_mxn": round(float(KA.max()), -3), "mediana_mxn": round(float(np.median(KA)), -3)},
                "renta_perpetua": {"peor_mxn": round(float(KB.max()), -3), "mediana_mxn": round(float(np.median(KB)), -3),
                                   "peor_arranque": str(pd.Timestamp(fin_mes[peor_b]).date())},
            }
            r = res["perfiles"][perfil][regla]
            print(f"{perfil:11s} {regla:20s} no se acaba: peor ${r['no_se_acaba']['peor_mxn']:,.0f} (mediana ${r['no_se_acaba']['mediana_mxn']:,.0f}) | "
                  f"renta perpetua: peor ${r['renta_perpetua']['peor_mxn']:,.0f} (mediana ${r['renta_perpetua']['mediana_mxn']:,.0f}, peor arranque {r['renta_perpetua']['peor_arranque']})")
    pathlib.Path(out).write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
