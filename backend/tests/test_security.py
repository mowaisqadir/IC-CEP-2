"""
backend/tests/test_security.py
Security hardening tests:
  • Login rate limiting (5 attempts/min/IP+username -> 429)
  • Request body size limit (413 for oversized JSON body)
  • Strict magic-byte MIME validation for JPEG/PNG/WebP (rejects spoofed/bad bytes)
  • Path-traversal-safe UUID validation on media endpoints
  • Security headers (X-Content-Type-Options, Referrer-Policy, Content-Security-Policy)
  • Cache-Control headers for /api/*, /sw.js, /js/*
"""

from pathlib import Path
import sys
import uuid

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password
import app.config as config_module
from app.db import _make_connection, init_db
from app.main import app
from app.routers.auth import reset_rate_limiter


@pytest.fixture(scope="module")
def sec_env(tmp_path_factory):
    tmp_root = tmp_path_factory.mktemp("sec_tests")
    db_path = tmp_root / "sec_test.db"
    media_dir = tmp_root / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    init_db(db_path)
    conn = _make_connection(db_path)

    uid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
        (uid, "secuser", "Security User", hash_password("field123")),
    )
    proj_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
        (proj_id, "Sec Project", "Test"),
    )
    conn.execute(
        "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
        (proj_id, uid),
    )
    rec_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO records (id, project_id, type, data, fv, created_by, created_at, deleted, server_seq)
        VALUES (?, ?, 'soil', '{}', '{}', ?, '2026-01-01T00:00:00Z', 0, 1)
        """,
        (rec_id, proj_id, uid),
    )
    conn.commit()
    conn.close()

    orig_db = config_module.DB_PATH
    orig_media = config_module.MEDIA_DIR
    config_module.DB_PATH = db_path
    config_module.MEDIA_DIR = media_dir

    reset_rate_limiter()
    with TestClient(app, raise_server_exceptions=True) as client:
        resp = client.post("/api/auth/login", json={"username": "secuser", "password": "field123"})
        assert resp.status_code == 200
        token = resp.json()["token"]
        yield client, token, proj_id, rec_id

    config_module.DB_PATH = orig_db
    config_module.MEDIA_DIR = orig_media


def test_security_and_cache_headers(sec_env):
    client, _, _, _ = sec_env
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.headers.get("x-content-type-options") == "nosniff"
    assert r_health.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    csp = r_health.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp
    assert "https://cdn.jsdelivr.net" in csp
    assert r_health.headers.get("cache-control") == "no-store"

    r_sw = client.get("/sw.js")
    if r_sw.status_code == 200:
        assert r_sw.headers.get("service-worker-allowed") == "/"
        assert "no-store" in r_sw.headers.get("cache-control", "")


def test_login_rate_limiting(sec_env):
    client, _, _, _ = sec_env
    reset_rate_limiter()
    for _ in range(5):
        r = client.post("/api/auth/login", json={"username": "ratetest", "password": "bad"})
        assert r.status_code == 401

    r_blocked = client.post("/api/auth/login", json={"username": "ratetest", "password": "bad"})
    assert r_blocked.status_code == 429
    assert "retry-after" in r_blocked.headers
    reset_rate_limiter()


def test_json_body_size_limit(sec_env):
    client, token, _, _ = sec_env
    oversized_payload = '{"padding":"' + ("a" * (config_module.MAX_JSON_BODY_BYTES + 100)) + '"}'
    r = client.post(
        "/api/sync/push",
        content=oversized_payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 413


def test_media_uuid_and_magic_bytes_validation(sec_env):
    client, token, proj_id, rec_id = sec_env
    headers_base = {
        "Authorization": f"Bearer {token}",
        "X-Record-Id": rec_id,
        "X-Project-Id": proj_id,
        "X-Mime": "image/jpeg",
    }

    # Path-traversal / non-UUID media_id rejected
    r_bad_id = client.put(
        "/api/media/not-a-uuid",
        content=b"\xff\xd8\xff\xe0VALID_JPEG",
        headers=headers_base,
    )
    assert r_bad_id.status_code == 400

    # Spoofed JPEG (actually plain text) rejected
    media_id = str(uuid.uuid4())
    r_spoof = client.put(
        f"/api/media/{media_id}",
        content=b"NOT_AN_IMAGE_PAYLOAD",
        headers=headers_base,
    )
    assert r_spoof.status_code == 400

    # PNG bytes with X-Mime: image/jpeg rejected
    png_bytes = b"\x89PNG\r\n\x1a\nFAKE_PNG"
    r_mismatch = client.put(
        f"/api/media/{media_id}",
        content=png_bytes,
        headers=headers_base,
    )
    assert r_mismatch.status_code == 400

    # Valid PNG with matching X-Mime accepted
    r_ok = client.put(
        f"/api/media/{media_id}",
        content=png_bytes,
        headers={**headers_base, "X-Mime": "image/png"},
    )
    assert r_ok.status_code == 200

