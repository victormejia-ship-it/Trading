"""Descarga 4 años de precios diarios ajustados (yfinance) y los guarda como CSV para investigación offline."""
import json, pathlib, sys
import pandas as pd
import yfinance as yf

def main(out="data/historico", universo="backtest/universo.json"):
    u = json.loads(pathlib.Path(universo).read_text())
    o = pathlib.Path(out); o.mkdir(parents=True, exist_ok=True)
    for t in u["indices"] + u["sic"] + u["bmv"]:
        df = yf.download(t, period="4y", interval="1d", auto_adjust=True, progress=False, multi_level_index=False, threads=False)
        if not len(df):
            print("sin datos", t, file=sys.stderr); continue
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
        df.index = pd.to_datetime(df.index).tz_localize(None)
        df.round(6).reset_index(names="date").to_csv(o / f"{t.replace('^', '')}.csv", index=False)
        print(t, len(df))

if __name__ == "__main__":
    main(*sys.argv[1:])
