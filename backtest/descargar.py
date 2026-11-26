"""Descarga precios diarios ajustados (yfinance) y tasas de interés (FRED, sin clave) para investigación offline.

  python -m backtest.descargar data/historico 4y
  python -m backtest.descargar data/historico20 max
"""
import io, json, pathlib, sys
import pandas as pd
import requests
import yfinance as yf

FRED = {  # tasas mensuales en % anual
    "tasa_mx_3m": "IR3TIB01MXM156N",   # México, interbancaria 3 meses (OCDE) ~ CETES
    "tasa_mx_descuento": "INTDSRMXM193N",
    "tasa_us_3m": "TB3MS",             # EE. UU., T-bills 3 meses
}


def tasas(out: pathlib.Path):
    for nombre, sid in FRED.items():
        try:
            r = requests.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", timeout=30,
                             headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            df = pd.read_csv(io.StringIO(r.text))
            df.columns = ["date", "tasa"]
            df["tasa"] = pd.to_numeric(df["tasa"], errors="coerce")
            df.dropna().to_csv(out / f"{nombre}.csv", index=False)
            print(nombre, len(df), df.dropna().iloc[-1].tolist())
        except Exception as e:
            print("sin tasa", nombre, e, file=sys.stderr)


def main(out="data/historico", periodo="4y", universo="backtest/universo.json"):
    u = json.loads(pathlib.Path(universo).read_text())
    o = pathlib.Path(out); o.mkdir(parents=True, exist_ok=True)
    for t in u["indices"] + u["sic"] + u["bmv"] + u.get("global", []):
        df = yf.download(t, period=periodo, interval="1d", auto_adjust=True, progress=False, multi_level_index=False, threads=False)
        if not len(df):
            print("sin datos", t, file=sys.stderr); continue
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
        df = df[df.close > 0]
        df.index = pd.to_datetime(df.index).tz_localize(None)
        df.round(6).reset_index(names="date").to_csv(o / f"{t.replace('^', '')}.csv", index=False)
        print(t, len(df), df.index[0].date())
    if periodo == "max":
        tasas(o)


if __name__ == "__main__":
    main(*sys.argv[1:])
