"""Candle service: unified read access for the API layer."""

from __future__ import annotations

from app.candles.resample import resample, validate_tf
from app.models import Bar
from app.store.parquet import CandleParquetStore


class CandleService:
    def __init__(self, store: CandleParquetStore, aggregator_holder):
        """`aggregator_holder` is the IngestManager (for forming-bar access)."""
        self.store = store
        self.ingest = aggregator_holder

    def history(self, symbol: str, tf: str, from_s: int | None, to_s: int | None) -> list[Bar]:
        validate_tf(tf)
        bars = self.store.read_1m(symbol, from_s, to_s)
        # include the live forming bar so charts have no gap at the right edge
        forming = self.ingest.aggregator.forming_bar(symbol)
        if forming is not None and (to_s is None or forming.time <= to_s):
            if bars and bars[-1].time == forming.time:
                bars[-1] = forming
            else:
                bars.append(forming)
        return resample(bars, tf)

    def quote(self, symbols: list[str]) -> list[dict]:
        out = []
        for sym in symbols:
            tick = self.ingest.aggregator.last_tick.get(sym)
            if tick is None:
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