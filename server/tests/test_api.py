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
    r = client.get("/api/history", params={"symbol": "SIM:ES", "tf": "7m"}, headers=_auth_headers(token))
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
