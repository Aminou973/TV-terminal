"""Timeframe definitions and 1m → higher-TF resampling.

Intraday bars are UTC-anchored (floor to multiples); daily bars are
session-anchored (see sessions.py) so CME dailies match TradingView.
"""

from __future__ import annotations

from app.candles.sessions import session_day_start_s
from app.models import Bar

# tf id -> seconds (intraday); "1D" handled via session anchoring
TF_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1D": 86400,
}


def bucket_start_s(ts_s: int, tf: str, symbol: str) -> int:
    if tf == "1D":
        return session_day_start_s(ts_s, symbol)
    secs = TF_SECONDS[tf]
    return (ts_s // secs) * secs


def validate_tf(tf: str) -> str:
    if tf not in TF_SECONDS:
        raise ValueError(f"unsupported timeframe: {tf}")
    return tf


def _merge(bars: list[Bar], start: int) -> Bar:
    return Bar(
        symbol=bars[0].symbol,
        time=start,
        open=bars[0].open,
        high=max(b.high for b in bars),
        low=min(b.low for b in bars),
        close=bars[-1].close,
        volume=sum(b.volume for b in bars),
    )


def resample(bars_1m: list[Bar], tf: str) -> list[Bar]:
    """Resample a sorted list of 1m bars into the target timeframe."""
    if tf == "1m" or not bars_1m:
        return bars_1m
    out: list[Bar] = []
    bucket: list[Bar] = []
    bucket_t = -1
    symbol = bars_1m[0].symbol
    for b in bars_1m:
        t = bucket_start_s(b.time, tf, symbol)
        if t != bucket_t:
            if bucket:
                out.append(_merge(bucket, bucket_t))
            bucket = [b]
            bucket_t = t
        else:
            bucket.append(b)
    if bucket:
        out.append(_merge(bucket, bucket_t))
    return out