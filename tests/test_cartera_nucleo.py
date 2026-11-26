import numpy as np
import pandas as pd

from backtest.cartera_nucleo import simular, posicion_objetivo, metricas


def manga(cierres):
    idx = pd.bdate_range("2010-01-01", periods=len(cierres))
    c = pd.Series(cierres, index=idx, dtype=float)
    df = pd.DataFrame({"open": c, "high": c * 1.001, "low": c * 0.999, "close": c, "volume": 1e6})
    return {"X": {"senal": df, "mxn": df}}, idx


def test_banda_sale_en_caida_y_cobra_cetes():
    cierres = list(np.linspace(100, 160, 400)) + list(np.linspace(160, 100, 120)) + [100] * 200
    mg, idx = manga(cierres)
    tasa = pd.Series((1.10) ** (1 / 252) - 1, index=idx)        # 10% anual en efectivo
    bh, _, _ = simular(mg, {"X": 1.0}, "comprar_y_mantener", idx, tasa)
    filt, eps, cambios = simular(mg, {"X": 1.0}, "sma200_banda", idx, tasa)
    assert cambios >= 1 and eps and eps[0]["salida"]
    assert metricas(filt)["max_dd_pct"] > metricas(bh)["max_dd_pct"]      # cae menos
    assert filt.iloc[-1] > bh.iloc[-1]                                      # y el efectivo rindió


def test_senal_se_ejecuta_al_dia_siguiente():
    mg, idx = manga(list(np.linspace(100, 150, 300)) + [100] * 50)
    obj = posicion_objetivo(mg["X"]["senal"], "sma200_banda")
    dia_senal = obj[obj == 0].index[0]
    _, eps, _ = simular(mg, {"X": 1.0}, "sma200_banda", idx, pd.Series(0.0, index=idx))
    assert pd.Timestamp(eps[0]["salida"]) > dia_senal


def test_mensual_solo_decide_a_fin_de_mes():
    mg, idx = manga(list(np.linspace(100, 150, 300)) + list(np.linspace(150, 90, 60)))
    obj = posicion_objetivo(mg["X"]["senal"], "sma200_mensual")
    cambios = obj[obj.diff() != 0].index[1:]
    fin_mes = idx.to_series().groupby(idx.to_period("M")).max()
    assert all(d in set(fin_mes) for d in cambios)
