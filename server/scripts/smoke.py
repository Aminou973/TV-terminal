"""End-to-end smoke test for OpenTerminal.

Boots the real server (uvicorn subprocess on :8000, real .env settings), then
exercises the full loop: health -> register -> login -> history -> quote ->
WebSocket bar stream. Prints a PASS/FAIL line per check and exits non-zero on
any failure. Kills the server on exit.

Usage:  .venv/Scripts/python scripts/smoke.py
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # server/
sys.path.insert(0, ROOT)

BASE = "http://127.0.0.1:8000"
WS_BASE = "ws://127.0.0.1:8000/api/stream"
SYMBOL = "SIM:ES"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


async def wait_health(client: httpx.AsyncClient, timeout_s: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            r = await client.get(f"{BASE}/api/health")
            if r.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.5)
    return False


async def main() -> int:
    if port_open(8000):
        print("Port 8000 already in use — assuming a server is running there.")
        proc = None
    else:
        print("Booting uvicorn on :8000 ...")
        proc = subprocess.Popen(
            [os.path.join(ROOT, ".venv", "Scripts", "python"), "-m", "uvicorn", "app.main:app", "--port", "8000", "--log-level", "warning"],
            cwd=ROOT,
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            ok = await wait_health(client)
            check("health", ok, "GET /api/health 200 within 30s")
            if not ok:
                return 1

            # -- auth ------------------------------------------------------
            user = f"smoke_{uuid.uuid4().hex[:8]}"
            r = await client.post(f"{BASE}/api/auth/register", json={"username": user, "password": "smoke-pass-1"})
            check("register", r.status_code in (200, 201, 400), f"status {r.status_code}")  # 400 = already exists, fine for reruns
            r = await client.post(f"{BASE}/api/auth/login", data={"username": user, "password": "smoke-pass-1"})
            token = r.json().get("access_token") if r.status_code == 200 else None
            check("login", token is not None, f"status {r.status_code}")
            if not token:
                return 1
            headers = {"Authorization": f"Bearer {token}"}

            # -- symbols / history / quote ---------------------------------
            r = await client.get(f"{BASE}/api/symbols", headers=headers)
            syms = r.json() if r.status_code == 200 else []
            check(
                "symbols",
                any(isinstance(s, dict) and s.get("symbol") == SYMBOL for s in syms),
                f"status {r.status_code}, {len(syms)} symbols",
            )

            # sim provider ticks at 0.2s; give history a moment to build bars
            bars = None
            for _ in range(20):
                r = await client.get(f"{BASE}/api/history", params={"symbol": SYMBOL, "tf": "1m"}, headers=headers)
                if r.status_code == 200 and r.json().get("bars"):
                    bars = r.json()["bars"]
                    break
                await asyncio.sleep(1.5)
            check(
                "history",
                bars is not None and len(bars) >= 1,
                f"{len(bars) if bars else 0} 1m bars" if bars else "no bars yet",
            )
            if bars:
                b = bars[-1]
                fields_ok = all(k in b for k in ("time", "open", "high", "low", "close", "volume"))
                check("history bar shape", fields_ok, json.dumps(b))
                check("history monotonic time", all(bars[i]["time"] < bars[i + 1]["time"] for i in range(len(bars) - 1)))

            # 5m resample via REST should merge the same 1m bars
            r = await client.get(f"{BASE}/api/history", params={"symbol": SYMBOL, "tf": "5m"}, headers=headers)
            ok5 = r.status_code == 200 and isinstance(r.json().get("bars"), list)
            check("history 5m resample", ok5, f"status {r.status_code}, {len(r.json().get('bars') or [])} bars")

            r = await client.get(f"{BASE}/api/quote", params={"symbols": SYMBOL}, headers=headers)
            quotes = (r.json() or {}).get("quotes") if r.status_code == 200 else None
            q = next((x for x in (quotes or []) if x.get("symbol") == SYMBOL), None) if quotes is not None else None
            check("quote", q is not None and q.get("last") is not None, json.dumps(r.json())[:160])

            # -- websocket bar stream --------------------------------------
            import websockets  # shipped with uvicorn[standard]

            ws_ok = False
            quote_ok = False
            got_closed = False
            n_msgs = 0
            first_bar = None
            try:
                async with websockets.connect(f"{WS_BASE}?token={token}", open_timeout=10) as ws:
                    await ws.send(json.dumps({"action": "subscribe", "symbol": SYMBOL, "tf": "1m"}))
                    await ws.send(json.dumps({"action": "subscribe_quotes", "symbols": [SYMBOL]}))
                    # a 1m bar closes only at a minute boundary — wait up to 70s
                    # (>= one full minute) but exit as soon as we have all signals
                    deadline = time.monotonic() + 70.0
                    while time.monotonic() < deadline and not (ws_ok and got_closed and quote_ok and n_msgs >= 3):
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=max(1.0, deadline - time.monotonic()))
                        except asyncio.TimeoutError:
                            break
                        n_msgs += 1
                        msg = json.loads(raw)
                        if msg.get("type") == "bar":
                            ws_ok = True
                            first_bar = msg
                            if msg.get("closed"):
                                got_closed = True
                        elif msg.get("type") == "quote":
                            quote_ok = True
            except Exception as e:  # noqa: BLE001
                check("websocket connect", False, f"{type(e).__name__}: {e}")

            check("ws bar stream", ws_ok, f"{n_msgs} messages in 25s")
            check("ws bar shape", first_bar is not None and all(k in first_bar["bar"] for k in ("time", "open", "high", "low", "close", "volume")) if first_bar else False)
            check("ws closed-bar event", got_closed, "at least one closed=True event (may take >60s on quiet symbols — sim emits every minute)")
            check("ws quote stream", quote_ok)

            # -- ws auth rejection ------------------------------------------
            try:
                async with websockets.connect(f"{WS_BASE}?token=definitely-bad", open_timeout=10) as ws:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    check("ws rejects bad token", False, f"unexpected message: {raw[:80]}")
            except Exception as e:  # noqa: BLE001
                check("ws rejects bad token", True, f"rejected with {type(e).__name__}")
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    failed = [r for r in results if not r[1]]
    print("-" * 60)
    print(f"SMOKE RESULT: {len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))