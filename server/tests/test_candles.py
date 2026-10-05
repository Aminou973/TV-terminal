"""Tests for the candle engine: aggregation, resampling, session boundaries."""

from __future__ import annotations

from app.candles.bus import EventBus
from app.candles.aggregator import CandleAggregator, QuoteEvent
from app.candles.resample import resample
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


def test_cme_daily_rolls_at_17ct():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    ct = ZoneInfo("America/Chicago")

    def label(iso: str) -> str:
        ts = int(datetime.fromisoformat(iso).replace(tzinfo=ct).timestamp())
        return datetime.fromtimestamp(session_day_start_s(ts, "ES"), ct).date().isoformat()

    assert label("2026-10-05T16:59") == "2026-10-05"  # Monday session, before the break
    assert label("2026-10-05T17:00") == "2026-10-06"  # evening open → Tuesday's trading day
    assert label("2026-10-05T23:30") == "2026-10-06"
    assert label("2026-10-06T08:00") == "2026-10-06"


def test_session_open_precedes_ticks():
    from app.candles.sessions import session_open_s

    ts = 1_791_239_400  # 2026-10-05 17:30 CT
    assert session_open_s(ts, "ES") <= ts < session_open_s(ts, "ES") + 86400


def test_market_classification():
    assert market_class("ES") == "cme"
    assert market_class("MES") == "cme"
    assert market_class("SIM:ES") == "cme"
    assert market_class("ES 12-25") == "cme"  # NinjaTrader contract naming
    assert market_class("ESZ5") == "cme"
    assert market_class("BINANCE-BTCUSDT") == "crypto"
    assert market_class("BINANCE-ETHUSDT") == "crypto"
    assert market_class("NETH") == "stock"
    assert market_class("NSE:RELIANCE") == "india"
    assert market_class("AAPL") == "stock"


def test_live_tf_does_not_double_count_seeded_forming_bar():
    from app.api.ws import LiveTfAggregator

    agg = LiveTfAggregator("ES", "5m")
    agg.seed([Bar("ES", 300, 1, 1, 1, 1, 4), Bar("ES", 360, 1, 1, 1, 1, 10)], now_s=400)
    out = agg.on_event(BarEvent(Bar("ES", 360, 1, 2, 1, 2, 12), "1m", False))
    assert out[-1][0].volume == 16  # 4 (closed) + 12 (forming), not 4 + 10 + 12


def test_trade_events_carry_side():
    from app.candles.aggregator import TradeEvent

    bus = EventBus()
    agg = CandleAggregator(bus, throttle_s=0.0)
    q = bus.subscribe()
    agg.process_tick(Tick("ES", 1_800_000_000_000, 100.0, 1))
    agg.process_tick(Tick("ES", 1_800_000_000_500, 100.5, 2))
    agg.process_tick(Tick("ES", 1_800_000_001_000, 100.25, 3, bid=100.25, ask=100.5))
    trades = [e for e in _drain(q) if isinstance(e, TradeEvent)]
    assert [t.side for t in trades] == ["", "buy", "sell"]


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

def test_weekly_and_monthly_buckets():
    from datetime import datetime, timezone

    from app.candles.resample import bucket_start_s

    wed = int(datetime(2026, 10, 7, 12, tzinfo=timezone.utc).timestamp())
    mon = int(datetime(2026, 10, 5, tzinfo=timezone.utc).timestamp())
    assert bucket_start_s(wed, "1W", "BINANCE-BTCUSDT") == mon
    assert bucket_start_s(wed, "1M", "BINANCE-BTCUSDT") == int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp())
    # CME Sunday 18:00 CT belongs to Monday's session → same week as Wednesday
    sun_eve = int(datetime(2026, 10, 4, 23, tzinfo=timezone.utc).timestamp())
    assert bucket_start_s(sun_eve, "1W", "ES") == bucket_start_s(wed, "1W", "ES")


def test_custom_intervals():
    from app.candles.resample import TF_SECONDS, bucket_start_s, tf_seconds

    assert tf_seconds("7m") == 420 and tf_seconds("90m") == 5400 and tf_seconds("3h") == 10800
    assert "7m" in TF_SECONDS and "0m" not in TF_SECONDS and "2D" not in TF_SECONDS and "x" not in TF_SECONDS
    assert tf_seconds("1441m") is None and tf_seconds("25h") is None
    assert bucket_start_s(1_000_000, "7m", "BINANCE-BTCUSDT") == 1_000_000 // 420 * 420
    bars = [Bar("X", t, 1, 1, 1, 1, 1) for t in range(0, 1800, 60)]
    assert [b.time for b in resample(bars, "10m")] == [0, 600, 1200]
