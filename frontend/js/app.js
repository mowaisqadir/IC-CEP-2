// frontend/js/app.js
// Entry point: register SW, initialise Dexie, configure router, auth guard.

import { db, getMeta }    from './db.js';
import { router }         from './router.js';
import { initAuth, isLoggedIn } from './auth.js';
import { toast }          from './ui/components.js';
import { loginView }      from './ui/login.js';
import { projectsView }   from './ui/projects.js';
import { recordsView }    from './ui/records.js';
import { recordFormView, recordDetailView } from './ui/recordForm.js';
import { tracksView, trackDetailView }      from './ui/tracks.js';
import { settingsView }   from './ui/settings.js';
import { markInterruptedTracks, setWriteHook } from './repo.js';
import { initSync, triggerSync } from './sync.js';

// ─── Placeholder stubs for routes not yet built (Phase 1) ────────────────────
// These will be replaced in later phases with real view modules.

function stubView(title) {
  return async function (_params, container) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon" aria-hidden="true">🚧</div>
        <div class="empty-state__title">${title}</div>
        <div class="empty-state__msg">Coming in a future phase.</div>
      </div>`;
  };
}

// ─── Service Worker registration ──────────────────────────────────────────────

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      if (!newSW) return;

      newSW.addEventListener('statechange', () => {
        // A new SW is installed and waiting — there was already a controller
        // (i.e. the user is not on a first install).
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          _showUpdateToast(newSW);
        }
      });
    });

  } catch (err) {
    console.warn('[SW] Registration failed:', err);
  }

  // Reload once a new SW takes control
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

/** Show the non-blocking "New version available" toast. */
function _showUpdateToast(newSW) {
  toast.info('A new version is available.', {
    title:    'Update ready',
    duration: 0,              // never auto-dismiss
    action:   'Reload',
    onAction: () => {
      newSW.postMessage({ type: 'SKIP_WAITING' });
    },
  });
}

// ─── Online / Offline indicator ───────────────────────────────────────────────

function initConnectivityIndicator() {
  const pill  = document.getElementById('online-pill');
  const label = document.getElementById('online-label');

  function update() {
    const online = navigator.onLine;
    pill.classList.toggle('offline', !online);
    label.textContent = online ? 'Online' : 'Offline';
  }

  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ─── App chrome visibility ────────────────────────────────────────────────────

function showChrome() {
  document.getElementById('app-header').hidden = false;
  document.getElementById('bottom-nav').hidden  = false;
  document.body.classList.remove('no-chrome');
}

function hideChrome() {
  document.getElementById('app-header').hidden = true;
  document.getElementById('bottom-nav').hidden  = true;
  document.body.classList.add('no-chrome');
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

/**
 * Wrap a view function with an auth guard.
 * Unauthenticated users are redirected to #/login.
 *
 * @param {Function} viewFn
 * @returns {Function}
 */
function guarded(viewFn) {
  return async function (params, container) {
    if (!isLoggedIn()) {
      window.location.hash = '#/login';
      return;
    }
    showChrome();
    return viewFn(params, container);
  };
}

// ─── Main init ────────────────────────────────────────────────────────────────

async function main() {
  // 1. Open IndexedDB (Dexie), hydrate auth, and mark any crashed recordings interrupted.
  await db.open();
  await initAuth();
  await markInterruptedTracks();

  // 2. Register service worker (non-blocking for the rest of init)
  registerServiceWorker();

  // 3. Online/offline pill
  initConnectivityIndicator();

  // 3b. Initialise sync engine (triggers, badge, background sync)
  //     Must come after initAuth() so the token is hydrated.
  setWriteHook(triggerSync);
  initSync();

  // 4. Configure routes
  router
    .on('#/login', async (params, container) => {
      hideChrome();
      // If already logged in, skip to projects
      if (isLoggedIn()) {
        window.location.hash = '#/projects';
        return;
      }
      await loginView(params, container);
    })

    .on('#/projects',                 guarded(projectsView))
    .on('#/records',                  guarded(async () => {
      const lastProjectId = await getMeta('last_project_id');
      if (lastProjectId) {
        window.location.hash = `#/p/${encodeURIComponent(lastProjectId)}/records`;
      } else {
        toast.info('Select a project to view its records.');
        window.location.hash = '#/projects';
      }
    }))
    .on('#/p/:projectId/records',     guarded(recordsView))
    .on('#/p/:projectId/records/new', guarded(recordFormView))
    .on('#/r/:recordId',              guarded(recordDetailView))
    .on('#/r/:recordId/edit',         guarded(recordFormView))
    .on('#/tracks',                   guarded(async () => {
      const lastProjectId = await getMeta('last_project_id');
      if (lastProjectId) {
        window.location.hash = `#/p/${encodeURIComponent(lastProjectId)}/tracks`;
      } else {
        toast.info('Select a project to view its tracks.');
        window.location.hash = '#/projects';
      }
    }))
    .on('#/p/:projectId/tracks',      guarded(tracksView))
    .on('#/t/:trackId',               guarded(trackDetailView))
    .on('#/settings',                 guarded(settingsView))

    .notFound(async (_p, container) => {
      // If the user typed a bare hash or nothing, redirect based on auth state.
      if (!window.location.hash || window.location.hash === '#') {
        window.location.hash = isLoggedIn() ? '#/projects' : '#/login';
        return;
      }
      hideChrome();
      container.innerHTML = `
        <div class="empty-state" style="margin-top:40px">
          <div class="empty-state__icon">🗺️</div>
          <div class="empty-state__title">Page not found</div>
          <div class="empty-state__msg">
            <a href="${isLoggedIn() ? '#/projects' : '#/login'}">Go home</a>
          </div>
        </div>`;
    })

    .start();
}

main().catch((err) => {
  console.error('[app] Fatal init error:', err);
  document.getElementById('view').innerHTML = `
    <div class="empty-state" style="margin-top:80px">
      <div class="empty-state__icon">💥</div>
      <div class="empty-state__title">Failed to start FieldSync</div>
      <div class="empty-state__msg">${err.message}</div>
    </div>`;
});
