"""WebSocket streaming: /api/stream?token=JWT

Client → server:
  {"action":"subscribe","symbol":"ES","tf":"5m"}
  {"action":"unsubscribe","symbol":"ES","tf":"5m"}
  {"action":"subscribe_quotes","symbols":["ES","BINANCE-BTCUSDT"]}
  {"action":"unsubscribe_quotes","symbols":["ES"]}
  {"action":"subscribe_trades","symbol":"ES"}     / "unsubscribe_trades"
  {"action":"subscribe_book","symbol":"ES"}       / "unsubscribe_book"

Server → client:
  {"type":"bar","symbol":…,"tf":…,"bar":{"time","open","high","low","close","volume"},"closed":bool}
  {"type":"quote","symbol":…,"last":…,"bid":…,"ask":…,"ts_ms":…}
  {"type":"trade","symbol":…,"price":…,"size":…,"side":"buy"|"sell"|"","ts_ms":…}
  {"type":"book","symbol":…,"bids":[[price,size],…],"asks":[[price,size],…],"ts_ms":…}

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
from app.candles.aggregator import BookEvent, QuoteEvent, TradeEvent
from app.candles.resample import TF_SECONDS, bucket_start_s
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

    def seed(self, bars_1m: list[Bar], now_s: int) -> None:
        """Seed with the 1m bars of the bucket containing `now_s`."""
        self.bucket = bucket_start_s(now_s, self.tf, self.symbol)
        for b in bars_1m:
            if bucket_start_s(b.time, self.tf, self.symbol) == self.bucket:
                self._ingest(b, closed=True)

    def on_event(self, ev: BarEvent) -> list[tuple[Bar, bool]]:
        """Returns [(tf_bar, closed)] — prev bucket final (if just crossed) + current forming."""
        t = bucket_start_s(ev.bar.time, self.tf, self.symbol)
        out: list[tuple[Bar, bool]] = []
        if self.bucket is not None and t != self.bucket:
            if self.closed or self.forming is not None:
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
            # a forming update supersedes any stored copy of the same minute
            # (seeding includes the live forming bar) — never count it twice
            self.closed.pop(bar.time, None)
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


def _symbols(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [s for s in value if isinstance(s, str) and s]
    return []


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
    trade_syms: set[str] = set()
    book_syms: set[str] = set()
    send_lock = asyncio.Lock()

    async def send(payload: dict) -> None:
        async with send_lock:
            await ws.send_json(payload)

    async def subscribe_bars(sym: str, tf: str) -> None:
        if tf != "1m":
            agg = LiveTfAggregator(sym, tf)
            now = int(time.time())
            # read a day back: a CME daily bucket is labelled after its 17:00 CT open
            bars_1m = await asyncio.to_thread(
                runtime.service.history, sym, "1m", now - TF_SECONDS[tf] - 86400, None
            )
            agg.seed(bars_1m, now)
            tf_aggs[(sym, tf)] = agg
        subs.add((sym, tf))

    async def receiver() -> None:
        while True:
            try:
                msg = await ws.receive_json()
            except (ValueError, KeyError):
                continue  # not JSON — ignore, keep the connection
            if not isinstance(msg, dict):
                continue
            action = msg.get("action")
            if action == "subscribe":
                sym, tf = msg.get("symbol"), msg.get("tf", "1m")
                if isinstance(sym, str) and sym and tf in TF_SECONDS:
                    await subscribe_bars(sym, tf)
            elif action == "unsubscribe":
                key = (msg.get("symbol"), msg.get("tf", "1m"))
                subs.discard(key)
                tf_aggs.pop(key, None)
            elif action == "subscribe_quotes":
                quote_syms.update(_symbols(msg.get("symbols")))
            elif action == "unsubscribe_quotes":
                quote_syms.difference_update(_symbols(msg.get("symbols")))
            elif action == "subscribe_trades":
                trade_syms.update(_symbols(msg.get("symbol")))
            elif action == "unsubscribe_trades":
                trade_syms.difference_update(_symbols(msg.get("symbol")))
            elif action == "subscribe_book":
                syms = _symbols(msg.get("symbol"))
                book_syms.update(syms)
                for s in syms:
                    book = runtime.ingest.last_book.get(s)
                    if book is not None:
                        await send(book.to_ws())
            elif action == "unsubscribe_book":
                book_syms.difference_update(_symbols(msg.get("symbol")))

    async def sender() -> None:
        while True:
            ev = await q.get()
            if isinstance(ev, BarEvent):
                sym = ev.bar.symbol
                if (sym, "1m") in subs:
                    await send(ev.to_ws())
                # snapshot: the receiver may (un)subscribe while we await sends
                for (s, tf), agg in list(tf_aggs.items()):
                    if s != sym or (s, tf) not in subs:
                        continue
                    for bar, closed in agg.on_event(ev):
                        await send(
                            {"type": "bar", "symbol": s, "tf": tf, "bar": bar.to_dict(), "closed": closed}
                        )
            elif isinstance(ev, QuoteEvent):
                if ev.symbol in quote_syms:
                    await send(ev.to_ws())
            elif isinstance(ev, TradeEvent):
                if ev.symbol in trade_syms:
                    await send(ev.to_ws())
            elif isinstance(ev, BookEvent):
                if ev.symbol in book_syms:
                    await send(ev.to_ws())

    # Run both directions; whichever ends first (client gone, send failed)
    # tears the other down so the bus subscription is always released.
    tasks = [asyncio.create_task(receiver()), asyncio.create_task(sender())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = t.exception()
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                log.warning("ws stream ended with error: %r", exc)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        runtime.bus.unsubscribe(q)
