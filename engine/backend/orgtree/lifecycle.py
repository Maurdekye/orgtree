"""Small durable lifecycle ledger shared by mail, tasks and watchdogs.

The runtime has several independent durable records (mail rows, watchdogs,
and provider task ids).  This module deliberately stores only identity and
state, not bodies or credentials.  A bounded ledger gives restart-safe
correlation without turning status polling into an unbounded append log.
"""

from __future__ import annotations

import uuid
from typing import Any, Mapping

MAX_RECORDS = 512


def identity(kind: str, value: Any) -> str:
    """Return the stable, non-secret identity used by a lifecycle record."""
    return f"{str(kind).strip()}:{str(value).strip()}"


def new_operation(kind: str) -> str:
    return identity(kind, uuid.uuid4().hex)


def _records(doc: dict[str, Any]) -> list[dict[str, Any]]:
    rows = doc.setdefault("lifecycle", [])
    if not isinstance(rows, list):
        rows = []
        doc["lifecycle"] = rows
    return rows


def record(doc: dict[str, Any], *, operation_id: str, kind: str,
           state: str, at: str, **fields: Any) -> dict[str, Any]:
    """Record one state transition, coalescing an identical repeated state.

    Different observed boundaries must remain visible: only the same
    ``operation_id`` and ``state`` coalesce, and the row keeps a count plus the
    most recent observation.  The returned mapping is the stored row.
    """
    rows = _records(doc)
    found = next((r for r in reversed(rows)
                  if r.get("operation_id") == operation_id
                  and r.get("state") == state), None)
    if found is not None:
        found["count"] = int(found.get("count") or 1) + 1
        found["last_at"] = at
        found.update(fields)
        return found
    row: dict[str, Any] = {
        "operation_id": operation_id, "kind": kind, "state": state,
        "at": at, "count": 1, **fields,
    }
    rows.append(row)
    del rows[:-MAX_RECORDS]
    return row


def latest(doc: Mapping[str, Any], operation_id: str) -> dict[str, Any] | None:
    rows = doc.get("lifecycle")
    if not isinstance(rows, list):
        return None
    for row in reversed(rows):
        if isinstance(row, dict) and row.get("operation_id") == operation_id:
            return row
    return None


def has_state(doc: Mapping[str, Any], operation_id: str, state: str) -> bool:
    rows = doc.get("lifecycle")
    return isinstance(rows, list) and any(
        isinstance(row, dict) and row.get("operation_id") == operation_id
        and row.get("state") == state for row in rows)
