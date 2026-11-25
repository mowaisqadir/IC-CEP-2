"""
backend/app/merge.py
Field-level last-write-wins merge (mirrors frontend/js/merge.js).
See PROJECT_CONTEXT.md §4 for the exact specification.
"""

import json
from typing import Any

from app.hlc import compare


def _values_equal(a: Any, b: Any) -> bool:
    """Shallow/JSON-safe value equality check matching JS JSON.stringify semantics."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if a == b:
        return True
    if a is None or b is None or not isinstance(a, (dict, list)) or not isinstance(b, (dict, list)):
        return False
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def merge_fields(
    local_data: dict[str, Any] | None,
    local_fv: dict[str, str] | None,
    incoming_fields: dict[str, dict[str, Any]] | None,
    local_deleted: bool = False,
) -> dict[str, Any]:
    """
    Merge incoming field updates into local record data/fv using HLC LWW.

    Returns a dict with keys:
      - data: dict[str, Any]
      - fv: dict[str, str]
      - overwritten: list[dict[str, Any]]
      - deleted: bool
      - deleted_hlc: str | None
      - changed: bool (True if any field or deleted state actually changed)
    """
    data: dict[str, Any] = dict(local_data or {})
    fv: dict[str, str] = dict(local_fv or {})
    overwritten: list[dict[str, Any]] = []
    deleted = bool(local_deleted)
    initial_deleted = deleted
    initial_deleted_hlc = fv.get("deleted")
    changed = False

    for field, incoming in (incoming_fields or {}).items():
        if not isinstance(incoming, dict) or not isinstance(incoming.get("hlc"), str):
            continue

        incoming_hlc = incoming["hlc"]
        incoming_val = incoming.get("v")
        local_hlc = fv.get(field)

        wins = local_hlc is None or compare(incoming_hlc, local_hlc) > 0
        if not wins:
            continue

        local_value = deleted if field == "deleted" else data.get(field)
        if local_hlc is not None and not _values_equal(local_value, incoming_val):
            overwritten.append(
                {
                    "field": field,
                    "localValue": local_value,
                    "remoteValue": incoming_val,
                }
            )

        fv[field] = incoming_hlc
        changed = True
        if field == "deleted":
            deleted = bool(incoming_val)
        else:
            data[field] = incoming_val

    # Revival rule (PROJECT_CONTEXT.md §4):
    # If deleted is true with deleted_hlc = D, and any data field has HLC E > D,
    # the record is revived (deleted = false).
    deleted_hlc = fv.get("deleted")
    if deleted and deleted_hlc:
        for field, field_hlc in fv.items():
            if field == "deleted":
                continue
            if compare(field_hlc, deleted_hlc) > 0:
                deleted = False
                break

    final_deleted_hlc = deleted_hlc if deleted else None
    if deleted != initial_deleted or final_deleted_hlc != initial_deleted_hlc:
        changed = True

    return {
        "data": data,
        "fv": fv,
        "overwritten": overwritten,
        "deleted": deleted,
        "deleted_hlc": final_deleted_hlc,
        "changed": changed,
    }
