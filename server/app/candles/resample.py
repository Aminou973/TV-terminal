"""Timeframe definitions and 1m → higher-TF resampling.

Intraday bars are UTC-anchored (floor to multiples); daily bars are
session-anchored (see sessions.py) so CME dailies match TradingView.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from app.candles.sessions import session_day_start_s, session_period_start_s
from app.models import Bar

_TF = re.compile(r"^(\d{1,4})(m|h)$|^(1)(D|W|M)$")
_UNIT = {"m": 60, "h": 3600, "D": 86400, "W": 604800, "M": 2678400}  # M nominal (31d), for sizing reads


def tf_seconds(tf: str) -> int | None:
    """Seconds for an interval id: Nm (1-1440), Nh (1-24), 1D, 1W, 1M; None if invalid."""
    m = _TF.match(tf or "")
    if not m:
        return None
    n = int(m.group(1) or m.group(3))
    unit = m.group(2) or m.group(4)
    if n < 1 or (unit == "m" and n > 1440) or (unit == "h" and n > 24):
        return None
    return n * _UNIT[unit]


class _TfSeconds(Mapping):
    """Read-only mapping view over tf_seconds(): `tf in TF_SECONDS`, `TF_SECONDS[tf]`.

    Any custom interval (7m, 90m, 3h …) is valid; iteration lists the common ones.
    """

    COMMON = ("1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1D", "1W", "1M")

    def __getitem__(self, tf: str) -> int:
        secs = tf_seconds(tf) if isinstance(tf, str) else None
        if secs is None:
            raise KeyError(tf)
        return secs

    def __contains__(self, tf: object) -> bool:
        return isinstance(tf, str) and tf_seconds(tf) is not None

    def __iter__(self):
        return iter(self.COMMON)

    def __len__(self) -> int:
        return len(self.COMMON)


TF_SECONDS = _TfSeconds()


def bucket_start_s(ts_s: int, tf: str, symbol: str) -> int:
    if tf == "1D":
        return session_day_start_s(ts_s, symbol)
    if tf in ("1W", "1M"):
        return session_period_start_s(ts_s, symbol, tf[1])
    secs = TF_SECONDS[tf]
    if secs >= 86400:  # 1D handled above; a multi-hour bucket longer than a day isn't offered
        return session_day_start_s(ts_s, symbol)
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