"""
backend/app/db.py
sqlite3 connection helper with:
  • WAL journal mode
  • foreign_keys = ON
  • row_factory = sqlite3.Row  (column-name access)
  • FastAPI dependency that yields one connection per request
  • init_db() that runs schema.sql idempotently at startup
  • next_seq() helper that increments the global_seq counter atomically
"""

import sqlite3
from pathlib import Path
from typing import Generator

from app import config

# Path to the SQL schema file, relative to this module.
_SCHEMA_PATH: Path = Path(__file__).parent / "schema.sql"


def _make_connection(path: Path | None = None) -> sqlite3.Connection:
    """
    Open a SQLite connection with the settings required by FieldSync.
    The caller is responsible for closing it.
    """
    target = path if path is not None else config.DB_PATH
    conn = sqlite3.connect(str(target), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL mode — better read/write concurrency under FastAPI's threading model.
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    # Enforce FK constraints on every connection.
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(path: Path | None = None) -> None:
    """
    Run schema.sql against the database.  Uses IF NOT EXISTS throughout,
    so it is safe to call on every application startup.
    """
    sql = _SCHEMA_PATH.read_text(encoding="utf-8")
    conn = _make_connection(path)
    try:
        # executescript commits any open transaction before running.
        conn.executescript(sql)
        # Idempotent column migration for pre-existing databases.
        track_cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(tracks);").fetchall()
        }
        if "fv" not in track_cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN fv TEXT NOT NULL DEFAULT '{}';")
        # Phase 5 migration: field_authors column for edit attribution
        record_cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(records);").fetchall()
        }
        if "field_authors" not in record_cols:
            conn.execute("ALTER TABLE records ADD COLUMN field_authors TEXT;")
        conn.commit()
    finally:
        conn.close()


def next_seq(conn: sqlite3.Connection) -> int:
    """
    Atomically increment the global monotonic sequence counter and return
    the new value.  Must be called inside an open transaction; the caller
    is responsible for the surrounding BEGIN / COMMIT.

    Usage:
        seq = next_seq(conn)
        conn.execute("INSERT INTO records (…, server_seq) VALUES (…, ?)", (…, seq))
        conn.commit()
    """
    conn.execute("UPDATE global_seq SET next_val = next_val + 1 WHERE id = 1;")
    row = conn.execute("SELECT next_val FROM global_seq WHERE id = 1;").fetchone()
    return row["next_val"]


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def get_db() -> Generator[sqlite3.Connection, None, None]:
    """
    FastAPI dependency.  Yields one sqlite3 connection per request and
    closes it on teardown — whether the request succeeded or raised.

    Usage in a router:
        from app.db import get_db
        @router.get("/…")
        def handler(db: sqlite3.Connection = Depends(get_db)):
            …
    """
    conn = _make_connection()
    try:
        yield conn
    finally:
        conn.close()
