// frontend/js/ui/recordForm.js
// Create/edit record form and record detail view.
// Form fields are generated purely from frontend/js/schemas.js.
// Reads/writes IndexedDB exclusively via repo.js.

import {
  createRecord,
  updateRecord,
  deleteRecord,
  restoreRecord,
  getRecord,
  getPendingRecordIds,
} from '../repo.js';
import {
  RECORD_TYPES,
  getSchema,
  getTypeMeta,
  validateRecordData,
} from '../schemas.js';
import { toast, createEmptyState } from './components.js';
import { escapeHtml, formatDate }  from '../utils.js';

// ─── Create / Edit Form View ──────────────────────────────────────────────────

/**
 * Renders create (#/p/:projectId/records/new) or edit (#/r/:recordId/edit).
 * @param {{ projectId?: string, recordId?: string }} params
 * @param {HTMLElement} container
 */
export async function recordFormView(params, container) {
  const isEdit = Boolean(params.recordId);
  let existing = null;
  let projectId = params.projectId;

  if (isEdit) {
    existing = await getRecord(params.recordId);
    if (!existing) {
      container.innerHTML = '';
      container.appendChild(
        createEmptyState({
          icon:    '🔍',
          title:   'Record not found',
          message: 'This observation may have been removed.',
        })
      );
      return;
    }
    projectId = existing.project_id;
  }

  let currentType = isEdit ? existing.type : 'soil';
  const backHref = isEdit
    ? `#/r/${encodeURIComponent(existing.id)}`
    : `#/p/${encodeURIComponent(projectId)}/records`;

  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px">
      <a href="${backHref}" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Back</a>
      <h1 class="page-header__title">${isEdit ? 'Edit Observation' : 'New Observation'}</h1>
    </div>
  `;
  container.appendChild(header);

  const card = document.createElement('div');
  card.className = 'card stack';
  container.appendChild(card);

  // Type selector (only on create)
  if (!isEdit) {
    const typeGroup = document.createElement('div');
    typeGroup.className = 'form-group';
    typeGroup.innerHTML = `<span class="form-label">Observation Type</span>`;

    const typePills = document.createElement('div');
    typePills.className = 'filter-pills';
    typePills.setAttribute('role', 'radiogroup');
    typePills.setAttribute('aria-label', 'Observation Type');

    for (const t of RECORD_TYPES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `filter-pill${t.key === currentType ? ' active' : ''}`;
      btn.dataset.type = t.key;
      btn.setAttribute('aria-pressed', t.key === currentType ? 'true' : 'false');
      btn.textContent = `${t.icon} ${t.label}`;
      typePills.appendChild(btn);
    }

    typePills.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-pill');
      if (!btn || btn.dataset.type === currentType) return;
      currentType = btn.dataset.type;
      typePills.querySelectorAll('.filter-pill').forEach((el) => {
        const selected = el.dataset.type === currentType;
        el.classList.toggle('active', selected);
        el.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      renderFormFields();
    });

    typeGroup.appendChild(typePills);
    card.appendChild(typeGroup);
  } else {
    const meta = getTypeMeta(currentType);
    const badgeRow = document.createElement('div');
    badgeRow.innerHTML = `<span class="badge badge--primary">${meta.icon} ${escapeHtml(meta.label)}</span>`;
    card.appendChild(badgeRow);
  }

  const form = document.createElement('form');
  form.className = 'stack';
  form.noValidate = true;
  card.appendChild(form);

  function renderFormFields() {
    form.innerHTML = '';
    const schema = getSchema(currentType);
    const initialData = isEdit ? (existing.data || {}) : {};

    for (const field of schema) {
      form.appendChild(_buildFieldGroup(field, initialData[field.key]));
    }

    const actions = document.createElement('div');
    actions.className = 'stack stack--sm';
    actions.style.marginTop = 'var(--space-2)';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn--primary btn--full';
    saveBtn.textContent = isEdit ? 'Save Changes' : 'Save Observation';
    actions.appendChild(saveBtn);

    const cancelLink = document.createElement('a');
    cancelLink.href = backHref;
    cancelLink.className = 'btn btn--secondary btn--full';
    cancelLink.textContent = 'Cancel';
    actions.appendChild(cancelLink);

    if (isEdit) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--danger btn--full';
      delBtn.textContent = 'Delete Record';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm('Delete this observation record? It will be marked deleted and synced.')) {
          return;
        }
        try {
          await deleteRecord(existing.id);
          toast.success('Record deleted.');
          window.location.hash = `#/p/${encodeURIComponent(projectId)}/records`;
        } catch (err) {
          toast.error(err.message || 'Failed to delete record.');
        }
      });
      actions.appendChild(delBtn);
    }

    form.appendChild(actions);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const schema = getSchema(currentType);
    const data   = _extractFormData(form, schema);
    const { valid, errors } = validateRecordData(currentType, data);

    _applyValidationErrors(form, schema, errors);
    if (!valid) {
      toast.error('Please fix the highlighted fields.');
      return;
    }

    try {
      if (isEdit) {
        await updateRecord(existing.id, data);
        toast.success('Observation updated.');
        window.location.hash = `#/r/${encodeURIComponent(existing.id)}`;
      } else {
        await createRecord(projectId, currentType, data);
        toast.success('Observation saved offline.');
        window.location.hash = `#/p/${encodeURIComponent(projectId)}/records`;
      }
    } catch (err) {
      console.error('[recordForm] save error', err);
      toast.error(err.message || 'Failed to save observation.');
    }
  });

  renderFormFields();
}

// ─── Record Detail View ───────────────────────────────────────────────────────

/**
 * Renders record detail (#/r/:recordId).
 * @param {{ recordId: string }} params
 * @param {HTMLElement}          container
 */
export async function recordDetailView(params, container) {
  const { recordId } = params;
  const [record, pendingIds] = await Promise.all([
    getRecord(recordId),
    getPendingRecordIds(),
  ]);

  container.innerHTML = '';

  if (!record) {
    container.appendChild(
      createEmptyState({
        icon:    '🔍',
        title:   'Record not found',
        message: 'This observation does not exist in local storage.',
      })
    );
    return;
  }

  const meta      = getTypeMeta(record.type);
  const schema    = getSchema(record.type);
  const isPending = pendingIds.has(record.id);
  const backHref  = `#/p/${encodeURIComponent(record.project_id)}/records`;

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px">
      <a href="${backHref}" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Records</a>
      <h1 class="page-header__title">${meta.icon} ${escapeHtml(meta.label)} Observation</h1>
    </div>
    ${!record.deleted
      ? `<a href="#/r/${encodeURIComponent(record.id)}/edit" class="btn btn--secondary">Edit</a>`
      : ''}
  `;
  container.appendChild(header);

  const card = document.createElement('div');
  card.className = 'card stack';

  const statusRow = document.createElement('div');
  statusRow.className = 'row row--between';
  statusRow.innerHTML = `
    <span class="text-xs text-muted">Created ${escapeHtml(formatDate(record.created_at))}</span>
    ${record.deleted
      ? `<span class="badge badge--error">Deleted</span>`
      : isPending
        ? `<span class="pending-indicator"><span class="pending-dot" aria-hidden="true"></span><span>Pending sync</span></span>`
        : `<span class="badge badge--success">Synced</span>`}
  `;
  card.appendChild(statusRow);

  const dl = document.createElement('dl');
  dl.className = 'detail-list';

  for (const field of schema) {
    const val = record.data?.[field.key];
    const hasVal = val !== undefined && val !== null && val !== '';
    const displayVal = hasVal
      ? `${val}${field.unit ? ` ${field.unit}` : ''}`
      : '—';

    const row = document.createElement('div');
    row.className = 'detail-list__row';
    row.innerHTML = `
      <dt class="detail-list__label">${escapeHtml(field.label)}</dt>
      <dd class="detail-list__value">${escapeHtml(String(displayVal))}</dd>
    `;
    dl.appendChild(row);
  }
  card.appendChild(dl);

  const actions = document.createElement('div');
  actions.className = 'stack stack--sm';

  if (record.deleted) {
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn btn--primary btn--full';
    restoreBtn.textContent = 'Restore Record';
    restoreBtn.addEventListener('click', async () => {
      try {
        await restoreRecord(record.id);
        toast.success('Record restored.');
        recordDetailView(params, container);
      } catch (err) {
        toast.error(err.message || 'Failed to restore record.');
      }
    });
    actions.appendChild(restoreBtn);
  } else {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--danger btn--full';
    delBtn.textContent = 'Delete Record';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm('Delete this observation record?')) return;
      try {
        await deleteRecord(record.id);
        toast.success('Record deleted.');
        window.location.hash = backHref;
      } catch (err) {
        toast.error(err.message || 'Failed to delete record.');
      }
    });
    actions.appendChild(delBtn);
  }

  card.appendChild(actions);
  container.appendChild(card);
}

// ─── Form DOM helpers (purely config-driven) ──────────────────────────────────

function _buildFieldGroup(field, value) {
  const group = document.createElement('div');
  group.className = 'form-group';
  group.dataset.fieldKey = field.key;

  const inputId = `field-${field.key}`;
  const label = document.createElement('label');
  label.className = `form-label${field.required ? ' form-label--required' : ''}`;
  label.htmlFor = inputId;
  label.textContent = field.unit ? `${field.label} (${field.unit})` : field.label;
  group.appendChild(label);

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    input.className = 'form-select';

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Select…';
    input.appendChild(emptyOpt);

    for (const optVal of field.options || []) {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal;
      if (value === optVal) opt.selected = true;
      input.appendChild(opt);
    }
  } else if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.className = 'form-textarea';
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = value ?? '';
  } else {
    input = document.createElement('input');
    input.className = 'form-input';
    input.type = field.type === 'number' ? 'number' : 'text';
    if (field.type === 'number') {
      input.inputMode = 'decimal';
      if (field.min !== null && field.min !== undefined) input.min = String(field.min);
      if (field.max !== null && field.max !== undefined) input.max = String(field.max);
      if (field.step !== null && field.step !== undefined) input.step = String(field.step);
    }
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = value !== undefined && value !== null ? String(value) : '';
  }

  input.id = inputId;
  input.name = field.key;
  if (field.required) input.required = true;
  group.appendChild(input);

  const errEl = document.createElement('div');
  errEl.className = 'form-error-msg';
  errEl.hidden = true;
  group.appendChild(errEl);

  return group;
}

function _extractFormData(form, schema) {
  const data = {};
  for (const field of schema) {
    const el = form.elements.namedItem(field.key);
    if (!el) continue;
    const raw = el.value.trim();
    if (raw === '') {
      data[field.key] = null;
    } else if (field.type === 'number') {
      data[field.key] = Number(raw);
    } else {
      data[field.key] = raw;
    }
  }
  return data;
}

function _applyValidationErrors(form, schema, errors) {
  for (const field of schema) {
    const group = form.querySelector(`[data-field-key="${field.key}"]`);
    if (!group) continue;
    const input = group.querySelector('input, select, textarea');
    const errEl = group.querySelector('.form-error-msg');
    const msg   = errors[field.key];
    if (input) input.classList.toggle('error', Boolean(msg));
    if (errEl) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    }
  }
}
