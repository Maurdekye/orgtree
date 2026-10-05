"""Idle runtime app sessions; no transaction body or commit is ever retried.

Account reads used to start a PostgreSQL backend for every operation. Retain
up to four clean sessions for ten idle minutes, independently of the shared
registry connection. This is an idle cache, not an active-connection limit:
callers never wait while holding other transaction resources.
"""
from __future__ import annotations

import atexit
import contextlib
import threading
import time
from typing import Any, Iterator

from . import conn

MAX_IDLE = 4
IDLE_SECONDS = 600.0
# Include the entire runtime target: distinct roles/clusters must never mix.
Key = tuple[str, str, str]
_idle: list[tuple[Key, Any, float]] = []
_lock = threading.Lock()


def _close(raw: Any) -> None:
    with contextlib.suppress(Exception):
        raw.close()


def _take(key: Key) -> Any:
    import psycopg
    now = time.monotonic()
    stale = []
    found = None
    with _lock:
        for index in range(len(_idle) - 1, -1, -1):
            saved, raw, at = _idle[index]
            if now - at >= IDLE_SECONDS or raw.closed:
                _idle.pop(index)
                stale.append(raw)
            elif saved == key and found is None:
                _idle.pop(index)
                found = raw
    for raw in stale:
        _close(raw)
    if found is not None:
        try:
            if found.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                raise psycopg.OperationalError('idle app session has an open transaction')
            found.execute('SELECT 1')
            return found
        except psycopg.Error:
            _close(found)
    base, database, application = key
    return conn.connect(base, database, application_name=application)


def _put(key: Key, raw: Any) -> None:
    import psycopg
    try:
        if raw.closed or raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
            return
        raw.autocommit = True
        raw.execute('RESET ALL')
        with _lock:
            if len(_idle) < MAX_IDLE:
                _idle.append((key, raw, time.monotonic()))
                raw = None
    except Exception:
        pass
    finally:
        if raw is not None:
            _close(raw)


def close_idle() -> None:
    """Forget retained sessions; outstanding callers still own theirs."""
    with _lock:
        saved = list(_idle)
        _idle.clear()
    for _, raw, _ in saved:
        _close(raw)


@contextlib.contextmanager
def connection(base: str, database: str, *, application_name: str) -> Iterator[Any]:
    """Preserve psycopg's commit/rollback context semantics without closing a
    healthy session. Only a failed pre-body health check may reconnect. Any
    body or commit failure discards the session, without repeating work."""
    key = (base, database, application_name)
    raw = _take(key)
    try:
        try:
            yield raw
            raw.commit()
        except BaseException:
            with contextlib.suppress(Exception):
                raw.rollback()
            raise
        else:
            _put(key, raw)
            raw = None
    finally:
        if raw is not None:
            _close(raw)


atexit.register(close_idle)
