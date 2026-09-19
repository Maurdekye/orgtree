"""Durable, bounded sink for slow-request stage attribution.

User decision 2026-09-19 (recorded on the rearchitecture item): every slow
request needs durable end-to-end stage attribution across every route and
tool, with explicit unattributed time, aggregate rankings, privacy-safe
bounded retention, and measured production overhead. The in-memory ring
(`api._PROFILE_RECORDS`) already serves the live view but dies with the
process and only fills while the operator toggle is on — the outage this
decision reacts to was diagnosed hours later, from a cold engine.

So: `api._access_emit` calls `emit()` for every request whose handler time
crosses the threshold, REGARDLESS of the profiling toggle, and the row lands
in `<data>/diagnostics/slow-requests.jsonl`. Rows carry only what the emit
allowlist already vetted — route templates, catalogued tool verbs and finite
numbers — never a path, an argument or content, so the file inherits the
exact privacy boundary of the printed record.

BOUNDED: the file rotates to a single `.1` sibling when it crosses the size
cap, so retention is at most two caps of newest rows. WORKER-READY IDs: every
row carries (instance, pid, seq) — `instance` is the per-process identity the
UI already consumes, so when read work later moves into worker processes,
rows from different processes merge without ambiguity and no re-keying is
needed (sol decision 2026-09-19 21:35Z: design trace identity so worker
isolation requires no rework).

A trace write may never be the reason a request fails: `emit` swallows its
own errors (the caller additionally wraps the whole emit path). It also never
runs under the document lock — `_access_emit` is outside every hold.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

#: Handler-time threshold in ms. Mirrors api._SLOW_MS by default; separate so
#: an operator can trace more aggressively than they alarm.
THRESHOLD_MS = float(os.environ.get("ORGTREE_SLOW_TRACE_MS", "500"))
#: Rotation cap per file; two files retained (current + .1).
_MAX_BYTES = int(float(os.environ.get("ORGTREE_SLOW_TRACE_MAX_KB", "4096")) * 1024)

_LOCK = threading.Lock()
_SEQ = 0


def path() -> str:
    from . import store
    return os.path.join(store.DATA_ROOT, "diagnostics", "slow-requests.jsonl")


def emit(row: dict[str, Any]) -> None:
    """Append one attribution row, rotating first when over the cap."""
    global _SEQ
    try:
        p = path()
        with _LOCK:
            _SEQ += 1
            row = {"seq": _SEQ, "pid": os.getpid(),
                   "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   **row}
            os.makedirs(os.path.dirname(p), exist_ok=True)
            try:
                if os.path.getsize(p) > _MAX_BYTES:
                    os.replace(p, p + ".1")
            except OSError:
                pass                       # no file yet, or a racing reader
            with open(p, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
    except Exception:                                          # noqa: BLE001
        pass       # tracing must never fail the request being traced


def tail(n: int = 200) -> list[dict[str, Any]]:
    """The newest `n` rows, oldest first. Reads the rotated sibling when the
    current file alone cannot supply `n`."""
    rows: list[dict[str, Any]] = []
    p = path()
    for candidate in (p + ".1", p):
        try:
            with open(candidate, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        try:
                            rows.append(json.loads(line))
                        except ValueError:
                            continue       # a torn last line after a crash
        except OSError:
            continue
    return rows[-n:]


def rankings(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate rows per (route, tool): count and handler-time distribution,
    worst first. Pure arithmetic on already-vetted rows."""
    groups: dict[tuple[str, str], list[float]] = {}
    for row in rows:
        key = (str(row.get("route") or "?"), str(row.get("tool") or ""))
        try:
            groups.setdefault(key, []).append(float(row.get("handler_ms") or 0.0))
        except (TypeError, ValueError):
            continue
    out = []
    for (route, tool), xs in groups.items():
        xs.sort()
        out.append({
            "route": route, "tool": tool or None, "n": len(xs),
            "p50_ms": round(xs[len(xs) // 2], 1),
            "p95_ms": round(xs[min(len(xs) - 1, int(len(xs) * 0.95))], 1),
            "max_ms": round(xs[-1], 1),
            "total_ms": round(sum(xs), 1),
        })
    out.sort(key=lambda r: -r["total_ms"])
    return out
