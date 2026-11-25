"""
backend/app/routers/media.py
Media upload/download endpoints:
  PUT /api/media/{id}        — stream full-resolution image to disk (max 10 MB, idempotent)
  PUT /api/media/{id}/thumb  — stream thumbnail image to disk (idempotent)
  GET /api/media/{id}        — download full-resolution binary (member-only)
  GET /api/media/{id}/thumb  — download thumbnail binary (member-only)
"""

from datetime import datetime, timezone
import os
from pathlib import Path
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import FileResponse

from app import config
from app.auth import get_current_user
from app.db import get_db, next_seq

router = APIRouter(prefix="/media", tags=["media"])

_ALLOWED_MIMES = {"image/jpeg", "image/png", "image/webp"}
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _validate_safe_id(value: str, label: str = "id") -> None:
    if not _SAFE_ID_RE.match(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {label}.",
        )


def _require_membership(db: sqlite3.Connection, project_id: str, user_id: str) -> None:
    row = db.execute(
        "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        (project_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this project.",
        )


def _parse_optional_int(value: str | None, header_name: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid integer in {header_name}.",
        ) from exc


async def _stream_to_file(request: Request, dest_path: Path, max_bytes: int) -> int:
    """
    Stream request body into a temporary file, enforcing max_bytes, then
    atomically rename to dest_path. Returns total bytes written.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_name(f".{dest_path.name}.tmp")
    total_size = 0

    try:
        with tmp_path.open("wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total_size += len(chunk)
                if total_size > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"Upload exceeds maximum size of {max_bytes} bytes.",
                    )
                fh.write(chunk)
        os.replace(tmp_path, dest_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    return total_size


def _media_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
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


@router.put("/{media_id}")
async def upload_media(
    media_id: str,
    request: Request,
    x_record_id: str = Header(..., alias="X-Record-Id"),
    x_project_id: str = Header(..., alias="X-Project-Id"),
    x_mime: str = Header(..., alias="X-Mime"),
    x_width: str | None = Header(None, alias="X-Width"),
    x_height: str | None = Header(None, alias="X-Height"),
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    _validate_safe_id(media_id, "media_id")
    _validate_safe_id(x_project_id, "project_id")
    _require_membership(db, x_project_id, current_user["id"])

    if x_mime not in _ALLOWED_MIMES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported media MIME type. Allowed: image/jpeg, image/png, image/webp.",
        )

    width = _parse_optional_int(x_width, "X-Width")
    height = _parse_optional_int(x_height, "X-Height")

    # Idempotency check: if already stored, return 200 without rewriting disk or bumping seq.
    existing = db.execute(
        """
        SELECT id, record_id, project_id, mime, size, width, height,
               created_by, created_at, server_seq
        FROM   media
        WHERE  id = ?
        """,
        (media_id,),
    ).fetchone()
    if existing is not None:
        if existing["project_id"] != x_project_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Media belongs to a different project.",
            )
        return _media_row_to_dict(existing)

    # Verify the referenced record exists in the same project before streaming.
    rec_row = db.execute(
        "SELECT project_id FROM records WHERE id = ?",
        (x_record_id,),
    ).fetchone()
    if rec_row is None or rec_row["project_id"] != x_project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Referenced record does not exist in this project.",
        )

    dest_path = config.MEDIA_DIR / x_project_id / media_id
    size = await _stream_to_file(request, dest_path, config.MAX_UPLOAD_BYTES)

    created_at = datetime.now(timezone.utc).isoformat()
    if db.in_transaction:
        db.commit()
    db.execute("BEGIN IMMEDIATE")
    try:
        # Re-check inside transaction in case of a concurrent upload of the same ID.
        existing = db.execute(
            """
            SELECT id, record_id, project_id, mime, size, width, height,
                   created_by, created_at, server_seq
            FROM   media
            WHERE  id = ?
            """,
            (media_id,),
        ).fetchone()
        if existing is not None:
            db.rollback()
            return _media_row_to_dict(existing)

        seq = next_seq(db)
        db.execute(
            """
            INSERT INTO media
                (id, record_id, project_id, mime, size, width, height,
                 created_by, created_at, server_seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                media_id,
                x_record_id,
                x_project_id,
                x_mime,
                size,
                width,
                height,
                current_user["id"],
                created_at,
                seq,
            ),
        )
        db.commit()
    except Exception:
        if db.in_transaction:
            db.rollback()
        dest_path.unlink(missing_ok=True)
        raise

    return {
        "id": media_id,
        "record_id": x_record_id,
        "project_id": x_project_id,
        "mime": x_mime,
        "size": size,
        "width": width,
        "height": height,
        "created_by": current_user["id"],
        "created_at": created_at,
        "server_seq": seq,
    }


@router.put("/{media_id}/thumb")
async def upload_media_thumb(
    media_id: str,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    _validate_safe_id(media_id, "media_id")

    row = db.execute(
        "SELECT id, project_id FROM media WHERE id = ?",
        (media_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")

    _require_membership(db, row["project_id"], current_user["id"])

    thumb_path = config.MEDIA_DIR / row["project_id"] / f"{media_id}.thumb"
    if thumb_path.exists():
        return {"id": media_id, "size": thumb_path.stat().st_size}

    size = await _stream_to_file(request, thumb_path, config.MAX_UPLOAD_BYTES)
    return {"id": media_id, "size": size}


@router.get("/{media_id}")
def get_media(
    media_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> FileResponse:
    _validate_safe_id(media_id, "media_id")

    row = db.execute(
        "SELECT id, project_id, mime FROM media WHERE id = ?",
        (media_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")

    _require_membership(db, row["project_id"], current_user["id"])

    file_path = config.MEDIA_DIR / row["project_id"] / media_id
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media file missing.")

    return FileResponse(path=file_path, media_type=row["mime"])


@router.get("/{media_id}/thumb")
def get_media_thumb(
    media_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> FileResponse:
    _validate_safe_id(media_id, "media_id")

    row = db.execute(
        "SELECT id, project_id, mime FROM media WHERE id = ?",
        (media_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found.")

    _require_membership(db, row["project_id"], current_user["id"])

    thumb_path = config.MEDIA_DIR / row["project_id"] / f"{media_id}.thumb"
    if not thumb_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Thumbnail not found.")

    return FileResponse(path=thumb_path, media_type=row["mime"])
