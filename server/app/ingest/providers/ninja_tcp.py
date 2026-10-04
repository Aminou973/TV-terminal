"""NinjaTrader 8 bridge provider.

Connects to the TvBridgePublisher AddOn (see nt-bridge/) which listens on a
localhost TCP socket and streams newline-delimited JSON tick frames. Zero
dependencies inside NT8; this side is a plain asyncio TCP client.

Frame contract (NDJSON, one JSON object per line):
  {"type":"tick","symbol":"ES","ts_ms":1725000000000,"price":4821.25,"size":3,"bid":4821.00,"ask":4821.50}
  {"type":"status","message":"subscribed ES"}                     # informational
  {"type":"bars","symbol":"ES","tf":"1m","bars":[[time_s,o,h,l,c,v],…]}  # historical dump (phase 1.5)
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.models import Tick

log = logging.getLogger("openterm.ninja")


class NinjaTcpProvider:
    name = "ninja"

    def __init__(self, host: str, port: int, on_bars=None):
        self.host = host
        self.port = port
        self.on_bars = on_bars  # callable(symbol, tf, bars:list[Bar]) for historical dumps

    async def run(self, sink) -> None:
        while True:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port)
                log.info("connected to NinjaTrader bridge at %s:%s", self.host, self.port)
                await self._pump(reader, sink)
            except (ConnectionError, OSError) as e:
                log.debug("NT bridge not reachable (%s); retrying in 2s", e)
                await asyncio.sleep(2.0)

    async def _pump(self, reader: asyncio.StreamReader, sink) -> None:
        while True:
            line = await reader.readline()
            if not line:
                raise ConnectionError("NT bridge closed the connection")
            try:
                frame: dict[str, Any] = json.loads(line)
            except json.JSONDecodeError:
                continue
            ftype = frame.get("type")
            if ftype == "tick":
                await sink(self._frame_to_tick(frame))
            elif ftype == "bars" and self.on_bars is not None:
                from app.models import Bar

                symbol = frame["symbol"]
                bars = [
                    Bar(symbol=symbol, time=int(b[0]), open=b[1], high=b[2], low=b[3], close=b[4], volume=b[5])
                    for b in frame.get("bars", [])
                ]
                self.on_bars(symbol, frame.get("tf", "1m"), bars)
            elif ftype == "status":
                log.info("NT bridge: %s", frame.get("message", ""))

    def _frame_to_tick(self, frame: dict[str, Any]) -> Tick:
        ts_ms = frame.get("ts_ms")
        if ts_ms is None:
            # accept ISO timestamps as fallback
            ts = frame.get("ts")
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00")) if isinstance(ts, str) else datetime.now(tz=timezone.utc)
            ts_ms = int(dt.timestamp() * 1000)
        return Tick(
            symbol=frame["symbol"],
            ts_ms=int(ts_ms),
            price=float(frame["price"]),
            size=float(frame.get("size", 0.0)),
            bid=float(frame.get("bid", 0.0)),
            ask=float(frame.get("ask", 0.0)),
            provider=self.name,
        )