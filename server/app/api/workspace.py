"""Per-user workspace: watchlists, chart layouts, drawings, scripts.

Specs are opaque JSON owned by the web app (layout grid, per-pane symbol/tf,
indicators; drawing manager exports; script source) — the server only stores
them, scoped to the signed-in user.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth.router import get_current_user
from app.db.database import database

router = APIRouter(prefix="/api", tags=["workspace"])

_MAX_JSON = 2_000_000  # bytes per stored document


def _dump(value: Any) -> str:
    text = json.dumps(value, separators=(",", ":"))
    if len(text) > _MAX_JSON:
        raise HTTPException(status_code=413, detail="document too large")
    return text


async def _q_all(sql: str, params: tuple) -> list[dict]:
    return await asyncio.to_thread(database.query_all, sql, params)


async def _q_one(sql: str, params: tuple) -> dict | None:
    return await asyncio.to_thread(database.query_one, sql, params)


async def _exec(sql: str, params: tuple) -> int:
    return await asyncio.to_thread(database.execute, sql, params)


# ------------------------------------------------------------- watchlists ---
class WatchlistIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    symbols: list[str] = Field(default_factory=list, max_length=1000)


@router.get("/watchlists")
async def list_watchlists(user: dict = Depends(get_current_user)):
    rows = await _q_all("SELECT id, name, symbols FROM watchlists WHERE user_id = ? ORDER BY id", (user["id"],))
    return [{"id": r["id"], "name": r["name"], "symbols": json.loads(r["symbols"])} for r in rows]


@router.put("/watchlists")
async def save_watchlist(body: WatchlistIn, user: dict = Depends(get_current_user)):
    """Upsert by name."""
    await _exec(
        "INSERT INTO watchlists (user_id, name, symbols) VALUES (?, ?, ?) "
        "ON CONFLICT(user_id, name) DO UPDATE SET symbols = excluded.symbols",
        (user["id"], body.name, _dump(body.symbols)),
    )
    row = await _q_one("SELECT id FROM watchlists WHERE user_id = ? AND name = ?", (user["id"], body.name))
    return {"id": row["id"], "name": body.name, "symbols": body.symbols}


@router.delete("/watchlists/{wid}")
async def delete_watchlist(wid: int, user: dict = Depends(get_current_user)):
    await _exec("DELETE FROM watchlists WHERE id = ? AND user_id = ?", (wid, user["id"]))
    return {"ok": True}


# ---------------------------------------------------------------- layouts ---
class LayoutIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    spec: dict[str, Any]


@router.get("/layouts")
async def list_layouts(user: dict = Depends(get_current_user)):
    rows = await _q_all("SELECT id, name, spec FROM layouts WHERE user_id = ? ORDER BY id", (user["id"],))
    return [{"id": r["id"], "name": r["name"], "spec": json.loads(r["spec"])} for r in rows]


@router.put("/layouts")
async def save_layout(body: LayoutIn, user: dict = Depends(get_current_user)):
    await _exec(
        "INSERT INTO layouts (user_id, name, spec) VALUES (?, ?, ?) "
        "ON CONFLICT(user_id, name) DO UPDATE SET spec = excluded.spec",
        (user["id"], body.name, _dump(body.spec)),
    )
    row = await _q_one("SELECT id FROM layouts WHERE user_id = ? AND name = ?", (user["id"], body.name))
    return {"id": row["id"], "name": body.name, "spec": body.spec}


@router.delete("/layouts/{lid}")
async def delete_layout(lid: int, user: dict = Depends(get_current_user)):
    await _exec("DELETE FROM layouts WHERE id = ? AND user_id = ?", (lid, user["id"]))
    return {"ok": True}


# --------------------------------------------------------------- drawings ---
# Drawings follow the symbol across timeframes (TradingView behaviour), so
# they are stored under tf "*".
class DrawingsIn(BaseModel):
    data: list[Any]


@router.get("/drawings/{symbol}")
async def get_drawings(symbol: str, user: dict = Depends(get_current_user)):
    row = await _q_one(
        "SELECT data FROM drawings WHERE user_id = ? AND symbol = ? AND tf = '*'", (user["id"], symbol)
    )
    return {"symbol": symbol, "data": json.loads(row["data"]) if row else []}


@router.put("/drawings/{symbol}")
async def save_drawings(symbol: str, body: DrawingsIn, user: dict = Depends(get_current_user)):
    await _exec(
        "INSERT INTO drawings (user_id, symbol, tf, data, updated_at) VALUES (?, ?, '*', ?, datetime('now')) "
        "ON CONFLICT(user_id, symbol, tf) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        (user["id"], symbol, _dump(body.data)),
    )
    return {"ok": True}


# ---------------------------------------------------------------- scripts ---
class ScriptIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["indicator", "strategy"] = "indicator"
    source: str = Field(max_length=200_000)


@router.get("/scripts")
async def list_scripts(user: dict = Depends(get_current_user)):
    return await _q_all(
        "SELECT id, name, kind, source, updated_at FROM scripts WHERE user_id = ? ORDER BY name", (user["id"],)
    )


@router.put("/scripts")
async def save_script(body: ScriptIn, user: dict = Depends(get_current_user)):
    await _exec(
        "INSERT INTO scripts (user_id, name, kind, source, updated_at) VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id, name) DO UPDATE SET kind = excluded.kind, source = excluded.source, "
        "updated_at = excluded.updated_at",
        (user["id"], body.name, body.kind, body.source),
    )
    return await _q_one(
        "SELECT id, name, kind, source, updated_at FROM scripts WHERE user_id = ? AND name = ?",
        (user["id"], body.name),
    )


@router.delete("/scripts/{sid}")
async def delete_script(sid: int, user: dict = Depends(get_current_user)):
    await _exec("DELETE FROM scripts WHERE id = ? AND user_id = ?", (sid, user["id"]))
    return {"ok": True}


# -------------------------------------------------------------- templates ---
# Named presets: indicator sets, chart settings, drawing styles.
TemplateKind = Literal["indicators", "chart", "drawing"]


class TemplateIn(BaseModel):
    kind: TemplateKind
    name: str = Field(min_length=1, max_length=64)
    spec: Any


@router.get("/templates")
async def list_templates(kind: TemplateKind, user: dict = Depends(get_current_user)):
    rows = await _q_all(
        "SELECT id, kind, name, spec FROM templates WHERE user_id = ? AND kind = ? ORDER BY name", (user["id"], kind)
    )
    return [{**r, "spec": json.loads(r["spec"])} for r in rows]


@router.put("/templates")
async def save_template(body: TemplateIn, user: dict = Depends(get_current_user)):
    await _exec(
        "INSERT INTO templates (user_id, kind, name, spec) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id, kind, name) DO UPDATE SET spec = excluded.spec",
        (user["id"], body.kind, body.name, _dump(body.spec)),
    )
    row = await _q_one(
        "SELECT id, kind, name, spec FROM templates WHERE user_id = ? AND kind = ? AND name = ?",
        (user["id"], body.kind, body.name),
    )
    return {**row, "spec": json.loads(row["spec"])}


@router.delete("/templates/{tid}")
async def delete_template(tid: int, user: dict = Depends(get_current_user)):
    await _exec("DELETE FROM templates WHERE id = ? AND user_id = ?", (tid, user["id"]))
    return {"ok": True}
