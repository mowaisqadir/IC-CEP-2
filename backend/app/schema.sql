-- backend/app/schema.sql
-- DDL for all FieldSync server-side tables.
-- Designed to be run idempotently (every CREATE uses IF NOT EXISTS).
--
-- ============================================================
-- SEQUENCE STRATEGY
-- ============================================================
-- We use a single monotonic counter stored in `global_seq` (one row).
-- Every INSERT into `records`, `tracks`, and `media` calls
-- next_seq() — a helper written in Python before the INSERT —
-- which does:
--     UPDATE global_seq SET next_val = next_val + 1;
--     SELECT next_val FROM global_seq;
-- and stores the result in the row's `server_seq` column.
--
-- Why one shared counter across all three tables?
--   • A single INTEGER sequence is strict-monotonic: no two rows in
--     any of the three tables will ever share the same seq value.
--   • The pull endpoint can answer "everything with seq > N" with a
--     single UNION query:
--         SELECT 'record' AS entity, … FROM records  WHERE server_seq > N
--         UNION ALL
--         SELECT 'track'  AS entity, … FROM tracks   WHERE server_seq > N
--         UNION ALL
--         SELECT 'media'  AS entity, … FROM media    WHERE server_seq > N
--         ORDER BY server_seq
--         LIMIT ?
--   • No gap risk: the counter lives inside the same SQLite file, so
--     it stays consistent even after crash recovery.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Sequence counter (single row, never deleted)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS global_seq (
    id       INTEGER PRIMARY KEY CHECK (id = 1),  -- enforces single-row
    next_val INTEGER NOT NULL DEFAULT 0
);
-- Seed the row if it doesn't exist yet.
INSERT OR IGNORE INTO global_seq (id, next_val) VALUES (1, 0);

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,          -- UUID v4
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL
);

-- ------------------------------------------------------------
-- sessions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,              -- ISO 8601 UTC
    expires_at  TEXT NOT NULL               -- ISO 8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- ------------------------------------------------------------
-- projects
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,           -- UUID v4
    name        TEXT NOT NULL,
    region      TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT ''
);

-- ------------------------------------------------------------
-- project_members  (join table, no surrogate key)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_members (
    project_id  TEXT NOT NULL REFERENCES projects(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);

-- ------------------------------------------------------------
-- records  (core observation entity)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS records (
    id          TEXT PRIMARY KEY,           -- UUID v4, client-generated
    project_id  TEXT NOT NULL REFERENCES projects(id),
    type        TEXT NOT NULL,              -- 'soil' | 'water' | 'wildlife'
    data        TEXT NOT NULL DEFAULT '{}', -- JSON object
    fv          TEXT NOT NULL DEFAULT '{}', -- JSON object: {field: hlc}
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,              -- ISO 8601 UTC
    deleted     INTEGER NOT NULL DEFAULT 0, -- 0 = alive, 1 = soft-deleted
    deleted_hlc TEXT,                       -- HLC of the deletion event (nullable)
    server_seq  INTEGER                     -- set by next_seq() on every write
);
CREATE INDEX IF NOT EXISTS idx_records_project_seq ON records(project_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_records_server_seq  ON records(server_seq);

-- ------------------------------------------------------------
-- media  (photo metadata; binary stored on disk)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,           -- UUID v4
    record_id   TEXT NOT NULL REFERENCES records(id),
    project_id  TEXT NOT NULL REFERENCES projects(id),
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,           -- bytes
    width       INTEGER,                    -- pixels (nullable)
    height      INTEGER,                    -- pixels (nullable)
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,              -- ISO 8601 UTC
    server_seq  INTEGER                     -- set by next_seq() on every write
);
CREATE INDEX IF NOT EXISTS idx_media_project_seq ON media(project_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_media_server_seq  ON media(server_seq);

-- ------------------------------------------------------------
-- tracks  (GPS track sessions)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracks (
    id          TEXT PRIMARY KEY,           -- UUID v4
    project_id  TEXT NOT NULL REFERENCES projects(id),
    name        TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL,              -- ISO 8601 UTC
    ended_at    TEXT,                       -- ISO 8601 UTC (nullable)
    status      TEXT NOT NULL DEFAULT 'recording', -- 'recording'|'paused'|'stopped'
    created_by  TEXT NOT NULL REFERENCES users(id),
    fv          TEXT NOT NULL DEFAULT '{}', -- JSON object: {field: hlc}
    server_seq  INTEGER                     -- set by next_seq() on every write
);
CREATE INDEX IF NOT EXISTS idx_tracks_project_seq ON tracks(project_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_tracks_server_seq  ON tracks(server_seq);

-- ------------------------------------------------------------
-- track_points  (append-only; PK is composite (track_id, idx))
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS track_points (
    track_id  TEXT    NOT NULL REFERENCES tracks(id),
    idx       INTEGER NOT NULL,             -- 0-based sequential index
    lat       REAL    NOT NULL,
    lng       REAL    NOT NULL,
    accuracy  REAL    NOT NULL,
    altitude  REAL,                         -- metres above WGS-84 (nullable)
    ts        TEXT    NOT NULL,             -- ISO 8601 UTC
    PRIMARY KEY (track_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_track_points_track_id ON track_points(track_id);

-- ------------------------------------------------------------
-- processed_changes  (idempotency log for /api/sync/push)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_changes (
    change_id  TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL                -- ISO 8601 UTC
);
