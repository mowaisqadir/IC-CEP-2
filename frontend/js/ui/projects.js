// frontend/js/ui/projects.js
// Project list screen view.
// Called by router as: projectsView(params, container)
//
// Caches fetched projects into IndexedDB (db.projects) and renders from
// IndexedDB so the project list works offline.

import { apiGetProjects, NetworkError }        from '../api.js';
import { upsertProjects, listProjects }        from '../repo.js';
import { prefetchProjectThumbs }               from '../media.js';
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
  const card = document.createElement('div');
  card.className = 'card stack stack--sm';

  const link = document.createElement('a');
  link.href = `#/p/${encodeURIComponent(project.id)}/records`;
  link.setAttribute('aria-label', `Open project ${project.name}`);
  link.style.display = 'block';
  link.style.color = 'inherit';
  link.style.textDecoration = 'none';
  link.innerHTML = `
    <div class="card__title">${_esc(project.name)}</div>
    <div class="card__subtitle">📍 ${_esc(project.region || 'No region')}</div>
    ${project.description
      ? `<div class="card__meta">${_esc(project.description)}</div>`
      : ''}
  `;
  card.appendChild(link);

  const offlineWrap = document.createElement('div');
  offlineWrap.className = 'stack stack--sm';
  offlineWrap.style.marginTop = 'var(--space-2)';

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'btn btn--secondary';
  dlBtn.style.minHeight = '44px';
  dlBtn.textContent = '⬇️ Download for offline use';

  const progressWrap = document.createElement('div');
  progressWrap.hidden = true;
  progressWrap.innerHTML = `
    <div class="row row--between text-xs text-muted">
      <span class="dl-status">Downloading thumbnails…</span>
      <span class="dl-count">0 / 0</span>
    </div>
    <div class="progress-bar-wrap">
      <div class="progress-bar-fill" style="width:0%"></div>
    </div>
  `;

  dlBtn.addEventListener('click', async () => {
    if (!navigator.onLine) {
      toast.warn('Connect to the internet to download thumbnails.');
      return;
    }
    dlBtn.disabled = true;
    progressWrap.hidden = false;
    const statusEl = progressWrap.querySelector('.dl-status');
    const countEl  = progressWrap.querySelector('.dl-count');
    const fillEl   = progressWrap.querySelector('.progress-bar-fill');

    try {
      const res = await prefetchProjectThumbs(project.id, (done, total) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 100;
        if (countEl) countEl.textContent = `${done} / ${total}`;
        if (fillEl)  fillEl.style.width = `${pct}%`;
      });

      if (res.total === 0) {
        if (statusEl) statusEl.textContent = 'All thumbnails already cached.';
        if (fillEl)   fillEl.style.width = '100%';
        toast.info('All project thumbnails are already available offline.');
      } else {
        if (statusEl) statusEl.textContent = `Downloaded ${res.done} of ${res.total}`;
        toast.success(`Downloaded ${res.done} thumbnail${res.done === 1 ? '' : 's'} for offline use.`);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to download thumbnails.');
      if (statusEl) statusEl.textContent = err.message || 'Download stopped.';
    } finally {
      dlBtn.disabled = false;
    }
  });

  offlineWrap.appendChild(dlBtn);
  offlineWrap.appendChild(progressWrap);
  card.appendChild(offlineWrap);

  return card;
}

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
