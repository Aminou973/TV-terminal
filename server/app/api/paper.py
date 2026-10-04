"""Paper trading API. Engine calls stay on the event loop (the bus is not thread-safe)."""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.rest import require_runtime
from app.auth.router import get_current_user
from app.paper.engine import PaperError

router = APIRouter(prefix="/api/paper", tags=["paper"])

OrderType = Literal["market", "limit", "stop", "stop_limit", "trailing_stop"]


class OrderIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["buy", "sell"]
    type: OrderType = "market"
    qty: float = Field(gt=0)
    price: Optional[float] = None
    stop_price: Optional[float] = None
    trail: Optional[float] = None
    tp: Optional[float] = None
    sl: Optional[float] = None
    reduce_only: bool = False


class ModifyIn(BaseModel):
    price: Optional[float] = None
    qty: Optional[float] = Field(default=None, gt=0)
    stop_price: Optional[float] = None
    trail: Optional[float] = None
    tp: Optional[float] = None
    sl: Optional[float] = None
    clear_tp: bool = False
    clear_sl: bool = False


class BracketsIn(BaseModel):
    tp: Optional[float] = None
    sl: Optional[float] = None


class SettingsIn(BaseModel):
    starting_balance: Optional[float] = None
    commission: Optional[float] = None


class TradeNoteIn(BaseModel):
    notes: Optional[str] = Field(default=None, max_length=5000)
    tags: Optional[str] = Field(default=None, max_length=500)


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except PaperError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/account")
async def account(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return {
        "account": rt.paper.account(user["id"]),
        "positions": rt.paper.positions(user["id"]),
        "orders": rt.paper.orders(user["id"]),
    }


@router.put("/settings")
async def settings(body: SettingsIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return _run(rt.paper.configure, user["id"], body.starting_balance, body.commission)


@router.get("/instrument")
async def instrument(symbol: str, user: dict = Depends(get_current_user)):
    return require_runtime().paper.instrument(symbol)


@router.post("/orders")
async def place_order(body: OrderIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return _run(
        rt.paper.place, user["id"], body.symbol, body.side, body.type, body.qty, body.price,
        stop_price=body.stop_price, trail=body.trail, tp=body.tp, sl=body.sl, reduce_only=body.reduce_only,
    )


@router.patch("/orders/{oid}")
async def modify_order(oid: int, body: ModifyIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return _run(rt.paper.modify, user["id"], oid, **body.model_dump())


@router.delete("/orders/{oid}")
async def cancel_order(oid: int, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    if not rt.paper.cancel(user["id"], oid):
        raise HTTPException(status_code=404, detail="no working order with that id")
    return {"ok": True}


@router.delete("/orders")
async def cancel_all(symbol: Optional[str] = None, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return {"cancelled": rt.paper.cancel_all(user["id"], symbol)}


@router.post("/positions/{symbol}/close")
async def close_position(symbol: str, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    order = _run(rt.paper.close_position, user["id"], symbol)
    if order is None:
        raise HTTPException(status_code=404, detail="no open position")
    return order


@router.post("/positions/{symbol}/reverse")
async def reverse_position(symbol: str, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    order = _run(rt.paper.reverse_position, user["id"], symbol)
    if order is None:
        raise HTTPException(status_code=404, detail="no open position")
    return order


@router.put("/positions/{symbol}/brackets")
async def position_brackets(symbol: str, body: BracketsIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return _run(rt.paper.set_brackets, user["id"], symbol, body.tp, body.sl)


@router.post("/flatten")
async def flatten(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return _run(rt.paper.flatten, user["id"])


@router.get("/trades")
async def trades(symbol: Optional[str] = None, limit: int = 500, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    return rt.paper.trades(user["id"], symbol, min(max(limit, 1), 5000))


@router.patch("/trades/{tid}")
async def annotate_trade(tid: int, body: TradeNoteIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    t = rt.paper.annotate_trade(user["id"], tid, body.notes, body.tags)
    if t is None:
        raise HTTPException(status_code=404, detail="trade not found")
    return t


@router.post("/reset")
async def reset(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    rt.paper.reset(user["id"])
    return rt.paper.account(user["id"])
