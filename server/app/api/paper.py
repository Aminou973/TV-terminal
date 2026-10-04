"""Paper trading API. Engine calls stay on the event loop (the bus is not thread-safe)."""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.rest import require_runtime
from app.auth.router import get_current_user
from app.paper.engine import PaperError

router = APIRouter(prefix="/api/paper", tags=["paper"])


class OrderIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop"] = "market"
    qty: float = Field(gt=0)
    price: Optional[float] = None


@router.get("/account")
async def account(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return {
        "account": rt.paper.account(user["id"]),
        "positions": rt.paper.positions(user["id"]),
        "orders": rt.paper.orders(user["id"]),
    }


@router.post("/orders")
async def place_order(body: OrderIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    try:
        return rt.paper.place(user["id"], body.symbol, body.side, body.type, body.qty, body.price)
    except PaperError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/orders/{oid}")
async def cancel_order(oid: int, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    if not rt.paper.cancel(user["id"], oid):
        raise HTTPException(status_code=404, detail="no working order with that id")
    return {"ok": True}


@router.post("/positions/{symbol}/close")
async def close_position(symbol: str, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    try:
        order = rt.paper.close_position(user["id"], symbol)
    except PaperError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if order is None:
        raise HTTPException(status_code=404, detail="no open position")
    return order


@router.post("/reset")
async def reset(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    rt.paper.reset(user["id"])
    return rt.paper.account(user["id"])
