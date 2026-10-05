"""Symbol mapping and the fixed lists behind the market overview and heatmap."""

from __future__ import annotations

from app.candles.sessions import CME_ROOTS, CRYPTO_EXCHANGES, CRYPTO_QUOTES, INDIA_EXCHANGES, _CONTRACT


def to_yahoo(symbol: str) -> str:
    """Map a terminal symbol to Yahoo naming (AAPL, ES=F, BTC-USD, RELIANCE.NS)."""
    s = symbol.strip().upper()
    feed, _, rest = s.rpartition(":")
    if feed in INDIA_EXCHANGES:
        return f"{rest}.{'NS' if feed == 'NSE' else 'BO'}"
    if "-" in s and s.split("-")[0] in CRYPTO_EXCHANGES:
        pair = s.split("-", 1)[1]
        for q in CRYPTO_QUOTES + ("USD",):
            if pair.endswith(q):
                return f"{pair[: -len(q)]}-USD"
        return pair
    s = rest.split(" ")[0]  # NT8 "ES 12-25"
    if s.endswith("=F") or s.endswith("=X") or s.startswith("^") or "." in s or "-" in s:
        return s
    root = s
    m = _CONTRACT.match(root)
    if root in CME_ROOTS:
        return f"{root}=F"
    if m and m.group(1) in CME_ROOTS:
        return f"{m.group(1)}=F"
    return root


# --------------------------------------------------------------- overview --
OVERVIEW: dict[str, list[tuple[str, str]]] = {
    "Indices": [
        ("^GSPC", "S&P 500"), ("^NDX", "Nasdaq 100"), ("^DJI", "Dow 30"), ("^RUT", "Russell 2000"),
        ("^VIX", "VIX"), ("^STOXX50E", "Euro Stoxx 50"), ("^GDAXI", "DAX"), ("^FTSE", "FTSE 100"),
        ("^N225", "Nikkei 225"), ("^HSI", "Hang Seng"),
    ],
    "Futures": [
        ("ES=F", "E-mini S&P"), ("NQ=F", "E-mini Nasdaq"), ("YM=F", "E-mini Dow"), ("RTY=F", "E-mini Russell"),
        ("CL=F", "Crude oil"), ("NG=F", "Natural gas"), ("GC=F", "Gold"), ("SI=F", "Silver"), ("HG=F", "Copper"),
        ("ZN=F", "10Y T-Note"),
    ],
    "Forex": [
        ("EURUSD=X", "EUR/USD"), ("GBPUSD=X", "GBP/USD"), ("USDJPY=X", "USD/JPY"), ("USDCHF=X", "USD/CHF"),
        ("AUDUSD=X", "AUD/USD"), ("USDCAD=X", "USD/CAD"), ("DX-Y.NYB", "Dollar index"),
    ],
    "Crypto": [("BTC-USD", "Bitcoin"), ("ETH-USD", "Ethereum"), ("SOL-USD", "Solana"), ("XRP-USD", "XRP")],
    "Rates": [("^IRX", "US 13W"), ("^FVX", "US 5Y"), ("^TNX", "US 10Y"), ("^TYX", "US 30Y")],
}

# ---------------------------------------------------------------- heatmap --
# Large US stocks by sector; market caps ($bn, approximate) size the tiles
# when live caps are unavailable.
HEATMAP: list[tuple[str, str, str, float]] = [
    ("AAPL", "Apple", "Technology", 3400), ("MSFT", "Microsoft", "Technology", 3300), ("NVDA", "NVIDIA", "Technology", 3500),
    ("AVGO", "Broadcom", "Technology", 1100), ("ORCL", "Oracle", "Technology", 450), ("CRM", "Salesforce", "Technology", 280),
    ("AMD", "AMD", "Technology", 260), ("ADBE", "Adobe", "Technology", 200), ("CSCO", "Cisco", "Technology", 240),
    ("INTC", "Intel", "Technology", 100), ("QCOM", "Qualcomm", "Technology", 180), ("TXN", "Texas Instruments", "Technology", 170),
    ("GOOGL", "Alphabet", "Communication", 2300), ("META", "Meta", "Communication", 1500), ("NFLX", "Netflix", "Communication", 400),
    ("DIS", "Disney", "Communication", 200), ("TMUS", "T-Mobile", "Communication", 270), ("VZ", "Verizon", "Communication", 170),
    ("AMZN", "Amazon", "Consumer Cyclical", 2200), ("TSLA", "Tesla", "Consumer Cyclical", 1000), ("HD", "Home Depot", "Consumer Cyclical", 380),
    ("MCD", "McDonald's", "Consumer Cyclical", 210), ("NKE", "Nike", "Consumer Cyclical", 110), ("SBUX", "Starbucks", "Consumer Cyclical", 105),
    ("WMT", "Walmart", "Consumer Defensive", 750), ("COST", "Costco", "Consumer Defensive", 400), ("PG", "Procter & Gamble", "Consumer Defensive", 380),
    ("KO", "Coca-Cola", "Consumer Defensive", 300), ("PEP", "PepsiCo", "Consumer Defensive", 200),
    ("JPM", "JPMorgan", "Financials", 700), ("V", "Visa", "Financials", 650), ("MA", "Mastercard", "Financials", 520),
    ("BAC", "Bank of America", "Financials", 330), ("WFC", "Wells Fargo", "Financials", 250), ("GS", "Goldman Sachs", "Financials", 190),
    ("BRK-B", "Berkshire", "Financials", 1000),
    ("LLY", "Eli Lilly", "Healthcare", 750), ("UNH", "UnitedHealth", "Healthcare", 300), ("JNJ", "Johnson & Johnson", "Healthcare", 380),
    ("ABBV", "AbbVie", "Healthcare", 340), ("MRK", "Merck", "Healthcare", 250), ("PFE", "Pfizer", "Healthcare", 150), ("TMO", "Thermo Fisher", "Healthcare", 200),
    ("XOM", "Exxon Mobil", "Energy", 480), ("CVX", "Chevron", "Energy", 270), ("COP", "ConocoPhillips", "Energy", 120),
    ("CAT", "Caterpillar", "Industrials", 180), ("GE", "GE Aerospace", "Industrials", 250), ("HON", "Honeywell", "Industrials", 140),
    ("UPS", "UPS", "Industrials", 100), ("BA", "Boeing", "Industrials", 140), ("RTX", "RTX", "Industrials", 180),
    ("LIN", "Linde", "Materials", 210), ("NEE", "NextEra", "Utilities", 150), ("PLD", "Prologis", "Real Estate", 100),
]

# a broad tape for "market news" when no symbol is given
MARKET_NEWS_TICKERS = ["^GSPC", "^NDX", "ES=F", "CL=F", "GC=F", "BTC-USD"]
