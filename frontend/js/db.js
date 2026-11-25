// frontend/js/db.js
// Dexie instance and schema (v1).
// See PROJECT_CONTEXT.md §5 for the full schema.
// This is the single export `db` used by all UI modules and repo.js.

const DB_NAME    = 'fieldsync';
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

// `Dexie` is a global injected by the CDN <script> in index.html.
const db = new Dexie(DB_NAME);
db.version(DB_VERSION).stores(SCHEMA);

export { db };
