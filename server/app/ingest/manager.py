"""Ingest manager: runs all providers, funnels ticks into the candle engine."""

from __future__ import annotations

import asyncio
import logging
import time

from app.candles.aggregator import BookEvent, CandleAggregator
from app.candles.bus import EventBus
from app.config import Settings
from app.ingest.providers.ccxt_provider import CcxtProvider
from app.ingest.providers.ninja_tcp import NinjaTcpProvider
from app.ingest.providers.sim import SimProvider
from app.models import Tick, now_ms
from app.store.parquet import CandleParquetStore

log = logging.getLogger("openterm.ingest")


class IngestManager:
    def __init__(self, settings: Settings, bus: EventBus, store: CandleParquetStore):
        self.settings = settings
        self.bus = bus
        self.store = store
        self.aggregator = CandleAggregator(bus, throttle_s=settings.bar_throttle)
        self.aggregator.on_closed = store.append_bar
        self.queue: asyncio.Queue[Tick] = asyncio.Queue(maxsize=10_000)
        self._tasks: list[asyncio.Task] = []
        self.provider_status: dict[str, str] = {}
        self.last_book: dict[str, BookEvent] = {}
        self._last_book_push: dict[str, float] = {}
        self.book_throttle_s = 0.25
        # sync callbacks run for every tick after candle aggregation (alerts, paper fills)
        self.tick_listeners: list = []

    # -- lifecycle -------------------------------------------------------------
    async def start(self) -> None:
        providers = []
        if self.settings.replay_enabled:
            providers.append(
                SimProvider(self.settings.replay_symbol, seed=self.settings.replay_seed, on_book=self.publish_book)
            )
        if self.settings.ninja_enabled:
            providers.append(
                NinjaTcpProvider(
                    self.settings.ninja_tcp_host,
                    self.settings.ninja_tcp_port,
                    on_bars=self._on_historical_bars,
                )
            )
        if self.settings.ccxt_enabled and self.settings.ccxt_symbols:
            providers.append(
                CcxtProvider(self.settings.ccxt_exchange, self.settings.ccxt_symbols, self.store)
            )

        self._tasks.append(asyncio.create_task(self._consume_loop(), name="ingest-consume"))
        for p in providers:
            self.provider_status[p.name] = "running"
            self._tasks.append(
                asyncio.create_task(self._run_provider(p), name=f"ingest-{p.name}")
            )

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self.store.flush()

    # -- internals ---------------------------------------------------------------
    async def _run_provider(self, provider) -> None:
        """Run a provider forever; restart with backoff on unexpected death."""
        while True:
            try:
                await provider.run(self._sink)
                self.provider_status[provider.name] = "stopped"
                log.info("provider %s stopped cleanly", provider.name)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — providers must never kill the server
                self.provider_status[provider.name] = f"error: {e}"
                log.exception("provider %s crashed: %s", provider.name, e)
            await asyncio.sleep(2.0)

    async def _sink(self, tick: Tick) -> None:
        try:
            self.queue.put_nowait(tick)
        except asyncio.QueueFull:
            # drop the tick before we ever block a provider
            log.warning("ingest queue full; dropped tick for %s", tick.symbol)

    async def _consume_loop(self) -> None:
        while True:
            tick = await self.queue.get()
            try:
                self.aggregator.process_tick(tick)
                for listener in self.tick_listeners:
                    listener(tick)
            except Exception:  # noqa: BLE001 — one bad tick must not stop the engine
                log.exception("failed processing tick %s", tick)

    def publish_book(self, symbol: str, bids: list, asks: list) -> None:
        """Providers call this with depth snapshots; throttled per symbol."""
        ev = BookEvent(symbol, bids, asks, now_ms())
        self.last_book[symbol] = ev
        now = time.monotonic()
        if now - self._last_book_push.get(symbol, 0.0) >= self.book_throttle_s:
            self._last_book_push[symbol] = now
            self.bus.publish(ev)

    def _on_historical_bars(self, symbol: str, tf: str, bars: list) -> None:
        if tf == "1m":
            self.store.append_bars(bars)
            log.info("NT bridge: stored %d historical 1m bars for %s", len(bars), symbol)