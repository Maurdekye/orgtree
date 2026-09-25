# pyright: strict
"""Per-operation state-access instrumentation (state-access rearchitecture,
Phase 0 — see engine/docs/state-access-rearchitecture.md).

Answers, per OPERATION (a tool verb, a route template, a worker loop), the
questions the rearchitecture needs measured rather than guessed:

  * how long the operation waited for and held the document write lock;
  * how many document loads it performed, how many megabytes each parsed;
  * which lazy sections it materialized, and how many bytes each pulled;
  * what each save actually changed (doc keys, node ids, log sections) and
    how many bytes the differ re-serialized to find that out.

The shipped route-timing middleware (D-239) measures the HTTP boundary and
is blind to everything below it; this measures the storage boundary and
carries the operation label down through worker threads, so a write route's
cost decomposes instead of being one opaque number.

Always importable, near-zero when disabled (one attribute read per hook).
Aggregation is in memory only, bounded, and never touches the documents it
measures. The operator reads it through the diagnostics endpoint; nothing
here writes disk or logs content — labels are templates/verbs, never
arguments, bodies or paths.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator

#: master switch. Starts ON: the per-hook cost is a few dict operations on
#: numbers (measured sub-microsecond), the memory is bounded, and the point
#: of Phase 0 is that the next slow operation arrives already decomposed.
#: The diagnostics endpoint can flip it live.
_ENABLED = True

#: the operation this thread/task is performing, e.g. "tool:orgtree_message",
#: "GET /api/orgs/{slug}/tree", "drain:mail", "turn:worker" — as a string, or
#: as a zero-arg callable resolved at record time (`label_deferred`).
#: ContextVars propagate through asyncio awaits and into anyio's handler
#: threadpool; dedicated worker threads set their own label at their entry.
_OP: ContextVar[Any] = ContextVar("stateprobe_op", default="(unlabelled)")

_lock = threading.Lock()
#: (op, metric) -> [count, ms_sum, bytes_sum, max_ms]
_agg: dict[tuple[str, str], list[float]] = {}
#: recent individual records for the endpoint's drill-down view, bounded.
_ring: deque[dict[str, Any]] = deque(maxlen=1000)
#: (op, section) -> [count, ms_sum, bytes_sum, max_ms] for materializations —
#: kept separately so "which lazy sections does each path pull" is a direct
#: read-off rather than a parse of metric strings.
_lazy: dict[tuple[str, str], list[float]] = {}
_started = time.time()


def enabled() -> bool:
    return _ENABLED


def set_enabled(on: bool) -> None:
    global _ENABLED
    _ENABLED = bool(on)


def current_op() -> str:
    op = _OP.get()
    if callable(op):
        try:
            op = str(op()) or "(unlabelled)"
        except Exception:
            op = "(unlabelled)"
    return op


def label_deferred(resolver: Any) -> None:
    """Label with a zero-arg callable resolved at record time — for the ASGI
    boundary, where the matched route template exists only after routing.
    No reset needed: the contextvar dies with the request task, and handler
    threads run under per-call context copies."""
    _OP.set(resolver)


def refine(label: str) -> None:
    """Replace the label with a more specific one (the tool verb inside the
    generic dispatch route). Deliberately unconditional, unlike
    `operation()`, which keeps the outermost."""
    _OP.set(label)


@contextmanager
def operation(label: str) -> Iterator[None]:
    """Label everything the body does, for threads and tasks alike.

    Nested labels keep the OUTERMOST: the boundary is the unit the user
    experiences, and a helper relabelling mid-flight would split one
    operation's cost across two rows.
    """
    if _OP.get() != "(unlabelled)":
        yield
        return
    token = _OP.set(label)
    try:
        yield
    finally:
        _OP.reset(token)


def set_op(label: str) -> None:
    """Label a dedicated worker thread at its entry point (no reset needed:
    the thread is the operation for its whole life, e.g. a drain sweep)."""
    _OP.set(label)


def record(metric: str, ms: float = 0.0, nbytes: int = 0,
           section: str | None = None, detail: dict[str, Any] | None = None) -> None:
    """One measurement under the current operation label. Cheap and total:
    never raises, never blocks beyond the tiny aggregate lock."""
    if not _ENABLED:
        return
    op = current_op()
    try:
        with _lock:
            row = _agg.get((op, metric))
            if row is None:
                row = _agg[(op, metric)] = [0.0, 0.0, 0.0, 0.0]
            row[0] += 1
            row[1] += ms
            row[2] += nbytes
            if ms > row[3]:
                row[3] = ms
            if section is not None:
                lrow = _lazy.get((op, section))
                if lrow is None:
                    lrow = _lazy[(op, section)] = [0.0, 0.0, 0.0, 0.0]
                lrow[0] += 1
                lrow[1] += ms
                lrow[2] += nbytes
                if ms > lrow[3]:
                    lrow[3] = ms
            if detail is not None:
                _ring.append({"op": op, "metric": metric, "ms": round(ms, 3),
                              "bytes": nbytes, **detail})
    except Exception:
        # instrumentation must never fail the operation it measures
        pass


def snapshot(reset: bool = False) -> dict[str, Any]:
    """The aggregate table for the diagnostics endpoint."""
    with _lock:
        ops: dict[str, dict[str, dict[str, float]]] = {}
        for (op, metric), (n, ms, nb, mx) in _agg.items():
            ops.setdefault(op, {})[metric] = {
                "n": int(n), "ms_sum": round(ms, 1),
                "ms_avg": round(ms / n, 2) if n else 0.0,
                "ms_max": round(mx, 1), "bytes_sum": int(nb)}
        lazy: dict[str, dict[str, dict[str, float]]] = {}
        for (op, sect), (n, ms, nb, mx) in _lazy.items():
            lazy.setdefault(op, {})[sect] = {
                "n": int(n), "ms_sum": round(ms, 1),
                "ms_max": round(mx, 1), "bytes_sum": int(nb)}
        recent = list(_ring)
        if reset:
            _agg.clear()
            _lazy.clear()
            _ring.clear()
    return {"enabled": _ENABLED, "since": _started, "operations": ops,
            "lazy_materializations": lazy, "recent": recent}


class SaveChanges:
    """What one save actually changed — collected at the differ's own write
    statements, so it is exact rather than re-derived. Also the input the
    section-granular read cache (Phase A) invalidates from."""

    __slots__ = ("doc_upserts", "doc_deletes", "node_updates", "node_inserts",
                 "node_deletes", "log_sections", "log_rows", "dumped_bytes")

    def __init__(self) -> None:
        self.doc_upserts: list[str] = []
        self.doc_deletes: list[str] = []
        self.node_updates: list[str] = []
        self.node_inserts: list[str] = []
        self.node_deletes: list[str] = []
        #: lazy sections whose rows or blob this save touched, in any way
        self.log_sections: set[str] = set()
        #: total data rows written into log tables (appends + rewrites)
        self.log_rows: int = 0
        #: bytes the differ serialized to decide/perform the write — the
        #: CPU cost driver the rearchitecture exists to shrink
        self.dumped_bytes: int = 0

    def is_empty(self) -> bool:
        return not (self.doc_upserts or self.doc_deletes or self.node_updates
                    or self.node_inserts or self.node_deletes
                    or self.log_sections)

    def changed_keys(self) -> set[str]:
        """Top-level sections a reader cache must refresh."""
        # an owner row of a split section (`mail\x1f<nid>`, store.SPLIT_SEP)
        # refreshes its section
        out = {k.partition("\x1f")[0]
               for k in (*self.doc_upserts, *self.doc_deletes)} | self.log_sections
        if self.node_updates or self.node_inserts or self.node_deletes:
            out.add("nodes")
        return out

    def as_dict(self) -> dict[str, Any]:
        return {"doc_upserts": list(self.doc_upserts),
                "doc_deletes": list(self.doc_deletes),
                "node_updates": list(self.node_updates),
                "node_inserts": list(self.node_inserts),
                "node_deletes": list(self.node_deletes),
                "log_sections": sorted(self.log_sections),
                "log_rows": self.log_rows,
                "dumped_bytes": self.dumped_bytes}
