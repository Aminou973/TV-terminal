"""NinjaTrader bridge provider against a fake AddOn on a real localhost socket."""

from __future__ import annotations

import asyncio
import json

from app.ingest.providers.ninja_tcp import NinjaTcpProvider


async def test_bridge_round_trip():
    received: list[dict] = []
    ready = asyncio.Event()

    async def fake_addon(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        frames = [
            {"type": "status", "message": "connected"},
            {"type": "tick", "symbol": "ES", "contract": "ES 12-25", "ts_ms": 1_800_000_000_000, "price": 5000.25, "size": 2, "bid": 5000, "ask": 5000.5},
            {"type": "book", "symbol": "ES", "bids": [[5000, 10]], "asks": [[5000.5, 12]]},
            {"type": "bars", "symbol": "ES", "tf": "1m", "bars": [[1_800_000_000, 1, 2, 0.5, 1.5, 100]]},
            "not json",
            {"type": "order_update", "ref": "abc", "state": "Filled", "filled": 1, "avg_price": 5000.5},
        ]
        for f in frames:
            writer.write(((f if isinstance(f, str) else json.dumps(f)) + "\n").encode())
        await writer.drain()
        ready.set()
        line = await reader.readline()
        received.append(json.loads(line))
        writer.close()

    server = await asyncio.start_server(fake_addon, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    ticks, books, bars, updates = [], [], [], []

    async def sink(t):
        ticks.append(t)

    p = NinjaTcpProvider(
        "127.0.0.1", port,
        on_bars=lambda s, tf, b: bars.extend(b),
        on_book=lambda s, b, a: books.append((s, b, a)),
        on_order_update=updates.append,
    )
    task = asyncio.create_task(p.run(sink))
    await asyncio.wait_for(ready.wait(), 5)
    for _ in range(50):
        if updates:
            break
        await asyncio.sleep(0.02)
    assert ticks[0].symbol == "ES" and ticks[0].price == 5000.25 and ticks[0].bid == 5000
    assert p.contracts == {"ES": "ES 12-25"}
    assert books == [("ES", [[5000, 10]], [[5000.5, 12]])]
    assert bars[0].time == 1_800_000_000 and bars[0].close == 1.5
    assert updates[0]["state"] == "Filled"
    assert p.connected
    await p.send({"type": "order", "ref": "x1", "action": "Buy", "qty": 1})
    for _ in range(50):
        if received:
            break
        await asyncio.sleep(0.02)
    assert received == [{"type": "order", "ref": "x1", "action": "Buy", "qty": 1}]
    task.cancel()
    server.close()
