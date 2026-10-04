"""SQLite store for users, watchlists, layouts and drawings (small-team scale).

Blocking sqlite3 calls are cheap at this scale; routers wrap them with
`asyncio.to_thread` where they touch request paths.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional

from app.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS watchlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    symbols     TEXT NOT NULL DEFAULT '[]',
    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS layouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    spec        TEXT NOT NULL DEFAULT '{}',
    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS drawings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    tf          TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, symbol, tf)
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # -- generic helpers ------------------------------------------------------
    def execute(self, sql: str, params: tuple = ()) -> None:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur.lastrowid

    def query_one(self, sql: str, params: tuple = ()) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def query_all(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    # -- users ---------------------------------------------------------------
    def create_user(self, username: str, password_hash: str) -> dict:
        with self._lock:
            count = self._conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            role = "admin" if count == 0 else "member"
            cur = self._conn.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                (username, password_hash, role),
            )
            self._conn.commit()
            return {"id": cur.lastrowid, "username": username, "role": role}

    def get_user(self, username: str) -> Optional[dict]:
        return self.query_one("SELECT * FROM users WHERE username = ?", (username,))

    def all_users(self) -> list[dict]:
        return self.query_all("SELECT id, username, role, created_at FROM users ORDER BY id")


database = Database(settings.sqlite_path)