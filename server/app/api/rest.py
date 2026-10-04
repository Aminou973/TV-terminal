"""REST API: history, symbols, quotes, health."""

from __future__ import annotations

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
    user: dict = Depends(get_current_user),
):
    rt = require_runtime()
    if tf not in TF_SECONDS:
        raise HTTPException(status_code=400, detail=f"unsupported tf '{tf}'")
    bars = rt.service.history(symbol, tf, frm, to)
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