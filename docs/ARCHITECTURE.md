# OpenTerminal Architecture

```
┌─ your machine / LAN ─────────────────────────────────────────────────────────────┐
│                                                                                  │
│  NinjaTrader 8 ── TCP NDJSON ⇄ ─┐   FastAPI backend                Browser       │
│  (OpenTerminal Bridge AddOn)    │   ┌──────────────────────────┐   ┌───────────┐ │
│                                 ├──►│ ingest manager           │   │ React app │ │
│  Yahoo (yfinance, polled 1m) ───┤   │  ├ ticks → 1m aggregator │──►│ LWC v5    │ │
│  Binance (ccxt, WS trades) ─────┤   │  ├ bars  → 1m aggregator │ WS│ drawings  │ │
│  tick simulator ────────────────┘   │  └ books (depth)         │   │ 876 ind.  │ │
│                                     │      ▼ event bus         │REST│ OpenScript│ │
│                                     │  tick listeners:          │◄──│ (worker)  │ │
│                                     │   alerts · paper fills    │   │ tester    │ │
│                                     │      ▼                    │   │ replay    │ │
│                                     │  Parquet (symbol/day)     │   └───────────┘ │
│                                     │  SQLite (users, layouts,  │                 │
│                                     │   drawings, scripts,      │                 │
│                                     │   alerts, paper account)  │                 │
│                                     └──────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Providers** emit `Tick{symbol, ts_ms, price, size, bid, ask}` (or, for
   bar-only feeds like yfinance, whole 1m `Bar`s) into the ingest manager's
   queue (drop-on-full — a provider is never blocked). Depth snapshots go
   straight to the bus as throttled `BookEvent`s.
2. **CandleAggregator** folds ticks into forming 1m bars (bar time = minute
   bucket start, TradingView convention) and publishes `BarEvent`s to the
   event bus:
   - `closed=False` — throttled forming-bar updates (default 0.2s/symbol)
   - `closed=True` — once per minute; also persisted via the store hook
3. **CandleParquetStore** buffers closed bars and flushes
   `data/candles/<symbol>/1m/<YYYYMMDD>.parquet` every 2s (day files are
   small; rewrites are cheap and deduplicate by bar time).
4. **CandleService.history()** reads stored 1m bars, appends the live forming
   bar, and resamples to the requested TF with session-aware daily bucketing
   (CME day opens 17:00 CT).
5. **Tick listeners** run after aggregation: the alert engine (crossing
   semantics against the previous tick) and the paper engine (limit/stop
   fills). Their results are `UserEvent`s routed only to the owning user's
   sockets.
6. **/api/stream (WS)**: per subscriber, `LiveTfAggregator` rebuilds higher-TF
   bars from the same 1m event stream — identical bucketing to the history
   resample, so live bars always match history (no client-side math drift).

## Why these choices

- **1m as the single base timeframe**: one aggregation path, one storage
  layout, one resample implementation shared by history and live. Sub-minute
  TFs later need a tick store (planned: `data/ticks/`).
- **Server-side resampling**: parity between what REST history serves and
  what WS streams push is structural, not tested-in.
- **NDJSON TCP instead of ZeroMQ**: zero dependencies inside NT8 beats pub/sub
  semantics we don't need (single consumer). ZMQ upgrade path stays open.
- **SQLite for users/workspaces** at small-team scale; Parquet for candles
  (analytical shape, per-day files). DuckDB enters when SQL analytics are
  needed (screener), reading the same Parquet files — no migration.

## Timeframe conventions

| TF | Bucketing |
|---|---|
| 1m | minute (base, persisted) |
| 5m/15m/30m/1h/4h | UTC-anchored floor |
| 1D | session-anchored: CME 17:00 CT · crypto UTC 00:00 · stocks/forex 00:00 ET |

Bar `time` = bucket start in unix seconds (LWC `UTCTimestamp`).

## Web app

- **ChartPane** owns one Lightweight Charts instance: main series per chart
  type (Heikin Ashi computed client-side), volume overlay, indicator layers in
  their own panes, a `DrawingManager` from lightweight-charts-drawing, and
  price lines for alerts, paper positions and working orders.
- **Indicators** come from `lightweight-charts-indicators` (lazy chunk) or
  from user scripts; both produce the same `{plots, markers}` output.
- **OpenScript** runs in a dedicated Web Worker (no DOM, no auth token) with a
  timeout that kills the worker. Strategies use the same runtime: orders fill
  at the next bar's open, stop-loss before take-profit inside a bar.
- **State**: Zustand stores; layouts, watchlists, drawings and scripts are
  saved server-side per user; UI conveniences in localStorage.

## Phase roadmap

- **P1 (done)** — data spine: providers, 1m engine, Parquet, REST+WS, LWC chart, auth
- **P2 (done)** — 86 drawing tools, indicator registry (876), layouts, alerts
- **P3 (done)** — OpenScript editor (JS sandbox in a worker) for indicators and strategies
- **P4 (done)** — screener, strategy tester, bar replay
- **P5 (done)** — paper trading, NT8 order route (opt-in), Docker image, installable PWA
- **Next** — tick store for sub-minute TFs, server-side alert conditions on indicators,
  Python indicator parity layer, Tauri desktop wrapper, multi-account brokers
