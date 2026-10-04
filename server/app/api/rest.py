"""REST API: history, symbols, quotes, health."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Query

from app import runtime as runtime_module
from app.auth.router import get_current_user
from app.candles.resample import TF_SECONDS

router = APIRouter(prefix="/api", tags=["data"])


def require_runtime():
    runtime = runtime_module.runtime
    if runtime is None:
        raise HTTPException(status_code=503, detail="server still starting")
    return runtime


@router.get("/health")
async def health():
    runtime = runtime_module.runtime
    if runtime is None:
        return {"status": "starting"}
    return {
        "status": "ok",
        "providers": runtime.ingest.provider_status,
        "symbols": len(runtime.service.symbols()),
    }


@router.get("/symbols")
async def symbols(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return rt.service.symbols()


@router.get("/history")
async def history(
    symbol: str = Query(...),
    tf: str = Query("1m"),
    frm: int | None = Query(None, alias="from"),
    to: int | None = Query(None),
    limit: int | None = Query(None, ge=1, le=20000),
    user: dict = Depends(get_current_user),
):
    """Bars for a range, or the latest `limit` bars up to `to` (page left with to=oldest-1)."""
    rt = require_runtime()
    if tf not in TF_SECONDS:
        raise HTTPException(status_code=400, detail=f"unsupported tf '{tf}'")
    bars = await asyncio.to_thread(rt.service.history, symbol, tf, frm, to, limit)
    return {
        "symbol": symbol,
        "tf": tf,
        "bars": [b.to_dict() for b in bars],
    }


@router.get("/quote")
async def quote(symbols: str = Query(...), user: dict = Depends(get_current_user)):
    rt = require_runtime()
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    return {"quotes": rt.service.quote(syms)}

@router.get("/stats")
async def stats(symbol: str = Query(...), user: dict = Depends(get_current_user)):
    rt = require_runtime()
    out = await asyncio.to_thread(rt.service.stats, symbol)
    if out is None:
        raise HTTPException(status_code=404, detail="no data for symbol")
    return out


_screen_cache: dict[str, tuple[float, list[dict]]] = {}


@router.get("/screener")
async def screener(tf: str = Query("1D"), user: dict = Depends(get_current_user)):
    rt = require_runtime()
    if tf not in TF_SECONDS:
        raise HTTPException(status_code=400, detail=f"unsupported tf '{tf}'")
    hit = _screen_cache.get(tf)
    if hit and time.monotonic() - hit[0] < 15:
        return {"tf": tf, "rows": hit[1]}
    rows = await asyncio.to_thread(rt.service.screen, tf)
    _screen_cache[tf] = (time.monotonic(), rows)
    return {"tf": tf, "rows": rows}
