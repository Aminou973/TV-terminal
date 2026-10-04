"""Indicator series for server-side alert conditions.

A series spec is a small dict: {"ind": "rsi", "length": 14, "output": "value"}.
Values are lists aligned with the bars (None where not yet defined).
Formulas follow TradingView's built-ins (Wilder RMA for RSI/ATR, SMA-seeded EMA).
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional

from app.models import Bar

Series = list[Optional[float]]


def _num(v: Optional[float]) -> bool:
    return v is not None and not math.isnan(v)


def sma(src: Series, n: int) -> Series:
    out: Series = [None] * len(src)
    window: list[float] = []
    total = 0.0
    for i, v in enumerate(src):
        if not _num(v):
            window.clear()
            total = 0.0
            continue
        window.append(v)
        total += v
        if len(window) > n:
            total -= window.pop(0)
        if len(window) == n:
            out[i] = total / n
    return out


def ema(src: Series, n: int) -> Series:
    out: Series = [None] * len(src)
    a = 2 / (n + 1)
    prev: Optional[float] = None
    seed: list[float] = []
    for i, v in enumerate(src):
        if not _num(v):
            continue
        if prev is None:
            seed.append(v)
            if len(seed) == n:
                prev = sum(seed) / n
                out[i] = prev
        else:
            prev = a * v + (1 - a) * prev
            out[i] = prev
    return out


def rma(src: Series, n: int) -> Series:
    out: Series = [None] * len(src)
    prev: Optional[float] = None
    seed: list[float] = []
    for i, v in enumerate(src):
        if not _num(v):
            continue
        if prev is None:
            seed.append(v)
            if len(seed) == n:
                prev = sum(seed) / n
                out[i] = prev
        else:
            prev = (prev * (n - 1) + v) / n
            out[i] = prev
    return out


def stdev(src: Series, n: int) -> Series:
    mean = sma(src, n)
    out: Series = [None] * len(src)
    for i, m in enumerate(mean):
        if m is None:
            continue
        window = src[i - n + 1 : i + 1]
        out[i] = math.sqrt(sum((x - m) ** 2 for x in window) / n)
    return out


def rsi(src: Series, n: int = 14) -> Series:
    up: Series = [None] + [max(src[i] - src[i - 1], 0.0) for i in range(1, len(src))]
    dn: Series = [None] + [max(src[i - 1] - src[i], 0.0) for i in range(1, len(src))]
    ru, rd = rma(up, n), rma(dn, n)
    out: Series = []
    for u, d in zip(ru, rd):
        if u is None or d is None:
            out.append(None)
        elif d == 0:
            out.append(100.0)
        else:
            out.append(100 - 100 / (1 + u / d))
    return out


def true_range(bars: list[Bar]) -> Series:
    out: Series = []
    for i, b in enumerate(bars):
        if i == 0:
            out.append(b.high - b.low)
        else:
            pc = bars[i - 1].close
            out.append(max(b.high - b.low, abs(b.high - pc), abs(b.low - pc)))
    return out


def _sub(a: Series, b: Series) -> Series:
    return [x - y if x is not None and y is not None else None for x, y in zip(a, b)]


def _spec_int(spec: dict, key: str, default: int, lo: int = 1, hi: int = 500) -> int:
    try:
        return max(lo, min(hi, int(spec.get(key, default))))
    except (TypeError, ValueError):
        return default


def _spec_float(spec: dict, key: str, default: float) -> float:
    try:
        return float(spec.get(key, default))
    except (TypeError, ValueError):
        return default


SOURCES = ("open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4")


def source(bars: list[Bar], name: str) -> Series:
    if name == "hl2":
        return [(b.high + b.low) / 2 for b in bars]
    if name == "hlc3":
        return [(b.high + b.low + b.close) / 3 for b in bars]
    if name == "ohlc4":
        return [(b.open + b.high + b.low + b.close) / 4 for b in bars]
    return [getattr(b, name if name in SOURCES else "close") for b in bars]


def _macd(bars, s):
    src = source(bars, s.get("source", "close"))
    line = _sub(ema(src, _spec_int(s, "fast", 12)), ema(src, _spec_int(s, "slow", 26)))
    signal = ema(line, _spec_int(s, "signal", 9))
    return {"macd": line, "signal": signal, "hist": _sub(line, signal)}


def _bb(bars, s):
    src = source(bars, s.get("source", "close"))
    n = _spec_int(s, "length", 20)
    k = _spec_float(s, "mult", 2.0)
    basis = sma(src, n)
    dev = stdev(src, n)
    upper = [b + k * d if b is not None and d is not None else None for b, d in zip(basis, dev)]
    lower = [b - k * d if b is not None and d is not None else None for b, d in zip(basis, dev)]
    return {"basis": basis, "upper": upper, "lower": lower}


def _stoch(bars, s):
    n = _spec_int(s, "length", 14)
    k_smooth = _spec_int(s, "smooth", 3)
    raw: Series = []
    for i in range(len(bars)):
        if i < n - 1:
            raw.append(None)
            continue
        window = bars[i - n + 1 : i + 1]
        hh = max(b.high for b in window)
        ll = min(b.low for b in window)
        raw.append(None if hh == ll else (bars[i].close - ll) / (hh - ll) * 100)
    k = sma(raw, k_smooth)
    return {"k": k, "d": sma(k, _spec_int(s, "d", 3))}


def _cci(bars, s):
    n = _spec_int(s, "length", 20)
    src = source(bars, s.get("source", "hlc3"))
    ma = sma(src, n)
    out: Series = [None] * len(src)
    for i, m in enumerate(ma):
        if m is None:
            continue
        md = sum(abs(x - m) for x in src[i - n + 1 : i + 1]) / n
        out[i] = 0.0 if md == 0 else (src[i] - m) / (0.015 * md)
    return {"value": out}


# indicator id -> (label, outputs, params with defaults, function(bars, spec) -> {output: series})
INDICATORS: dict[str, tuple[str, list[str], dict[str, Any], Callable[[list[Bar], dict], dict[str, Series]]]] = {
    "price": ("Price", ["value"], {"source": "close"}, lambda bars, s: {"value": source(bars, s.get("source", "close"))}),
    "sma": ("SMA", ["value"], {"length": 20, "source": "close"},
            lambda bars, s: {"value": sma(source(bars, s.get("source", "close")), _spec_int(s, "length", 20))}),
    "ema": ("EMA", ["value"], {"length": 20, "source": "close"},
            lambda bars, s: {"value": ema(source(bars, s.get("source", "close")), _spec_int(s, "length", 20))}),
    "rsi": ("RSI", ["value"], {"length": 14, "source": "close"},
            lambda bars, s: {"value": rsi(source(bars, s.get("source", "close")), _spec_int(s, "length", 14))}),
    "macd": ("MACD", ["macd", "signal", "hist"], {"fast": 12, "slow": 26, "signal": 9, "source": "close"}, _macd),
    "bb": ("Bollinger Bands", ["upper", "basis", "lower"], {"length": 20, "mult": 2.0, "source": "close"}, _bb),
    "stoch": ("Stochastic", ["k", "d"], {"length": 14, "smooth": 3, "d": 3}, _stoch),
    "atr": ("ATR", ["value"], {"length": 14}, lambda bars, s: {"value": rma(true_range(bars), _spec_int(s, "length", 14))}),
    "cci": ("CCI", ["value"], {"length": 20, "source": "hlc3"}, _cci),
    "volume_sma": ("Volume SMA", ["value"], {"length": 20},
                   lambda bars, s: {"value": sma([b.volume for b in bars], _spec_int(s, "length", 20))}),
}


def catalog() -> list[dict]:
    return [{"id": k, "label": v[0], "outputs": v[1], "params": v[2]} for k, v in INDICATORS.items()]


def compute(bars: list[Bar], spec: dict) -> Series:
    """Series for {"ind": id, "output": name, ...params}; a bare number → constant series."""
    if "value" in spec and "ind" not in spec:
        c = float(spec["value"])
        return [c] * len(bars)
    entry = INDICATORS.get(spec.get("ind", ""))
    if entry is None:
        raise ValueError(f"unknown indicator {spec.get('ind')!r}")
    _, outputs, _, fn = entry
    out = fn(bars, spec)
    name = spec.get("output") or outputs[0]
    if name not in out:
        raise ValueError(f"{spec.get('ind')} has no output {name!r}")
    return out[name]


def describe(spec: dict) -> str:
    if "value" in spec and "ind" not in spec:
        return f"{float(spec['value']):g}"
    entry = INDICATORS.get(spec.get("ind", ""))
    if entry is None:
        return str(spec.get("ind"))
    label, outputs, params, _ = entry
    args = [str(spec.get(k, d)) for k, d in params.items() if k != "source" or spec.get(k, d) != "close"]
    out = spec.get("output") or outputs[0]
    suffix = f".{out}" if len(outputs) > 1 else ""
    if spec.get("ind") == "price":
        return spec.get("source", "close")
    return f"{label}({', '.join(args)}){suffix}"
