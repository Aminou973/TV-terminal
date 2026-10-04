"""Paper trading: simulated orders filled against the live tick stream.

- market orders fill at the last traded price when placed
- buy limit fills when price <= limit, sell limit when price >= limit
- buy stop fills when price >= stop,  sell stop when price <= stop
  (limit fills at the limit price, stop fills at the tick price — slippage-ish)

Positions are signed (+long / -short) with an average price; realized P&L is
booked when a fill reduces or flips a position. Futures use their point
value (ES = $50/pt) so P&L is in account currency.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from app.candles.bus import EventBus
from app.candles.sessions import _root
from app.db.database import Database
from app.models import Tick, UserEvent, now_ms

log = logging.getLogger("openterm.paper")

STARTING_BALANCE = 100_000.0

# $ per 1.0 price move, per contract
POINT_VALUE = {
    "ES": 50, "MES": 5, "NQ": 20, "MNQ": 2, "YM": 5, "MYM": 0.5, "RTY": 50, "M2K": 5,
    "CL": 1000, "MCL": 100, "NG": 10000, "GC": 100, "MGC": 10, "SI": 5000, "SIL": 1000,
    "ZB": 1000, "ZN": 1000, "ZF": 1000, "ZT": 2000, "ZC": 50, "ZS": 50, "ZW": 50,
    "6E": 125000, "6J": 12500000, "6B": 62500, "HE": 400, "LE": 400, "PL": 50, "PA": 100,
    "MBT": 0.1,
}


def point_value(symbol: str) -> float:
    return float(POINT_VALUE.get(_root(symbol), 1.0))


class PaperError(ValueError):
    pass


class PaperEngine:
    def __init__(self, db: Database, bus: EventBus):
        self.db = db
        self.bus = bus
        self.last: dict[str, float] = {}
        self._working: dict[str, list[dict]] = {}  # symbol -> working orders
        self._lock = threading.Lock()  # REST threads + the tick loop both fill

    # -- lifecycle -----------------------------------------------------------
    def reload(self) -> None:
        rows = self.db.query_all("SELECT * FROM paper_orders WHERE status = 'working'")
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["symbol"], []).append(r)
        with self._lock:
            self._working = by

    # -- account -------------------------------------------------------------
    def account(self, user_id: int) -> dict:
        acct = self.db.query_one("SELECT * FROM paper_accounts WHERE user_id = ?", (user_id,))
        if acct is None:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_accounts (user_id, starting_balance) VALUES (?, ?)",
                (user_id, STARTING_BALANCE),
            )
            acct = {"user_id": user_id, "starting_balance": STARTING_BALANCE, "realized_pnl": 0.0}
        positions = self.positions(user_id)
        unrealized = sum(p["unrealized_pnl"] for p in positions)
        balance = acct["starting_balance"] + acct["realized_pnl"]
        return {
            "starting_balance": acct["starting_balance"],
            "realized_pnl": acct["realized_pnl"],
            "balance": balance,
            "unrealized_pnl": unrealized,
            "equity": balance + unrealized,
        }

    def reset(self, user_id: int) -> None:
        with self._lock:
            self.db.execute("DELETE FROM paper_positions WHERE user_id = ?", (user_id,))
            self.db.execute(
                "UPDATE paper_orders SET status = 'cancelled' WHERE user_id = ? AND status = 'working'", (user_id,)
            )
            self.db.execute(
                "INSERT INTO paper_accounts (user_id, starting_balance, realized_pnl) VALUES (?, ?, 0) "
                "ON CONFLICT(user_id) DO UPDATE SET realized_pnl = 0, starting_balance = excluded.starting_balance",
                (user_id, STARTING_BALANCE),
            )
        self.reload()
        self._notify(user_id, {"type": "paper", "event": "reset"})

    def positions(self, user_id: int) -> list[dict]:
        rows = self.db.query_all(
            "SELECT symbol, qty, avg_price FROM paper_positions WHERE user_id = ? AND qty != 0 ORDER BY symbol",
            (user_id,),
        )
        out = []
        for r in rows:
            last = self.last.get(r["symbol"], r["avg_price"])
            pv = point_value(r["symbol"])
            out.append(
                {
                    **r,
                    "last": last,
                    "point_value": pv,
                    "unrealized_pnl": (last - r["avg_price"]) * r["qty"] * pv,
                }
            )
        return out

    def orders(self, user_id: int, limit: int = 200) -> list[dict]:
        return self.db.query_all(
            "SELECT * FROM paper_orders WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        )

    # -- orders --------------------------------------------------------------
    def place(self, user_id: int, symbol: str, side: str, type_: str, qty: float, price: Optional[float]) -> dict:
        if side not in ("buy", "sell"):
            raise PaperError("side must be buy or sell")
        if type_ not in ("market", "limit", "stop"):
            raise PaperError("type must be market, limit or stop")
        if not qty or qty <= 0:
            raise PaperError("qty must be positive")
        if type_ != "market" and (price is None or price <= 0):
            raise PaperError(f"{type_} orders need a price")
        last = self.last.get(symbol)
        if type_ == "market" and last is None:
            raise PaperError(f"no live price for {symbol} yet")

        self.account(user_id)  # make sure the account exists
        oid = self.db.execute(
            "INSERT INTO paper_orders (user_id, symbol, side, type, qty, price, status, created_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, 'working', ?)",
            (user_id, symbol, side, type_, qty, price, now_ms()),
        )
        order = self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (oid,))
        if type_ == "market":
            self._fill(order, last)
        else:
            with self._lock:
                self._working.setdefault(symbol, []).append(order)
            # a limit already marketable fills right away, like a real venue
            if last is not None and self._crosses(order, last):
                self._fill(order, self._fill_price(order, last))
            else:
                self._notify(user_id, {"type": "paper", "event": "order", "order": order})
        return self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (oid,))

    def cancel(self, user_id: int, order_id: int) -> bool:
        with self._lock:
            n = self.db.query_one(
                "SELECT id FROM paper_orders WHERE id = ? AND user_id = ? AND status = 'working'", (order_id, user_id)
            )
            if n is None:
                return False
            self.db.execute("UPDATE paper_orders SET status = 'cancelled' WHERE id = ?", (order_id,))
            for sym, orders in self._working.items():
                self._working[sym] = [o for o in orders if o["id"] != order_id]
        self._notify(user_id, {"type": "paper", "event": "cancel", "order_id": order_id})
        return True

    def close_position(self, user_id: int, symbol: str) -> Optional[dict]:
        pos = self.db.query_one(
            "SELECT qty FROM paper_positions WHERE user_id = ? AND symbol = ?", (user_id, symbol)
        )
        if pos is None or pos["qty"] == 0:
            return None
        side = "sell" if pos["qty"] > 0 else "buy"
        return self.place(user_id, symbol, side, "market", abs(pos["qty"]), None)

    # -- tick path -----------------------------------------------------------
    def on_tick(self, tick: Tick) -> None:
        self.last[tick.symbol] = tick.price
        orders = self._working.get(tick.symbol)
        if not orders:
            return
        for order in [o for o in orders if self._crosses(o, tick.price)]:
            self._fill(order, self._fill_price(order, tick.price))

    @staticmethod
    def _crosses(order: dict, price: float) -> bool:
        if order["type"] == "limit":
            return price <= order["price"] if order["side"] == "buy" else price >= order["price"]
        if order["type"] == "stop":
            return price >= order["price"] if order["side"] == "buy" else price <= order["price"]
        return True

    @staticmethod
    def _fill_price(order: dict, price: float) -> float:
        if order["type"] == "limit":
            return min(price, order["price"]) if order["side"] == "buy" else max(price, order["price"])
        return price

    def _fill(self, order: dict, price: float) -> None:
        with self._lock:
            row = self.db.query_one("SELECT status FROM paper_orders WHERE id = ?", (order["id"],))
            if row is None or row["status"] != "working":
                return  # cancelled or filled by a concurrent path
            ts = now_ms()
            self.db.execute(
                "UPDATE paper_orders SET status = 'filled', fill_price = ?, filled_ms = ? WHERE id = ?",
                (price, ts, order["id"]),
            )
            sym = order["symbol"]
            if sym in self._working:
                self._working[sym] = [o for o in self._working[sym] if o["id"] != order["id"]]
            realized = self._apply_fill(order["user_id"], sym, order["side"], order["qty"], price)
        log.info("paper fill #%s %s %s %s @ %s", order["id"], order["side"], order["qty"], sym, price)
        self._notify(
            order["user_id"],
            {
                "type": "paper",
                "event": "fill",
                "order_id": order["id"],
                "symbol": sym,
                "side": order["side"],
                "qty": order["qty"],
                "price": price,
                "realized_pnl": realized,
                "ts_ms": ts,
            },
        )

    def _apply_fill(self, user_id: int, symbol: str, side: str, qty: float, price: float) -> float:
        """Update the position; returns the P&L realized by this fill."""
        signed = qty if side == "buy" else -qty
        pos = self.db.query_one(
            "SELECT qty, avg_price FROM paper_positions WHERE user_id = ? AND symbol = ?", (user_id, symbol)
        )
        cur_qty, avg = (pos["qty"], pos["avg_price"]) if pos else (0.0, 0.0)
        realized = 0.0
        if cur_qty == 0 or (cur_qty > 0) == (signed > 0):
            # opening or adding: weighted average
            new_qty = cur_qty + signed
            avg = (avg * abs(cur_qty) + price * abs(signed)) / abs(new_qty)
        else:
            closing = min(abs(signed), abs(cur_qty))
            direction = 1 if cur_qty > 0 else -1
            realized = (price - avg) * closing * direction * point_value(symbol)
            new_qty = cur_qty + signed
            if new_qty == 0:
                avg = 0.0
            elif (new_qty > 0) != (cur_qty > 0):
                avg = price  # flipped: the remainder opened at this price
        self.db.execute(
            "INSERT INTO paper_positions (user_id, symbol, qty, avg_price) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id, symbol) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price",
            (user_id, symbol, new_qty, avg),
        )
        if realized:
            self.db.execute(
                "UPDATE paper_accounts SET realized_pnl = realized_pnl + ? WHERE user_id = ?", (realized, user_id)
            )
        return realized

    def _notify(self, user_id: int, payload: dict) -> None:
        self.bus.publish(UserEvent(user_id, payload))
