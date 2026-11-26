"""El motor de la web (JS) debe dar exactamente lo mismo que el de la investigación (Python), con datos reales."""
import json
import pathlib
import shutil
import subprocess

import pandas as pd
import pytest

from backtest.cartera_nucleo import posicion_objetivo
from backtest.patrones import detectar
from trend_risk import analyze

RAIZ = pathlib.Path(__file__).parent.parent
DATOS = RAIZ / "data/historico20"
ACTIVOS = ["SPY", "NAFTRACISHRS.MX", "AAPL", "WALMEX.MX"]
pytestmark = pytest.mark.skipif(shutil.which("node") is None or not DATOS.exists(), reason="requiere node y data/historico20")


def js(archivo):
    out = subprocess.run(["node", str(RAIZ / "tests/js/paridad.js"), str(archivo), "400"], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@pytest.mark.parametrize("t", ACTIVOS)
def test_paridad_motor(t):
    f = DATOS / f"{t}.csv"
    df = pd.read_csv(f, parse_dates=["date"]).set_index("date")
    df = df[(df.close > 0) & (df.high >= df.low)]
    j = js(f)
    # 1) filtro de régimen mensual (historia completa)
    py = "".join(str(int(x)) for x in posicion_objetivo(df, "sma200_mensual").values)
    assert py[:-1] == j["regimen"][:-1]
    # 2) patrones de velas (tras calentamiento de 260 velas)
    det = detectar(df).loc[pd.to_datetime(j["fechas"])]
    for k, bits in j["patrones"].items():
        assert "".join(str(int(x)) for x in det[k].values)[260:] == bits[260:], k
    # 3) plan del motor de riesgo sobre las mismas 400 velas
    p = analyze(df.iloc[-400:], "X").to_dict()
    assert (p["fase"], p["orden"]) == (j["plan"]["fase"], j["plan"]["orden"])
    for a, b in ((p["stop_loss"], j["plan"]["stop"]), (p["entrada"], j["plan"]["entrada"]), (p["resistencia_1"], j["plan"]["r1"])):
        assert abs(a - b) <= 0.011
