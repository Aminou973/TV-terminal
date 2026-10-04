"""Economic calendar from the public Forex Factory weekly feed (JSON)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import httpx

FF_THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

IMPACTS = {"High": "high", "Medium": "medium", "Low": "low", "Holiday": "holiday", "Non-Economic": "low"}


def _ts(s: str) -> Optional[int]:
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except (AttributeError, ValueError):
        return None


def parse_ff(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows or []:
        t = _ts(r.get("date", ""))
        if t is None or not r.get("title"):
            continue
        out.append({
            "time": t,
            "country": (r.get("country") or "").upper(),
            "title": r["title"],
            "impact": IMPACTS.get(r.get("impact") or "", "low"),
            "actual": r.get("actual") or None,
            "forecast": r.get("forecast") or None,
            "previous": r.get("previous") or None,
        })
    return sorted(out, key=lambda e: e["time"])


def fetch(url: str = FF_THIS_WEEK) -> list[dict]:
    with httpx.Client(timeout=10, headers={"User-Agent": "OpenTerminal"}) as c:
        r = c.get(url)
        r.raise_for_status()
        return parse_ff(r.json())
