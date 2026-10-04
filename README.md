# OpenTerminal

A self-hosted, open-source TradingView-style trading terminal. CME futures from your NinjaTrader 8, stocks/ETFs/futures/FX via yfinance, crypto via ccxt, and your own data — charted in the browser with TradingView's open-source Lightweight Charts engine.

![status](https://img.shields.io/badge/status-v0.2-blue) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

| | |
|---|---|
| **Charts** | Candles, hollow, Heikin Ashi, bars, columns, line, area, baseline · price-based Renko, Range, Line break, Kagi, Point & Figure · any interval (1m–1440m, 1–24h, 1D/1W/1M, e.g. 7m, 90m, 3h) with favourites · 1/2/3/4-chart layouts with symbol + crosshair sync · infinite history scroll · light/dark |
| **Chart settings** | Regular / log / percent / indexed scales, invert, colours, grid, volume, time zone, countdown to bar close, previous-close line, session breaks · compare symbols (% overlay) and spreads (`ES - NQ`, `2 * GC / SI`) · snapshots (PNG download + clipboard) |
| **Drawings** | 86 TradingView tools — trend lines, channels, pitchforks, Fibonacci, Gann, harmonic & Elliott patterns, long/short position, measures, volume profiles, anchored VWAP, shapes, text — saved per symbol · right-click menus, style editor (colour, width, dash, fill, text, extend, labels) with style templates, object tree, undo/redo, favourite-tools bar |
| **Indicators** | 876 built-in (95 standard, 736 community, 45 candlestick patterns) with own panes, live legend values, settings, data window and saved indicator templates |
| **OpenScript** | Write your own indicators and strategies in JavaScript (Pine-style `ta.*`, `plot`, `input`, `strategy.*`), sandboxed in a Web Worker, CodeMirror editor with templates |
| **Strategy tester** | Next-bar-open fills, stop-loss / take-profit, commission, futures point values; net profit, win rate, profit factor, drawdown, Sharpe, equity curve, trade list |
| **Bar replay** | Pick a bar, then play / step forward at 1–10× with indicators recalculated as bars arrive |
| **Screener** | RSI, SMA trend, ATR %, change % across every stored symbol, filterable and sortable |
| **Alerts** | Crossing / crossing up / down / greater / less, evaluated server-side on every tick → toast + browser notification + log |
| **Trading** | Paper trading (market/limit/stop, positions, P&L with futures point values) with positions and orders drawn on the chart · optional order routing to NinjaTrader 8 |
| **Market panels** | Watchlists, order book + time & sales, symbol details |
| **App** | Multi-user (JWT), layouts/watchlists/drawings/scripts stored per user, installable PWA, single Docker image |

## Stack

| Layer | Component |
|---|---|
| Chart | [Lightweight Charts v5](https://github.com/tradingview/lightweight-charts) (Apache-2.0) · [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing) (MIT) · [lightweight-charts-indicators](https://github.com/deepentropy/lightweight-charts-indicators) (MIT) |
| Web | React 18 · TypeScript · Zustand · Vite · CodeMirror 6 |
| Backend | Python 3.12+ · FastAPI · WebSockets · SQLite (users/workspaces) |
| Storage | Parquet (Polars) — one file per symbol/day |
| Data in | NinjaTrader 8 AddOn (TCP NDJSON) · yfinance · ccxt · tick simulator |

## Layout

```
nt-bridge/   NinjaScript AddOn (C#) — streams NT8 ticks, depth, history; optional order route
server/      FastAPI backend — ingest, candle engine, storage, alerts, paper trading, REST + WS API
web/         React + TypeScript terminal
landing/     Project landing page (deployed to GitHub Pages)
docs/        Architecture docs
data/        Local candle storage (gitignored)
```

## Quick start

### Docker (one command)

```bash
cp server/.env.example server/.env      # set OPENTERM_JWT_SECRET to a long random string
docker compose up --build               # → http://localhost:8000
```

### Dev (two terminals)

```bash
# backend — Python 3.12+
cd server
python -m venv .venv && .venv/bin/pip install -e ".[dev]"     # Windows: .venv\Scripts\pip
.venv/bin/python scripts/seed_demo.py                         # optional: 30 days of demo history
.venv/bin/uvicorn app.main:app --reload --port 8000

# frontend — Node 18+
cd web
npm install
npm run dev                                                   # → http://localhost:5173
```

Register on the sign-in screen (**No account? Register**) — the first account becomes the admin. The tick simulator (`SIM:ES`) streams immediately; yfinance and Binance stream when the machine can reach them.

Tests: `cd server && pytest` · `cd web && npm test`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Symbol search (type `A - B` for a spread) |
| digits, e.g. `45`, `4h`, `d` + Enter | Change interval |
| Alt+T / H / J / V / C / F / B / P / N | Trend line / horizontal line / horizontal ray / vertical line / cross line / Fib retracement / rectangle / long position / text |
| Ctrl+Z / Ctrl+Y | Undo / redo drawings |
| Alt+R · Alt+S | Reset chart view · snapshot |
| Alt+A · Alt+I | New alert · indicators |
| Esc · Del | Cancel tool · delete selected drawing |
| Right-click | Chart or drawing context menu |

## Data sources

| Provider | Symbols | Setup |
|---|---|---|
| Simulator | `SIM:ES` | on by default (`OPENTERM_REPLAY_*`) |
| yfinance | `AAPL`, `SPY`, `^GSPC`, `ES=F`, `EURUSD=X`, `BTC-USD`… | on by default; `OPENTERM_YF_TICKERS` (JSON list). Polled 1m bars, Yahoo's delays apply |
| ccxt | `BINANCE-BTCUSDT`… | on by default; `OPENTERM_CCXT_EXCHANGE`, `OPENTERM_CCXT_SYMBOLS` |
| NinjaTrader 8 | `ES`, `NQ`… (your CME subscription) | see below |

## Connecting NinjaTrader 8 (real CME data)

1. Copy `nt-bridge/TvBridgePublisher.cs` into `Documents\NinjaTrader 8\bin\Custom\AddOns\` and compile (F5 in the NinjaScript Editor).
2. Control Center → **New → OpenTerminal Bridge**, enter instruments (`ES 12-25, NQ 12-25`), **Start**.
3. Run the OpenTerminal server on the same Windows machine (`OPENTERM_NINJA_ENABLED=true`, the default) — ticks, depth and 5 days of 1m history flow in.

**Order routing (optional).** Off by default behind three switches: `OPENTERM_NINJA_ORDERS_ENABLED=true` on the server, the admin account in OpenTerminal, and *Allow order routing* + an account allow-list (default `Sim101`) in the AddOn window. Then the order ticket shows a *Route: NinjaTrader* option.

## API overview

- `POST /api/auth/register` · `POST /api/auth/login` (JWT) · `GET /api/auth/me`
- `GET /api/history?symbol=ES&tf=5m&limit=1500[&to=…]` — OHLCV (server-resampled from 1m)
- `WS /api/stream?token=…` — `subscribe` bars · `subscribe_quotes` · `subscribe_trades` · `subscribe_book`; per-user `alert` / `paper` / `broker` events
- `GET /api/symbols` · `/api/quote` · `/api/stats` · `/api/screener` · `/api/health`
- `/api/watchlists` · `/api/layouts` · `/api/drawings/{symbol}` · `/api/scripts`
- `/api/alerts` (+ `/log`) · `/api/paper/{account,orders,positions/{s}/close,reset}`
- `/api/broker/ninja/{status,orders}`

## Legal notes

- Keep the TradingView attribution logo enabled in the chart (Lightweight Charts, Apache-2.0).
- CME data bridged from your NinjaTrader subscription is for **internal/LAN use only** — do not expose this platform publicly with that feed.
- yfinance uses Yahoo's public endpoints; check Yahoo's terms for your use.
- Lightweight Charts is © TradingView, Inc. This project is not affiliated with TradingView.

## License

MIT (see [LICENSE](LICENSE)). Third-party components keep their own licenses.
