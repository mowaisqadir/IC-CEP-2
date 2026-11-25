// frontend/js/hlc.js
// Hybrid Logical Clock — now(), receive(), compare().
// See PROJECT_CONTEXT.md §3 for the exact specification.
//
// Format:
//   <13-digit zero-padded wall-clock ms>-<4-digit zero-padded counter>-<deviceId>
//
// Pure functions: pass (lastHlc, deviceId) explicitly for deterministic use
// inside Dexie transactions, or omit them for quick browser-console testing.

const MAX_COUNTER = 9999;

let _consoleLast = null;
const _consoleDeviceId = 'console';

/**
 * Format wall ms, counter, and deviceId into an HLC string.
 * @param {number} wallMs
 * @param {number} counter
 * @param {string} deviceId
 * @returns {string}
 */
export function formatHlc(wallMs, counter, deviceId) {
  const wallStr    = String(Math.max(0, Math.floor(wallMs))).padStart(13, '0');
  const counterStr = String(Math.max(0, Math.floor(counter))).padStart(4, '0');
  return `${wallStr}-${counterStr}-${deviceId}`;
}

/**
 * Parse an HLC string into its components.
 * @param {string} hlcStr
 * @returns {{ wall: number, counter: number, deviceId: string }}
 */
export function parseHlc(hlcStr) {
  const firstDash  = hlcStr.indexOf('-');
  const secondDash = hlcStr.indexOf('-', firstDash + 1);
  if (firstDash === -1 || secondDash === -1) {
    throw new Error(`Invalid HLC string: ${hlcStr}`);
  }
  return {
    wall:     Number(hlcStr.slice(0, firstDash)),
    counter:  Number(hlcStr.slice(firstDash + 1, secondDash)),
    deviceId: hlcStr.slice(secondDash + 1),
  };
}

/**
 * Lexicographic comparison of two HLC strings.
 * Because wall ms and counter are zero-padded to fixed widths,
 * lexicographic order equals causal order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Advance the HLC for a local event.
 *
 * Pure when `lastHlc` and `deviceId` are provided.
 * When called with no arguments in the console, maintains internal test state.
 *
 * @param {string|null} [lastHlc]
 * @param {string}      [deviceId]
 * @param {number}      [wallMs=Date.now()]
 * @returns {string}
 */
export function now(lastHlc, deviceId, wallMs = Date.now()) {
  const useConsole = arguments.length === 0;
  const prev       = useConsole ? _consoleLast : (lastHlc ?? null);
  const dev        = deviceId || _consoleDeviceId;
  const nowWall    = Math.max(0, Math.floor(wallMs));

  let nextWall    = nowWall;
  let nextCounter = 0;

  if (prev) {
    const parsed = parseHlc(prev);
    if (nowWall > parsed.wall) {
      nextWall    = nowWall;
      nextCounter = 0;
    } else {
      nextWall    = parsed.wall;
      nextCounter = parsed.counter + 1;
      if (nextCounter > MAX_COUNTER) {
        nextWall   += 1;
        nextCounter = 0;
      }
    }
  }

  const next = formatHlc(nextWall, nextCounter, dev);
  if (useConsole) _consoleLast = next;
  return next;
}

/**
 * Advance the local HLC upon receiving a remote HLC.
 *
 * Pure when `localHlc` and `deviceId` are provided.
 *
 * @param {string}      remoteHlc
 * @param {string|null} [localHlc]
 * @param {string}      [deviceId]
 * @param {number}      [wallMs=Date.now()]
 * @returns {string}
 */
export function receive(remoteHlc, localHlc, deviceId, wallMs = Date.now()) {
  const useConsole = arguments.length <= 1;
  const prev       = useConsole ? _consoleLast : (localHlc ?? null);
  const dev        = deviceId || _consoleDeviceId;
  const nowWall    = Math.max(0, Math.floor(wallMs));

  const remote = parseHlc(remoteHlc);
  const local  = prev ? parseHlc(prev) : { wall: -1, counter: 0 };

  const maxWall = Math.max(nowWall, local.wall, remote.wall);

  let nextCounter = 0;
  if (maxWall === local.wall && maxWall === remote.wall) {
    nextCounter = Math.max(local.counter, remote.counter) + 1;
  } else if (maxWall === local.wall) {
    nextCounter = local.counter + 1;
  } else if (maxWall === remote.wall) {
    nextCounter = remote.counter + 1;
  }

  let finalWall = maxWall;
  if (nextCounter > MAX_COUNTER) {
    finalWall  += 1;
    nextCounter = 0;
  }

  const next = formatHlc(finalWall, nextCounter, dev);
  if (useConsole) _consoleLast = next;
  return next;
}
