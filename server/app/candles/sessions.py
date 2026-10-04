"""CME session logic and market classification.

CME futures trade Sun 18:00 ET (17:00 CT) through Fri 17:00 ET with a daily
break 17:00-18:00 ET. TradingView-style daily bars anchor at the session open,
so a tick at 23:30 ET Monday belongs to *Tuesday's* trading day.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
NEW_YORK = ZoneInfo("America/New_York")

# well-known CME/CBOT/NYMEX/COMEX roots
CME_ROOTS = {
    "ES", "MES", "NQ", "MNQ", "RTY", "M2K", "YM", "MYM", "CL", "MCL", "NG",
    "GC", "MGC", "SI", "SIL", "ZB", "ZN", "ZF", "ZT", "ZC", "ZS", "ZW",
    "HE", "LE", "6E", "6J", "6B", "DX", "VX", "BTC1", "MBT", "PL", "PA",
}

CRYPTO_MARKERS = ("USDT", "USDC", "BINANCE", "XBT", "BTC", "ETH")


def market_class(symbol: str) -> str:
    """'cme' | 'crypto' | 'stock'."""
    root = symbol.split("-")[0].split(".")[0].upper()
    if root in CME_ROOTS:
        return "cme"
    upper = symbol.upper()
    if any(m in upper for m in CRYPTO_MARKERS):
        return "crypto"
    return "stock"


def session_day_start_s(ts_s: int, symbol: str) -> int:
    """Start (unix seconds) of the trading day that `ts_s` belongs to."""
    market = market_class(symbol)
    if market == "cme":
        # CME trading day opens 17:00 America/Chicago
        local = datetime.fromtimestamp(ts_s, tz=CHICAGO) - timedelta(hours=7)
        day = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return int(day.timestamp())
    if market == "crypto":
        # UTC calendar day
        return (ts_s // 86400) * 86400
    # stocks/forex: New York calendar day
    local = datetime.fromtimestamp(ts_s, tz=NEW_YORK)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp())