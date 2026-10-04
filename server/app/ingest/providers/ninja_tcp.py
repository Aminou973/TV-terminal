"""NinjaTrader 8 bridge provider.

Connects to the OpenTerminal Bridge AddOn (see nt-bridge/) which listens on a
localhost TCP socket and speaks newline-delimited JSON both ways. Zero
dependencies inside NT8; this side is a plain asyncio TCP client.

NT → backend:
  {"type":"tick","symbol":"ES","contract":"ES 12-25","ts_ms":…,"price":…,"size":3,"bid":…,"ask":…}
  {"type":"book","symbol":"ES","bids":[[p,s],…],"asks":[[p,s],…]}
  {"type":"bars","symbol":"ES","tf":"1m","bars":[[time_s,o,h,l,c,v],…]}   # backfill on connect
  {"type":"status","message":"…"}
  {"type":"order_update","ref":"…","order_id":"…","state":"Filled","filled":1,"avg_price":…,"error":""}
backend → NT (only honoured when routing is enabled in the AddOn window):
  {"type":"order",…} / {"type":"cancel","ref":"…"}
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from app.models import Bar, Tick

log = logging.getLogger("openterm.ninja")


class NinjaTcpProvider:
    name = "ninja"

    def __init__(
        self,
        host: str,
        port: int,
        on_bars: Optional[Callable[[str, str, list[Bar]], None]] = None,
        on_book: Optional[Callable[[str, list, list], None]] = None,
        on_order_update: Optional[Callable[[dict], None]] = None,
    ):
        self.host = host
        self.port = port
        self.on_bars = on_bars
        self.on_book = on_book
        self.on_order_update = on_order_update
        self.contracts: dict[str, str] = {}  # symbol root -> front contract seen in ticks ("ES" -> "ES 12-25")
        self._writer: Optional[asyncio.StreamWriter] = None

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    async def send(self, frame: dict) -> None:
        if not self.connected:
            raise ConnectionError("NinjaTrader bridge is not connected")
        self._writer.write((json.dumps(frame) + "\n").encode())
        await self._writer.drain()

    async def run(self, sink) -> None:
        while True:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port)
                self._writer = writer
                log.info("connected to NinjaTrader bridge at %s:%s", self.host, self.port)
                try:
                    await self._pump(reader, sink)
                finally:
                    self._writer = None
                    writer.close()
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
            try:
                await self.handle(frame, sink)
            except (KeyError, TypeError, ValueError) as e:
                log.warning("NT bridge: bad %s frame (%s)", frame.get("type"), e)

    async def handle(self, frame: dict[str, Any], sink) -> None:
        ftype = frame.get("type")
        if ftype == "tick":
            if frame.get("contract"):
                self.contracts[frame["symbol"]] = frame["contract"]
            await sink(self._frame_to_tick(frame))
        elif ftype == "book" and self.on_book is not None:
            self.on_book(frame["symbol"], frame.get("bids", []), frame.get("asks", []))
        elif ftype == "bars" and self.on_bars is not None:
            symbol = frame["symbol"]
            bars = [
                Bar(symbol=symbol, time=int(b[0]), open=b[1], high=b[2], low=b[3], close=b[4], volume=b[5])
                for b in frame.get("bars", [])
            ]
            self.on_bars(symbol, frame.get("tf", "1m"), bars)
        elif ftype == "order_update" and self.on_order_update is not None:
            self.on_order_update(frame)
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
