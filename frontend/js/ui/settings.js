// frontend/js/ui/settings.js
// Settings screen (device ID, logged-in user, outbox count, logout).

import { getMeta }           from '../db.js';
import { getUser, logout }   from '../auth.js';
import { getOutboxCount }    from '../repo.js';
import {
  getStorageStatus,
  requestPersistentStorage,
  formatBytes,
} from '../media.js';
import { createPageHeader, toast } from './components.js';
import { escapeHtml }        from '../utils.js';

/**
 * @param {object}      _params
 * @param {HTMLElement} container
 */
export async function settingsView(_params, container) {
  container.innerHTML = '';
  container.appendChild(createPageHeader({ title: 'Settings' }));

  const [deviceId, pendingCount, storage] = await Promise.all([
    getMeta('device_id'),
    getOutboxCount(),
    getStorageStatus(),
  ]);
  const user = getUser();

  const stack = document.createElement('div');
  stack.className = 'stack';

  // ── User card ───────────────────────────────────────────────────────────
  const userCard = document.createElement('div');
  userCard.className = 'card stack stack--sm';
  userCard.innerHTML = `
    <div class="card__title">Account</div>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Name</dt>
        <dd class="detail-list__value">${escapeHtml(user?.display_name || '—')}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Username</dt>
        <dd class="detail-list__value">${escapeHtml(user?.username || '—')}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">User ID</dt>
        <dd class="detail-list__value text-xs" style="font-family:var(--font-mono);word-break:break-all">${escapeHtml(user?.id || '—')}</dd>
      </div>
    </dl>
  `;
  stack.appendChild(userCard);

  // ── Device & Sync card ──────────────────────────────────────────────────
  const deviceCard = document.createElement('div');
  deviceCard.className = 'card stack stack--sm';
  deviceCard.innerHTML = `
    <div class="card__title">Device & Offline Storage</div>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Device ID</dt>
        <dd class="detail-list__value text-xs" style="font-family:var(--font-mono);word-break:break-all">${escapeHtml(deviceId || '—')}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Pending Outbox Changes</dt>
        <dd class="detail-list__value">
          ${pendingCount > 0
            ? `<span class="badge badge--warn">${pendingCount} pending</span>`
            : `<span class="badge badge--success">0 pending</span>`}
        </dd>
      </div>
    </dl>
  `;
  stack.appendChild(deviceCard);

  // ── Storage Quota Meter card ────────────────────────────────────────────
  const storageCard = document.createElement('div');
  storageCard.className = 'card stack stack--sm';

  if (!storage.supported) {
    storageCard.innerHTML = `
      <div class="card__title">Storage Quota</div>
      <p class="text-sm text-muted">Storage estimation is not supported in this browser.</p>
    `;
  } else {
    const pct = Math.min(100, Math.round(storage.usagePct * 10) / 10);
    const fillClass = storage.lowSpace ? 'danger' : pct > 80 ? 'warn' : '';
    const warnings = [];
    if (storage.lowSpace) {
      warnings.push('Less than 20 MB remaining — new photo capture is blocked until space is freed.');
    } else if (pct > 80) {
      warnings.push(`Storage usage is at ${pct}% (> 80% of quota). Consider syncing and freeing space.`);
    }
    if (storage.persistDenied) {
      warnings.push('Persistent storage was denied by the browser. Offline data may be evicted under storage pressure.');
    }

    storageCard.innerHTML = `
      <div class="row row--between">
        <div class="card__title" style="margin:0">Storage Quota</div>
        <span class="text-xs text-muted">${pct}% used</span>
      </div>
      <div class="storage-meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="storage-meter__fill ${fillClass}" style="width:${pct}%"></div>
      </div>
      <div class="row row--between text-xs text-muted">
        <span>Used: ${escapeHtml(formatBytes(storage.usage))}</span>
        <span>Quota: ${escapeHtml(formatBytes(storage.quota))}</span>
      </div>
      ${storage.persisted === true
        ? `<span class="badge badge--success" style="align-self:flex-start">Persistent storage granted</span>`
        : `<button type="button" id="persist-storage-btn" class="btn btn--secondary">Request Persistent Storage</button>`}
      ${warnings.map((w) => `
        <div class="offline-banner" role="status" style="margin:0">
          <span aria-hidden="true">⚠️</span>
          <span>${escapeHtml(w)}</span>
        </div>
      `).join('')}
    `;

    const persistBtn = storageCard.querySelector('#persist-storage-btn');
    if (persistBtn) {
      persistBtn.addEventListener('click', async () => {
        const granted = await requestPersistentStorage();
        if (granted) {
          toast.success('Persistent storage granted.');
        } else {
          toast.warn('Persistent storage was denied by the browser.');
        }
        settingsView(_params, container);
      });
    }
  }
  stack.appendChild(storageCard);

  // ── Logout card ─────────────────────────────────────────────────────────
  const sessionCard = document.createElement('div');
  sessionCard.className = 'card stack stack--sm';
  sessionCard.innerHTML = `
    <div class="card__title">Session</div>
    ${pendingCount > 0
      ? `<div class="offline-banner" role="status" style="margin-bottom:0">
           <span aria-hidden="true">⚠️</span>
           <span>You have ${pendingCount} unsynced change(s). Logging out will keep your offline data safe in IndexedDB.</span>
         </div>`
      : `<p class="text-sm text-muted">Logging out clears your session token. Local observations remain stored on this device.</p>`}
    <button type="button" id="logout-btn" class="btn btn--danger btn--full">Log Out</button>
  `;
  stack.appendChild(sessionCard);

  container.appendChild(stack);

  sessionCard.querySelector('#logout-btn').addEventListener('click', async () => {
    const currentPending = await getOutboxCount();
    if (currentPending > 0) {
      const ok = window.confirm(
        `Warning: You have ${currentPending} unsynced change(s) in your outbox.\n\n` +
        'Logging out will NOT delete your offline data, but you will need to log back in to sync. Continue?'
      );
      if (!ok) return;
    }
    await logout();
    toast.info('Logged out.');
  });
}
