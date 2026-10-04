"""yfinance provider: frame parsing, change detection, and the bar ingest path."""

from __future__ import annotations

import pandas as pd

from app.candles.aggregator import CandleAggregator
from app.candles.bus import EventBus
from app.candles.sessions import market_class
from app.ingest.providers.yfinance_provider import YFinanceProvider, frame_to_bars
from app.models import Bar, BarEvent
from app.paper.engine import point_value


def _frame(rows: dict[str, list[tuple]]) -> pd.DataFrame:
    """Build a frame shaped like yf.download(group_by='ticker')."""
    parts = {}
    for t, data in rows.items():
        idx = pd.to_datetime([r[0] for r in data], unit="s", utc=True)
        parts[t] = pd.DataFrame(
            [r[1:] for r in data], index=idx, columns=["Open", "High", "Low", "Close", "Adj Close", "Volume"]
        )
    return pd.concat(parts, axis=1)


def test_frame_to_bars_multi_ticker_and_nan():
    df = _frame(
        {
            "AAPL": [(60, 1, 2, 0.5, 1.5, 1.5, 100), (120, 1.5, 2, 1, 1.8, 1.8, 50)],
            "ES=F": [(60, 10, 11, 9, 10.5, 10.5, 7), (120, float("nan"),) * 1 + (float("nan"),) * 5],
        }
    )
    out = frame_to_bars(df, ["AAPL", "ES=F", "MISSING"])
    assert [b.time for b in out["AAPL"]] == [60, 120]
    assert out["AAPL"][1].close == 1.8 and out["AAPL"][1].volume == 50
    assert [b.time for b in out["ES=F"]] == [60]  # NaN row dropped
    assert "MISSING" not in out


def test_updates_only_new_or_changed():
    p = YFinanceProvider(["AAPL"], store=None)
    b1, b2 = Bar("AAPL", 60, 1, 1, 1, 1, 1), Bar("AAPL", 120, 1, 2, 1, 2, 5)
    assert p.updates({"AAPL": [b1, b2]}) == [b1, b2]
    assert p.updates({"AAPL": [b1, b2]}) == []
    b2b = Bar("AAPL", 120, 1, 3, 1, 3, 9)
    assert p.updates({"AAPL": [b1, b2b]}) == [b2b]


def test_process_bar_forms_and_closes():
    bus = EventBus()
    q = bus.subscribe()
    agg = CandleAggregator(bus)
    closed = []
    agg.on_closed = closed.append
    agg.process_bar(Bar("AAPL", 60, 1, 2, 1, 1.5, 10))
    agg.process_bar(Bar("AAPL", 60, 1, 2.5, 1, 2, 20))  # same minute, updated
    tick = agg.process_bar(Bar("AAPL", 120, 2, 2, 2, 2, 1))
    assert len(closed) == 1 and closed[0].high == 2.5 and closed[0].volume == 20
    assert tick.price == 2 and agg.last_tick["AAPL"].price == 2
    agg.process_bar(Bar("AAPL", 60, 9, 9, 9, 9, 9))  # stale → ignored
    assert agg.forming_bar("AAPL").time == 120
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    assert sum(isinstance(e, BarEvent) and not e.closed for e in events) == 3


def test_yahoo_symbols_classify():
    assert market_class("ES=F") == "cme" and point_value("ES=F") == 50
    assert market_class("BTC-USD") == "crypto"
    assert market_class("AAPL") == "stock" and market_class("EURUSD=X") == "stock"
