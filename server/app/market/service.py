"""Market data with caching and a demo fallback.

Each request goes to the live source (Yahoo / Forex Factory) through a TTL
cache. A failure marks that source down for a few minutes (so a blocked
network doesn't make every request wait on timeouts) and the answer comes
from the deterministic demo source instead, tagged `source: "demo"`.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from app.market import calendar, demo, yahoo
from app.market.universe import HEATMAP, MARKET_NEWS_TICKERS, OVERVIEW, to_yahoo

log = logging.getLogger("openterm.market")

TTL = {"news": 300, "fundamentals": 6 * 3600, "events": 6 * 3600, "quotes": 60, "caps": 6 * 3600,
       "earnings": 6 * 3600, "calendar": 1800}
DOWN_FOR_S = 300
ALLOW_EMPTY = {"news", "earnings", "events"}


class MarketService:
    def __init__(self, live: bool = True, calendar_url: str = calendar.FF_THIS_WEEK,
                 yahoo_mod: Any = yahoo, calendar_fetch: Callable[[str], list[dict]] | None = None):
        self.live = live
        self.calendar_url = calendar_url
        self.yahoo = yahoo_mod
        self.calendar_fetch = calendar_fetch or calendar.fetch
        self._cache: dict[tuple, tuple[float, Any, str]] = {}
        self._down: dict[str, float] = {}  # source -> retry after (monotonic)
        self._lock = threading.Lock()

    # -- plumbing ------------------------------------------------------------
    def _get(self, kind: str, key: tuple, source: str, live_fn: Callable[[], Any], demo_fn: Callable[[], Any]) -> tuple[Any, str]:
        ck = (kind, *key)
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(ck)
            # demo answers are only kept until the live source is retried
            ttl = TTL[kind] if hit and (hit[2] == "live" or not self.live) else min(TTL[kind], DOWN_FOR_S)
            if hit and now - hit[0] < ttl:
                return hit[1], hit[2]
            up = self.live and self._down.get(source, 0) <= now
        value, origin = None, "demo"
        if up:
            try:
                value = live_fn()
                origin = "live"
            except Exception as e:  # noqa: BLE001 — any network / parsing failure falls back
                log.warning("market %s via %s failed (%s); serving demo data for %ss", kind, source, e, DOWN_FOR_S)
                with self._lock:
                    self._down[source] = now + DOWN_FOR_S
        # an empty live answer is real for lists of things that may not exist
        # (no news, no upcoming earnings); for quotes it means the source failed
        if origin != "live" or (not value and kind not in ALLOW_EMPTY):
            value, origin = demo_fn(), "demo"
        with self._lock:
            self._cache[ck] = (now, value, origin)
        return value, origin

    def status(self) -> dict:
        now = time.monotonic()
        return {"live": self.live, "down": {k: round(v - now) for k, v in self._down.items() if v > now}}

    # -- public --------------------------------------------------------------
    def news(self, symbol: str | None) -> dict:
        if symbol:
            t = to_yahoo(symbol)
            items, src = self._get("news", (t,), "yahoo", lambda: self.yahoo.news(t), lambda: demo.news(t))
        else:
            def live():
                seen, out = set(), []
                for tk in MARKET_NEWS_TICKERS:
                    for n in self.yahoo.news(tk):
                        if n["id"] not in seen:
                            seen.add(n["id"])
                            out.append(n)
                return out
            items, src = self._get("news", ("*",), "yahoo", live, lambda: demo.news(None))
        items = sorted(items, key=lambda n: n.get("time") or 0, reverse=True)[:40]
        return {"symbol": symbol, "source": src, "items": items}

    def fundamentals(self, symbol: str, ref_price: float | None = None) -> dict:
        """`ref_price` (the terminal's own last price) anchors demo numbers to the chart."""
        t = to_yahoo(symbol)
        f, src = self._get("fundamentals", (t, symbol), "yahoo", lambda: self.yahoo.fundamentals(t),
                           lambda: demo.fundamentals(t, price=ref_price))
        return {**f, "symbol": symbol, "yahoo": t, "source": src}

    def events(self, symbol: str, ref_price: float | None = None) -> dict:
        t = to_yahoo(symbol)
        ev, src = self._get("events", (t, symbol), "yahoo", lambda: self.yahoo.events(t),
                            lambda: demo.events(t, price=ref_price))
        return {"symbol": symbol, "source": src, "events": ev}

    def quotes(self, tickers: list[str]) -> tuple[dict[str, dict], str]:
        key = tuple(sorted(tickers))
        return self._get("quotes", key, "yahoo", lambda: self.yahoo.quotes(list(key)), lambda: demo.quotes(list(key)))

    def overview(self) -> dict:
        tickers = [t for g in OVERVIEW.values() for t, _ in g]
        q, src = self.quotes(tickers)
        groups = []
        for name, items in OVERVIEW.items():
            rows = [{"symbol": t, "name": n, **q[t]} for t, n in items if t in q]
            groups.append({"name": name, "rows": rows})
        movers = self.heatmap()["tiles"]
        ranked = [m for m in movers if m.get("change_pct") is not None]
        return {
            "source": src,
            "groups": groups,
            "gainers": sorted(ranked, key=lambda m: -m["change_pct"])[:8],
            "losers": sorted(ranked, key=lambda m: m["change_pct"])[:8],
            "active": sorted(ranked, key=lambda m: -(m.get("volume") or 0) * (m.get("last") or 0))[:8],
        }

    def heatmap(self) -> dict:
        tickers = [t for t, _, _, _ in HEATMAP]
        q, src = self.quotes(tickers)
        caps, _ = self._get("caps", ("heatmap",), "yahoo", lambda: self.yahoo.market_caps(tickers), lambda: demo.market_caps(tickers))
        tiles = []
        for t, name, sector, approx in HEATMAP:
            row = q.get(t)
            if row is None:
                continue
            tiles.append({"symbol": t, "name": name, "sector": sector, "market_cap": caps.get(t) or approx * 1e9,
                          "last": row["last"], "change_pct": row["change_pct"], "volume": row.get("volume")})
        return {"source": src, "tiles": tiles}

    def earnings_calendar(self, symbols: list[str]) -> dict:
        tickers = sorted({to_yahoo(s) for s in symbols} | {t for t, _, _, _ in HEATMAP[:30]})
        rows, src = self._get("earnings", tuple(tickers), "yahoo", lambda: self.yahoo.next_earnings(tickers),
                              lambda: demo.next_earnings(tickers))
        names = {t: n for t, n, _, _ in HEATMAP}
        now = time.time()
        rows = [{**r, "name": names.get(r["symbol"], r["symbol"])} for r in rows if r["time"] >= now - 86400]
        return {"source": src, "rows": sorted(rows, key=lambda r: r["time"])}

    def economic_calendar(self) -> dict:
        rows, src = self._get("calendar", ("week",), "calendar", lambda: self.calendar_fetch(self.calendar_url),
                              lambda: demo.economic_calendar())
        return {"source": src, "rows": rows}
