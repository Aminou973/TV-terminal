"""CME session logic and market classification.

CME futures trade Sun 18:00 ET (17:00 CT) through Fri 17:00 ET with a daily
break 17:00-18:00 ET. TradingView-style daily bars anchor at the session open,
so a tick at 23:30 ET Monday belongs to *Tuesday's* trading day.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
NEW_YORK = ZoneInfo("America/New_York")
KOLKATA = ZoneInfo("Asia/Kolkata")

# well-known CME/CBOT/NYMEX/COMEX roots
CME_ROOTS = {
    "ES", "MES", "NQ", "MNQ", "RTY", "M2K", "YM", "MYM", "CL", "MCL", "NG",
    "GC", "MGC", "SI", "SIL", "ZB", "ZN", "ZF", "ZT", "ZC", "ZS", "ZW",
    "HE", "LE", "6E", "6J", "6B", "DX", "VX", "BTC1", "MBT", "PL", "PA",
}

CRYPTO_EXCHANGES = ("BINANCE", "COINBASE", "KRAKEN", "BYBIT", "OKX", "BITSTAMP")
CRYPTO_QUOTES = ("USDT", "USDC", "BUSD")
CRYPTO_ROOTS = {"BTC", "ETH", "XBT", "SOL"}
INDIA_EXCHANGES = ("NSE", "BSE")

# futures contract suffix: month code + 1-2 digit year (ESZ5, NQH26)
_CONTRACT = re.compile(r"^([A-Z0-9]{1,4}?)[FGHJKMNQUVXZ]\d{1,2}$")


def _root(symbol: str) -> str:
    """Instrument root: drops a 'FEED:' prefix and an NT8 ' 12-25' expiry."""
    s = symbol.upper().split(":")[-1]
    s = s.split(" ")[0].split(".")[0]
    return s[:-2] if s.endswith("=F") else s  # Yahoo continuous futures: ES=F


def market_class(symbol: str) -> str:
    """'cme' | 'crypto' | 'india' | 'stock'."""
    upper = symbol.upper()
    prefix = upper.split(":")[0].split("-")[0] if (":" in upper or "-" in upper) else ""
    if prefix in INDIA_EXCHANGES:
        return "india"
    if prefix in CRYPTO_EXCHANGES:
        return "crypto"
    root = _root(symbol)
    if root in CME_ROOTS:
        return "cme"
    m = _CONTRACT.match(root)
    if m and m.group(1) in CME_ROOTS:
        return "cme"
    if root.split("-")[0] in CRYPTO_ROOTS or any(root.endswith(q) for q in CRYPTO_QUOTES):
        return "crypto"
    return "stock"


def session_day_start_s(ts_s: int, symbol: str) -> int:
    """Label (unix seconds) of the trading day that `ts_s` belongs to.

    TradingView labels a daily bar with its trading DATE, so for CME this is
    midnight Chicago of the trading date — which is later than the 17:00 CT
    open of that session. Use `session_open_s` when you need the real start.
    """
    market = market_class(symbol)
    if market == "cme":
        # CME trading day opens 17:00 CT the evening before: shift +7h so
        # 17:00 lands on the next calendar date.
        local = datetime.fromtimestamp(ts_s, tz=CHICAGO) + timedelta(hours=7)
        day = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return int(day.timestamp())
    if market == "india":
        local = datetime.fromtimestamp(ts_s, tz=KOLKATA)
        return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    if market == "crypto":
        # UTC calendar day
        return (ts_s // 86400) * 86400
    # stocks/forex: New York calendar day
    local = datetime.fromtimestamp(ts_s, tz=NEW_YORK)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp())


def session_open_s(ts_s: int, symbol: str) -> int:
    """Actual start (unix seconds) of the trading day containing `ts_s`."""
    label = session_day_start_s(ts_s, symbol)
    if market_class(symbol) == "cme":
        opened = datetime.fromtimestamp(label, tz=CHICAGO) - timedelta(days=1)
        return int(opened.replace(hour=17).timestamp())
    return label


def _tz(symbol: str):
    market = market_class(symbol)
    return {"cme": CHICAGO, "india": KOLKATA, "crypto": timezone.utc}.get(market, NEW_YORK)


def session_period_start_s(ts_s: int, symbol: str, period: str) -> int:
    """Label of the trading week ('W', starts Monday) or month ('M') containing `ts_s`.

    Built on the daily label, so a CME Sunday-evening session counts in the
    week of the Monday it trades for.
    """
    day_label = session_day_start_s(ts_s, symbol)
    tz = _tz(symbol)
    d = datetime.fromtimestamp(day_label, tz=tz)
    if period == "W":
        d = d - timedelta(days=d.weekday())
    else:
        d = d.replace(day=1)
    return int(d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
