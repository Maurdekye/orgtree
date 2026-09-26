"""Small durable lifecycle ledger shared by mail, tasks and watchdogs.

The runtime has several independent durable records (mail rows, watchdogs,
and provider task ids).  This module deliberately stores only identity and
state, not bodies or credentials.  A bounded ledger gives restart-safe
correlation without turning status polling into an unbounded append log.
"""

from __future__ import annotations

import queue
import threading
import uuid
from typing import Any, Mapping

MAX_RECORDS = 512
#: PG-3d: an over-cap write prunes to here, so eviction runs once per
#: MAX_RECORDS - PRUNE_TO writes instead of on every write at the cap
PRUNE_TO = 448
# A delay report is a durable de-duplication decision for a delivery that can
# remain unread longer than the ordinary traffic ring.  It must outlive
# unrelated observations, but the ring must still have a hard bound.
_STICKY_STATES = frozenset({"delay_reported"})

# S8 (lead decision 8 on the scale parent, superseding 5; decision 29's lock-free appends kept).
# On the ROW store the ledger is a list log (store.LIST_LOGS) that writers
# only APPEND to, without a lock, so every mail send stays parallel. Safe
# because a writer never edits a row another transaction may hold: it
# coalesces only onto a row appended in ITS OWN transaction (not yet
# committed), and eviction is not done inline — one serialized pruner
# (`prune`, which takes `PRUNE_LOCK` FOR UPDATE) deletes whole rows from the
# committed set it loaded, so an append committed meanwhile is never touched.
# A repeated state seen by two transactions is therefore two rows, not one
# row with count 2; `latest` / `has_state` read the same either way, and no
# caller reads `count`. On a plain dict (the JSON backend's whole-document
# cycle under DOC_LOCK, `Org.create`, fixtures) the old in-place behaviour
# stays: that cycle is serialized.
# Limits (p01, accepted): (a) a prune is triggered only by a later org_tx
# COMMIT on the org, so an org that meanwhile sees only legacy DOC_LOCK saves
# (the fence period) is not pruned until some org_tx commits there — bounded
# in practice; (b) the append count is per process and resets at restart, and
# `over_cap` is seen only when the ledger is materialized, so a ledger already
# over the cap at boot may wait up to PRUNE_EVERY appends. Appends of a
# transaction that later rolls back still count: a prune only comes early.
#: the pruner's own row: a doc key no writer uses, locked FOR UPDATE only by
#: `prune`, so two pruners serialize while appends take no lock at all
PRUNE_LOCK = "lifecycle_prune"
#: row-store appends by THIS process per org before a prune is due. A due
#: org is handed to ONE background pruner thread after the next org_tx on it
#: commits (a commit listener), so no request ever waits on a prune (p01)
PRUNE_EVERY = 64
_due_lock = threading.Lock()
_appended: dict[str, int] = {}
_due: set[str] = set()
_listening = False
_queue: "queue.SimpleQueue[str]" = queue.SimpleQueue()
_worker: threading.Thread | None = None
#: set whenever the pruner thread has nothing queued or in hand (tests)
idle = threading.Event()
idle.set()


def identity(kind: str, value: Any) -> str:
    """Return the stable, non-secret identity used by a lifecycle record."""
    return f"{str(kind).strip()}:{str(value).strip()}"


def new_operation(kind: str) -> str:
    return identity(kind, uuid.uuid4().hex)


def _fresh(doc: Any) -> list[dict[str, Any]] | None:
    """The ledger rows this transaction appended itself (never committed),
    or None for a plain-dict document (the serialized whole-document cycle).
    Rows loaded from the store are never returned: another transaction may
    hold them, so they are not ours to edit."""
    from . import store
    if not isinstance(doc, store.LazyDoc):
        return None
    if dict.__contains__(doc, "lifecycle"):       # materialized: loaded + fresh
        rows = dict.__getitem__(doc, "lifecycle")
        ids = getattr(rows, "_row_ids", None)
        if not isinstance(rows, list) or ids is None or len(ids) != len(rows):
            return []                             # identity unknown: coalesce nothing
        return [r for r, i in zip(rows, ids) if i is None and isinstance(r, dict)]
    pending = doc._pending.get("lifecycle") or []  # pyright: ignore[reportPrivateUsage]
    return [r for r in pending if isinstance(r, dict)]


def _note_append(slug: str, over_cap: bool = False) -> None:
    """Count one row-store append; mark the org due for a prune (at once
    when the writer could see the ledger is over the cap)."""
    global _listening
    with _due_lock:
        _appended[slug] = _appended.get(slug, 0) + 1
        if over_cap or _appended[slug] >= PRUNE_EVERY:
            _appended[slug] = 0
            _due.add(slug)
        if _listening:
            return
        _listening = True
    from . import orgtx
    orgtx.commit_listeners.append(_after_commit)


def _after_commit(committed: Any) -> None:
    """orgtx commit listener: hand a due org to the pruner thread. Never
    prunes here — this runs on the committing (request) thread."""
    global _worker
    slug = committed.slug
    with _due_lock:
        if slug not in _due:
            return
        _due.discard(slug)
        idle.clear()
        _queue.put(slug)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_prune_worker, name="lifecycle-pruner",
                                       daemon=True)
            _worker.start()


def _prune_worker() -> None:
    """The one pruner thread. A failed prune (a lock timeout, a deleted org)
    leaves the org due for the next commit on it."""
    while True:
        slug = _queue.get()
        try:
            prune(slug)
        except Exception:                                  # noqa: BLE001
            with _due_lock:
                _due.add(slug)
        finally:
            with _due_lock:
                if _queue.empty():
                    idle.set()


def prune(slug: str) -> int:
    """THE pruner: past MAX_RECORDS, delete down to PRUNE_TO, oldest
    non-sticky rows first (the sticky ones only if nothing else is left).
    Serialized by `PRUNE_LOCK`; it deletes only rows of the committed set it
    loaded, so rows appended concurrently are never lost. Returns how many
    rows it removed."""
    from . import orgtx
    with orgtx.org_tx(slug, logs=["lifecycle"], sections=[PRUNE_LOCK]) as tx:
        rows = tx.d.get("lifecycle")
        if not isinstance(rows, list) or len(rows) <= MAX_RECORDS:
            return 0
        removed = 0
        while len(rows) > PRUNE_TO:
            index = next((i for i, item in enumerate(rows)
                          if not isinstance(item, dict)
                          or item.get("state") not in _STICKY_STATES), 0)
            rows.pop(index)
            removed += 1
        return removed


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

    On the row store only a row appended in THIS transaction coalesces, and
    no eviction is done here (see the module note and `prune`).
    """
    fresh = _fresh(doc)
    if fresh is not None:
        found = next((r for r in reversed(fresh)
                      if r.get("operation_id") == operation_id
                      and r.get("state") == state), None)
        if found is not None:
            found["count"] = int(found.get("count") or 1) + 1
            found["last_at"] = at
            found.update(fields)
            return found
        from . import store
        row = {"operation_id": operation_id, "kind": kind, "state": state,
               "at": at, "count": 1, **fields}
        store.log_append(doc, "lifecycle", row)
        seen = dict.get(doc, "lifecycle")          # only if already materialized
        _note_append(str(dict.get(doc, "slug") or doc._slug),   # pyright: ignore[reportPrivateUsage]
                     over_cap=isinstance(seen, list) and len(seen) > MAX_RECORDS)
        return row
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
    # Evict ordinary observations first.  A sticky decision is retained while
    # there is any non-sticky history to discard, so a long-stuck delivery
    # cannot re-alarm merely because 512 unrelated writes occurred.  If the
    # ledger is made entirely of sticky decisions, the same hard cap still
    # applies and the oldest decision is removed.
    # PG-3d: in a BATCH, down to PRUNE_TO, not one row per write. The ledger
    # is a row log (store.LIST_LOGS): an append is a free INSERT, but every
    # eviction deletes an existing row, and at the cap one-per-write would
    # make every two concurrent writers collide on the same front row.
    if len(rows) > MAX_RECORDS:
        while len(rows) > PRUNE_TO:
            index = next((i for i, item in enumerate(rows)
                          if item.get("state") not in _STICKY_STATES), 0)
            rows.pop(index)
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
