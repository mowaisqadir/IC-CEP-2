// frontend/js/media.js
// Offline photo capture, resizing, thumbnail generation, and Dexie media helpers.
// Note: Remote deletion of media is out of scope for v1 (soft-delete is local only).

import { db, getMeta, setMeta } from './db.js';
import { notifyWrite }            from './repo.js';
import { apiGetMediaThumb, apiGetMediaFull } from './api.js';
import { uuid, nowIso }          from './utils.js';

export const MAX_IMAGE_EDGE = 1600;
export const THUMB_EDGE     = 320;
export const JPEG_QUALITY   = 0.72;
export const MIN_FREE_BYTES = 20 * 1024 * 1024; // 20 MB

// ─── Storage quota & persistence ──────────────────────────────────────────────

/**
 * Inspect browser storage estimate and persistence status.
 * @returns {Promise<{
 *   supported: boolean,
 *   usage: number,
 *   quota: number,
 *   remaining: number | null,
 *   usagePct: number,
 *   persisted: boolean | null,
 *   persistDenied: boolean,
 *   lowSpace: boolean,
 * }>}
 */
export async function getStorageStatus() {
  const persistDenied = Boolean(await getMeta('storage_persist_denied'));

  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return {
      supported: false,
      usage: 0,
      quota: 0,
      remaining: null,
      usagePct: 0,
      persisted: null,
      persistDenied,
      lowSpace: false,
    };
  }

  const est       = await navigator.storage.estimate();
  const usage     = est.usage ?? 0;
  const quota     = est.quota ?? 0;
  const remaining = quota > 0 ? Math.max(0, quota - usage) : null;
  const usagePct  = quota > 0 ? (usage / quota) * 100 : 0;

  let persisted = null;
  if (typeof navigator.storage.persisted === 'function') {
    try {
      persisted = await navigator.storage.persisted();
    } catch {
      persisted = null;
    }
  }

  return {
    supported: true,
    usage,
    quota,
    remaining,
    usagePct,
    persisted,
    persistDenied: persistDenied && persisted !== true,
    lowSpace: remaining !== null && remaining < MIN_FREE_BYTES,
  };
}

/**
 * Request persistent storage from the browser and record if denied.
 * @returns {Promise<boolean | null>}
 */
export async function requestPersistentStorage() {
  if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
    return null;
  }
  try {
    const granted = await navigator.storage.persist();
    await setMeta('storage_persist_denied', !granted);
    return granted;
  } catch {
    await setMeta('storage_persist_denied', true);
    return false;
  }
}

/**
 * Assert at least 20 MB of storage remains before saving a new photo.
 */
export async function assertSufficientStorage() {
  const status = await getStorageStatus();
  if (status.lowSpace) {
    const remMb = (status.remaining / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Storage almost full (${remMb} MB remaining; 20 MB minimum required). Free up space before adding photos.`
    );
  }
}

// ─── Image decoding & resizing ────────────────────────────────────────────────

function _fitDimensions(srcW, srcH, maxEdge) {
  const longest = Math.max(srcW, srcH);
  if (longest <= maxEdge) {
    return { width: srcW, height: srcH };
  }
  const scale = maxEdge / longest;
  return {
    width:  Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

async function _renderToJpegBlob(bitmap, width, height, quality) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode JPEG image.'))),
      'image/jpeg',
      quality
    );
  });
}

/**
 * Decode an image File (respecting EXIF orientation), downscale to <= 1600px,
 * and generate both the main JPEG blob and a <= 320px thumbnail blob.
 *
 * @param {File|Blob} file
 * @returns {Promise<{
 *   blob: Blob,
 *   thumb_blob: Blob,
 *   width: number,
 *   height: number,
 *   size: number,
 *   mime: string,
 * }>}
 */
export async function processImage(file) {
  if (!file) throw new Error('No image file provided.');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  try {
    const mainDims  = _fitDimensions(bitmap.width, bitmap.height, MAX_IMAGE_EDGE);
    const thumbDims = _fitDimensions(bitmap.width, bitmap.height, THUMB_EDGE);

    const [blob, thumb_blob] = await Promise.all([
      _renderToJpegBlob(bitmap, mainDims.width, mainDims.height, JPEG_QUALITY),
      _renderToJpegBlob(bitmap, thumbDims.width, thumbDims.height, JPEG_QUALITY),
    ]);

    return {
      blob,
      thumb_blob,
      width:  mainDims.width,
      height: mainDims.height,
      size:   blob.size,
      mime:   'image/jpeg',
    };
  } finally {
    bitmap.close();
  }
}

// ─── Media Dexie CRUD ─────────────────────────────────────────────────────────

/**
 * Process an image file and store it in `db.media` in a single transaction.
 *
 * @param {string}    recordId
 * @param {File|Blob} file
 * @returns {Promise<object>}
 */
export async function addPhoto(recordId, file) {
  await assertSufficientStorage();

  const processed = await processImage(file);

  const row = await db.transaction('rw', db.media, db.records, db.meta, async () => {
    const record = await db.records.get(recordId);
    if (!record) {
      throw new Error(`Record not found: ${recordId}`);
    }

    const userRow   = await db.meta.get('user');
    const createdBy = userRow?.value?.id ?? 'unknown';

    const mediaRow = {
      id:           uuid(),
      record_id:    recordId,
      project_id:   record.project_id,
      mime:         processed.mime,
      size:         processed.size,
      width:        processed.width,
      height:       processed.height,
      blob:         processed.blob,
      thumb_blob:   processed.thumb_blob,
      created_by:   createdBy,
      created_at:   nowIso(),
      upload_state: 'pending',
      meta_synced:  false,
      deleted:      false,
    };

    await db.media.add(mediaRow);
    return mediaRow;
  });
  notifyWrite();
  return row;
}

/**
 * List non-deleted media attachments for a record, oldest first.
 *
 * @param {string} recordId
 * @returns {Promise<Array<object>>}
 */
export async function listMediaForRecord(recordId) {
  const rows = await db.media.where('record_id').equals(recordId).toArray();
  return rows
    .filter((m) => !m.deleted)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

/**
 * Soft-delete a photo locally.
 * Remote deletion of media is out of scope for v1.
 *
 * @param {string} mediaId
 * @returns {Promise<void>}
 */
export async function softDeleteMedia(mediaId) {
  await db.media.update(mediaId, { deleted: true });
}

/**
 * Download thumbnail for a 'remote' media row (upload_state='remote', thumb_blob=null).
 * Online-only. Stores thumb_blob in Dexie.
 * @param {string} mediaId
 * @returns {Promise<Blob|null>}
 */
export async function fetchAndStoreThumb(mediaId) {
  if (!navigator.onLine) return null;
  try {
    const blob = await apiGetMediaThumb(mediaId);
    await db.media.update(mediaId, { thumb_blob: blob });
    return blob;
  } catch {
    return null;
  }
}

/**
 * Download full-resolution image for a 'remote' media row.
 * Online-only. Stores blob in Dexie.
 * @param {string} mediaId
 * @returns {Promise<Blob|null>}
 */
export async function fetchAndStoreFull(mediaId) {
  if (!navigator.onLine) return null;
  try {
    const blob = await apiGetMediaFull(mediaId);
    await db.media.update(mediaId, { blob });
    return blob;
  } catch {
    return null;
  }
}

/**
 * Prefetch all missing thumbnails for a project (for offline use).
 * Respects the storage quota check from Phase 4.
 * @param {string} projectId
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ done: number, failed: number, total: number }>}
 */
export async function prefetchProjectThumbs(projectId, onProgress) {
  await assertSufficientStorage();

  const all = await db.media.where('project_id').equals(projectId).toArray();
  const needsThumb = all.filter(
    (m) => !m.deleted && m.upload_state === 'remote' && !m.thumb_blob
  );

  const total = needsThumb.length;
  if (onProgress) onProgress(0, total);
  if (total === 0) return { done: 0, failed: 0, total: 0 };

  let done = 0;
  let failed = 0;

  for (const m of needsThumb) {
    await assertSufficientStorage();
    const result = await fetchAndStoreThumb(m.id);
    if (result) done += 1;
    else failed += 1;
    if (onProgress) onProgress(done + failed, total);
  }

  return { done, failed, total };
}

/**
 * Format byte count into human-readable KB / MB / GB.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
