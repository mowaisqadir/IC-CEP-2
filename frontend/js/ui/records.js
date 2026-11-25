// frontend/js/ui/records.js
// Record list screen view.
// Reads exclusively from IndexedDB via repo.js.

import { getProject, listRecords, getPendingRecordIds } from '../repo.js';
import { setMeta }                                      from '../db.js';
import { RECORD_TYPES, getSchema, getTypeMeta }         from '../schemas.js';
import { createEmptyState, createLoadingState }         from './components.js';
import { debounce, escapeHtml, formatDate }             from '../utils.js';

/**
 * @param {{ projectId: string }} params
 * @param {HTMLElement}           container
 */
export async function recordsView(params, container) {
  const { projectId } = params;
  setMeta('last_project_id', projectId).catch(() => {});

  container.innerHTML = '';

  const project = await getProject(projectId);
  const projectName = project ? project.name : 'Project Records';

  // ── Header with back link + New button ──────────────────────────────────
  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px;min-width:0;flex:1">
      <a href="#/projects" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Projects</a>
      <h1 class="page-header__title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(projectName)}</h1>
    </div>
    <a href="#/p/${encodeURIComponent(projectId)}/records/new" class="btn btn--primary">+ New</a>
  `;
  container.appendChild(header);

  // ── Filter bar: type pills + search ─────────────────────────────────────
  const filterWrap = document.createElement('div');
  filterWrap.className = 'stack stack--sm';
  filterWrap.style.marginBottom = 'var(--space-4)';

  const pills = document.createElement('div');
  pills.className = 'filter-pills';
  pills.setAttribute('role', 'tablist');
  pills.setAttribute('aria-label', 'Filter by observation type');

  const filterTypes = [{ key: 'all', label: 'All', icon: '' }, ...RECORD_TYPES];
  let activeType = 'all';
  let searchText = '';

  for (const t of filterTypes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-pill${t.key === activeType ? ' active' : ''}`;
    btn.dataset.type = t.key;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', t.key === activeType ? 'true' : 'false');
    btn.textContent = t.icon ? `${t.icon} ${t.label}` : t.label;
    pills.appendChild(btn);
  }
  filterWrap.appendChild(pills);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'form-input';
  searchInput.placeholder = 'Search observations (site, species, notes…)';
  searchInput.setAttribute('aria-label', 'Search records');
  filterWrap.appendChild(searchInput);

  container.appendChild(filterWrap);

  // ── List container ──────────────────────────────────────────────────────
  const listWrap = document.createElement('div');
  listWrap.appendChild(createLoadingState('Loading records…'));
  container.appendChild(listWrap);

  // ── Floating Action Button for mobile ───────────────────────────────────
  const fab = document.createElement('a');
  fab.href = `#/p/${encodeURIComponent(projectId)}/records/new`;
  fab.className = 'fab';
  fab.setAttribute('aria-label', 'New observation record');
  fab.textContent = '+';
  container.appendChild(fab);

  async function renderList() {
    const [records, pendingIds] = await Promise.all([
      listRecords(projectId, { type: activeType, search: searchText }),
      getPendingRecordIds(),
    ]);

    listWrap.innerHTML = '';

    if (records.length === 0) {
      listWrap.appendChild(
        createEmptyState({
          icon:    '📋',
          title:   searchText || activeType !== 'all' ? 'No matching records' : 'No records yet',
          message: searchText || activeType !== 'all'
            ? 'Try clearing your search or changing the type filter.'
            : 'Tap + New to log your first field observation offline.',
        })
      );
      return;
    }

    const list = document.createElement('div');
    list.className = 'list';
    for (const rec of records) {
      list.appendChild(_buildRecordCard(rec, pendingIds.has(rec.id)));
    }
    listWrap.appendChild(list);
  }

  pills.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-pill');
    if (!btn) return;
    activeType = btn.dataset.type;
    pills.querySelectorAll('.filter-pill').forEach((el) => {
      const isSelected = el.dataset.type === activeType;
      el.classList.toggle('active', isSelected);
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    renderList();
  });

  searchInput.addEventListener(
    'input',
    debounce(() => {
      searchText = searchInput.value;
      renderList();
    }, 150)
  );

  await renderList();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _buildRecordCard(record, isPending) {
  const meta   = getTypeMeta(record.type);
  const schema = getSchema(record.type);
  const data   = record.data || {};

  const primary =
    data.site_name ||
    data.species ||
    data.source ||
    `${meta.label} Observation`;

  const summaryParts = [];
  for (const field of schema) {
    if (field.key === 'site_name' || field.key === 'species' || field.key === 'source' || field.key === 'notes') {
      continue;
    }
    const val = data[field.key];
    if (val === undefined || val === null || val === '') continue;
    const unit = field.unit ? ` ${field.unit}` : '';
    summaryParts.push(`${field.label}: ${val}${unit}`);
    if (summaryParts.length >= 3) break;
  }

  const card = document.createElement('a');
  card.className = 'card card--clickable';
  card.href      = `#/r/${encodeURIComponent(record.id)}`;
  card.setAttribute('aria-label', `${meta.label}: ${primary}`);

  card.innerHTML = `
    <div class="row row--between" style="margin-bottom:var(--space-2)">
      <span class="badge badge--primary">${meta.icon} ${escapeHtml(meta.label)}</span>
      ${isPending
        ? `<span class="pending-indicator" title="Pending sync">
             <span class="pending-dot" aria-hidden="true"></span>
             <span>Pending sync</span>
           </span>`
        : `<span class="text-xs text-muted">Synced</span>`}
    </div>
    <div class="card__title">${escapeHtml(String(primary))}</div>
    ${summaryParts.length > 0
      ? `<div class="card__subtitle">${escapeHtml(summaryParts.join(' · '))}</div>`
      : ''}
    <div class="card__meta">${escapeHtml(formatDate(record.created_at))}</div>
  `;

  return card;
}
