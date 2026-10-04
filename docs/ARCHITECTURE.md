# OpenTerminal Architecture

```
┌─ Windows box ───────────────────────────────────────────────────────────────┐
│                                                                             │
│  NinjaTrader 8                OpenTerminal backend           Browser        │
│  ┌──────────────────┐         ┌─────────────────────┐        ┌───────────┐  │
│  │ TvBridgePublisher │  TCP    │ FastAPI (uvicorn)   │  REST   │ React app │  │
│  │  AddOn (C#)       │ ──────► │                     │ ──────► │           │  │
│  │  NDJSON ticks     │ 5555    │  ingest manager     │   WS    │ LWC v5    │  │
│  └──────────────────┘         │   ├ sim provider     │ ──────► │ charts    │  │
│                               │   ├ ninja provider   │         │ datafeed  │  │
│  Binance WS ──────────────────►│   └ ccxt provider    │         │ adapter   │  │
│  (via ccxt, public)            │   ▼                  │         └───────────┘  │
│                               │  candle aggregator   │                        │
│                               │   ticks → 1m bars    │                        │
│                               │   ▼                   │                        │
│                               │  Parquet store        │                        │
│                               │  (per symbol/day)     │                        │
│                               │   ▼                   │                        │
│                               │  history service      │                        │
│                               │  (resample 1m → Tf)  │                        │
│                               └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Providers** emit `Tick{symbol, ts_ms, price, size, bid, ask}` into the
   ingest manager's queue (drop-on-full — a provider is never blocked).
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
5. **/api/stream (WS)**: per subscriber, `LiveTfAggregator` rebuilds higher-TF
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

## Phase roadmap

- **P1 (done)** — data spine: providers, 1m engine, Parquet, REST+WS, LWC chart, auth
- **P2** — drawing toolbar (`lightweight-charts-drawing`), indicator registry
  (`lightweight-charts-indicators`), layouts, alerts v1
- **P3** — custom-indicator editor (JS sandbox), Python indicator parity layer
- **P4** — screener, backtesting.py integration, bar replay
- **P5** — paper trading, NT8 execution route, Tauri desktop packaging