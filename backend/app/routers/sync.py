"""
backend/app/routers/sync.py
Sync endpoints:
  POST /api/sync/push — idempotent, HLC-merged push of record/track changes
  GET  /api/sync/pull — incremental pull of records, tracks, and media metadata
"""

from datetime import datetime, timezone
import json
import logging
import sqlite3
import time
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.db import get_db, next_seq
from app.hlc import is_clock_skewed
from app.merge import merge_fields

router = APIRouter(prefix="/sync", tags=["sync"])
_logger = logging.getLogger("fieldsync.sync")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class FieldUpdate(BaseModel):
    v: Any = None
    hlc: str


class PushChange(BaseModel):
    change_id: str
    entity: str
    entity_id: str
    project_id: str
    fields: dict[str, FieldUpdate] = Field(default_factory=dict)
    base: dict[str, Any] = Field(default_factory=dict)


class PushRequest(BaseModel):
    device_id: str
    changes: list[PushChange] = Field(default_factory=list)


class RejectedChange(BaseModel):
    change_id: str
    reason: str


class PushResponse(BaseModel):
    applied: list[str]
    rejected: list[RejectedChange]
    server_seq: int


class PullItem(BaseModel):
    entity: str
    entity_id: str
    project_id: str
    state: dict[str, Any]


class PullResponse(BaseModel):
    changes: list[PullItem]
    next_seq: int
    has_more: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_user_project_ids(db: sqlite3.Connection, user_id: str) -> set[str]:
    rows = db.execute(
        "SELECT project_id FROM project_members WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    return {row["project_id"] for row in rows}


def _validate_change_hlcs(
    fields: dict[str, FieldUpdate],
    server_now_ms: int,
) -> str | None:
    """Return rejection reason if any field HLC is malformed or >24h ahead, else None."""
    for field_update in fields.values():
        try:
            if is_clock_skewed(field_update.hlc, server_now_ms):
                return "clock_skew"
        except ValueError:
            return "invalid_hlc"
    return None


def _apply_record_change(
    db: sqlite3.Connection,
    change: PushChange,
    incoming_fields: dict[str, dict[str, Any]],
    user_id: str,
    display_name: str = "",
) -> str | None:
    """Apply a record change inside an open transaction. Returns rejection reason or None."""
    row = db.execute(
        """
        SELECT id, project_id, type, data, fv, created_by, created_at,
               deleted, deleted_hlc, server_seq, field_authors
        FROM   records
        WHERE  id = ?
        """,
        (change.entity_id,),
    ).fetchone()

    if row is not None:
        if row["project_id"] != change.project_id:
            return "project_mismatch"

        existing_fv = json.loads(row["fv"])
        merged = merge_fields(
            json.loads(row["data"]),
            existing_fv,
            incoming_fields,
            bool(row["deleted"]),
        )
        if merged["changed"]:
            # Build updated field_authors: for each winning field, record the author
            existing_fa: dict[str, Any] = json.loads(row["field_authors"] or "{}")
            for field, f_incoming in incoming_fields.items():
                local_hlc = existing_fv.get(field)
                wins = local_hlc is None or (
                    merged["fv"].get(field) == f_incoming["hlc"]
                )
                if wins:
                    existing_fa[field] = {
                        "user_id": user_id,
                        "display_name": display_name,
                        "hlc": f_incoming["hlc"],
                    }

            seq = next_seq(db)
            db.execute(
                """
                UPDATE records
                SET    data = ?, fv = ?, deleted = ?, deleted_hlc = ?,
                       server_seq = ?, field_authors = ?
                WHERE  id = ?
                """,
                (
                    json.dumps(merged["data"]),
                    json.dumps(merged["fv"]),
                    int(merged["deleted"]),
                    merged["deleted_hlc"],
                    seq,
                    json.dumps(existing_fa),
                    change.entity_id,
                ),
            )
        return None

    rec_type = change.base.get("type")
    if not rec_type or not isinstance(rec_type, str):
        return "missing_base_type"

    created_by = change.base.get("created_by") or user_id
    created_at = change.base.get("created_at") or datetime.now(timezone.utc).isoformat()
    merged = merge_fields({}, {}, incoming_fields, False)
    seq = next_seq(db)

    # Build field_authors for brand-new record
    new_fa: dict[str, Any] = {}
    for field, f_incoming in incoming_fields.items():
        new_fa[field] = {
            "user_id": user_id,
            "display_name": display_name,
            "hlc": f_incoming["hlc"],
        }

    db.execute(
        """
        INSERT INTO records
            (id, project_id, type, data, fv, created_by, created_at,
             deleted, deleted_hlc, server_seq, field_authors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            change.entity_id,
            change.project_id,
            rec_type,
            json.dumps(merged["data"]),
            json.dumps(merged["fv"]),
            created_by,
            created_at,
            int(merged["deleted"]),
            merged["deleted_hlc"],
            seq,
            json.dumps(new_fa),
        ),
    )
    return None


def _apply_track_change(
    db: sqlite3.Connection,
    change: PushChange,
    incoming_fields: dict[str, dict[str, Any]],
    user_id: str,
) -> str | None:
    """Apply a track metadata change inside an open transaction. Returns rejection reason or None."""
    row = db.execute(
        """
        SELECT id, project_id, name, started_at, ended_at, status,
               created_by, fv, server_seq
        FROM   tracks
        WHERE  id = ?
        """,
        (change.entity_id,),
    ).fetchone()

    if row is not None:
        if row["project_id"] != change.project_id:
            return "project_mismatch"

        local_data = {
            "name": row["name"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "status": row["status"],
        }
        merged = merge_fields(
            local_data,
            json.loads(row["fv"]),
            incoming_fields,
            False,
        )
        if merged["changed"]:
            d = merged["data"]
            seq = next_seq(db)
            db.execute(
                """
                UPDATE tracks
                SET    name = ?, started_at = ?, ended_at = ?, status = ?,
                       fv = ?, server_seq = ?
                WHERE  id = ?
                """,
                (
                    d.get("name") or "",
                    d.get("started_at") or row["started_at"],
                    d.get("ended_at"),
                    d.get("status") or "recording",
                    json.dumps(merged["fv"]),
                    seq,
                    change.entity_id,
                ),
            )
        return None

    created_by = change.base.get("created_by") or user_id
    default_started = change.base.get("created_at") or datetime.now(timezone.utc).isoformat()
    merged = merge_fields({}, {}, incoming_fields, False)
    d = merged["data"]
    seq = next_seq(db)

    db.execute(
        """
        INSERT INTO tracks
            (id, project_id, name, started_at, ended_at, status,
             created_by, fv, server_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            change.entity_id,
            change.project_id,
            d.get("name") or "",
            d.get("started_at") or default_started,
            d.get("ended_at"),
            d.get("status") or "recording",
            created_by,
            json.dumps(merged["fv"]),
            seq,
        ),
    )
    return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/push", response_model=PushResponse)
def sync_push(
    body: PushRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> PushResponse:
    t0 = time.monotonic()
    user_id = current_user["id"]
    user_projects = _get_user_project_ids(db, user_id)
    server_now_ms = int(time.time() * 1000)

    # Look up display_name once for field_authors attribution
    user_row = db.execute(
        "SELECT display_name FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    display_name: str = user_row["display_name"] if user_row else ""

    applied: list[str] = []
    rejected: list[RejectedChange] = []

    for change in body.changes:
        if change.entity not in ("record", "track"):
            rejected.append(RejectedChange(change_id=change.change_id, reason="unknown_entity"))
            continue

        if change.project_id not in user_projects:
            rejected.append(RejectedChange(change_id=change.change_id, reason="not_a_member"))
            continue

        hlc_error = _validate_change_hlcs(change.fields, server_now_ms)
        if hlc_error is not None:
            rejected.append(RejectedChange(change_id=change.change_id, reason=hlc_error))
            continue

        incoming_fields = {
            k: {"v": v.v, "hlc": v.hlc}
            for k, v in change.fields.items()
        }

        if db.in_transaction:
            db.commit()
        db.execute("BEGIN IMMEDIATE")
        try:
            already_done = db.execute(
                "SELECT 1 FROM processed_changes WHERE change_id = ?",
                (change.change_id,),
            ).fetchone()
            if already_done is not None:
                db.rollback()
                applied.append(change.change_id)
                continue

            if change.entity == "record":
                err = _apply_record_change(db, change, incoming_fields, user_id, display_name)
            else:
                err = _apply_track_change(db, change, incoming_fields, user_id)

            if err is not None:
                db.rollback()
                rejected.append(RejectedChange(change_id=change.change_id, reason=err))
                continue

            db.execute(
                "INSERT INTO processed_changes (change_id, applied_at) VALUES (?, ?)",
                (change.change_id, datetime.now(timezone.utc).isoformat()),
            )
            db.commit()
            applied.append(change.change_id)
        except Exception:
            if db.in_transaction:
                db.rollback()
            raise

    seq_row = db.execute("SELECT next_val FROM global_seq WHERE id = 1").fetchone()
    current_seq = seq_row["next_val"] if seq_row else 0

    duration_ms = round((time.monotonic() - t0) * 1000, 2)
    touched_projects = sorted({c.project_id for c in body.changes})
    _logger.info(
        json.dumps(
            {
                "event": "sync_push",
                "user_id": user_id,
                "device_id": body.device_id,
                "projects": touched_projects,
                "applied_count": len(applied),
                "rejected_count": len(rejected),
                "server_seq": current_seq,
                "duration_ms": duration_ms,
            }
        )
    )

    return PushResponse(
        applied=applied,
        rejected=rejected,
        server_seq=current_seq,
    )


@router.get("/pull", response_model=PullResponse)
def sync_pull(
    since: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> PullResponse:
    t0 = time.monotonic()
    user_id = current_user["id"]

    # Fetch limit + 1 rows across all three entity tables for the user's projects
    union_rows = db.execute(
        """
        SELECT entity, id, project_id, server_seq
        FROM (
            SELECT 'record' AS entity, r.id, r.project_id, r.server_seq
            FROM   records r
            JOIN   project_members pm ON pm.project_id = r.project_id
            WHERE  pm.user_id = ? AND r.server_seq > ?
            UNION ALL
            SELECT 'track' AS entity, t.id, t.project_id, t.server_seq
            FROM   tracks t
            JOIN   project_members pm ON pm.project_id = t.project_id
            WHERE  pm.user_id = ? AND t.server_seq > ?
            UNION ALL
            SELECT 'media' AS entity, m.id, m.project_id, m.server_seq
            FROM   media m
            JOIN   project_members pm ON pm.project_id = m.project_id
            WHERE  pm.user_id = ? AND m.server_seq > ?
        )
        ORDER BY server_seq ASC
        LIMIT ?
        """,
        (user_id, since, user_id, since, user_id, since, limit + 1),
    ).fetchall()

    has_more = len(union_rows) > limit
    page_rows = union_rows[:limit]

    if not page_rows:
        duration_ms = round((time.monotonic() - t0) * 1000, 2)
        _logger.info(
            json.dumps(
                {
                    "event": "sync_pull",
                    "user_id": user_id,
                    "projects": [],
                    "since": since,
                    "pulled_count": 0,
                    "next_seq": since,
                    "has_more": False,
                    "duration_ms": duration_ms,
                }
            )
        )
        return PullResponse(changes=[], next_seq=since, has_more=False)

    record_ids = [r["id"] for r in page_rows if r["entity"] == "record"]
    track_ids = [r["id"] for r in page_rows if r["entity"] == "track"]
    media_ids = [r["id"] for r in page_rows if r["entity"] == "media"]

    records_by_id: dict[str, dict[str, Any]] = {}
    if record_ids:
        placeholders = ",".join("?" for _ in record_ids)
        for row in db.execute(
            f"""
            SELECT id, project_id, type, data, fv, created_by, created_at,
                   deleted, deleted_hlc, server_seq, field_authors
            FROM   records
            WHERE  id IN ({placeholders})
            """,
            record_ids,
        ).fetchall():
            records_by_id[row["id"]] = {
                "id": row["id"],
                "project_id": row["project_id"],
                "type": row["type"],
                "data": json.loads(row["data"]),
                "fv": json.loads(row["fv"]),
                "created_by": row["created_by"],
                "created_at": row["created_at"],
                "deleted": bool(row["deleted"]),
                "deleted_hlc": row["deleted_hlc"],
                "server_seq": row["server_seq"],
                "field_authors": json.loads(row["field_authors"]) if row["field_authors"] else {},
            }

    tracks_by_id: dict[str, dict[str, Any]] = {}
    if track_ids:
        placeholders = ",".join("?" for _ in track_ids)
        counts: dict[str, int] = {}
        for cnt_row in db.execute(
            f"""
            SELECT track_id, COUNT(*) AS cnt
            FROM   track_points
            WHERE  track_id IN ({placeholders})
            GROUP BY track_id
            """,
            track_ids,
        ).fetchall():
            counts[cnt_row["track_id"]] = cnt_row["cnt"]

        for row in db.execute(
            f"""
            SELECT id, project_id, name, started_at, ended_at, status,
                   created_by, fv, server_seq
            FROM   tracks
            WHERE  id IN ({placeholders})
            """,
            track_ids,
        ).fetchall():
            tracks_by_id[row["id"]] = {
                "id": row["id"],
                "project_id": row["project_id"],
                "name": row["name"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "status": row["status"],
                "created_by": row["created_by"],
                "fv": json.loads(row["fv"]),
                "point_count": counts.get(row["id"], 0),
                "server_seq": row["server_seq"],
            }

    media_by_id: dict[str, dict[str, Any]] = {}
    if media_ids:
        placeholders = ",".join("?" for _ in media_ids)
        for row in db.execute(
            f"""
            SELECT id, record_id, project_id, mime, size, width, height,
                   created_by, created_at, server_seq
            FROM   media
            WHERE  id IN ({placeholders})
            """,
            media_ids,
        ).fetchall():
            media_by_id[row["id"]] = {
                "id": row["id"],
                "record_id": row["record_id"],
                "project_id": row["project_id"],
                "mime": row["mime"],
                "size": row["size"],
                "width": row["width"],
                "height": row["height"],
                "created_by": row["created_by"],
                "created_at": row["created_at"],
                "server_seq": row["server_seq"],
            }

    lookup = {
        "record": records_by_id,
        "track": tracks_by_id,
        "media": media_by_id,
    }

    changes: list[PullItem] = []
    for item in page_rows:
        state = lookup[item["entity"]][item["id"]]
        changes.append(
            PullItem(
                entity=item["entity"],
                entity_id=item["id"],
                project_id=item["project_id"],
                state=state,
            )
        )

    next_cursor = page_rows[-1]["server_seq"]
    duration_ms = round((time.monotonic() - t0) * 1000, 2)
    pulled_projects = sorted({c.project_id for c in changes})
    _logger.info(
        json.dumps(
            {
                "event": "sync_pull",
                "user_id": user_id,
                "projects": pulled_projects,
                "since": since,
                "pulled_count": len(changes),
                "next_seq": next_cursor,
                "has_more": has_more,
                "duration_ms": duration_ms,
            }
        )
    )
    return PullResponse(
        changes=changes,
        next_seq=next_cursor,
        has_more=has_more,
    )
