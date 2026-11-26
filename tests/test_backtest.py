"""Mecánica del simulador con un plan forzado (no depende de que el motor dé señal)."""
import pandas as pd
import pytest

import backtest.run_backtest as B
from trend_risk import Config


def serie(barras, inicio="2024-01-01", previas=260):
    """barras: lista de (o,h,l,c). Se anteponen `previas` velas planas a 100 para calentar indicadores."""
    rows = [(100, 100.5, 99.5, 100)] * previas + barras
    idx = pd.bdate_range(inicio, periods=len(rows))
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(volume=1e6)


def plan_falso(entrada=100.0, stop=95.0, r1=110.0):
    return {"orden": "COMPRAR_EN_RETROCESO", "fase": "TENDENCIA_ALCISTA_TEMPRANA", "entrada": entrada, "stop_loss": stop,
            "resistencia_1": r1, "tamano_posicion_pct": 20.0, "rr": 2.0, "invalidacion_temporal": "Si en 10 sesiones ..."}


@pytest.fixture
def forzar(monkeypatch):
    def _f(df, dia_senal):
        precios = {"SPY": df, "X": df}
        fecha = df.index[dia_senal]
        monkeypatch.setattr(B, "SESIONES_TEST", len(df) - 230)
        monkeypatch.setattr(B, "plan_en", lambda corte, t, d, cfg: plan_falso() if d == fecha else {"orden": "NO_OPERAR", "fase": "TRANSICION_SIN_FASE_CLARA"})
        B._MERCADO.clear()
        return B.simular(precios, ["SPY"], ["X"], Config(), filtro_mercado=False)
    return _f


def test_objetivo_parcial_y_trailing(forzar):
    barras = [(100, 101, 99, 100)] * 10 + [(100, 101, 99.8, 100.5),   # día de señal (índice 270)
              (100.4, 101, 99.9, 100.6),                              # se llena el límite a 100
              (101, 111, 100.8, 110.5),                                # toca objetivo 1 (110): vende 50%
              (110, 110.2, 95.5, 96)]                                  # cierre < SMA20 -> trailing (stop 95 intacto)
    df = serie(barras)
    trades, curva, _ = forzar(df, 270)
    assert len(trades) == 1
    t = trades[0]
    assert t["entrada"] == 100 and t["salidas"] == ["objetivo1", "trailing_sma20"]
    esperado = 20000 * (0.5 * 110 + 0.5 * 96) / 100 - 20000
    assert t["pnl"] < esperado and t["pnl"] > esperado - 20000 * 0.0034 * 3     # costos descontados


def test_stop_tiene_prioridad_el_mismo_dia(forzar):
    barras = [(100, 101, 99, 100)] * 10 + [(100, 101, 99.8, 100.5), (100.4, 101, 99.9, 100.6), (100, 112, 94, 105)]
    trades, _, _ = forzar(serie(barras), 270)
    assert trades[0]["salidas"] == ["stop"] and trades[0]["r"] < -0.99


def test_gap_bajo_el_stop_sale_a_la_apertura(forzar):
    barras = [(100, 101, 99, 100)] * 10 + [(100, 101, 99.8, 100.5), (100.4, 101, 99.9, 100.6), (90, 91, 89, 90)]
    trades, _, _ = forzar(serie(barras), 270)
    assert trades[0]["r"] < -1.5          # el gap pierde más de 1R: así es el mercado
