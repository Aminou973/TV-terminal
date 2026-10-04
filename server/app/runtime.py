"""Process-wide runtime singletons (bus, store, ingest, service).

Created in main.py's lifespan, before any request is served.
"""

from __future__ import annotations

from app.alerts.engine import AlertEngine
from app.candles.bus import EventBus
from app.config import Settings
from app.db.database import database
from app.ingest.manager import IngestManager
from app.paper.engine import PaperEngine
from app.store.parquet import CandleParquetStore
from app.store.service import CandleService


class Runtime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.bus = EventBus(maxsize=settings.bus_queue_size)
        self.store = CandleParquetStore(settings.data_dir)
        self.ingest = IngestManager(settings, self.bus, self.store)
        self.service = CandleService(self.store, self.ingest)
        self.alerts = AlertEngine(database, self.bus)
        self.paper = PaperEngine(database, self.bus, price_lookup=self.service.last_price)
        self.ingest.tick_listeners += [self.alerts.on_tick, self.paper.on_tick]
        self.flush_task = None

    async def start(self) -> None:
        import asyncio

        self.alerts.reload()
        self.paper.reload()
        await self.ingest.start()
        self.flush_task = asyncio.create_task(self.store.flush_loop(2.0))

    async def stop(self) -> None:
        import asyncio

        if self.flush_task is not None:
            self.flush_task.cancel()
        await self.ingest.stop()


runtime: Runtime | None = None