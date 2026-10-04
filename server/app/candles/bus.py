"""In-process event bus feeding WebSocket subscribers.

publish() is fire-and-forget: a full subscriber queue drops the oldest event
(liveness beats completeness — clients gap-fill via REST on reconnect).
"""

from __future__ import annotations

import asyncio
from collections.abc import Set
from typing import Any


class EventBus:
    def __init__(self, maxsize: int = 2000):
        self._subs: Set[asyncio.Queue] = set()
        self._maxsize = maxsize

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._maxsize)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, event: Any) -> None:
        for q in self._subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()  # drop oldest
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass