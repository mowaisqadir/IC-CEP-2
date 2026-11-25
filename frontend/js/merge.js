// frontend/js/merge.js
// Field-level last-write-wins merge (mirrors backend/app/merge.py).
// See PROJECT_CONTEXT.md §4 for the exact specification.
// Pure, no DB access — written for 1:1 portability to Python.

import { compare } from './hlc.js';

/**
 * Shallow-safe value equality check for primitive and JSON-serialisable values.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge incoming field updates into local record data/fv using HLC LWW.
 *
 * @param {Record<string, any>}                          localData
 * @param {Record<string, string>}                       localFv
 * @param {Record<string, { v: any, hlc: string }>}      incomingFields
 * @param {boolean}                                      [localDeleted=false]
 * @returns {{
 *   data: Record<string, any>,
 *   fv: Record<string, string>,
 *   overwritten: Array<{ field: string, localValue: any, remoteValue: any }>,
 *   deleted: boolean,
 *   deleted_hlc: string | null,
 * }}
 */
export function mergeFields(localData, localFv, incomingFields, localDeleted = false) {
  const data = { ...(localData || {}) };
  const fv   = { ...(localFv || {}) };
  const overwritten = [];
  let deleted = Boolean(localDeleted);

  for (const [field, incoming] of Object.entries(incomingFields || {})) {
    if (!incoming || typeof incoming.hlc !== 'string') continue;

    const localHlc = fv[field];
    const wins = !localHlc || compare(incoming.hlc, localHlc) > 0;
    if (!wins) continue;

    const localValue = field === 'deleted' ? deleted : data[field];
    if (localHlc !== undefined && !valuesEqual(localValue, incoming.v)) {
      overwritten.push({
        field,
        localValue,
        remoteValue: incoming.v,
      });
    }

    fv[field] = incoming.hlc;
    if (field === 'deleted') {
      deleted = Boolean(incoming.v);
    } else {
      data[field] = incoming.v;
    }
  }

  // Revival rule (PROJECT_CONTEXT.md §4):
  // If deleted is true with deleted_hlc = D, and any data field has HLC E > D,
  // the record is revived (deleted = false).
  const deletedHlc = fv.deleted ?? null;
  if (deleted && deletedHlc) {
    for (const [field, fieldHlc] of Object.entries(fv)) {
      if (field === 'deleted') continue;
      if (compare(fieldHlc, deletedHlc) > 0) {
        deleted = false;
        break;
      }
    }
  }

  return {
    data,
    fv,
    overwritten,
    deleted,
    deleted_hlc: deleted ? deletedHlc : null,
  };
}
