"""
backend/tests/test_sync.py
Tests for FieldSync sync backend:
  • HLC parse/compare/clock-skew safety
  • Two-device offline edits on different fields -> both survive (both arrival orders)
  • Two-device offline edits on the same field -> greater HLC wins (both orders)
  • Delete on A + older edit on B -> stays deleted; newer edit on B -> revived
  • Duplicate push of same change_id -> idempotent no-op
  • Non-member push -> rejected
  • Clock skew >24h ahead -> rejected with reason='clock_skew'; past times accepted
  • Pull with `since` cursor + paging (`limit=2`)
  • Media PUT idempotency, 10 MB size limit (413), thumb upload/get, membership check
  • Track metadata merge, track points idempotency, server_seq bump, GET from_idx
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def sync_env(tmp_path_factory):
    tmp_root = tmp_path_factory.mktemp("sync_tests")
    db_path = tmp_root / "sync_test.db"
    media_dir = tmp_root / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    init_db(db_path)
    conn = _make_connection(db_path)

    user_ids: dict[str, str] = {}
    for username, display_name in [
        ("researcher1", "Researcher One"),
        ("researcher2", "Researcher Two"),
        ("outsider", "Outsider User"),
    ]:
        uid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (uid, username, display_name, hash_password("field123")),
        )
        user_ids[username] = uid

    proj_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
        (proj_id, "Indus Delta Survey", "Sindh"),
    )

    for u in ("researcher1", "researcher2"):
        conn.execute(
            "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
            (proj_id, user_ids[u]),
        )

    conn.commit()
    conn.close()

    orig_db = config_module.DB_PATH
    orig_media = config_module.MEDIA_DIR
    config_module.DB_PATH = db_path
    config_module.MEDIA_DIR = media_dir

    with TestClient(app, raise_server_exceptions=True) as client:
        tokens = {}
        for u in ("researcher1", "researcher2", "outsider"):
            resp = client.post("/api/auth/login", json={"username": u, "password": "field123"})
            assert resp.status_code == 200
            tokens[u] = resp.json()["token"]
        yield client, user_ids, proj_id, tokens, media_dir

    config_module.DB_PATH = orig_db
    config_module.MEDIA_DIR = orig_media


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _hlc(offset_ms: int, device_id: str, counter: int = 0) -> str:
    base_ms = int(time.time() * 1000) - 60_000  # 1 minute ago
    return format_hlc(base_ms + offset_ms, counter, device_id)


def _pull_record(client: TestClient, token: str, record_id: str) -> dict:
    resp = client.get("/api/sync/pull?since=0&limit=1000", headers=_headers(token))
    assert resp.status_code == 200
    for item in resp.json()["changes"]:
        if item["entity"] == "record" and item["entity_id"] == record_id:
            return item["state"]
    raise AssertionError(f"Record {record_id} not found in pull")


# ---------------------------------------------------------------------------
# Two-device merge tests
# ---------------------------------------------------------------------------

class TestTwoDeviceMerge:
    def test_different_fields_both_survive_A_then_B(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        rec_id = str(uuid.uuid4())
        base = {
            "type": "soil",
            "created_by": user_ids["researcher1"],
            "created_at": "2026-01-01T10:00:00Z",
        }

        push_a = {
            "device_id": "devA",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "ph": {"v": 6.8, "hlc": _hlc(100, "devA")},
                        "notes": {"v": "From A", "hlc": _hlc(101, "devA")},
                    },
                    "base": base,
                }
            ],
        }
        push_b = {
            "device_id": "devB",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        "moisture_pct": {"v": 24.5, "hlc": _hlc(102, "devB")},
                    },
                    "base": base,
                }
            ],
        }

        r1 = client.post("/api/sync/push", json=push_a, headers=_headers(tokens["researcher1"]))
        r2 = client.post("/api/sync/push", json=push_b, headers=_headers(tokens["researcher2"]))
        assert r1.status_code == 200 and len(r1.json()["applied"]) == 1
        assert r2.status_code == 200 and len(r2.json()["applied"]) == 1

        state = _pull_record(client, tokens["researcher1"], rec_id)
        assert state["data"]["ph"] == 6.8
        assert state["data"]["notes"] == "From A"
        assert state["data"]["moisture_pct"] == 24.5

    def test_different_fields_both_survive_B_then_A(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        rec_id = str(uuid.uuid4())
        base = {
            "type": "water",
            "created_by": user_ids["researcher2"],
            "created_at": "2026-01-01T10:00:00Z",
        }

        push_a = {
            "device_id": "devA",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {"ph": {"v": 7.4, "hlc": _hlc(200, "devA")}},
                    "base": base,
                }
            ],
        }
        push_b = {
            "device_id": "devB",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {"turbidity_ntu": {"v": 12.1, "hlc": _hlc(150, "devB")}},
                    "base": base,
                }
            ],
        }

        assert client.post("/api/sync/push", json=push_b, headers=_headers(tokens["researcher2"])).status_code == 200
        assert client.post("/api/sync/push", json=push_a, headers=_headers(tokens["researcher1"])).status_code == 200

        state = _pull_record(client, tokens["researcher2"], rec_id)
        assert state["data"]["ph"] == 7.4
        assert state["data"]["turbidity_ntu"] == 12.1

    @pytest.mark.parametrize("a_first", [True, False])
    def test_same_field_greater_hlc_wins_regardless_of_order(self, sync_env, a_first):
        client, user_ids, proj_id, tokens, _ = sync_env
        rec_id = str(uuid.uuid4())
        base = {
            "type": "soil",
            "created_by": user_ids["researcher1"],
            "created_at": "2026-01-01T10:00:00Z",
        }

        older_hlc = _hlc(300, "devA")
        newer_hlc = _hlc(500, "devB")

        push_a = {
            "device_id": "devA",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {"ph": {"v": 5.5, "hlc": older_hlc}},
                    "base": base,
                }
            ],
        }
        push_b = {
            "device_id": "devB",
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {"ph": {"v": 8.1, "hlc": newer_hlc}},
                    "base": base,
                }
            ],
        }

        if a_first:
            client.post("/api/sync/push", json=push_a, headers=_headers(tokens["researcher1"]))
            client.post("/api/sync/push", json=push_b, headers=_headers(tokens["researcher2"]))
        else:
            client.post("/api/sync/push", json=push_b, headers=_headers(tokens["researcher2"]))
            client.post("/api/sync/push", json=push_a, headers=_headers(tokens["researcher1"]))

        state = _pull_record(client, tokens["researcher1"], rec_id)
        assert state["data"]["ph"] == 8.1
        assert state["fv"]["ph"] == newer_hlc

    def test_delete_and_revival_semantics(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        rec_id = str(uuid.uuid4())
        base = {
            "type": "wildlife",
            "created_by": user_ids["researcher1"],
            "created_at": "2026-01-01T10:00:00Z",
        }

        # Device A creates and then deletes at t=1000
        t_create = _hlc(900, "devA")
        t_delete = _hlc(1000, "devA")
        t_older_edit = _hlc(950, "devB")
        t_newer_edit = _hlc(1200, "devB")

        client.post(
            "/api/sync/push",
            json={
                "device_id": "devA",
                "changes": [
                    {
                        "change_id": str(uuid.uuid4()),
                        "entity": "record",
                        "entity_id": rec_id,
                        "project_id": proj_id,
                        "fields": {
                            "species": {"v": "Indus Dolphin", "hlc": t_create},
                            "deleted": {"v": True, "hlc": t_delete},
                        },
                        "base": base,
                    }
                ],
            },
            headers=_headers(tokens["researcher1"]),
        )

        # Older edit from B (t=950 <= t_delete=1000) -> stays deleted
        client.post(
            "/api/sync/push",
            json={
                "device_id": "devB",
                "changes": [
                    {
                        "change_id": str(uuid.uuid4()),
                        "entity": "record",
                        "entity_id": rec_id,
                        "project_id": proj_id,
                        "fields": {"count": {"v": 3, "hlc": t_older_edit}},
                        "base": base,
                    }
                ],
            },
            headers=_headers(tokens["researcher2"]),
        )
        state = _pull_record(client, tokens["researcher1"], rec_id)
        assert state["deleted"] is True
        assert state["deleted_hlc"] == t_delete

        # Newer edit from B (t=1200 > t_delete=1000) -> record is revived
        client.post(
            "/api/sync/push",
            json={
                "device_id": "devB",
                "changes": [
                    {
                        "change_id": str(uuid.uuid4()),
                        "entity": "record",
                        "entity_id": rec_id,
                        "project_id": proj_id,
                        "fields": {"count": {"v": 5, "hlc": t_newer_edit}},
                        "base": base,
                    }
                ],
            },
            headers=_headers(tokens["researcher2"]),
        )
        state = _pull_record(client, tokens["researcher1"], rec_id)
        assert state["deleted"] is False
        assert state["deleted_hlc"] is None
        assert state["data"]["count"] == 5


# ---------------------------------------------------------------------------
# Idempotency, membership, clock skew, and pull paging
# ---------------------------------------------------------------------------

class TestPushPullSafety:
    def test_duplicate_push_same_change_id_is_noop(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        rec_id = str(uuid.uuid4())
        change_id = str(uuid.uuid4())
        payload = {
            "device_id": "devA",
            "changes": [
                {
                    "change_id": change_id,
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {"ph": {"v": 7.0, "hlc": _hlc(10, "devA")}},
                    "base": {
                        "type": "soil",
                        "created_by": user_ids["researcher1"],
                        "created_at": "2026-01-01T10:00:00Z",
                    },
                }
            ],
        }

        r1 = client.post("/api/sync/push", json=payload, headers=_headers(tokens["researcher1"]))
        assert r1.status_code == 200
        seq_after_first = r1.json()["server_seq"]
        assert r1.json()["applied"] == [change_id]

        r2 = client.post("/api/sync/push", json=payload, headers=_headers(tokens["researcher1"]))
        assert r2.status_code == 200
        assert r2.json()["applied"] == [change_id]
        assert r2.json()["server_seq"] == seq_after_first

    def test_non_member_push_rejected(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        change_id = str(uuid.uuid4())
        resp = client.post(
            "/api/sync/push",
            json={
                "device_id": "devOutsider",
                "changes": [
                    {
                        "change_id": change_id,
                        "entity": "record",
                        "entity_id": str(uuid.uuid4()),
                        "project_id": proj_id,
                        "fields": {"ph": {"v": 6.0, "hlc": _hlc(20, "devOutsider")}},
                        "base": {
                            "type": "soil",
                            "created_by": user_ids["outsider"],
                            "created_at": "2026-01-01T10:00:00Z",
                        },
                    }
                ],
            },
            headers=_headers(tokens["outsider"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["applied"] == []
        assert body["rejected"] == [{"change_id": change_id, "reason": "not_a_member"}]

    def test_clock_skew_rejected_and_past_time_accepted(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        now_ms = int(time.time() * 1000)
        future_hlc = format_hlc(now_ms + 25 * 3600 * 1000, 0, "devSkew")
        past_hlc = format_hlc(now_ms - 10 * 24 * 3600 * 1000, 0, "devOld")

        skew_cid = str(uuid.uuid4())
        past_cid = str(uuid.uuid4())
        resp = client.post(
            "/api/sync/push",
            json={
                "device_id": "devA",
                "changes": [
                    {
                        "change_id": skew_cid,
                        "entity": "record",
                        "entity_id": str(uuid.uuid4()),
                        "project_id": proj_id,
                        "fields": {"ph": {"v": 7.0, "hlc": future_hlc}},
                        "base": {
                            "type": "soil",
                            "created_by": user_ids["researcher1"],
                            "created_at": "2026-01-01T10:00:00Z",
                        },
                    },
                    {
                        "change_id": past_cid,
                        "entity": "record",
                        "entity_id": str(uuid.uuid4()),
                        "project_id": proj_id,
                        "fields": {"ph": {"v": 6.5, "hlc": past_hlc}},
                        "base": {
                            "type": "soil",
                            "created_by": user_ids["researcher1"],
                            "created_at": "2026-01-01T10:00:00Z",
                        },
                    },
                ],
            },
            headers=_headers(tokens["researcher1"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["applied"] == [past_cid]
        assert body["rejected"] == [{"change_id": skew_cid, "reason": "clock_skew"}]

    def test_pull_since_cursor_and_paging(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env

        # Capture current cursor
        head = client.get("/api/sync/pull?since=0&limit=1000", headers=_headers(tokens["researcher1"])).json()
        start_seq = head["next_seq"]

        # Push 3 new records
        created_ids = []
        for i in range(3):
            rec_id = str(uuid.uuid4())
            created_ids.append(rec_id)
            resp = client.post(
                "/api/sync/push",
                json={
                    "device_id": "devA",
                    "changes": [
                        {
                            "change_id": str(uuid.uuid4()),
                            "entity": "record",
                            "entity_id": rec_id,
                            "project_id": proj_id,
                            "fields": {"notes": {"v": f"rec-{i}", "hlc": _hlc(1000 + i, "devA")}},
                            "base": {
                                "type": "soil",
                                "created_by": user_ids["researcher1"],
                                "created_at": "2026-01-01T10:00:00Z",
                            },
                        }
                    ],
                },
                headers=_headers(tokens["researcher1"]),
            )
            assert resp.status_code == 200

        page1 = client.get(
            f"/api/sync/pull?since={start_seq}&limit=2",
            headers=_headers(tokens["researcher2"]),
        ).json()
        assert len(page1["changes"]) == 2
        assert page1["has_more"] is True

        page2 = client.get(
            f"/api/sync/pull?since={page1['next_seq']}&limit=2",
            headers=_headers(tokens["researcher2"]),
        ).json()
        assert len(page2["changes"]) == 1
        assert page2["has_more"] is False

        pulled_ids = [c["entity_id"] for c in page1["changes"] + page2["changes"]]
        assert pulled_ids == created_ids


# ---------------------------------------------------------------------------
# Media & Track Points
# ---------------------------------------------------------------------------

class TestMediaAndTracks:
    def test_media_put_idempotent_and_size_limit(self, sync_env):
        client, user_ids, proj_id, tokens, media_dir = sync_env

        # Create parent record first
        rec_id = str(uuid.uuid4())
        client.post(
            "/api/sync/push",
            json={
                "device_id": "devA",
                "changes": [
                    {
                        "change_id": str(uuid.uuid4()),
                        "entity": "record",
                        "entity_id": rec_id,
                        "project_id": proj_id,
                        "fields": {"notes": {"v": "photo rec", "hlc": _hlc(2000, "devA")}},
                        "base": {
                            "type": "wildlife",
                            "created_by": user_ids["researcher1"],
                            "created_at": "2026-01-01T10:00:00Z",
                        },
                    }
                ],
            },
            headers=_headers(tokens["researcher1"]),
        )

        media_id = str(uuid.uuid4())
        img_bytes = b"\xff\xd8\xff\xe0FAKE_JPEG_DATA"
        put_headers = {
            **_headers(tokens["researcher1"]),
            "X-Record-Id": rec_id,
            "X-Project-Id": proj_id,
            "X-Mime": "image/jpeg",
            "X-Width": "640",
            "X-Height": "480",
        }

        r1 = client.put(f"/api/media/{media_id}", content=img_bytes, headers=put_headers)
        assert r1.status_code == 200
        seq1 = r1.json()["server_seq"]
        assert (media_dir / proj_id / media_id).read_bytes() == img_bytes

        # Idempotent re-PUT with different bytes should return 200 without rewriting or bumping seq
        r2 = client.put(f"/api/media/{media_id}", content=b"DIFFERENT", headers=put_headers)
        assert r2.status_code == 200
        assert r2.json()["server_seq"] == seq1
        assert (media_dir / proj_id / media_id).read_bytes() == img_bytes

        # Thumbnail upload & GET
        thumb_bytes = b"\xff\xd8\xff\xe0THUMB"
        rt = client.put(
            f"/api/media/{media_id}/thumb",
            content=thumb_bytes,
            headers=_headers(tokens["researcher1"]),
        )
        assert rt.status_code == 200

        g_full = client.get(f"/api/media/{media_id}", headers=_headers(tokens["researcher2"]))
        assert g_full.status_code == 200
        assert g_full.content == img_bytes

        g_thumb = client.get(f"/api/media/{media_id}/thumb", headers=_headers(tokens["researcher2"]))
        assert g_thumb.status_code == 200
        assert g_thumb.content == thumb_bytes

        # Non-member cannot GET media
        g_out = client.get(f"/api/media/{media_id}", headers=_headers(tokens["outsider"]))
        assert g_out.status_code == 403

        # >10 MB upload rejected with 413
        oversize_id = str(uuid.uuid4())
        oversize_bytes = b"x" * (10 * 1024 * 1024 + 1)
        r_big = client.put(f"/api/media/{oversize_id}", content=oversize_bytes, headers=put_headers)
        assert r_big.status_code == 413
        assert not (media_dir / proj_id / oversize_id).exists()

    def test_track_points_idempotent_and_get_from_idx(self, sync_env):
        client, user_ids, proj_id, tokens, _ = sync_env
        track_id = str(uuid.uuid4())

        # Push track metadata first
        push_resp = client.post(
            "/api/sync/push",
            json={
                "device_id": "devA",
                "changes": [
                    {
                        "change_id": str(uuid.uuid4()),
                        "entity": "track",
                        "entity_id": track_id,
                        "project_id": proj_id,
                        "fields": {
                            "name": {"v": "Transect 1", "hlc": _hlc(3000, "devA")},
                            "status": {"v": "recording", "hlc": _hlc(3001, "devA")},
                            "started_at": {"v": "2026-01-01T10:00:00Z", "hlc": _hlc(3002, "devA")},
                        },
                        "base": {
                            "created_by": user_ids["researcher1"],
                            "created_at": "2026-01-01T10:00:00Z",
                        },
                    }
                ],
            },
            headers=_headers(tokens["researcher1"]),
        )
        assert push_resp.status_code == 200

        pts = [
            {"idx": 0, "lat": 24.8, "lng": 67.0, "accuracy": 5.0, "altitude": 10.0, "ts": "2026-01-01T10:00:01Z"},
            {"idx": 1, "lat": 24.81, "lng": 67.01, "accuracy": 4.5, "altitude": 11.0, "ts": "2026-01-01T10:00:02Z"},
        ]

        r1 = client.post(
            f"/api/tracks/{track_id}/points",
            json={"points": pts},
            headers=_headers(tokens["researcher1"]),
        )
        assert r1.status_code == 200
        assert r1.json()["inserted"] == 2
        seq1 = r1.json()["server_seq"]

        # Duplicate batch -> 0 inserted, server_seq unchanged
        r2 = client.post(
            f"/api/tracks/{track_id}/points",
            json={"points": pts},
            headers=_headers(tokens["researcher1"]),
        )
        assert r2.status_code == 200
        assert r2.json()["inserted"] == 0
        assert r2.json()["server_seq"] == seq1

        # GET points from_idx=1
        g = client.get(
            f"/api/tracks/{track_id}/points?from_idx=1",
            headers=_headers(tokens["researcher2"]),
        )
        assert g.status_code == 200
        assert len(g.json()["points"]) == 1
        assert g.json()["points"][0]["idx"] == 1

