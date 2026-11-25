"""
backend/seed.py
Database seeding script.

Creates:
  • 3 users:    researcher1, researcher2, researcher3  (password: field123)
  • 2 projects: 'Indus Delta Survey', 'Thar Wetlands'
  • All 3 users are members of both projects.

Run from the backend/ directory:
    python seed.py

Safe to re-run: existing rows are skipped via INSERT OR IGNORE.
"""

import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap — make app/ importable when run as `python seed.py` from backend/
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).parent))

from app.auth import hash_password
from app.config import DB_PATH
from app.db import init_db

# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------

USERS = [
    {"username": "researcher1", "display_name": "Researcher One"},
    {"username": "researcher2", "display_name": "Researcher Two"},
    {"username": "researcher3", "display_name": "Researcher Three"},
]

PROJECTS = [
    {"name": "Indus Delta Survey", "region": "Sindh, Pakistan",    "description": "Soil and water survey of the Indus river delta."},
    {"name": "Thar Wetlands",      "region": "Tharparkar, Pakistan","description": "Wildlife and water observation in Thar wetlands."},
]

PASSWORD = "field123"


def seed(db_path: Path = DB_PATH) -> None:
    # Ensure schema exists.
    init_db(db_path)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")

    now = datetime.now(timezone.utc).isoformat()

    # -- Users ----------------------------------------------------------------
    user_ids: dict[str, str] = {}  # username → id
    for u in USERS:
        # Check if user already exists.
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (u["username"],)
        ).fetchone()
        if existing:
            user_ids[u["username"]] = existing["id"]
            print(f"  [skip] user '{u['username']}' already exists.")
        else:
            uid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
                (uid, u["username"], u["display_name"], hash_password(PASSWORD)),
            )
            user_ids[u["username"]] = uid
            print(f"  [+] user '{u['username']}' created  (id={uid})")

    # -- Projects -------------------------------------------------------------
    project_ids: list[str] = []
    for p in PROJECTS:
        existing = conn.execute(
            "SELECT id FROM projects WHERE name = ?", (p["name"],)
        ).fetchone()
        if existing:
            project_ids.append(existing["id"])
            print(f"  [skip] project '{p['name']}' already exists.")
        else:
            pid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, ?)",
                (pid, p["name"], p["region"], p["description"]),
            )
            project_ids.append(pid)
            print(f"  [+] project '{p['name']}' created  (id={pid})")

    # -- Memberships ----------------------------------------------------------
    for pid in project_ids:
        for uid in user_ids.values():
            existing = conn.execute(
                "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
                (pid, uid),
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO project_members (project_id, user_id) VALUES (?, ?)",
                    (pid, uid),
                )
                print(f"  [+] membership  project={pid}  user={uid}")
            else:
                print(f"  [skip] membership already exists  project={pid}  user={uid}")

    conn.commit()
    conn.close()
    print("\nSeeding complete.")


if __name__ == "__main__":
    print(f"Seeding database at: {DB_PATH}\n")
    seed()
