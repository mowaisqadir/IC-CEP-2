// frontend/js/ui/projects.js
// Project list screen view.
// Called by router as: projectsView(params, container)
//
// Caches fetched projects into IndexedDB (db.projects) and renders from
// IndexedDB so the project list works offline.

import { apiGetProjects, NetworkError }        from '../api.js';
import { upsertProjects, listProjects }        from '../repo.js';
import { toast, createPageHeader,
         createEmptyState, createLoadingState,
         createErrorState }                    from './components.js';
import { getUser }                             from '../auth.js';

/**
 * @param {object}      _params
 * @param {HTMLElement} container  - #view element
 */
export async function projectsView(_params, container) {
  container.innerHTML = '';

  const header = createPageHeader({ title: 'Projects' });
  container.appendChild(header);

  const loadingEl = createLoadingState('Loading projects…');
  container.appendChild(loadingEl);

  let fetchError = null;
  if (navigator.onLine) {
    try {
      const res = await apiGetProjects();
      const fetched = Array.isArray(res) ? res : (res?.projects ?? []);
      await upsertProjects(fetched);
    } catch (err) {
      console.error('[projects] fetch error', err);
      fetchError = err;
    }
  }

  const projects = await listProjects();
  loadingEl.remove();

  if (!projects || projects.length === 0) {
    if (!navigator.onLine || fetchError instanceof NetworkError) {
      container.appendChild(
        createEmptyState({
          icon:    '📡',
          title:   "You're offline",
          message: 'Projects will appear here once you connect and sync.',
        })
      );
    } else if (fetchError) {
      container.appendChild(
        createErrorState(fetchError, () => projectsView(_params, container))
      );
    } else {
      container.appendChild(
        createEmptyState({
          icon:    '📂',
          title:   'No projects yet',
          message: 'Ask your team lead to add you to a project.',
        })
      );
    }
    return;
  }

  if (fetchError && !(fetchError instanceof NetworkError)) {
    toast.warn('Showing cached projects (server unavailable).');
  }

  const list = document.createElement('div');
  list.className = 'list';

  for (const project of projects) {
    list.appendChild(_buildProjectCard(project));
  }

  container.appendChild(list);

  // Greeting toast (first load only)
  const user = getUser();
  if (user && sessionStorage.getItem('fs_greeted') !== '1') {
    sessionStorage.setItem('fs_greeted', '1');
    toast.success(`Welcome back, ${user.display_name || user.username}!`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _buildProjectCard(project) {
  const card = document.createElement('a');
  card.className = 'card card--clickable';
  card.href      = `#/p/${encodeURIComponent(project.id)}/records`;
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

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
