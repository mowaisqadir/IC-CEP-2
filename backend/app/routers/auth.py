"""
backend/app/routers/auth.py
Auth endpoints:
  POST /api/auth/login  — {username, password} → {token, user}
  GET  /api/auth/me     — requires Bearer token → {user}
"""

import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.auth import (
    generate_token,
    get_current_user,
    hash_password,       # imported for type-checking completeness; used in seed
    verify_password,
)
from app.config import SESSION_LIFETIME_SECONDS
from app.db import get_db

router = APIRouter(prefix="/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id:           str
    username:     str
    display_name: str


class LoginResponse(BaseModel):
    token: str
    user:  UserOut


class MeResponse(BaseModel):
    user: UserOut


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: sqlite3.Connection = Depends(get_db)) -> LoginResponse:
    """
    Validate credentials and return a fresh session token.
    Intentionally returns the same 401 for wrong username or wrong password
    to avoid username-enumeration attacks.
    """
    row = db.execute(
        "SELECT id, username, display_name, password_hash FROM users WHERE username = ?",
        (body.username,),
    ).fetchone()

    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = generate_token()
    now   = datetime.now(timezone.utc)
    exp   = now + timedelta(seconds=SESSION_LIFETIME_SECONDS)

    db.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, row["id"], now.isoformat(), exp.isoformat()),
    )
    db.commit()

    return LoginResponse(
        token=token,
        user=UserOut(
            id=row["id"],
            username=row["username"],
            display_name=row["display_name"],
        ),
    )


@router.get("/me", response_model=MeResponse)
def me(current_user: dict = Depends(get_current_user)) -> MeResponse:
    """Return the authenticated user's profile."""
    return MeResponse(user=UserOut(**current_user))
