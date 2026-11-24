import numpy as np
import pandas as pd
import pytest
from trend_risk import analyze, Config
from trend_risk.engine import _probabilidades, evitar_numero_redondo, TEMPRANA, EXTENDIDA, BAJISTA, ACUMULACION


def make(drifts, vols, seed=0, start=100.0):
    rng = np.random.default_rng(seed)
    r = np.concatenate([rng.normal(d, v, n) for d, v, n in zip(*zip(*drifts), vols)]) if False else None
    rets, sig = [], []
    for (mu, n), s in zip(drifts, vols):
        rets.append(rng.normal(mu, s, n)); sig.append(np.full(n, s))
    rets, sig = np.concatenate(rets), np.concatenate(sig)
    c = start * np.exp(np.cumsum(rets))
    h = c * (1 + sig * 0.6); l = c * (1 - sig * 0.6); o = np.r_[c[0], c[:-1]]
    v = rng.integers(9e5, 1.1e6, len(c)).astype(float)
    idx = pd.bdate_range("2024-01-01", periods=len(c))
    return pd.DataFrame({"open": o, "high": np.maximum(h, o), "low": np.minimum(l, o), "close": c, "volume": v}, idx)


def test_prob_suman_100():
    for s in np.linspace(-1, 1, 41):
        for ext in (0, 0.2, 0.4):
            p = _probabilidades(s, ext, Config())
            assert sum(p) == 100 and min(p) > 0


def test_fase_extendida_prohibe_compra():
    df = make([(0.0, 200), (0.012, 60)], [0.01, 0.01])
    p = analyze(df, "X")
    assert p.fase == EXTENDIDA and p.orden == "TOMA_PARCIAL_GANANCIAS" and p.tamano_posicion_pct is None


def test_fase_bajista():
    df = make([(0.001, 200), (-0.006, 60)], [0.01, 0.01])
    p = analyze(df, "X")
    assert p.fase == BAJISTA and p.orden in ("VENDER_CERRAR_POSICIONES", "NO_OPERAR")


def test_fase_temprana_y_reglas_riesgo():
    df = make([(-0.001, 200), (0.0015, 60)], [0.01, 0.01], seed=5)
    p = analyze(df, "X")
    assert p.fase == TEMPRANA
    assert p.stop_loss < p.soporte < p.entrada
    if p.tamano_posicion_formula_pct:
        assert abs(p.tamano_posicion_formula_pct - 1 / p.distancia_stop_pct * 100) < 0.05
    if p.rr is not None and p.rr < 2:
        assert p.orden in ("ESPERAR_MEJOR_TIMING", "NO_OPERAR")


def test_filtro_asimetria_generico():
    for seed in range(15):
        for drifts in ([(-0.001, 200), (0.0025, 60)], [(-0.003, 180), (0.0, 80)], [(0.0, 260)]):
            p = analyze(make(drifts, [0.015, 0.008] if len(drifts) == 2 else [0.01], seed=seed), "X")
            if p.orden == "COMPRAR_EN_RETROCESO":
                assert p.rr >= 2.0


def test_noticias_negativas_fuerzan_defensa():
    df = make([(-0.001, 200), (0.0015, 60)], [0.01, 0.01], seed=5)
    p = analyze(df, "X", noticias={"score": -0.8, "nota": "fraude contable"})
    assert p.fase == BAJISTA


def test_stop_evita_numero_redondo():
    s = evitar_numero_redondo(100.05, 2.0, 105)
    assert s < 100 - 0.4


def test_datos_insuficientes():
    with pytest.raises(ValueError):
        analyze(make([(0, 100)], [0.01]), "X")
