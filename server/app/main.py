"""OpenTerminal backend entrypoint.

Run:  uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import runtime as runtime_mod
from app.api import rest, ws
from app.auth import router as auth_router
from app.config import settings
from app.db.database import database
from app.runtime import Runtime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.connect()
    runtime_mod.runtime = Runtime(settings)
    await runtime_mod.runtime.start()
    yield
    await runtime_mod.runtime.stop()
    database.close()
    runtime_mod.runtime = None


app = FastAPI(title="OpenTerminal", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(rest.router)
app.include_router(ws.router)