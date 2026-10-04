"""Application settings (env prefix OPENTERM_)."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="OPENTERM_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # -- paths ------------------------------------------------------------
    data_dir: Path = Path("../data")
    sqlite_path: Path = Path("openterm.db")

    # -- auth ---------------------------------------------------------------
    jwt_secret: str = "dev-secret-change-me"  # override in .env for anything real
    token_expiry_hours: int = 24

    # -- ingest providers ----------------------------------------------------
    # tick-replay simulator (synthetic ES-like feed for dev without NT8)
    replay_enabled: bool = True
    replay_symbol: str = "SIM:ES"
    replay_seed: int = 7

    # NinjaTrader 8 TCP bridge (AddOn publishes NDJSON ticks on this port)
    ninja_enabled: bool = True
    ninja_tcp_host: str = "127.0.0.1"
    ninja_tcp_port: int = 5555

    # live crypto via ccxt (Binance public market data, no API key needed)
    ccxt_enabled: bool = True
    ccxt_exchange: str = "binance"
    ccxt_symbols: list[str] = ["BTC/USDT", "ETH/USDT"]

    # stocks / ETFs / indices / futures / FX via yfinance (polled 1m bars, no key)
    yf_enabled: bool = True
    yf_tickers: list[str] = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ", "ES=F", "NQ=F", "GC=F", "EURUSD=X"]
    yf_poll_s: float = 15.0

    # -- streaming -----------------------------------------------------------
    # throttle for forming-bar updates pushed per symbol (seconds)
    bar_throttle: float = 0.2
    bus_queue_size: int = 2000


settings = Settings()