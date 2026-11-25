"""
backend/app/routers/projects.py
Projects endpoints:
  GET /api/projects — returns projects where the authenticated user is a member
"""

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth import get_current_user
from app.db import get_db

router = APIRouter(prefix="/projects", tags=["projects"])


# ---------------------------------------------------------------------------
# Response model
# ---------------------------------------------------------------------------

class ProjectOut(BaseModel):
    id:          str
    name:        str
    region:      str
    description: str


class ProjectsResponse(BaseModel):
    projects: list[ProjectOut]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=ProjectsResponse)
def list_projects(
    current_user: dict[str, Any] = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> ProjectsResponse:
    """
    Return all projects for which the authenticated user has a membership row.
    Ordered by name for a stable, predictable list.
    """
    rows = db.execute(
        """
        SELECT p.id, p.name, p.region, p.description
        FROM   projects       p
        JOIN   project_members pm ON pm.project_id = p.id
        WHERE  pm.user_id = ?
        ORDER  BY p.name
        """,
        (current_user["id"],),
    ).fetchall()

    return ProjectsResponse(
        projects=[
            ProjectOut(
                id=row["id"],
                name=row["name"],
                region=row["region"],
                description=row["description"],
            )
            for row in rows
        ]
    )
