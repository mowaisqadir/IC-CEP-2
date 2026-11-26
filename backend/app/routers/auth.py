"""
backend/app/routers/auth.py
Auth endpoints:
  POST /api/auth/login  — {username, password} → {token, user}
  GET  /api/auth/me     — requires Bearer token → {user}
"""

from collections import defaultdict, deque
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.auth import (
    generate_token,
    get_current_user,
    hash_password,       # imported for type-checking completeness; used in seed
    verify_password,
)
from app.config import (
    LOGIN_RATE_LIMIT_MAX,
    LOGIN_RATE_LIMIT_WINDOW_S,
    SESSION_LIFETIME_SECONDS,
)
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
# In-memory login rate limiter (5 attempts / 60s / IP + username)
# ---------------------------------------------------------------------------

_rate_lock = threading.Lock()
_login_attempts: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def reset_rate_limiter() -> None:
    """Clear all recorded login attempts (useful in tests)."""
    with _rate_lock:
        _login_attempts.clear()


def _check_and_record_login_attempt(client_ip: str, username: str) -> None:
    key = (client_ip, username)
    now = time.monotonic()
    cutoff = now - LOGIN_RATE_LIMIT_WINDOW_S

    with _rate_lock:
        q = _login_attempts[key]
        while q and q[0] <= cutoff:
            q.popleft()

        if len(q) >= LOGIN_RATE_LIMIT_MAX:
            retry_after = max(1, int(LOGIN_RATE_LIMIT_WINDOW_S - (now - q[0])) + 1)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts. Please wait a minute and try again.",
                headers={"Retry-After": str(retry_after)},
            )

        q.append(now)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    request: Request,
    db: sqlite3.Connection = Depends(get_db),
) -> LoginResponse:
    """
    Validate credentials and return a fresh session token.
    Rate-limited to 5 attempts per minute per IP + username.
    Intentionally returns the same 401 for wrong username or wrong password
    to avoid username-enumeration attacks.
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_and_record_login_attempt(client_ip, body.username)

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
