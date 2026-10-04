"""Order routing to NinjaTrader 8 through the bridge AddOn.

Off unless OPENTERM_NINJA_ORDERS_ENABLED=true, admin-only, and the AddOn's
own "Allow order routing" box and account allow-list must agree — three
independent switches before a real order can leave this server.
"""

from __future__ import annotations

import uuid
from collections import deque
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.rest import require_runtime
from app.auth.router import get_current_user
from app.config import settings
from app.models import UserEvent

router = APIRouter(prefix="/api/broker/ninja", tags=["broker"])

# ref -> user id, and a short history of updates per user
_owners: dict[str, int] = {}
_updates: dict[int, deque] = {}
_wired: set[int] = set()


class NinjaOrderIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop"] = "market"
    qty: int = Field(gt=0, le=1000)
    price: Optional[float] = None
    contract: Optional[str] = None  # override, e.g. "ES 03-26"


def _wire(rt) -> None:
    """Route bridge order updates to the user who placed the order (once per runtime)."""
    if id(rt) in _wired:
        return
    _wired.add(id(rt))

    def on_update(frame: dict) -> None:
        user_id = _owners.get(str(frame.get("ref")))
        if user_id is None:
            return
        payload = {"type": "broker", "broker": "ninja", **frame}
        _updates.setdefault(user_id, deque(maxlen=200)).appendleft(payload)
        rt.bus.publish(UserEvent(user_id, payload))

    rt.ingest.order_update_listeners.append(on_update)


def _require_admin(user: dict) -> None:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="only the admin can route orders to NinjaTrader")


@router.get("/status")
async def status(user: dict = Depends(get_current_user)):
    rt = require_runtime()
    ninja = rt.ingest.ninja
    return {
        "enabled": settings.ninja_orders_enabled,
        "connected": bool(ninja and ninja.connected),
        "account": settings.ninja_order_account,
        "contracts": dict(ninja.contracts) if ninja else {},
        "can_trade": settings.ninja_orders_enabled and user["role"] == "admin",
    }


@router.post("/orders")
async def place(body: NinjaOrderIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    _require_admin(user)
    if not settings.ninja_orders_enabled:
        raise HTTPException(status_code=400, detail="NinjaTrader routing is disabled (OPENTERM_NINJA_ORDERS_ENABLED)")
    ninja = rt.ingest.ninja
    if ninja is None or not ninja.connected:
        raise HTTPException(status_code=503, detail="NinjaTrader bridge is not connected")
    contract = body.contract or ninja.contracts.get(body.symbol)
    if not contract:
        raise HTTPException(status_code=400, detail=f"no NT contract known for {body.symbol}; pass `contract`")
    if body.type != "market" and not body.price:
        raise HTTPException(status_code=400, detail=f"{body.type} orders need a price")
    _wire(rt)
    ref = uuid.uuid4().hex[:12]
    _owners[ref] = user["id"]
    await ninja.send(
        {
            "type": "order",
            "ref": ref,
            "account": settings.ninja_order_account,
            "contract": contract,
            "action": "Buy" if body.side == "buy" else "Sell",
            "order_type": {"market": "Market", "limit": "Limit", "stop": "StopMarket"}[body.type],
            "qty": body.qty,
            "limit": body.price if body.type == "limit" else 0,
            "stop": body.price if body.type == "stop" else 0,
        }
    )
    return {"ref": ref, "status": "sent", "contract": contract, "account": settings.ninja_order_account}


@router.delete("/orders/{ref}")
async def cancel(ref: str, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    _require_admin(user)
    if _owners.get(ref) != user["id"]:
        raise HTTPException(status_code=404, detail="unknown order")
    ninja = rt.ingest.ninja
    if ninja is None or not ninja.connected:
        raise HTTPException(status_code=503, detail="NinjaTrader bridge is not connected")
    await ninja.send({"type": "cancel", "ref": ref})
    return {"ok": True}


@router.get("/orders")
async def updates(user: dict = Depends(get_current_user)):
    return list(_updates.get(user["id"], []))
