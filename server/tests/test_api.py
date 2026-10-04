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