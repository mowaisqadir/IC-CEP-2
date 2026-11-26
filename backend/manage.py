#!/usr/bin/env python3
"""
backend/manage.py
Admin CLI for managing FieldSync users, projects, and memberships.

Usage (from backend/ or repo root):
    python backend/manage.py add-user --username alice --display-name "Alice Field" --password "..."
    python backend/manage.py add-project --name "Indus Survey" --region "Sindh" --description "..."
    python backend/manage.py add-member --username alice --project "Indus Survey"
"""

import argparse
import getpass
from pathlib import Path
import sqlite3
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.auth import hash_password
from app.config import DB_PATH
from app.db import _make_connection, init_db


def cmd_add_user(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
    password = args.password or getpass.getpass("Password: ")
    if not password:
        print("Error: password cannot be empty.", file=sys.stderr)
        return 1

    existing = conn.execute(
        "SELECT id FROM users WHERE username = ?", (args.username,)
    ).fetchone()
    if existing:
        print(f"Error: user '{args.username}' already exists (id={existing['id']}).", file=sys.stderr)
        return 1

    uid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
        (uid, args.username, args.display_name, hash_password(password)),
    )
    conn.commit()
    print(f"Created user '{args.username}' (id={uid})")
    return 0


def cmd_add_project(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
    pid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO projects (id, name, region, description) VALUES (?, ?, ?, ?)",
        (pid, args.name, args.region, args.description),
    )
    conn.commit()
    print(f"Created project '{args.name}' (id={pid})")
    return 0


def cmd_add_member(conn: sqlite3.Connection, args: argparse.Namespace) -> int:
    user = conn.execute(
        "SELECT id, username FROM users WHERE username = ?", (args.username,)
    ).fetchone()
    if not user:
        print(f"Error: user '{args.username}' not found.", file=sys.stderr)
        return 1

    project = conn.execute(
        "SELECT id, name FROM projects WHERE id = ? OR name = ?",
        (args.project, args.project),
    ).fetchone()
    if not project:
        print(f"Error: project '{args.project}' not found.", file=sys.stderr)
        return 1

    conn.execute(
        "INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)",
        (project["id"], user["id"]),
    )
    conn.commit()
    print(f"Added '{user['username']}' to project '{project['name']}' ({project['id']})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="FieldSync admin management CLI")
    parser.add_argument("--db", type=Path, default=DB_PATH, help="SQLite DB path")
    sub = parser.add_subparsers(dest="command", required=True)

    p_user = sub.add_parser("add-user", help="Create a new researcher account")
    p_user.add_argument("--username", required=True)
    p_user.add_argument("--display-name", required=True)
    p_user.add_argument("--password", default=None, help="Omit to prompt interactively")

    p_proj = sub.add_parser("add-project", help="Create a new project")
    p_proj.add_argument("--name", required=True)
    p_proj.add_argument("--region", default="")
    p_proj.add_argument("--description", default="")

    p_mem = sub.add_parser("add-member", help="Add a user to a project")
    p_mem.add_argument("--username", required=True)
    p_mem.add_argument("--project", required=True, help="Project ID or exact name")

    args = parser.parse_args()
    init_db(args.db)
    conn = _make_connection(args.db)
    try:
        if args.command == "add-user":
            return cmd_add_user(conn, args)
        if args.command == "add-project":
            return cmd_add_project(conn, args)
        if args.command == "add-member":
            return cmd_add_member(conn, args)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

