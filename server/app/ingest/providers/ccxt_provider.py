"""Live crypto provider via ccxt — public market data, no API key required.

Backfills recent 1m history via REST (fetch_ohlcv), then streams trades over
the exchange WebSocket and emits them as ticks. Symbols are normalized to
filesystem-safe ids, e.g. BTC/USDT → BINANCE-BTCUSDT.
"""

from __future__ import annotations

import asyncio
import logging

import ccxt.pro as ccxt  # WS-capable flavor — async_support lacks watch_* since ccxt 4.5

from app.models import Bar, Tick, now_ms

log = logging.getLogger("openterm.ccxt")

TF_MS = {"1m": 60_000}


def normalized_symbol(exchange_id: str, ccxt_symbol: str) -> str:
    base = ccxt_symbol.replace("/", "").replace(":", "")
    return f"{exchange_id.upper()}-{base.upper()}"


class CcxtProvider:
    name = "ccxt"

    def __init__(self, exchange_id: str, ccxt_symbols: list[str], store):
        self.exchange_id = exchange_id
        self.ccxt_symbols = ccxt_symbols
        self.store = store  # CandleParquetStore, for the REST backfill
        self.exchange: ccxt.Exchange | None = None

    async def run(self, sink) -> None:
        exchange_class = getattr(ccxt, self.exchange_id)
        self.exchange = exchange_class({"enableRateLimit": True})
        try:
            await self._backfill()
            await asyncio.gather(
                *(self._watch_trades(sym, sink) for sym in self.ccxt_symbols)
            )
        finally:
            await self.exchange.close()

    async def _backfill(self) -> None:
        """Fetch the last ~3 days of 1m bars so history requests work immediately."""
        for ccxt_symbol in self.ccxt_symbols:
            try:
                ohlcv = await self.exchange.fetch_ohlcv(ccxt_symbol, "1m", limit=1000)
                sym = normalized_symbol(self.exchange_id, ccxt_symbol)
                bars = [
                    Bar(symbol=sym, time=int(c[0] // 1000), open=c[1], high=c[2], low=c[3], close=c[4], volume=c[5])
                    for c in ohlcv
                ]
                self.store.append_bars(bars)
                log.info("ccxt: backfilled %d x 1m bars for %s", len(bars), sym)
            except Exception as e:  # noqa: BLE001 — keep other symbols alive
                log.warning("ccxt: backfill failed for %s: %s", ccxt_symbol, e)

    async def _watch_trades(self, ccxt_symbol: str, sink) -> None:
        sym = normalized_symbol(self.exchange_id, ccxt_symbol)
        while True:
            try:
                trades = await self.exchange.watch_trades(ccxt_symbol)
                for t in trades:
                    if t.get("price") is None:
                        continue
                    await sink(
                        Tick(
                            symbol=sym,
                            ts_ms=int(t.get("timestamp") or now_ms()),
                            price=float(t["price"]),
                            size=float(t.get("amount") or 0.0),
                            provider=self.name,
                            side=t.get("side") or "",
                        )
                    )
                    # NOTE: since ccxt 4.5, watch_trades returns a fresh list of
                    # new trades each call — do NOT clear() a shared buffer here.
            except Exception as e:  # noqa: BLE001
                log.warning("ccxt: %s stream error (%s); retrying in 5s", ccxt_symbol, e)
                await asyncio.sleep(5.0)