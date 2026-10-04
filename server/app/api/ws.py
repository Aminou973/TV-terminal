"""WebSocket streaming: /api/stream?token=JWT

Client → server:
  {"action":"subscribe","symbol":"ES","tf":"5m"}
  {"action":"unsubscribe","symbol":"ES","tf":"5m"}
  {"action":"subscribe_quotes","symbols":["ES","BINANCE-BTCUSDT"]}

Server → client:
  {"type":"bar","symbol":…,"tf":…,"bar":{"time","open","high","low","close","volume"},"closed":bool}
  {"type":"quote","symbol":…,"last":…,"bid":…,"ask":…,"ts_ms":…}

Higher timeframes are aggregated live from the 1m event stream per subscriber,
using the same bucketing as the history resample so displayed bars match
REST-loaded history exactly.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import runtime as runtime_module
from app.auth.security import decode_token
from app.candles.resample import TF_SECONDS, bucket_start_s
from app.candles.aggregator import QuoteEvent
from app.models import Bar, BarEvent

log = logging.getLogger("openterm.ws")
router = APIRouter()


class LiveTfAggregator:
    """Per-subscription live higher-TF builder, seeded from history on subscribe."""

    def __init__(self, symbol: str, tf: str):
        self.symbol = symbol
        self.tf = tf
        self.bucket: int | None = None
        self.closed: dict[int, Bar] = {}  # 1m bar time -> bar
        self.forming: Bar | None = None

    def seed(self, bars_1m: list[Bar]) -> None:
        for b in bars_1m:
            self._ingest(b, closed=True)

    def on_event(self, ev: BarEvent) -> list[tuple[Bar, bool]]:
        """Returns [(tf_bar, closed)] — prev bucket final (if just crossed) + current forming."""
        t = bucket_start_s(ev.bar.time, self.tf, self.symbol)
        out: list[tuple[Bar, bool]] = []
        if self.bucket is not None and t != self.bucket:
            out.append((self._aggregate(self.bucket), True))
            self.closed.clear()
            self.forming = None
        self.bucket = t
        self._ingest(ev.bar, closed=ev.closed)
        out.append((self._aggregate(t), False))
        return out

    def _ingest(self, bar: Bar, closed: bool) -> None:
        if closed:
            self.closed[bar.time] = bar
            if self.forming is not None and self.forming.time == bar.time:
                self.forming = None
        else:
            self.forming = bar

    def _aggregate(self, bucket_t: int) -> Bar:
        bars = [self.closed[t] for t in sorted(self.closed)]
        if self.forming is not None:
            bars.append(self.forming)
        if not bars:
            return Bar(self.symbol, bucket_t, 0.0, 0.0, 0.0, 0.0, 0.0)
        return Bar(
            symbol=self.symbol,
            time=bucket_t,
            open=bars[0].open,
            high=max(b.high for b in bars),
            low=min(b.low for b in bars),
            close=bars[-1].close,
            volume=sum(b.volume for b in bars),
        )


@router.websocket("/api/stream")
async def stream(ws: WebSocket):
    runtime = runtime_module.runtime
    if runtime is None:
        await ws.close(code=1013)
        return
    payload = decode_token(ws.query_params.get("token", ""))
    if payload is None:
        await ws.close(code=4401)  # unauthorized
        return
    await ws.accept()

    q = runtime.bus.subscribe()
    subs: set[tuple[str, str]] = set()
    tf_aggs: dict[tuple[str, str], LiveTfAggregator] = {}
    quote_syms: set[str] = set()
    send_lock = asyncio.Lock()

    async def send(payload: dict) -> None:
        async with send_lock:
            await ws.send_json(payload)

    async def receiver() -> None:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")
            if action == "subscribe":
                sym, tf = msg.get("symbol"), msg.get("tf", "1m")
                if tf not in TF_SECONDS or not sym:
                    continue
                subs.add((sym, tf))
                if tf != "1m":
                    agg = LiveTfAggregator(sym, tf)
                    # seed the current tf bucket from stored 1m bars
                    start = bucket_start_s(int(time.time()), tf, sym)
                    bars_1m = await asyncio.to_thread(runtime.service.history, sym, "1m", start, None)
                    agg.seed(bars_1m)
                    tf_aggs[(sym, tf)] = agg
            elif action == "unsubscribe":
                key = (msg.get("symbol"), msg.get("tf", "1m"))
                subs.discard(key)
                tf_aggs.pop(key, None)
            elif action == "subscribe_quotes":
                quote_syms.update(msg.get("symbols", []))

    rx = asyncio.create_task(receiver())
    try:
        while True:
            ev = await q.get()
            if isinstance(ev, BarEvent):
                sym = ev.bar.symbol
                if (sym, "1m") in subs:
                    await send(ev.to_ws())
                for (s, tf) in subs:
                    if s != sym or tf == "1m":
                        continue
                    agg = tf_aggs.get((s, tf))
                    if agg is None:
                        continue
                    for bar, closed in agg.on_event(ev):
                        await send(
                            {
                                "type": "bar",
                                "symbol": s,
                                "tf": tf,
                                "bar": bar.to_dict(),
                                "closed": closed,
                            }
                        )
            elif isinstance(ev, QuoteEvent):
                if ev.symbol in quote_syms:
                    await send(ev.to_ws())
    except WebSocketDisconnect:
        pass
    finally:
        rx.cancel()
        runtime.bus.unsubscribe(q)