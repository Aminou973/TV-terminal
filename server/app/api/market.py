"""Market data API: news, fundamentals, chart events, overview, heatmap, calendars."""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query

from app import runtime as runtime_module
from app.auth.router import get_current_user
from app.config import settings
from app.market.service import MarketService

router = APIRouter(prefix="/api/market", tags=["market"])

market = MarketService(live=settings.market_live, calendar_url=settings.market_calendar_url)


def _local_last(symbol: str) -> Optional[float]:
    """The terminal's own last price for a symbol, if it has data for it."""
    rt = runtime_module.runtime
    if rt is None:
        return None
    try:
        st = rt.service.stats(symbol)
    except Exception:  # noqa: BLE001 — unknown symbol etc.
        return None
    return st.get("last") if st else None


@router.get("/status")
async def status(user: dict = Depends(get_current_user)):
    return market.status()


@router.get("/news")
async def news(symbol: Optional[str] = None, user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(market.news, symbol or None)


@router.get("/fundamentals")
async def fundamentals(symbol: str = Query(..., min_length=1), user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(lambda: market.fundamentals(symbol, _local_last(symbol)))


@router.get("/events")
async def events(symbol: str = Query(..., min_length=1), user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(lambda: market.events(symbol, _local_last(symbol)))


@router.get("/overview")
async def overview(user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(market.overview)


@router.get("/heatmap")
async def heatmap(user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(market.heatmap)


@router.get("/earnings")
async def earnings(symbols: str = "", user: dict = Depends(get_current_user)):
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:60]
    return await asyncio.to_thread(market.earnings_calendar, syms)


@router.get("/calendar")
async def economic_calendar(user: dict = Depends(get_current_user)):
    return await asyncio.to_thread(market.economic_calendar)
