"""Provider protocol: anything that yields ticks into the ingest manager."""

from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from app.models import Tick

# sink pushes a tick into the ingest queue
TickSink = Callable[[Tick], Awaitable[None]]


class TickProvider(Protocol):
    name: str

    async def run(self, sink: TickSink) -> None: ...