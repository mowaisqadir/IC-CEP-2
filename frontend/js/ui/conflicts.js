// frontend/js/ui/conflicts.js
// Conflict review screen.
// Reads/writes IndexedDB exclusively via repo.js.
// 'Use mine' calls repo.updateRecord with the old local value, creating a NEW
// newer HLC change so it wins LWW on the next sync.
// 'Keep current' marks the conflict as seen.

import {
  listConflicts,
  countUnseenConflicts,
  markConflictSeen,
  dismissAllConflicts,
  getRecord,
  updateRecord,
} from '../repo.js';
import { getSchema, getTypeMeta } from '../schemas.js';
import { toast }                  from './components.js';
import { escapeHtml, formatDate } from '../utils.js';

/**
 * Update the conflicts badge in the header.
 */
export async function updateConflictsBadge() {
  try {
    const count  = await countUnseenConflicts();
    const nav    = document.getElementById('conflicts-nav');
    const textEl = document.getElementById('conflicts-badge-text');
    if (!nav || !textEl) return;

    nav.hidden = count === 0;
    if (count > 0) {
      const label = `${count} change${count === 1 ? '' : 's'} from teammates overwrote yours`;
      textEl.textContent = label;
      nav.setAttribute('aria-label', label);
      nav.title = label;
    }
  } catch {
    // ignore
  }
}

/**
 * @param {object}      _params
 * @param {HTMLElement} container
 */
export async function conflictsView(_params, container) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px">
      <a href="#/projects" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Projects</a>
      <h1 class="page-header__title">Conflicts</h1>
    </div>
  `;
  container.appendChild(header);

  await _renderConflicts(container);
  await updateConflictsBadge();
}

async function _renderConflicts(container) {
  const header = container.querySelector('.page-header');
  while (container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const conflicts = await listConflicts();
  const unseen = conflicts.filter((c) => !c.seen);
  const seen   = conflicts.filter((c) =>  c.seen);

  if (conflicts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.marginTop = 'var(--space-8)';
    empty.innerHTML = `
      <div class="empty-state__icon" aria-hidden="true">✅</div>
      <div class="empty-state__title">No conflicts</div>
      <div class="empty-state__msg">All changes are in agreement.</div>
    `;
    container.appendChild(empty);
    return;
  }

  if (unseen.length > 0) {
    const dismissBar = document.createElement('div');
    dismissBar.className = 'row row--between';
    dismissBar.style.marginBottom = 'var(--space-4)';
    dismissBar.innerHTML = `
      <span class="text-sm text-muted">${unseen.length} unresolved conflict${unseen.length !== 1 ? 's' : ''}</span>
    `;

    const dismissAllBtn = document.createElement('button');
    dismissAllBtn.type = 'button';
    dismissAllBtn.className = 'btn btn--secondary';
    dismissAllBtn.textContent = 'Dismiss all';
    dismissAllBtn.addEventListener('click', async () => {
      await dismissAllConflicts();
      await updateConflictsBadge();
      toast.success('All conflicts dismissed.');
      await _renderConflicts(container);
    });
    dismissBar.appendChild(dismissAllBtn);
    container.appendChild(dismissBar);

    for (const conflict of unseen) {
      container.appendChild(await _buildConflictCard(conflict, container, false));
    }
  }

  if (seen.length > 0) {
    const seenHeader = document.createElement('div');
    seenHeader.className = 'text-sm text-muted';
    seenHeader.style.marginTop = 'var(--space-6)';
    seenHeader.textContent = `${seen.length} resolved conflict${seen.length !== 1 ? 's' : ''}`;
    container.appendChild(seenHeader);

    for (const conflict of seen) {
      container.appendChild(await _buildConflictCard(conflict, container, true));
    }
  }
}

async function _buildConflictCard(conflict, container, isResolved) {
  const record   = await getRecord(conflict.record_id);
  const typeMeta = record ? getTypeMeta(record.type) : null;
  const recordName = record
    ? (record.data?.site_name || record.data?.species || record.data?.source || `${typeMeta.label} Observation`)
    : conflict.record_id.slice(0, 8) + '…';
  const recordTypeLabel = typeMeta ? `${typeMeta.icon} ${typeMeta.label}` : 'Record';

  let fieldLabel = conflict.field;
  if (conflict.field === 'deleted') {
    fieldLabel = 'Deleted status';
  } else if (record) {
    try {
      const schema = getSchema(record.type);
      const found  = schema.find((f) => f.key === conflict.field);
      if (found) fieldLabel = found.label;
    } catch { /* ignore */ }
  }

  const remoteAuthor = conflict.remote_user_display || conflict.remote_user || 'teammate';
  const editTime     = formatDate(conflict.at);

  const card = document.createElement('div');
  card.className = `card stack${isResolved ? ' conflict-card--resolved' : ''}`;
  card.style.borderLeft = isResolved
    ? '4px solid var(--color-border)'
    : '4px solid var(--color-warn)';

  card.innerHTML = `
    <div class="row row--between">
      <div class="stack stack--sm" style="gap:2px;min-width:0">
        <span class="text-xs text-muted">${escapeHtml(recordTypeLabel)}</span>
        <a href="#/r/${encodeURIComponent(conflict.record_id)}" class="text-sm font-medium">${escapeHtml(String(recordName))}</a>
      </div>
      ${isResolved
        ? '<span class="badge badge--success">Resolved</span>'
        : '<span class="badge badge--warn">Conflict</span>'}
    </div>
    <div class="text-sm">
      <span class="text-muted">Field:</span> <strong>${escapeHtml(fieldLabel)}</strong>
    </div>
    <div class="conflict-values">
      <div class="conflict-value conflict-value--yours">
        <span class="text-xs text-muted">Your value</span>
        <span class="conflict-value__content">${escapeHtml(_formatValue(conflict.localValue))}</span>
      </div>
      <div class="conflict-value conflict-value--remote">
        <span class="text-xs text-muted">Current value (by ${escapeHtml(remoteAuthor)}, ${escapeHtml(editTime)})</span>
        <span class="conflict-value__content">${escapeHtml(_formatValue(conflict.remoteValue))}</span>
      </div>
    </div>
  `;

  if (!isResolved) {
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.style.gap = 'var(--space-2)';

    const keepBtn = document.createElement('button');
    keepBtn.type = 'button';
    keepBtn.className = 'btn btn--secondary';
    keepBtn.style.flex = '1';
    keepBtn.textContent = 'Keep current';
    keepBtn.addEventListener('click', async () => {
      await markConflictSeen(conflict.id);
      await updateConflictsBadge();
      toast.info('Kept current value.');
      await _renderConflicts(container);
    });

    const useMineBtn = document.createElement('button');
    useMineBtn.type = 'button';
    useMineBtn.className = 'btn btn--primary';
    useMineBtn.style.flex = '1';
    useMineBtn.textContent = 'Use mine';
    useMineBtn.addEventListener('click', async () => {
      try {
        if (!record) throw new Error('Record no longer exists locally.');
        await updateRecord(conflict.record_id, { [conflict.field]: conflict.localValue });
        await markConflictSeen(conflict.id);
        await updateConflictsBadge();
        toast.success('Your value restored and queued for sync.');
        await _renderConflicts(container);
      } catch (err) {
        toast.error(err.message || 'Failed to apply your value.');
      }
    });

    actions.appendChild(keepBtn);
    actions.appendChild(useMineBtn);
    card.appendChild(actions);
  }

  return card;
}

function _formatValue(val) {
  if (val === null || val === undefined || val === '') return '(empty)';
  if (typeof val === 'boolean') return val ? 'Yes (deleted)' : 'No';
  return String(val);
}
