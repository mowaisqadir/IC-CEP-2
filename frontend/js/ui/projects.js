// frontend/js/ui/projects.js
// Project list screen view.
// Called by router as: projectsView(params, container)
//
// Phase 1 behaviour:
//   - When ONLINE: GET /api/projects → render cards.
//   - When OFFLINE: show "you're offline" empty state.
//
// TODO Phase 3 — IndexedDB caching hook:
//   1. After a successful apiGetProjects() call, upsert each project into
//      db.projects (repo.upsertProject or db.projects.bulkPut).
//   2. When offline (or the network call fails), read from db.projects
//      instead of showing the empty state.
//   3. Update the page-header badge with the pending outbox count.

import { apiGetProjects }                     from '../api.js';
import { NetworkError }                        from '../api.js';
import { toast, createPageHeader,
         createEmptyState, createLoadingState,
         createErrorState }                    from './components.js';
import { formatDate }                          from '../utils.js';
import { getUser }                             from '../auth.js';

/**
 * @param {object}      _params
 * @param {HTMLElement} container  - #view element
 */
export async function projectsView(_params, container) {
  container.innerHTML = '';

  // ── Page header ──────────────────────────────────────────────────────────
  const header = createPageHeader({ title: 'Projects' });
  container.appendChild(header);

  // ── Loading state ────────────────────────────────────────────────────────
  const loadingEl = createLoadingState('Loading projects…');
  container.appendChild(loadingEl);

  if (!navigator.onLine) {
    loadingEl.replaceWith(
      createEmptyState({
        icon:    '📡',
        title:   'You\'re offline',
        message: 'Projects will appear here once you connect and sync.',
      })
    );
    // TODO Phase 3: attempt to read from db.projects here and render cards
    // even without a network connection.
    return;
  }

  let projects;
  try {
    const res = await apiGetProjects();
    projects = Array.isArray(res) ? res : (res?.projects ?? []);
  } catch (err) {
    console.error('[projects] fetch error', err);

    if (err instanceof NetworkError) {
      loadingEl.replaceWith(
        createEmptyState({
          icon:    '📡',
          title:   'No connection',
          message: 'Could not load projects. Check your network and try again.',
        })
      );
    } else {
      loadingEl.replaceWith(
        createErrorState(err, () => projectsView(_params, container))
      );
    }
    // TODO Phase 3: fall back to db.projects on any network error
    return;
  }

  loadingEl.remove();

  if (!projects || projects.length === 0) {
    container.appendChild(
      createEmptyState({
        icon:    '📂',
        title:   'No projects yet',
        message: 'Ask your team lead to add you to a project.',
      })
    );
    return;
  }

  // TODO Phase 3: await repo.upsertProjects(projects) — cache for offline use

  // ── Render project cards ─────────────────────────────────────────────────
  const list = document.createElement('div');
  list.className = 'list';

  for (const project of projects) {
    list.appendChild(_buildProjectCard(project));
  }

  container.appendChild(list);

  // ── Greeting toast (first load only) ────────────────────────────────────
  const user = getUser();
  if (user && sessionStorage.getItem('fs_greeted') !== '1') {
    sessionStorage.setItem('fs_greeted', '1');
    toast.success(`Welcome back, ${user.display_name || user.username}!`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a project card element.
 * @param {{ id:string, name:string, region:string, description?:string }} project
 * @returns {HTMLElement}
 */
function _buildProjectCard(project) {
  const card = document.createElement('a');
  card.className   = 'card card--clickable';
  card.href        = `#/p/${project.id}/records`;
  card.setAttribute('aria-label', `Open project ${project.name}`);

  card.innerHTML = `
    <div class="card__title">${_esc(project.name)}</div>
    <div class="card__subtitle">📍 ${_esc(project.region || 'No region')}</div>
    ${project.description
      ? `<div class="card__meta">${_esc(project.description)}</div>`
      : ''}
  `;

  return card;
}

/** Quick HTML escape (avoids importing escapeHtml again for tiny usage). */
function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
