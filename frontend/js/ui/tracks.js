// frontend/js/ui/tracks.js
// GPS tracks list, live track recorder, track detail with SVG polyline preview,
// and offline GPX export. Reads/writes IndexedDB exclusively via repo.js & gps.js.

import {
  getProject,
  listTracks,
  getTrack,
  getTrackPoints,
} from '../repo.js';
import { setMeta } from '../db.js';
import {
  startTrack,
  pauseTrack,
  resumeTrack,
  stopTrack,
  resumeInterruptedAsNewSegment,
  getActiveTrackState,
  onTrackStateChange,
  computeTrackDistance,
} from '../gps.js';
import { router } from '../router.js';
import { toast, createEmptyState, createLoadingState } from './components.js';
import { escapeHtml, formatDate } from '../utils.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function _formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function _formatDuration(startedAt, endedAt) {
  if (!startedAt) return '00:00';
  const startMs = Date.parse(startedAt);
  const endMs   = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return '00:00';
  const totalSec = Math.floor((endMs - startMs) / 1000);
  const hrs  = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad  = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function _statusBadge(status) {
  switch (status) {
    case 'recording':   return `<span class="badge badge--success">● Recording</span>`;
    case 'paused':      return `<span class="badge badge--warn">⏸ Paused</span>`;
    case 'interrupted': return `<span class="badge badge--error">⚠ Interrupted</span>`;
    case 'stopped':
    default:            return `<span class="badge badge--primary">✓ Stopped</span>`;
  }
}

// ─── Tracks List & Live Recorder View ─────────────────────────────────────────

/**
 * @param {{ projectId: string }} params
 * @param {HTMLElement} container
 */
export async function tracksView(params, container) {
  const { projectId } = params;
  setMeta('last_project_id', projectId).catch(() => {});

  container.innerHTML = '';
  const project = await getProject(projectId);
  const projectName = project ? project.name : 'Project Tracks';

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px;min-width:0;flex:1">
      <a href="#/p/${encodeURIComponent(projectId)}/records" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Records</a>
      <h1 class="page-header__title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(projectName)} · Tracks</h1>
    </div>
  `;
  container.appendChild(header);

  const recorderCard = document.createElement('div');
  recorderCard.className = 'card stack';
  recorderCard.style.marginBottom = 'var(--space-4)';
  container.appendChild(recorderCard);

  const listWrap = document.createElement('div');
  listWrap.appendChild(createLoadingState('Loading tracks…'));
  container.appendChild(listWrap);

  let durationTimer = null;

  function renderRecorder(state) {
    recorderCard.innerHTML = '';
    if (durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }

    if (!state) {
      recorderCard.innerHTML = `
        <div class="card__title" style="margin:0">New GPS Track</div>
        <div class="form-group">
          <label class="form-label" for="track-name-input">Track Name (optional)</label>
          <input id="track-name-input" type="text" class="form-input" placeholder="e.g. North Ridge Transect" />
        </div>
        <button type="button" id="start-track-btn" class="btn btn--primary btn--full">📍 Start Track</button>
      `;

      recorderCard.querySelector('#start-track-btn').addEventListener('click', async () => {
        const name = recorderCard.querySelector('#track-name-input').value;
        try {
          await startTrack(projectId, name);
          toast.success('GPS track recording started.');
          await renderTracksList();
        } catch (err) {
          toast.error(err.message || 'Failed to start track.');
        }
      });
      return;
    }

    const isRecording = state.track.status === 'recording';
    recorderCard.innerHTML = `
      <div class="row row--between">
        <div>
          <div class="card__title" style="margin:0">${escapeHtml(state.track.name)}</div>
          <div class="text-xs text-muted">${state.wakeLockActive ? '🔆 Screen Wake Lock active' : 'Wake Lock inactive'}</div>
        </div>
        ${_statusBadge(state.track.status)}
      </div>
      <div class="track-stats">
        <div class="track-stat">
          <div class="track-stat__val" id="live-duration">${_formatDuration(state.track.started_at)}</div>
          <div class="track-stat__label">Duration</div>
        </div>
        <div class="track-stat">
          <div class="track-stat__val">${escapeHtml(_formatDistance(state.distanceM))}</div>
          <div class="track-stat__label">Distance</div>
        </div>
        <div class="track-stat">
          <div class="track-stat__val">${state.pointCount}</div>
          <div class="track-stat__label">Points</div>
        </div>
      </div>
      <div class="text-xs text-muted">
        Accuracy: ${state.lastAccuracy !== null ? `±${state.lastAccuracy} m` : state.lastRawAccuracy !== null ? `±${state.lastRawAccuracy} m (filtered)` : 'Waiting for GPS…'}
        ${state.bufferedCount > 0 ? ` · ${state.bufferedCount} buffered` : ''}
      </div>
      ${state.lastError
        ? `<div class="offline-banner" role="alert" style="margin:0">
             <span aria-hidden="true">⚠️</span>
             <span>${escapeHtml(state.lastError)}</span>
           </div>`
        : ''}
      <div class="row" style="gap:var(--space-2)">
        <button type="button" id="pause-resume-btn" class="btn btn--secondary" style="flex:1">
          ${isRecording ? '⏸ Pause' : '▶ Resume'}
        </button>
        <button type="button" id="stop-track-btn" class="btn btn--danger" style="flex:1">⏹ Stop</button>
      </div>
    `;

    if (isRecording) {
      const durEl = recorderCard.querySelector('#live-duration');
      durationTimer = setInterval(() => {
        if (durEl) durEl.textContent = _formatDuration(state.track.started_at);
      }, 1000);
    }

    recorderCard.querySelector('#pause-resume-btn').addEventListener('click', async () => {
      try {
        if (isRecording) {
          await pauseTrack();
          toast.info('Track paused.');
        } else {
          await resumeTrack();
          toast.success('Track resumed.');
        }
        await renderTracksList();
      } catch (err) {
        toast.error(err.message || 'Failed to update track.');
      }
    });

    recorderCard.querySelector('#stop-track-btn').addEventListener('click', async () => {
      try {
        const stopped = await stopTrack();
        toast.success(`Track "${stopped?.name || ''}" saved.`);
        await renderTracksList();
      } catch (err) {
        toast.error(err.message || 'Failed to stop track.');
      }
    });
  }

  async function renderTracksList() {
    const tracks = await listTracks(projectId);
    listWrap.innerHTML = '';

    if (tracks.length === 0) {
      listWrap.appendChild(
        createEmptyState({
          icon:    '📍',
          title:   'No GPS tracks yet',
          message: 'Tap Start Track above to record a field transect offline.',
        })
      );
      return;
    }

    const list = document.createElement('div');
    list.className = 'list';

    for (const track of tracks) {
      const points = await getTrackPoints(track.id);
      const distM  = computeTrackDistance(points);
      const dur    = _formatDuration(track.started_at, track.ended_at);

      const card = document.createElement('div');
      card.className = 'card stack stack--sm';

      card.innerHTML = `
        <a href="#/t/${encodeURIComponent(track.id)}" style="text-decoration:none;color:inherit;display:block">
          <div class="row row--between" style="margin-bottom:var(--space-1)">
            <div class="card__title" style="margin:0">${escapeHtml(track.name)}</div>
            ${_statusBadge(track.status)}
          </div>
          <div class="card__subtitle">
            ${escapeHtml(_formatDistance(distM))} · ${escapeHtml(dur)} · ${points.length} pts
          </div>
          <div class="card__meta">${escapeHtml(formatDate(track.started_at))}</div>
        </a>
      `;

      if (track.status === 'interrupted') {
        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.className = 'btn btn--secondary btn--full';
        resumeBtn.textContent = '▶ Resume as new segment';
        resumeBtn.addEventListener('click', async () => {
          try {
            await resumeInterruptedAsNewSegment(track);
            toast.success('Started new track segment.');
            await renderTracksList();
          } catch (err) {
            toast.error(err.message || 'Could not resume track.');
          }
        });
        card.appendChild(resumeBtn);
      }

      list.appendChild(card);
    }

    listWrap.appendChild(list);
  }

  const unsub = onTrackStateChange((state) => {
    renderRecorder(state);
  });

  router.onCleanup(() => {
    unsub();
    if (durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
  });

  renderRecorder(getActiveTrackState());
  await renderTracksList();
}

// ─── Track Detail View ────────────────────────────────────────────────────────

/**
 * @param {{ trackId: string }} params
 * @param {HTMLElement} container
 */
export async function trackDetailView(params, container) {
  const { trackId } = params;
  const track = await getTrack(trackId);
  container.innerHTML = '';

  if (!track) {
    container.appendChild(
      createEmptyState({
        icon:    '📍',
        title:   'Track not found',
        message: 'This GPS track does not exist in local storage.',
      })
    );
    return;
  }

  const points   = await getTrackPoints(track.id);
  const distM    = computeTrackDistance(points);
  const duration = _formatDuration(track.started_at, track.ended_at);
  const backHref = `#/p/${encodeURIComponent(track.project_id)}/tracks`;

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="stack stack--sm" style="gap:2px;min-width:0;flex:1">
      <a href="${backHref}" class="text-sm text-muted" style="display:inline-block;padding:4px 0">← Tracks</a>
      <h1 class="page-header__title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(track.name)}</h1>
    </div>
    ${_statusBadge(track.status)}
  `;
  container.appendChild(header);

  const card = document.createElement('div');
  card.className = 'card stack';

  card.innerHTML = `
    <div class="track-stats">
      <div class="track-stat">
        <div class="track-stat__val">${escapeHtml(_formatDistance(distM))}</div>
        <div class="track-stat__label">Distance</div>
      </div>
      <div class="track-stat">
        <div class="track-stat__val">${escapeHtml(duration)}</div>
        <div class="track-stat__label">Duration</div>
      </div>
      <div class="track-stat">
        <div class="track-stat__val">${points.length}</div>
        <div class="track-stat__label">Points</div>
      </div>
    </div>
    <div class="track-svg-wrap">
      ${_buildTrackSvg(points)}
    </div>
    <dl class="detail-list">
      <div class="detail-list__row">
        <dt class="detail-list__label">Started</dt>
        <dd class="detail-list__value">${escapeHtml(formatDate(track.started_at))}</dd>
      </div>
      <div class="detail-list__row">
        <dt class="detail-list__label">Ended</dt>
        <dd class="detail-list__value">${track.ended_at ? escapeHtml(formatDate(track.ended_at)) : '—'}</dd>
      </div>
    </dl>
  `;

  const actions = document.createElement('div');
  actions.className = 'stack stack--sm';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn btn--primary btn--full';
  exportBtn.textContent = '⬇️ Export GPX';
  exportBtn.disabled = points.length === 0;
  exportBtn.addEventListener('click', () => {
    _downloadGpx(track, points);
    toast.success('GPX file exported.');
  });
  actions.appendChild(exportBtn);

  if (track.status === 'interrupted') {
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'btn btn--secondary btn--full';
    resumeBtn.textContent = '▶ Resume as new segment';
    resumeBtn.addEventListener('click', async () => {
      try {
        await resumeInterruptedAsNewSegment(track);
        toast.success('Started new track segment.');
        window.location.hash = backHref;
      } catch (err) {
        toast.error(err.message || 'Could not resume track.');
      }
    });
    actions.appendChild(resumeBtn);
  }

  card.appendChild(actions);
  container.appendChild(card);
}

// ─── SVG Polyline Preview ─────────────────────────────────────────────────────

function _buildTrackSvg(points) {
  const W = 320;
  const H = 200;
  const PAD = 18;

  if (!points || points.length === 0) {
    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="No GPS points">
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="13">No GPS points recorded</text>
    </svg>`;
  }

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  const spanLat = maxLat - minLat;
  const spanLng = maxLng - minLng;

  if (points.length === 1 || (spanLat === 0 && spanLng === 0)) {
    return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Single GPS point">
      <circle cx="${W / 2}" cy="${H / 2}" r="6" fill="var(--color-primary)" />
    </svg>`;
  }

  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const toX = (lng) => (spanLng === 0 ? W / 2 : PAD + ((lng - minLng) / spanLng) * innerW);
  const toY = (lat) => (spanLat === 0 ? H / 2 : H - PAD - ((lat - minLat) / spanLat) * innerH);

  const coords = points.map((p) => `${toX(p.lng).toFixed(1)},${toY(p.lat).toFixed(1)}`);
  const start  = points[0];
  const end    = points[points.length - 1];

  return `<svg class="track-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="GPS track preview">
    <polyline fill="none" stroke="var(--color-primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${coords.join(' ')}" />
    <circle cx="${toX(start.lng).toFixed(1)}" cy="${toY(start.lat).toFixed(1)}" r="5" fill="#22c55e" stroke="#ffffff" stroke-width="1.5" />
    <circle cx="${toX(end.lng).toFixed(1)}" cy="${toY(end.lat).toFixed(1)}" r="5" fill="#ef4444" stroke="#ffffff" stroke-width="1.5" />
  </svg>`;
}

// ─── GPX Export ───────────────────────────────────────────────────────────────

function _xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _downloadGpx(track, points) {
  const trkpts = points
    .map((p) => {
      const ele = p.altitude !== null && p.altitude !== undefined ? `<ele>${p.altitude}</ele>` : '';
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${ele}<time>${_xmlEscape(p.ts)}</time></trkpt>`;
    })
    .join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FieldSync" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${_xmlEscape(track.name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const safeName = (track.name || 'track').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  a.href     = url;
  a.download = `${safeName}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
