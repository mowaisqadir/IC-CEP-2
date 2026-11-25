// frontend/js/ui/settings.js
// Settings screen: account, device/sync, storage quota, dead letters,
// "Sync now" panel, and optional dev/debug section.

import { getMeta, setMeta, db }  from '../db.js';
import { getUser, logout }       from '../auth.js';
import { getOutboxCount }        from '../repo.js';
import {
  getStorageStatus,
  requestPersistentStorage,
  formatBytes,
} from '../media.js';
import {
  on as syncOn,
  getState as getSyncState,
  runSync,
} from '../sync.js';
import { createPageHeader, toast } from './components.js';
import { escapeHtml }             from '../utils.js';

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

  // Show dev panel only when ?debug=1 is in the URL
  const isDebug = new URLSearchParams(window.location.search).get('debug') === '1';

  const stack = document.createElement('div');
  stack.className = 'stack';

  // ── User card ──────────────────────────────────────────────────────────────
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

  // ── Sync card ──────────────────────────────────────────────────────────────
  const syncCard = document.createElement('div');
  syncCard.className = 'card stack stack--sm';
  syncCard.id = 'settings-sync-card';
  stack.appendChild(syncCard);
  _renderSyncCard(syncCard, pendingCount);

  // Subscribe to sync state changes so the card updates live
  const unsubSync = syncOn('state', () => {
    _renderSyncCard(syncCard, null);
  });

  // ── Device card ────────────────────────────────────────────────────────────
  const deviceCard = document.createElement('div');
  deviceCard.className = 'card stack stack--sm';
  deviceCard.innerHTML = `
    <div class="card__title">Device</div>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Device ID</dt>
        <dd class="detail-list__value text-xs" style="font-family:var(--font-mono);word-break:break-all">${escapeHtml(deviceId || '—')}</dd>
      </div>
    </dl>
  `;
  stack.appendChild(deviceCard);

  // ── Storage Quota card ─────────────────────────────────────────────────────
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
      warnings.push('Persistent storage was denied. Offline data may be evicted under storage pressure.');
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

  // ── Dead Letters card ──────────────────────────────────────────────────────
  const deadLetters = (await getMeta('dead_letters')) || [];
  if (deadLetters.length > 0) {
    const dlCard = document.createElement('div');
    dlCard.className = 'card stack stack--sm';
    dlCard.innerHTML = `
      <div class="card__title">⚠️ Failed Changes (Dead Letter)</div>
      <p class="text-sm text-muted">These changes were permanently rejected by the server and will not be retried. Contact support if you believe this is an error.</p>
      <ul class="stack stack--sm" style="list-style:none;padding:0;margin:0">
        ${deadLetters.slice(-20).map((dl) => `
          <li class="card" style="padding:10px 12px;">
            <span class="badge badge--error">${escapeHtml(dl.reason)}</span>
            <span class="text-xs text-muted" style="display:block;margin-top:4px;font-family:var(--font-mono)">${escapeHtml(dl.entity)} · ${escapeHtml(dl.change_id?.slice(0, 8) ?? '—')}</span>
            <span class="text-xs text-muted">${escapeHtml(dl.at || '')}</span>
          </li>
        `).join('')}
      </ul>
      <button type="button" id="clear-dead-letters-btn" class="btn btn--secondary">Clear Dead Letters</button>
    `;
    dlCard.querySelector('#clear-dead-letters-btn').addEventListener('click', async () => {
      await setMeta('dead_letters', []);
      toast.info('Dead letters cleared.');
      settingsView(_params, container);
    });
    stack.appendChild(dlCard);
  }

  // ── Logout card ───────────────────────────────────────────────────────────
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

  sessionCard.querySelector('#logout-btn').addEventListener('click', async () => {
    const currentPending = await getOutboxCount();
    if (currentPending > 0) {
      const ok = window.confirm(
        `Warning: You have ${currentPending} unsynced change(s) in your outbox.\n\n` +
        'Logging out will NOT delete your offline data, but you will need to log back in to sync. Continue?'
      );
      if (!ok) return;
    }
    unsubSync();
    await logout();
    toast.info('Logged out.');
  });

  // ── Dev / Debug section (only when ?debug=1) ──────────────────────────────
  if (isDebug) {
    const debugCard = await _buildDebugCard(_params, container, unsubSync);
    stack.appendChild(debugCard);
  }

  container.appendChild(stack);

  // Teardown subscriptions when route changes
  const teardown = () => { unsubSync(); };
  // Store on container so router can call it if needed
  container._syncTeardown = teardown;
}

// ─── Sync card render ─────────────────────────────────────────────────────────

async function _renderSyncCard(card, _initialPending) {
  const { status, pendingChanges, pendingMedia, pendingPoints, lastSyncAt, lastError } = getSyncState();
  const totalPending = pendingChanges + pendingMedia + pendingPoints;

  const statusLabel = {
    idle:    '<span class="badge badge--success">Idle</span>',
    syncing: '<span class="badge badge--primary">Syncing…</span>',
    offline: '<span class="badge badge--warn">Offline</span>',
    error:   '<span class="badge badge--error">Error</span>',
  }[status] ?? `<span class="badge">${escapeHtml(status)}</span>`;

  const lastSyncLabel = lastSyncAt ? _formatRelTime(lastSyncAt) : 'Never';

  card.innerHTML = `
    <div class="card__title">Sync</div>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Status</dt>
        <dd class="detail-list__value">${statusLabel}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Last synced</dt>
        <dd class="detail-list__value">${escapeHtml(lastSyncLabel)}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Pending changes</dt>
        <dd class="detail-list__value">
          ${totalPending > 0
            ? `<span class="badge badge--warn">${pendingChanges} records · ${pendingMedia} media · ${pendingPoints} points</span>`
            : `<span class="badge badge--success">All synced</span>`}
        </dd>
      </div>
      ${lastError ? `
      <div class="detail-list__row">
        <dt class="detail-list__label">Last error</dt>
        <dd class="detail-list__value text-error text-sm">${escapeHtml(lastError)}</dd>
      </div>` : ''}
    </dl>
    <button type="button" id="sync-now-btn" class="btn btn--primary"
      ${status === 'syncing' ? 'disabled' : ''}>
      ${status === 'syncing' ? 'Syncing…' : 'Sync Now'}
    </button>
  `;

  card.querySelector('#sync-now-btn').addEventListener('click', async () => {
    await runSync({ manual: true });
    toast.info('Sync triggered.');
  });
}

function _formatRelTime(isoString) {
  if (!isoString) return 'Never';
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins   = Math.floor(diffMs / 60_000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs} h ago`;
    return `${Math.floor(hrs / 24)} d ago`;
  } catch {
    return isoString;
  }
}

// ─── Dev / Debug card ─────────────────────────────────────────────────────────

async function _buildDebugCard(_params, mainContainer, unsubSync) {
  const card = document.createElement('div');
  card.className = 'card stack stack--sm';
  card.style.cssText = 'border:2px dashed var(--color-warn);';

  const outboxCount  = await db.outbox.count();
  const lastPullSeq  = (await getMeta('last_pull_seq')) ?? 0;
  const deadLetters  = (await getMeta('dead_letters')) || [];
  const conflictsCnt = await db.conflicts.count();

  card.innerHTML = `
    <div class="card__title" style="color:var(--color-warn)">🛠 Dev / Debug</div>
    <p class="text-xs text-muted" style="margin:0">Only visible at <code>?debug=1</code>.</p>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Outbox size</dt>
        <dd class="detail-list__value"><code>${outboxCount}</code></dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">last_pull_seq</dt>
        <dd class="detail-list__value"><code>${lastPullSeq}</code></dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Dead letters</dt>
        <dd class="detail-list__value"><code>${deadLetters.length}</code></dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Unreviewed conflicts</dt>
        <dd class="detail-list__value"><code>${conflictsCnt}</code></dd>
      </div>
    </dl>
    <button type="button" id="debug-dump-btn" class="btn btn--secondary">Dump to Console</button>
    <button type="button" id="debug-reset-btn" class="btn btn--danger">Reset Local Database…</button>
  `;

  card.querySelector('#debug-dump-btn').addEventListener('click', async () => {
    const dump = {
      outbox:        await db.outbox.toArray(),
      meta:          await db.meta.toArray(),
      dead_letters:  await getMeta('dead_letters'),
      conflicts:     await db.conflicts.toArray(),
      sync_state:    getSyncState(),
    };
    console.group('[FieldSync Debug Dump]');
    console.table(dump.meta);
    console.log('Outbox:', dump.outbox);
    console.log('Dead letters:', dump.dead_letters);
    console.log('Conflicts:', dump.conflicts);
    console.log('Sync state:', dump.sync_state);
    console.groupEnd();
    toast.info('Debug dump written to browser console.');
  });

  card.querySelector('#debug-reset-btn').addEventListener('click', async () => {
    const first = window.confirm(
      '⚠️ DANGER: This will delete ALL local data (records, media, tracks, outbox, etc.).\n\n' +
      'Unsynced changes will be LOST. Are you sure?'
    );
    if (!first) return;
    const second = window.confirm(
      '☠️ FINAL WARNING: There is NO undo.\n\nType OK in the next prompt to confirm.'
    );
    if (!second) return;
    const typed = window.prompt('Type RESET to confirm:');
    if (typed !== 'RESET') {
      toast.warn('Reset cancelled — you did not type RESET.');
      return;
    }

    try {
      unsubSync();
      await db.delete();
      toast.success('Local database deleted. Reloading…');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      toast.error(`Reset failed: ${err.message}`);
    }
  });

  return card;
}
