"""Core data models shared across the candle pipeline."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass(slots=True)
class Tick:
    symbol: str
    ts_ms: int
    price: float
    size: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    provider: str = ""
    side: str = ""  # "buy" | "sell" | "" (aggressor side, when the feed knows it)


@dataclass(slots=True)
class Bar:
    """One OHLCV bar. `time` is the bucket START in unix seconds (TradingView convention)."""

    symbol: str
    time: int  # seconds
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def to_dict(self) -> dict:
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }


@dataclass(slots=True)
class BarEvent:
    """A forming or closed bar pushed to subscribers."""

    bar: Bar
    tf: str  # timeframe id this event belongs to (always "1m" from the aggregator)
    closed: bool
    provider: str = ""

    def to_ws(self) -> dict:
        return {
            "type": "bar",
            "symbol": self.bar.symbol,
            "tf": self.tf,
            "bar": self.bar.to_dict(),
            "closed": self.closed,
        }


def now_ms() -> int:
    return int(time.time() * 1000)

@dataclass(slots=True)
class UserEvent:
    """A message for one user's open WebSocket connections (alerts, orders)."""

    user_id: int
    payload: dict
