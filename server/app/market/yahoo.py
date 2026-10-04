"""Yahoo Finance (via yfinance) as a market-data source.

Every function here is blocking and may raise on network errors; the service
runs them in threads and falls back to demo data. The `parse_*` helpers are
pure so they can be tested against captured shapes without the network.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Optional


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _ts(v: Any) -> Optional[int]:
    """Seconds since epoch from an epoch number, ISO string, pandas Timestamp or datetime."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v / 1000) if v > 1e11 else int(v)
    if isinstance(v, str):
        try:
            return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp())
        except ValueError:
            return None
    if hasattr(v, "timestamp"):
        try:
            if getattr(v, "tzinfo", None) is None and isinstance(v, datetime):
                v = v.replace(tzinfo=timezone.utc)
            return int(v.timestamp())
        except (ValueError, OverflowError):
            return None
    return None


# ------------------------------------------------------------------ news ---
def parse_news(items: list[dict] | None, ticker: str) -> list[dict]:
    """Normalise yfinance news (both the old flat and the new `content` shapes)."""
    out = []
    for it in items or []:
        c = it.get("content") if isinstance(it.get("content"), dict) else None
        if c is not None:
            url = (c.get("canonicalUrl") or {}).get("url") or (c.get("clickThroughUrl") or {}).get("url")
            thumbs = ((c.get("thumbnail") or {}).get("resolutions") or [])
            out.append({
                "id": it.get("id") or c.get("id") or url,
                "title": c.get("title") or "",
                "summary": c.get("summary") or c.get("description") or "",
                "publisher": (c.get("provider") or {}).get("displayName") or "",
                "url": url,
                "time": _ts(c.get("pubDate") or c.get("displayTime")),
                "thumbnail": min(thumbs, key=lambda r: r.get("width") or 9999).get("url") if thumbs else None,
                "tickers": [ticker],
            })
        else:
            thumbs = ((it.get("thumbnail") or {}).get("resolutions") or [])
            out.append({
                "id": it.get("uuid") or it.get("link"),
                "title": it.get("title") or "",
                "summary": "",
                "publisher": it.get("publisher") or "",
                "url": it.get("link"),
                "time": _ts(it.get("providerPublishTime")),
                "thumbnail": min(thumbs, key=lambda r: r.get("width") or 9999).get("url") if thumbs else None,
                "tickers": it.get("relatedTickers") or [ticker],
            })
    return [n for n in out if n["title"] and n["url"]]


def news(ticker: str) -> list[dict]:
    import yfinance as yf

    return parse_news(yf.Ticker(ticker).news, ticker)


# ---------------------------------------------------------- fundamentals ---
FUNDAMENTAL_KEYS = {
    "name": "longName", "short_name": "shortName", "sector": "sector", "industry": "industry", "country": "country",
    "website": "website", "summary": "longBusinessSummary", "currency": "currency", "exchange": "fullExchangeName",
    "quote_type": "quoteType", "employees": "fullTimeEmployees",
}
FUNDAMENTAL_NUMS = {
    "market_cap": "marketCap", "enterprise_value": "enterpriseValue", "pe": "trailingPE", "forward_pe": "forwardPE",
    "peg": "trailingPegRatio", "eps": "trailingEps", "forward_eps": "forwardEps", "price_to_book": "priceToBook",
    "price_to_sales": "priceToSalesTrailing12Months", "dividend_yield": "dividendYield", "payout_ratio": "payoutRatio",
    "beta": "beta", "high_52w": "fiftyTwoWeekHigh", "low_52w": "fiftyTwoWeekLow", "avg_volume": "averageVolume",
    "shares_outstanding": "sharesOutstanding", "float_shares": "floatShares", "short_ratio": "shortRatio",
    "revenue": "totalRevenue", "revenue_growth": "revenueGrowth", "gross_margin": "grossMargins",
    "operating_margin": "operatingMargins", "profit_margin": "profitMargins", "ebitda": "ebitda",
    "earnings_growth": "earningsGrowth", "roe": "returnOnEquity", "roa": "returnOnAssets", "debt_to_equity": "debtToEquity",
    "current_ratio": "currentRatio", "free_cash_flow": "freeCashflow", "total_cash": "totalCash", "total_debt": "totalDebt",
    "target_mean": "targetMeanPrice", "target_high": "targetHighPrice", "target_low": "targetLowPrice",
    "analysts": "numberOfAnalystOpinions", "price": "currentPrice", "prev_close": "previousClose",
}


def parse_info(info: dict | None) -> dict:
    info = info or {}
    out: dict[str, Any] = {k: info.get(src) for k, src in FUNDAMENTAL_KEYS.items()}
    out.update({k: _num(info.get(src)) for k, src in FUNDAMENTAL_NUMS.items()})
    out["recommendation"] = info.get("recommendationKey")
    if out["price"] is None:
        out["price"] = _num(info.get("regularMarketPrice"))
    # yfinance changed dividendYield from a fraction to a percent: prefer the
    # unambiguous rate / price, else treat implausibly large values as percent
    rate = _num(info.get("dividendRate"))
    dy = out.get("dividend_yield")
    if rate and out["price"]:
        out["dividend_yield"] = rate / out["price"]
    elif dy is not None and dy > 0.2:
        out["dividend_yield"] = dy / 100
    return out


def parse_earnings_history(df) -> list[dict]:
    """yfinance Ticker.earnings_history → [{time, eps_estimate, eps_actual, surprise_pct}] oldest first."""
    if df is None or getattr(df, "empty", True):
        return []
    rows = []
    for idx, r in df.iterrows():
        rows.append({
            "time": _ts(idx),
            "eps_estimate": _num(r.get("epsEstimate")),
            "eps_actual": _num(r.get("epsActual")),
            "surprise_pct": (lambda s: s * 100 if s is not None and abs(s) < 5 else s)(_num(r.get("surprisePercent"))),
        })
    return sorted([r for r in rows if r["time"]], key=lambda r: r["time"])


def parse_calendar(cal) -> dict:
    """yfinance Ticker.calendar (dict) → next earnings / dividend dates."""
    cal = cal or {}
    if not isinstance(cal, dict):
        return {}
    dates = cal.get("Earnings Date") or []
    if not isinstance(dates, (list, tuple)):
        dates = [dates]
    return {
        "next_earnings": _date_ts(dates[0]) if dates else None,
        "eps_estimate": _num(cal.get("Earnings Average")),
        "revenue_estimate": _num(cal.get("Revenue Average")),
        "ex_dividend": _date_ts(cal.get("Ex-Dividend Date")),
        "dividend_date": _date_ts(cal.get("Dividend Date")),
    }


def _date_ts(d) -> Optional[int]:
    if d is None:
        return None
    if hasattr(d, "timestamp"):
        return _ts(d)
    try:
        return int(datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    except TypeError:
        return None


def fundamentals(ticker: str) -> dict:
    import yfinance as yf

    t = yf.Ticker(ticker)
    out = parse_info(t.info)
    out["symbol"] = ticker
    try:
        out.update(parse_calendar(t.calendar))
    except Exception:  # noqa: BLE001 — optional extras
        pass
    try:
        out["earnings"] = parse_earnings_history(t.earnings_history)
    except Exception:  # noqa: BLE001
        out["earnings"] = []
    return out


# ---------------------------------------------------------------- events ---
def parse_events(dividends, splits, earnings: list[dict], next_earnings: Optional[int]) -> list[dict]:
    out = []
    for idx, v in (dividends.items() if dividends is not None else []):
        out.append({"time": _ts(idx), "kind": "dividend", "value": _num(v), "label": f"Dividend {float(v):.4g}"})
    for idx, v in (splits.items() if splits is not None else []):
        out.append({"time": _ts(idx), "kind": "split", "value": _num(v), "label": f"Split {float(v):g}:1"})
    for e in earnings:
        label = "Earnings"
        if e.get("eps_actual") is not None:
            label += f" · EPS {e['eps_actual']:.2f}"
            if e.get("eps_estimate") is not None:
                label += f" vs {e['eps_estimate']:.2f}"
        out.append({"time": e["time"], "kind": "earnings", "value": e.get("eps_actual"), "label": label})
    if next_earnings:
        out.append({"time": next_earnings, "kind": "earnings", "value": None, "label": "Next earnings", "upcoming": True})
    return sorted([e for e in out if e["time"]], key=lambda e: e["time"])


def events(ticker: str) -> list[dict]:
    import yfinance as yf

    t = yf.Ticker(ticker)
    try:
        earnings = parse_earnings_history(t.earnings_history)
    except Exception:  # noqa: BLE001
        earnings = []
    try:
        nxt = parse_calendar(t.calendar).get("next_earnings")
    except Exception:  # noqa: BLE001
        nxt = None
    return parse_events(t.dividends, t.splits, earnings, nxt)


# ---------------------------------------------------------------- quotes ---
def parse_quotes(df, tickers: list[str]) -> dict[str, dict]:
    """Daily yf.download frame → {ticker: {last, prev_close, change, change_pct, volume, spark}}."""
    out: dict[str, dict] = {}
    if df is None or getattr(df, "empty", True):
        return out
    multi = getattr(df.columns, "nlevels", 1) > 1
    for t in tickers:
        if multi:
            if t not in df.columns.get_level_values(0):
                continue
            sub = df[t]
        else:
            sub = df
        sub = sub.dropna(subset=["Close"])
        if len(sub) == 0:
            continue
        closes = [float(c) for c in sub["Close"].tolist()]
        last = closes[-1]
        prev = closes[-2] if len(closes) > 1 else None
        out[t] = {
            "last": last,
            "prev_close": prev,
            "change": last - prev if prev else None,
            "change_pct": (last / prev - 1) * 100 if prev else None,
            "volume": _num(sub["Volume"].iloc[-1]) if "Volume" in sub else None,
            "spark": closes[-20:],
        }
    return out


def quotes(tickers: list[str]) -> dict[str, dict]:
    import yfinance as yf

    df = yf.download(tickers, period="1mo", interval="1d", group_by="ticker", auto_adjust=False, progress=False, threads=True)
    return parse_quotes(df, tickers)


def market_caps(tickers: list[str]) -> dict[str, float]:
    import yfinance as yf

    def one(t: str) -> tuple[str, Optional[float]]:
        try:
            return t, _num(yf.Ticker(t).fast_info["marketCap"])
        except Exception:  # noqa: BLE001
            return t, None

    with ThreadPoolExecutor(max_workers=8) as pool:
        return {t: c for t, c in pool.map(one, tickers) if c}


def next_earnings(tickers: list[str]) -> list[dict]:
    import yfinance as yf

    def one(t: str) -> Optional[dict]:
        try:
            cal = parse_calendar(yf.Ticker(t).calendar)
        except Exception:  # noqa: BLE001
            return None
        if not cal.get("next_earnings"):
            return None
        return {"symbol": t, "time": cal["next_earnings"], "eps_estimate": cal.get("eps_estimate"),
                "revenue_estimate": cal.get("revenue_estimate")}

    with ThreadPoolExecutor(max_workers=8) as pool:
        return [r for r in pool.map(one, tickers) if r]
