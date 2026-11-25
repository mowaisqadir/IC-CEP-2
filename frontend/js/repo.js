// frontend/js/repo.js
// Single data-access layer for IndexedDB (Dexie).
// All UI modules read/write data exclusively through this module.

import { db }            from './db.js';
import { now as hlcNow } from './hlc.js';
import { uuid, nowIso }  from './utils.js';

// ─── Write hook (registered by app.js to avoid circular import with sync.js) ──

/** @type {(() => void) | null} */
let _writeHook = null;

/**
 * Register a callback that is called after every local write.
 * Used by app.js to wire in sync.js triggerSync without a circular import.
 * @param {() => void} fn
 */
export function setWriteHook(fn) {
  _writeHook = fn;
}

export function notifyWrite() {
  if (typeof _writeHook === 'function') {
    try { _writeHook(); } catch { /* ignore */ }
  }
}
const _notifyWrite = notifyWrite;

// ─── Internal transaction helpers ─────────────────────────────────────────────

/**
 * Load device_id and hlc_last inside an active RW transaction that includes `meta`.
 * @returns {Promise<{ deviceId: string, lastHlc: string | null }>}
 */
async function _readClockMeta() {
  let deviceRow = await db.meta.get('device_id');
  let deviceId  = deviceRow?.value;
  if (!deviceId) {
    deviceId = uuid();
    await db.meta.put({ key: 'device_id', value: deviceId });
  }
  const hlcRow = await db.meta.get('hlc_last');
  return { deviceId, lastHlc: hlcRow?.value ?? null };
}

/**
 * Append or coalesce field changes into the outbox for an entity ('record' or 'track').
 * Must be called inside an active RW transaction that includes `outbox`.
 *
 * @param {'record'|'track'} entity
 * @param {object}           row
 * @param {Record<string, { v: any, hlc: string }>} changedFields
 * @param {object}           base
 */
async function _enqueueOutbox(entity, row, changedFields, base) {
  const existing = await db.outbox
    .where('entity')
    .equals(entity)
    .filter((entry) => entry.entity_id === row.id)
    .first();

  if (existing) {
    await db.outbox.update(existing.seq, {
      fields: { ...existing.fields, ...changedFields },
    });
    return;
  }

  await db.outbox.add({
    change_id:  uuid(),
    entity,
    entity_id:  row.id,
    project_id: row.project_id,
    fields:     changedFields,
    base,
  });
}

function _recordBase(record) {
  return {
    type:       record.type,
    created_by: record.created_by,
    created_at: record.created_at,
  };
}

function _trackBase(track) {
  return {
    created_by: track.created_by,
    created_at: track.started_at,
  };
}

function _valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Projects ─────────────────────────────────────────────────────────────────

/**
 * Cache fetched projects into IndexedDB.
 * @param {Array<object>} projects
 */
export async function upsertProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return;
  await db.projects.bulkPut(projects);
}

/**
 * List cached projects ordered by name.
 * @returns {Promise<Array<object>>}
 */
export async function listProjects() {
  return db.projects.orderBy('name').toArray();
}

/**
 * Get a single cached project by ID.
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getProject(id) {
  return db.projects.get(id);
}

// ─── Records (CRUD) ───────────────────────────────────────────────────────────

/**
 * Create a new observation record and enqueue it in the outbox.
 * Runs in one Dexie transaction over records + outbox + meta.
 *
 * @param {string}              projectId
 * @param {'soil'|'water'|'wildlife'} type
 * @param {Record<string, any>} data
 * @returns {Promise<object>}
 */
export async function createRecord(projectId, type, data) {
  const result = await db.transaction('rw', db.records, db.outbox, db.meta, async () => {
    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    let lastHlc = initialHlc;

    const userRow   = await db.meta.get('user');
    const createdBy = userRow?.value?.id ?? 'unknown';
    const createdAt = nowIso();
    const id        = uuid();

    const cleanData = {};
    const fv        = {};
    const fields    = {};

    for (const [k, v] of Object.entries(data || {})) {
      if (v === undefined) continue;
      lastHlc      = hlcNow(lastHlc, deviceId);
      cleanData[k] = v;
      fv[k]        = lastHlc;
      fields[k]    = { v, hlc: lastHlc };
    }

    // Track deleted state in fv per PROJECT_CONTEXT.md §2.4
    lastHlc        = hlcNow(lastHlc, deviceId);
    fv.deleted     = lastHlc;
    fields.deleted = { v: false, hlc: lastHlc };

    const record = {
      id,
      project_id:  projectId,
      type,
      data:        cleanData,
      fv,
      created_by:  createdBy,
      created_at:  createdAt,
      deleted:     false,
      deleted_hlc: null,
    };

    await db.records.add(record);
    await _enqueueOutbox('record', record, fields, _recordBase(record));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return record;
  });
  _notifyWrite();
  return result;
}

/**
 * Update an existing record with a partial data patch.
 * Only changed fields receive a fresh HLC and are queued in the outbox.
 *
 * @param {string}              id
 * @param {Record<string, any>} patch
 * @returns {Promise<object>}
 */
export async function updateRecord(id, patch) {
  const result = await db.transaction('rw', db.records, db.outbox, db.meta, async () => {
    const record = await db.records.get(id);
    if (!record) throw new Error(`Record not found: ${id}`);

    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    let lastHlc = initialHlc;

    const nextData      = { ...(record.data || {}) };
    const nextFv        = { ...(record.fv || {}) };
    const changedFields = {};

    for (const [k, v] of Object.entries(patch || {})) {
      const normalized = v === undefined ? null : v;
      const prev       = nextData[k] === undefined ? null : nextData[k];
      if (_valuesEqual(prev, normalized)) continue;

      lastHlc          = hlcNow(lastHlc, deviceId);
      nextData[k]      = normalized;
      nextFv[k]        = lastHlc;
      changedFields[k] = { v: normalized, hlc: lastHlc };
    }

    if (Object.keys(changedFields).length === 0) {
      return record;
    }

    const updated = {
      ...record,
      data: nextData,
      fv:   nextFv,
    };

    await db.records.put(updated);
    await _enqueueOutbox('record', updated, changedFields, _recordBase(updated));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
  _notifyWrite();
  return result;
}

/**
 * Soft-delete a record and enqueue the deletion in the outbox.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function deleteRecord(id) {
  const result = await db.transaction('rw', db.records, db.outbox, db.meta, async () => {
    const record = await db.records.get(id);
    if (!record) throw new Error(`Record not found: ${id}`);

    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    const lastHlc = hlcNow(initialHlc, deviceId);

    const updated = {
      ...record,
      deleted:     true,
      deleted_hlc: lastHlc,
      fv:          { ...(record.fv || {}), deleted: lastHlc },
    };

    await db.records.put(updated);
    await _enqueueOutbox('record', updated, { deleted: { v: true, hlc: lastHlc } }, _recordBase(updated));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
  _notifyWrite();
  return result;
}

/**
 * Restore a soft-deleted record and enqueue the restoration in the outbox.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function restoreRecord(id) {
  const result = await db.transaction('rw', db.records, db.outbox, db.meta, async () => {
    const record = await db.records.get(id);
    if (!record) throw new Error(`Record not found: ${id}`);

    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    const lastHlc = hlcNow(initialHlc, deviceId);

    const updated = {
      ...record,
      deleted:     false,
      deleted_hlc: null,
      fv:          { ...(record.fv || {}), deleted: lastHlc },
    };

    await db.records.put(updated);
    await _enqueueOutbox('record', updated, { deleted: { v: false, hlc: lastHlc } }, _recordBase(updated));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
  _notifyWrite();
  return result;
}

/**
 * List records for a project with optional type and text search filters.
 *
 * @param {string} projectId
 * @param {object} [filters]
 * @param {string} [filters.type]
 * @param {string} [filters.search]
 * @param {boolean} [filters.includeDeleted=false]
 * @returns {Promise<Array<object>>}
 */
export async function listRecords(projectId, filters = {}) {
  const { type, search, includeDeleted = false } = filters;

  let rows;
  if (type && type !== 'all') {
    rows = await db.records.where('[project_id+type]').equals([projectId, type]).toArray();
  } else {
    rows = await db.records.where('project_id').equals(projectId).toArray();
  }

  if (!includeDeleted) {
    rows = rows.filter((r) => !r.deleted);
  }

  const q = typeof search === 'string' ? search.trim().toLowerCase() : '';
  if (q) {
    rows = rows.filter((r) => {
      if (r.type && r.type.toLowerCase().includes(q)) return true;
      for (const val of Object.values(r.data || {})) {
        if (val !== null && val !== undefined && String(val).toLowerCase().includes(q)) {
          return true;
        }
      }
      return false;
    });
  }

  rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return rows;
}

/**
 * Get a single record by ID.
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getRecord(id) {
  return db.records.get(id);
}

// ─── Outbox status helpers ────────────────────────────────────────────────────

/**
 * Return a Set of record entity_ids that currently have unsent outbox entries.
 * @returns {Promise<Set<string>>}
 */
export async function getPendingRecordIds() {
  const rows = await db.outbox.where('entity').equals('record').toArray();
  return new Set(rows.map((r) => r.entity_id));
}

/**
 * Return the total number of unsent changes in the outbox.
 * @returns {Promise<number>}
 */
export async function getOutboxCount() {
  return db.outbox.count();
}

// ─── Tracks & Track Points ────────────────────────────────────────────────────

const TRACK_META_FIELDS = ['name', 'status', 'started_at', 'ended_at'];

/**
 * Create a new GPS track in `recording` status and enqueue its metadata in outbox.
 *
 * @param {string} projectId
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function createTrack(projectId, name) {
  const result = await db.transaction('rw', db.tracks, db.outbox, db.meta, async () => {
    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    let lastHlc = initialHlc;

    const userRow   = await db.meta.get('user');
    const createdBy = userRow?.value?.id ?? 'unknown';
    const startedAt = nowIso();
    const id        = uuid();

    const metaValues = {
      name:       (name || '').trim() || `Track ${startedAt.slice(0, 16).replace('T', ' ')}`,
      status:     'recording',
      started_at: startedAt,
      ended_at:   null,
    };

    const fv     = {};
    const fields = {};
    for (const key of TRACK_META_FIELDS) {
      lastHlc     = hlcNow(lastHlc, deviceId);
      fv[key]     = lastHlc;
      fields[key] = { v: metaValues[key], hlc: lastHlc };
    }

    const track = {
      id,
      project_id: projectId,
      ...metaValues,
      created_by: createdBy,
      fv,
    };

    await db.tracks.add(track);
    await _enqueueOutbox('track', track, fields, _trackBase(track));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return track;
  });
  _notifyWrite();
  return result;
}

/**
 * Update track metadata fields (name, status, started_at, ended_at) with HLCs
 * and coalesce into the outbox.
 *
 * @param {string} id
 * @param {Record<string, any>} patch
 * @returns {Promise<object>}
 */
export async function updateTrack(id, patch) {
  const result = await db.transaction('rw', db.tracks, db.outbox, db.meta, async () => {
    const track = await db.tracks.get(id);
    if (!track) throw new Error(`Track not found: ${id}`);

    const { deviceId, lastHlc: initialHlc } = await _readClockMeta();
    let lastHlc = initialHlc;

    const nextFv        = { ...(track.fv || {}) };
    const nextTrack     = { ...track };
    const changedFields = {};

    for (const key of TRACK_META_FIELDS) {
      if (!(key in (patch || {}))) continue;
      const val  = patch[key] === undefined ? null : patch[key];
      const prev = track[key] === undefined ? null : track[key];
      if (_valuesEqual(prev, val)) continue;

      lastHlc            = hlcNow(lastHlc, deviceId);
      nextTrack[key]     = val;
      nextFv[key]        = lastHlc;
      changedFields[key] = { v: val, hlc: lastHlc };
    }

    if (Object.keys(changedFields).length === 0) {
      return track;
    }

    nextTrack.fv = nextFv;
    await db.tracks.put(nextTrack);
    await _enqueueOutbox('track', nextTrack, changedFields, _trackBase(nextTrack));
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return nextTrack;
  });
  _notifyWrite();
  return result;
}

/**
 * List all tracks for a project, newest first.
 * @param {string} projectId
 * @returns {Promise<Array<object>>}
 */
export async function listTracks(projectId) {
  const rows = await db.tracks.where('project_id').equals(projectId).toArray();
  rows.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  return rows;
}

/**
 * Get a single track by ID.
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getTrack(id) {
  return db.tracks.get(id);
}

/**
 * Flush a batch of GPS track points to IndexedDB.
 * Points are NOT placed in the outbox; they sync via `synced: 0`.
 *
 * @param {Array<object>} points
 * @returns {Promise<void>}
 */
export async function bulkPutTrackPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return;
  await db.track_points.bulkPut(points);
  _notifyWrite();
}

/**
 * Get all points for a track ordered by `idx`.
 * @param {string} trackId
 * @returns {Promise<Array<object>>}
 */
export async function getTrackPoints(trackId) {
  return db.track_points.where('track_id').equals(trackId).sortBy('idx');
}

/**
 * Count points for a track.
 * @param {string} trackId
 * @returns {Promise<number>}
 */
export async function getTrackPointCount(trackId) {
  return db.track_points.where('track_id').equals(trackId).count();
}

/**
 * Mark any tracks left in 'recording' status (from a crash/reload) as 'interrupted'.
 * @returns {Promise<Array<object>>} interrupted tracks
 */
export async function markInterruptedTracks() {
  const stale = await db.tracks.where('status').equals('recording').toArray();
  const updated = [];
  for (const t of stale) {
    updated.push(
      await updateTrack(t.id, {
        status:   'interrupted',
        ended_at: t.ended_at || nowIso(),
      })
    );
  }
  return updated;
}
