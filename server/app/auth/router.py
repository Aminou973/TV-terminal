"""Auth API: register / login / me."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, Field

from app.auth.security import create_access_token, decode_token, hash_password, verify_password
from app.db.database import database

router = APIRouter(prefix="/api/auth", tags=["auth"])

# tokenUrl makes the OpenAPI "Authorize" button work; we also accept raw Bearer JWTs
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str
    role: str


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = await asyncio.to_thread(
        database.query_one, "SELECT * FROM users WHERE id = ?", (int(payload["sub"]),)
    )
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return user


@router.post("/register", response_model=TokenResponse)
async def register(req: RegisterRequest):
    existing = await asyncio.to_thread(database.get_user, req.username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")
    user = await asyncio.to_thread(database.create_user, req.username, hash_password(req.password))
    return TokenResponse(
        access_token=create_access_token(user), username=user["username"], role=user["role"]
    )


@router.post("/login", response_model=TokenResponse)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    user = await asyncio.to_thread(database.get_user, form.username)
    if user is None or not verify_password(form.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenResponse(
        access_token=create_access_token(user), username=user["username"], role=user["role"]
    )


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {"id": user["id"], "username": user["username"], "role": user["role"]}