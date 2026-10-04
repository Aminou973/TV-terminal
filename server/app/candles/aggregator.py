"""Tick → 1m candle aggregation with throttled forming-bar events."""

from __future__ import annotations

import time
from typing import Callable, Optional

from app.candles.bus import EventBus
from app.models import Bar, BarEvent, Tick


class QuoteEvent:
    __slots__ = ("symbol", "price", "ts_ms", "bid", "ask")

    def __init__(self, symbol: str, price: float, ts_ms: int, bid: float = 0.0, ask: float = 0.0):
        self.symbol = symbol
        self.price = price
        self.ts_ms = ts_ms
        self.bid = bid
        self.ask = ask

    def to_ws(self) -> dict:
        return {
            "type": "quote",
            "symbol": self.symbol,
            "last": self.price,
            "bid": self.bid,
            "ask": self.ask,
            "ts_ms": self.ts_ms,
        }


class TradeEvent:
    """One print, for the recent-trades panel (unthrottled)."""

    __slots__ = ("symbol", "price", "size", "side", "ts_ms")

    def __init__(self, symbol: str, price: float, size: float, side: str, ts_ms: int):
        self.symbol = symbol
        self.price = price
        self.size = size
        self.side = side
        self.ts_ms = ts_ms

    def to_ws(self) -> dict:
        return {
            "type": "trade",
            "symbol": self.symbol,
            "price": self.price,
            "size": self.size,
            "side": self.side,
            "ts_ms": self.ts_ms,
        }


class BookEvent:
    """Order-book snapshot: bids high→low, asks low→high, as [price, size]."""

    __slots__ = ("symbol", "bids", "asks", "ts_ms")

    def __init__(self, symbol: str, bids: list[list[float]], asks: list[list[float]], ts_ms: int):
        self.symbol = symbol
        self.bids = bids
        self.asks = asks
        self.ts_ms = ts_ms

    def to_ws(self) -> dict:
        return {"type": "book", "symbol": self.symbol, "bids": self.bids, "asks": self.asks, "ts_ms": self.ts_ms}


def infer_side(tick: Tick, prev: Optional[Tick]) -> str:
    """Aggressor side: feed-provided, else quote rule, else tick rule."""
    if tick.side in ("buy", "sell"):
        return tick.side
    if tick.bid and tick.ask:
        if tick.price >= tick.ask:
            return "buy"
        if tick.price <= tick.bid:
            return "sell"
    if prev is not None:
        if tick.price > prev.price:
            return "buy"
        if tick.price < prev.price:
            return "sell"
    return ""


class CandleAggregator:
    """Builds live 1m candles from ticks and publishes bar/quote events.

    `on_closed` is a sync hook (usually CandleStore.append) called with each
    freshly closed 1m bar.
    """

    def __init__(self, bus: EventBus, throttle_s: float = 0.2, quote_throttle_s: float = 0.25):
        self.bus = bus
        self.throttle_s = throttle_s
        self.quote_throttle_s = quote_throttle_s
        self._forming: dict[str, Bar] = {}
        self._last_push: dict[str, float] = {}
        self._last_quote_push: dict[str, float] = {}
        self.last_tick: dict[str, Tick] = {}
        self.on_closed: Optional[Callable[[Bar], None]] = None

    # -- main entry -----------------------------------------------------------
    def process_tick(self, tick: Tick) -> None:
        symbol = tick.symbol
        minute_s = (tick.ts_ms // 60_000) * 60
        bar = self._forming.get(symbol)

        if bar is not None and bar.time != minute_s:
            self._emit_closed(bar, tick.provider)
            bar = None

        if bar is None:
            bar = Bar(
                symbol=symbol,
                time=minute_s,
                open=tick.price,
                high=tick.price,
                low=tick.price,
                close=tick.price,
                volume=0.0,
            )
            self._forming[symbol] = bar

        bar.high = max(bar.high, tick.price)
        bar.low = min(bar.low, tick.price)
        bar.close = tick.price
        bar.volume += tick.size

        side = infer_side(tick, self.last_tick.get(symbol))
        self.last_tick[symbol] = tick
        self.bus.publish(TradeEvent(symbol, tick.price, tick.size, side, tick.ts_ms))
        self._maybe_push_forming(bar, tick.provider)
        self._maybe_push_quote(tick)

    def forming_bar(self, symbol: str) -> Optional[Bar]:
        return self._forming.get(symbol)

    # -- internals ------------------------------------------------------------
    def _emit_closed(self, bar: Bar, provider: str) -> None:
        if self.on_closed is not None:
            self.on_closed(bar)
        self.bus.publish(BarEvent(bar=bar, tf="1m", closed=True, provider=provider))

    def _maybe_push_forming(self, bar: Bar, provider: str) -> None:
        now = time.monotonic()
        last = self._last_push.get(bar.symbol, 0.0)
        if now - last >= self.throttle_s:
            self._last_push[bar.symbol] = now
            self.bus.publish(BarEvent(bar=bar, tf="1m", closed=False, provider=provider))

    def _maybe_push_quote(self, tick: Tick) -> None:
        now = time.monotonic()
        last = self._last_quote_push.get(tick.symbol, 0.0)
        if now - last >= self.quote_throttle_s:
            self._last_quote_push[tick.symbol] = now
            self.bus.publish(
                QuoteEvent(tick.symbol, tick.price, tick.ts_ms, tick.bid, tick.ask)
            )