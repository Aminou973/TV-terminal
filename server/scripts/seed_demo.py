"""Seed synthetic 1m history so a fresh install has something to chart.

Writes random-walk 1m bars straight into the Parquet store (data/candles/…),
ending now. Real feeds overwrite/extend the same files as data arrives.

Usage:  python scripts/seed_demo.py [--days 30] [--symbols DEMO:ES DEMO:AAPL …]
"""

from __future__ import annotations

import argparse
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.models import Bar  # noqa: E402
from app.store.parquet import CandleParquetStore  # noqa: E402

DEFAULTS = {"DEMO:ES": 5800.0, "DEMO:AAPL": 230.0, "DEMO:BTCUSDT": 97000.0, "DEMO:EURUSD": 1.09}


def walk(symbol: str, start_px: float, days: int, seed: int) -> list[Bar]:
    rng = random.Random(seed)
    end = int(time.time()) // 60 * 60
    start = end - days * 86400
    vol = start_px * 0.0006
    px = start_px
    bars = []
    for t in range(start, end, 60):
        # intraday volatility smile + slow regime drift
        hour = (t % 86400) / 3600
        k = 1.6 if 13 <= hour <= 16 else 0.7
        drift = math.sin(t / 86400 / 3) * vol * 0.05
        o = px
        c = max(start_px * 0.2, o + rng.gauss(drift, vol * k))
        h = max(o, c) + abs(rng.gauss(0, vol * k * 0.6))
        lo = min(o, c) - abs(rng.gauss(0, vol * k * 0.6))
        v = round(rng.expovariate(1 / 150) * k, 2)
        bars.append(Bar(symbol, t, round(o, 6), round(h, 6), round(lo, 6), round(c, 6), v))
        px = c
    return bars


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--symbols", nargs="*", default=list(DEFAULTS))
    args = ap.parse_args()
    store = CandleParquetStore(settings.data_dir)
    for i, sym in enumerate(args.symbols):
        bars = walk(sym, DEFAULTS.get(sym, 100.0), args.days, seed=i + 1)
        store.append_bars(bars)
        store.flush()
        print(f"seeded {len(bars):>6} x 1m bars for {sym}")


if __name__ == "__main__":
    main()
