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

Waiters block on one condition variable with NO timeout; nothing polls (review
f1: a periodic re-check is polling, however slow). A waiter whose turn is
abandoned while queued (interrupt, halt, retire) is woken through `wake()` and
leaves the queue without taking a slot — so EVERY path that sets a cancel flag
a waiter reads must call `wake()` afterwards (today: supervisor.interrupt_turn,
halt._cut_state, halt.request, halt.recover). `max_wait` exists only for
tests; production passes none.

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
    def __new__(cls, limit: int = DEFAULT_LIMIT) -> Any:
        # The one-process alpha keeps memory slots until the host configures
        # the durable scheduler. Its identity comes from bind_request.
        if cls is FairSlots:
            from .orgdb import enabled
            if enabled() and _database_queue is not None:
                return DatabaseSlots()
        return super().__new__(cls)

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
                max_wait: float | None = None) -> None:
        """Block until this caller holds a slot; raise `Cancelled` if
        `cancelled()` turns true first — re-checked only when the condition
        is notified (release, set_limit, wake). `on_queued` is called once,
        outside the lock, when the caller actually has to wait."""
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


# The orgdb adapter is deliberately lazy: importing the supervisor must not
# open a connection or register another engine instance. The host configures
# its existing instance after bootstrap and drives its heartbeat every 5 s.
_database_queue: Any = None
_database_instance: int | None = None
_database_resolver: Callable[[str, str], tuple[int, int]] | None = None
_request_context = threading.local()


def configure(instance_id: int, connect: Callable[[], Any] | None = None,
              resolve: Callable[[str, str], tuple[int, int]] | None = None) -> None:
    """Host startup: install its existing registered instance and runtime DB.

    The instance heartbeat belongs to the host, never to a waiting thread:
    a paused owner must not look alive because some unrelated waiter runs.
    """
    from .turnqueue import Queue
    global _database_queue, _database_instance, _database_resolver
    if _database_instance is not None and _database_instance != instance_id:
        raise RuntimeError("turn queue already configured for another engine instance")
    _database_queue = Queue(connect) if connect is not None else Queue()
    _database_instance = instance_id
    _database_resolver = resolve


def bind_agent(org: str, agent: str, lane: str = "turn") -> Any:
    """Transitional caller identity until durable org start_turn jobs land.

    The host resolver reads registry.org_id and the org agents.id by name.
    A UUID is minted once per attempt, not each enqueue retry. Legacy callers
    take the same slot path without requesting any database identity.
    """
    from contextlib import nullcontext
    from .orgdb import enabled
    if not enabled() or _database_queue is None:
        return nullcontext()
    _configured()
    if _database_resolver is None:
        raise RuntimeError("orgdb turn admission needs the host's org/agent identity resolver")
    from .turnqueue import Request
    from uuid import uuid4
    org_id, agent_id = _database_resolver(org, agent)
    return bind_request(Request(str(uuid4()), org_id, agent_id, agent, lane))


def bind_request(request: Any) -> Any:
    """Around a start_turn handler/turn: supply its durable turnqueue.Request.

    The org request must already be queued. This context never mints an id.
    It must cover acquire and release on the same thread. Host/job wiring
    supplies the org CAS at start and its finish/stop acknowledgement.
    """
    from contextlib import contextmanager

    @contextmanager
    def bound() -> Any:
        previous = getattr(_request_context, "request", None)
        _request_context.request = request
        try:
            yield
        finally:
            _request_context.request = previous
    return bound()


def _configured() -> tuple[Any, int]:
    if _database_queue is None or _database_instance is None:
        raise RuntimeError("orgdb turn admission needs turnslots.configure after host bootstrap")
    return _database_queue, _database_instance


class _DatabaseAttempt:
    """Retained until an abandoned acquire or stopped provider is resolved."""
    def __init__(self, request: Any, instance: int) -> None:
        from uuid import uuid4
        self.request = request
        self.instance = instance
        self.token = str(uuid4())
        self.ticket: Any = None
        self.action: str | None = None
        self.resolved = False
        self.error: Exception | None = None
        self.lock = threading.Lock()


class DatabaseSlots:
    """Existing blocking slot interface over durable tickets.

    A single shared listener versions wakeups; its catch-up after LISTEN
    covers startup. NOTIFY is only a hint; each wake re-reads the ticket.
    At the 5 s process-lease boundary we re-check too, covering reconnects/
    missed notices. No thread here refreshes a lease or reclaims a worker.
    The host drives those actions separately.
    """
    def __init__(self) -> None:
        self._held = threading.local()
        self._cond = threading.Condition()
        self._version = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._recovery: dict[str, _DatabaseAttempt] = {}

    def _remember(self, attempt: _DatabaseAttempt, action: str) -> None:
        with self._cond:
            attempt.action = action
            if not attempt.resolved:
                self._recovery[attempt.token] = attempt

    @staticmethod
    def _finished(queue: Any, attempt: _DatabaseAttempt) -> None:
        from .turnqueue import LostClaim
        ticket = attempt.ticket
        write_error: Exception | None = None
        try:
            if queue.finish(ticket):
                return
        except Exception as exc:
            write_error = exc
        current = queue.get(ticket.request_id)
        if (current is not None and current.owner == ticket.owner and current.token == ticket.token):
            # A finish/ack can commit while its reply is lost. These precise
            # terminal states resolve that uncertainty without another run.
            if current.state == 'done' and current.epoch == ticket.epoch:
                return
            if current.state == 'cancelled' and current.epoch == ticket.epoch + 1:
                return
            if current.state == 'stopping' and current.epoch == ticket.epoch + 1:
                try:
                    if queue.acknowledge_stop(current.request_id, current.owner, current.epoch):
                        return
                except Exception as exc:
                    write_error = exc
                after = queue.get(ticket.request_id)
                if (after is not None and after.owner == current.owner and after.token == current.token
                        and after.epoch == current.epoch and after.state == 'cancelled'):
                    return
            if write_error is not None and current.state in ('running', 'stopping'):
                raise write_error
        # Only an authoritative different/terminal claim resolves fencing.
        # A LostClaim exception from a failed write alone is still uncertain.
        attempt.error = LostClaim("turn finished after its claim was lost")
        attempt.resolved = True
        raise attempt.error

    def _resolve(self, queue: Any, attempt: _DatabaseAttempt) -> None:
        with attempt.lock:
            if attempt.resolved:
                if attempt.error is not None:
                    raise attempt.error
                return
            try:
                if attempt.action == 'abandon':
                    queue.cancel_unstarted(attempt.request, attempt.instance, attempt.token)
                else:
                    self._finished(queue, attempt)
                attempt.resolved = True
            finally:
                if attempt.resolved:
                    with self._cond:
                        self._recovery.pop(attempt.token, None)

    def recover_pending(self) -> None:
        """Retry retained local outcomes at notifications/lease boundaries.

        Only abandoned acquires and providers whose release was called are
        eligible. This never stops or finishes a provider that is still active.
        A connection error retains the record for a later pass.
        """
        queue, _ = _configured()
        with self._cond:
            pending = list(self._recovery.values())
        for attempt in pending:
            try:
                self._resolve(queue, attempt)
            except Exception:
                pass  # unresolved records stay; definitive fencing is retained

    def pending_recovery(self) -> list[dict[str, Any]]:
        """Host diagnostics: outcomes not yet resolved, never discarded."""
        with self._cond:
            return [{"request_id": a.request.request_id, "owner": a.instance,
                     "claim_token": a.token, "action": a.action} for a in self._recovery.values()]

    def _changed(self) -> None:
        with self._cond:
            self._version += 1
            self._cond.notify_all()

    def _listen(self) -> None:
        from .turnqueue import HEARTBEAT_SECONDS
        while not self._stop.is_set():
            try:
                queue, _ = _configured()
                with queue.connect() as c:
                    c.execute("LISTEN turn_tickets")
                    c.commit()
                    self.recover_pending()
                    self._changed()  # catch-up after connect before any sleep
                    while not self._stop.is_set():
                        for _notice in c.notifies(timeout=HEARTBEAT_SECONDS, stop_after=1):
                            break
                        self.recover_pending()
                        self._changed()  # also reread at the lease boundary
            except Exception:
                self.recover_pending()
                self._changed()  # callers re-read and receive their DB error
                self._stop.wait(1)

    def _start(self) -> None:
        with self._cond:
            if self._stop.is_set():
                raise RuntimeError("turn-slot listener is closed")
            if self._thread is None:
                self._thread = threading.Thread(target=self._listen, name="turn-slot-listener", daemon=True)
                self._thread.start()

    def close(self) -> None:
        """Host shutdown; also used by verification to join the listener."""
        self._stop.set()
        self._changed()
        if self._thread is not None:
            self._thread.join(10)
            if self._thread.is_alive():
                raise RuntimeError("turn-slot listener did not stop")
        self.recover_pending()
        if self.pending_recovery():
            raise RuntimeError("turn-slot shutdown has unresolved database outcomes; host must retain or reclaim them")

    @property
    def limit(self) -> int:
        return self.snapshot()["limit"]

    def set_limit(self, limit: int) -> None:
        queue, _ = _configured()
        queue.set_limit(limit)

    def snapshot(self) -> dict[str, Any]:
        queue, _ = _configured()
        return queue.snapshot()

    def wake(self) -> None:
        self._changed()
        queue, _ = _configured()
        with queue.connect() as c:
            c.execute("SELECT pg_notify('turn_tickets', 'wake')")

    def acquire(self, org: str, cancelled: Callable[[], bool] = lambda: False,
                on_queued: Callable[[dict[str, Any]], None] | None = None,
                max_wait: float | None = None) -> None:
        from .turnqueue import LostClaim
        queue, instance = _configured()
        request = getattr(_request_context, "request", None)
        if request is None:
            raise RuntimeError("orgdb turn admission needs a durable bind_request context")
        previous = getattr(self._held, "attempt", None)
        if previous is not None and previous.resolved:
            # The listener may have resolved a failed release after its
            # caller unwound. A reused worker thread can now take its next
            # turn; only authoritative completion clears this local claim.
            self._held.ticket = None
            self._held.attempt = None
        if getattr(self._held, "ticket", None) is not None:
            raise RuntimeError("this thread already holds a turn slot")
        self._start()
        attempt = _DatabaseAttempt(request, instance)
        try:
            ticket = queue.enqueue(request, instance)
            announced_limit: int | None = None
            since = time.time()
            while True:
                with self._cond:
                    version = self._version
                if self._stop.is_set():
                    raise Cancelled()
                if ticket.state == "running":
                    # A duplicate request/job cannot launch this claim again.
                    raise LostClaim("request was already admitted")
                if ticket.state != "waiting":
                    raise Cancelled()
                if ticket.owner != instance:
                    raise LostClaim("another engine owns this waiting attempt")
                if cancelled():
                    raise Cancelled()
                claimed = queue.claim(instance, request.request_id, claim_token=attempt.token)
                if claimed is not None:
                    attempt.ticket = claimed
                    if cancelled():
                        raise Cancelled()
                    self._held.ticket = claimed
                    self._held.attempt = attempt
                    return
                if on_queued is not None:
                    view = queue.snapshot()
                    if view["limit"] != announced_limit:
                        announced_limit = view["limit"]
                        on_queued({"since": since, "limit": view["limit"], "waiting": view["waiting"]})
                with self._cond:
                    # Any commit between the read and wait increments version.
                    # The listener's catch-up after LISTEN covers startup too.
                    if version == self._version and not self._stop.is_set():
                        self._cond.wait(max_wait)
                ticket = queue.get(request.request_id)
                if ticket is None:
                    raise LostClaim("org or turn ticket was removed")
        except BaseException:
            # The provider has not started. Record identity BEFORE cleanup:
            # enqueue/claim/cancel may have committed while their reply was
            # lost, and cleanup itself may temporarily be unable to reach PG.
            self._remember(attempt, 'abandon')
            try:
                self._resolve(queue, attempt)
            except Exception:
                pass
            self._changed()
            raise

    @property
    def current_claim(self) -> Any:
        """Start/finish wiring reads this thread's admitted numbered claim."""
        return getattr(self._held, "ticket", None)

    def release(self) -> None:
        queue, _ = _configured()
        ticket = getattr(self._held, "ticket", None)
        if ticket is None:
            raise RuntimeError("turn slot released more times than acquired")
        attempt = self._held.attempt
        # release means the provider scope has stopped. The exact claim stays
        # available to this caller until completion is authoritative. A failed
        # call can be retried here, and the shared listener also reconciles it.
        self._remember(attempt, 'finish')
        try:
            self._resolve(queue, attempt)
        finally:
            if attempt.resolved:
                self._held.ticket = None
                self._held.attempt = None
