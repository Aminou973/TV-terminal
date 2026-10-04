"""Alert and paper-trading engine logic, against a throwaway SQLite DB."""

from __future__ import annotations

import pytest

from app.alerts.engine import AlertEngine, triggered
from app.candles.bus import EventBus
from app.db.database import Database
from app.models import Tick, UserEvent
from app.paper.engine import PaperEngine, PaperError, point_value


@pytest.fixture()
def db(tmp_path):
    d = Database(tmp_path / "t.db")
    d.connect()
    d.create_user("alice", "x")
    yield d
    d.close()


def _events(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return [e for e in out if isinstance(e, UserEvent)]


def test_trigger_conditions():
    assert triggered("crossing_up", 100, 99, 100)
    assert not triggered("crossing_up", 100, 101, 102)
    assert triggered("crossing_down", 100, 101, 99.5)
    assert triggered("crossing", 100, 101, 99.5)
    assert not triggered("crossing", 100, None, 100)
    assert triggered("greater", 100, None, 100.5)
    assert triggered("less", 100, None, 99)


def test_alert_fires_once_and_logs(db):
    bus = EventBus()
    q = bus.subscribe()
    eng = AlertEngine(db, bus)
    db.execute("INSERT INTO alerts (user_id, symbol, condition, price) VALUES (1, 'ES', 'crossing_up', 100)")
    eng.reload()
    for p in (99, 99.5, 100.25, 99, 101):
        eng.on_tick(Tick("ES", 1, p))
    evs = _events(q)
    assert len(evs) == 1 and evs[0].user_id == 1 and evs[0].payload["type"] == "alert"
    assert db.query_one("SELECT active FROM alerts")["active"] == 0
    assert len(db.query_all("SELECT * FROM alert_log")) == 1


def test_paper_market_round_trip_with_point_value(db):
    eng = PaperEngine(db, EventBus())
    eng.on_tick(Tick("ES", 1, 5000.0))
    eng.place(1, "ES", "buy", "market", 2, None)
    eng.on_tick(Tick("ES", 2, 5010.0))
    pos = eng.positions(1)[0]
    assert pos["qty"] == 2 and pos["avg_price"] == 5000.0
    assert pos["unrealized_pnl"] == 10 * 2 * 50
    eng.close_position(1, "ES")
    acct = eng.account(1)
    assert acct["realized_pnl"] == 1000.0
    assert eng.positions(1) == []


def test_paper_limit_and_stop_fill_on_ticks(db):
    eng = PaperEngine(db, EventBus())
    eng.on_tick(Tick("AAPL", 1, 100.0))
    lim = eng.place(1, "AAPL", "buy", "limit", 10, 98.0)
    stop = eng.place(1, "AAPL", "sell", "stop", 4, 97.0)
    assert lim["status"] == stop["status"] == "working"
    eng.on_tick(Tick("AAPL", 2, 97.9))  # limit fills at 98 (or better)
    assert db.query_one("SELECT status, fill_price FROM paper_orders WHERE id = ?", (lim["id"],)) == {
        "status": "filled",
        "fill_price": 97.9,
    }
    eng.on_tick(Tick("AAPL", 3, 96.5))  # stop triggers
    pos = eng.positions(1)[0]
    assert pos["qty"] == 6
    assert eng.account(1)["realized_pnl"] == pytest.approx((96.5 - 97.9) * 4)


def test_paper_flip_and_cancel(db):
    eng = PaperEngine(db, EventBus())
    eng.on_tick(Tick("X", 1, 10.0))
    eng.place(1, "X", "buy", "market", 1, None)
    eng.on_tick(Tick("X", 2, 12.0))
    eng.place(1, "X", "sell", "market", 3, None)  # close 1, open short 2 @ 12
    pos = eng.positions(1)[0]
    assert pos["qty"] == -2 and pos["avg_price"] == 12.0
    o = eng.place(1, "X", "buy", "limit", 1, 5.0)
    assert eng.cancel(1, o["id"]) and not eng.cancel(1, o["id"])
    with pytest.raises(PaperError):
        eng.place(1, "NOPRICE", "buy", "market", 1, None)


def test_point_values():
    assert point_value("ES") == 50 and point_value("SIM:ES") == 50 and point_value("AAPL") == 1
