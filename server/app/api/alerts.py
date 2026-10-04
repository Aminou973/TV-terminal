"""Alerts API (price-level alerts evaluated server-side on every tick)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.rest import require_runtime
from app.auth.router import get_current_user
from app.db.database import database

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


class AlertIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    condition: Literal["crossing", "crossing_up", "crossing_down", "greater", "less"] = "crossing"
    price: float
    message: str = Field(default="", max_length=500)
    once: bool = True


@router.get("")
async def list_alerts(user: dict = Depends(get_current_user)):
    return database.query_all("SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC", (user["id"],))


@router.post("")
async def create_alert(body: AlertIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    aid = database.execute(
        "INSERT INTO alerts (user_id, symbol, condition, price, message, once) VALUES (?, ?, ?, ?, ?, ?)",
        (user["id"], body.symbol, body.condition, body.price, body.message, int(body.once)),
    )
    rt.alerts.reload()
    return database.query_one("SELECT * FROM alerts WHERE id = ?", (aid,))


@router.patch("/{aid}")
async def toggle_alert(aid: int, active: bool, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    row = database.query_one("SELECT id FROM alerts WHERE id = ? AND user_id = ?", (aid, user["id"]))
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    database.execute("UPDATE alerts SET active = ? WHERE id = ?", (int(active), aid))
    rt.alerts.reload()
    return database.query_one("SELECT * FROM alerts WHERE id = ?", (aid,))


@router.delete("/{aid}")
async def delete_alert(aid: int, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    database.execute("DELETE FROM alerts WHERE id = ? AND user_id = ?", (aid, user["id"]))
    rt.alerts.reload()
    return {"ok": True}


@router.get("/log")
async def alert_log(user: dict = Depends(get_current_user)):
    return database.query_all(
        "SELECT * FROM alert_log WHERE user_id = ? ORDER BY id DESC LIMIT 200", (user["id"],)
    )
