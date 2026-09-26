"""The machine-wide turn-slot budget, admitted FAIRLY (user ruling 2026-09-26).

At most `limit` agent turns hold a slot at once, across every org on the
instance. It replaces a bare `threading.Semaphore` whose waiters each spun on
`acquire(timeout=0.1)`: that had no order at all, so a turn that arrived a
moment ago could overtake one that had waited minutes, and one busy org could
starve a quiet one ("Nothing enforces fairness").

The rules, the user's:
  · the limit is a SETTING (default 16), changed live without a restart;
  · FIRST COME, FIRST SERVED within an org;
  · FAIR ACROSS ORGS: a freed slot goes to the next org, in round-robin order
    after the org served last, that has a waiter — so an org with fifty
    waiters and an org with one alternate instead of the one waiting behind
    the fifty.

Waiters block on one condition variable; nothing polls. A waiter whose turn is
abandoned while queued (interrupt, halt, retire) is woken through `wake()` and
leaves the queue without taking a slot. `max_wait` is only a safety net for a
cancel flag set by a path that forgot to call `wake()`.

Lowering the limit never preempts: running turns finish, and nothing is
admitted until the count falls below the new limit. Raising it admits waiters
at once.
"""
from __future__ import annotations

import collections
import itertools
import threading
import time
from typing import Any, Callable

DEFAULT_LIMIT = 16
MAX_LIMIT = 512


class Cancelled(Exception):
    """The waiter was cancelled before it was granted a slot."""


class _Ticket:
    __slots__ = ("org", "seq", "since", "granted", "gone")

    def __init__(self, org: str, seq: int) -> None:
        self.org = org
        self.seq = seq
        self.since = time.time()
        self.granted = False
        self.gone = False


class FairSlots:
    def __init__(self, limit: int = DEFAULT_LIMIT) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._limit = _clamp(limit)
        self._held = 0
        # org -> FIFO of waiting tickets. `_ring` is the round-robin order:
        # orgs in order of first arrival, one entry per org, so it is only
        # ever as long as the number of orgs on the instance.
        self._queues: dict[str, collections.deque[_Ticket]] = {}
        self._ring: list[str] = []
        self._last_org: str | None = None
        self._seq = itertools.count()

    # ── settings ───────────────────────────────────────────────────────
    @property
    def limit(self) -> int:
        return self._limit

    def set_limit(self, limit: int) -> None:
        with self._cond:
            self._limit = _clamp(limit)
            self._dispatch()
            self._cond.notify_all()

    # ── the queue ──────────────────────────────────────────────────────
    def acquire(self, org: str, cancelled: Callable[[], bool] = lambda: False,
                on_queued: Callable[[dict[str, Any]], None] | None = None,
                max_wait: float = 5.0) -> None:
        """Block until this caller holds a slot; raise `Cancelled` if
        `cancelled()` turns true first. `on_queued` is called once, outside
        the lock, when the caller actually has to wait."""
        with self._cond:
            t = _Ticket(org, next(self._seq))
            if org not in self._queues:
                self._queues[org] = collections.deque()
                self._ring.append(org)
            self._queues[org].append(t)
            self._dispatch()
            if t.granted:
                return
            info = {"since": t.since, "limit": self._limit,
                    "waiting": self._waiting_locked()}
        if on_queued is not None:
            on_queued(info)
        with self._cond:
            while not t.granted:
                if cancelled():
                    self._abandon(t)
                    raise Cancelled()
                self._cond.wait(max_wait)
            if cancelled():
                # granted and cancelled in the same instant: hand it on
                self._held -= 1
                self._dispatch()
                self._cond.notify_all()
                raise Cancelled()

    def release(self) -> None:
        with self._cond:
            if self._held <= 0:
                raise RuntimeError("turn slot released more times than acquired")
            self._held -= 1
            self._dispatch()
            self._cond.notify_all()

    def wake(self) -> None:
        """Re-check every waiter's cancel flag now (call after setting one)."""
        with self._cond:
            self._cond.notify_all()

    def snapshot(self) -> dict[str, Any]:
        with self._cond:
            return {"limit": self._limit, "held": self._held,
                    "waiting": self._waiting_locked(),
                    "waiting_by_org": {o: len(q) for o, q in self._queues.items() if q}}

    # ── internals (lock held) ──────────────────────────────────────────
    def _waiting_locked(self) -> int:
        return sum(len(q) for q in self._queues.values())

    def _abandon(self, t: _Ticket) -> None:
        t.gone = True
        q = self._queues.get(t.org)
        if q is not None:
            try:
                q.remove(t)
            except ValueError:
                pass

    def _next_org(self) -> str | None:
        """Round-robin over the ring of orgs (in order of first arrival),
        starting AFTER the org served last."""
        ring = self._ring
        if not ring:
            return None
        start = ring.index(self._last_org) + 1 if self._last_org in ring else 0
        for k in range(len(ring)):
            org = ring[(start + k) % len(ring)]
            if self._queues[org]:
                return org
        return None

    def _dispatch(self) -> None:
        while self._held < self._limit:
            org = self._next_org()
            if org is None:
                return
            t = self._queues[org].popleft()
            t.granted = True
            self._held += 1
            self._last_org = org


def _clamp(limit: Any) -> int:
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    # 0 is legal HERE (a closed gate — tests use it); the user-facing
    # setting refuses anything below 1 (appsettings.MAX_TURNS_MIN)
    return max(0, min(MAX_LIMIT, n))
