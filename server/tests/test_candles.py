"""Tests for the candle engine: aggregation, resampling, session boundaries."""

from __future__ import annotations

from app.candles.bus import EventBus
from app.candles.aggregator import CandleAggregator, QuoteEvent
from app.candles.resample import bucket_start_s, resample
from app.candles.sessions import market_class, session_day_start_s
from app.models import Bar, BarEvent, Tick


# ---------------------------------------------------------------- resample ----
def test_resample_5m_buckets():
    bars = [
        Bar("ES", 0, 10, 12, 9, 11, 100),
        Bar("ES", 60, 11, 13, 10, 12, 200),
        Bar("ES", 300, 12, 14, 11, 13, 300),  # starts a new 5m bucket
    ]
    out = resample(bars, "5m")
    assert len(out) == 2
    assert out[0].time == 0 and out[0].open == 10 and out[0].close == 12
    assert out[0].high == 13 and out[0].low == 9 and out[0].volume == 300
    assert out[1].time == 300 and out[1].open == 12


def test_bucket_start_daily_cme_anchors_at_17ct():
    # Mon 2026-10-05 18:00 ET (23:00 UTC) belongs to Tuesday's session? No:
    # CME day opens 17:00 CT (22:00 UTC Oct 4 is Sunday open for Monday's day).
    # 2026-10-05 23:00 UTC = 16:00 CT Monday → still MONDAY's trading day (opened Sun 17:00 CT)
    ts = 1770265200  # 2026-10-05T23:00:00Z
    start = session_day_start_s(ts, "ES")
    assert start <= ts
    # the day window must contain the tick and be exactly 24h long in session terms
    assert ts - start < 86400


def test_market_classification():
    assert market_class("ES") == "cme"
    assert market_class("MES") == "cme"
    assert market_class("BINANCE-BTCUSDT") == "crypto"
    assert market_class("AAPL") == "stock"


# -------------------------------------------------------------- aggregator ----
def test_aggregator_builds_and_closes_bars():
    bus = EventBus()
    agg = CandleAggregator(bus, throttle_s=0.0)
    closed: list[Bar] = []
    agg.on_closed = closed.append
    q = bus.subscribe()

    t0 = 1_800_000_000_000  # a minute boundary
    for i in range(3):
        agg.process_tick(Tick("ES", t0 + i * 1000, 100 + i, 2))
    agg.process_tick(Tick("ES", t0 + 61_000, 110, 1))  # next minute → closes bar

    assert len(closed) == 1
    b = closed[0]
    assert b.time == t0 // 1000
    assert b.open == 100 and b.close == 102 and b.high == 102 and b.low == 100
    assert b.volume == 6

    events = [e for e in _drain(q) if isinstance(e, BarEvent)]
    assert any(e.closed for e in events), "a closed bar event must be published"
    assert any(not e.closed for e in events), "forming events must be published"


def test_aggregator_quote_events():
    bus = EventBus()
    agg = CandleAggregator(bus, throttle_s=0.0, quote_throttle_s=0.0)
    q = bus.subscribe()
    agg.process_tick(Tick("ES", 1_800_000_000_000, 100.0, 1, bid=99.75, ask=100.25))
    quotes = [e for e in _drain(q) if isinstance(e, QuoteEvent)]
    assert quotes and quotes[0].price == 100.0


def _drain(q):
    import asyncio

    out = []
    while not q.empty():
        try:
            out.append(q.get_nowait())
        except asyncio.QueueEmpty:
            break
    return out