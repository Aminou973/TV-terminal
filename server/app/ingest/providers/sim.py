"""Synthetic tick generator — a live ES-like feed for development without NT8.

Not a historical replay: it emits ticks with real wall-clock timestamps so the
platform behaves exactly like a live session (form bars, closes, persistence).
"""

from __future__ import annotations

import asyncio
import random
import time

from app.models import Tick, now_ms


class SimProvider:
    name = "sim"

    def __init__(self, symbol: str = "SIM:ES", seed: int = 7, tick_interval_s: float = 0.2, on_book=None):
        self.symbol = symbol
        self.rng = random.Random(seed)
        self.tick_interval_s = tick_interval_s
        self._price = 4800.0
        self._last_close = 4800.0
        self.on_book = on_book  # callable(symbol, bids, asks) for a synthetic 10-level book

    async def run(self, sink) -> None:
        while True:
            # mean-reverting random walk with occasional volatility bursts
            burst = self.rng.random() < 0.02
            sigma = 2.5 if burst else 0.75
            self._price += self.rng.gauss(0, sigma)
            self._price = max(1.0, self._price)
            size = round(self.rng.expovariate(1 / 3), 0)
            bid = round(self._price - 0.25, 2)
            ask = round(self._price + 0.25, 2)
            await sink(
                Tick(
                    symbol=self.symbol,
                    ts_ms=now_ms(),
                    price=round(self._price, 2),
                    size=size,
                    bid=bid,
                    ask=ask,
                    provider=self.name,
                )
            )
            if self.on_book is not None:
                self.on_book(self.symbol, *self._book(bid, ask))
            await asyncio.sleep(self.tick_interval_s)

    def _book(self, bid: float, ask: float) -> tuple[list, list]:
        tick = 0.25
        bids = [[round(bid - i * tick, 2), float(self.rng.randint(5, 120))] for i in range(10)]
        asks = [[round(ask + i * tick, 2), float(self.rng.randint(5, 120))] for i in range(10)]
        return bids, asks