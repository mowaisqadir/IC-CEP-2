// frontend/js/api.js
// fetch() wrappers for every backend endpoint.
// ONLY this file and sync.js may call fetch() or any network API.
//
// Token strategy:
//   Phase 1 (now): in-memory + localStorage fallback.
//   Phase 3 swap:  replace getToken()/setToken() internals to read from
//                  Dexie meta table (db.meta.get('token')) without
//                  changing any caller.

import { getMeta, setMeta, deleteMeta } from './db.js';

// ─── Typed error classes ──────────────────────────────────────────────────────

export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class AuthError extends Error {
  constructor(message = 'Unauthorised') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {any}    [body]
   */
  constructor(status, message, body) {
    super(message);
    this.name   = 'HttpError';
    this.status = status;
    this.body   = body;
  }
}

// ─── Token store (Dexie meta + in-memory cache) ───────────────────────────────
// Callers MUST use getToken()/setToken()/clearToken().
// hydrateToken() is awaited once at app startup after db.open().

let _memToken = null;

/**
 * Hydrate the in-memory token from Dexie `meta` on startup.
 * @returns {Promise<string|null>}
 */
export async function hydrateToken() {
  _memToken = await getMeta('token');
  return _memToken;
}

/**
 * Read the current JWT (synchronous in-memory cache, hydrated from Dexie meta).
 * @returns {string|null}
 */
export function getToken() {
  return _memToken;
}

/**
 * Persist a JWT to in-memory cache and Dexie `meta`.
 * @param {string} token
 * @returns {Promise<void>}
 */
export function setToken(token) {
  _memToken = token;
  return setMeta('token', token).catch((err) => {
    console.warn('[api] Failed to persist token in meta:', err);
  });
}

/**
 * Remove the stored JWT (logout).
 * @returns {Promise<void>}
 */
export function clearToken() {
  _memToken = null;
  return deleteMeta('token').catch((err) => {
    console.warn('[api] Failed to clear token from meta:', err);
  });
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

const BASE_URL = '/api';

/**
 * Internal fetch wrapper.
 *
 * @param {string} path   - e.g. '/auth/login'
 * @param {RequestInit} [init]
 * @returns {Promise<any>}  Parsed JSON body
 * @throws {NetworkError|AuthError|HttpError}
 */
async function apiFetch(path, init = {}) {
  const url = `${BASE_URL}${path}`;

  const headers = new Headers(init.headers || {});

  // Inject Bearer token when available
  const token = getToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Default content-type for JSON bodies
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (err) {
    // fetch() itself throws only on network-level failure
    throw new NetworkError(err.message || 'Network request failed');
  }

  // 401 → AuthError
  if (response.status === 401) {
    throw new AuthError();
  }

  // Parse body
  const contentType = response.headers.get('content-type') || '';
  let body;
  if (contentType.includes('application/json')) {
    body = await response.json().catch(() => null);
  } else {
    body = await response.text().catch(() => null);
  }

  if (!response.ok) {
    const message =
      (body && (body.detail || body.message)) ||
      `HTTP ${response.status}`;
    throw new HttpError(response.status, message, body);
  }

  return body;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

/**
 * GET /api<path>
 * @param {string} path
 * @returns {Promise<any>}
 */
export function apiGet(path) {
  return apiFetch(path, { method: 'GET' });
}

/**
 * POST /api<path> with a JSON body.
 * @param {string} path
 * @param {any}    data
 * @returns {Promise<any>}
 */
export function apiPost(path, data) {
  return apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * PUT /api<path> with a JSON body.
 * @param {string} path
 * @param {any}    data
 * @returns {Promise<any>}
 */
export function apiPut(path, data) {
  return apiFetch(path, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * PUT /api<path> with raw binary body (media upload).
 * @param {string}            path
 * @param {Blob|ArrayBuffer}  blob
 * @param {Record<string,string>} extraHeaders
 * @returns {Promise<any>}
 */
export function apiPutRaw(path, blob, extraHeaders = {}) {
  return apiFetch(path, {
    method: 'PUT',
    body: blob,
    headers: extraHeaders,
  });
}

// ─── Endpoint-specific helpers ────────────────────────────────────────────────

/** POST /api/auth/login */
export function apiLogin(username, password) {
  return apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/auth/me */
export function apiMe() {
  return apiGet('/auth/me');
}

/** GET /api/projects */
export function apiGetProjects() {
  return apiGet('/projects');
}

/** POST /api/sync/push */
export function apiSyncPush(payload) {
  return apiPost('/sync/push', payload);
}

/** GET /api/sync/pull?since=<seq>&limit=<n> */
export function apiSyncPull(since = 0, limit = 200) {
  return apiGet(`/sync/pull?since=${since}&limit=${limit}`);
}

/** PUT /api/media/:id  (raw binary) */
export function apiPutMedia(id, blob, headers = {}) {
  return apiPutRaw(`/media/${id}`, blob, headers);
}

/**
 * Internal binary GET helper for media endpoints.
 * @param {string} path
 * @returns {Promise<Blob>}
 */
async function apiGetBlob(path) {
  const url = `${BASE_URL}${path}`;
  const headers = new Headers();
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response;
  try {
    response = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw new NetworkError(err.message || 'Network request failed');
  }

  if (response.status === 401) {
    throw new AuthError();
  }
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`);
  }
  return response.blob();
}

/** GET /api/media/:id/thumb (raw binary) */
export function apiGetMediaThumb(id) {
  return apiGetBlob(`/media/${encodeURIComponent(id)}/thumb`);
}

/** GET /api/media/:id (raw binary, full resolution) */
export function apiGetMediaFull(id) {
  return apiGetBlob(`/media/${encodeURIComponent(id)}`);
}

/** POST /api/tracks/:id/points */
export function apiPostTrackPoints(trackId, points) {
  return apiPost(`/tracks/${trackId}/points`, { points });
}

/** GET /api/health */
export function apiHealth() {
  return apiGet('/health');
}
