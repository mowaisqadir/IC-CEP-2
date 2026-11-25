"""
backend/tests/conftest.py
Shared pytest fixtures for FieldSync backend tests.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Make `app/` importable from the backend/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password
from app.config import DB_PATH
from app.db import init_db, _make_connection
from app.main import app

import uuid
import tempfile
import os


@pytest.fixture(scope="session")
def tmp_db(tmp_path_factory):
    """
    Create a temporary SQLite database, seed it with test data, and return
    the path.  Session-scoped so the DB is shared across all tests in a run,
    giving us fast execution without repeated schema creation.
    """
    db_path = tmp_path_factory.mktemp("db") / "test_fieldsync.db"
    init_db(db_path)

    conn = _make_connection(db_path)

    # Create test users
    users = [
        ("researcher1", "Researcher One"),
        ("researcher2", "Researcher Two"),
        ("researcher3", "Researcher Three"),
    ]
    user_ids = {}
    for username, display_name in users:
        uid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (uid, username, display_name, hash_password("field123")),
        )
        user_ids[username] = uid

    # Create test projects
    proj_ids = []
    for name, region in [
        ("Indus Delta Survey", "Sindh, Pakistan"),
        ("Thar Wetlands",      "Tharparkar, Pakistan"),
    ]:
        pid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
            (pid, name, region),
        )
        proj_ids.append(pid)

    # researcher1 and researcher2 are in BOTH projects
    # researcher3 is NOT in any project — used to test membership filtering
    for pid in proj_ids:
        for username in ("researcher1", "researcher2"):
            conn.execute(
                "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
                (pid, user_ids[username]),
            )

    conn.commit()
    conn.close()

    return db_path, user_ids, proj_ids


@pytest.fixture(scope="session")
def client(tmp_db, monkeypatch_session):
    """
    TestClient wired to a temporary database.  We override DB_PATH at the
    module level before the app processes any request.
    """
    db_path, user_ids, proj_ids = tmp_db

    # Patch the DB_PATH used by db.get_db so every request uses the test DB.
    import app.db as db_module
    import app.config as config_module

    original_db_path = db_module.DB_PATH
    original_config_path = config_module.DB_PATH

    db_module.DB_PATH = db_path
    config_module.DB_PATH = db_path

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c, user_ids, proj_ids

    db_module.DB_PATH = original_db_path
    config_module.DB_PATH = original_config_path


@pytest.fixture(scope="session")
def monkeypatch_session():
    """Session-scoped monkeypatch shim (pytest's built-in is function-scoped)."""
    # We handle patching manually in the client fixture above.
    yield

