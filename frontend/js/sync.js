// frontend/js/sync.js
// Full sync cycle: push → pull → media upload → track-point upload.
// ONLY this file and api.js may call fetch() or any network API.
// See PROJECT_CONTEXT.md §7 for the algorithm specification.
//
// Triggers: online event, visibilitychange, 30-second interval, post-write
// debounce (2 s), login success, manual button.
// Concurrency guard: navigator.locks (fallback: in-memory flag).
// Backoff: 5 s → 5 min exponential, reset on success.

import { db, getMeta, setMeta }     from './db.js';
import { receive as hlcReceive }     from './hlc.js';
import { mergeFields }               from './merge.js';
import {
  apiSyncPush,
  apiSyncPull,
  apiPutMedia,
  apiPostTrackPoints,
  apiHealth,
  AuthError,
  NetworkError,
  HttpError,
} from './api.js';
import { debounce, sleep, nowIso }   from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PUSH_BATCH      = 50;
const TRACK_PT_BATCH  = 500;
const MEDIA_RETRIES   = 3;
const BACKOFF_MIN_MS  = 5_000;
const BACKOFF_MAX_MS  = 5 * 60_000;
const POLL_INTERVAL   = 30_000;
const DEBOUNCE_MS     = 2_000;

// ─── Event emitter (sync.on / sync.off / sync.emit) ──────────────────────────

/** @type {Map<string, Set<Function>>} */
const _listeners = new Map();

/**
 * Subscribe to sync events.
 * @param {string}   event  - 'state'
 * @param {Function} fn
 * @returns {() => void}  unsubscribe
 */
export function on(event, fn) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(fn);
  return () => _listeners.get(event)?.delete(fn);
}

function _emit(event, payload) {
  const fns = _listeners.get(event);
  if (!fns) return;
  for (const fn of fns) {
    try { fn(payload); } catch (e) { console.warn('[sync] listener error', e); }
  }
}

// ─── Sync state ───────────────────────────────────────────────────────────────

/**
 * @typedef {'idle'|'syncing'|'offline'|'error'} SyncStatus
 *
 * @typedef {{
 *   status:        SyncStatus,
 *   pendingChanges:number,
 *   pendingMedia:  number,
 *   pendingPoints: number,
 *   lastSyncAt:    string | null,
 *   lastError:     string | null,
 * }} SyncState
 */

/** @type {SyncState} */
let _state = {
  status:         'idle',
  pendingChanges: 0,
  pendingMedia:   0,
  pendingPoints:  0,
  lastSyncAt:     null,
  lastError:      null,
};

/** @returns {SyncState} */
export function getState() {
  return { ..._state };
}

async function _refreshCounts() {
  try {
    const [changes, media, points] = await Promise.all([
      db.outbox.count(),
      db.media.where('upload_state').anyOf(['pending', 'uploading']).count(),
      db.track_points.where('synced').equals(0).count(),
    ]);
    _state.pendingChanges = changes;
    _state.pendingMedia   = media;
    _state.pendingPoints  = points;
  } catch {
    // ignore — counts are best-effort
  }
}

async function _setState(patch) {
  Object.assign(_state, patch);
  await _refreshCounts();
  _emit('state', getState());
  _updateHeaderBadge();
}

// ─── Auth-error state ─────────────────────────────────────────────────────────

let _authBlocked = false;   // set true on 401; cleared on successful login

/**
 * Call this after a successful login so sync can resume.
 */
export function notifyLoginSuccess() {
  _authBlocked = false;
  // Kick off a sync after a brief delay so the token is fully persisted
  setTimeout(() => runSync(), 500);
}

// ─── In-memory concurrency fallback ──────────────────────────────────────────

let _syncInProgress = false;

// ─── Backoff state ────────────────────────────────────────────────────────────

let _consecutiveFailures = 0;
let _backoffMs = BACKOFF_MIN_MS;
let _nextRetryAt = 0;
let _backoffTimer = null;

function _resetBackoff() {
  _consecutiveFailures = 0;
  _backoffMs = BACKOFF_MIN_MS;
  _nextRetryAt = 0;
  if (_backoffTimer) {
    clearTimeout(_backoffTimer);
    _backoffTimer = null;
  }
}

function _advanceBackoff() {
  const delay = _consecutiveFailures === 0
    ? BACKOFF_MIN_MS
    : Math.min(_backoffMs * 2, BACKOFF_MAX_MS);
  _consecutiveFailures += 1;
  _backoffMs = delay;
  _nextRetryAt = Date.now() + delay;
  if (_backoffTimer) clearTimeout(_backoffTimer);
  _backoffTimer = setTimeout(() => {
    _backoffTimer = null;
    runSync();
  }, delay);
}

// ─── Dead-letter helpers ──────────────────────────────────────────────────────

/**
 * Move an outbox entry to a "dead_letters" meta key and remove it from outbox.
 * @param {object} outboxRow
 * @param {string} reason
 */
async function _moveToDeadLetter(outboxRow, reason) {
  try {
    const existing = (await getMeta('dead_letters')) || [];
    existing.push({
      change_id:  outboxRow.change_id,
      entity:     outboxRow.entity,
      entity_id:  outboxRow.entity_id,
      project_id: outboxRow.project_id,
      reason,
      at:         nowIso(),
    });
    await setMeta('dead_letters', existing);
    await db.outbox.where('change_id').equals(outboxRow.change_id).delete();
  } catch (err) {
    console.error('[sync] dead-letter write failed', err);
  }
}

// ─── Connectivity check ───────────────────────────────────────────────────────

/**
 * Check real connectivity by hitting /api/health.
 * navigator.onLine can lie (e.g. captive portal).
 * @returns {Promise<boolean>}
 */
async function _isConnected() {
  if (!navigator.onLine) return false;
  try {
    await apiHealth();
    return true;
  } catch (err) {
    if (err instanceof AuthError) return true; // server responded → online
    return false;
  }
}

// ─── PUSH ─────────────────────────────────────────────────────────────────────

/**
 * Drain the outbox in batches of PUSH_BATCH.
 * Returns false if a network/5xx error should stop the whole sync.
 * @param {string} deviceId
 * @returns {Promise<boolean>} true = finished, false = abort sync cycle
 */
async function _push(deviceId) {
  while (true) {
    // Read up to PUSH_BATCH rows ordered by seq (ascending)
    const batch = await db.outbox.orderBy('seq').limit(PUSH_BATCH).toArray();
    if (batch.length === 0) break;

    let result;
    try {
      result = await apiSyncPush({ device_id: deviceId, changes: batch });
    } catch (err) {
      if (err instanceof AuthError)    throw err;   // propagate to caller
      if (err instanceof NetworkError) return false; // abort, keep everything
      if (err instanceof HttpError && err.status >= 500) return false;
      // 4xx (not 401) — log and abort; we'll retry next cycle
      console.warn('[sync] push 4xx:', err.status, err.message);
      return false;
    }

    // Build a lookup from change_id → outbox row for rejected handling
    const byChangeId = Object.fromEntries(batch.map((r) => [r.change_id, r]));

    // Process applied — delete from outbox
    if (result.applied?.length) {
      await db.outbox
        .where('change_id')
        .anyOf(result.applied)
        .delete();
    }

    // Process rejected
    for (const rej of (result.rejected || [])) {
      const row = byChangeId[rej.change_id];
      if (!row) continue;

      if (rej.reason === 'clock_skew') {
        // Keep in outbox; surface a persistent error. Clock must be fixed.
        await _setState({
          lastError: `Clock skew on change ${rej.change_id}. Check your device clock.`,
        });
        // Do NOT dead-letter — could recover when clock is corrected.

      } else {
        // All other permanent rejections → dead letter
        await _moveToDeadLetter(row, rej.reason);
      }
    }

    // If the batch was smaller than the max, we've drained the outbox
    if (batch.length < PUSH_BATCH) break;
  }
  return true;
}

// ─── PULL ─────────────────────────────────────────────────────────────────────

/**
 * Pull all pages from the server since last_pull_seq.
 * Applies each page inside a single Dexie transaction.
 * @param {string}      deviceId
 * @param {string|null} lastHlc
 * @returns {Promise<string|null>} new lastHlc (or same if unchanged)
 */
async function _pull(deviceId, lastHlc) {
  let since = (await getMeta('last_pull_seq')) ?? 0;
  let currentHlc = lastHlc;

  while (true) {
    let page;
    try {
      page = await apiSyncPull(since);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof NetworkError) return currentHlc;
      if (err instanceof HttpError && err.status >= 500) return currentHlc;
      console.warn('[sync] pull error:', err.message);
      return currentHlc;
    }

    if (!page || !page.changes || page.changes.length === 0) {
      // Nothing new — advance cursor if the server provides a new seq
      if (page?.next_seq !== undefined && page.next_seq > since) {
        await setMeta('last_pull_seq', page.next_seq);
        since = page.next_seq;
      }
      break;
    }

    const nextSeq = page.next_seq;

    // Apply all changes for this page in ONE Dexie transaction,
    // only advancing last_pull_seq after everything commits.
    await db.transaction(
      'rw',
      db.records, db.tracks, db.media, db.outbox, db.conflicts, db.meta,
      async () => {
        for (const change of page.changes) {
          if (change.entity === 'record') {
            currentHlc = await _applyRecordChange(change, deviceId, currentHlc);
          } else if (change.entity === 'track') {
            currentHlc = await _applyTrackChange(change, deviceId, currentHlc);
          } else if (change.entity === 'media') {
            await _applyMediaChange(change);
          }
        }
        // Persist new cursor and updated HLC
        await db.meta.put({ key: 'last_pull_seq', value: nextSeq });
        if (currentHlc) {
          await db.meta.put({ key: 'hlc_last', value: currentHlc });
        }
      }
    );

    since = nextSeq;
    if (!page.has_more) break;
  }

  return currentHlc;
}

/**
 * Apply an incoming record change from the pull response.
 * The server sends full merged state; we convert it to incomingFields and merge locally.
 * @returns {string|null} updated lastHlc
 */
async function _applyRecordChange(change, deviceId, lastHlc) {
  const incoming  = change.state;
  const serverFv  = incoming.fv  || {};
  const serverData = incoming.data || {};

  // Build incomingFields from server's fv
  const incomingFields = {};
  for (const [field, hlc] of Object.entries(serverFv)) {
    const v = field === 'deleted' ? Boolean(incoming.deleted) : serverData[field];
    incomingFields[field] = { v, hlc };
  }

  // Advance local HLC for every remote HLC we receive
  let currentHlc = lastHlc;
  for (const { hlc } of Object.values(incomingFields)) {
    if (typeof hlc === 'string') {
      currentHlc = hlcReceive(hlc, currentHlc, deviceId);
    }
  }

  const local = await db.records.get(change.entity_id);

  if (!local) {
    // Brand-new record from server — insert directly
    await db.records.put({
      id:            incoming.id,
      project_id:    incoming.project_id,
      type:          incoming.type,
      data:          { ...serverData },
      fv:            { ...serverFv },
      field_authors: incoming.field_authors ? { ...incoming.field_authors } : {},
      created_by:    incoming.created_by,
      created_at:    incoming.created_at,
      deleted:       Boolean(incoming.deleted),
      deleted_hlc:   incoming.deleted_hlc ?? null,
    });
    return currentHlc;
  }

  // Merge remote into local
  const merged = mergeFields(
    local.data,
    local.fv,
    incomingFields,
    local.deleted
  );

  // Handle overwritten fields: only log conflicts and prune outbox when
  // those fields were still pending locally in the outbox.
  if (merged.overwritten.length > 0) {
    const outboxEntry = await db.outbox
      .where('entity').equals('record')
      .filter((e) => e.entity_id === change.entity_id)
      .first();

    if (outboxEntry && outboxEntry.fields) {
      const updatedFields = { ...outboxEntry.fields };
      let outboxMutated = false;

      for (const ow of merged.overwritten) {
        if (!(ow.field in updatedFields)) continue;

        const remoteAuthor = incoming.field_authors?.[ow.field];
        const remoteHlc = incomingFields[ow.field]?.hlc || '';
        const hlcMs = parseInt(remoteHlc.slice(0, 13), 10);
        const editTime = Number.isFinite(hlcMs) && hlcMs > 0
          ? new Date(hlcMs).toISOString()
          : nowIso();

        await db.conflicts.add({
          record_id:           change.entity_id,
          field:               ow.field,
          localValue:          ow.localValue,
          remoteValue:         ow.remoteValue,
          remote_user:         remoteAuthor?.user_id ?? incoming.created_by ?? null,
          remote_user_display: remoteAuthor?.display_name ?? null,
          at:                  editTime,
          seen:                0,
        });

        // Prune the losing field from the outbox so we never re-push it
        delete updatedFields[ow.field];
        outboxMutated = true;
      }

      if (outboxMutated) {
        if (Object.keys(updatedFields).length === 0) {
          await db.outbox.delete(outboxEntry.seq);
        } else {
          await db.outbox.update(outboxEntry.seq, { fields: updatedFields });
        }
      }
    }
  }

  // Merge field_authors: for each field in merged.fv, pick incoming author if incoming HLC won
  const mergedAuthors = { ...(local.field_authors || {}) };
  const incomingAuthors = incoming.field_authors || {};
  for (const [field, hlc] of Object.entries(merged.fv)) {
    if (incomingAuthors[field] && incomingAuthors[field].hlc === hlc) {
      mergedAuthors[field] = incomingAuthors[field];
    }
  }

  // Write merged record
  await db.records.put({
    ...local,
    data:          merged.data,
    fv:            merged.fv,
    field_authors: mergedAuthors,
    deleted:       merged.deleted,
    deleted_hlc:   merged.deleted_hlc,
  });

  return currentHlc;
}

/**
 * Apply an incoming track change from the pull response.
 * @returns {string|null} updated lastHlc
 */
async function _applyTrackChange(change, deviceId, lastHlc) {
  const incoming = change.state;
  const serverFv = incoming.fv || {};

  // Advance local HLC
  let currentHlc = lastHlc;
  for (const hlc of Object.values(serverFv)) {
    if (typeof hlc === 'string') {
      currentHlc = hlcReceive(hlc, currentHlc, deviceId);
    }
  }

  const local = await db.tracks.get(change.entity_id);

  if (!local) {
    // New track from server
    await db.tracks.put({
      id:          incoming.id,
      project_id:  incoming.project_id,
      name:        incoming.name,
      started_at:  incoming.started_at,
      ended_at:    incoming.ended_at   ?? null,
      status:      incoming.status,
      created_by:  incoming.created_by,
      fv:          { ...serverFv },
    });
    return currentHlc;
  }

  // Merge track metadata fields
  const trackFields = ['name', 'status', 'started_at', 'ended_at'];
  const localData = {
    name:       local.name,
    started_at: local.started_at,
    ended_at:   local.ended_at,
    status:     local.status,
  };
  const incomingFields = {};
  for (const field of trackFields) {
    if (serverFv[field]) {
      incomingFields[field] = { v: incoming[field], hlc: serverFv[field] };
    }
  }

  const merged = mergeFields(localData, local.fv || {}, incomingFields, false);

  await db.tracks.put({
    ...local,
    name:       merged.data.name       ?? local.name,
    started_at: merged.data.started_at ?? local.started_at,
    ended_at:   merged.data.ended_at   ?? null,
    status:     merged.data.status     ?? local.status,
    fv:         merged.fv,
  });

  return currentHlc;
}

/**
 * Apply an incoming media metadata change from the pull response.
 * Creates a row with upload_state:'remote' and blob:null.
 * Thumbnail download is deferred to Phase 7.
 */
async function _applyMediaChange(change) {
  const incoming = change.state;
  const existing = await db.media.get(change.entity_id);
  if (existing) return; // already have it (e.g. we uploaded it ourselves)

  await db.media.put({
    id:           incoming.id,
    record_id:    incoming.record_id,
    project_id:   incoming.project_id,
    mime:         incoming.mime,
    size:         incoming.size,
    width:        incoming.width  ?? null,
    height:       incoming.height ?? null,
    created_by:   incoming.created_by,
    created_at:   incoming.created_at,
    blob:         null,
    thumb_blob:   null,
    meta_synced:  true,
    upload_state: 'remote',
    deleted:      false,
  });
}

// ─── MEDIA UPLOAD ─────────────────────────────────────────────────────────────

/**
 * Upload pending media one-at-a-time.
 * - Recovers rows stuck in 'uploading' from a previous crash.
 * - Only uploads rows whose parent record is no longer pending in the outbox.
 * - 3 retries with linear backoff; marks 'error' if all attempts fail.
 */
async function _uploadMedia() {
  // Recover crashed uploads (stuck 'uploading')
  const stale = await db.media.where('upload_state').equals('uploading').toArray();
  for (const row of stale) {
    await db.media.update(row.id, { upload_state: 'pending' });
  }

  // Record IDs still pending in the outbox — don't upload before the creation push
  const pendingRecordIds = new Set(
    (await db.outbox.where('entity').equals('record').toArray()).map((r) => r.entity_id)
  );

  const pending = await db.media.where('upload_state').equals('pending').toArray();

  for (const media of pending) {
    // Skip if parent record creation not yet pushed
    if (pendingRecordIds.has(media.record_id)) continue;
    // Skip remote-only rows that have no local blob
    if (!media.blob) continue;

    await db.media.update(media.id, { upload_state: 'uploading' });

    let success  = false;
    let lastErr  = null;

    for (let attempt = 0; attempt < MEDIA_RETRIES; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MIN_MS * attempt);

      try {
        // PUT main blob
        await apiPutMedia(media.id, media.blob, {
          'X-Record-Id':  media.record_id,
          'X-Project-Id': media.project_id,
          'X-Mime':       media.mime,
          'X-Width':      String(media.width  ?? ''),
          'X-Height':     String(media.height ?? ''),
          'Content-Type': media.mime,
        });

        // PUT thumbnail blob if present
        if (media.thumb_blob) {
          await apiPutMedia(`${media.id}/thumb`, media.thumb_blob, {
            'Content-Type': media.mime,
          });
        }

        success = true;
        break;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        lastErr = err;
      }
    }

    if (success) {
      await db.media.update(media.id, {
        upload_state: 'done',
        meta_synced:  true,
      });
    } else {
      const msg = lastErr?.message || 'Upload failed';
      await db.media.update(media.id, {
        upload_state: 'error',
        upload_error: msg,
      });
      console.warn(`[sync] media ${media.id} upload failed after ${MEDIA_RETRIES} retries:`, msg);
    }
  }
}

// ─── TRACK POINTS UPLOAD ──────────────────────────────────────────────────────

/**
 * POST all unsynced track points to the server, grouped by track, in batches.
 * Idempotent by (track_id, idx) — the server deduplicates.
 */
async function _uploadTrackPoints() {
  const unsyncedPoints = await db.track_points.where('synced').equals(0).toArray();
  if (unsyncedPoints.length === 0) return;

  // Group by track_id
  const byTrack = new Map();
  for (const pt of unsyncedPoints) {
    if (!byTrack.has(pt.track_id)) byTrack.set(pt.track_id, []);
    byTrack.get(pt.track_id).push(pt);
  }

  for (const [trackId, points] of byTrack) {
    points.sort((a, b) => a.idx - b.idx);

    for (let i = 0; i < points.length; i += TRACK_PT_BATCH) {
      const batch = points.slice(i, i + TRACK_PT_BATCH);
      const payload = batch.map((p) => ({
        idx:      p.idx,
        lat:      p.lat,
        lng:      p.lng,
        accuracy: p.accuracy,
        altitude: p.altitude ?? null,
        ts:       p.ts,
      }));

      try {
        await apiPostTrackPoints(trackId, payload);
        // Mark synced=1 in a transaction
        await db.transaction('rw', db.track_points, async () => {
          for (const pt of batch) {
            await db.track_points.update([pt.track_id, pt.idx], { synced: 1 });
          }
        });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        // Keep for next cycle — don't abort other tracks
        console.warn(`[sync] track points upload failed for ${trackId}:`, err.message);
      }
    }
  }
}

// ─── Main sync cycle ──────────────────────────────────────────────────────────

/**
 * Run one full sync cycle (push → pull → media → track points).
 * Guarded by navigator.locks (or in-memory flag as fallback).
 */
export async function runSync({ manual = false } = {}) {
  // Don't sync if the user is not logged in
  const token = await getMeta('token');
  if (!token) return;

  // Don't sync if blocked by an AuthError until re-login
  if (_authBlocked) return;

  // Respect exponential backoff for automatic triggers
  if (!manual && _nextRetryAt > 0 && Date.now() < _nextRetryAt) return;
  if (manual) _resetBackoff();

  // Check real connectivity first
  const online = await _isConnected();
  if (!online) {
    await _setState({ status: 'offline', lastError: null });
    return;
  }

  // Concurrency guard
  const useLocks = typeof navigator?.locks?.request === 'function';

  if (useLocks) {
    await navigator.locks.request(
      'fieldsync-sync',
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return; // Another tab is syncing
        await _doSync();
      }
    );
  } else {
    if (_syncInProgress) return;
    _syncInProgress = true;
    try {
      await _doSync();
    } finally {
      _syncInProgress = false;
    }
  }
}

/**
 * The core sync work, called inside the concurrency lock.
 */
async function _doSync() {
  if (_authBlocked) return;

  await _setState({ status: 'syncing', lastError: null });

  try {
    const [deviceId, lastHlcStored] = await Promise.all([
      getMeta('device_id'),
      getMeta('hlc_last'),
    ]);

    // ── 1. PUSH ──────────────────────────────────────────────────────────
    const pushOk = await _push(deviceId);
    if (!pushOk) {
      _advanceBackoff();
      await _setState({ status: 'error', lastError: 'Push failed — will retry after backoff.' });
      return;
    }

    // ── 2. PULL ──────────────────────────────────────────────────────────
    await _pull(deviceId, lastHlcStored);
    _emit('pull', null);
    _updateConflictsBadge();

    // ── 3. MEDIA UPLOAD ──────────────────────────────────────────────────
    await _uploadMedia();

    // ── 4. TRACK POINTS ──────────────────────────────────────────────────
    await _uploadTrackPoints();

    // ── Success ──────────────────────────────────────────────────────────
    _resetBackoff();
    const now = nowIso();
    await setMeta('last_sync_at', now);
    await _setState({ status: 'idle', lastSyncAt: now, lastError: null });

  } catch (err) {
    if (err instanceof AuthError) {
      _authBlocked = true;
      await _setState({
        status:    'error',
        lastError: 'Session expired — sign in again to continue syncing.',
      });
      _showAuthExpiredBanner();
      return;
    }

    _advanceBackoff();
    const msg = err?.message || 'Sync failed';
    console.error('[sync] cycle error:', err);
    await _setState({ status: 'error', lastError: msg });
  }
}

// ─── Auth-expired banner ──────────────────────────────────────────────────────

function _showAuthExpiredBanner() {
  let banner = document.getElementById('auth-expired-banner');
  if (banner) return; // already shown

  banner = document.createElement('div');
  banner.id = 'auth-expired-banner';
  banner.className = 'offline-banner';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = 'position:sticky;top:0;z-index:200;border-radius:0;';
  banner.innerHTML = `
    <span aria-hidden="true">🔒</span>
    <span>Session expired — <a href="#/login" style="color:inherit;font-weight:600;text-decoration:underline">sign in again</a> to continue syncing.</span>
  `;
  document.body.insertBefore(banner, document.body.firstChild);

  // Remove when user navigates back (hash could be #/login or anything after re-login)
  const removeBanner = () => {
    if (window.location.hash.startsWith('#/login')) {
      banner?.remove();
      window.removeEventListener('hashchange', removeBanner);
    }
  };
  window.addEventListener('hashchange', removeBanner);
}

// ─── Sync badge in header ─────────────────────────────────────────────────────

function _updateHeaderBadge() {
  const badge   = document.getElementById('sync-badge');
  const countEl = document.getElementById('sync-badge-count');
  if (!badge) return;

  const { status, pendingChanges, pendingMedia, pendingPoints, lastSyncAt, lastError } = _state;
  const totalPending = pendingChanges + pendingMedia + pendingPoints;

  badge.hidden = false;
  badge.classList.toggle('syncing', status === 'syncing');

  let icon      = '↕';
  let countText = '';

  if (status === 'syncing') {
    icon      = '↻';
    countText = 'Syncing…';
  } else if (status === 'offline') {
    icon      = '⊘';
    countText = 'Offline';
  } else if (status === 'error') {
    icon      = '⚠';
    countText = 'Error';
  } else {
    // idle
    if (totalPending > 0) {
      countText = `${totalPending} pending`;
    } else if (lastSyncAt) {
      countText = _formatRelativeTime(lastSyncAt);
    } else {
      countText = 'Synced';
    }
  }

  const iconEl = badge.querySelector('.sync-badge__icon');
  if (iconEl) iconEl.textContent = icon;
  if (countEl) countEl.textContent = countText;

  badge.setAttribute(
    'aria-label',
    `Sync: ${status}${totalPending > 0 ? `, ${totalPending} pending` : ''}`
  );
  badge.title = (status === 'error' && lastError) ? lastError : '';
}

async function _updateConflictsBadge() {
  try {
    const all = await db.conflicts.toArray();
    const count = all.filter((c) => !c.seen).length;
    const nav = document.getElementById('conflicts-nav');
    const textEl = document.getElementById('conflicts-badge-text');
    if (!nav || !textEl) return;
    nav.hidden = count === 0;
    if (count > 0) {
      const label = `${count} change${count === 1 ? '' : 's'} from teammates overwrote yours`;
      textEl.textContent = label;
      nav.setAttribute('aria-label', label);
      nav.title = label;
    }
  } catch { /* ignore */ }
}

function _formatRelativeTime(isoString) {
  if (!isoString) return '';
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins   = Math.floor(diffMs / 60_000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs} h ago`;
    return `${Math.floor(hrs / 24)} d ago`;
  } catch {
    return '';
  }
}

// ─── Debounced post-write trigger ─────────────────────────────────────────────

/**
 * Call after any local write to trigger a debounced sync (2 s).
 */
export const triggerSync = debounce(() => runSync(), DEBOUNCE_MS);

// ─── Background Sync (progressive enhancement) ───────────────────────────────

function _registerBackgroundSync() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => {
      if (!reg.sync) return;
      return reg.sync.register('fieldsync-sync');
    })
    .catch(() => {}); // ignore — optional PE
}

// ─── Interval-based trigger ───────────────────────────────────────────────────

let _intervalId = null;

function _startInterval() {
  if (_intervalId) return;
  _intervalId = setInterval(() => {
    if (navigator.onLine) runSync();
  }, POLL_INTERVAL);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialise all sync triggers. Call once from app.js after auth init.
 * @returns {() => void}  teardown (clears interval + listeners)
 */
export function initSync() {
  // Restore lastSyncAt from meta for the badge
  getMeta('last_sync_at')
    .then((v) => {
      if (v) {
        _state.lastSyncAt = v;
        _emit('state', getState());
        _updateHeaderBadge();
      }
    })
    .catch(() => {});
  _updateConflictsBadge();

  // Badge click → go to settings
  const badge = document.getElementById('sync-badge');
  if (badge) {
    badge.addEventListener('click', () => {
      window.location.hash = '#/settings';
    });
  }

  // Online event
  const onOnline = () => runSync();
  window.addEventListener('online', onOnline);

  // Visibility change
  const onVisChange = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      runSync();
    }
  };
  document.addEventListener('visibilitychange', onVisChange);

  // 30-second interval
  _startInterval();

  // Listen for SW background-sync messages
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (evt) => {
      if (evt.data?.type === 'BACKGROUND_SYNC') runSync();
    });
  }

  // Register Background Sync tag (progressive enhancement)
  _registerBackgroundSync();

  // Kick off an initial sync immediately
  runSync();

  return function teardown() {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisChange);
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    if (_backoffTimer) { clearTimeout(_backoffTimer); _backoffTimer = null; }
  };
}
