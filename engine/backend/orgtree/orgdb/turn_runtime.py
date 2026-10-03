"""Host-owned turn heartbeat, durable bridge, cancellation and run credentials.

Startup gives this module an already bootstrapped instance. It never imports
the store, registers an instance, opens admin connections or infers process
death from a heartbeat. Old trees are reclaimed only on the host's proof.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import logging
from pathlib import Path
import secrets
import threading
import time
from typing import Any, Callable, Iterable, Iterator, Mapping
from uuid import uuid4

from .. import turnqueue, turnslots
from . import conn, jobs, names, turn_context as context, turn_requests as requests
from .turn_forwarder import Bridge

LOG = logging.getLogger(__name__)
_host: Host | None = None


def initial_limit(data_root: str, env: Mapping[str, str]) -> int:
    """The saved v1 setting, then ORGTREE_MAX_TURNS, then the existing default."""
    try:
        with (Path(data_root) / 'app-settings.json').open(encoding='utf-8') as handle:
            doc = json.load(handle)
        runtime = doc.get('runtime') if isinstance(doc, dict) and doc.get('version') == 1 else None
        value = runtime.get('max_concurrent_turns') if isinstance(runtime, dict) else None
        if type(value) is int and 1 <= value <= turnslots.MAX_LIMIT:
            return value
    except (OSError, ValueError):
        pass
    return turnqueue.clamp_limit(env.get('ORGTREE_MAX_TURNS', turnslots.DEFAULT_LIMIT))


def current() -> Host | None:
    return _host


class Host:
    def __init__(self, runtime: str, instance_id: int, *, prefix: str | None = None,
                 active_orgs: Callable[[], Iterable[jobs.Org]] | None = None,
                 connect_org: Callable[[jobs.Org], Any] | None = None) -> None:
        if type(instance_id) is not int or instance_id <= 0:
            raise ValueError('host needs its existing engine instance')
        self.runtime = runtime
        self.instance_id = instance_id
        self.prefix = prefix or names.prefix()
        self._app_slots = threading.BoundedSemaphore(4)
        self._org_slots = threading.BoundedSemaphore(16)
        source = jobs.Runtime(runtime, prefix=self.prefix)
        self.active_orgs = active_orgs or source.active_orgs
        self._connect_org = connect_org or source.connect
        self.queue = turnqueue.Queue(self.app_connection)
        self.bridge = Bridge(self.org_connection, self.queue, instance_id)
        self.slots: Any = None
        self.key: bytes | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._active_lock = threading.Lock()
        self._active: dict[str, tuple[context.Run, Callable[[], None]]] = {}
        self._condition = threading.Condition()
        self._version = 0

    @contextmanager
    def app_connection(self) -> Iterator[Any]:
        with self._app_slots:
            with conn.connect(self.runtime, names.app(self.prefix),
                              application_name='orgtree-turn-host') as c:
                yield c

    @contextmanager
    def org_connection(self, org: jobs.Org) -> Iterator[Any]:
        with self._org_slots:
            with self._connect_org(org) as c:
                yield c

    def org(self, slug: str) -> jobs.Org:
        with self.app_connection() as c:
            row = c.execute("SELECT org_id, slug, database, org_uuid::text FROM orgtree.orgs "
                            "WHERE slug=%s AND state='active' AND op_kind IS NULL", (slug,)).fetchone()
        if row is None:
            raise RuntimeError('org is not open for turn admission')
        return jobs.Org(*row)

    def resolve(self, slug: str, agent: str) -> tuple[int, int]:
        org = self.org(slug)
        with self.org_connection(org) as c:
            row = c.execute("SELECT id FROM orgtree.agents WHERE name=%s "
                            "AND state='live' AND NOT tombstone", (agent,)).fetchone()
        if row is None:
            raise RuntimeError('turn agent is not live')
        return org.org_id, row[0]

    def key_for(self, instance: int) -> bytes | None:
        with self.app_connection() as c:
            row = c.execute('SELECT secret FROM orgtree.turn_signing_keys WHERE instance_id=%s',
                            (instance,)).fetchone()
        return bytes(row[0]) if row is not None else None

    def credential(self, run: context.Run) -> str:
        if run.owner != self.instance_id or self.key is None:
            raise RuntimeError('only the admitted owner signs its run')
        return context.sign(run, self.key)

    def start(self, *, limit: int, previous_tree_stopped: bool = False) -> None:
        """Host calls after holding the root lock and the guardian's tree cleanup."""
        if self._thread is not None or self._stop.is_set():
            raise RuntimeError('turn host already started or stopped')
        with self.app_connection() as c, c.transaction():
            if c.execute('SELECT id FROM orgtree.engine_instances WHERE id=%s AND dead_at IS NULL',
                         (self.instance_id,)).fetchone() is None:
                raise RuntimeError('host instance is not registered and live')
            row = c.execute('INSERT INTO orgtree.turn_signing_keys(instance_id, secret) VALUES (%s,%s) '
                            'ON CONFLICT (instance_id) DO UPDATE SET instance_id=EXCLUDED.instance_id '
                            'RETURNING secret', (self.instance_id, secrets.token_bytes(32))).fetchone()
            self.key = bytes(row[0])
        if previous_tree_stopped:
            with self.app_connection() as c:
                owners = c.execute('SELECT id FROM orgtree.engine_instances '
                                   'WHERE dead_at IS NULL AND id<>%s ORDER BY id',
                                   (self.instance_id,)).fetchall()
            for (owner,) in owners:
                self.reclaim_verified(owner)
        turnslots.configure(self.instance_id, self.app_connection, self.resolve)
        self.slots = turnslots.DatabaseSlots()
        self.queue.set_limit(limit)
        self.queue.heartbeat(self.instance_id)
        # Publication itself performs no I/O; even an already imported
        # supervisor gets this exact shared slot object before serving.
        turnslots.activate(self.slots, limit)
        self._thread = threading.Thread(target=self._loop, name='turn-host-heartbeat', daemon=True)
        self._thread.start()

    def reclaim_verified(self, instance: int) -> dict[str, int]:
        """Caller has killed the pid/start-time-verified tree, not just timed it out."""
        if instance == self.instance_id:
            raise ValueError('host cannot reclaim itself')
        # Include unavailable/closing orgs whose database still exists. Their
        # runtime identity must match too. A failure prevents app-slot reuse.
        with self.app_connection() as c:
            rows = c.execute('SELECT org_id, slug, database, org_uuid::text FROM orgtree.orgs '
                             "WHERE database IS NOT NULL AND state <> 'trashed' ORDER BY org_id").fetchall()
        for row in rows:
            org = jobs.Org(*row)
            while True:
                with self.org_connection(org) as c, c.transaction():
                    if c.execute("SELECT to_regclass('orgtree.turn_requests')").fetchone()[0] is None:
                        break  # a pre-B5 org cannot hold a B5 request
                    lost = requests.reclaim_owner(c, instance, limit=16)
                if not lost:
                    break
        with self.app_connection() as c:
            return turnqueue.reclaim_instance(c, instance)

    def prepare(self, slug: str, agent: str, reason: str, request_id: str,
                cancelled: Callable[[], bool] = lambda: False) -> tuple[jobs.Org, requests.Request]:
        """Mint once outside this retryable method; deciding effects commit together."""
        org = self.org(slug)
        with self.org_connection(org) as c, c.transaction():
            row = c.execute('SELECT id FROM orgtree.agents WHERE name=%s AND NOT tombstone',
                            (agent,)).fetchone()
            if row is None:
                raise RuntimeError('turn agent is missing')
            request = requests.create(c, request_id, row[0], reason, self.instance_id)
            # The new request is already this transaction's first tier.
            # Checking the agent under lock makes a racing halt win before
            # this deciding transaction can commit a runnable request.
            allowed = c.execute("SELECT id FROM orgtree.agents WHERE id=%s AND state='live' "
                                'AND NOT tombstone AND NOT is_halted FOR SHARE', (row[0],)).fetchone()
            if allowed is None:
                raise turnslots.Cancelled()
        while True:
            with self._condition:
                version = self._version
            if cancelled() or self._stop.is_set():
                self.abort_unstarted(org, request.request_id)
                raise turnslots.Cancelled()
            current = self.bridge.queue_one(org, request.request_id)
            self._wake.set()
            if current is None:
                raise RuntimeError('turn request disappeared')
            if current.state != 'pending':
                if current.state != 'queued':
                    raise turnslots.Cancelled()
                return org, current
            # Another start worker holds the job's short lease. It, or the
            # host's expiry pass, will change the request. Do not insert an
            # app ticket for pending intent, or keep an org transaction open.
            with self._condition:
                if version == self._version and not self._stop.is_set():
                    self._condition.wait(turnqueue.HEARTBEAT_SECONDS)

    def begin(self, org: jobs.Org, agent: str, request_id: str, ticket: Any,
              stop: Callable[[], None]) -> context.Run:
        with self.org_connection(org) as c, c.transaction():
            request = requests.lock(c, request_id)
            if request is None or request.state != 'queued':
                raise turnslots.Cancelled()
            allowed = c.execute("SELECT id FROM orgtree.agents WHERE id=%s AND name=%s "
                                "AND state='live' AND NOT tombstone AND NOT is_halted FOR SHARE",
                                (request.agent_id, agent)).fetchone()
            if allowed is None:
                raise turnslots.Cancelled()
            running = requests.activate(c, request_id, ticket)
            if running is None:
                raise turnslots.Cancelled()
        run = context.Run(org.slug, agent, org.org_id, running.agent_id, running.request_id,
                          running.epoch, running.owner, running.token)
        with self._active_lock:
            self._active[run.request_id] = (run, stop)
        return run

    def cancel(self, slug: str, request_id: str) -> requests.Request | None:
        org = self.org(slug)
        with self.org_connection(org) as c, c.transaction():
            request = requests.cancel(c, request_id)
        if request is not None and request.app_pending:
            self.bridge.forward(org, request)
        self._wake.set()
        return request

    def abort_unstarted(self, org: jobs.Org, request_id: str, ticket: Any = None) -> bool:
        """The caller never launched a provider, including a lost activation reply.

        A duplicate caller cannot cancel someone else's running token. This
        operation must not be used after the provider launch seam.
        """
        with self.org_connection(org) as c, c.transaction():
            current = requests.lock(c, request_id)
            if current is None or current.owner != self.instance_id:
                return False
            if current.state in ('running', 'stopping'):
                if ticket is None or (current.owner, current.token) != (ticket.owner, ticket.token):
                    return False
            if current.state in ('pending', 'queued', 'running'):
                current = requests.cancel(c, request_id, reason='provider was not launched')
            if current.state == 'stopping':
                current = requests.acknowledge_stop(c, request_id, self.instance_id, current.epoch)
        if current is not None and current.app_pending:
            self.bridge.forward(org, current)
        return current is not None and current.state == 'cancelled'

    def complete(self, org: jobs.Org, run: context.Run) -> None:
        """Only after the provider scope stops; suitable as a retained release guard."""
        with self.org_connection(org) as c, c.transaction():
            request = requests.lock(c, run.request_id)
            same = request is not None and (request.owner, request.agent_id, request.token) == (
                run.owner, run.agent_id, run.token)
            if not same:
                raise requests.StaleRun('completed turn belongs to another claim')
            if request.state == 'running' and request.epoch == run.epoch:
                request = requests.finish(c, run)
            elif request.state == 'stopping' and request.epoch == run.epoch + 1:
                request = requests.acknowledge_stop(c, run.request_id, run.owner, request.epoch)
            elif not (request.state == 'done' and request.epoch == run.epoch or
                      request.state == 'cancelled' and request.epoch == run.epoch + 1):
                raise requests.StaleRun('completed turn no longer owns this request')
        if request is not None and request.app_pending:
            self.bridge.forward(org, request)
        with self._active_lock:
            self._active.pop(run.request_id, None)

    def tick(self) -> None:
        """The host alone refreshes its lease and rereads authoritative stopping claims."""
        tickets = self.queue.heartbeat(self.instance_id)
        for org in self.active_orgs():
            try:
                self.bridge.step(org)
            except Exception:
                LOG.exception('turn bridge failed for %s', org.slug)
        with self._active_lock:
            active = dict(self._active)
        states = {ticket.request_id: ticket for ticket in tickets}
        for request_id, (_, stop) in active.items():
            ticket = states.get(request_id)
            if ticket is None or ticket.state == 'stopping':
                stop()  # signal; never acknowledges an active provider here
        if self.slots is not None:
            self.slots.recover_pending()

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.tick()
            except Exception:
                LOG.exception('turn host heartbeat failed')
            finally:
                with self._condition:
                    self._version += 1
                    self._condition.notify_all()
            self._wake.wait(max(0, turnqueue.HEARTBEAT_SECONDS - (time.monotonic() - started)))
            self._wake.clear()

    def stop(self) -> None:
        """Stops threads; running providers and unresolved outcomes keep their claims."""
        self._stop.set()
        self._wake.set()
        with self._condition:
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join(10)
            if self._thread.is_alive():
                raise RuntimeError('turn host heartbeat did not stop')
        if self.slots is not None:
            self.slots.close()


def start(*, runtime: str, instance_id: int, data_root: str,
          env: Mapping[str, str], prefix: str | None = None) -> Host:
    global _host
    if _host is not None:
        if _host.instance_id != instance_id:
            raise RuntimeError('turn host is already bound to another instance')
        return _host
    host = Host(runtime, instance_id, prefix=prefix)
    host.start(limit=initial_limit(data_root, env), previous_tree_stopped=True)
    _host = host
    return host


def stop() -> None:
    if _host is not None:
        _host.stop()
