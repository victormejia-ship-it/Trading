import numpy as np
import pandas as pd

from backtest.patrones import detectar


def df_desde(velas, previas=260):
    base = [(100 + i * 0.05, 100.6 + i * 0.05, 99.6 + i * 0.05, 100.2 + i * 0.05) for i in range(previas)]
    rows = base + velas
    idx = pd.bdate_range("2020-01-01", periods=len(rows))
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(volume=1e6)


def test_martillo_tras_caida():
    caida = [(113 - i, 113.2 - i, 111.8 - i, 112 - i) for i in range(6)]           # 6 sesiones bajando
    martillo = [(107.0, 107.25, 103.0, 107.2)]                                      # mecha inferior larga, cuerpo arriba
    d = detectar(df_desde(caida + martillo))
    assert d["martillo"].iloc[-1]


def test_envolvente_alcista():
    caida = [(113 - i, 113.2 - i, 111.8 - i, 112 - i) for i in range(6)]
    velas = caida + [(107.5, 107.6, 106.4, 106.6), (106.3, 108.2, 106.2, 108.0)]
    d = detectar(df_desde(velas))
    assert d["envolvente_alcista"].iloc[-1]


def test_sin_futuro():
    """La detección del día t no cambia al agregar días posteriores."""
    caida = [(113 - i, 113.2 - i, 111.8 - i, 112 - i) for i in range(6)] + [(107.0, 107.25, 103.0, 107.2)]
    a = detectar(df_desde(caida))
    b = detectar(df_desde(caida + [(107, 109, 106, 108)] * 5))
    pd.testing.assert_frame_equal(a, b.iloc[: len(a)])
