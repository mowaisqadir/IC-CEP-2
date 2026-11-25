# FieldSync — Project Context (Contract)

> **This file is the single source of truth.**
> Never change a section silently. If a change is required, stop, explain why,
> and update this file in the same commit/PR as the code change.

---

## 1. GOAL

**FieldSync** is an **offline-first Progressive Web App** for environmental field
researchers. Researchers collect soil, water, and wildlife observations — including
photos and GPS tracks — in remote areas with little or no internet connectivity.

Key requirements:

- Works fully offline; all data is stored locally in IndexedDB (via Dexie.js).
- When a network connection is restored, the app auto-syncs with the FastAPI backend.
- Multiple researchers can edit the **same regional dataset ("project")** while
  offline simultaneously. Conflicts are resolved automatically using the HLC-based
  last-write-wins merge rule (Section 4).
- Media (photos) are uploaded in the background after the record metadata is synced.
- GPS tracks are streamed to the server incrementally (append-only point batches).

---

## 2. DATA MODEL

All `id` fields are **client-generated UUID v4 strings**.

### 2.1 `user`

| Field          | Type   | Notes                       |
| -------------- | ------ | --------------------------- |
| `id`           | string | UUID v4                     |
| `username`     | string | unique login handle         |
| `display_name` | string | shown in the UI             |

### 2.2 `project`

A regional dataset shared among team members.

| Field         | Type   | Notes                        |
| ------------- | ------ | ---------------------------- |
| `id`          | string | UUID v4                      |
| `name`        | string |                              |
| `region`      | string | free-text geographic label   |
| `description` | string | optional                     |

### 2.3 `project_member`

Join table (no surrogate key).

| Field        | Type   | Notes   |
| ------------ | ------ | ------- |
| `project_id` | string | UUID v4 |
| `user_id`    | string | UUID v4 |

### 2.4 `record`

The core observation entity.

| Field         | Type                            | Notes                                                                                      |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `id`          | string                          | UUID v4, client-generated                                                                  |
| `project_id`  | string                          | FK → project                                                                               |
| `type`        | `'soil'\|'water'\|'wildlife'`   | determines which schema is used from `schemas.js`                                          |
| `data`        | `{field: value}`                | observation payload; keys defined in `frontend/js/schemas.js`                             |
| `fv`          | `{field: hlc}`                  | per-field HLC timestamp — same keys as `data` plus `deleted`                              |
| `created_by`  | string                          | user UUID                                                                                  |
| `created_at`  | string                          | ISO 8601 UTC                                                                               |
| `deleted`     | boolean                         | soft-delete flag                                                                           |
| `deleted_hlc` | string \| null                  | HLC of the deletion event; edits with a **greater** HLC revive the record                 |

**Common optional `data` fields** (all record types must accept them):

| Key           | Type           | Notes                                |
| ------------- | -------------- | ------------------------------------ |
| `lat`         | number         | WGS-84 latitude                      |
| `lng`         | number         | WGS-84 longitude                     |
| `accuracy`    | number         | GPS accuracy in metres               |
| `altitude`    | number \| null | GPS altitude in metres above WGS-84  |
| `observed_at` | string         | ISO 8601 UTC                         |
| `notes`       | string         | free-text field notes                |

Type-specific fields come from `frontend/js/schemas.js` and are validated there.

### 2.5 `media`

Immutable after creation. Binary data is stored separately (IndexedDB blob / server
file store); this record holds only metadata.

| Field        | Type                                       | Notes                        |
| ------------ | ------------------------------------------ | ---------------------------- |
| `id`         | string                                     | UUID v4                      |
| `record_id`  | string                                     | FK → record                  |
| `project_id` | string                                     | FK → project                 |
| `mime`       | string                                     | e.g. `image/jpeg`            |
| `size`       | number                                     | bytes                        |
| `width`      | number \| null                             | pixels (images only)         |
| `height`     | number \| null                             | pixels (images only)         |
| `created_by` | string                                     | user UUID                    |
| `created_at` | string                                     | ISO 8601 UTC                 |

#### Dexie-only fields (not on server)

| Field         | Type                                     | Notes                               |
| ------------- | ---------------------------------------- | ----------------------------------- |
| `blob`        | Blob                                     | full-resolution binary              |
| `thumb_blob`  | Blob \| null                             | ≤320 px thumbnail                   |
| `meta_synced` | boolean                                  | metadata PUT acknowledged by server |
| `upload_state`| `'pending'\|'uploading'\|'done'\|'error'`| upload lifecycle                    |
| `deleted`     | boolean                                  | local soft-delete flag (remote deletion of media is out of scope for v1) |

### 2.6 `track`

A GPS track session.

| Field        | Type                        | Notes              |
| ------------ | --------------------------- | ------------------ |
| `id`         | string                      | UUID v4            |
| `project_id` | string                      | FK → project       |
| `name`       | string                      | user-given label   |
| `started_at` | string                      | ISO 8601 UTC       |
| `ended_at`   | string \| null              | ISO 8601 UTC       |
| `status`     | `'recording'\|'paused'\|'stopped'\|'interrupted'` | `'interrupted'` set on reload if app closed while `'recording'` |
| `created_by` | string                      | user UUID          |
| `fv`         | `{field: hlc}`              | per-field HLC for metadata (`name`, `status`, `started_at`, `ended_at`) |

### 2.7 `track_point`

Append-only. PK is composite `(track_id, idx)`.

| Field      | Type           | Notes                     |
| ---------- | -------------- | ------------------------- |
| `track_id` | string         | FK → track                |
| `idx`      | number         | 0-based sequential index  |
| `lat`      | number         |                           |
| `lng`      | number         |                           |
| `accuracy` | number         | metres                    |
| `altitude` | number \| null | metres above WGS-84       |
| `ts`       | string         | ISO 8601 UTC              |
| `synced`   | `0 \| 1`       | Dexie-only upload flag (numeric because IndexedDB cannot index booleans) |

---

## 3. HLC FORMAT

**Hybrid Logical Clock** timestamp string:

```
<13-digit zero-padded wall-clock ms>-<4-digit zero-padded counter>-<deviceId>
```

**Examples:**

```
0001748303476123-0000-a1b2c3d4
0001748303476123-0001-a1b2c3d4   ← same ms, counter incremented
0001748303476200-0000-e5f6a7b8   ← later ms, counter resets to 0
```

**Rules:**

1. **Local event** — advance: `hlc = max(now_ms_padded, last_hlc)`. If the wall
   part equals `last_hlc`'s wall part, increment the counter; otherwise reset to 0.
2. **Receiving a remote HLC** — advance local clock:
   `hlc = max(local_hlc, remote_hlc)` (string lex compare). If equal wall part,
   take the max counter.
3. **Lexicographic comparison equals causal order** because all three parts
   (wall ms, counter, deviceId) are zero-padded to fixed widths.
4. Ties are **impossible** because `deviceId` is unique per device and embedded in
   the HLC.

Implemented in `frontend/js/hlc.js` and `backend/app/hlc.py` (identical logic).

---

## 4. MERGE RULE

> **Identical on client and server. Commutative and idempotent.**

For every field `f` in a record:

```
winner = argmax(fv[f])    # compare HLC strings lexicographically
record.data[f] = winner.value
record.fv[f]   = winner.hlc
```

`deleted` is treated as an ordinary field (its HLC is `deleted_hlc`).

**Conflict / revival semantics:**

- If a record is deleted (`deleted = true`, `deleted_hlc = D`) and a concurrent
  edit arrives with field HLC `E > D`, the record is **revived** (`deleted = false`)
  with the winning field values.
- If `E ≤ D`, the deletion wins and the record stays deleted.
- Conflicts (a local value overwritten by a remote value with a greater HLC) are
  logged to the `conflicts` Dexie table so the researcher can review them.

Implemented in `frontend/js/merge.js` and `backend/app/merge.py` (identical logic).

---

## 5. DEXIE SCHEMA v1

```js
// frontend/js/db.js
const DB_VERSION = 1;
const SCHEMA = {
  projects:     'id, name',
  records:      'id, project_id, type, [project_id+type], deleted',
  media:        'id, record_id, project_id, upload_state',
  tracks:       'id, project_id, status',
  track_points: '[track_id+idx], track_id, synced',
  outbox:       '++seq, change_id, entity',
  conflicts:    '++id, record_id, seen',
  meta:         'key',
};
```

### Key/value pairs stored in `meta`

| `key`           | Purpose                                               |
| --------------- | ----------------------------------------------------- |
| `device_id`     | Randomly generated UUID, persists forever             |
| `hlc_last`      | Last HLC string emitted by this device                |
| `last_pull_seq` | Server sequence number after the last successful pull |
| `token`         | JWT auth token                                        |
| `user`          | Serialised `user` object of the logged-in researcher  |

---

## 6. API

All endpoints are under `/api`. All requests (except `/auth/login` and `/health`)
require `Authorization: Bearer <token>`.

Responses are JSON unless otherwise noted.

### 6.1 Auth

| Method | Path          | Request body              | Response                  |
| ------ | ------------- | ------------------------- | ------------------------- |
| POST   | `/auth/login` | `{username, password}`    | `{token, user}`           |
| GET    | `/auth/me`    | —                         | `{user}`                  |

### 6.2 Projects

| Method | Path        | Notes                                      |
| ------ | ----------- | ------------------------------------------ |
| GET    | `/projects` | Returns projects where current user is a member |

### 6.3 Sync — Push

```
POST /sync/push
```

**Request body:**

```json
{
  "device_id": "string",
  "changes": [
    {
      "change_id":  "uuid",
      "entity":     "record" | "track",
      "entity_id":  "uuid",
      "project_id": "uuid",
      "fields":     { "<field>": { "v": <value>, "hlc": "<hlc>" } },
      "base":       { "type": "<soil|water|wildlife>", ... }
    }
  ]
}
```

**Response:**

```json
{
  "applied":    ["change_id", ...],
  "rejected":   [{ "change_id": "...", "reason": "..." }, ...],
  "server_seq": 12345
}
```

### 6.4 Sync — Pull

```
GET /sync/pull?since=<int>&limit=200
```

**Response:**

```json
{
  "changes": [
    {
      "entity":    "record" | "track" | "media",
      "entity_id": "uuid",
      "project_id":"uuid",
      "state":     { /* full merged record/track/media metadata */ }
    }
  ],
  "next_seq": 12346,
  "has_more": false
}
```

### 6.5 Media

| Method | Path                  | Notes                                                                      |
| ------ | --------------------- | -------------------------------------------------------------------------- |
| PUT    | `/media/{id}`         | Raw bytes body. Headers: `X-Record-Id`, `X-Project-Id`, `X-Mime`, `X-Width`, `X-Height`. Max 10 MB. Idempotent. |
| PUT    | `/media/{id}/thumb`   | Raw bytes body for thumbnail. Idempotent.                                  |
| GET    | `/media/{id}`         | Returns full-resolution binary with correct `Content-Type`.                |
| GET    | `/media/{id}/thumb`   | Returns thumbnail binary.                                                  |

### 6.6 Track Points

```
POST /tracks/{id}/points
```

**Request body:**

```json
{
  "points": [
    { "idx": 0, "lat": 1.23, "lng": 4.56, "accuracy": 5.0, "altitude": 123.4, "ts": "2024-01-01T00:00:00Z" }
  ]
}
```

Idempotent by `(track_id, idx)`. Max 1000 points per request.

```
GET /tracks/{id}/points?from_idx=0
```

Returns `{ "track_id": "uuid", "points": [...] }` ordered by `idx` ascending.

### 6.7 Health

```
GET /health  →  { "status": "ok" }
```

---

## 7. SYNC ALGORITHM

**Order of operations per sync cycle:**

1. **Push** — drain `outbox` (records + tracks), POST to `/sync/push`. Remove
   applied entries; keep rejected for retry.
2. **Pull** — GET `/sync/pull?since=last_pull_seq`. Merge each change into
   IndexedDB (Section 4). Store `next_seq` as new `last_pull_seq`.
3. **Media upload** — for each `media` row with `upload_state = 'pending'`, PUT
   raw bytes to `/media/{id}`. Set `upload_state = 'done'` on success.
4. **Track points upload** — for each `track_points` row with `synced = 0`,
   POST to `/tracks/{id}/points`. Set `synced = 1` on success.

**Triggers:**

- `window` `'online'` event.
- `document` `visibilitychange` → visible.
- Every **30 seconds** while `navigator.onLine === true`.
- Manual "Sync now" button.

**Concurrency guard:** `navigator.locks.request('fieldsync-sync', ...)` — only one
sync at a time per browser.

**Backoff:** Exponential, starting at 5 s, capped at 5 min, reset on success.

Implemented in `frontend/js/sync.js`.

---

## 8. CONVENTIONS

| Topic              | Rule                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Module system**  | ES modules (`type="module"`). No globals except the `Dexie` constructor from CDN.          |
| **Function size**  | Prefer small, single-purpose functions.                                                     |
| **Error handling** | Errors must surface in the UI (toast / error panel). Never swallow silently.               |
| **Dates**          | ISO 8601 strings in UTC everywhere. No `Date` objects cross module boundaries.             |
| **Language**       | All UI strings in English.                                                                  |
| **CSS**            | CSS custom properties (`--var`) for all theme values. Defined in `:root` in `styles.css`. |
| **Touch targets**  | Minimum 44 × 44 px for all interactive elements (WCAG 2.5.5).                             |
| **Networking**     | Only `sync.js` and `api.js` may call `fetch()` or any network API.                         |
| **IndexedDB**      | UI modules only read/write Dexie; they never call fetch.                                    |
| **Mobile-first**   | Layouts designed for 360 px viewport upward; enhanced for tablet (768 px+).               |
| **No build step**  | No bundler, transpiler, or framework. Plain `.js` and `.css` files.                        |
| **Approved CDNs**  | Dexie.js via `https://cdn.jsdelivr.net/npm/dexie`. No other CDN libraries without approval.|

---

## 9. FILE MAP

```
IC-CEP-2/
├── PROJECT_CONTEXT.md          ← this file
├── README.md
├── folder_structure.txt
├── backend/
│   ├── requirements.txt
│   ├── seed.py
│   ├── tests/
│   │   └── (pytest test files)
│   └── app/
│       ├── main.py             ← FastAPI app factory, mounts routers
│       ├── config.py           ← settings (env vars, JWT secret, paths)
│       ├── db.py               ← sqlite3 connection factory, migrations
│       ├── schema.sql          ← DDL for all server-side tables
│       ├── auth.py             ← JWT encode/decode, password hashing
│       ├── hlc.py              ← HLC advance logic (mirrors frontend)
│       ├── merge.py            ← field-level merge logic (mirrors frontend)
│       └── routers/
│           ├── auth.py         ← /api/auth/* endpoints
│           ├── projects.py     ← /api/projects endpoint
│           ├── sync.py         ← /api/sync/push, /api/sync/pull
│           ├── media.py        ← /api/media/* endpoints
│           └── tracks.py       ← /api/tracks/*/points endpoint
└── frontend/
    ├── index.html              ← single HTML shell; all navigation is client-side
    ├── manifest.json           ← PWA manifest
    ├── sw.js                   ← Service Worker (cache strategy + background sync)
    ├── icons/                  ← PWA icons (192px, 512px, maskable)
    ├── css/
    │   └── styles.css          ← global styles, CSS variables, mobile-first layout
    └── js/
        ├── app.js              ← entry point; init Dexie, router, auth check
        ├── router.js           ← hash-based SPA router
        ├── db.js               ← Dexie instance + schema; single export `db`
        ├── hlc.js              ← HLC clock (advance, format, compare)
        ├── merge.js            ← field-level merge (mirrors backend)
        ├── repo.js             ← all IndexedDB CRUD helpers (used by UI)
        ├── api.js              ← fetch wrappers for every backend endpoint
        ├── auth.js             ← login/logout, token storage via repo/meta
        ├── sync.js             ← full sync cycle, triggers, backoff, lock
        ├── media.js            ← capture, thumbnail generation, media repo helpers
        ├── gps.js              ← Geolocation API wrapper, track recording
        ├── schemas.js          ← field definitions per record type
        ├── utils.js            ← uuid(), formatDate(), debounce(), etc.
        └── ui/
            ├── login.js        ← login screen
            ├── projects.js     ← project list screen
            ├── records.js      ← record list screen
            ├── recordForm.js   ← create/edit record form
            ├── tracks.js       ← tracks list + live recording screen
            ├── conflicts.js    ← conflict review screen
            ├── settings.js     ← settings screen (device ID, logout, sync status)
            └── components.js   ← shared UI helpers (toast, modal, spinner, etc.)
```

---

*Last updated: Phase 3 — Sync backend*

