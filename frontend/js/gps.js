// frontend/js/gps.js
// Geolocation API wrapper, one-shot coordinate capture, and background-resilient
// GPS track recording with Wake Lock and buffered Dexie flushes.

import {
  createTrack,
  updateTrack,
  bulkPutTrackPoints,
} from './repo.js';
import { nowIso } from './utils.js';

export const GPS_TIMEOUT_MS       = 20000;
export const MAX_TRACK_ACCURACY_M = 100;
export const MIN_TRACK_MOVE_M     = 3;
export const FLUSH_INTERVAL_MS    = 5000;
export const FLUSH_BATCH_SIZE     = 10;

// ─── Geolocation helpers ──────────────────────────────────────────────────────

function _formatGeoError(err) {
  if (!err) return 'Unable to read GPS location.';
  switch (err.code) {
    case 1: // PERMISSION_DENIED
      return 'Location permission denied. Enable Location access for FieldSync in your browser or device settings and try again.';
    case 2: // POSITION_UNAVAILABLE
      return 'GPS position unavailable. Move to an area with clearer sky view or check that device Location is turned on.';
    case 3: // TIMEOUT
      return 'GPS timed out after 20 seconds. Try again outdoors with a clearer view of the sky.';
    default:
      return err.message || 'Unable to read GPS location.';
  }
}

/**
 * Capture a single high-accuracy GPS fix.
 * @returns {Promise<{ lat: number, lng: number, accuracy: number, altitude: number | null }>}
 */
export function captureCurrentPosition() {
  if (!('geolocation' in navigator)) {
    return Promise.reject(new Error('Geolocation is not supported on this device/browser.'));
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy, altitude } = pos.coords;
        resolve({
          lat:      Number(latitude.toFixed(6)),
          lng:      Number(longitude.toFixed(6)),
          accuracy: Math.round(accuracy * 10) / 10,
          altitude: altitude !== null && altitude !== undefined ? Math.round(altitude * 10) / 10 : null,
        });
      },
      (err) => reject(new Error(_formatGeoError(err))),
      {
        enableHighAccuracy: true,
        timeout:            GPS_TIMEOUT_MS,
        maximumAge:         0,
      }
    );
  });
}

// ─── Distance helpers ─────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371000;

/**
 * Haversine distance between two WGS-84 coordinates in metres.
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute total Haversine distance (in metres) across an ordered array of points.
 * @param {Array<{ lat: number, lng: number }>} points
 * @returns {number}
 */
export function computeTrackDistance(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng
    );
  }
  return total;
}

// ─── Active Track Recorder ────────────────────────────────────────────────────

const _listeners = new Set();

let _state = null; // null when idle
let _watchId = null;
let _flushTimer = null;
let _wakeLock = null;
let _flushing = false;

function _emit() {
  const snapshot = getActiveTrackState();
  for (const cb of _listeners) {
    try { cb(snapshot); } catch (e) { console.warn('[gps] listener error', e); }
  }
}

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator) || _wakeLock) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => {
      _wakeLock = null;
      _emit();
    });
    _emit();
  } catch (err) {
    console.warn('[gps] Wake Lock request failed:', err?.message || err);
  }
}

async function _releaseWakeLock() {
  if (!_wakeLock) return;
  const lock = _wakeLock;
  _wakeLock = null;
  try {
    await lock.release();
  } catch {
    // ignore if already released
  }
  _emit();
}

function _onVisibilityChange() {
  if (
    document.visibilityState === 'visible' &&
    _state &&
    _state.track.status === 'recording'
  ) {
    _acquireWakeLock();
  }
}

async function _flushBuffer() {
  if (_flushing || !_state || _state.buffer.length === 0) return;
  _flushing = true;
  const batch = _state.buffer.splice(0, _state.buffer.length);
  try {
    await bulkPutTrackPoints(batch);
  } catch (err) {
    // Put points back so they aren't lost
    if (_state) {
      _state.buffer.unshift(...batch);
      _state.lastError = err.message || 'Failed to save track points.';
      _emit();
    }
  } finally {
    _flushing = false;
  }
}

function _handlePosition(pos) {
  if (!_state || _state.track.status !== 'recording') return;

  const { latitude, longitude, accuracy, altitude } = pos.coords;
  _state.lastError = null;
  _state.lastRawAccuracy = Math.round(accuracy * 10) / 10;

  if (accuracy > MAX_TRACK_ACCURACY_M) {
    _state.skippedCount += 1;
    _emit();
    return;
  }

  let dist = 0;
  if (_state.lastPoint) {
    dist = haversineMeters(
      _state.lastPoint.lat,
      _state.lastPoint.lng,
      latitude,
      longitude
    );
    if (dist < MIN_TRACK_MOVE_M) {
      _state.skippedCount += 1;
      _emit();
      return;
    }
  }

  const point = {
    track_id: _state.track.id,
    idx:      _state.nextIdx++,
    lat:      Number(latitude.toFixed(6)),
    lng:      Number(longitude.toFixed(6)),
    accuracy: Math.round(accuracy * 10) / 10,
    altitude: altitude !== null && altitude !== undefined ? Math.round(altitude * 10) / 10 : null,
    ts:       nowIso(),
    synced:   0,
  };

  _state.buffer.push(point);
  _state.lastPoint    = point;
  _state.pointCount  += 1;
  _state.distanceM   += dist;
  _state.lastAccuracy = point.accuracy;

  if (_state.buffer.length >= FLUSH_BATCH_SIZE) {
    _flushBuffer();
  }
  _emit();
}

function _handleWatchError(err) {
  if (!_state) return;
  _state.lastError = _formatGeoError(err);
  _emit();
}

function _startWatching() {
  if (!('geolocation' in navigator)) {
    throw new Error('Geolocation is not supported on this device/browser.');
  }
  if (_watchId !== null) {
    navigator.geolocation.clearWatch(_watchId);
  }
  _watchId = navigator.geolocation.watchPosition(_handlePosition, _handleWatchError, {
    enableHighAccuracy: true,
    timeout:            GPS_TIMEOUT_MS,
    maximumAge:         0,
  });

  if (_flushTimer === null) {
    _flushTimer = setInterval(() => {
      _flushBuffer();
    }, FLUSH_INTERVAL_MS);
  }
}

function _stopWatching() {
  if (_watchId !== null) {
    navigator.geolocation.clearWatch(_watchId);
    _watchId = null;
  }
  if (_flushTimer !== null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

/**
 * Subscribe to active track recorder updates.
 * @param {(state: object | null) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onTrackStateChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/**
 * Return a snapshot of the active track recorder state, or null if idle.
 */
export function getActiveTrackState() {
  if (!_state) return null;
  return {
    track:           _state.track,
    pointCount:      _state.pointCount,
    bufferedCount:   _state.buffer.length,
    distanceM:       _state.distanceM,
    lastAccuracy:    _state.lastAccuracy,
    lastRawAccuracy: _state.lastRawAccuracy,
    skippedCount:    _state.skippedCount,
    lastError:       _state.lastError,
    wakeLockActive:  Boolean(_wakeLock),
  };
}

/**
 * Start recording a new GPS track.
 * @param {string} projectId
 * @param {string} [name]
 * @returns {Promise<object>}
 */
export async function startTrack(projectId, name) {
  if (_state) {
    throw new Error('A track is already active. Stop it before starting a new one.');
  }
  if (!('geolocation' in navigator)) {
    throw new Error('Geolocation is not supported on this device/browser.');
  }

  const track = await createTrack(projectId, name);
  _state = {
    track,
    nextIdx:         0,
    lastPoint:       null,
    buffer:          [],
    pointCount:      0,
    distanceM:       0,
    lastAccuracy:    null,
    lastRawAccuracy: null,
    skippedCount:    0,
    lastError:       null,
  };

  document.addEventListener('visibilitychange', _onVisibilityChange);
  _startWatching();
  await _acquireWakeLock();
  _emit();
  return track;
}

/**
 * Pause the currently recording track.
 */
export async function pauseTrack() {
  if (!_state || _state.track.status !== 'recording') return null;
  _stopWatching();
  await _flushBuffer();
  await _releaseWakeLock();
  _state.track = await updateTrack(_state.track.id, { status: 'paused' });
  _emit();
  return _state.track;
}

/**
 * Resume a paused track.
 */
export async function resumeTrack() {
  if (!_state || _state.track.status !== 'paused') return null;
  _state.track = await updateTrack(_state.track.id, { status: 'recording' });
  _startWatching();
  await _acquireWakeLock();
  _emit();
  return _state.track;
}

/**
 * Stop the active track, flush all remaining points, and release Wake Lock.
 */
export async function stopTrack() {
  if (!_state) return null;
  _stopWatching();
  document.removeEventListener('visibilitychange', _onVisibilityChange);
  await _flushBuffer();
  await _releaseWakeLock();
  const stopped = await updateTrack(_state.track.id, {
    status:   'stopped',
    ended_at: nowIso(),
  });
  _state = null;
  _emit();
  return stopped;
}

/**
 * Start a new track segment continuing an interrupted track.
 * @param {object} interruptedTrack
 * @returns {Promise<object>}
 */
export async function resumeInterruptedAsNewSegment(interruptedTrack) {
  const baseName = (interruptedTrack.name || 'Track').replace(/\s*\(cont\.\)$/, '');
  return startTrack(interruptedTrack.project_id, `${baseName} (cont.)`);
}
