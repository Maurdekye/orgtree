"""Transaction-local org half of the durable turn protocol (design 2.4).

Every mutation and fence needs the caller's open transaction. This module
never commits, opens an app connection or starts a provider. A committed
queued request is the handoff to the host's idempotent app forwarder, even
when its start_turn job is already done. app_pending retains that handoff
through uncertain commits and cancellation until the exact outcome is seen.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from . import jobs


class StaleRun(RuntimeError):
    """The request no longer authorizes this numbered provider run."""


@dataclass(frozen=True)
class Request:
    request_id: str
    agent_id: int
    reason: str
    state: str
    epoch: int
    owner: int
    token: str | None
    created_at: datetime
    started_at: datetime | None
    stopped_at: datetime | None
    ended_at: datetime | None
    end_reason: str | None
    app_pending: bool


COLUMNS = ('request_id', 'agent_id', 'reason', 'state', 'claim_epoch',
           'lease_owner', 'claim_token', 'created_at', 'started_at',
           'stopped_at', 'ended_at', 'end_reason', 'app_pending')
_SELECT = ', '.join(COLUMNS)
_JOB_COLUMNS = ('id', 'kind', 'agent_id', 'item_id', 'watchdog_id', 'run_at',
                'state', 'attempts', 'max_attempts', 'lease_owner',
                'lease_until', 'last_error', 'dedupe_key')


def _request(row: Any) -> Request | None:
    if row is None:
        return None
    values = list(row)
    values[0] = str(values[0])
    if values[6] is not None:
        values[6] = str(values[6])
    return Request(*values)


def _transaction(c: Any) -> None:
    from psycopg.pq import TransactionStatus
    if c.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError('turn requests need the caller\'s open org transaction')


def _id(value: str) -> str:
    return str(UUID(value))


def _positive(value: int, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(label + ' must be a positive integer')
    return value


def get(c: Any, request_id: str) -> Request | None:
    return _request(c.execute('SELECT ' + _SELECT +
                             ' FROM orgtree.turn_requests WHERE request_id = %s',
                             (_id(request_id),)).fetchone())


def lock(c: Any, request_id: str) -> Request | None:
    """First lock tier for a transition, before any agent, job or other row."""
    _transaction(c)
    return _request(c.execute('SELECT ' + _SELECT +
                             ' FROM orgtree.turn_requests WHERE request_id=%s FOR UPDATE',
                             (_id(request_id),)).fetchone())


def create(c: Any, request_id: str, agent_id: int, reason: str,
           instance_id: int) -> Request:
    """Persist one attempt and its start job in the deciding org transaction.

    The caller mints the UUID once, before retrying an uncertain commit. An
    existing request is returned without touching its job, including after
    completion. Reusing an id for another agent or reason is refused.
    """
    _transaction(c)
    rid = _id(request_id)
    _positive(agent_id, 'agent_id')
    _positive(instance_id, 'instance_id')
    if not isinstance(reason, str) or not reason:
        raise ValueError('reason must be a non-empty string')
    existing = lock(c, rid)
    if existing is not None:
        if (existing.agent_id, existing.reason) != (agent_id, reason):
            raise ValueError('request id already belongs to a different turn')
        return existing
    row = c.execute('INSERT INTO orgtree.turn_requests '
                    '(request_id, agent_id, reason, lease_owner) VALUES (%s, %s, %s, %s) '
                    'ON CONFLICT (request_id) DO NOTHING RETURNING ' + _SELECT,
                    (rid, agent_id, reason, instance_id)).fetchone()
    if row is None:
        existing = lock(c, rid)
        if existing is None or (existing.agent_id, existing.reason) != (agent_id, reason):
            raise ValueError('request id already belongs to a different turn')
        return existing
    request = _request(row)
    jobs.enqueue(c, 'start_turn', rid, agent_id=agent_id)
    assert request is not None
    return request


def queue_job(c: Any, job: jobs.Job) -> None:
    """jobs.execute handler: org intent commits with job='done', never app SQL."""
    _transaction(c)
    if job.kind != 'start_turn':
        raise ValueError('not a start_turn job')
    c.execute("UPDATE orgtree.turn_requests SET state = 'queued', app_pending = true "
              "WHERE request_id = %s AND agent_id = %s AND state = 'pending'",
              (_id(job.dedupe_key), job.agent_id))


def end_unrunnable(c: Any, request_id: str) -> Request | None:
    """Release pending intent whose start step cannot ever authorize a ticket.

    Take the request first, then inspect the exact job. A normal handler
    holding this request commits queued together with done, so done with
    pending, failed or a missing job proves there is no runnable
    start step. Retain the request UUID as a cancellation tombstone.
    """
    current = lock(c, request_id)
    if current is None or current.state != 'pending':
        return current
    row = c.execute("SELECT state FROM orgtree.jobs WHERE kind='start_turn' "
                    "AND dedupe_key=%s ORDER BY id DESC LIMIT 1", (current.request_id,)).fetchone()
    if row is None or row[0] not in ('queued', 'running'):
        return cancel(c, request_id, reason='start_turn job did not produce queued intent')
    return current


def pending_batch(c: Any, *, limit: int = 16) -> list[str]:
    """Current pending intent only; retained terminal requests are excluded."""
    _positive(limit, 'limit')
    return [str(row[0]) for row in c.execute(
        "SELECT request_id FROM orgtree.turn_requests WHERE state='pending' "
        "ORDER BY created_at, request_id LIMIT %s", (limit,)).fetchall()]


def claim_jobs(c: Any, instance_id: int, *, limit: int = 16) -> list[jobs.Job]:
    """The B5 bridge leases only start_turn jobs, never another domain's work."""
    _transaction(c)
    _positive(instance_id, 'instance_id')
    _positive(limit, 'limit')
    rows = c.execute("WITH due AS (SELECT id FROM orgtree.jobs "
                     "WHERE kind = 'start_turn' AND state = 'queued' "
                     "AND run_at <= statement_timestamp() ORDER BY run_at, id "
                     "LIMIT %s FOR UPDATE SKIP LOCKED) UPDATE orgtree.jobs j "
                     "SET state = 'running', attempts = attempts + 1, lease_owner = %s, "
                     "lease_until = clock_timestamp() + interval '30 seconds' "
                     "FROM due WHERE j.id = due.id RETURNING " +
                     ', '.join('j.' + name for name in _JOB_COLUMNS),
                     (limit, instance_id)).fetchall()
    return [jobs.Job(*row) for row in rows]


def sweep_jobs(c: Any, *, limit: int = 16) -> None:
    """Retry expired start steps, respecting the framework's locked attempt."""
    _transaction(c)
    _positive(limit, 'limit')
    c.execute("WITH stale AS (SELECT id FROM orgtree.jobs "
              "WHERE kind = 'start_turn' AND state = 'running' "
              "AND lease_until <= statement_timestamp() ORDER BY lease_until, id "
              "LIMIT %s FOR UPDATE SKIP LOCKED) UPDATE orgtree.jobs j "
              "SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, "
              "run_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL, "
              "last_error = 'lease expired' FROM stale WHERE j.id = stale.id", (limit,))


def repair_batch(c: Any, *, limit: int = 16) -> list[Request]:
    """Bounded indexed committed handoffs, excluding already-synced history."""
    _positive(limit, 'limit')
    return [_request(row) for row in c.execute(
        'SELECT ' + _SELECT + ' FROM orgtree.turn_requests WHERE app_pending '
        'ORDER BY created_at, request_id LIMIT %s', (limit,)).fetchall()]


def app_synced(c: Any, request: Request) -> bool:
    _transaction(c)
    return c.execute('UPDATE orgtree.turn_requests SET app_pending = false '
                     'WHERE request_id = %s AND state = %s AND claim_epoch = %s '
                     'AND lease_owner = %s RETURNING request_id',
                     (request.request_id, request.state, request.epoch,
                      request.owner)).fetchone() is not None


def activate(c: Any, request_id: str, ticket: Any) -> Request | None:
    """The app admission authorizes exactly one queued->running transition."""
    _transaction(c)
    if ticket.state != 'running' or not ticket.token or ticket.owner is None:
        raise ValueError('activation needs an admitted numbered app claim')
    if _id(request_id) != _id(ticket.request_id):
        raise ValueError('app claim belongs to another request')
    _positive(ticket.epoch, 'claim epoch')
    return _request(c.execute("UPDATE orgtree.turn_requests SET state = 'running', "
                             "claim_epoch = %s, lease_owner = %s, claim_token = %s, "
                             "started_at = clock_timestamp(), app_pending = false "
                             "WHERE request_id = %s AND agent_id = %s AND state = 'queued' "
                             "AND lease_owner = %s RETURNING " + _SELECT,
                             (ticket.epoch, ticket.owner, ticket.token, request_id,
                              ticket.agent_id, ticket.owner)).fetchone())


def fence(c: Any, request: Request) -> None:
    """Hold FOR SHARE through the caller's result/tool transaction commit."""
    _transaction(c)
    if c.execute("SELECT request_id FROM orgtree.turn_requests WHERE request_id = %s "
                 "AND agent_id = %s AND claim_epoch = %s AND lease_owner = %s "
                 "AND claim_token = %s AND state = 'running' FOR SHARE",
                 (request.request_id, request.agent_id, request.epoch,
                  request.owner, request.token)).fetchone() is None:
        raise StaleRun('turn was cancelled, finished or replaced')


def finish(c: Any, request: Request) -> Request | None:
    """Provider scope ended: invalidate its operations before freeing the app slot."""
    _transaction(c)
    return _request(c.execute("UPDATE orgtree.turn_requests SET state = 'done', "
                             "stopped_at = clock_timestamp(), ended_at = clock_timestamp(), "
                             "end_reason = 'completed', app_pending = true "
                             "WHERE request_id = %s AND agent_id = %s AND claim_epoch = %s "
                             "AND lease_owner = %s AND claim_token = %s AND state = 'running' "
                             "RETURNING " + _SELECT,
                             (request.request_id, request.agent_id, request.epoch,
                              request.owner, request.token)).fetchone())


def cancel(c: Any, request_id: str, *, reason: str = 'cancelled') -> Request | None:
    """Commit the org cancellation before its app write or provider stop request."""
    _transaction(c)
    c.execute("UPDATE orgtree.turn_requests SET state = CASE WHEN state = 'running' "
              "THEN 'stopping' ELSE 'cancelled' END, claim_epoch = claim_epoch + 1, "
              "ended_at = CASE WHEN state = 'running' THEN NULL ELSE clock_timestamp() END, "
              "end_reason = %s, app_pending = true WHERE request_id = %s "
              "AND state IN ('pending', 'queued', 'running')", (reason, _id(request_id)))
    return get(c, request_id)


def acknowledge_stop(c: Any, request_id: str, instance_id: int, epoch: int) -> Request | None:
    """Owner calls only AFTER its provider scope has stopped, using the new epoch."""
    _transaction(c)
    return _request(c.execute("UPDATE orgtree.turn_requests SET state = 'cancelled', "
                             "stopped_at = clock_timestamp(), ended_at = clock_timestamp(), "
                             "app_pending = true WHERE request_id = %s AND state = 'stopping' "
                             "AND lease_owner = %s AND claim_epoch = %s RETURNING " + _SELECT,
                             (_id(request_id), instance_id, epoch)).fetchone())


def reclaim_owner(c: Any, instance_id: int, *, limit: int = 16) -> list[Request]:
    """Host verified this process AND its provider tree dead before calling.

    Invalidate operations in org transactions first, then reclaim app tickets.
    Repeated bounded batches allow startup to retire an arbitrarily large
    dead backlog without a single unbounded write/returned body.
    """
    _transaction(c)
    _positive(instance_id, 'instance_id')
    _positive(limit, 'limit')
    return [_request(row) for row in c.execute(
        "WITH victims AS (SELECT request_id FROM orgtree.turn_requests "
        "WHERE lease_owner = %s AND state IN ('pending', 'queued', 'running', 'stopping') "
        "ORDER BY request_id LIMIT %s FOR UPDATE) "
        "UPDATE orgtree.turn_requests r SET state = 'lost', claim_epoch = claim_epoch + 1, "
        "stopped_at = clock_timestamp(), ended_at = clock_timestamp(), "
        "end_reason = 'owner process and provider tree terminated', app_pending = true "
        "FROM victims WHERE r.request_id = victims.request_id RETURNING " +
        ', '.join('r.' + name for name in COLUMNS), (instance_id, limit)).fetchall()]
