// frontend/js/router.js
// Tiny hash-based SPA router.
//
// Supported routes (from PROJECT_CONTEXT.md §8):
//   #/login
//   #/projects
//   #/p/:projectId/records
//   #/p/:projectId/records/new
//   #/r/:recordId
//   #/p/:projectId/tracks
//   #/settings
//
// Usage:
//   import { router } from './router.js';
//   router.on('#/projects', projectsView);
//   router.start();
//
// Each viewFn is called as:
//   await viewFn(params, container)
// where params is {projectId?, recordId?, ...} and container is the #view element.
//
// Cleanup hooks:
//   The previously active view can register a teardown via router.onCleanup(fn).
//   The router calls it before mounting the next view.

/** @type {Array<{pattern: RegExp, keys: string[], fn: Function}>} */
const _routes = [];

/** @type {Function|null} */
let _currentCleanup = null;

/** @type {HTMLElement|null} */
let _container = null;

/** @type {Function|null} */
let _notFoundFn = null;

// ─── Pattern compiler ─────────────────────────────────────────────────────────

/**
 * Convert a route string like "#/p/:id/records" into a RegExp and
 * an ordered list of param names.
 *
 * @param {string} route
 * @returns {{ pattern: RegExp, keys: string[] }}
 */
function compileRoute(route) {
  const keys = [];
  const src = route
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\\:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { pattern: new RegExp(`^${src}$`), keys };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const router = {
  /**
   * Register a route.
   * @param {string}   route  - e.g. '#/p/:projectId/records'
   * @param {Function} fn     - async (params, container) => void
   */
  on(route, fn) {
    const { pattern, keys } = compileRoute(route);
    _routes.push({ pattern, keys, fn });
    return this;
  },

  /**
   * Register a 404 fallback.
   * @param {Function} fn
   */
  notFound(fn) {
    _notFoundFn = fn;
    return this;
  },

  /**
   * Register a cleanup hook for the CURRENT view.
   * Call this inside your viewFn if you have intervals, listeners, etc.
   * @param {Function} fn
   */
  onCleanup(fn) {
    _currentCleanup = fn;
    return this;
  },

  /**
   * Start the router.  Renders the initial hash and listens for changes.
   * @param {HTMLElement} [container] - defaults to document.getElementById('view')
   */
  start(container) {
    _container = container || document.getElementById('view');
    window.addEventListener('hashchange', () => this._dispatch());
    this._dispatch();
    return this;
  },

  /**
   * Navigate programmatically.
   * @param {string} hash  - e.g. '#/projects'
   */
  navigate(hash) {
    window.location.hash = hash;
  },

  // ─── Internal ───────────────────────────────────────────────────────────────

  async _dispatch() {
    const hash = window.location.hash || '#/login';

    // Run cleanup for the previous view
    if (typeof _currentCleanup === 'function') {
      try { await _currentCleanup(); } catch (e) { console.warn('[router] cleanup error', e); }
      _currentCleanup = null;
    }

    // Show loading state while async view renders
    if (_container) {
      _container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    }

    // Match route
    for (const { pattern, keys, fn } of _routes) {
      const m = hash.match(pattern);
      if (!m) continue;

      // Build params object
      const params = {};
      keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      // Update bottom nav active state
      _updateNavActive(hash);

      try {
        await fn(params, _container);
      } catch (err) {
        console.error('[router] view error', err);
        if (_container) {
          _container.innerHTML = `
            <div class="empty-state">
              <div class="empty-state__icon">⚠️</div>
              <div class="empty-state__title">Something went wrong</div>
              <div class="empty-state__msg">${err.message}</div>
            </div>`;
        }
      }
      return;
    }

    // No match
    if (_notFoundFn) {
      await _notFoundFn({}, _container);
    } else if (_container) {
      _container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">🗺️</div>
          <div class="empty-state__title">Page not found</div>
          <div class="empty-state__msg">Route: ${hash}</div>
        </div>`;
    }
  },
};

// ─── Nav active state ─────────────────────────────────────────────────────────

function _updateNavActive(hash) {
  document.querySelectorAll('.bottom-nav__item').forEach((el) => {
    el.classList.remove('active');
    el.removeAttribute('aria-current');
    const route = el.dataset.route;
    if (!route) return;
    if (hash.startsWith(`#/${route}`)) {
      el.classList.add('active');
      el.setAttribute('aria-current', 'page');
    }
  });
}
