// frontend/js/db.js
// Dexie instance and schema (v1).
// See PROJECT_CONTEXT.md §5 for the full schema.
// This is the single export `db` used by all UI modules and repo.js.

import { uuid } from './utils.js';

const DB_NAME    = 'fieldsync';
const DB_VERSION = 2;

const SCHEMA_V1 = {
  projects:     'id, name',
  records:      'id, project_id, type, [project_id+type], deleted',
  media:        'id, record_id, project_id, upload_state',
  tracks:       'id, project_id, status',
  track_points: '[track_id+idx], track_id, synced',
  outbox:       '++seq, change_id, entity',
  conflicts:    '++id, record_id, seen',
  meta:         'key',
};

const SCHEMA_V2 = {
  ...SCHEMA_V1,
  media:        'id, record_id, project_id, upload_state, [record_id+upload_state]',
};

// `Dexie` is a global injected by the CDN <script> in index.html.
const db = new Dexie(DB_NAME);
db.version(1).stores(SCHEMA_V1);
db.version(DB_VERSION).stores(SCHEMA_V2);

// Ensure a persistent device_id exists in meta on first run.
// Use the `vipDb` argument provided by Dexie's `ready` hook to avoid
// deadlocking against `db.open()`.
db.on('ready', async (vipDb) => {
  const target = vipDb || db;
  const existing = await target.meta.get('device_id');
  if (!existing || !existing.value) {
    await target.meta.put({ key: 'device_id', value: uuid() });
  }
});

export class StorageQuotaError extends Error {
  constructor(
    message = 'Device storage is full (QuotaExceededError). Sync your pending data and free up device space before saving.'
  ) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

/**
 * Return true if `err` represents an IndexedDB / Web Storage quota error.
 * @param {any} err
 * @returns {boolean}
 */
export function isQuotaExceededError(err) {
  if (!err) return false;
  if (err instanceof StorageQuotaError) return true;
  const name = err.name || err.inner?.name || '';
  const msg  = String(err.message || err.inner?.message || '').toLowerCase();
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    msg.includes('quota')
  );
}

/**
 * Execute an async Dexie write operation and convert QuotaExceededError into a
 * clear, user-facing StorageQuotaError without silent data loss.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function safeWrite(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isQuotaExceededError(err)) {
      throw new StorageQuotaError();
    }
    throw err;
  }
}

/**
 * Read a value from the `meta` key/value store.
 * @param {string} key
 * @returns {Promise<any>}
 */
export async function getMeta(key) {
  const row = await db.meta.get(key);
  return row ? row.value : null;
}

/**
 * Write a value to the `meta` key/value store.
 * @param {string} key
 * @param {any}    value
 * @returns {Promise<void>}
 */
export async function setMeta(key, value) {
  await safeWrite(() => db.meta.put({ key, value }));
}

/**
 * Delete a key from the `meta` key/value store.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteMeta(key) {
  await db.meta.delete(key);
}

export { db };
