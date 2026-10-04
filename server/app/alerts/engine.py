"""Server-side alerts.

Kinds
- price      — price vs a level (crossing / up / down / greater / less)
- line       — price vs a drawn trend line / ray (level interpolated in time)
- indicator  — series A vs series B or a value, on the alert's timeframe
- script     — an OpenScript alertcondition() or a strategy's order fills

Frequencies (TradingView's): once · once_per_bar · once_per_bar_close ·
once_per_minute · every_time. Price/line alerts are checked on every tick
(or at bar close for once_per_bar_close); indicator/script alerts at each
bar close of their timeframe and, for intrabar frequencies, at most every
few seconds on the forming bar. Heavy evaluation runs in worker threads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Callable, Optional

from app.alerts import indicators
from app.alerts.notify import deliver, render
from app.candles.bus import EventBus
from app.candles.resample import bucket_start_s
from app.config import Settings
from app.db.database import Database
from app.models import Bar, Tick, UserEvent

log = logging.getLogger("openterm.alerts")

CONDITIONS = ("crossing", "crossing_up", "crossing_down", "greater", "less")
FREQUENCIES = ("once", "once_per_bar", "once_per_bar_close", "once_per_minute", "every_time")
INTRABAR_EVERY_S = 5.0

History = Callable[[str, str, int], list[Bar]]


def triggered(condition: str, level: float, prev: float | None, price: float) -> bool:
    """Price vs a fixed level, comparing against the previous price."""
    return touch(condition, prev, price, level, level)


def touch(cond: str, a_prev: float | None, a: float | None, b_prev: float | None, b: float | None) -> bool:
    """Price vs a level/line: reaching the level counts as crossing it."""
    if a is None or b is None:
        return False
    if cond == "greater":
        return a > b
    if cond == "less":
        return a < b
    if a_prev is None or b_prev is None:
        return False
    up = a_prev < b_prev and a >= b
    down = a_prev > b_prev and a <= b
    if cond == "crossing_up":
        return up
    if cond == "crossing_down":
        return down
    return up or down


def compare(cond: str, a_prev: float | None, a: float | None, b_prev: float | None, b: float | None) -> bool:
    """Series A vs series B over the last two points (ta.crossover semantics: strictly through)."""
    if a is None or b is None:
        return False
    if cond == "greater":
        return a > b
    if cond == "less":
        return a < b
    if a_prev is None or b_prev is None:
        return False
    up = a_prev <= b_prev and a > b
    down = a_prev >= b_prev and a < b
    if cond == "crossing_up":
        return up
    if cond == "crossing_down":
        return down
    return up or down


def line_level(params: dict, t_s: float) -> Optional[float]:
    """Price of a drawn line at time t (None outside a non-extended segment)."""
    t1, p1, t2, p2 = (float(params[k]) for k in ("t1", "p1", "t2", "p2"))
    if t2 == t1:
        return p1
    if t2 < t1:
        t1, p1, t2, p2 = t2, p2, t1, p1
    ext = params.get("extend", "right")
    if (t_s < t1 and ext not in ("left", "both")) or (t_s > t2 and ext not in ("right", "both")):
        return None
    return p1 + (p2 - p1) * (t_s - t1) / (t2 - t1)


def describe(a: dict) -> str:
    cond = a["condition"].replace("_", " ")
    p = a["params"]
    if a["kind"] == "indicator":
        return f"{indicators.describe(p.get('left', {}))} {cond} {indicators.describe(p.get('right', {}))} ({a['tf']})"
    if a["kind"] == "line":
        return f"{a['symbol']} {cond} trend line"
    if a["kind"] == "script":
        what = "order fills" if p.get("condition") == "strategy" else p.get("condition", "")
        return f"{p.get('name', 'script')}: {what} ({a['tf']})"
    return f"{a['symbol']} {cond} {a['price']:g}"


class AlertEngine:
    def __init__(self, db: Database, bus: EventBus, settings: Settings, history: Optional[History] = None):
        self.db = db
        self.bus = bus
        self.settings = settings
        self.history = history
        self._by_symbol: dict[str, list[dict]] = {}
        self._prev: dict[str, float] = {}
        self._buckets: dict[tuple[str, str], int] = {}  # (symbol, tf) -> current bar start
        self._last_intrabar: dict[int, float] = {}
        self._busy: set[tuple[str, str]] = set()
        self._closes: dict[tuple[str, str], list[float]] = {}  # last two closed prices, for close-based price alerts

    # -- state -----------------------------------------------------------------
    def reload(self) -> None:
        rows = self.db.query_all("SELECT * FROM alerts WHERE active = 1")
        by: dict[str, list[dict]] = {}
        for r in rows:
            r["params"] = json.loads(r.get("params") or "{}")
            r["notify"] = json.loads(r.get("notify") or "{}")
            by.setdefault(r["symbol"], []).append(r)
        self._by_symbol = by

    # -- tick path -------------------------------------------------------------
    def on_tick(self, tick: Tick) -> None:
        sym = tick.symbol
        prev = self._prev.get(sym)
        self._prev[sym] = tick.price
        alerts = self._by_symbol.get(sym)
        if not alerts:
            return
        now_ms = int(time.time() * 1000)
        t_s = tick.ts_ms / 1000
        for a in list(alerts):
            if a.get("expires_ms") and now_ms > a["expires_ms"]:
                self._expire(a)
                continue
            tf = a["tf"] or "1m"
            bar_t = bucket_start_s(int(t_s), tf, sym)
            key = (sym, tf)
            closed = self._buckets.get(key)
            if closed is not None and bar_t != closed:
                self._on_bar_close(key, closed, prev)
            self._buckets[key] = bar_t

            kind = a["kind"]
            freq = a["frequency"]
            if kind in ("price", "line") and freq != "once_per_bar_close":
                if kind == "price":
                    hit = triggered(a["condition"], a["price"], prev, tick.price)
                else:
                    lvl_now = line_level(a["params"], t_s)
                    lvl_prev = line_level(a["params"], t_s - 1)
                    hit = lvl_now is not None and touch(a["condition"], prev, tick.price, lvl_prev, lvl_now)
                if hit and self._gate(a, now_ms, bar_t):
                    self._fire(a, tick.price, bar_t, {"close": tick.price})
            elif kind in ("indicator", "script") and freq != "once_per_bar_close":
                last = self._last_intrabar.get(a["id"], 0.0)
                if time.monotonic() - last >= INTRABAR_EVERY_S:
                    self._last_intrabar[a["id"]] = time.monotonic()
                    self._schedule(key, closed_only=False)

    def _on_bar_close(self, key: tuple[str, str], bar_t: int, last_price: float | None) -> None:
        """A bar of (symbol, tf) just closed at last_price."""
        sym, tf = key
        closes = self._closes.setdefault(key, [])
        if last_price is not None:
            closes.append(last_price)
            del closes[:-2]
        now_ms = int(time.time() * 1000)
        for a in self._by_symbol.get(sym, []):
            if (a["tf"] or "1m") != tf or a["frequency"] != "once_per_bar_close" or a["kind"] not in ("price", "line"):
                continue
            if len(closes) < 2:
                continue
            if a["kind"] == "price":
                lp, l = a["price"], a["price"]
            else:
                lp = line_level(a["params"], bar_t - 1)
                l = line_level(a["params"], bar_t)
            if l is not None and touch(a["condition"], closes[0], closes[1], lp, l) and self._gate(a, now_ms, bar_t):
                self._fire(a, closes[1], bar_t, {"close": closes[1]})
        if any((a["tf"] or "1m") == tf and a["kind"] in ("indicator", "script") for a in self._by_symbol.get(sym, [])):
            self._schedule(key, closed_only=True)

    # -- indicator / script evaluation (threaded) ------------------------------------
    def _schedule(self, key: tuple[str, str], closed_only: bool) -> None:
        if self.history is None or (key, closed_only) in self._busy:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # not in the event loop (unit tests call evaluate_group directly)
        self._busy.add((key, closed_only))

        async def run() -> None:
            try:
                fired = await asyncio.to_thread(self.evaluate_group, key, closed_only)
                for a, price, bar_t, ctx in fired:
                    if self._gate(a, int(time.time() * 1000), bar_t):
                        self._fire(a, price, bar_t, ctx)
            except Exception:  # noqa: BLE001 — never break the tick loop
                log.exception("alert evaluation failed for %s", key)
            finally:
                self._busy.discard((key, closed_only))

        loop.create_task(run())

    def evaluate_group(self, key: tuple[str, str], closed_only: bool) -> list[tuple[dict, float, int, dict]]:
        """Evaluate indicator/script alerts of one (symbol, tf). Safe to run in a thread."""
        sym, tf = key
        alerts = [
            a
            for a in self._by_symbol.get(sym, [])
            if (a["tf"] or "1m") == tf
            and a["kind"] in ("indicator", "script")
            and (a["frequency"] == "once_per_bar_close") == closed_only
        ]
        if not alerts:
            return []
        bars = self.history(sym, tf, 400)
        if closed_only and bars:
            # history ends with the bar that just started forming — drop it
            current = self._buckets.get(key)
            if current is not None and bars[-1].time >= current:
                bars = bars[:-1]
        if len(bars) < 2:
            return []
        last = bars[-1]
        ctx = {"close": last.close, "open": last.open, "high": last.high, "low": last.low, "volume": last.volume}
        out = []
        for a in alerts:
            try:
                hit, extra = self._evaluate(a, bars)
            except Exception as e:  # noqa: BLE001 — a broken alert reports, doesn't crash
                self._set_error(a, str(e))
                continue
            if hit:
                out.append((a, last.close, last.time, {**ctx, **extra}))
        return out

    def _evaluate(self, a: dict, bars: list[Bar]) -> tuple[bool, dict]:
        p = a["params"]
        if a["kind"] == "indicator":
            left = indicators.compute(bars, p["left"])
            right = indicators.compute(bars, p["right"])
            return compare(a["condition"], left[-2], left[-1], right[-2], right[-1]), {"value": left[-1]}
        # script
        from app.alerts.scripts import run_script
        from app.paper.engine import point_value

        res = run_script(p.get("source", ""), bars, p.get("inputs") or {}, point_value(a["symbol"]))
        if p.get("condition") == "strategy":
            fills = [f for f in res.get("fills", []) if f["time"] == bars[-1].time]
            if not fills:
                return False, {}
            f = fills[-1]
            return True, {
                "strategy.order.action": f["action"],
                "strategy.order.contracts": f["qty"],
                "strategy.order.price": f["price"],
                "strategy.order.id": f["id"],
                "strategy.order.comment": f["reason"],
            }
        for cond in res.get("alerts", []):
            if cond["title"] == p.get("condition"):
                return bool(cond["last"]), {"script.message": cond["message"]}
        raise ValueError(f"alertcondition {p.get('condition')!r} not found in the script")

    # -- firing ----------------------------------------------------------------------
    def _gate(self, a: dict, now_ms: int, bar_t: int) -> bool:
        if not a["active"]:
            return False
        freq = a["frequency"]
        last = a.get("last_fired_ms") or 0
        if freq == "once_per_bar":
            return a.get("last_bar") != bar_t
        if freq == "once_per_bar_close":
            return a.get("last_bar") != bar_t
        if freq == "once_per_minute":
            return now_ms - last >= 60_000
        if freq == "every_time":
            return now_ms - last >= 1_000
        return True  # once

    def _fire(self, alert: dict, price: float, bar_t: int, ctx: dict) -> None:
        now_ms = int(time.time() * 1000)
        once = alert["frequency"] == "once"
        alert["last_fired_ms"] = now_ms
        alert["last_bar"] = bar_t
        if once:
            alert["active"] = 0
        title = describe(alert)
        tctx = {
            "ticker": alert["symbol"],
            "interval": alert["tf"],
            "price": price,
            "alert": title,
            "time": datetime.fromtimestamp(bar_t, tz=timezone.utc).isoformat(),
            "timenow": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **ctx,
        }
        default = ctx.get("script.message") or title
        message = render(alert["message"] or default, tctx)
        now_txt = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        self.db.execute(
            "UPDATE alerts SET active = ?, triggered_at = ?, last_fired_ms = ?, last_bar = ?, error = NULL WHERE id = ?",
            (0 if once else 1, now_txt, now_ms, bar_t, alert["id"]),
        )
        log_id = self.db.execute(
            "INSERT INTO alert_log (alert_id, user_id, symbol, price, message, ts_ms) VALUES (?, ?, ?, ?, ?, ?)",
            (alert["id"], alert["user_id"], alert["symbol"], price, message, now_ms),
        )
        log.info("alert %s fired for user %s: %s", alert["id"], alert["user_id"], message)
        self.bus.publish(
            UserEvent(
                alert["user_id"],
                {"type": "alert", "id": alert["id"], "symbol": alert["symbol"], "price": price, "message": message, "ts_ms": now_ms},
            )
        )
        if once:
            self.reload()
        if alert["notify"]:
            self._deliver(alert, title, message, tctx, log_id)

    def _deliver(self, alert: dict, title: str, message: str, ctx: dict, log_id: int) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        prefs = self.db.query_one("SELECT * FROM notify_settings WHERE user_id = ?", (alert["user_id"],)) or {}
        meta = {"alert_id": alert["id"], "symbol": alert["symbol"], "price": ctx.get("price"), "interval": alert["tf"], "time": ctx.get("time")}

        async def run() -> None:
            status = await deliver(alert["notify"], prefs, self.settings, title, message, meta)
            if status:
                self.db.execute("UPDATE alert_log SET delivery = ? WHERE id = ?", (status, log_id))

        loop.create_task(run())

    def _expire(self, a: dict) -> None:
        a["active"] = 0
        self.db.execute("UPDATE alerts SET active = 0, error = 'expired' WHERE id = ?", (a["id"],))
        self.reload()

    def _set_error(self, a: dict, err: str) -> None:
        if a.get("error") != err:
            a["error"] = err
            self.db.execute("UPDATE alerts SET error = ? WHERE id = ?", (err[:300], a["id"]))
