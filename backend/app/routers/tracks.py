"""
backend/app/routers/tracks.py
Track points endpoints:
  POST /api/tracks/{id}/points          — idempotent batch insert (max 1000 points)
  GET  /api/tracks/{id}/points?from_idx — download track points on demand
"""

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.db import get_db, next_seq

router = APIRouter(prefix="/tracks", tags=["tracks"])

_MAX_POINTS_PER_BATCH = 1000


class TrackPointIn(BaseModel):
    idx: int = Field(..., ge=0)
    lat: float
    lng: float
    accuracy: float
    altitude: float | None = None
    ts: str


class TrackPointsBatchIn(BaseModel):
    points: list[TrackPointIn] = Field(default_factory=list)


class TrackPointsBatchOut(BaseModel):
    inserted: int
    server_seq: int | None


class TrackPointOut(BaseModel):
    idx: int
    lat: float
    lng: float
    accuracy: float
    altitude: float | None
    ts: str


class TrackPointsListOut(BaseModel):
    track_id: str
    points: list[TrackPointOut]


def _get_track_for_member(
    db: sqlite3.Connection,
    track_id: str,
    user_id: str,
) -> sqlite3.Row:
    track = db.execute(
        "SELECT id, project_id, server_seq FROM tracks WHERE id = ?",
        (track_id,),
    ).fetchone()
    if track is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Track not found.")

    member = db.execute(
        "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        (track["project_id"], user_id),
    ).fetchone()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this project.",
        )
    return track


@router.post("/{track_id}/points", response_model=TrackPointsBatchOut)
def upload_track_points(
    track_id: str,
    body: TrackPointsBatchIn,
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> TrackPointsBatchOut:
    if len(body.points) > _MAX_POINTS_PER_BATCH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum {_MAX_POINTS_PER_BATCH} points per request.",
        )

    track = _get_track_for_member(db, track_id, current_user["id"])
    current_seq: int | None = track["server_seq"]

    if not body.points:
        return TrackPointsBatchOut(inserted=0, server_seq=current_seq)

    if db.in_transaction:
        db.commit()
    db.execute("BEGIN IMMEDIATE")
    try:
        before_changes = db.total_changes
        db.executemany(
            """
            INSERT OR IGNORE INTO track_points
                (track_id, idx, lat, lng, accuracy, altitude, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (track_id, p.idx, p.lat, p.lng, p.accuracy, p.altitude, p.ts)
                for p in body.points
            ],
        )
        inserted = db.total_changes - before_changes

        if inserted > 0:
            current_seq = next_seq(db)
            db.execute(
                "UPDATE tracks SET server_seq = ? WHERE id = ?",
                (current_seq, track_id),
            )

        db.commit()
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise

    return TrackPointsBatchOut(inserted=inserted, server_seq=current_seq)


@router.get("/{track_id}/points", response_model=TrackPointsListOut)
def get_track_points(
    track_id: str,
    from_idx: int = Query(0, ge=0),
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> TrackPointsListOut:
    _get_track_for_member(db, track_id, current_user["id"])

    rows = db.execute(
        """
        SELECT idx, lat, lng, accuracy, altitude, ts
        FROM   track_points
        WHERE  track_id = ? AND idx >= ?
        ORDER  BY idx ASC
        """,
        (track_id, from_idx),
    ).fetchall()

    return TrackPointsListOut(
        track_id=track_id,
        points=[
            TrackPointOut(
                idx=r["idx"],
                lat=r["lat"],
                lng=r["lng"],
                accuracy=r["accuracy"],
                altitude=r["altitude"],
                ts=r["ts"],
            )
            for r in rows
        ],
    )
