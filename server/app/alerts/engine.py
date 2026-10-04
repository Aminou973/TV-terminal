"""Price alerts, evaluated on every tick.

Active alerts are cached per symbol; a tick is compared against the previous
tick of that symbol so "crossing" means the price actually moved through the
level (TradingView semantics), not that it merely sits beyond it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.candles.bus import EventBus
from app.db.database import Database
from app.models import Tick, UserEvent

log = logging.getLogger("openterm.alerts")

CONDITIONS = ("crossing", "crossing_up", "crossing_down", "greater", "less")


def triggered(condition: str, level: float, prev: float | None, price: float) -> bool:
    if condition == "greater":
        return price > level
    if condition == "less":
        return price < level
    if prev is None:
        return False
    up = prev < level <= price
    down = prev > level >= price
    if condition == "crossing_up":
        return up
    if condition == "crossing_down":
        return down
    return up or down  # crossing


class AlertEngine:
    def __init__(self, db: Database, bus: EventBus):
        self.db = db
        self.bus = bus
        self._by_symbol: dict[str, list[dict]] = {}
        self._prev: dict[str, float] = {}

    def reload(self) -> None:
        rows = self.db.query_all("SELECT * FROM alerts WHERE active = 1")
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["symbol"], []).append(r)
        self._by_symbol = by

    def on_tick(self, tick: Tick) -> None:
        prev = self._prev.get(tick.symbol)
        self._prev[tick.symbol] = tick.price
        alerts = self._by_symbol.get(tick.symbol)
        if not alerts:
            return
        fired = [a for a in alerts if triggered(a["condition"], a["price"], prev, tick.price)]
        for a in fired:
            self._fire(a, tick)
        if any(a["once"] for a in fired):
            self.reload()

    def _fire(self, alert: dict, tick: Tick) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        message = alert["message"] or (
            f"{alert['symbol']} {alert['condition'].replace('_', ' ')} {alert['price']:g}"
        )
        if alert["once"]:
            self.db.execute("UPDATE alerts SET active = 0, triggered_at = ? WHERE id = ?", (now, alert["id"]))
        else:
            self.db.execute("UPDATE alerts SET triggered_at = ? WHERE id = ?", (now, alert["id"]))
        self.db.execute(
            "INSERT INTO alert_log (alert_id, user_id, symbol, price, message, ts_ms) VALUES (?, ?, ?, ?, ?, ?)",
            (alert["id"], alert["user_id"], alert["symbol"], tick.price, message, tick.ts_ms),
        )
        log.info("alert %s fired for user %s: %s", alert["id"], alert["user_id"], message)
        self.bus.publish(
            UserEvent(
                alert["user_id"],
                {
                    "type": "alert",
                    "id": alert["id"],
                    "symbol": alert["symbol"],
                    "price": tick.price,
                    "message": message,
                    "ts_ms": tick.ts_ms,
                },
            )
        )
