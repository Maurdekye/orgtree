"""Bounded start_turn bridge, until the general host scheduler owns its step.

An org commit is always complete before an app operation starts. The org's
app_pending flag, rather than an in-memory callback or unfinished jobs row,
repairs a crash between commits. No provider is launched by this bridge.
"""
from __future__ import annotations

from typing import Any, Callable

from ..turnqueue import Request as AppRequest, Ticket
from . import jobs, turn_requests as requests


class Bridge:
    def __init__(self, connect: Callable[[jobs.Org], Any], queue: Any,
                 instance_id: int, *, batch: int = 16) -> None:
        if type(batch) is not int or not 1 <= batch <= 256:
            raise ValueError('bridge batch must be between 1 and 256')
        self.connect = connect
        self.queue = queue
        self.instance_id = instance_id
        self.batch = batch

    def step(self, org: jobs.Org) -> int:
        """One bounded org visit: short job handlers, then committed handoffs."""
        with self.connect(org) as c, c.transaction():
            requests.sweep_jobs(c, limit=self.batch)
            claimed = requests.claim_jobs(c, self.instance_id, limit=self.batch)
        for job in claimed:
            with self.connect(org) as c:
                jobs.execute(c, job, requests.queue_job)
        return self.repair(org)

    def repair(self, org: jobs.Org) -> int:
        with self.connect(org) as c:
            pending = requests.repair_batch(c, limit=self.batch)
        synced = 0
        for request in pending:
            with self.connect(org) as c:
                row = c.execute('SELECT name FROM orgtree.agents WHERE id = %s',
                                (request.agent_id,)).fetchone()
            if row is None:
                raise RuntimeError('turn request agent is missing')
            app = AppRequest(request.request_id, org.org_id, request.agent_id,
                             row[0], request.reason)
            if not self._forward(request, app):
                continue
            with self.connect(org) as c, c.transaction():
                synced += int(requests.app_synced(c, request))
        return synced

    def _forward(self, request: requests.Request, app: AppRequest) -> bool:
        """No org transaction is open here. A stale selection cannot undo cancel."""
        if request.state == 'queued':
            ticket = self.queue.enqueue(app, request.owner)
            return ticket.state in ('waiting', 'running')
        if request.state in ('stopping', 'cancelled'):
            ticket = self.queue.cancel(app)
            # Before activation, the org CAS proves no provider was launched.
            # After activation only stopped_at is the owner's stop acknowledgement.
            if request.state == 'cancelled' and ticket.state == 'stopping' and (
                    request.started_at is None or request.stopped_at is not None):
                self.queue.acknowledge_stop(app.request_id, ticket.owner, ticket.epoch)
                ticket = self.queue.get(app.request_id)
            allowed = ('stopping', 'cancelled', 'lost', 'done') if request.state == 'stopping' else (
                'cancelled', 'lost', 'done')
            return ticket is not None and ticket.state in allowed
        if request.state == 'done':
            claim = Ticket(app.request_id, app.org_id, app.agent_id, 'running',
                           request.epoch, request.owner, request.token)
            self.queue.finish(claim)
            ticket = self.queue.get(app.request_id)
            return ticket is not None and ticket.state == 'done'
        if request.state == 'lost':
            # Host invalidated the org half first. It reclaims the verified
            # dead app owner before revisiting these markers; never cancel a
            # potentially active provider merely because a heartbeat is old.
            ticket = self.queue.get(app.request_id)
            return ticket is None or ticket.state in ('lost', 'cancelled', 'done')
        return False
