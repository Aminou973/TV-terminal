"""Parquet candle storage: one file per symbol per day under data/candles/<symbol>/1m/.

Closed 1m bars append to an in-memory buffer; a flusher merges them into the
day's file (small — ≤ ~1440 rows) every few seconds and releases the buffer.
Symbols are sanitized to be safe as Windows folder names; the original name
is kept in <symbol>/symbol.txt so listings round-trip (SIM:ES, not SIM-ES).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import polars as pl

from app.models import Bar

_BAD = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize_symbol(symbol: str) -> str:
    return _BAD.sub("-", symbol).strip("-.") or "UNKNOWN"


_SCHEMA = {"time": pl.Int64, "open": pl.Float64, "high": pl.Float64, "low": pl.Float64, "close": pl.Float64, "volume": pl.Float64}


class CandleParquetStore:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.root = self.data_dir / "candles"
        # buffer keyed by (symbol_dir, day) -> list[Bar] (sorted by time)
        self._buffers: dict[tuple[str, str], list[Bar]] = {}
        self._dirty: set[tuple[str, str]] = set()
        self._names: dict[str, str] = {}  # sanitized dir -> original symbol

    # -- write path ------------------------------------------------------------
    def append_bar(self, bar: Bar) -> None:
        """Sync, cheap: buffers the bar; the async flusher persists it."""
        sym = sanitize_symbol(bar.symbol)
        self._names.setdefault(sym, bar.symbol)
        day = datetime.fromtimestamp(bar.time, tz=timezone.utc).strftime("%Y%m%d")
        key = (sym, day)
        buf = self._buffers.setdefault(key, [])
        if buf and buf[-1].time == bar.time:
            buf[-1] = bar  # replace (re-emitted closed bar)
        else:
            buf.append(bar)
        self._dirty.add(key)

    def append_bars(self, bars: Iterable[Bar]) -> None:
        for b in bars:
            self.append_bar(b)

    async def flush_loop(self, interval_s: float = 2.0) -> None:
        import asyncio

        while True:
            await asyncio.sleep(interval_s)
            self.flush()

    def flush(self) -> None:
        for key in list(self._dirty):
            self._write_day(key)
            # the file now holds these bars (merge dedupes by time), so the
            # buffer can go — otherwise every day ever seen stays in memory
            self._buffers.pop(key, None)
        self._dirty.clear()

    def _day_path(self, key: tuple[str, str]) -> Path:
        sym, day = key
        return self.root / sym / "1m" / f"{day}.parquet"

    def _write_day(self, key: tuple[str, str]) -> None:
        sym, day = key
        buf = self._buffers.get(key)
        if not buf:
            return
        path = self._day_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        name_file = path.parent.parent / "symbol.txt"
        if not name_file.exists() and sym in self._names:
            name_file.write_text(self._names[sym], encoding="utf-8")

        df_new = pl.DataFrame(
            {
                "time": [b.time for b in buf],
                "open": [b.open for b in buf],
                "high": [b.high for b in buf],
                "low": [b.low for b in buf],
                "close": [b.close for b in buf],
                "volume": [b.volume for b in buf],
            },
            schema=_SCHEMA,
        )
        if path.exists():
            df_old = pl.read_parquet(path)
            df_new = pl.concat([df_old, df_new]).unique(subset="time", keep="last").sort("time")
        df_new.write_parquet(path)

    # -- read path --------------------------------------------------------------
    def read_1m(self, symbol: str, from_s: int | None = None, to_s: int | None = None) -> list[Bar]:
        sym = sanitize_symbol(symbol)
        d = self.root / sym / "1m"
        if not d.is_dir():
            return []
        frames = []
        for f in sorted(d.glob("*.parquet")):
            if from_s is not None:
                day_start = datetime.strptime(f.stem, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp()
                if day_start < from_s - 86400:
                    continue
            frames.append(pl.read_parquet(f))
        if not frames:
            return []
        df = pl.concat(frames).sort("time")
        mask = pl.Series("m", [True] * df.height)
        t = df.get_column("time")
        if from_s is not None:
            mask = mask & (t >= from_s)
        if to_s is not None:
            mask = mask & (t <= to_s)
        df = df.filter(mask)
        bars = [
            Bar(
                symbol=symbol,
                time=row[0],
                open=row[1],
                high=row[2],
                low=row[3],
                close=row[4],
                volume=row[5],
            )
            for row in df.iter_rows()
        ]
        return bars

    def symbols(self) -> list[str]:
        """Original symbol names of everything stored."""
        if not self.root.is_dir():
            return []
        out = []
        for p in self.root.iterdir():
            if not p.is_dir():
                continue
            name_file = p / "symbol.txt"
            out.append(name_file.read_text(encoding="utf-8").strip() if name_file.exists() else p.name)
        return sorted(out)

    def last_bars(self, symbol: str, n: int) -> list[Bar]:
        """Most recent n stored 1m bars (for chart seeding before the live window)."""
        sym = sanitize_symbol(symbol)
        d = self.root / sym / "1m"
        if not d.is_dir():
            return []
        frames = [pl.read_parquet(f) for f in sorted(d.glob("*.parquet"))[-3:]]
        if not frames:
            return []
        df = pl.concat(frames).sort("time").tail(n)
        return [
            Bar(symbol, row[0], row[1], row[2], row[3], row[4], row[5]) for row in df.iter_rows()
        ]