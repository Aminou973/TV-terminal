"""Process-wide runtime singletons (bus, store, ingest, service).

Created in main.py's lifespan, before any request is served.
"""

from __future__ import annotations

from app.candles.bus import EventBus
from app.config import Settings
from app.ingest.manager import IngestManager
from app.store.parquet import CandleParquetStore
from app.store.service import CandleService


class Runtime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.bus = EventBus(maxsize=settings.bus_queue_size)
        self.store = CandleParquetStore(settings.data_dir)
        self.ingest = IngestManager(settings, self.bus, self.store)
        self.service = CandleService(self.store, self.ingest)
        self.flush_task = None

    async def start(self) -> None:
        import asyncio

        await self.ingest.start()
        self.flush_task = asyncio.create_task(self.store.flush_loop(2.0))

    async def stop(self) -> None:
        import asyncio

        if self.flush_task is not None:
            self.flush_task.cancel()
        await self.ingest.stop()


runtime: Runtime | None = None