"""Paper trading: simulated orders filled against the live tick stream.

Order types
- market        fills at the last traded price when placed
- limit         buy fills when price <= limit, sell when price >= limit (at the limit or better)
- stop          buy fills when price >= stop, sell when price <= stop (at the tick price)
- stop_limit    once price reaches `stop_price` the order becomes a limit at `price`
- trailing_stop a stop that follows the market by `trail`; `price` is the current stop level

Brackets and OCO
- an entry order may carry `tp` / `sl`; when it fills, a take-profit limit and a
  stop-loss stop are attached as reduce-only orders sharing one OCO group
- when an order in an OCO group fills, the rest of the group is cancelled
- reduce-only orders never open or add to a position: they are clamped to the
  position size, and cancelled once the position is flat or flips

Positions are signed (+long / -short) with an average price; realized P&L is
booked when a fill reduces or flips a position, net of the account's
commission. Futures use their point value (ES = $50/pt) so P&L is in account
currency. Every flat → open → flat cycle is recorded in `paper_trades` (the
trade journal) with its price extremes for MAE / MFE.
"""

from __future__ import annotations

import logging
import math
import threading
from typing import Callable, Optional

from app.candles.bus import EventBus
from app.candles.sessions import _root
from app.db.database import Database
from app.models import Tick, UserEvent, now_ms

log = logging.getLogger("openterm.paper")

STARTING_BALANCE = 100_000.0
ORDER_TYPES = ("market", "limit", "stop", "stop_limit", "trailing_stop")

# $ per 1.0 price move, per contract
POINT_VALUE = {
    "ES": 50, "MES": 5, "NQ": 20, "MNQ": 2, "YM": 5, "MYM": 0.5, "RTY": 50, "M2K": 5,
    "CL": 1000, "MCL": 100, "NG": 10000, "GC": 100, "MGC": 10, "SI": 5000, "SIL": 1000,
    "ZB": 1000, "ZN": 1000, "ZF": 1000, "ZT": 2000, "ZC": 50, "ZS": 50, "ZW": 50,
    "6E": 125000, "6J": 12500000, "6B": 62500, "HE": 400, "LE": 400, "PL": 50, "PA": 100,
    "MBT": 0.1,
}

# minimum price increment
TICK_SIZE = {
    "ES": 0.25, "MES": 0.25, "NQ": 0.25, "MNQ": 0.25, "YM": 1, "MYM": 1, "RTY": 0.1, "M2K": 0.1,
    "CL": 0.01, "MCL": 0.01, "NG": 0.001, "GC": 0.1, "MGC": 0.1, "SI": 0.005, "SIL": 0.005,
    "ZB": 1 / 32, "ZN": 1 / 64, "ZF": 1 / 128, "ZT": 1 / 256, "ZC": 0.25, "ZS": 0.25, "ZW": 0.25,
    "6E": 0.00005, "6J": 0.0000005, "6B": 0.0001, "HE": 0.025, "LE": 0.025, "PL": 0.1, "PA": 0.5,
    "MBT": 5,
}


def point_value(symbol: str) -> float:
    return float(POINT_VALUE.get(_root(symbol), 1.0))


def tick_size(symbol: str, price: Optional[float] = None) -> float:
    t = TICK_SIZE.get(_root(symbol))
    if t is not None:
        return float(t)
    if price is None:
        return 0.01
    a = abs(price)
    return 0.00001 if a < 1 else 0.0001 if a < 10 else 0.01


class PaperError(ValueError):
    pass


class PaperEngine:
    def __init__(self, db: Database, bus: EventBus, price_lookup: Optional[Callable[[str], Optional[float]]] = None):
        self.db = db
        self.bus = bus
        # fallback for symbols without a live tick (e.g. a closed market): last stored close
        self.price_lookup = price_lookup
        self.last: dict[str, float] = {}
        self._working: dict[str, list[dict]] = {}  # symbol -> working orders
        self._trades: dict[tuple[int, str], dict] = {}  # (user, symbol) -> open journal trade
        # REST threads + the tick loop both fill; re-entrant because a fill can
        # attach bracket legs and cancel OCO siblings while holding it
        self._lock = threading.RLock()

    # -- lifecycle -----------------------------------------------------------
    def reload(self) -> None:
        rows = self.db.query_all("SELECT * FROM paper_orders WHERE status = 'working'")
        by: dict[str, list[dict]] = {}
        for r in rows:
            by.setdefault(r["symbol"], []).append(r)
        trades = self.db.query_all("SELECT * FROM paper_trades WHERE status = 'open'")
        with self._lock:
            self._working = by
            self._trades = {(t["user_id"], t["symbol"]): t for t in trades}

    # -- account -------------------------------------------------------------
    def _account_row(self, user_id: int) -> dict:
        acct = self.db.query_one("SELECT * FROM paper_accounts WHERE user_id = ?", (user_id,))
        if acct is None:
            self.db.execute(
                "INSERT OR IGNORE INTO paper_accounts (user_id, starting_balance) VALUES (?, ?)",
                (user_id, STARTING_BALANCE),
            )
            acct = {"user_id": user_id, "starting_balance": STARTING_BALANCE, "realized_pnl": 0.0, "commission": 0.0}
        return acct

    def account(self, user_id: int) -> dict:
        acct = self._account_row(user_id)
        positions = self.positions(user_id)
        unrealized = sum(p["unrealized_pnl"] for p in positions)
        balance = acct["starting_balance"] + acct["realized_pnl"]
        return {
            "starting_balance": acct["starting_balance"],
            "realized_pnl": acct["realized_pnl"],
            "commission": acct.get("commission") or 0.0,
            "balance": balance,
            "unrealized_pnl": unrealized,
            "equity": balance + unrealized,
        }

    def configure(self, user_id: int, starting_balance: Optional[float] = None, commission: Optional[float] = None) -> dict:
        self._account_row(user_id)
        if starting_balance is not None:
            if starting_balance <= 0:
                raise PaperError("starting balance must be positive")
            self.db.execute("UPDATE paper_accounts SET starting_balance = ? WHERE user_id = ?", (starting_balance, user_id))
        if commission is not None:
            if commission < 0:
                raise PaperError("commission cannot be negative")
            self.db.execute("UPDATE paper_accounts SET commission = ? WHERE user_id = ?", (commission, user_id))
        return self.account(user_id)

    def reset(self, user_id: int) -> None:
        with self._lock:
            start = self._account_row(user_id)["starting_balance"]
            self.db.execute("DELETE FROM paper_positions WHERE user_id = ?", (user_id,))
            self.db.execute("DELETE FROM paper_trades WHERE user_id = ?", (user_id,))
            self.db.execute(
                "UPDATE paper_orders SET status = 'cancelled', reason = 'reset' WHERE user_id = ? AND status = 'working'",
                (user_id,),
            )
            self.db.execute("UPDATE paper_accounts SET realized_pnl = 0, starting_balance = ? WHERE user_id = ?", (start, user_id))
        self.reload()
        self._notify(user_id, {"type": "paper", "event": "reset"})

    def _last(self, symbol: str) -> Optional[float]:
        last = self.last.get(symbol)
        if last is None and self.price_lookup is not None:
            last = self.price_lookup(symbol)
        return last

    def instrument(self, symbol: str) -> dict:
        last = self._last(symbol)
        return {"symbol": symbol, "point_value": point_value(symbol), "tick_size": tick_size(symbol, last), "last": last}

    def positions(self, user_id: int) -> list[dict]:
        rows = self.db.query_all(
            "SELECT symbol, qty, avg_price FROM paper_positions WHERE user_id = ? AND qty != 0 ORDER BY symbol",
            (user_id,),
        )
        working = self.db.query_all(
            "SELECT symbol, tag, price FROM paper_orders WHERE user_id = ? AND status = 'working' AND reduce_only = 1",
            (user_id,),
        )
        out = []
        for r in rows:
            last = self._last(r["symbol"])
            if last is None:
                last = r["avg_price"]
            pv = point_value(r["symbol"])
            tp = next((o["price"] for o in working if o["symbol"] == r["symbol"] and o["tag"] == "tp"), None)
            sl = next((o["price"] for o in working if o["symbol"] == r["symbol"] and o["tag"] == "sl"), None)
            out.append(
                {
                    **r,
                    "last": last,
                    "point_value": pv,
                    "unrealized_pnl": (last - r["avg_price"]) * r["qty"] * pv,
                    "tp": tp,
                    "sl": sl,
                }
            )
        return out

    def _position_qty(self, user_id: int, symbol: str) -> float:
        pos = self.db.query_one("SELECT qty FROM paper_positions WHERE user_id = ? AND symbol = ?", (user_id, symbol))
        return pos["qty"] if pos else 0.0

    def orders(self, user_id: int, limit: int = 200) -> list[dict]:
        return self.db.query_all(
            "SELECT * FROM paper_orders WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        )

    # -- journal -------------------------------------------------------------
    def trades(self, user_id: int, symbol: Optional[str] = None, limit: int = 500) -> list[dict]:
        sql = "SELECT * FROM paper_trades WHERE user_id = ?"
        args: list = [user_id]
        if symbol:
            sql += " AND symbol = ?"
            args.append(symbol)
        rows = self.db.query_all(sql + " ORDER BY id DESC LIMIT ?", (*args, limit))
        out = []
        for t in rows:
            live = self._trades.get((user_id, t["symbol"]))
            if live is not None and live["id"] == t["id"]:
                t = {**t, "high": live["high"], "low": live["low"]}
            pv = point_value(t["symbol"])
            d = 1 if t["side"] == "long" else -1
            best, worst = (t["high"], t["low"]) if d == 1 else (t["low"], t["high"])
            out.append(
                {
                    **t,
                    "mfe": (best - t["entry_price"]) * d * t["qty"] * pv,
                    "mae": (worst - t["entry_price"]) * d * t["qty"] * pv,
                    "point_value": pv,
                }
            )
        return out

    def annotate_trade(self, user_id: int, trade_id: int, notes: Optional[str], tags: Optional[str]) -> Optional[dict]:
        row = self.db.query_one("SELECT id FROM paper_trades WHERE id = ? AND user_id = ?", (trade_id, user_id))
        if row is None:
            return None
        if notes is not None:
            self.db.execute("UPDATE paper_trades SET notes = ? WHERE id = ?", (notes, trade_id))
            if (live := self._find_live_trade(trade_id)) is not None:
                live["notes"] = notes
        if tags is not None:
            self.db.execute("UPDATE paper_trades SET tags = ? WHERE id = ?", (tags, trade_id))
            if (live := self._find_live_trade(trade_id)) is not None:
                live["tags"] = tags
        return next((t for t in self.trades(user_id) if t["id"] == trade_id), None)

    def _find_live_trade(self, trade_id: int) -> Optional[dict]:
        return next((t for t in self._trades.values() if t["id"] == trade_id), None)

    # -- orders --------------------------------------------------------------
    def place(
        self,
        user_id: int,
        symbol: str,
        side: str,
        type_: str,
        qty: float,
        price: Optional[float] = None,
        *,
        stop_price: Optional[float] = None,
        trail: Optional[float] = None,
        tp: Optional[float] = None,
        sl: Optional[float] = None,
        reduce_only: bool = False,
        tag: str = "",
        oco: Optional[str] = None,
        parent_id: Optional[int] = None,
    ) -> dict:
        if side not in ("buy", "sell"):
            raise PaperError("side must be buy or sell")
        if type_ not in ORDER_TYPES:
            raise PaperError(f"type must be one of {', '.join(ORDER_TYPES)}")
        if not qty or qty <= 0 or not math.isfinite(qty):
            raise PaperError("qty must be positive")
        last = self._last(symbol)
        if type_ in ("limit", "stop", "stop_limit") and (price is None or price <= 0):
            raise PaperError(f"{type_.replace('_', ' ')} orders need a price")
        if type_ == "stop_limit" and (stop_price is None or stop_price <= 0):
            raise PaperError("stop limit orders need a stop price")
        trail_ref = None
        if type_ == "trailing_stop":
            if trail is None or trail <= 0:
                raise PaperError("trailing stops need a positive trail distance")
            if last is None:
                raise PaperError(f"no live price for {symbol} yet")
            trail_ref = last
            price = last - trail if side == "sell" else last + trail
        if type_ == "market" and last is None:
            raise PaperError(f"no live price for {symbol} yet")
        if (tp is not None or sl is not None) and reduce_only:
            raise PaperError("brackets can only be attached to an entry order")
        ref = {"market": last, "limit": price, "stop": price, "stop_limit": price, "trailing_stop": price}[type_]
        self._check_bracket(side, ref, tp, sl)

        self._account_row(user_id)  # make sure the account exists
        oid = self.db.execute(
            "INSERT INTO paper_orders (user_id, symbol, side, type, qty, price, stop_price, trail, trail_ref, tp, sl,"
            " reduce_only, tag, oco, parent_id, status, created_ms)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?)",
            (user_id, symbol, side, type_, qty, price, stop_price, trail, trail_ref, tp, sl,
             int(reduce_only), tag or ("entry" if tp is not None or sl is not None else ""), oco, parent_id, now_ms()),
        )
        order = self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (oid,))
        if type_ == "market":
            self._fill(order, last)
        else:
            with self._lock:
                self._working.setdefault(symbol, []).append(order)
            self._notify(user_id, {"type": "paper", "event": "order", "order": order})
            # a limit already marketable fills right away, like a real venue
            if last is not None:
                self._evaluate(order, last)
        return self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (oid,))

    @staticmethod
    def _check_bracket(side: str, ref: Optional[float], tp: Optional[float], sl: Optional[float]) -> None:
        for name, v in (("take profit", tp), ("stop loss", sl)):
            if v is not None and (not math.isfinite(v) or v <= 0):
                raise PaperError(f"{name} must be a positive price")
        if ref is None:
            return
        if side == "buy":
            if tp is not None and tp <= ref:
                raise PaperError("take profit must be above the entry for a buy")
            if sl is not None and sl >= ref:
                raise PaperError("stop loss must be below the entry for a buy")
        else:
            if tp is not None and tp >= ref:
                raise PaperError("take profit must be below the entry for a sell")
            if sl is not None and sl <= ref:
                raise PaperError("stop loss must be above the entry for a sell")

    def modify(
        self,
        user_id: int,
        order_id: int,
        *,
        price: Optional[float] = None,
        qty: Optional[float] = None,
        stop_price: Optional[float] = None,
        trail: Optional[float] = None,
        tp: Optional[float] = None,
        sl: Optional[float] = None,
        clear_tp: bool = False,
        clear_sl: bool = False,
    ) -> dict:
        with self._lock:
            order = self.db.query_one(
                "SELECT * FROM paper_orders WHERE id = ? AND user_id = ? AND status = 'working'", (order_id, user_id)
            )
            if order is None:
                raise PaperError("no working order with that id")
            if order["type"] == "market":
                raise PaperError("market orders cannot be modified")
            changes: dict = {}
            if qty is not None:
                if qty <= 0:
                    raise PaperError("qty must be positive")
                changes["qty"] = qty
            if trail is not None:
                if order["type"] != "trailing_stop" or trail <= 0:
                    raise PaperError("trail only applies to trailing stops and must be positive")
                ref = order["trail_ref"]
                changes["trail"] = trail
                changes["price"] = ref - trail if order["side"] == "sell" else ref + trail
            if price is not None:
                if price <= 0:
                    raise PaperError("price must be positive")
                if order["type"] == "trailing_stop":
                    # dragging a trailing stop moves its distance from the best price
                    changes["trail"] = abs(order["trail_ref"] - price)
                changes["price"] = price
            if stop_price is not None:
                if order["type"] != "stop_limit":
                    raise PaperError("stop price only applies to stop limit orders")
                changes["stop_price"] = stop_price
            if tp is not None or clear_tp:
                changes["tp"] = None if clear_tp else tp
            if sl is not None or clear_sl:
                changes["sl"] = None if clear_sl else sl
            merged = {**order, **changes}
            if merged["tp"] is not None or merged["sl"] is not None:
                self._check_bracket(merged["side"], merged["price"], merged["tp"], merged["sl"])
            if changes:
                cols = ", ".join(f"{k} = ?" for k in changes)
                self.db.execute(f"UPDATE paper_orders SET {cols} WHERE id = ?", (*changes.values(), order_id))
                for o in self._working.get(order["symbol"], []):
                    if o["id"] == order_id:
                        o.update(changes)
        self._notify(user_id, {"type": "paper", "event": "modify", "order_id": order_id})
        last = self.last.get(order["symbol"])
        live = next((o for o in self._working.get(order["symbol"], []) if o["id"] == order_id), None)
        if last is not None and live is not None:
            self._evaluate(live, last)
        return self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (order_id,))

    def cancel(self, user_id: int, order_id: int, reason: str = "") -> bool:
        with self._lock:
            n = self.db.query_one(
                "SELECT id FROM paper_orders WHERE id = ? AND user_id = ? AND status = 'working'", (order_id, user_id)
            )
            if n is None:
                return False
            self.db.execute("UPDATE paper_orders SET status = 'cancelled', reason = ? WHERE id = ?", (reason or None, order_id))
            for sym, orders in self._working.items():
                self._working[sym] = [o for o in orders if o["id"] != order_id]
        self._notify(user_id, {"type": "paper", "event": "cancel", "order_id": order_id})
        return True

    def cancel_all(self, user_id: int, symbol: Optional[str] = None) -> int:
        sql = "SELECT id FROM paper_orders WHERE user_id = ? AND status = 'working'"
        args: tuple = (user_id,)
        if symbol:
            sql += " AND symbol = ?"
            args = (user_id, symbol)
        ids = [r["id"] for r in self.db.query_all(sql, args)]
        return sum(self.cancel(user_id, i) for i in ids)

    def close_position(self, user_id: int, symbol: str) -> Optional[dict]:
        qty = self._position_qty(user_id, symbol)
        if qty == 0:
            return None
        side = "sell" if qty > 0 else "buy"
        return self.place(user_id, symbol, side, "market", abs(qty), None, tag="close")

    def reverse_position(self, user_id: int, symbol: str) -> Optional[dict]:
        qty = self._position_qty(user_id, symbol)
        if qty == 0:
            return None
        side = "sell" if qty > 0 else "buy"
        return self.place(user_id, symbol, side, "market", abs(qty) * 2, None, tag="reverse")

    def flatten(self, user_id: int) -> dict:
        cancelled = self.cancel_all(user_id)
        closed = 0
        for p in self.positions(user_id):
            if self.close_position(user_id, p["symbol"]) is not None:
                closed += 1
        return {"cancelled": cancelled, "closed": closed}

    def set_brackets(self, user_id: int, symbol: str, tp: Optional[float], sl: Optional[float]) -> list[dict]:
        """Replace the take-profit / stop-loss protecting an open position."""
        qty = self._position_qty(user_id, symbol)
        if qty == 0:
            raise PaperError(f"no open position in {symbol}")
        exit_side = "sell" if qty > 0 else "buy"
        last = self._last(symbol)
        # validate as if entering from the current price, in the position's direction
        self._check_bracket("buy" if qty > 0 else "sell", last, tp, sl)
        existing = self.db.query_all(
            "SELECT id FROM paper_orders WHERE user_id = ? AND symbol = ? AND status = 'working' AND reduce_only = 1"
            " AND tag IN ('tp', 'sl')",
            (user_id, symbol),
        )
        for o in existing:
            self.cancel(user_id, o["id"], "replaced")
        group = f"pos-{user_id}-{symbol}-{now_ms()}"
        out = []
        if tp is not None:
            out.append(self.place(user_id, symbol, exit_side, "limit", abs(qty), tp, reduce_only=True, tag="tp", oco=group))
        if sl is not None:
            out.append(self.place(user_id, symbol, exit_side, "stop", abs(qty), sl, reduce_only=True, tag="sl", oco=group))
        return out

    # -- tick path -----------------------------------------------------------
    def on_tick(self, tick: Tick) -> None:
        self.last[tick.symbol] = tick.price
        for (uid, sym), t in list(self._trades.items()):
            if sym == tick.symbol:
                if tick.price > t["high"]:
                    t["high"] = tick.price
                elif tick.price < t["low"]:
                    t["low"] = tick.price
        orders = self._working.get(tick.symbol)
        if not orders:
            return
        for order in list(orders):
            self._evaluate(order, tick.price)

    def _evaluate(self, order: dict, price: float) -> None:
        """Advance trailing / stop-limit state for one working order and fill it if marketable."""
        if order["type"] == "trailing_stop":
            ref = order["trail_ref"]
            better = price > ref if order["side"] == "sell" else price < ref
            if better:
                order["trail_ref"] = price
                order["price"] = price - order["trail"] if order["side"] == "sell" else price + order["trail"]
                self.db.execute(
                    "UPDATE paper_orders SET trail_ref = ?, price = ? WHERE id = ? AND status = 'working'",
                    (order["trail_ref"], order["price"], order["id"]),
                )
        elif order["type"] == "stop_limit" and not order["triggered"]:
            hit = price >= order["stop_price"] if order["side"] == "buy" else price <= order["stop_price"]
            if not hit:
                return
            order["triggered"] = 1
            self.db.execute("UPDATE paper_orders SET triggered = 1 WHERE id = ?", (order["id"],))
            self._notify(order["user_id"], {"type": "paper", "event": "triggered", "order_id": order["id"]})
        if self._crosses(order, price):
            self._fill(order, self._fill_price(order, price))

    @staticmethod
    def _crosses(order: dict, price: float) -> bool:
        t = order["type"]
        if t in ("limit", "stop_limit"):
            if t == "stop_limit" and not order["triggered"]:
                return False
            return price <= order["price"] if order["side"] == "buy" else price >= order["price"]
        if t in ("stop", "trailing_stop"):
            return price >= order["price"] if order["side"] == "buy" else price <= order["price"]
        return True

    @staticmethod
    def _fill_price(order: dict, price: float) -> float:
        if order["type"] in ("limit", "stop_limit"):
            return min(price, order["price"]) if order["side"] == "buy" else max(price, order["price"])
        return price

    def _fill(self, order: dict, price: float) -> None:
        events: list[tuple[int, dict]] = []
        attached: list[dict] = []
        with self._lock:
            row = self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (order["id"],))
            if row is None or row["status"] != "working":
                return  # cancelled or filled by a concurrent path
            uid, sym, qty = row["user_id"], row["symbol"], row["qty"]
            if row["reduce_only"]:
                pos = self._position_qty(uid, sym)
                reduces = (pos > 0 and row["side"] == "sell") or (pos < 0 and row["side"] == "buy")
                if not reduces:
                    self._cancel_locked(row, "position closed", events)
                    self._flush(events)
                    return
                qty = min(qty, abs(pos))
            ts = now_ms()
            self.db.execute(
                "UPDATE paper_orders SET status = 'filled', qty = ?, fill_price = ?, filled_ms = ? WHERE id = ?",
                (qty, price, ts, row["id"]),
            )
            self._drop_working(row["id"], sym)
            realized, commission = self._apply_fill(uid, sym, row["side"], qty, price, ts)
            events.append((uid, {
                "type": "paper", "event": "fill", "order_id": row["id"], "symbol": sym, "side": row["side"],
                "qty": qty, "price": price, "realized_pnl": realized, "commission": commission, "tag": row["tag"], "ts_ms": ts,
            }))
            # one leg of an OCO group done → the others go
            if row["oco"]:
                for o in self.db.query_all(
                    "SELECT * FROM paper_orders WHERE oco = ? AND status = 'working' AND id != ?", (row["oco"], row["id"])
                ):
                    self._cancel_locked(o, "oco", events)
            # protective orders that no longer protect anything
            pos = self._position_qty(uid, sym)
            for o in self.db.query_all(
                "SELECT * FROM paper_orders WHERE user_id = ? AND symbol = ? AND status = 'working' AND reduce_only = 1",
                (uid, sym),
            ):
                if pos == 0 or (pos > 0 and o["side"] == "buy") or (pos < 0 and o["side"] == "sell"):
                    self._cancel_locked(o, "position closed", events)
            # bracket legs ride on the entry's fill
            if row["tp"] is not None or row["sl"] is not None:
                exit_side = "sell" if row["side"] == "buy" else "buy"
                group = f"bracket-{row['id']}"
                for leg, type_, lvl in (("tp", "limit", row["tp"]), ("sl", "stop", row["sl"])):
                    if lvl is None:
                        continue
                    lid = self.db.execute(
                        "INSERT INTO paper_orders (user_id, symbol, side, type, qty, price, reduce_only, tag, oco, parent_id,"
                        " status, created_ms) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'working', ?)",
                        (uid, sym, exit_side, type_, qty, lvl, leg, group, row["id"], ts),
                    )
                    leg_row = self.db.query_one("SELECT * FROM paper_orders WHERE id = ?", (lid,))
                    self._working.setdefault(sym, []).append(leg_row)
                    attached.append(leg_row)
                    events.append((uid, {"type": "paper", "event": "order", "order": leg_row}))
        log.info("paper fill #%s %s %s %s @ %s", row["id"], row["side"], qty, sym, price)
        self._flush(events)
        # a gap can leave a fresh leg already marketable
        last = self.last.get(sym)
        if last is not None:
            for leg_row in attached:
                self._evaluate(leg_row, last)

    def _cancel_locked(self, order: dict, reason: str, events: list) -> None:
        self.db.execute("UPDATE paper_orders SET status = 'cancelled', reason = ? WHERE id = ?", (reason, order["id"]))
        self._drop_working(order["id"], order["symbol"])
        events.append((order["user_id"], {"type": "paper", "event": "cancel", "order_id": order["id"], "reason": reason}))

    def _drop_working(self, order_id: int, symbol: str) -> None:
        if symbol in self._working:
            self._working[symbol] = [o for o in self._working[symbol] if o["id"] != order_id]

    def _flush(self, events: list[tuple[int, dict]]) -> None:
        for uid, payload in events:
            self._notify(uid, payload)
        events.clear()

    def _apply_fill(self, user_id: int, symbol: str, side: str, qty: float, price: float, ts: int) -> tuple[float, float]:
        """Update the position and the journal; returns (net P&L realized by this fill, commission)."""
        signed = qty if side == "buy" else -qty
        pos = self.db.query_one(
            "SELECT qty, avg_price FROM paper_positions WHERE user_id = ? AND symbol = ?", (user_id, symbol)
        )
        cur_qty, avg = (pos["qty"], pos["avg_price"]) if pos else (0.0, 0.0)
        commission = (self._account_row(user_id).get("commission") or 0.0) * qty
        gross = 0.0
        closing = 0.0
        if cur_qty == 0 or (cur_qty > 0) == (signed > 0):
            # opening or adding: weighted average
            new_qty = cur_qty + signed
            avg = (avg * abs(cur_qty) + price * abs(signed)) / abs(new_qty)
        else:
            closing = min(abs(signed), abs(cur_qty))
            direction = 1 if cur_qty > 0 else -1
            gross = (price - avg) * closing * direction * point_value(symbol)
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
        net = gross - commission
        if net:
            self.db.execute("UPDATE paper_accounts SET realized_pnl = realized_pnl + ? WHERE user_id = ?", (net, user_id))
        self._journal(user_id, symbol, cur_qty, new_qty, avg, price, closing, gross, commission, ts)
        return net, commission

    def _journal(self, user_id: int, symbol: str, cur_qty: float, new_qty: float, avg: float, price: float,
                 closing: float, gross: float, commission: float, ts: int) -> None:
        key = (user_id, symbol)
        t = self._trades.get(key)
        flipped = cur_qty != 0 and new_qty != 0 and (new_qty > 0) != (cur_qty > 0)
        opening_share = commission
        if t is not None:
            if closing:
                # split commission between the closing and (if flipping) opening parts
                share = commission * (closing / (closing + abs(new_qty))) if flipped else commission
                opening_share = commission - share
                t["exit_price"] = ((t["exit_price"] or 0) * t["exit_qty"] + price * closing) / (t["exit_qty"] + closing)
                t["exit_qty"] += closing
                t["pnl"] += gross - share
                t["commission"] += share
            else:
                t["entry_price"] = avg
                t["qty"] = max(t["qty"], abs(new_qty))
                t["pnl"] -= commission
                t["commission"] += commission
            if new_qty == 0 or flipped:
                t["status"] = "closed"
                t["exit_ms"] = ts
                del self._trades[key]
            self.db.execute(
                "UPDATE paper_trades SET qty = ?, entry_price = ?, exit_price = ?, exit_qty = ?, exit_ms = ?, pnl = ?,"
                " commission = ?, high = ?, low = ?, status = ? WHERE id = ?",
                (t["qty"], t["entry_price"], t["exit_price"], t["exit_qty"], t.get("exit_ms"), t["pnl"], t["commission"],
                 max(t["high"], price), min(t["low"], price), t["status"], t["id"]),
            )
        if new_qty != 0 and (cur_qty == 0 or flipped):
            side = "long" if new_qty > 0 else "short"
            tid = self.db.execute(
                "INSERT INTO paper_trades (user_id, symbol, side, qty, entry_price, entry_ms, pnl, commission, high, low)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, symbol, side, abs(new_qty), avg, ts, -opening_share, opening_share, price, price),
            )
            self._trades[key] = self.db.query_one("SELECT * FROM paper_trades WHERE id = ?", (tid,))

    def _notify(self, user_id: int, payload: dict) -> None:
        self.bus.publish(UserEvent(user_id, payload))
