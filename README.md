# OpenTerminal

A self-hosted, open-source TradingView replica. CME futures from your NinjaTrader 8, crypto, stocks, and your own data — charted in the browser with the official TradingView Lightweight Charts engine.

![status](https://img.shields.io/badge/status-Phase%201%20data%20spine-yellow) ![license](https://img.shields.io/badge/license-MIT-blue)

## Stack

| Layer | Component |
|---|---|
| Chart | [Lightweight Charts v5](https://github.com/tradingview/lightweight-charts) (Apache-2.0) + drawing/indicator plugins (MIT) |
| Backend | Python 3.12+ · FastAPI · WebSockets · SQLite (users/workspaces) |
| Storage | Parquet (via Polars) — one file per symbol/day |
| Data in | NinjaTrader 8 AddOn (TCP NDJSON, publish-only) · ccxt · tick-replay simulator · CSV import |
| Backtesting | backtesting.py · vectorbt (Phase 4) |

## Layout

```
nt-bridge/   NinjaScript AddOn (C#) — streams NT8 ticks + historical bars
server/      FastAPI backend — ingest, 1m candle engine, storage, REST + WS API
web/         React + TypeScript — charts, datafeed adapter, terminal UI
docs/        Architecture docs
data/        Local candle storage (gitignored)
```

## Quick start (dev, without NinjaTrader)

```powershell
# 1. Backend
cd server
python -m venv .venv
.venv\Scripts\pip install -e ".[dev]"
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000

# 2. Frontend
cd web
npm install
npm run dev          # http://localhost:5173

# 3. Register a user at /register, then open the terminal.
#    The replay provider publishes synthetic ES ticks so the chart is live
#    immediately; BTC streams from Binance via ccxt.
```

## Connecting NinjaTrader 8 (real CME data)

1. Copy `nt-bridge/TvBridgePublisher.cs` into `Documents\NinjaTrader 8\bin\Custom\AddOns\` and let NT8 compile it (F5 in the NinjaScript Editor).
2. Enable the AddOn from NT8's New → Tv Bridge Publisher window, subscribe your instruments.
3. Set `OPENTERM_NINJA_TCP_HOST=127.0.0.1` (default) and start the server — ticks flow.

No external DLLs are required inside NT8 — the AddOn speaks plain newline-delimited JSON over a localhost TCP socket.

## API overview

- `POST /api/auth/register` · `POST /api/auth/login` (JWT)
- `GET  /api/history?symbol=ES&tf=5m&from=…&to=…` — OHLCV bars (server-resampled from the 1m base)
- `WS   /api/stream?token=…` — subscribe `{action:"subscribe",symbol:"ES",tf:"5m"}`; server pushes forming/closed bars
- `GET  /api/quote?symbols=ES,BTC` — last prices
- `GET  /api/health` — provider status

## Legal notes

- Keep the TradingView attribution logo enabled in the chart (Apache-2.0 requirement).
- CME data bridged from your NinjaTrader subscription is for **internal/LAN use only** — do not expose this platform publicly with that feed.
- Lightweight Charts is © TradingView, Inc. This project is not affiliated with TradingView.

## License

MIT (see LICENSE). Third-party components keep their own licenses.