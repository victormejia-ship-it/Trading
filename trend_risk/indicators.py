"""Indicadores técnicos (convención Wilder para RSI y ATR)."""
import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = wilder(d.clip(lower=0), n)
    dn = wilder(-d.clip(upper=0), n)
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(dn != 0, 100.0)


def macd(close: pd.Series, fast=12, slow=26, signal=9):
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return line, sig, line - sig


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    return wilder(tr, n)


def pivots(series: pd.Series, k: int, kind: str) -> pd.Series:
    """Pivotes estructurales confirmados: extremo de una ventana de 2k+1 velas."""
    w = series.rolling(2 * k + 1, center=True)
    ext = w.min() if kind == "low" else w.max()
    return series[(series == ext)].dropna()


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    c = df["close"]
    df["sma20"], df["sma50"], df["sma200"] = sma(c, 20), sma(c, 50), sma(c, 200)
    df["rsi14"] = rsi(c, 14)
    df["macd"], df["macd_sig"], df["macd_hist"] = macd(c)
    df["atr14"] = atr(df, 14)
    df["atr50"] = atr(df, 50)
    if "volume" in df:
        df["vol20"] = sma(df["volume"], 20)
    return df
