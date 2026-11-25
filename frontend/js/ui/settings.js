// frontend/js/ui/settings.js
// Settings screen (device ID, logged-in user, outbox count, logout).

import { getMeta }           from '../db.js';
import { getUser, logout }   from '../auth.js';
import { getOutboxCount }    from '../repo.js';
import { createPageHeader, toast } from './components.js';
import { escapeHtml }        from '../utils.js';

/**
 * @param {object}      _params
 * @param {HTMLElement} container
 */
export async function settingsView(_params, container) {
  container.innerHTML = '';
  container.appendChild(createPageHeader({ title: 'Settings' }));

  const [deviceId, pendingCount] = await Promise.all([
    getMeta('device_id'),
    getOutboxCount(),
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
