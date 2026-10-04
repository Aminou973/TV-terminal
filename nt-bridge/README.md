# NT Bridge — NinjaScript AddOn

Streams NinjaTrader 8 market data to the OpenTerminal backend as NDJSON over a
localhost TCP socket (default `127.0.0.1:5555`).

## Design principles

1. **NT8 stability first.** The AddOn is publish-only: `OnMarketData` enqueues a
   pre-rendered JSON line to a `ConcurrentQueue` and returns — no network work,
   no blocking, ever — on NT's data threads. One background thread owns the socket.
2. **Zero dependencies.** Plain `System.Net.Sockets` — no DLLs to copy into
   NT8's folders, no version conflicts, nothing to break on NT8 updates.
3. **The backend reconnects.** NT8 can restart freely; the backend's TCP client
   retries every 2s.

## Install

1. Close NinjaTrader.
2. Copy `TvBridgePublisher.cs` to:
   `Documents\NinjaTrader 8\bin\Custom\AddOns\TvBridgePublisher.cs`
3. Open NT8 → New → **Tv Bridge Publisher**.
4. Enter symbols (comma-separated instrument names NT8 understands,
   e.g. `ES 12-25, NQ 12-25, CL 12-26, MES 12-25`) and click **Start**.
5. Start the OpenTerminal backend — it connects and the symbols appear
   automatically under `/api/symbols`.

## Wire format

```
{"type":"tick","symbol":"ES","ts_ms":1725000000000,"price":4821.25,"size":3,"bid":4821.00,"ask":4821.50}
{"type":"status","message":"connected"}
```

- `ts_ms` — exchange event time in unix ms (UTC)
- One backend client at a time (the platform); multiple clients can be added
  later by re-pumping the queue.

## Notes & limits

- The AddOn publishes **last-trade** events; the backend aggregates them into
  1-minute candles (volume = sum of trade sizes). NT prints can be added later
  the same way.
- Historical backfill (`BarsRequest` dump at startup) is planned as a frame type
  `{"type":"bars", …}` — the backend already accepts it.
- Your CME data subscription governs what NT8 receives; keep the platform
  LAN-internal (see main README legal notes).