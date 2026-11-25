"""
backend/tests/test_multiuser.py
Multi-user end-to-end sync tests:
  • A and B offline, both edit the same soil record (different fields + one same field)
  • Both reconnect (push + pull) -> identical final state + field_authors attribution
  • Loser overrides via "Use mine" (newer HLC) -> both converge with new author
  • Soft-delete & restore across two users
"""

from pathlib import Path
import sys
import time
import uuid

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password
import app.config as config_module
from app.db import _make_connection, init_db
from app.hlc import format_hlc
from app.main import app


@pytest.fixture(scope="module")
def multiuser_env(tmp_path_factory):
    tmp_root = tmp_path_factory.mktemp("multiuser_tests")
    db_path = tmp_root / "multiuser_test.db"
    media_dir = tmp_root / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    init_db(db_path)
    conn = _make_connection(db_path)

    users = {}
    for username, display_name in [
        ("alice", "Alice Field"),
        ("bob", "Bob Survey"),
    ]:
        uid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (uid, username, display_name, hash_password("field123")),
        )
        users[username] = {"id": uid, "display_name": display_name}

    proj_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
        (proj_id, "Mangrove Transect", "Delta"),
    )
    for u in users.values():
        conn.execute(
            "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
            (proj_id, u["id"]),
        )

    conn.commit()
    conn.close()

    orig_db = config_module.DB_PATH
    orig_media = config_module.MEDIA_DIR
    config_module.DB_PATH = db_path
    config_module.MEDIA_DIR = media_dir

    with TestClient(app, raise_server_exceptions=True) as client:
        tokens = {}
        for username in ("alice", "bob"):
            resp = client.post(
                "/api/auth/login",
                json={"username": username, "password": "field123"},
            )
            assert resp.status_code == 200
            tokens[username] = resp.json()["token"]
        yield client, users, proj_id, tokens

    config_module.DB_PATH = orig_db
    config_module.MEDIA_DIR = orig_media


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _hlc(offset_ms: int, device_id: str, counter: int = 0) -> str:
    base_ms = int(time.time() * 1000) - 120_000
    return format_hlc(base_ms + offset_ms, counter, device_id)


def _pull_record(client: TestClient, token: str, record_id: str) -> dict:
    resp = client.get("/api/sync/pull?since=0&limit=1000", headers=_headers(token))
    assert resp.status_code == 200
    for item in resp.json()["changes"]:
        if item["entity"] == "record" and item["entity_id"] == record_id:
            return item["state"]
    raise AssertionError(f"Record {record_id} not found in pull")


def test_two_device_soil_conflict_and_field_authors(multiuser_env):
    client, users, proj_id, tokens = multiuser_env
    rec_id = str(uuid.uuid4())
    base = {
        "type": "soil",
        "created_by": users["alice"]["id"],
        "created_at": "2026-02-01T08:00:00Z",
    }

    # Initial creation synced so both A and B start with the same soil record
    t0 = _hlc(100, "devAlice")
    r0 = client.post(
        "/api/sync/push",
        json={
            "device_id": "devAlice",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "site_name": {"v": "Plot S-1", "hlc": t0},
                        "ph": {"v": 6.5, "hlc": _hlc(101, "devAlice")},
                        "notes": {"v": "Initial", "hlc": _hlc(102, "devAlice")},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["alice"]),
    )
    assert r0.status_code == 200
    assert len(r0.json()["applied"]) == 1

    # Both go offline.
    # Alice edits ph (6.9) and notes ("Alice dry soil") at t=200..201
    # Bob edits moisture_pct (42.0) and notes ("Bob wet sample") at t=300..301 (Bob's notes HLC > Alice's)
    alice_ph_hlc = _hlc(200, "devAlice")
    alice_notes_hlc = _hlc(201, "devAlice")
    bob_moisture_hlc = _hlc(300, "devBob")
    bob_notes_hlc = _hlc(301, "devBob")

    push_alice = client.post(
        "/api/sync/push",
        json={
            "device_id": "devAlice",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "ph": {"v": 6.9, "hlc": alice_ph_hlc},
                        "notes": {"v": "Alice dry soil", "hlc": alice_notes_hlc},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["alice"]),
    )
    assert push_alice.status_code == 200
    assert len(push_alice.json()["applied"]) == 1

    push_bob = client.post(
        "/api/sync/push",
        json={
            "device_id": "devBob",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "moisture_pct": {"v": 42.0, "hlc": bob_moisture_hlc},
                        "notes": {"v": "Bob wet sample", "hlc": bob_notes_hlc},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["bob"]),
    )
    assert push_bob.status_code == 200
    assert len(push_bob.json()["applied"]) == 1

    # Both pull -> identical final state
    state_a = _pull_record(client, tokens["alice"], rec_id)
    state_b = _pull_record(client, tokens["bob"], rec_id)
    assert state_a["data"] == state_b["data"]
    assert state_a["fv"] == state_b["fv"]
    assert state_a["field_authors"] == state_b["field_authors"]

    # Non-conflicting fields from both survived; same-field conflict resolved to Bob
    assert state_a["data"]["site_name"] == "Plot S-1"
    assert state_a["data"]["ph"] == 6.9
    assert state_a["data"]["moisture_pct"] == 42.0
    assert state_a["data"]["notes"] == "Bob wet sample"

    # Per-field attribution in field_authors
    fa = state_a["field_authors"]
    assert fa["ph"]["user_id"] == users["alice"]["id"]
    assert fa["ph"]["display_name"] == "Alice Field"
    assert fa["ph"]["hlc"] == alice_ph_hlc

    assert fa["moisture_pct"]["user_id"] == users["bob"]["id"]
    assert fa["moisture_pct"]["display_name"] == "Bob Survey"
    assert fa["moisture_pct"]["hlc"] == bob_moisture_hlc

    assert fa["notes"]["user_id"] == users["bob"]["id"]
    assert fa["notes"]["display_name"] == "Bob Survey"
    assert fa["notes"]["hlc"] == bob_notes_hlc

    # Alice (the loser on 'notes') chooses "Use mine" -> creates a NEW newer HLC
    alice_override_hlc = _hlc(500, "devAlice")
    override_resp = client.post(
        "/api/sync/push",
        json={
            "device_id": "devAlice",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "notes": {"v": "Alice dry soil", "hlc": alice_override_hlc},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["alice"]),
    )
    assert override_resp.status_code == 200
    final_b = _pull_record(client, tokens["bob"], rec_id)
    assert final_b["data"]["notes"] == "Alice dry soil"
    assert final_b["field_authors"]["notes"]["user_id"] == users["alice"]["id"]
    assert final_b["field_authors"]["notes"]["hlc"] == alice_override_hlc


def test_soft_delete_and_restore_multiuser(multiuser_env):
    client, users, proj_id, tokens = multiuser_env
    rec_id = str(uuid.uuid4())
    base = {
        "type": "soil",
        "created_by": users["alice"]["id"],
        "created_at": "2026-02-01T09:00:00Z",
    }

    # Alice creates & soft-deletes
    client.post(
        "/api/sync/push",
        json={
            "device_id": "devAlice",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "site_name": {"v": "Plot D-1", "hlc": _hlc(600, "devAlice")},
                        "deleted": {"v": True, "hlc": _hlc(610, "devAlice")},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["alice"]),
    )
    s1 = _pull_record(client, tokens["bob"], rec_id)
    assert s1["deleted"] is True

    # Bob restores the record with a newer HLC
    restore_hlc = _hlc(650, "devBob")
    client.post(
        "/api/sync/push",
        json={
            "device_id": "devBob",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "deleted": {"v": False, "hlc": restore_hlc},
                    },
                    "base": base,
                }
            ],
        },
        headers=_headers(tokens["bob"]),
    )
    s2 = _pull_record(client, tokens["alice"], rec_id)
    assert s2["deleted"] is False
    assert s2["field_authors"]["deleted"]["user_id"] == users["bob"]["id"]

