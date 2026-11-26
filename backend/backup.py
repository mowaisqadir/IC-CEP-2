#!/usr/bin/env python3
"""
backend/backup.py
Online SQLite backup script using sqlite3's Connection.backup() API.
Safe to run while uvicorn is serving traffic (including WAL mode).
Keeps the last 7 backup copies (configurable via --keep).

Usage:
    python backend/backup.py
    python backend/backup.py --db backend/data/fieldsync.db --dest backend/data/backups --keep 7
"""

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.config import DB_PATH


def run_backup(db_path: Path, dest_dir: Path, keep: int = 7) -> Path:
    if not db_path.exists():
        raise FileNotFoundError(f"Source database not found: {db_path}")

    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = dest_dir / f"fieldsync-{stamp}.db"

    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30.0)
    dst = sqlite3.connect(str(backup_path))
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()

    # Prune old backups, keeping the newest `keep` files
    backups = sorted(
        dest_dir.glob("fieldsync-*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in backups[keep:]:
        old.unlink(missing_ok=True)

    return backup_path


def main() -> int:
    parser = argparse.ArgumentParser(description="FieldSync online SQLite backup")
    parser.add_argument("--db", type=Path, default=DB_PATH, help="Source SQLite DB path")
    parser.add_argument(
        "--dest",
        type=Path,
        default=DB_PATH.parent / "backups",
        help="Backup directory",
    )
    parser.add_argument("--keep", type=int, default=7, help="Number of backups to retain")
    args = parser.parse_args()

    out = run_backup(args.db, args.dest, max(1, args.keep))
    print(f"Backup written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

