"""Deterministic demo market data — used when Yahoo / the calendar feed are
disabled or unreachable, so every panel still works offline (and in tests).

Values are seeded by symbol and UTC day: stable within a day, different the next.
"""

from __future__ import annotations

import hashlib
import random
import time
from datetime import datetime, timedelta, timezone

from app.market.universe import HEATMAP, OVERVIEW

DAY = 86400

_NAMES = {t: n for t, n, _, _ in HEATMAP} | {t: n for g in OVERVIEW.values() for t, n in g}
_SECTOR = {t: s for t, _, s, _ in HEATMAP}
_CAP = {t: c for t, _, _, c in HEATMAP}
_BASE = {
    "^GSPC": 5800, "^NDX": 20500, "^DJI": 42500, "^RUT": 2200, "^VIX": 16, "^STOXX50E": 4900, "^GDAXI": 19500,
    "^FTSE": 8300, "^N225": 38500, "^HSI": 21000, "ES=F": 5810, "NQ=F": 20550, "YM=F": 42600, "RTY=F": 2205,
    "CL=F": 72, "NG=F": 2.9, "GC=F": 2650, "SI=F": 31, "HG=F": 4.3, "ZN=F": 111, "EURUSD=X": 1.09, "GBPUSD=X": 1.30,
    "USDJPY=X": 148, "USDCHF=X": 0.86, "AUDUSD=X": 0.67, "USDCAD=X": 1.36, "DX-Y.NYB": 102, "BTC-USD": 64000,
    "ETH-USD": 2600, "SOL-USD": 150, "XRP-USD": 0.6, "^IRX": 4.6, "^FVX": 3.8, "^TNX": 4.0, "^TYX": 4.3,
}


def _rng(*parts: object) -> random.Random:
    h = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


def _day(now: float | None = None) -> int:
    return int((now or time.time()) // DAY)


def name_of(ticker: str) -> str:
    return _NAMES.get(ticker, ticker.replace("=F", "").replace("=X", "").lstrip("^"))


def quotes(tickers: list[str], now: float | None = None) -> dict[str, dict]:
    d = _day(now)
    out = {}
    for t in tickers:
        base = _BASE.get(t) or (_rng("base", t).uniform(20, 600))
        r = _rng("q", t, d)
        vol = 0.012 if t.startswith("^") or t.endswith("=F") or t.endswith("=X") else 0.022
        if t.endswith("-USD"):
            vol = 0.035
        spark = [base]
        for _ in range(19):
            spark.append(spark[-1] * (1 + r.gauss(0, vol)))
        last, prev = spark[-1], spark[-2]
        out[t] = {
            "last": round(last, 6 if last < 10 else 2),
            "prev_close": round(prev, 6 if prev < 10 else 2),
            "change": last - prev,
            "change_pct": (last / prev - 1) * 100,
            "volume": float(int(r.uniform(2e6, 9e7))),
            "spark": [round(x, 6 if x < 10 else 2) for x in spark],
        }
    return out


def market_caps(tickers: list[str]) -> dict[str, float]:
    return {t: _CAP[t] * 1e9 for t in tickers if t in _CAP}


_HEADLINES = [
    ("{name} shares climb as analysts lift price targets", "Several brokers raised their targets after channel checks pointed to stronger demand."),
    ("{name} slips after cautious guidance", "Management flagged a softer outlook for the coming quarter, citing costs."),
    ("What to watch from {name} this week", "Options imply a sizeable move around the next catalyst."),
    ("{name} announces share buyback expansion", "The board approved an additional repurchase authorisation."),
    ("Institutional investors add to {name} positions", "Latest filings show increased holdings among large funds."),
    ("{name} trades near key technical level", "Traders eye the 50-day moving average as support."),
    ("Is {name} still a buy after its recent run?", "Valuation looks stretched against peers, but momentum remains strong."),
    ("{name} unveils new product line at investor event", "The company outlined its roadmap and margin targets."),
]
_MARKET_HEADLINES = [
    ("Stocks edge higher ahead of inflation data", "Investors await CPI for clues on the rate path."),
    ("Treasury yields steady as Fed speakers strike balanced tone", "Markets price roughly two cuts over the next year."),
    ("Oil swings as traders weigh supply outlook", "OPEC+ commentary and inventory data kept crude volatile."),
    ("Dollar firms against majors after strong jobs report", "Payrolls beat expectations, lifting short-dated yields."),
    ("Gold hovers near record as central-bank buying continues", "Safe-haven demand stays firm amid geopolitical tension."),
    ("Bitcoin rebounds as ETF inflows pick up", "Crypto markets recovered after a volatile week."),
    ("Tech leads as chipmakers rally on AI demand", "Semiconductor names outperformed the broader market."),
    ("Earnings season: what Wall Street expects", "Analysts forecast mid-single-digit profit growth for the index."),
]
_PUBLISHERS = ["Market Wire", "Daily Trader", "Finance Desk", "The Ledger", "Street Notes", "Macro Brief"]


def news(ticker: str | None, now: float | None = None) -> list[dict]:
    now = now or time.time()
    d = _day(now)
    r = _rng("news", ticker or "market", d)
    pool = _HEADLINES if ticker else _MARKET_HEADLINES
    picks = r.sample(pool, k=min(6, len(pool)))
    out = []
    for i, (title, summary) in enumerate(picks):
        name = name_of(ticker) if ticker else ""
        t = int(now) - int(r.uniform(0.2, 1.0) * (i + 1) * 3 * 3600)
        out.append({
            "id": f"demo-{ticker or 'mkt'}-{d}-{i}",
            "title": title.format(name=name),
            "summary": summary,
            "publisher": r.choice(_PUBLISHERS),
            "url": f"https://example.com/news/{(ticker or 'market').lower()}/{d}-{i}",
            "time": t,
            "thumbnail": None,
            "tickers": [ticker] if ticker else [],
        })
    return out


def fundamentals(ticker: str, now: float | None = None, price: float | None = None) -> dict:
    """`price` anchors the demo numbers to the terminal's own last price when known."""
    r = _rng("f", ticker)
    q = quotes([ticker], now)[ticker]
    if price:
        q = {**q, "last": price, "prev_close": price / (1 + q["change_pct"] / 100)}
    price = q["last"]
    stock = not (ticker.startswith("^") or "=" in ticker or ticker.endswith("-USD"))
    if not stock:
        return {"symbol": ticker, "name": name_of(ticker), "quote_type": "INDEX" if ticker.startswith("^") else "FUTURE",
                "price": price, "prev_close": q["prev_close"], "high_52w": price * 1.12, "low_52w": price * 0.82, "earnings": []}
    eps = price / r.uniform(14, 45)
    shares = (_CAP.get(ticker) or r.uniform(20, 400)) * 1e9 / price
    rev = shares * price / r.uniform(2, 12)
    nxt = earnings_dates(ticker, now)[0]
    hist = []
    for k in range(8, 0, -1):
        est = eps / 4 * (1 + r.gauss(0, 0.05))
        act = est * (1 + r.gauss(0.03, 0.06))
        hist.append({"time": nxt - k * 91 * DAY, "eps_estimate": round(est, 2), "eps_actual": round(act, 2),
                     "surprise_pct": round((act / est - 1) * 100, 2)})
    return {
        "symbol": ticker, "name": f"{name_of(ticker)} Inc." if ticker not in _NAMES else name_of(ticker),
        "short_name": name_of(ticker), "sector": _SECTOR.get(ticker, "Technology"), "industry": "—",
        "country": "United States", "website": None, "currency": "USD", "exchange": "NasdaqGS", "quote_type": "EQUITY",
        "summary": f"{name_of(ticker)} is shown with demo fundamentals because live data is unavailable.",
        "employees": int(r.uniform(5e3, 3e5)), "market_cap": shares * price, "enterprise_value": shares * price * 1.03,
        "pe": price / eps, "forward_pe": price / (eps * 1.1), "peg": r.uniform(0.8, 3), "eps": eps, "forward_eps": eps * 1.1,
        "price_to_book": r.uniform(2, 40), "price_to_sales": shares * price / rev, "dividend_yield": r.choice([None, r.uniform(0.002, 0.035)]),
        "payout_ratio": r.uniform(0, 0.6), "beta": r.uniform(0.6, 1.8), "high_52w": price * r.uniform(1.03, 1.35),
        "low_52w": price * r.uniform(0.55, 0.92), "avg_volume": q["volume"], "shares_outstanding": shares,
        "float_shares": shares * 0.98, "short_ratio": r.uniform(0.5, 5), "revenue": rev, "revenue_growth": r.gauss(0.08, 0.08),
        "gross_margin": r.uniform(0.3, 0.75), "operating_margin": r.uniform(0.1, 0.45), "profit_margin": r.uniform(0.05, 0.35),
        "ebitda": rev * r.uniform(0.15, 0.45), "earnings_growth": r.gauss(0.1, 0.15), "roe": r.uniform(0.08, 0.6),
        "roa": r.uniform(0.03, 0.2), "debt_to_equity": r.uniform(10, 200), "current_ratio": r.uniform(0.8, 3),
        "free_cash_flow": rev * r.uniform(0.05, 0.3), "total_cash": rev * r.uniform(0.1, 0.6), "total_debt": rev * r.uniform(0.1, 0.8),
        "target_mean": price * r.uniform(0.95, 1.25), "target_high": price * 1.45, "target_low": price * 0.8,
        "analysts": int(r.uniform(8, 55)), "recommendation": r.choice(["buy", "strong_buy", "hold"]),
        "price": price, "prev_close": q["prev_close"], "next_earnings": nxt, "eps_estimate": round(eps / 4, 2),
        "revenue_estimate": rev / 4, "ex_dividend": None, "dividend_date": None, "earnings": hist,
    }


def earnings_dates(ticker: str, now: float | None = None) -> list[int]:
    """Next earnings first, then the previous ones (quarterly)."""
    now = now or time.time()
    r = _rng("e", ticker)
    phase = int(r.uniform(0, 91)) * DAY
    q = 91 * DAY
    k = int((now - phase) // q) + 1
    nxt = phase + k * q + 13 * 3600
    return [nxt] + [nxt - i * q for i in range(1, 9)]


def events(ticker: str, now: float | None = None, price: float | None = None) -> list[dict]:
    f = fundamentals(ticker, now, price)
    out = [{"time": e["time"], "kind": "earnings", "value": e["eps_actual"],
            "label": f"Earnings · EPS {e['eps_actual']:.2f} vs {e['eps_estimate']:.2f}"} for e in f.get("earnings", [])]
    if f.get("next_earnings"):
        out.append({"time": f["next_earnings"], "kind": "earnings", "value": None, "label": "Next earnings", "upcoming": True})
    if f.get("dividend_yield"):
        per = f["price"] * f["dividend_yield"] / 4
        for e in f.get("earnings", []):
            out.append({"time": e["time"] + 20 * DAY, "kind": "dividend", "value": round(per, 2), "label": f"Dividend {per:.2f}"})
    return sorted(out, key=lambda e: e["time"])


def next_earnings(tickers: list[str], now: float | None = None) -> list[dict]:
    out = []
    for t in tickers:
        f = fundamentals(t, now)
        if f.get("next_earnings"):
            out.append({"symbol": t, "time": f["next_earnings"], "eps_estimate": f.get("eps_estimate"),
                        "revenue_estimate": f.get("revenue_estimate")})
    return out


_ECON = [
    ("USD", "CPI m/m", "high", "0.3%"), ("USD", "Core CPI m/m", "high", "0.3%"), ("USD", "Non-Farm Employment Change", "high", "150K"),
    ("USD", "Unemployment Rate", "high", "4.1%"), ("USD", "FOMC Statement", "high", None), ("USD", "Federal Funds Rate", "high", "4.50%"),
    ("USD", "Retail Sales m/m", "medium", "0.4%"), ("USD", "ISM Manufacturing PMI", "medium", "48.5"), ("USD", "Unemployment Claims", "medium", "225K"),
    ("USD", "Crude Oil Inventories", "low", "-1.2M"), ("EUR", "ECB Main Refinancing Rate", "high", "3.40%"), ("EUR", "German Flash Manufacturing PMI", "medium", "42.9"),
    ("GBP", "CPI y/y", "high", "2.2%"), ("GBP", "BOE Gov Speaks", "medium", None), ("JPY", "BOJ Policy Rate", "high", "0.25%"),
    ("CAD", "Employment Change", "high", "25.0K"), ("AUD", "Cash Rate", "high", "4.35%"), ("CNY", "Manufacturing PMI", "medium", "49.6"),
    ("USD", "Prelim UoM Consumer Sentiment", "low", "68.9"), ("USD", "PPI m/m", "medium", "0.2%"),
]


def economic_calendar(now: float | None = None) -> list[dict]:
    now = now or time.time()
    today = datetime.fromtimestamp(now, timezone.utc).date()
    monday = today - timedelta(days=today.weekday())
    r = _rng("cal", monday.isoformat())
    out = []
    for i, (country, title, impact, forecast) in enumerate(r.sample(_ECON, k=16)):
        day = monday + timedelta(days=i % 5)
        hour = {"USD": 12, "CAD": 12, "EUR": 8, "GBP": 6, "JPY": 3, "AUD": 1, "CNY": 1}[country] + r.choice([0, 0, 1, 2])
        t = int(datetime(day.year, day.month, day.day, hour, 30 if r.random() < 0.5 else 0, tzinfo=timezone.utc).timestamp())
        prev = forecast
        actual = None
        if forecast and t < now:
            actual = forecast  # demo: print in line with forecast
        out.append({"time": t, "country": country, "title": title, "impact": impact,
                    "actual": actual, "forecast": forecast, "previous": prev})
    return sorted(out, key=lambda e: e["time"])
