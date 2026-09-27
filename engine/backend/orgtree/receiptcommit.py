"""Receipt baseline callbacks owned by the actual PostgreSQL transaction.

The org_tx save loop suppresses intermediate COMMITs. These callbacks must be
released by that loop only after its final server COMMIT, never by a save tail.
No receipt reader or writer is activated by this module.
"""
from __future__ import annotations
from collections.abc import Callable, Iterable
from typing import Any


def defer(conn: Any, callback: Callable[[], None]) -> None:
    """Queue adoption before commit. The transaction owner must finish/discard."""
    if not conn.in_transaction:
        raise RuntimeError('receipt adoption requires an open transaction')
    callbacks = getattr(conn, '_receipt_adoptions', None)
    if callbacks is None:
        callbacks = conn._receipt_adoptions = []
    callbacks.append(callback)


def committed(conns: Iterable[Any]) -> None:
    """Called by the transaction owner AFTER successful server COMMIT.

    IDLE is only a misuse check, not evidence of commit: the caller must know
    COMMIT succeeded. Drain first so a failure cannot cause callbacks to replay.
    All callbacks are attempted; the first error is then propagated.
    """
    conns = tuple(conns)
    if any(conn.in_transaction for conn in conns):
        raise RuntimeError('receipt adoption before server commit')
    callbacks = []
    for conn in conns:
        callbacks.extend(getattr(conn, '_receipt_adoptions', ()))
        conn._receipt_adoptions = []
    first = None
    for callback in callbacks:
        try:
            callback()
        except Exception as exc:
            if first is None:
                first = exc
    if first is not None:
        raise first


def discard(conns: Iterable[Any]) -> None:
    """Rollback/aborted save: leave original receipt baselines untouched."""
    for conn in conns:
        conn._receipt_adoptions = []
