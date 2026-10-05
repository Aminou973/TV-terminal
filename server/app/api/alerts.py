"""Alerts API: price, trend-line, indicator and script alerts with delivery channels."""

from __future__ import annotations

import json
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.alerts import indicators
from app.alerts.engine import CONDITIONS, FREQUENCIES
from app.alerts.notify import DeliveryError, deliver
from app.api.rest import require_runtime
from app.auth.router import get_current_user
from app.candles.resample import TF_SECONDS
from app.config import settings
from app.db.database import database

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

Kind = Literal["price", "line", "indicator", "script"]
Condition = Literal["crossing", "crossing_up", "crossing_down", "greater", "less"]
Frequency = Literal["once", "once_per_bar", "once_per_bar_close", "once_per_minute", "every_time"]


class Notify(BaseModel):
    webhook: Optional[str | bool] = None  # URL, or true = the user's default webhook
    telegram: bool = False
    email: bool = False


class AlertIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    kind: Kind = "price"
    condition: Condition = "crossing"
    price: float = 0.0
    params: dict[str, Any] = Field(default_factory=dict)
    tf: str = "1m"
    frequency: Frequency = "once"
    expires_ms: Optional[int] = None
    message: str = Field(default="", max_length=2000)
    notify: Notify = Field(default_factory=Notify)
    # legacy clients
    once: Optional[bool] = None


def _validate(body: AlertIn, user: dict) -> dict:
    if body.tf not in TF_SECONDS:
        raise HTTPException(status_code=400, detail=f"unsupported timeframe {body.tf!r}")
    params = dict(body.params)
    if body.kind == "line":
        try:
            for k in ("t1", "p1", "t2", "p2"):
                float(params[k])
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail="line alerts need t1, p1, t2, p2") from e
        params.setdefault("extend", "right")
    elif body.kind == "indicator":
        dummy = [indicators.Bar("X", i * 60, 1.0 + i % 3, 2.0 + i % 3, 0.5, 1.5, 1.0) for i in range(60)]
        try:
            indicators.compute(dummy, params["left"])
            indicators.compute(dummy, params["right"])
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"invalid indicator condition: {e}") from e
    elif body.kind == "script":
        name = params.get("name")
        row = database.query_one("SELECT source FROM scripts WHERE user_id = ? AND name = ?", (user["id"], name))
        if row is None:
            raise HTTPException(status_code=400, detail=f"no saved script named {name!r}")
        if not params.get("condition"):
            raise HTTPException(status_code=400, detail="pick an alertcondition or 'strategy'")
        params["source"] = row["source"]  # snapshot, like TradingView: editing the script later doesn't change the alert
    if body.expires_ms is not None and body.expires_ms < int(time.time() * 1000):
        raise HTTPException(status_code=400, detail="expiry is in the past")
    frequency = body.frequency
    if body.once is False and frequency == "once":
        frequency = "every_time"
    notify = {k: v for k, v in body.notify.model_dump().items() if v}
    return {
        "symbol": body.symbol,
        "kind": body.kind,
        "condition": body.condition,
        "price": body.price,
        "params": json.dumps(params),
        "tf": body.tf,
        "frequency": frequency,
        "expires_ms": body.expires_ms,
        "message": body.message,
        "notify": json.dumps(notify),
        "once": int(frequency == "once"),
    }


def _row(r: dict) -> dict:
    out = dict(r)
    out["params"] = json.loads(r.get("params") or "{}")
    out["params"].pop("source", None)  # don't ship script source back in lists
    out["notify"] = json.loads(r.get("notify") or "{}")
    return out


@router.get("")
async def list_alerts(user: dict = Depends(get_current_user)):
    rows = database.query_all("SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC", (user["id"],))
    return [_row(r) for r in rows]


@router.get("/catalog")
async def catalog(user: dict = Depends(get_current_user)):
    return {
        "indicators": indicators.catalog(),
        "conditions": list(CONDITIONS),
        "frequencies": list(FREQUENCIES),
        "email_available": bool(settings.smtp_host),
        "telegram_default_bot": bool(settings.telegram_bot_token),
    }


@router.post("")
async def create_alert(body: AlertIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    v = _validate(body, user)
    aid = database.execute(
        "INSERT INTO alerts (user_id, symbol, kind, condition, price, params, tf, frequency, expires_ms, message, notify, once)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (user["id"], v["symbol"], v["kind"], v["condition"], v["price"], v["params"], v["tf"], v["frequency"],
         v["expires_ms"], v["message"], v["notify"], v["once"]),
    )
    rt.alerts.reload()
    return _row(database.query_one("SELECT * FROM alerts WHERE id = ?", (aid,)))


@router.put("/{aid:int}")
async def update_alert(aid: int, body: AlertIn, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    if database.query_one("SELECT id FROM alerts WHERE id = ? AND user_id = ?", (aid, user["id"])) is None:
        raise HTTPException(status_code=404, detail="alert not found")
    v = _validate(body, user)
    database.execute(
        "UPDATE alerts SET symbol = ?, kind = ?, condition = ?, price = ?, params = ?, tf = ?, frequency = ?,"
        " expires_ms = ?, message = ?, notify = ?, once = ?, active = 1, error = NULL WHERE id = ?",
        (v["symbol"], v["kind"], v["condition"], v["price"], v["params"], v["tf"], v["frequency"],
         v["expires_ms"], v["message"], v["notify"], v["once"], aid),
    )
    rt.alerts.reload()
    return _row(database.query_one("SELECT * FROM alerts WHERE id = ?", (aid,)))


@router.patch("/{aid:int}")
async def toggle_alert(aid: int, active: bool, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    row = database.query_one("SELECT id FROM alerts WHERE id = ? AND user_id = ?", (aid, user["id"]))
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    database.execute("UPDATE alerts SET active = ?, error = NULL WHERE id = ?", (int(active), aid))
    rt.alerts.reload()
    return _row(database.query_one("SELECT * FROM alerts WHERE id = ?", (aid,)))


@router.delete("/{aid:int}")
async def delete_alert(aid: int, user: dict = Depends(get_current_user)):
    rt = require_runtime()
    database.execute("DELETE FROM alerts WHERE id = ? AND user_id = ?", (aid, user["id"]))
    rt.alerts.reload()
    return {"ok": True}


@router.get("/log")
async def alert_log(user: dict = Depends(get_current_user)):
    return database.query_all("SELECT * FROM alert_log WHERE user_id = ? ORDER BY id DESC LIMIT 200", (user["id"],))


# -------------------------------------------------------- notification prefs ---
class NotifySettings(BaseModel):
    webhook_url: str = Field(default="", max_length=1000)
    telegram_bot_token: str = Field(default="", max_length=200)
    telegram_chat_id: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)


@router.get("/settings")
async def get_settings(user: dict = Depends(get_current_user)):
    row = database.query_one("SELECT * FROM notify_settings WHERE user_id = ?", (user["id"],))
    return NotifySettings(**{k: row[k] for k in NotifySettings.model_fields} if row else {})


@router.put("/settings")
async def put_settings(body: NotifySettings, user: dict = Depends(get_current_user)):
    database.execute(
        "INSERT INTO notify_settings (user_id, webhook_url, telegram_bot_token, telegram_chat_id, email) VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT(user_id) DO UPDATE SET webhook_url = excluded.webhook_url, telegram_bot_token = excluded.telegram_bot_token,"
        " telegram_chat_id = excluded.telegram_chat_id, email = excluded.email",
        (user["id"], body.webhook_url.strip(), body.telegram_bot_token.strip(), body.telegram_chat_id.strip(), body.email.strip()),
    )
    return body


@router.post("/test")
async def test_notify(body: Notify, user: dict = Depends(get_current_user)):
    prefs = database.query_one("SELECT * FROM notify_settings WHERE user_id = ?", (user["id"],)) or {}
    notify = {k: v for k, v in body.model_dump().items() if v}
    if not notify:
        raise HTTPException(status_code=400, detail="choose at least one channel")
    try:
        status = await deliver(
            notify, prefs, settings, "Test", f"OpenTerminal test alert for {user['username']} ✅",
            {"test": True},
        )
    except DeliveryError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"status": status}
