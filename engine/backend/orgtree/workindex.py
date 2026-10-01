"""Health controls for the derived PostgreSQL docket index.

The raw doc/log rows remain authoritative. Reconciliation is an explicit
migration/diagnostic operation, never a foreground poll. Future bounded readers
must require `ready` and use the exact compatibility path when it is false.
No read path is switched by this storage-only slice.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def ready(raw: Any, org_id: int) -> bool:
    """Constant-size health read inside the caller's committed snapshot."""
    schema = f"org_{int(org_id)}"
    if raw.execute("SELECT to_regclass(%s)", (schema + ".work_index_state",)).fetchone()[0] is None:
        return False
    row = raw.execute(f"SELECT format,valid FROM {schema}.work_index_state WHERE singleton").fetchone()
    return ready_row(row)


def ready_row(row: Any) -> bool:
    """`ready`'s verdict on a (format, valid) row already read."""
    return bool(row and row[0] == "orgtree.work-index/v1" and row[1])


def reconcile(raw: Any, org_id: int) -> bool:
    """Compare maintained metadata/counts/hashes against raw rows atomically.

    The SHARE locks prevent a writer changing source rows between the raw scan
    and health update. A nested caller retains these locks until its outer
    transaction ends. Call at an explicit maintenance boundary, not per read.
    A mismatch logs ERROR, marks the index unavailable, and returns false so
    callers retain exact compatibility behavior. Corrupt JSON/schema errors
    propagate; they must never become an empty successful answer.
    """
    schema = f"org_{int(org_id)}"
    with raw.transaction():
        raw.execute(f"LOCK TABLE {schema}.doc,{schema}.log_l IN SHARE MODE")
        valid = bool(raw.execute("SELECT public.orgtree_check_work_index(%s)", (int(org_id),)).fetchone()[0])
        raw.execute(f"UPDATE {schema}.work_index_state SET valid=%s WHERE singleton", (valid,))
    if not valid:
        log.error("Docket index reconciliation mismatch for org %s; indexed reads disabled; use exact raw path", org_id)
    return valid
