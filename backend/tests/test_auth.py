"""
backend/tests/test_auth.py
Tests for:
  • POST /api/auth/login  — success, wrong password, unknown user
  • GET  /api/auth/me     — with valid token, with no token, with bad token
  • GET  /api/projects    — membership filtering (member sees projects, non-member sees none)
"""

from datetime import datetime, timedelta, timezone
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure app/ is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import generate_token, hash_password
from app.db import init_db, _make_connection
from app.main import app
import app.config as config_module


# ---------------------------------------------------------------------------
# Session-scoped test database (avoid re-creating DB for every test)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def test_db(tmp_path_factory):
    """Stand-alone DB fixture (module scope) so this file is self-contained."""
    db_path = tmp_path_factory.mktemp("auth_tests") / "auth_test.db"
    init_db(db_path)

    conn = _make_connection(db_path)

    user_ids: dict[str, str] = {}
    for username, display_name in [
        ("researcher1", "Researcher One"),
        ("researcher2", "Researcher Two"),
        ("researcher3", "Researcher Three"),
    ]:
        uid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (uid, username, display_name, hash_password("field123")),
        )
        user_ids[username] = uid

    proj_ids: list[str] = []
    for name, region in [
        ("Indus Delta Survey", "Sindh"),
        ("Thar Wetlands",      "Tharparkar"),
    ]:
        pid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
            (pid, name, region),
        )
        proj_ids.append(pid)

    # researcher1 + researcher2 are members; researcher3 is NOT a member of any project.
    for pid in proj_ids:
        for u in ("researcher1", "researcher2"):
            conn.execute(
                "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
                (pid, user_ids[u]),
            )

    conn.commit()
    conn.close()

    return db_path, user_ids, proj_ids


@pytest.fixture(scope="module")
def api(test_db):
    """TestClient backed by the test database."""
    db_path, user_ids, proj_ids = test_db

    # Redirect all db.get_db() calls to the test database.
    original = config_module.DB_PATH
    config_module.DB_PATH = db_path

    with TestClient(app, raise_server_exceptions=True) as client:
        yield client, user_ids, proj_ids

    config_module.DB_PATH = original


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def login(client: TestClient, username: str, password: str = "field123"):
    return client.post("/api/auth/login", json={"username": username, "password": password})


# ===========================================================================
# Tests — login
# ===========================================================================

class TestLogin:
    def test_login_success(self, api):
        client, user_ids, _ = api
        resp = login(client, "researcher1")
        assert resp.status_code == 200
        body = resp.json()
        assert "token" in body
        assert body["user"]["username"] == "researcher1"
        assert body["user"]["display_name"] == "Researcher One"
        assert "password_hash" not in body["user"]

    def test_login_wrong_password(self, api):
        client, _, _ = api
        resp = login(client, "researcher1", password="wrongpass")
        assert resp.status_code == 401

    def test_login_unknown_user(self, api):
        client, _, _ = api
        resp = login(client, "ghost_user")
        assert resp.status_code == 401

    def test_login_returns_token_string(self, api):
        client, _, _ = api
        resp = login(client, "researcher2")
        assert isinstance(resp.json()["token"], str)
        assert len(resp.json()["token"]) > 20  # sanity-check token is non-trivial


# ===========================================================================
# Tests — /me
# ===========================================================================

class TestMe:
    def test_me_with_valid_token(self, api):
        client, _, _ = api
        token = login(client, "researcher1").json()["token"]
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["user"]["username"] == "researcher1"

    def test_me_without_token(self, api):
        client, _, _ = api
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401

    def test_me_with_invalid_token(self, api):
        client, _, _ = api
        resp = client.get("/api/auth/me", headers={"Authorization": "Bearer invalid_token_xyz"})
        assert resp.status_code == 401

    def test_me_with_expired_token(self, api, test_db):
        client, user_ids, _ = api
        db_path, _, _ = test_db
        expired_token = generate_token()
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        conn = _make_connection(db_path)
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (expired_token, user_ids["researcher1"], past, past),
        )
        conn.commit()
        conn.close()

        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
        assert resp.status_code == 401

    def test_me_user_fields(self, api):
        client, _, _ = api
        token = login(client, "researcher2").json()["token"]
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        user = resp.json()["user"]
        assert "id" in user
        assert "username" in user
        assert "display_name" in user
        assert "password_hash" not in user


# ===========================================================================
# Tests — /projects (membership filtering)
# ===========================================================================

class TestProjects:
    def _auth_header(self, client, username):
        token = login(client, username).json()["token"]
        return {"Authorization": f"Bearer {token}"}

    def test_member_sees_both_projects(self, api):
        client, _, proj_ids = api
        resp = client.get("/api/projects", headers=self._auth_header(client, "researcher1"))
        assert resp.status_code == 200
        projects = resp.json()["projects"]
        returned_ids = {p["id"] for p in projects}
        assert set(proj_ids) == returned_ids

    def test_member_project_fields(self, api):
        client, _, _ = api
        resp = client.get("/api/projects", headers=self._auth_header(client, "researcher1"))
        project = resp.json()["projects"][0]
        for field in ("id", "name", "region", "description"):
            assert field in project

    def test_non_member_sees_no_projects(self, api):
        """researcher3 has no memberships — should get an empty list, not an error."""
        client, _, _ = api
        resp = client.get("/api/projects", headers=self._auth_header(client, "researcher3"))
        assert resp.status_code == 200
        assert resp.json()["projects"] == []

    def test_projects_requires_auth(self, api):
        client, _, _ = api
        resp = client.get("/api/projects")
        assert resp.status_code == 401

    def test_projects_rejects_bad_token(self, api):
        client, _, _ = api
        resp = client.get("/api/projects", headers={"Authorization": "Bearer bad_token"})
        assert resp.status_code == 401

    def test_researcher2_sees_same_projects(self, api):
        client, _, proj_ids = api
        resp = client.get("/api/projects", headers=self._auth_header(client, "researcher2"))
        returned_ids = {p["id"] for p in resp.json()["projects"]}
        assert set(proj_ids) == returned_ids

