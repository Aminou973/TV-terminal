"""Parquet store round-trip tests."""

from __future__ import annotations

import time

from app.models import Bar
from app.store.parquet import CandleParquetStore, sanitize_symbol


def test_sanitize_symbol_filesystem_safe():
    assert sanitize_symbol("BINANCE:BTCUSDT") == "BINANCE-BTCUSDT"
    assert " " not in sanitize_symbol("ES 12-25")
    assert sanitize_symbol("AAPL") == "AAPL"


def test_store_roundtrip(tmp_path):
    store = CandleParquetStore(tmp_path)
    t = int(time.time()) // 60 * 60
    bars = [
        Bar("ES", t, 100, 102, 99, 101, 10),
        Bar("ES", t + 60, 101, 103, 100, 102, 20),
    ]
    store.append_bars(bars)
    store.flush()

    back = store.read_1m("ES")
    assert [b.time for b in back] == [t, t + 60]
    assert back[0].open == 100 and back[1].volume == 20

    # appends merge, not duplicate
    store.append_bar(Bar("ES", t + 120, 102, 104, 101, 103, 5))
    store.flush()
    back = store.read_1m("ES")
    assert len(back) == 3

    # filtering works
    back = store.read_1m("ES", from_s=t + 60)
    assert [b.time for b in back] == [t + 60, t + 120]


def test_store_replaces_duplicate_bar(tmp_path):
    store = CandleParquetStore(tmp_path)
    t = int(time.time()) // 60 * 60
    store.append_bar(Bar("ES", t, 100, 100, 100, 100, 1))
    store.append_bar(Bar("ES", t, 100, 105, 100, 105, 2))  # same minute, updated
    store.flush()
    back = store.read_1m("ES")
    assert len(back) == 1
    assert back[0].high == 105 and back[0].volume == 2