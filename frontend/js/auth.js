// frontend/js/auth.js
// Login / logout logic, token + user storage in Dexie `meta`.

import {
  apiLogin,
  hydrateToken,
  setToken,
  clearToken,
  getToken,
} from './api.js';
import { getMeta, setMeta, deleteMeta, isQuotaExceededError } from './db.js';

let _memUser = null;

/**
 * Hydrate token and user from Dexie `meta` on app startup (after db.open()).
 * @returns {Promise<void>}
 */
export async function initAuth() {
  await hydrateToken();
  _memUser = await getMeta('user');
}

// ─── User helpers ─────────────────────────────────────────────────────────────

/**
 * Store the user object returned by the login endpoint in Dexie `meta`.
 * @param {object} user  - {id, username, display_name}
 * @returns {Promise<void>}
 */
export function setUser(user) {
  _memUser = user;
  return setMeta('user', user).catch((err) => {
    if (isQuotaExceededError(err)) throw err;
    console.warn('[auth] Failed to persist user in meta:', err);
  });
}

/**
 * Read the stored user (may be null when not logged in or storage cleared).
 * @returns {{ id: string, username: string, display_name: string }|null}
 */
export function getUser() {
  return _memUser;
}

/**
 * Remove all auth credentials (token + user) from Dexie `meta`.
 * Does NOT delete offline records, projects, or outbox entries.
 * @returns {Promise<void>}
 */
export async function clearAuth() {
  _memUser = null;
  await Promise.all([
    clearToken(),
    deleteMeta('user').catch((err) => {
      console.warn('[auth] Failed to clear user from meta:', err);
    }),
  ]);
}

// ─── Auth state check ─────────────────────────────────────────────────────────

/**
 * Returns true when the app considers the user logged in.
 * A token presence is used as the proxy — the server validates it on each
 * API call; we don't re-validate it locally to allow full offline operation.
 *
 * @returns {boolean}
 */
export function isLoggedIn() {
  return Boolean(getToken());
}

// ─── Login action ─────────────────────────────────────────────────────────────

/**
 * Attempt to log in. Calls POST /api/auth/login.
 *
 * On success: stores token + user in Dexie `meta` and returns the user object.
 * On failure: re-throws (NetworkError / AuthError / HttpError).
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ id:string, username:string, display_name:string }>}
 */
export async function login(username, password) {
  const data = await apiLogin(username, password);
  await setToken(data.token);
  await setUser(data.user);
  return data.user;
}

// ─── Logout action ────────────────────────────────────────────────────────────

/**
 * Log out the current user.
 * Clears local credentials from `meta` and redirects to the login route.
 * Does NOT call a server endpoint (stateless JWT) and does NOT delete
 * unsynced offline data.
 */
export async function logout() {
  await clearAuth();
  window.location.hash = '#/login';
}
