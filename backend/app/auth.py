"""
backend/app/auth.py
Authentication helpers:
  • scrypt password hashing via hashlib (stdlib only — no passlib/bcrypt)
  • secure random session token via secrets.token_urlsafe(32)
  • FastAPI dependency get_current_user() — reads Bearer token, rejects expired sessions
"""

import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.db import get_db

# ---------------------------------------------------------------------------
# Password hashing — hashlib.scrypt
# ---------------------------------------------------------------------------
# Default parameters — overridable via environment variables at runtime (not at import time).
# Reading at call time means tests can set FIELDSYNC_SCRYPT_N=1024 via conftest.py and
# the value is respected even after the module has already been imported.
_SCRYPT_DKL = 64  # derived-key length in bytes (fixed)


def _scrypt_params() -> tuple[int, int, int]:
    """Read scrypt n/r/p from env at call time so test overrides always take effect."""
    n = int(os.environ.get("FIELDSYNC_SCRYPT_N", "16384"))
    r = int(os.environ.get("FIELDSYNC_SCRYPT_R", "8"))
    p = int(os.environ.get("FIELDSYNC_SCRYPT_P", "1"))
    return n, r, p


def hash_password(plain: str) -> str:
    """
    Hash a plaintext password with scrypt + a random 16-byte salt.
    Returns a string in the format:  <hex_salt>$<hex_hash>
    """
    n, r, p = _scrypt_params()
    salt = os.urandom(16)
    dk = hashlib.scrypt(
        plain.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=_SCRYPT_DKL,
    )
    return f"{salt.hex()}${dk.hex()}"


def verify_password(plain: str, stored: str) -> bool:
    """
    Verify a plaintext password against a stored ``hash_password`` output.
    Returns True if the password matches, False otherwise.
    Uses secrets.compare_digest for constant-time comparison.
    """
    try:
        salt_hex, dk_hex = stored.split("$", 1)
    except ValueError:
        return False
    n, r, p = _scrypt_params()
    salt = bytes.fromhex(salt_hex)
    dk_expected = bytes.fromhex(dk_hex)
    dk_actual = hashlib.scrypt(
        plain.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=_SCRYPT_DKL,
    )
    return secrets.compare_digest(dk_actual, dk_expected)


# ---------------------------------------------------------------------------
# Token generation
# ---------------------------------------------------------------------------

def generate_token() -> str:
    """Return a 32-byte URL-safe base64-encoded random token (43 chars)."""
    return secrets.token_urlsafe(32)


# ---------------------------------------------------------------------------
# FastAPI dependency — get_current_user
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer(auto_error=True)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    db: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    FastAPI dependency.  Reads the Bearer token from the Authorization header,
    looks it up in the sessions table, and verifies it has not expired.

    Returns the matching users row as a plain dict.
    Raises HTTP 401 on any failure.
    """
    token = credentials.credentials
    now_utc = datetime.now(timezone.utc).isoformat()

    row = db.execute(
        """
        SELECT s.token, s.expires_at, u.id, u.username, u.display_name
        FROM   sessions s
        JOIN   users    u ON u.id = s.user_id
        WHERE  s.token = ?
        """,
        (token,),
    ).fetchone()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Compare ISO 8601 strings lexicographically — valid because they are UTC.
    if row["expires_at"] <= now_utc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return {
        "id":           row["id"],
        "username":     row["username"],
        "display_name": row["display_name"],
    }
