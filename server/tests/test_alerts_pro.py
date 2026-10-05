"""Pro alerts: indicator maths, line levels, frequencies, indicator/script alerts, delivery."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.alerts import indicators
from app.alerts.engine import AlertEngine, compare, line_level
from app.alerts.notify import DeliveryError, check_public_url, deliver, render
from app.candles.bus import EventBus
from app.config import Settings
from app.db.database import Database
from app.models import Bar, Tick, UserEvent


@pytest.fixture()
def db(tmp_path):
    d = Database(tmp_path / "t.db")
    d.connect()
    d.create_user("alice", "x")
    yield d
    d.close()


def bars_from(closes, step=60):
    return [Bar("X", i * step, c, c + 0.5, c - 0.5, c, 10) for i, c in enumerate(closes)]


def add_alert(db, **kw):
    row = {"user_id": 1, "symbol": "X", "kind": "price", "condition": "crossing", "price": 0, "params": "{}",
           "tf": "1m", "frequency": "once", "message": "", "notify": "{}"}
    row.update({k: json.dumps(v) if isinstance(v, dict) else v for k, v in kw.items()})
    cols = ", ".join(row)
    return db.execute(f"INSERT INTO alerts ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def events(q):
    out = []
    while not q.empty():
        e = q.get_nowait()
        if isinstance(e, UserEvent):
            out.append(e.payload)
    return out


# ------------------------------------------------------------- indicators ----
def test_indicator_maths():
    assert indicators.sma([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5]
    assert indicators.ema([1.0] * 5, 3)[2:] == [1.0, 1.0, 1.0]
    up = indicators.rsi([float(i) for i in range(30)], 14)
    assert up[-1] == 100.0 and up[13] is None
    bars = bars_from([10 + (i % 7) for i in range(60)])
    macd = indicators.compute(bars, {"ind": "macd", "output": "hist"})
    assert len(macd) == 60 and macd[-1] is not None
    assert indicators.compute(bars, {"value": 70})[-1] == 70.0
    with pytest.raises(ValueError):
        indicators.compute(bars, {"ind": "nope"})
    assert indicators.describe({"ind": "rsi", "length": 14}) == "RSI(14)"
    assert indicators.describe({"ind": "macd", "output": "signal"}).endswith(".signal")
    assert {c["id"] for c in indicators.catalog()} >= {"rsi", "sma", "ema", "macd", "bb", "stoch", "price"}


def test_compare_and_line_level():
    assert compare("crossing_up", 69, 71, 70, 70) and not compare("crossing_up", 70, 70.0, 70, 70)
    assert compare("crossing_down", 71, 69, 70, 70)
    assert line_level({"t1": 0, "p1": 100, "t2": 100, "p2": 200}, 50) == 150
    assert line_level({"t1": 0, "p1": 100, "t2": 100, "p2": 200}, 200) == 300  # extends right by default
    assert line_level({"t1": 0, "p1": 100, "t2": 100, "p2": 200, "extend": "none"}, 200) is None


# ------------------------------------------------------------------ engine ----
def test_line_alert_and_frequencies(db):
    bus = EventBus()
    q = bus.subscribe()
    eng = AlertEngine(db, bus, Settings())
    # rising line 100 → 200 over 100 s; price crosses it upward
    add_alert(db, kind="line", condition="crossing_up", params={"t1": 0, "p1": 100, "t2": 100, "p2": 200}, frequency="every_time")
    add_alert(db, kind="price", condition="greater", price=50, frequency="once_per_minute")
    eng.reload()
    eng.on_tick(Tick("X", 10_000, 105))   # line at 110: below
    eng.on_tick(Tick("X", 20_000, 125))   # line at 120: crossed up
    eng.on_tick(Tick("X", 21_000, 126))   # above but no new cross; greater fires only once a minute
    fired = events(q)
    msgs = [e["message"] for e in fired]
    assert sum("trend line" in m for m in msgs) == 1
    assert sum("greater" in m for m in msgs) == 1


def test_expiry_deactivates(db):
    eng = AlertEngine(db, EventBus(), Settings())
    add_alert(db, condition="greater", price=1, expires_ms=1)
    eng.reload()
    eng.on_tick(Tick("X", 1, 5))
    row = db.query_one("SELECT active, error FROM alerts")
    assert row == {"active": 0, "error": "expired"}


def test_indicator_alert_on_bar_close(db):
    closes = [50.0] * 30 + [50 - i for i in range(10)] + [45 + 3 * i for i in range(10)]  # RSI dips then recovers
    hist = bars_from(closes)
    eng = AlertEngine(db, EventBus(), Settings(), history=lambda s, tf, n: hist)
    rsi = indicators.rsi([b.close for b in hist], 14)
    level = (rsi[-2] + rsi[-1]) / 2  # a level the last bar crosses upward
    add_alert(db, kind="indicator", condition="crossing_up", frequency="once_per_bar_close",
              params={"left": {"ind": "rsi", "length": 14}, "right": {"value": level}})
    eng.reload()
    eng._buckets[("X", "1m")] = hist[-1].time + 60  # the bar after the last one is forming
    hits = eng.evaluate_group(("X", "1m"), closed_only=True)
    assert len(hits) == 1 and hits[0][2] == hist[-1].time


def test_script_alerts_condition_and_strategy(db):
    hist = bars_from([10.0 + i for i in range(40)])
    eng = AlertEngine(db, EventBus(), Settings(), history=lambda s, tf, n: hist)
    add_alert(db, kind="script", frequency="once_per_bar_close",
              params={"source": "alertcondition(close.map(c => c > 45), 'High', 'up {{close}}')", "condition": "High"})
    add_alert(db, kind="script", frequency="once_per_bar_close",
              params={"source": "strategy.onBar(i => { if (i === bar_count - 2) strategy.entry('L', 'long') })", "condition": "strategy"})
    add_alert(db, kind="script", frequency="once_per_bar_close", params={"source": "plot(close)", "condition": "missing"})
    eng.reload()
    hits = eng.evaluate_group(("X", "1m"), closed_only=True)
    assert len(hits) == 2
    strat = [h for h in hits if "strategy.order.action" in h[3]][0]
    assert strat[3]["strategy.order.action"] == "buy"
    assert "not found" in db.query_one("SELECT error FROM alerts WHERE id = 3")["error"]


# ------------------------------------------------------------------ notify ----
def test_render_placeholders():
    out = render('{"t":"{{ticker}}","p":{{close}}} {{unknown}}', {"ticker": "ES", "close": 5000.25})
    assert out == '{"t":"ES","p":5000.25} {{unknown}}'


def test_webhook_guard_and_delivery():
    got = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_port}/hook"

    async def main():
        with pytest.raises(DeliveryError):
            await check_public_url(url, allow_private=False)
        with pytest.raises(DeliveryError):
            await check_public_url("file:///etc/passwd", allow_private=True)
        ok = Settings(alerts_allow_private_webhooks=True)
        s1 = await deliver({"webhook": url}, {}, ok, "t", '{"side":"buy"}', {"a": 1})
        s2 = await deliver({"webhook": url}, {}, ok, "t", "plain text", {"a": 1})
        s3 = await deliver({"telegram": True, "email": True}, {}, Settings(), "t", "m", {})
        return s1, s2, s3

    s1, s2, s3 = asyncio.run(main())
    srv.shutdown()
    assert s1 == "webhook: 200" and got[0] == {"side": "buy"}
    assert got[1] == {"text": "plain text", "a": 1}
    assert "telegram: failed" in s3 and "email: failed" in s3


def test_migration_adds_columns(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT DEFAULT 'member', created_at TEXT);"
        "CREATE TABLE alerts (id INTEGER PRIMARY KEY, user_id INTEGER, symbol TEXT, condition TEXT, price REAL,"
        " message TEXT DEFAULT '', once INTEGER DEFAULT 1, active INTEGER DEFAULT 1, created_at TEXT, triggered_at TEXT);"
        "CREATE TABLE alert_log (id INTEGER PRIMARY KEY, alert_id INTEGER, user_id INTEGER, symbol TEXT, price REAL, message TEXT, ts_ms INTEGER);"
        "INSERT INTO alerts (user_id, symbol, condition, price, once) VALUES (1, 'ES', 'greater', 1, 0);"
    )
    con.commit()
    con.close()
    d = Database(path)
    d.connect()
    row = d.query_one("SELECT kind, frequency, notify, tf FROM alerts")
    assert row == {"kind": "price", "frequency": "every_time", "notify": "{}", "tf": "1m"}
    d.close()
