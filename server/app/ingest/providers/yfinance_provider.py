"""Stocks, ETFs, indices, futures and FX via yfinance — no account or API key.

Yahoo serves 1-minute *bars*, not trades, so this provider polls: a 5-day 1m
backfill on start, then every `poll_s` seconds the current day's bars. Each
new or changed minute is pushed through the candle engine as a bar update
(see CandleAggregator.process_bar), so charts, alerts and paper fills behave
as with tick feeds — at minute resolution and with Yahoo's delays (US stocks
are near real time; futures are typically delayed ~10 minutes).

Tickers use Yahoo naming: AAPL, SPY, ^GSPC, ES=F, EURUSD=X, BTC-USD.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional

from app.models import Bar

log = logging.getLogger("openterm.yfinance")

# fetch(tickers, period) -> pandas DataFrame shaped like yf.download(group_by="ticker")
Fetch = Callable[[list[str], str], object]


def yf_fetch(tickers: list[str], period: str):
    import yfinance as yf

    return yf.download(
        tickers,
        period=period,
        interval="1m",
        group_by="ticker",
        auto_adjust=False,
        prepost=False,
        progress=False,
        threads=True,
    )


def frame_to_bars(df, tickers: list[str]) -> dict[str, list[Bar]]:
    """Split a yf.download frame into sorted 1m bars per ticker (NaN rows dropped)."""
    out: dict[str, list[Bar]] = {}
    if df is None or getattr(df, "empty", True):
        return out
    multi = getattr(df.columns, "nlevels", 1) > 1
    for t in tickers:
        if multi:
            if t not in df.columns.get_level_values(0):
                continue
            sub = df[t]
        else:
            sub = df
        sub = sub.dropna(subset=["Open", "High", "Low", "Close"])
        bars = [
            Bar(
                symbol=t,
                time=int(ts.timestamp()) // 60 * 60,
                open=float(row["Open"]),
                high=float(row["High"]),
                low=float(row["Low"]),
                close=float(row["Close"]),
                volume=float(row["Volume"]) if row["Volume"] == row["Volume"] else 0.0,
            )
            for ts, row in sub.iterrows()
        ]
        bars.sort(key=lambda b: b.time)
        if bars:
            out[t] = bars
    return out


class YFinanceProvider:
    name = "yfinance"
    accepts_bars = True  # run() also gets a bar sink

    def __init__(self, tickers: list[str], store, poll_s: float = 15.0, fetch: Optional[Fetch] = None):
        self.tickers = tickers
        self.store = store
        self.poll_s = poll_s
        self.fetch = fetch or yf_fetch
        self._last: dict[str, Bar] = {}  # last bar pushed per ticker

    async def run(self, sink, bar_sink) -> None:
        try:
            data = await asyncio.to_thread(self.fetch, self.tickers, "5d")
            for t, bars in frame_to_bars(data, self.tickers).items():
                self.store.append_bars(bars[:-1])  # the last minute may still be forming
                self._last[t] = bars[-1]
                await bar_sink(bars[-1])
                log.info("yfinance: backfilled %d x 1m bars for %s", len(bars), t)
        except Exception as e:  # noqa: BLE001 — keep polling even if the backfill failed
            log.warning("yfinance: backfill failed: %s", e)

        while True:
            await asyncio.sleep(self.poll_s)
            try:
                data = await asyncio.to_thread(self.fetch, self.tickers, "1d")
            except Exception as e:  # noqa: BLE001
                log.warning("yfinance: poll failed (%s)", e)
                continue
            for bar in self.updates(frame_to_bars(data, self.tickers)):
                await bar_sink(bar)

    def updates(self, by_ticker: dict[str, list[Bar]]) -> list[Bar]:
        """Bars that are new or changed since the last poll, oldest first."""
        out: list[Bar] = []
        for t, bars in by_ticker.items():
            last = self._last.get(t)
            for b in bars:
                if last is None or b.time > last.time or (b.time == last.time and b != last):
                    out.append(b)
            self._last[t] = bars[-1]
        return out
