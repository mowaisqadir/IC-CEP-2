// frontend/js/repo.js
// Single data-access layer for IndexedDB (Dexie).
// All UI modules read/write data exclusively through this module.

import { db }            from './db.js';
import { now as hlcNow } from './hlc.js';
import { uuid, nowIso }  from './utils.js';

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
 * Append or coalesce field changes into the outbox for a record.
 * Must be called inside an active RW transaction that includes `outbox`.
 *
 * @param {object} record
 * @param {Record<string, { v: any, hlc: string }>} changedFields
 */
async function _enqueueOutbox(record, changedFields) {
  const existing = await db.outbox
    .where('entity')
    .equals('record')
    .filter((row) => row.entity_id === record.id)
    .first();

  if (existing) {
    await db.outbox.update(existing.seq, {
      fields: { ...existing.fields, ...changedFields },
    });
    return;
  }

  await db.outbox.add({
    change_id:  uuid(),
    entity:     'record',
    entity_id:  record.id,
    project_id: record.project_id,
    fields:     changedFields,
    base: {
      type:       record.type,
      created_by: record.created_by,
      created_at: record.created_at,
    },
  });
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
  return db.transaction('rw', db.records, db.outbox, db.meta, async () => {
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
    await _enqueueOutbox(record, fields);
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return record;
  });
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
  return db.transaction('rw', db.records, db.outbox, db.meta, async () => {
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
    await _enqueueOutbox(updated, changedFields);
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
}

/**
 * Soft-delete a record and enqueue the deletion in the outbox.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function deleteRecord(id) {
  return db.transaction('rw', db.records, db.outbox, db.meta, async () => {
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
    await _enqueueOutbox(updated, { deleted: { v: true, hlc: lastHlc } });
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
}

/**
 * Restore a soft-deleted record and enqueue the restoration in the outbox.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function restoreRecord(id) {
  return db.transaction('rw', db.records, db.outbox, db.meta, async () => {
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
    await _enqueueOutbox(updated, { deleted: { v: false, hlc: lastHlc } });
    await db.meta.put({ key: 'hlc_last', value: lastHlc });

    return updated;
  });
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
