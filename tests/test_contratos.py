"""Contratos de datos: lo que la página espera de cada archivo publicado en public/data."""
import json
import pathlib

D = pathlib.Path(__file__).parent.parent / "public/data"
cargar = lambda n: json.loads((D / n).read_text())


def test_plan():
    p = cargar("plan.json")
    ids = {x["id"] for x in p["procesos"]}
    assert "CETES" in ids and len(p["procesos"]) >= 3
    for x in p["procesos"]:
        assert {"id", "nombre", "plazo", "tipo", "como", "compra", "venta", "evidencia"} <= set(x)
        if x["tipo"] == "filtro":
            assert x["simbolo"] and x["regla"] == "sma200_mensual"
            assert {"t1", "t2", "todo"} <= set(x["evidencia"])
    for k, pf in p["perfiles"].items():
        assert abs(sum(pf["pesos"].values()) - 1) < 1e-9, k
        assert set(pf["pesos"]) <= ids, k
        assert pf["con_filtro"]["todo"]["max_dd_pct"] < 0


def test_retiros():
    r = cargar("retiros.json")
    for k in ("conservador", "moderado", "agresivo"):
        e = r["perfiles"][k]["sma200_mensual"]
        assert 0 < e["no_se_acaba"]["peor_mxn"] <= e["renta_perpetua"]["peor_mxn"]


def test_patrones():
    p = cargar("patrones.json")
    assert len(p["patrones"]) >= 10
    for x in p["patrones"].values():
        t = x["tramos"]["todo"]["10"]
        assert {"n", "ventaja_pct", "p_sube", "p_lateral", "p_baja"} <= set(t)
        assert abs(t["p_sube"] + t["p_lateral"] + t["p_baja"] - 100) < 0.5


def test_contexto():
    c = cargar("contexto.json")
    assert c["actualizado"] and c["puntos"] and c["casas_de_bolsa"]["opciones"]
    for x in c["puntos"]:
        assert x["fuentes"] and all(u.startswith("https://") for u in x["fuentes"])


def test_mundo():
    m = cargar("mundo.json")
    assert m["regla"] == "sma200_mensual" and len(m["mercados"]) >= 20
    assert m["resumen"]["filtro_reduce_caida_en_ambos"] <= m["resumen"]["mercados_con_dos_tramos"]
    for t, x in m["mercados"].items():
        assert {"nombre", "grupo", "desde", "tramos"} <= set(x), t
