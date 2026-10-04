# NT Bridge — NinjaScript AddOn

Streams NinjaTrader 8 market data to the OpenTerminal backend as NDJSON over a
localhost TCP socket (`127.0.0.1:5555`), and optionally accepts orders back.

## Design principles

1. **NT8 stability first.** Data callbacks (`MarketData.Update`,
   `MarketDepth.Update`) only render a JSON line and enqueue it — no network
   work on NT's threads. One background task owns the socket; the queue is
   bounded and cleared when no client is connected.
2. **Zero dependencies.** Plain `System.Net.Sockets` — no DLLs to copy into
   NT8's folders, nothing to break on NT8 updates.
3. **The backend reconnects.** NT8 can restart freely; the backend retries every 2s.

## Install

1. Copy `TvBridgePublisher.cs` to
   `Documents\NinjaTrader 8\bin\Custom\AddOns\TvBridgePublisher.cs`.
2. NinjaScript Editor → compile (F5).
3. Control Center → **New → OpenTerminal Bridge**.
4. Enter instruments by full name (`ES 12-25, NQ 12-25, CL 01-26`) and click **Start**.
5. Start the OpenTerminal server on the same machine — symbols appear under
   their root (`ES`, `NQ`) with 5 days of 1m history backfilled on connect.

> Written against the NT8 AddOn API (`AddOnBase`, `MarketData`,
> `MarketDepth<MarketDepthRow>`, `BarsRequest`, `Account.CreateOrder`).
> It hasn't been compiled inside NinjaTrader by the maintainers yet — if the
> NinjaScript Editor reports an error, please open an issue with the message.

## Wire format

NT → backend:

```
{"type":"tick","symbol":"ES","contract":"ES 12-25","ts_ms":1725000000000,"price":4821.25,"size":3,"bid":4821.00,"ask":4821.50}
{"type":"book","symbol":"ES","bids":[[4821.0,12],…],"asks":[[4821.25,9],…]}
{"type":"bars","symbol":"ES","tf":"1m","bars":[[time_s,o,h,l,c,v],…]}
{"type":"status","message":"connected"}
{"type":"order_update","ref":"…","order_id":"…","state":"Filled","filled":1,"avg_price":4821.25,"error":""}
```

backend → NT (ignored unless routing is allowed in the window):

```
{"type":"order","ref":"…","account":"Sim101","contract":"ES 12-25","action":"Buy","order_type":"Market","qty":1,"limit":0,"stop":0}
{"type":"cancel","ref":"…"}
```

- `ts_ms` — event time in unix ms (UTC); bar times are bar **start** in unix seconds.
- One backend client at a time.

## Order routing

Three independent switches must all be on before an order reaches an account:

1. Server: `OPENTERM_NINJA_ORDERS_ENABLED=true` (and `OPENTERM_NINJA_ORDER_ACCOUNT`, default `Sim101`).
2. OpenTerminal: only the **admin** user sees the *Route: NinjaTrader* option, and confirms each order.
3. AddOn window: **Allow order routing** ticked, and the account listed in *Accounts allowed*.

The AddOn only reports updates for orders it placed (named `OT-<ref>`).
Test on `Sim101` first.

## Notes & limits

- Ticks are **last-trade** events; the backend builds 1-minute candles (volume = sum of trade sizes).
- Depth is the top 10 levels, at most 4 snapshots per second per instrument.
- Your CME data subscription governs what NT8 receives; keep the platform
  LAN-internal (see the main README legal notes).
