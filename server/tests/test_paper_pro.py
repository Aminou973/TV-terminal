"""Pro paper trading: order types, brackets/OCO, reduce-only, modify, journal."""

from __future__ import annotations

import pytest

from app.candles.bus import EventBus
from app.db.database import Database
from app.models import Tick
from app.paper.engine import PaperEngine, PaperError, tick_size


@pytest.fixture()
def db(tmp_path):
    d = Database(tmp_path / "t.db")
    d.connect()
    d.create_user("alice", "x")
    yield d
    d.close()


@pytest.fixture()
def eng(db):
    e = PaperEngine(db, EventBus())
    e.on_tick(Tick("ES", 1, 5000.0))
    return e


def status(db, oid):
    return db.query_one("SELECT status FROM paper_orders WHERE id = ?", (oid,))["status"]


def working(db, **where):
    sql = "SELECT * FROM paper_orders WHERE status = 'working'"
    for k in where:
        sql += f" AND {k} = ?"
    return db.query_all(sql, tuple(where.values()))


def test_bracket_market_entry_attaches_oco_legs_and_tp_cancels_sl(eng, db):
    entry = eng.place(1, "ES", "buy", "market", 2, None, tp=5010, sl=4990)
    assert entry["status"] == "filled"
    legs = working(db)
    assert {(o["tag"], o["type"], o["side"], o["price"], o["qty"]) for o in legs} == {
        ("tp", "limit", "sell", 5010, 2), ("sl", "stop", "sell", 4990, 2)
    }
    assert all(o["reduce_only"] == 1 and o["oco"] == legs[0]["oco"] for o in legs)
    pos = eng.positions(1)[0]
    assert pos["tp"] == 5010 and pos["sl"] == 4990
    eng.on_tick(Tick("ES", 2, 5010.25))  # limit fills at 5010.25 — "or better"
    assert eng.positions(1) == []
    assert working(db) == []
    sl = next(o for o in legs if o["tag"] == "sl")
    assert db.query_one("SELECT status, reason FROM paper_orders WHERE id = ?", (sl["id"],)) == {
        "status": "cancelled", "reason": "oco"
    }
    assert eng.account(1)["realized_pnl"] == pytest.approx(10.25 * 2 * 50)


def test_bracket_on_working_limit_attaches_only_after_fill(eng, db):
    entry = eng.place(1, "ES", "sell", "limit", 1, 5005, tp=4995, sl=5015)
    assert working(db, tag="tp") == [] and status(db, entry["id"]) == "working"
    eng.on_tick(Tick("ES", 2, 5005))
    assert status(db, entry["id"]) == "filled"
    assert len(working(db, reduce_only=1)) == 2
    eng.on_tick(Tick("ES", 3, 5016))  # stop loss
    assert eng.positions(1) == [] and working(db) == []
    assert eng.account(1)["realized_pnl"] == pytest.approx(-11 * 50)


def test_bracket_validation(eng):
    with pytest.raises(PaperError, match="take profit must be above"):
        eng.place(1, "ES", "buy", "market", 1, None, tp=4990)
    with pytest.raises(PaperError, match="stop loss must be above"):
        eng.place(1, "ES", "sell", "limit", 1, 5010, sl=5000)


def test_manual_close_cancels_protective_orders(eng, db):
    eng.place(1, "ES", "buy", "market", 1, None, tp=5020, sl=4980)
    eng.close_position(1, "ES")
    assert working(db) == []


def test_reverse_cancels_wrong_side_brackets_and_flips(eng, db):
    eng.place(1, "ES", "buy", "market", 1, None, tp=5020, sl=4980)
    eng.reverse_position(1, "ES")
    assert eng.positions(1)[0]["qty"] == -1
    assert working(db) == []


def test_reduce_only_is_clamped_and_never_opens(eng, db):
    eng.place(1, "ES", "buy", "market", 1, None)
    o = eng.place(1, "ES", "sell", "limit", 5, 5002, reduce_only=True)
    eng.on_tick(Tick("ES", 2, 5002))
    row = db.query_one("SELECT status, qty FROM paper_orders WHERE id = ?", (o["id"],))
    assert row == {"status": "filled", "qty": 1}
    assert eng.positions(1) == []
    lone = eng.place(1, "ES", "sell", "limit", 1, 5003, reduce_only=True)
    eng.on_tick(Tick("ES", 3, 5004))
    assert status(db, lone["id"]) == "cancelled" and eng.positions(1) == []


def test_position_brackets_replace(eng, db):
    eng.place(1, "ES", "buy", "market", 3, None)
    eng.set_brackets(1, "ES", tp=5030, sl=4970)
    eng.set_brackets(1, "ES", tp=5040, sl=None)
    legs = working(db)
    assert [(o["tag"], o["price"], o["qty"]) for o in legs] == [("tp", 5040, 3)]
    with pytest.raises(PaperError):
        eng.set_brackets(1, "ES", tp=4990, sl=None)
    with pytest.raises(PaperError):
        eng.set_brackets(1, "NQ", tp=1, sl=None)


def test_stop_limit_triggers_then_rests_as_limit(eng, db):
    o = eng.place(1, "ES", "buy", "stop_limit", 1, 5006, stop_price=5005)
    eng.on_tick(Tick("ES", 2, 5004))
    assert db.query_one("SELECT triggered FROM paper_orders WHERE id = ?", (o["id"],))["triggered"] == 0
    eng.on_tick(Tick("ES", 3, 5008))  # triggers, but 5008 is above the 5006 limit
    row = db.query_one("SELECT status, triggered FROM paper_orders WHERE id = ?", (o["id"],))
    assert row == {"status": "working", "triggered": 1}
    eng.on_tick(Tick("ES", 4, 5005.5))
    assert db.query_one("SELECT status, fill_price FROM paper_orders WHERE id = ?", (o["id"],)) == {
        "status": "filled", "fill_price": 5005.5
    }


def test_trailing_stop_follows_and_fires(eng, db):
    eng.place(1, "ES", "buy", "market", 1, None)
    o = eng.place(1, "ES", "sell", "trailing_stop", 1, trail=5)
    assert o["price"] == 4995
    for p in (5003, 5010, 5007):
        eng.on_tick(Tick("ES", 2, p))
    row = db.query_one("SELECT price, trail_ref, status FROM paper_orders WHERE id = ?", (o["id"],))
    assert row == {"price": 5005, "trail_ref": 5010, "status": "working"}
    eng.on_tick(Tick("ES", 3, 5004.75))
    assert status(db, o["id"]) == "filled"
    assert eng.account(1)["realized_pnl"] == pytest.approx(4.75 * 50)


def test_modify_price_qty_and_brackets(eng, db):
    o = eng.place(1, "ES", "buy", "limit", 1, 4990, tp=5000, sl=4980)
    eng.modify(1, o["id"], price=4992, qty=2, sl=4985)
    row = db.query_one("SELECT price, qty, tp, sl FROM paper_orders WHERE id = ?", (o["id"],))
    assert row == {"price": 4992, "qty": 2, "tp": 5000, "sl": 4985}
    eng.modify(1, o["id"], clear_tp=True)
    assert db.query_one("SELECT tp FROM paper_orders WHERE id = ?", (o["id"],))["tp"] is None
    with pytest.raises(PaperError):
        eng.modify(1, o["id"], sl=4995)  # stop above the buy entry
    # dragging a limit through the market fills it, like a real venue
    eng.modify(1, o["id"], price=5001)
    assert status(db, o["id"]) == "filled"
    assert len(working(db, tag="sl")) == 1


def test_cancel_all_and_flatten(eng, db):
    eng.on_tick(Tick("NQ", 1, 18000.0))
    eng.place(1, "ES", "buy", "market", 1, None)
    eng.place(1, "NQ", "sell", "market", 1, None)
    eng.place(1, "ES", "buy", "limit", 1, 4900)
    eng.place(1, "NQ", "buy", "limit", 1, 17000)
    assert eng.cancel_all(1, "ES") == 1
    assert eng.flatten(1) == {"cancelled": 1, "closed": 2}
    assert eng.positions(1) == [] and working(db) == []


def test_journal_round_trip_with_scale_in_out_mae_mfe_and_commission(eng, db):
    eng.configure(1, commission=2.0)
    eng.place(1, "ES", "buy", "market", 1, None)          # 1 @ 5000
    eng.on_tick(Tick("ES", 2, 4996))                       # worst
    eng.on_tick(Tick("ES", 3, 5002))
    eng.place(1, "ES", "buy", "market", 1, None)          # 2 @ 5001 avg
    eng.on_tick(Tick("ES", 4, 5012))                       # best
    eng.place(1, "ES", "sell", "market", 1, None)         # out 1 @ 5012
    eng.on_tick(Tick("ES", 5, 5010))
    eng.place(1, "ES", "sell", "market", 1, None)         # out 1 @ 5010
    (t,) = eng.trades(1)
    assert t["status"] == "closed" and t["side"] == "long" and t["qty"] == 2
    assert t["entry_price"] == pytest.approx(5001) and t["exit_price"] == pytest.approx(5011)
    gross = (11 + 9) * 50
    assert t["commission"] == pytest.approx(8.0)
    assert t["pnl"] == pytest.approx(gross - 8.0)
    assert eng.account(1)["realized_pnl"] == pytest.approx(gross - 8.0)
    assert t["mfe"] == pytest.approx((5012 - 5001) * 2 * 50)
    assert t["mae"] == pytest.approx((4996 - 5001) * 2 * 50)
    assert t["exit_ms"] >= t["entry_ms"]


def test_journal_flip_closes_and_opens_and_notes(eng, db):
    eng.place(1, "ES", "buy", "market", 1, None)
    eng.on_tick(Tick("ES", 2, 5004))
    eng.place(1, "ES", "sell", "market", 3, None)
    trades = eng.trades(1)
    assert [(t["side"], t["status"], t["qty"]) for t in trades] == [("short", "open", 2), ("long", "closed", 1)]
    assert trades[1]["pnl"] == pytest.approx(4 * 50)
    t = eng.annotate_trade(1, trades[0]["id"], "faded the high", "fade,a+")
    assert t["notes"] == "faded the high" and t["tags"] == "fade,a+"
    eng.close_position(1, "ES")
    closed = eng.trades(1)[0]
    assert closed["status"] == "closed" and closed["notes"] == "faded the high"
    assert eng.annotate_trade(1, 999, "x", None) is None


def test_journal_survives_reload(db):
    eng = PaperEngine(db, EventBus())
    eng.on_tick(Tick("ES", 1, 5000.0))
    eng.place(1, "ES", "buy", "market", 1, None, tp=5010)
    eng2 = PaperEngine(db, EventBus())
    eng2.reload()
    eng2.on_tick(Tick("ES", 2, 5010))
    assert eng2.positions(1) == []
    assert eng2.trades(1)[0]["status"] == "closed"


def test_reset_clears_journal_and_keeps_starting_balance(eng, db):
    eng.configure(1, starting_balance=25_000)
    eng.place(1, "ES", "buy", "market", 1, None)
    eng.reset(1)
    assert eng.trades(1) == [] and eng.account(1)["balance"] == 25_000


def test_instrument_and_tick_size(eng):
    assert eng.instrument("SIM:ES") ["tick_size"] == 0.25
    assert tick_size("ZN") == 1 / 64
    assert tick_size("AAPL", 190.0) == 0.01 and tick_size("EURUSD", 1.08) == 0.0001
