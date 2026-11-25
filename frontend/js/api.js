// frontend/js/api.js
// fetch() wrappers for every backend endpoint.
// ONLY this file and sync.js may call fetch() or any network API.
//
// Token strategy:
//   Phase 1 (now): in-memory + localStorage fallback.
//   Phase 3 swap:  replace getToken()/setToken() internals to read from
//                  Dexie meta table (db.meta.get('token')) without
//                  changing any caller.

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

// ─── Token store (Phase 1 implementation) ────────────────────────────────────
// Callers MUST use getToken()/setToken()/clearToken().
// Phase 3: swap the bodies of these three functions to use Dexie without
// changing any caller.

const LS_KEY = 'fieldsync_token';

let _memToken = null;

/**
 * Read the current JWT (in-memory first, then localStorage).
 * @returns {string|null}
 */
export function getToken() {
  if (_memToken) return _memToken;
  try {
    _memToken = localStorage.getItem(LS_KEY);
  } catch {
    // localStorage blocked (private mode edge case)
  }
  return _memToken;
}

/**
 * Persist a JWT.
 * @param {string} token
 */
export function setToken(token) {
  _memToken = token;
  try {
    localStorage.setItem(LS_KEY, token);
  } catch { /* ignore */ }
}

/**
 * Remove the stored JWT (logout).
 */
export function clearToken() {
  _memToken = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch { /* ignore */ }
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

/** POST /api/tracks/:id/points */
export function apiPostTrackPoints(trackId, points) {
  return apiPost(`/tracks/${trackId}/points`, { points });
}

/** GET /api/health */
export function apiHealth() {
  return apiGet('/health');
}
