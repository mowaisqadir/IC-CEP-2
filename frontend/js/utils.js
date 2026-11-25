// frontend/js/utils.js
// Shared utilities: uuid(), formatDate(), debounce(), etc.

/**
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() when available (all modern browsers),
 * falls back to a manual approach.
 *
 * @returns {string} UUID v4 e.g. "550e8400-e29b-41d4-a716-446655440000"
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback — not cryptographically ideal but good enough for old WebViews
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Return current wall-clock time as an ISO 8601 UTC string.
 * Always use this instead of new Date() to keep the contract
 * (ISO 8601 strings in UTC, never Date objects across modules).
 *
 * @returns {string}  e.g. "2024-06-01T14:30:00.000Z"
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Format an ISO 8601 date string for display.
 *
 * @param {string} isoString
 * @param {object} [opts]
 * @param {boolean} [opts.time=true] - include time
 * @returns {string}
 */
export function formatDate(isoString, { time = true } = {}) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    const dateStr = d.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    if (!time) return dateStr;
    const timeStr = d.toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit',
    });
    return `${dateStr} ${timeStr}`;
  } catch {
    return isoString;
  }
}

/**
 * Debounce a function.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Throttle a function — calls at most once per `ms`.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function throttle(fn, ms) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      return fn.apply(this, args);
    }
  };
}

/**
 * Sleep for `ms` milliseconds (returns a Promise).
 * Useful for retry back-off.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape HTML special characters to prevent XSS when setting innerHTML.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
