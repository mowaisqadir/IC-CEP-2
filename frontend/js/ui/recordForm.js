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
import { captureCurrentPosition }    from '../gps.js';
import {
  addPhoto,
  listMediaForRecord,
  softDeleteMedia,
  assertSufficientStorage,
  formatBytes,
} from '../media.js';
import { router } from '../router.js';

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
  let capturedGeo = isEdit && existing.data?.lat !== undefined && existing.data?.lat !== null
    ? {
        lat:      existing.data.lat,
        lng:      existing.data.lng,
        accuracy: existing.data.accuracy ?? null,
        altitude: existing.data.altitude ?? null,
      }
    : null;
  const stagedFiles = [];
  const activeUrls  = new Set();
  router.onCleanup(() => {
    for (const u of activeUrls) URL.revokeObjectURL(u);
    activeUrls.clear();
  });

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

    // ── GPS Location section ──────────────────────────────────────────────
    const gpsSection = _buildGpsSection({
      getGeo: () => capturedGeo,
      onCapture: async () => {
        const geo = await captureCurrentPosition();
        capturedGeo = geo;
        if (isEdit) {
          existing = await updateRecord(existing.id, geo);
          toast.success('Location saved to record.');
        } else {
          toast.success('Location captured.');
        }
        return geo;
      },
    });
    form.appendChild(gpsSection);

    // ── Photos section ────────────────────────────────────────────────────
    const photoSection = _buildPhotoSection({
      recordId: isEdit ? existing.id : null,
      stagedFiles,
      activeUrls,
    });
    form.appendChild(photoSection);

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

    if (capturedGeo) {
      data.lat      = capturedGeo.lat;
      data.lng      = capturedGeo.lng;
      data.accuracy = capturedGeo.accuracy;
      data.altitude = capturedGeo.altitude;
    }

    try {
      if (isEdit) {
        await updateRecord(existing.id, data);
        toast.success('Observation updated.');
        window.location.hash = `#/r/${encodeURIComponent(existing.id)}`;
      } else {
        const created = await createRecord(projectId, currentType, data);
        for (const file of stagedFiles) {
          await addPhoto(created.id, file);
        }
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

  const activeUrls = new Set();
  router.onCleanup(() => {
    for (const u of activeUrls) URL.revokeObjectURL(u);
    activeUrls.clear();
  });

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

  // GPS Coordinates (if captured)
  if (record.data?.lat !== undefined && record.data?.lat !== null) {
    const gpsBox = document.createElement('div');
    gpsBox.className = 'gps-box stack stack--sm';
    const acc = record.data.accuracy;
    const alt = record.data.altitude;
    gpsBox.innerHTML = `
      <div class="row row--between">
        <span class="text-sm font-medium">📍 Location</span>
        ${acc !== null && acc !== undefined
          ? `<span class="badge ${acc > 50 ? 'badge--warn' : 'badge--success'}">±${Math.round(acc)} m</span>`
          : ''}
      </div>
      <div class="gps-coords">${escapeHtml(String(record.data.lat))}, ${escapeHtml(String(record.data.lng))}${alt !== null && alt !== undefined ? ` · Alt ${escapeHtml(String(alt))} m` : ''}</div>
      ${acc > 50
        ? `<div class="text-xs text-muted">⚠️ Low GPS accuracy (&gt; 50 m). Consider recapturing outdoors.</div>`
        : ''}
    `;
    card.appendChild(gpsBox);
  }

  // Photos Gallery + Add Photo
  if (!record.deleted) {
    card.appendChild(_buildPhotoSection({ recordId: record.id, activeUrls }));
  }

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

// ─── GPS Capture Section ──────────────────────────────────────────────────────

function _buildGpsSection({ getGeo, onCapture }) {
  const wrap = document.createElement('div');
  wrap.className = 'gps-box stack stack--sm';

  const headerRow = document.createElement('div');
  headerRow.className = 'row row--between';
  headerRow.innerHTML = `<span class="form-label" style="margin:0">GPS Location</span>`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--secondary';
  btn.textContent = '📍 Capture location';
  headerRow.appendChild(btn);
  wrap.appendChild(headerRow);

  const infoEl = document.createElement('div');
  infoEl.className = 'stack stack--sm';
  wrap.appendChild(infoEl);

  function renderInfo() {
    const geo = getGeo();
    if (!geo) {
      infoEl.innerHTML = `<span class="text-xs text-muted">No coordinates captured yet.</span>`;
      return;
    }
    const acc = geo.accuracy;
    const alt = geo.altitude;
    infoEl.innerHTML = `
      <div class="row row--between">
        <span class="gps-coords">${escapeHtml(String(geo.lat))}, ${escapeHtml(String(geo.lng))}</span>
        ${acc !== null && acc !== undefined
          ? `<span class="badge ${acc > 50 ? 'badge--warn' : 'badge--success'}">±${Math.round(acc)} m</span>`
          : ''}
      </div>
      <div class="text-xs text-muted">
        Accuracy: ${acc !== null && acc !== undefined ? `${acc} m` : '—'} · Altitude: ${alt !== null && alt !== undefined ? `${alt} m` : '—'}
      </div>
      ${acc > 50
        ? `<div class="offline-banner" role="status" style="margin:0">
             <span aria-hidden="true">⚠️</span>
             <span>GPS accuracy is ${Math.round(acc)} m (&gt; 50 m). Move to open sky and recapture for better precision.</span>
           </div>`
        : ''}
    `;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '📡 Capturing…';
    try {
      await onCapture();
      renderInfo();
    } catch (err) {
      toast.error(err.message || 'Failed to capture GPS location.');
    } finally {
      btn.disabled = false;
      btn.textContent = '📍 Capture location';
    }
  });

  renderInfo();
  return wrap;
}

// ─── Photo Gallery & Capture Section ──────────────────────────────────────────

function _buildPhotoSection({ recordId, stagedFiles = null, activeUrls }) {
  const wrap = document.createElement('div');
  wrap.className = 'gps-box stack stack--sm';

  const headerRow = document.createElement('div');
  headerRow.className = 'row row--between';
  headerRow.style.flexWrap = 'wrap';
  headerRow.innerHTML = `<span class="form-label" style="margin:0">Photos</span>`;

  const btnGroup = document.createElement('div');
  btnGroup.className = 'row';
  btnGroup.style.gap = 'var(--space-2)';

  const camInput = document.createElement('input');
  camInput.type     = 'file';
  camInput.accept   = 'image/*';
  camInput.capture  = 'environment';
  camInput.multiple = true;
  camInput.hidden   = true;

  const galInput = document.createElement('input');
  galInput.type     = 'file';
  galInput.accept   = 'image/*';
  galInput.multiple = true;
  galInput.hidden   = true;

  const camBtn = document.createElement('button');
  camBtn.type      = 'button';
  camBtn.className = 'btn btn--secondary';
  camBtn.textContent = '📷 Add photo';
  camBtn.addEventListener('click', () => camInput.click());

  const galBtn = document.createElement('button');
  galBtn.type      = 'button';
  galBtn.className = 'btn btn--ghost';
  galBtn.textContent = '🖼️ Gallery';
  galBtn.addEventListener('click', () => galInput.click());

  btnGroup.appendChild(camBtn);
  btnGroup.appendChild(galBtn);
  btnGroup.appendChild(camInput);
  btnGroup.appendChild(galInput);
  headerRow.appendChild(btnGroup);
  wrap.appendChild(headerRow);

  const strip = document.createElement('div');
  strip.className = 'photo-strip';
  wrap.appendChild(strip);

  const localThumbUrls = new Set();

  function revokeLocalThumbs() {
    for (const u of localThumbUrls) {
      URL.revokeObjectURL(u);
      activeUrls.delete(u);
    }
    localThumbUrls.clear();
  }

  async function renderStrip() {
    revokeLocalThumbs();
    strip.innerHTML = '';

    if (recordId) {
      const items = await listMediaForRecord(recordId);
      if (items.length === 0) {
        strip.innerHTML = `<span class="text-xs text-muted">No photos attached yet.</span>`;
        return;
      }
      for (const item of items) {
        const thumbSrc = item.thumb_blob || item.blob;
        const url = URL.createObjectURL(thumbSrc);
        localThumbUrls.add(url);
        activeUrls.add(url);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'photo-thumb-btn';
        btn.setAttribute('aria-label', 'View photo');
        btn.innerHTML = `
          <img src="${url}" alt="Field observation photo" />
          <span class="photo-thumb-badge">${item.upload_state === 'done' ? '✓' : '⏳'}</span>
        `;
        btn.addEventListener('click', () => {
          _openPhotoViewer(item, async () => {
            await softDeleteMedia(item.id);
            toast.info('Photo deleted locally.');
            await renderStrip();
          });
        });
        strip.appendChild(btn);
      }
      return;
    }

    // Staged files (create mode before record is saved)
    if (!stagedFiles || stagedFiles.length === 0) {
      strip.innerHTML = `<span class="text-xs text-muted">No photos selected yet.</span>`;
      return;
    }
    stagedFiles.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      localThumbUrls.add(url);
      activeUrls.add(url);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-thumb-btn';
      btn.setAttribute('aria-label', 'Remove staged photo');
      btn.innerHTML = `
        <img src="${url}" alt="Staged photo" />
        <span class="photo-thumb-badge">✕</span>
      `;
      btn.addEventListener('click', () => {
        if (window.confirm('Remove this staged photo?')) {
          stagedFiles.splice(index, 1);
          renderStrip();
        }
      });
      strip.appendChild(btn);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    camBtn.disabled = true;
    galBtn.disabled = true;
    camBtn.textContent = 'Processing…';

    try {
      await assertSufficientStorage();
      if (recordId) {
        for (const file of files) {
          await addPhoto(recordId, file);
        }
        toast.success(`${files.length} photo(s) saved offline.`);
      } else if (stagedFiles) {
        stagedFiles.push(...files);
        toast.info(`${files.length} photo(s) staged. Save observation to store.`);
      }
      await renderStrip();
    } catch (err) {
      toast.error(err.message || 'Failed to add photo.');
    } finally {
      camInput.value = '';
      galInput.value = '';
      camBtn.disabled = false;
      galBtn.disabled = false;
      camBtn.textContent = '📷 Add photo';
    }
  }

  camInput.addEventListener('change', (e) => handleFiles(e.target.files));
  galInput.addEventListener('change', (e) => handleFiles(e.target.files));

  renderStrip();
  return wrap;
}

function _openPhotoViewer(mediaItem, onDelete) {
  const fullUrl = URL.createObjectURL(mediaItem.blob || mediaItem.thumb_blob);

  const overlay = document.createElement('div');
  overlay.className = 'photo-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Photo viewer');

  const dims = mediaItem.width && mediaItem.height ? `${mediaItem.width}×${mediaItem.height}` : '';
  const size = mediaItem.size ? formatBytes(mediaItem.size) : '';

  overlay.innerHTML = `
    <div class="photo-viewer__bar">
      <div class="text-xs">
        <div>${escapeHtml([dims, size].filter(Boolean).join(' · '))}</div>
        <div style="opacity:0.75">${mediaItem.upload_state === 'done' ? 'Uploaded' : 'Pending upload'}</div>
      </div>
      <div class="row" style="gap:var(--space-2)">
        <button type="button" class="btn btn--danger" id="pv-delete">🗑️ Delete</button>
        <button type="button" class="btn btn--secondary" id="pv-close">✕ Close</button>
      </div>
    </div>
    <div class="photo-viewer__stage">
      <img class="photo-viewer__img" src="${fullUrl}" alt="Full-size field photo" />
    </div>
  `;

  function close() {
    document.removeEventListener('keydown', onKeyDown);
    URL.revokeObjectURL(fullUrl);
    overlay.remove();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('#pv-close').addEventListener('click', close);
  overlay.querySelector('#pv-delete').addEventListener('click', async () => {
    if (!window.confirm('Delete this photo locally? (Remote deletion is not supported in v1.)')) {
      return;
    }
    try {
      await onDelete();
      close();
    } catch (err) {
      toast.error(err.message || 'Failed to delete photo.');
    }
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
}
