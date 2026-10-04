"""API integration tests against the full app (sim provider only — no ccxt/ninja).

These exercise the whole pipeline headlessly: register → login → history → WS stream.
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _register_and_token(client: TestClient, username: str | None = None) -> str:
    username = username or f"trader-{uuid.uuid4().hex[:8]}"
    r = client.post("/api/auth/register", json={"username": username, "password": "secret123"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_health_and_auth_flow(client):
    # health is public
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] in ("ok", "starting")

    # symbols require auth
    r = client.get("/api/symbols")
    assert r.status_code == 401

    token = _register_and_token(client, username="flowuser")
    r = client.get("/api/auth/me", headers=_auth_headers(token))
    assert r.status_code == 200
    assert r.json()["username"] == "flowuser"

    # login works
    r = client.post("/api/auth/login", data={"username": "flowuser", "password": "secret123"})
    assert r.status_code == 200 and "access_token" in r.json()


def test_history_returns_sim_bars(client):
    token = _register_and_token(client)
    r = client.get("/api/history", params={"symbol": "SIM:ES", "tf": "1m"}, headers=_auth_headers(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["symbol"] == "SIM:ES"
    assert len(body["bars"]) >= 1
    b = body["bars"][0]
    assert set(b) == {"time", "open", "high", "low", "close", "volume"}


def test_history_resamples_5m(client):
    token = _register_and_token(client)
    r5 = client.get("/api/history", params={"symbol": "SIM:ES", "tf": "5m"}, headers=_auth_headers(token))
    assert r5.status_code == 200
    bars = r5.json()["bars"]
    assert len(bars) >= 1
    for b in bars:
        assert b["time"] % 300 == 0, "5m bars must sit on 5-minute boundaries"


def test_history_rejects_bad_tf(client):
    token = _register_and_token(client)
    r = client.get("/api/history", params={"symbol": "SIM:ES", "tf": "7x"}, headers=_auth_headers(token))
    assert r.status_code == 400


def test_ws_stream_pushes_bars(client):
    token = _register_and_token(client)
    with client.websocket_connect(f"/api/stream?token={token}") as ws:
        ws.send_json({"action": "subscribe", "symbol": "SIM:ES", "tf": "1m"})
        # sim ticks flow every 0.2s; a bar event must arrive quickly
        msg = json.loads(ws.receive_text())
        assert msg["type"] == "bar"
        assert msg["symbol"] == "SIM:ES"
        assert msg["tf"] == "1m"
        assert "open" in msg["bar"]


def test_ws_rejects_bad_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/api/stream?token=garbage"):
            pass

def test_symbols_listed_once(client):
    token = _register_and_token(client)
    names = [s["symbol"] for s in client.get("/api/symbols", headers=_auth_headers(token)).json()]
    assert "SIM-ES" not in names
    assert len(names) == len(set(names))


def test_ws_survives_bad_messages_and_streams_trades_and_book(client):
    token = _register_and_token(client)
    with client.websocket_connect(f"/api/stream?token={token}") as ws:
        ws.send_text("not json")
        ws.send_json(["not", "a", "dict"])
        ws.send_json({"action": "subscribe_trades", "symbol": "SIM:ES"})
        ws.send_json({"action": "subscribe_book", "symbol": "SIM:ES"})
        ws.send_json({"action": "subscribe", "symbol": "SIM:ES", "tf": "5m"})
        seen = set()
        for _ in range(200):
            msg = json.loads(ws.receive_text())
            seen.add(msg["type"])
            if {"trade", "book", "bar"} <= seen:
                break
        assert {"trade", "book", "bar"} <= seen


def test_workspace_crud(client):
    h = _auth_headers(_register_and_token(client))
    assert client.put("/api/watchlists", json={"name": "Main", "symbols": ["ES", "NQ"]}, headers=h).status_code == 200
    assert client.get("/api/watchlists", headers=h).json()[0]["symbols"] == ["ES", "NQ"]
    client.put("/api/layouts", json={"name": "Default", "spec": {"grid": "2x1"}}, headers=h)
    assert client.get("/api/layouts", headers=h).json()[0]["spec"] == {"grid": "2x1"}
    client.put("/api/drawings/SIM:ES", json={"data": [{"kind": "trend-line"}]}, headers=h)
    assert client.get("/api/drawings/SIM:ES", headers=h).json()["data"] == [{"kind": "trend-line"}]
    s = client.put("/api/scripts", json={"name": "My MA", "kind": "indicator", "source": "plot(close)"}, headers=h)
    assert s.status_code == 200
    assert client.delete(f"/api/scripts/{s.json()['id']}", headers=h).json() == {"ok": True}
    # another user can't see them
    other = _auth_headers(_register_and_token(client))
    assert client.get("/api/watchlists", headers=other).json() == []


def test_alerts_and_paper_api(client):
    h = _auth_headers(_register_and_token(client))
    a = client.post("/api/alerts", json={"symbol": "SIM:ES", "condition": "greater", "price": 1}, headers=h)
    assert a.status_code == 200
    with client.websocket_connect(f"/api/stream?token={h['Authorization'][7:]}") as ws:
        for _ in range(100):
            msg = json.loads(ws.receive_text())
            if msg["type"] == "alert":
                break
        assert msg["type"] == "alert" and msg["symbol"] == "SIM:ES"
    o = client.post("/api/paper/orders", json={"symbol": "SIM:ES", "side": "buy", "qty": 1}, headers=h)
    assert o.status_code == 200 and o.json()["status"] == "filled"
    acct = client.get("/api/paper/account", headers=h).json()
    assert acct["positions"][0]["qty"] == 1
    assert client.post("/api/paper/positions/SIM:ES/close", headers=h).status_code == 200
    assert client.post("/api/paper/orders", json={"symbol": "SIM:ES", "side": "buy", "type": "limit", "qty": 1}, headers=h).status_code == 400


def test_history_limit_stats_screener(client):
    h = _auth_headers(_register_and_token(client))
    r = client.get("/api/history", params={"symbol": "SIM:ES", "tf": "1m", "limit": 1}, headers=h)
    assert len(r.json()["bars"]) == 1
    st = client.get("/api/stats", params={"symbol": "SIM:ES"}, headers=h).json()
    assert {"last", "change_pct", "high", "low"} <= set(st)
    batch = client.get("/api/stats", params={"symbols": "SIM:ES,NOPE"}, headers=h).json()["stats"]
    assert [b["symbol"] for b in batch] == ["SIM:ES"]
    rows = client.get("/api/screener", headers=h).json()["rows"]
    assert any(r["symbol"] == "SIM:ES" for r in rows)


def test_ninja_routing_is_off_by_default(client):
    h = _auth_headers(_register_and_token(client))
    st = client.get("/api/broker/ninja/status", headers=h).json()
    assert st["enabled"] is False and st["connected"] is False
    r = client.post("/api/broker/ninja/orders", json={"symbol": "ES", "side": "buy", "qty": 1}, headers=h)
    assert r.status_code in (400, 403)


def test_templates(client):
    h = _auth_headers(_register_and_token(client))
    t = client.put("/api/templates", json={"kind": "indicators", "name": "Scalp", "spec": [{"id": "rsi"}]}, headers=h)
    assert t.status_code == 200 and t.json()["spec"] == [{"id": "rsi"}]
    assert [x["name"] for x in client.get("/api/templates?kind=indicators", headers=h).json()] == ["Scalp"]
    assert client.get("/api/templates?kind=chart", headers=h).json() == []
    client.delete(f"/api/templates/{t.json()['id']}", headers=h)
    assert client.get("/api/templates?kind=indicators", headers=h).json() == []


def test_pro_alerts_api(client):
    h = _auth_headers(_register_and_token(client))
    cat = client.get("/api/alerts/catalog", headers=h).json()
    assert any(i["id"] == "rsi" for i in cat["indicators"]) and "once_per_bar_close" in cat["frequencies"]
    ok = client.post("/api/alerts", headers=h, json={
        "symbol": "SIM:ES", "kind": "indicator", "condition": "crossing_up", "tf": "5m", "frequency": "once_per_bar_close",
        "params": {"left": {"ind": "rsi", "length": 14}, "right": {"value": 70}},
        "notify": {"webhook": "https://example.com/hook"}, "message": "{{ticker}} RSI > 70",
    })
    assert ok.status_code == 200, ok.text
    assert ok.json()["notify"] == {"webhook": "https://example.com/hook"}
    bad = client.post("/api/alerts", headers=h, json={"symbol": "SIM:ES", "kind": "indicator", "params": {"left": {"ind": "nope"}, "right": {"value": 1}}})
    assert bad.status_code == 400
    assert client.post("/api/alerts", headers=h, json={"symbol": "SIM:ES", "kind": "script", "params": {"name": "none", "condition": "x"}}).status_code == 400
    client.put("/api/scripts", headers=h, json={"name": "S", "kind": "indicator", "source": "alertcondition(close.map(c => c > 0), 'Up')"})
    sc = client.post("/api/alerts", headers=h, json={"symbol": "SIM:ES", "kind": "script", "params": {"name": "S", "condition": "Up"}})
    assert sc.status_code == 200 and "source" not in sc.json()["params"]
    line = client.post("/api/alerts", headers=h, json={"symbol": "SIM:ES", "kind": "line", "params": {"t1": 0, "p1": 1, "t2": 60, "p2": 2}})
    assert line.status_code == 200
    upd = client.put(f"/api/alerts/{line.json()['id']}", headers=h, json={"symbol": "SIM:ES", "kind": "price", "price": 3, "frequency": "every_time"})
    assert upd.json()["kind"] == "price" and upd.json()["frequency"] == "every_time"
    assert client.put("/api/alerts/settings", headers=h, json={"telegram_chat_id": "42", "email": "a@b.c"}).status_code == 200
    assert client.get("/api/alerts/settings", headers=h).json()["telegram_chat_id"] == "42"
    assert client.post("/api/alerts/test", headers=h, json={}).status_code == 400
    t = client.post("/api/alerts/test", headers=h, json={"email": True})
    assert "email: failed" in t.json()["status"]


def test_ws_reconnect_churn(client):
    # client disconnects used to race the handler's teardown and leak a CancelledError
    token = _register_and_token(client)
    for _ in range(25):
        with client.websocket_connect(f"/api/stream?token={token}") as ws:
            ws.send_json({"action": "subscribe", "symbol": "SIM:ES", "tf": "1m"})
            assert json.loads(ws.receive_text())["type"] == "bar"
