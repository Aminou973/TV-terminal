"""Candle service: unified read access for the API layer."""

from __future__ import annotations

import time

from app.candles.resample import TF_SECONDS, resample, validate_tf
from app.models import Bar
from app.store.parquet import CandleParquetStore


class CandleService:
    def __init__(self, store: CandleParquetStore, aggregator_holder):
        """`aggregator_holder` is the IngestManager (for forming-bar access)."""
        self.store = store
        self.ingest = aggregator_holder

    def history(
        self, symbol: str, tf: str, from_s: int | None, to_s: int | None, limit: int | None = None
    ) -> list[Bar]:
        """Bars in [from_s, to_s]; with `limit` and no `from_s`, the latest `limit` bars up to `to_s`."""
        validate_tf(tf)
        if limit is not None and from_s is None:
            # read only as many days as `limit` bars can span (x2 for closed sessions)
            end = to_s if to_s is not None else int(time.time())
            from_s = end - limit * TF_SECONDS[tf] * 2 - 86400
        bars = self.store.read_1m(symbol, from_s, to_s)
        # include the live forming bar so charts have no gap at the right edge
        forming = self.ingest.aggregator.forming_bar(symbol)
        if forming is not None and (to_s is None or forming.time <= to_s):
            if bars and bars[-1].time == forming.time:
                bars[-1] = forming
            else:
                bars.append(forming)
        out = resample(bars, tf)
        return out[-limit:] if limit is not None else out

    def stats(self, symbol: str) -> dict | None:
        """Session stats from the daily bars: open/high/low/volume and change vs prior close."""
        days = self.history(symbol, "1D", None, None, limit=2)
        if not days:
            return None
        today = days[-1]
        prev_close = days[-2].close if len(days) > 1 else today.open
        return {
            "symbol": symbol,
            "last": today.close,
            "open": today.open,
            "high": today.high,
            "low": today.low,
            "volume": today.volume,
            "prev_close": prev_close,
            "change": today.close - prev_close,
            "change_pct": (today.close / prev_close - 1) * 100 if prev_close else 0.0,
        }

    def screen(self, tf: str = "1D", lookback: int = 120) -> list[dict]:
        from app.store.screener import metrics

        rows = []
        for info in self.symbols():
            bars = self.history(info["symbol"], tf, None, None, limit=lookback)
            m = metrics(info["symbol"], info["market"], bars)
            if m is not None:
                rows.append(m)
        return rows

    def last_price(self, symbol: str) -> float | None:
        """Live last trade, else the close of the newest stored 1m bar."""
        tick = self.ingest.aggregator.last_tick.get(symbol)
        if tick is not None:
            return tick.price
        bars = self.store.last_bars(symbol, 1)
        return bars[-1].close if bars else None

    def quote(self, symbols: list[str]) -> list[dict]:
        out = []
        for sym in symbols:
            tick = self.ingest.aggregator.last_tick.get(sym)
            if tick is None:
                # no live feed for it (yet): serve the last stored close, flagged stale
                bars = self.store.last_bars(sym, 1)
                if bars:
                    b = bars[-1]
                    out.append({"symbol": sym, "last": b.close, "bid": 0.0, "ask": 0.0, "ts_ms": b.time * 1000, "stale": True})
                continue
            out.append(
                {
                    "symbol": sym,
                    "last": tick.price,
                    "bid": tick.bid,
                    "ask": tick.ask,
                    "ts_ms": tick.ts_ms,
                }
            )
        return out

    def symbols(self) -> list[dict]:
        known = set(self.store.symbols())
        known.update(self.ingest.aggregator.last_tick.keys())
        return [{"symbol": s, "market": _market_hint(s)} for s in sorted(known)]


def _market_hint(symbol: str) -> str:
    from app.candles.sessions import market_class

    return market_class(symbol)