"""
backend/app/config.py
Application settings — all values are overridable via environment variables.
"""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Resolve paths relative to the backend/ directory so the app works regardless
# of the working directory from which uvicorn is launched.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent  # …/backend/
_DATA_DIR     = _BACKEND_DIR / "data"

# --- Database ---------------------------------------------------------------
DB_PATH: Path = Path(os.environ.get("FIELDSYNC_DB_PATH",    str(_DATA_DIR / "fieldsync.db")))

# --- Media ------------------------------------------------------------------
MEDIA_DIR: Path = Path(os.environ.get("FIELDSYNC_MEDIA_DIR", str(_DATA_DIR / "media")))

# --- Session ----------------------------------------------------------------
# Lifetime in seconds (default 30 days)
SESSION_LIFETIME_SECONDS: int = int(os.environ.get("FIELDSYNC_SESSION_LIFETIME", str(30 * 24 * 3600)))

# --- Upload -----------------------------------------------------------------
# Maximum raw-bytes upload size (default 10 MB)
MAX_UPLOAD_BYTES: int = int(os.environ.get("FIELDSYNC_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))

# ---------------------------------------------------------------------------
# Ensure data directories exist at import time so other modules can rely on
# them being present.
# ---------------------------------------------------------------------------
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
