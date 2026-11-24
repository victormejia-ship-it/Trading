#!/usr/bin/env python3
"""CLI: genera el Plan de Ejecución.

Uso:
  python analyze.py --csv data/AAPL.csv data/BTC-USD.csv [--news news.json] [--out reporte.md] [--json]
  python analyze.py --tickers AAPL NVDA SPY        # requiere `pip install yfinance` y acceso a internet

CSV: columnas date,open,high,low,close,volume (diario, >= 220 filas).
news.json: {"AAPL": {"score": -0.4, "nota": "Investigación antimonopolio UE"}}  score en [-1, 1].
"""
import argparse, json, pathlib, sys
import pandas as pd
from trend_risk import analyze, Config
from trend_risk.report import report_md


def load_csv(path):
    df = pd.read_csv(path)
    df.columns = [c.strip().lower().replace("adj close", "adj_close") for c in df.columns]
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")[["open", "high", "low", "close", "volume"]].dropna()


def load_yf(t):
    import yfinance as yf
    df = yf.download(t, period="2y", interval="1d", auto_adjust=True, progress=False, multi_level_index=False)
    df.columns = [c.lower() for c in df.columns]
    return df[["open", "high", "low", "close", "volume"]].dropna()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", nargs="*", default=[])
    ap.add_argument("--tickers", nargs="*", default=[])
    ap.add_argument("--news")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--riesgo", type=float, default=0.01)
    a = ap.parse_args()
    news = json.loads(pathlib.Path(a.news).read_text()) if a.news else {}
    cfg = Config(riesgo_por_operacion=a.riesgo)
    plans = []
    for src, name, loader in [(p, pathlib.Path(p).stem.upper(), load_csv) for p in a.csv] + \
                             [(t, t.upper(), load_yf) for t in a.tickers]:
        try:
            plans.append(analyze(loader(src), name, cfg, news.get(name)))
        except Exception as e:
            print(f"[ERROR] {name}: {e}", file=sys.stderr)
    out = json.dumps([p.to_dict() for p in plans], ensure_ascii=False, indent=2) if a.json else report_md(plans)
    if a.out:
        pathlib.Path(a.out).write_text(out)
    print(out)


if __name__ == "__main__":
    main()
