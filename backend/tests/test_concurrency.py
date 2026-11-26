"""
backend/tests/test_concurrency.py
Concurrency and reliability tests:
  • Parallel pushes to the same record via ThreadPoolExecutor converge cleanly
    with zero SQLite lock errors and deterministic HLC LWW winners.
  • Online SQLite backup (backend/backup.py) produces a valid DB copy and
    enforces the 7-copy retention limit.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import sqlite3
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
from backup import run_backup


@pytest.fixture(scope="module")
def conc_env(tmp_path_factory):
    tmp_root = tmp_path_factory.mktemp("conc_tests")
    db_path = tmp_root / "conc_test.db"
    media_dir = tmp_root / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    init_db(db_path)
    conn = _make_connection(db_path)

    user_ids: dict[str, str] = {}
    for username in ("user_a", "user_b"):
        uid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (uid, username, username.upper(), hash_password("field123")),
        )
        user_ids[username] = uid

    proj_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, '')",
        (proj_id, "Concurrency Project", "Delta"),
    )
    for uid in user_ids.values():
        conn.execute(
            "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
            (proj_id, uid),
        )
    conn.commit()
    conn.close()

    orig_db = config_module.DB_PATH
    orig_media = config_module.MEDIA_DIR
    config_module.DB_PATH = db_path
    config_module.MEDIA_DIR = media_dir

    with TestClient(app, raise_server_exceptions=True) as client:
        tokens = {}
        for username in ("user_a", "user_b"):
            resp = client.post(
                "/api/auth/login",
                json={"username": username, "password": "field123"},
            )
            assert resp.status_code == 200
            tokens[username] = resp.json()["token"]
        yield client, user_ids, proj_id, tokens, db_path, tmp_root

    config_module.DB_PATH = orig_db
    config_module.MEDIA_DIR = orig_media


def test_parallel_pushes_to_same_record_converge(conc_env):
    client, user_ids, proj_id, tokens, _, _ = conc_env
    rec_id = str(uuid.uuid4())
    base_ms = int(time.time() * 1000) - 60_000

    base = {
        "type": "soil",
        "created_by": user_ids["user_a"],
        "created_at": "2026-03-01T10:00:00Z",
    }

    # 10 concurrent worker pushes to the exact same record_id:
    # - Each thread writes its own unique field `slot_<i>`
    # - Every thread also writes the shared `notes` field with a distinct HLC;
    #   thread 9 has the highest HLC and must win deterministically.
    n_threads = 10

    def push_worker(idx: int):
        user_key = "user_a" if idx % 2 == 0 else "user_b"
        dev_id = f"dev_{idx:02d}"
        slot_hlc = format_hlc(base_ms + idx * 10, 0, dev_id)
        notes_hlc = format_hlc(base_ms + 1000 + idx * 10, 0, dev_id)
        payload = {
            "device_id": dev_id,
            "changes": [
                {
                    "change_id": str(uuid.uuid4()),
                    "entity": "record",
                    "entity_id": rec_id,
                    "project_id": proj_id,
                    "fields": {
                        f"slot_{idx}": {"v": idx, "hlc": slot_hlc},
                        "notes": {"v": f"note-from-{idx}", "hlc": notes_hlc},
                    },
                    "base": base,
                }
            ],
        }
        resp = client.post(
            "/api/sync/push",
            json=payload,
            headers={"Authorization": f"Bearer {tokens[user_key]}"},
        )
        return resp.status_code, resp.json()

    results = []
    with ThreadPoolExecutor(max_workers=n_threads) as pool:
        futures = [pool.submit(push_worker, i) for i in range(n_threads)]
        for fut in as_completed(futures):
            results.append(fut.result())

    for status_code, body in results:
        assert status_code == 200
        assert len(body["applied"]) == 1
        assert body["rejected"] == []

    # Pull and verify all 10 disjoint fields survived and highest-HLC notes won
    pull_resp = client.get(
        "/api/sync/pull?since=0&limit=1000",
        headers={"Authorization": f"Bearer {tokens['user_a']}"},
    )
    assert pull_resp.status_code == 200
    matches = [
        c["state"]
        for c in pull_resp.json()["changes"]
        if c["entity"] == "record" and c["entity_id"] == rec_id
    ]
    assert len(matches) == 1
    state = matches[0]
    for i in range(n_threads):
        assert state["data"][f"slot_{i}"] == i
    assert state["data"]["notes"] == f"note-from-{n_threads - 1}"


def test_sqlite_online_backup_and_retention(conc_env):
    _, _, _, _, db_path, tmp_root = conc_env
    backup_dir = tmp_root / "backups"

    created: list[Path] = []
    for i in range(9):
        # Create pre-existing stamped files or run backup with distinct mtimes
        out = run_backup(db_path, backup_dir, keep=7)
        # Rename to avoid same-second collision in fast test loop
        unique = backup_dir / f"fieldsync-20260101-00000{i}.db"
        out.replace(unique)
        created.append(unique)

    # Run one more backup to trigger pruning down to 7
    latest = run_backup(db_path, backup_dir, keep=7)
    remaining = sorted(backup_dir.glob("fieldsync-*.db"))
    assert len(remaining) == 7
    assert latest.exists()

    # Verify the backup is a valid, readable SQLite database
    bconn = sqlite3.connect(str(latest))
    row = bconn.execute("SELECT COUNT(*) FROM users").fetchone()
    bconn.close()
    assert row[0] >= 2

