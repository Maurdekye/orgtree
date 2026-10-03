"""Durable record of slow, org-wide and failed org transactions.

Item engine-logging-persist-the-engine-s-output-and-r (user request
2026-10-03). The live org jammed for ~9 minutes that morning and nothing
could say which transaction held the org-wide `node:*` lock: lock timeouts
name only the waiting statement, and the engine kept no record of how long
any transaction waited for or held its locks.

`orgtx` marks every attempt's lock points (`mark`, from `orgtx._pause`) and
calls `finish` when the attempt ends. `finish` appends ONE JSON line to
`<data>/diagnostics/slow-transactions.jsonl` when the attempt

  * waited for its locks >= THRESHOLD_MS, or held them >= THRESHOLD_MS,
  * took `nodes=ALL` or `whole` (org-wide, rare, and what other transactions
    queue behind),
  * or ended in an exception (a lock timeout, deadlock, serialization
    failure or any error).

A line carries: UTC time, pid, org slug, the caller label (`label()`), the
lock plan summary (flags, counts, up to 20 node ids, section names, logs),
wait/hold ms and the outcome. On a LOCK TIMEOUT it also carries `blockers`:
the other database sessions that hold or wait for advisory locks at that
moment (pid, their own caller label from `application_name`, state,
transaction age, what they wait on, who blocks them). Every org transaction
tags its session with its caller label (`app_name`, `SET LOCAL
application_name` in the BEGIN batch), which is what makes a blocker
nameable.

PRIVACY: plan names are node ids and section names; labels are route
templates, tool verbs or function names. No statement text is recorded
except the leading words of orgtree's own lock statements, so no message
body, token or key can reach the file.

NEVER FAILS A TRANSACTION: every entry point swallows its own errors, and
the cost when nothing is logged is a few clock reads per attempt. The file
rotates to `.1`/`.2` past MAX_BYTES (three files at most).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from typing import Any

#: Log an attempt that waited for or held its locks at least this long.
THRESHOLD_MS = float(os.environ.get("ORGTREE_TXLOG_MS", "1000"))
#: Rotation cap per file; the current file and two rotated ones are kept.
MAX_BYTES = int(float(os.environ.get("ORGTREE_TXLOG_MAX_MB", "10")) * 1024 * 1024)
KEEP = 2
#: Node ids listed per plan (the counts are always exact).
MAX_IDS = 20
#: Blocker sessions listed per lock timeout.
MAX_BLOCKERS = 20
#: The prefix every org transaction's application_name carries.
APP_PREFIX = "orgtree:"

_LOCK = threading.Lock()
_SKIP_FILES = ("orgtx.py", "halt.py", "txlog.py", "contextlib.py", "lifecycle_tx.py",
               "pgdoor.py", "settingstx.py", "tx.py")
_SAFE = re.compile(r"[^A-Za-z0-9 _./{}:@#-]")


def path() -> str:
    from . import store
    return os.path.join(store.DATA_ROOT, "diagnostics", "slow-transactions.jsonl")


def label() -> str:
    """Who is running this transaction: the HTTP route template or agent
    tool verb of the request being served (`stateprobe`), else the nearest
    calling function outside the transaction machinery (a background loop)."""
    try:
        from . import stateprobe
        op = stateprobe.current_op()
        if op and op != "(unlabelled)":
            return _clean(op)
    except Exception:                                           # noqa: BLE001
        pass
    try:
        f = sys._getframe(2)
        for _ in range(16):
            if f is None:
                break
            name = os.path.basename(f.f_code.co_filename)
            if name not in _SKIP_FILES:
                return _clean(f"{name[:-3] if name.endswith('.py') else name}.{f.f_code.co_name}")
            f = f.f_back
    except Exception:                                           # noqa: BLE001
        pass
    return "(unknown)"


def _clean(s: str) -> str:
    return _SAFE.sub("_", str(s))[:80]


def app_name(tx: Any) -> str:
    """The SQL literal for `SET LOCAL application_name` (quotes doubled; the
    label is already restricted to safe characters)."""
    name = (APP_PREFIX + str(getattr(tx, "log_label", "") or "(unknown)"))[:63]
    return "'" + name.replace("'", "''") + "'"


def mark(point: str, tx: Any) -> None:
    """Record when an attempt reached a lock point (orgtx._pause)."""
    try:
        tx.log_marks[point] = time.perf_counter()
    except Exception:                                           # noqa: BLE001
        pass


def _plan(tx: Any) -> dict[str, Any]:
    nodes = sorted(tx.lock_nodes)
    share = sorted(tx.share_nodes)
    return {"all_nodes": bool(tx.all_nodes), "whole": bool(tx.whole),
            "nodes": len(nodes), "node_ids": nodes[:MAX_IDS],
            "share_nodes": len(share), "share_node_ids": share[:MAX_IDS],
            "sections": sorted(tx.lock_sections),
            "share_sections": sorted(tx.share_sections),
            "logs": sorted(str(x if isinstance(x, str) else x[0]) for x in tx.logs)}


def finish(txs: list[Any], started: float, exc: BaseException | None) -> None:
    """One attempt of `org_tx` ended (committed, replayed or raised)."""
    try:
        now = time.perf_counter()
        for tx in txs:
            m = getattr(tx, "log_marks", None) or {}
            begin = m.get("before_lock", started)
            locked = m.get("after_lock")
            wait_ms = ((locked if locked is not None else now) - begin) * 1000.0
            hold_ms = ((now - locked) * 1000.0) if locked is not None else 0.0
            wide = bool(tx.all_nodes or tx.whole)
            if exc is None and not wide and wait_ms < THRESHOLD_MS and hold_ms < THRESHOLD_MS:
                continue
            row: dict[str, Any] = {
                "org": tx.slug, "label": getattr(tx, "log_label", "") or "(unknown)",
                "wait_ms": round(wait_ms, 1), "hold_ms": round(hold_ms, 1),
                "outcome": ("replayed" if tx.replayed else "committed") if exc is None
                else type(exc).__name__,
                "plan": _plan(tx)}
            if exc is not None:
                row["error"] = _clean(str(exc).splitlines()[0] if str(exc) else "")[:200]
                from .orgtx import LockTimeout
                if isinstance(exc, LockTimeout):
                    row["blockers"] = blockers()
            emit(row)
    except Exception:                                           # noqa: BLE001
        pass


def blockers() -> list[dict[str, Any]] | str:
    """The OTHER database sessions holding or waiting for advisory locks
    right now (orgtree's row locks are advisory keys plus row locks), each
    with who blocks it. A separate short connection: the timed-out one is
    in a failed transaction. Statement text is reduced to the leading words
    of orgtree's own lock statements."""
    try:
        from . import store
        if store.STORE_BACKEND != "postgres":
            return []
        from . import pgstore
        with pgstore.connect() as c:
            rows = c.execute(
                "SELECT a.pid, a.application_name, a.state, a.wait_event_type, "
                "round(extract(epoch FROM now() - a.xact_start) * 1000), "
                "pg_blocking_pids(a.pid), "
                "bool_or(l.granted), bool_or(NOT l.granted), left(a.query, 40) "
                "FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid "
                "WHERE l.locktype = 'advisory' AND a.pid <> pg_backend_pid() "
                "GROUP BY a.pid, a.application_name, a.state, a.wait_event_type, "
                "a.xact_start, a.query "
                "ORDER BY a.xact_start NULLS LAST LIMIT %s", (MAX_BLOCKERS,)).fetchall()
        out = []
        for pid, app, state, wait, age, by, holds, waits, q in rows:
            q = str(q or "")
            kind = ("lock block" if q.startswith("DO $orgtx_")
                    else "advisory lock" if q.startswith("SELECT pg_advisory")
                    else (q.split(None, 1)[0].upper() if q.strip() else ""))
            out.append({"pid": pid, "label": _clean(app or ""), "state": state,
                        "waiting_on": wait, "xact_ms": age, "blocked_by": list(by or []),
                        "holds_advisory": bool(holds), "waits_advisory": bool(waits),
                        "statement": kind})
        return out
    except Exception as e:                                      # noqa: BLE001
        return f"unavailable: {type(e).__name__}"


def emit(row: dict[str, Any]) -> None:
    """Append one line, rotating first when the file is over the cap."""
    try:
        p = path()
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "pid": os.getpid(), **row}
        line = json.dumps(row, sort_keys=True, default=str) + "\n"
        with _LOCK:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            try:
                if os.path.getsize(p) > MAX_BYTES:
                    for i in range(KEEP, 0, -1):
                        src = p if i == 1 else f"{p}.{i - 1}"
                        if os.path.exists(src):
                            os.replace(src, f"{p}.{i}")
            except OSError:
                pass                       # no file yet, or a racing reader
            with open(p, "a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:                                           # noqa: BLE001
        pass
