"""Per-org jobs, leases and scheduling (design 2.7).

enqueue/claim/sweep/fail are transaction-local: pass the org transaction's
psycopg connection. Enqueue commits with the condition that requires the job.
An active (kind, dedupe_key) is idempotent; finished keys may be enqueued again.

execute() owns a short transaction. It fences the attempt and locks the row
through the handler and completion. A lease sweep skips that lock. A crashed
transaction rolls back, so reclaim may retry it without duplicate DB effects.
Handlers receive that connection and MUST put org writes in it. External
effects need their own idempotency key (for example cross-org message_id): a
lease cannot promise exactly-once effects in a different database or service.

Worker is standalone until the engine host wires its domain handlers. It uses
only runtime connections, LISTENs for served orgs and checks dormant orgs every
60 seconds. A failed org or handler does not stop another org's jobs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import logging
import math
import select
import threading
import time
from typing import Any, Callable, Iterable, Mapping

from . import app_pool, conn, names

LOG = logging.getLogger(__name__)
CHANNEL = 'org_jobs'
_COLUMNS = ('id', 'kind', 'agent_id', 'item_id', 'watchdog_id', 'run_at', 'state',
            'attempts', 'max_attempts', 'lease_owner', 'lease_until', 'last_error', 'dedupe_key')
_RETURNING = ', '.join('j.' + col for col in _COLUMNS)

# Literal predicates match the partial indexes even under prepared plans.
CLAIM_SQL = """
WITH due AS (
  SELECT id FROM orgtree.jobs
  WHERE state = 'queued' AND run_at <= statement_timestamp()
  ORDER BY run_at, id LIMIT %s FOR UPDATE SKIP LOCKED
)
UPDATE orgtree.jobs AS j
SET state = 'running', attempts = attempts + 1, lease_owner = %s,
    lease_until = clock_timestamp() + %s * interval '1 second'
FROM due WHERE j.id = due.id
RETURNING """ + _RETURNING

SWEEP_SQL = """
WITH stale AS (
  SELECT id FROM orgtree.jobs
  WHERE state = 'running' AND lease_until <= statement_timestamp()
  ORDER BY lease_until, id LIMIT %s FOR UPDATE SKIP LOCKED
)
UPDATE orgtree.jobs AS j
SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    run_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL,
    last_error = 'lease expired'
FROM stale WHERE j.id = stale.id RETURNING j.id
"""


@dataclass(frozen=True)
class Job:
    id: int
    kind: str
    agent_id: int | None
    item_id: int | None
    watchdog_id: int | None
    run_at: datetime
    state: str
    attempts: int
    max_attempts: int
    lease_owner: int | None
    lease_until: datetime | None
    last_error: str | None
    dedupe_key: str


@dataclass(frozen=True)
class Org:
    org_id: int
    slug: str
    database: str
    org_uuid: str


Handler = Callable[[Any, Job], None]


def _job(row: Any) -> Job:
    return Job(**row) if isinstance(row, dict) else Job(*row)


def _positive(value: float, label: str) -> float:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{label} must be finite and positive')
    return value


def _count(value: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f'{label} must be a positive integer')
    return value


def enqueue(c: Any, kind: str, dedupe_key: str, *, run_at: datetime | None = None,
            agent_id: int | None = None, item_id: int | None = None,
            watchdog_id: int | None = None, max_attempts: int = 5) -> Job:
    """Create once while active; duplicates retain the original arguments.

    The conflict update locks only the same job and returns its current row,
    even when a concurrent enqueue has just committed. It changes no due time.
    """
    if not kind or not dedupe_key:
        raise ValueError('kind and dedupe_key must be non-empty')
    _count(max_attempts, 'max_attempts')
    if run_at is not None and (run_at.tzinfo is None or run_at.utcoffset() is None):
        raise ValueError('run_at must include a timezone')
    row = c.execute("""
        INSERT INTO orgtree.jobs AS j
          (kind, dedupe_key, run_at, agent_id, item_id, watchdog_id, max_attempts)
        VALUES (%s, %s, coalesce(%s, clock_timestamp()), %s, %s, %s, %s)
        ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued', 'running')
        DO UPDATE SET dedupe_key = excluded.dedupe_key
        RETURNING """ + _RETURNING,
        (kind, dedupe_key, run_at, agent_id, item_id, watchdog_id, max_attempts)).fetchone()
    return _job(row)


def claim(c: Any, owner: int, *, limit: int = 1, lease_seconds: float = 30) -> list[Job]:
    """Lease due rows without waiting for rows another worker has locked.

    Commit before execution. Each successful claim increments attempts: that
    number fences old workers even if a process reuses the same owner string.
    """
    _count(owner, 'owner (engine_instances.id)')
    _count(limit, 'limit')
    _positive(lease_seconds, 'lease_seconds')
    rows = c.execute(CLAIM_SQL, (limit, owner, lease_seconds)).fetchall()
    return [_job(row) for row in rows]


def next_due(c: Any) -> datetime | None:
    """Next queued job or lease expiry, using two active-only index probes."""
    row = c.execute("""
        SELECT least(
          (SELECT min(run_at) FROM orgtree.jobs WHERE state = 'queued'),
          (SELECT min(lease_until) FROM orgtree.jobs WHERE state = 'running'))
        """).fetchone()
    return row['least'] if isinstance(row, dict) else row[0]


def sweep(c: Any, *, limit: int = 1000) -> int:
    """Release expired leases or fail their exhausted last attempt.

    A handler still running in its org transaction holds the row lock, so this
    skips it. A crash rolls back the handler and releases that lock. Reclaimed
    attempts are immediately due; handler failures use backoff below.
    """
    _count(limit, 'limit')
    return len(c.execute(SWEEP_SQL, (limit,)).fetchall())


def backoff(attempt: int, *, base_seconds: float = 1, cap_seconds: float = 300) -> float:
    _count(attempt, 'attempt')
    _positive(base_seconds, 'base_seconds')
    _positive(cap_seconds, 'cap_seconds')
    return min(cap_seconds, base_seconds * 2 ** min(attempt - 1, 62))


def fail(c: Any, job: Job, error: str, *, base_seconds: float = 1,
         cap_seconds: float = 300) -> bool:
    """Retry or fail this exact attempt; a reclaimed job cannot be changed."""
    delay = backoff(job.attempts, base_seconds=base_seconds, cap_seconds=cap_seconds)
    return c.execute("""
        UPDATE orgtree.jobs
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            run_at = clock_timestamp() + %s * interval '1 second',
            last_error = %s, lease_owner = NULL, lease_until = NULL
        WHERE id = %s AND state = 'running' AND lease_owner = %s AND attempts = %s
        RETURNING id
        """, (delay, error, job.id, job.lease_owner, job.attempts)).fetchone() is not None


def execute(c: Any, job: Job, handler: Handler, *, base_seconds: float = 1,
            cap_seconds: float = 300) -> bool:
    """Run the current, unexpired attempt and commit its effects with 'done'.

    False means it was stale, and no handler ran. Handler exceptions
    roll back all its org effects; then a separate transaction records retry.
    Returns True for an attempt that ran, even when its handler failed.

    Handler authors must bump orgtree.org_revision and NOTIFY org_rev
    '<slug>:<rev>' for org record changes, in this same transaction. Take the
    revision row lock last (design 2.5); use the feed helper when integrated.
    """
    ran = False
    try:
        with c.transaction():
            row = c.execute("""
                SELECT """ + ', '.join(_COLUMNS) + """ FROM orgtree.jobs
                WHERE id = %s AND state = 'running' AND lease_owner = %s
                  AND attempts = %s AND lease_until > clock_timestamp()
                FOR UPDATE
                """, (job.id, job.lease_owner, job.attempts)).fetchone()
            if row is None:
                return False
            # A claimant's READ COMMITTED recheck can briefly hold this same
            # row, even though its state no longer matches the queue. Wait on
            # our row only, then check expiry again after that wait.
            current = _job(row)
            valid = c.execute('SELECT %s > clock_timestamp() AS valid',
                              (current.lease_until,)).fetchone()
            if not (valid['valid'] if isinstance(valid, dict) else valid[0]):
                return False
            ran = True
            handler(c, current)
            c.execute("UPDATE orgtree.jobs SET state = 'done', lease_owner = NULL, "
                      "lease_until = NULL WHERE id = %s", (job.id,))
    except Exception as exc:
        # Connection/commit failures may leave the outcome unknown. The token
        # guard makes this safe even if the completion actually committed.
        if not ran:
            raise
        with c.transaction():
            fail(c, job, f'{type(exc).__name__}: {exc}',
                 base_seconds=base_seconds, cap_seconds=cap_seconds)
    return True


class Runtime:
    """Runtime-only registry enumeration and identity-checked org connections.

    The host may replace both callbacks with its registry/pool adapters. No
    migration, lifecycle write or admin connection happens in this module.
    """

    def __init__(self, base: str | None = None, *, prefix: str | None = None) -> None:
        self.base = base or conn.runtime_base()
        self.prefix = prefix or names.prefix()

    def active_orgs(self) -> list[Org]:
        with app_pool.connection(self.base, names.app(self.prefix),
                          application_name='orgtree-jobs-registry') as c:
            rows = c.execute("SELECT org_id, slug, database, org_uuid::text FROM orgtree.orgs "
                             "WHERE state = 'active' AND op_kind IS NULL ORDER BY org_id").fetchall()
        return [Org(*r) for r in rows]

    def connect(self, org: Org) -> Any:
        c = conn.connect(self.base, org.database, application_name='orgtree-jobs')
        try:
            identity = c.execute('SELECT org_uuid::text, slug FROM orgtree.org_identity').fetchone()
            if identity != (org.org_uuid, org.slug):
                raise ValueError(f'org identity mismatch: {org.slug}')
            return c
        except BaseException:
            c.close()
            raise


@dataclass
class _Served:
    org: Org
    listener: Any
    due: datetime | None
    retry_at: float = 0.0


class Worker:
    """Serve all active orgs without retaining idle org connections.

    A sweep opens each dormant org, LISTENs before reading the next due time,
    and closes it if nothing is due within sweep_seconds (60 by default).
    Served orgs wake at their deadline or a notification. One bounded turn
    per org prevents a busy org starving the others. Handlers must be short.
    """

    def __init__(self, handlers: Mapping[str, Handler], *, owner: int,
                 active_orgs: Callable[[], Iterable[Org]] | None = None,
                 connect: Callable[[Org], Any] | None = None,
                 sweep_seconds: float = 60,
                 lease_seconds: float = 30, jobs_per_org: int = 16,
                 on_error: Callable[[Org | None, Exception], None] | None = None) -> None:
        if active_orgs is None or connect is None:
            runtime = Runtime()
            active_orgs = active_orgs or runtime.active_orgs
            connect = connect or runtime.connect
        self.active_orgs = active_orgs
        self.connect = connect
        self.handlers = dict(handlers)
        self.owner = _count(owner, 'owner (engine_instances.id)')
        self.sweep_seconds = _positive(sweep_seconds, 'sweep_seconds')
        self.lease_seconds = _positive(lease_seconds, 'lease_seconds')
        self.jobs_per_org = _count(jobs_per_org, 'jobs_per_org')
        self.on_error = on_error
        self.served: dict[int, _Served] = {}
        self._next_sweep = 0.0

    def _error(self, org: Org | None, exc: Exception) -> None:
        LOG.warning('job scheduler failure for %s: %s', org.slug if org else 'registry', exc)
        if self.on_error:
            try:
                self.on_error(org, exc)
            except Exception:
                LOG.exception('job scheduler error callback failed')

    def _close(self, key: int) -> None:
        slot = self.served.pop(key)
        try:
            slot.listener.close()
        except Exception as exc:
            self._error(slot.org, exc)

    def _probe(self, org: Org) -> None:
        c = self.connect(org)
        try:
            c.execute('LISTEN org_jobs')   # before reading, so no enqueue is lost
            due = next_due(c)
            if due is not None and due.timestamp() <= time.time() + self.sweep_seconds:
                self.served[org.org_id] = _Served(org, c, due)
                c = None
        finally:
            if c is not None:
                c.close()

    def _sweep_orgs(self) -> None:
        orgs = {org.org_id: org for org in self.active_orgs()}
        for key, slot in list(self.served.items()):
            if orgs.get(key) != slot.org:
                self._close(key)  # unavailable, removed, restored or renamed
        for key, org in orgs.items():
            if key not in self.served:
                try:
                    self._probe(org)
                except Exception as exc:
                    self._error(org, exc)

    def _run_org(self, slot: _Served) -> None:
        # Listener is never used for handler transactions: LISTEN is autocommit.
        progressed = False
        with self.connect(slot.org) as c:
            with c.transaction():
                sweep(c)
            for _ in range(self.jobs_per_org):
                with c.transaction():
                    claimed = claim(c, self.owner, lease_seconds=self.lease_seconds)
                if not claimed:
                    break
                progressed = True
                job = claimed[0]
                handler = self.handlers.get(job.kind)
                if handler is None:
                    with c.transaction():
                        fail(c, job, f'no handler registered for {job.kind}')
                else:
                    execute(c, job, handler)
        slot.due = next_due(slot.listener)
        slot.retry_at = 0.0 if progressed else time.monotonic() + 1.0

    def step(self) -> float:
        """One scheduler turn; return seconds to the next deadline (at most 1).

        run() uses select to wake early for LISTEN. A host with its own event
        loop may drive step() itself and use the listener file descriptors.
        """
        now = time.monotonic()
        if now >= self._next_sweep:
            self._next_sweep = now + self.sweep_seconds
            try:
                self._sweep_orgs()
            except Exception as exc:
                self._error(None, exc)
                # Fail closed: registry unavailable means no cached org runs.
                for key in list(self.served):
                    self._close(key)
        for key, slot in list(self.served.items()):
            try:
                notices = list(slot.listener.notifies(timeout=0))
                if notices:
                    slot.due = next_due(slot.listener)
                    slot.retry_at = 0.0
                if (slot.due is not None and slot.due.timestamp() <= time.time()
                        and slot.retry_at <= time.monotonic()):
                    self._run_org(slot)
                if slot.due is None or slot.due.timestamp() > time.time() + self.sweep_seconds:
                    self._close(key)
            except Exception as exc:
                self._error(slot.org, exc)
                self._close(key)
        deadlines = [self._next_sweep - time.monotonic(), 1.0]
        deadlines.extend(max(slot.due.timestamp() - time.time(),
                             slot.retry_at - time.monotonic()) for slot in self.served.values()
                         if slot.due is not None)
        # An expired but row-locked job must not turn into a busy loop.
        return max(0.05, min(deadlines))

    def run(self, stop: threading.Event) -> None:
        """Run in the host's owned thread; stop within a second between jobs."""
        try:
            while not stop.is_set():
                delay = self.step()
                listeners = [slot.listener for slot in self.served.values()]
                if not listeners:
                    stop.wait(delay)
                else:
                    try:
                        select.select(listeners, [], [], delay)
                    except (OSError, ValueError):
                        # step() identifies and reconnects the failed org.
                        stop.wait(min(delay, 0.05))
        finally:
            self.close()

    def close(self) -> None:
        for key in list(self.served):
            self._close(key)
