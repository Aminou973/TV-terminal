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
CREATE TABLE IF NOT EXISTS scripts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'indicator',   -- indicator | strategy
    source      TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol       TEXT NOT NULL,
    condition    TEXT NOT NULL,          -- crossing | crossing_up | crossing_down | greater | less
    price        REAL NOT NULL,
    message      TEXT NOT NULL DEFAULT '',
    once         INTEGER NOT NULL DEFAULT 1,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    triggered_at TEXT
);
CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id    INTEGER,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    price       REAL NOT NULL,
    message     TEXT NOT NULL,
    ts_ms       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_accounts (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    starting_balance REAL NOT NULL,
    realized_pnl     REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paper_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol       TEXT NOT NULL,
    side         TEXT NOT NULL,          -- buy | sell
    type         TEXT NOT NULL,          -- market | limit | stop
    qty          REAL NOT NULL,
    price        REAL,                   -- limit / stop trigger price
    status       TEXT NOT NULL,          -- working | filled | cancelled | rejected
    fill_price   REAL,
    created_ms   INTEGER NOT NULL,
    filled_ms    INTEGER
);
CREATE TABLE IF NOT EXISTS paper_positions (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol       TEXT NOT NULL,
    qty          REAL NOT NULL,          -- signed: + long, - short
    avg_price    REAL NOT NULL,
    PRIMARY KEY (user_id, symbol)
);
CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,          -- indicators | chart | drawing
    name        TEXT NOT NULL,
    spec        TEXT NOT NULL,
    UNIQUE(user_id, kind, name)
);
CREATE TABLE IF NOT EXISTS notify_settings (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    webhook_url        TEXT NOT NULL DEFAULT '',
    telegram_bot_token TEXT NOT NULL DEFAULT '',
    telegram_chat_id   TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS kv (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
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
        self._migrate()
        self._conn.commit()

    # columns added after a table first shipped: (table, column, definition)
    _ADDED_COLUMNS = [
        ("alerts", "kind", "TEXT NOT NULL DEFAULT 'price'"),       # price | line | indicator | script
        ("alerts", "params", "TEXT NOT NULL DEFAULT '{}'"),        # kind-specific spec (JSON)
        ("alerts", "tf", "TEXT NOT NULL DEFAULT '1m'"),
        ("alerts", "frequency", "TEXT NOT NULL DEFAULT 'once'"),   # once | once_per_bar | once_per_bar_close | once_per_minute | every_time
        ("alerts", "expires_ms", "INTEGER"),
        ("alerts", "notify", "TEXT NOT NULL DEFAULT '{}'"),        # {"webhook": url, "telegram": bool, "email": bool}
        ("alerts", "last_fired_ms", "INTEGER"),
        ("alerts", "last_bar", "INTEGER"),
        ("alerts", "error", "TEXT"),
        ("alert_log", "delivery", "TEXT NOT NULL DEFAULT ''"),
    ]

    def _migrate(self) -> None:
        for table, column, definition in self._ADDED_COLUMNS:
            have = {r["name"] for r in self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in have:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        # alerts created before frequencies existed: once=0 meant "every time"
        self._conn.execute("UPDATE alerts SET frequency = 'every_time' WHERE once = 0 AND frequency = 'once'")

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # -- generic helpers ------------------------------------------------------
    def execute(self, sql: str, params: tuple = ()) -> int:
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

    # -- key/value (server-side secrets such as broker tokens) ----------------
    def kv_get(self, key: str) -> Optional[str]:
        row = self.query_one("SELECT value FROM kv WHERE key = ?", (key,))
        return row["value"] if row else None

    def kv_set(self, key: str, value: str) -> None:
        self.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


database = Database(settings.sqlite_path)