"""Screener metrics computed from stored bars (resampled to the requested TF)."""

from __future__ import annotations

from app.models import Bar


def sma(values: list[float], n: int) -> float | None:
    return sum(values[-n:]) / n if len(values) >= n else None


def rsi(closes: list[float], n: int = 14) -> float | None:
    """Wilder RSI."""
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_g, avg_l = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_g = (avg_g * (n - 1) + max(d, 0.0)) / n
        avg_l = (avg_l * (n - 1) + max(-d, 0.0)) / n
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def atr(bars: list[Bar], n: int = 14) -> float | None:
    if len(bars) <= n:
        return None
    trs = [
        max(b.high - b.low, abs(b.high - p.close), abs(b.low - p.close)) for p, b in zip(bars, bars[1:])
    ]
    return sum(trs[-n:]) / n


def metrics(symbol: str, market: str, bars: list[Bar]) -> dict | None:
    if not bars:
        return None
    closes = [b.close for b in bars]
    last = bars[-1]
    prev_close = bars[-2].close if len(bars) > 1 else last.open
    a = atr(bars)
    s20, s50 = sma(closes, 20), sma(closes, 50)
    return {
        "symbol": symbol,
        "market": market,
        "last": last.close,
        "change": last.close - prev_close,
        "change_pct": (last.close / prev_close - 1) * 100 if prev_close else 0.0,
        "volume": last.volume,
        "high": last.high,
        "low": last.low,
        "rsi14": rsi(closes),
        "sma20": s20,
        "sma50": s50,
        "above_sma20": s20 is not None and last.close > s20,
        "above_sma50": s50 is not None and last.close > s50,
        "atr_pct": a / last.close * 100 if a and last.close else None,
        "bars": len(bars),
    }
