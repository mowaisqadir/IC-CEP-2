// frontend/js/auth.js
// Login / logout logic, token + user storage.
//
// Token storage uses getToken()/setToken()/clearToken() from api.js
// (Phase 1: localStorage).  Phase 3 swap: change those three functions
// in api.js to use Dexie meta — zero changes needed here.
//
// User object is stored separately in localStorage (key 'fieldsync_user')
// so it survives a full page reload while offline.  Phase 3 swap: mirror
// it also into db.meta with key 'user'.

import { apiLogin, setToken, clearToken, getToken } from './api.js';

const LS_USER_KEY = 'fieldsync_user';

// ─── User helpers ─────────────────────────────────────────────────────────────

/**
 * Store the user object returned by the login endpoint.
 * @param {object} user  - {id, username, display_name}
 */
export function setUser(user) {
  try {
    localStorage.setItem(LS_USER_KEY, JSON.stringify(user));
  } catch { /* ignore */ }
}

/**
 * Read the stored user (may be null when not logged in or storage cleared).
 * @returns {{ id: string, username: string, display_name: string }|null}
 */
export function getUser() {
  try {
    const raw = localStorage.getItem(LS_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Remove all auth credentials (token + user).
 */
export function clearAuth() {
  clearToken();
  try {
    localStorage.removeItem(LS_USER_KEY);
  } catch { /* ignore */ }
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
 * Attempt to log in.  Calls POST /api/auth/login.
 *
 * On success: stores token + user and returns the user object.
 * On failure: re-throws (NetworkError / AuthError / HttpError).
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ id:string, username:string, display_name:string }>}
 */
export async function login(username, password) {
  // apiLogin does NOT attach the Bearer header (no token yet).
  const data = await apiLogin(username, password);
  // data = { token: "...", user: { id, username, display_name } }
  setToken(data.token);
  setUser(data.user);
  return data.user;
}

// ─── Logout action ────────────────────────────────────────────────────────────

/**
 * Log out the current user.
 * Clears local credentials and redirects to the login route.
 * Does NOT call a server endpoint (stateless JWT).
 */
export function logout() {
  clearAuth();
  window.location.hash = '#/login';
}
