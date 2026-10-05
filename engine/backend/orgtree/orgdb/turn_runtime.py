"""Host-owned turn heartbeat, durable bridge, cancellation and run credentials.

Startup gives this module an already bootstrapped instance. It never imports
the store, registers an instance, opens admin connections or infers process
death from a heartbeat. Old trees are reclaimed only on the host's proof.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
import json
import logging
from pathlib import Path
import secrets
import threading
import time
from typing import Any, Callable, Iterable, Iterator, Mapping
from uuid import uuid4

from .. import turnqueue, turnslots
from . import app_pool, conn, jobs, names, turn_context as context, turn_requests as requests
from .turn_forwarder import Bridge

LOG = logging.getLogger(__name__)
_host: Host | None = None
_release_scope: ContextVar[ExitStack | None] = ContextVar('turn_release_scope', default=None)


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


@contextmanager
def supervisor_scope() -> Iterator[None]:
    """Keep a slot's original run bound through its supervisor's finalizers.

    The slot body ends before the supervisor's exception accounting. Its
    release therefore belongs to this enclosing scope, after those writes
    and provider cleanup, rather than to the inner provider block.
    """
    if current() is None or _release_scope.get() is not None:
        yield
        return
    scope = ExitStack()
    token = _release_scope.set(scope)
    try:
        yield
    finally:
        try:
            scope.close()
        finally:
            _release_scope.reset(token)


def defer_release(release: Callable[[], None]) -> bool:
    """Return whether the current supervisor owns this slot's release."""
    scope = _release_scope.get()
    if scope is None:
        return False
    scope.callback(release)
    return True


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
        self._lease_queue = turnqueue.Queue(self.heartbeat_connection)
        self.bridge = Bridge(self.org_connection, self.queue, instance_id)
        self.slots: Any = None
        self.key: bytes | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._heartbeat_thread: threading.Thread | None = None
        self._active_lock = threading.Lock()
        self._active: dict[str, tuple[context.Run, Callable[[], None]]] = {}
        self._unstarted: dict[str, tuple[jobs.Org, Any]] = {}
        self._condition = threading.Condition()
        self._version = 0
        self._recovery_after = (0, 0)

    @contextmanager
    def app_connection(self) -> Iterator[Any]:
        with self._app_slots:
            with app_pool.connection(self.runtime, names.app(self.prefix),
                              application_name='orgtree-turn-host') as c:
                yield c

    @contextmanager
    def heartbeat_connection(self) -> Iterator[Any]:
        """One reserved connection: admission/maintenance cannot starve the lease."""
        from psycopg.conninfo import make_conninfo
        base = make_conninfo(self.runtime, connect_timeout=5,
                             options='-c statement_timeout=5000')
        with conn.connect(base, names.app(self.prefix),
                          application_name='orgtree-turn-heartbeat') as c:
            yield c

    @contextmanager
    def org_connection(self, org: jobs.Org) -> Iterator[Any]:
        with self._org_slots:
            with self._connect_org(org) as c:
                yield c

    def org(self, slug: str, *, owner: int | None = None) -> jobs.Org:
        # Restoring an old org snapshot cannot revive a verified-dead app
        # identity, even after this org's recovery fence has been cleared.
        owner_gate = (' AND EXISTS (SELECT 1 FROM orgtree.engine_instances e '
                      'WHERE e.id=%s AND e.dead_at IS NULL)') if owner is not None else ''
        params = (slug, owner) if owner is not None else (slug,)
        with self.app_connection() as c:
            row = c.execute("SELECT org_id, slug, database, org_uuid::text FROM orgtree.orgs o "
                            "WHERE slug=%s AND state='active' AND op_kind IS NULL AND NOT EXISTS "
                            '(SELECT 1 FROM orgtree.turn_recovery f WHERE f.org_id=o.org_id)' +
                            owner_gate, params).fetchone()
        if row is None:
            raise requests.StaleRun('org is not open for turn admission or is fenced for recovery')
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

    @contextmanager
    def operation(self, run: context.Run) -> Iterator[None]:
        """Authorize a short callback through its actual origin request row.

        The captured run never changes when another run starts. Keep this
        lock around result publication only, never around a provider wait
        or an HTTP tool which may cancel its own request.
        """
        org = self.org(run.org, owner=run.owner)
        if org.org_id != run.org_id:
            raise requests.StaleRun('turn origin was replaced')
        with self.org_connection(org) as c, c.transaction():
            requests.fence(c, run)
            with context.bind(run):
                yield

    def authorize(self, run: context.Run) -> None:
        """Refuse stale read-only calls; writes repeat the fence in their own TX."""
        with self.operation(run):
            pass

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
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop,
                                                   name='turn-host-heartbeat', daemon=True)
        self._heartbeat_thread.start()
        self._thread = threading.Thread(target=self._loop, name='turn-host-maintenance', daemon=True)
        self._thread.start()

    def reclaim_verified(self, instance: int) -> dict[str, int]:
        """Caller has killed the pid/start-time-verified tree, not just timed it out."""
        if instance == self.instance_id:
            raise ValueError('host cannot reclaim itself')
        # The app fence and verified-dead capacity release commit together.
        # Opening an org is never itself a reason to free a claim. Lifecycle
        # operations have no runs and belong to the lifecycle's takeover.
        with self.app_connection() as c, c.transaction():
            turnqueue.Queue._gate(c)
            if c.execute('SELECT id FROM orgtree.engine_instances WHERE id=%s AND dead_at IS NULL',
                         (instance,)).fetchone() is not None:
                c.execute('INSERT INTO orgtree.turn_recovery(org_id,instance_id) '
                          "SELECT org_id,%s FROM orgtree.orgs WHERE state IN ('active','unavailable') "
                          'AND op_kind IS NULL ON CONFLICT DO NOTHING', (instance,))
            counts = turnqueue.reclaim_instance(c, instance)
        self.recover_orgs()
        return counts

    def recover_orgs(self) -> None:
        """One bounded page of durable fences; a failing org never hides the next page."""
        query = ('SELECT f.org_id,f.instance_id,o.slug,o.database,o.org_uuid::text '
                 'FROM orgtree.turn_recovery f JOIN orgtree.orgs o USING(org_id) '
                 "WHERE o.state='active' AND o.op_kind IS NULL AND "
                 '(f.org_id,f.instance_id) > (%s,%s) '
                 'ORDER BY f.org_id,f.instance_id LIMIT 16')
        with self.app_connection() as c:
            rows = c.execute(query, self._recovery_after).fetchall()
            if not rows and self._recovery_after != (0, 0):
                self._recovery_after = (0, 0)
                rows = c.execute(query, self._recovery_after).fetchall()
        for org_id, instance, slug, database, org_uuid in rows:
            self._recovery_after = (org_id, instance)
            org = jobs.Org(org_id, slug, database, org_uuid)
            try:
                self._reconcile_org(org, instance)
            except Exception:
                LOG.exception('dead-owner turn recovery retained for %s', slug)
                continue
            # Every org transaction has committed and its connection closed.
            # A changed/closing registry identity retains the fence too.
            with self.app_connection() as c, c.transaction():
                c.execute('DELETE FROM orgtree.turn_recovery f WHERE f.org_id=%s '
                          'AND f.instance_id=%s AND EXISTS (SELECT 1 FROM orgtree.orgs o '
                          "WHERE o.org_id=f.org_id AND o.state='active' AND o.op_kind IS NULL "
                          'AND o.org_uuid=%s)', (org_id, instance, org_uuid))

    def _reconcile_org(self, org: jobs.Org, instance: int) -> None:
        """Invalidate a dead owner's current requests, committing bounded batches."""
        while True:
            with self.org_connection(org) as c, c.transaction():
                if c.execute("SELECT to_regclass('orgtree.turn_requests')").fetchone()[0] is None:
                    return  # a pre-B5 org cannot hold a B5 request
                lost = requests.reclaim_owner(c, instance, limit=16)
            if not lost:
                return

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
        if self.org(org.slug) != org:
            raise requests.StaleRun('turn origin was replaced before admission')
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

    def abandon(self, org: jobs.Org, request_id: str, ticket: Any = None) -> None:
        """Retain an unstarted caller's org cleanup through uncertain replies."""
        with self._active_lock:
            self._unstarted[request_id] = (org, ticket)
        if not self.abort_unstarted(org, request_id, ticket):
            with self.org_connection(org) as c:
                if requests.get(c, request_id) is not None:
                    raise RuntimeError('unstarted request no longer belongs to this caller')
        with self._active_lock:
            self._unstarted.pop(request_id, None)
            self._active.pop(request_id, None)

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

    def tick(self, *, refresh_heartbeat: bool = True) -> None:
        """The host alone refreshes its lease and rereads authoritative stopping claims."""
        if refresh_heartbeat:
            self.queue.heartbeat(self.instance_id)
        self.recover_orgs()
        for org in self.active_orgs():
            try:
                # A successful lifecycle Retry does not lift a turn fence.
                # Admission, tools and this bridge all use its durable gate.
                if self.org(org.slug) != org:
                    continue
                self.bridge.step(org)
            except requests.StaleRun:
                continue
            except Exception:
                LOG.exception('turn bridge failed for %s', org.slug)
        with self._active_lock:
            active = dict(self._active)
            unstarted = dict(self._unstarted)
        for request_id, (org, ticket) in unstarted.items():
            try:
                self.abandon(org, request_id, ticket)
            except Exception:
                LOG.exception('unstarted turn cleanup failed for %s', request_id)
        for request_id, (run, stop) in active.items():
            # Admission may register after the earlier heartbeat snapshot.
            # Each active request gets an authoritative indexed point read.
            ticket = self.queue.get(request_id)
            if ticket is None or (ticket.state, ticket.owner, ticket.epoch, ticket.token) != (
                    'running', run.owner, run.epoch, run.token):
                stop()  # signal; never acknowledges an active provider here
        if self.slots is not None:
            self.slots.recover_pending()

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.tick(refresh_heartbeat=False)
            except Exception:
                LOG.exception('turn host maintenance failed')
            finally:
                with self._condition:
                    self._version += 1
                    self._condition.notify_all()
            self._wake.wait(max(0, turnqueue.HEARTBEAT_SECONDS - (time.monotonic() - started)))
            self._wake.clear()

    def _heartbeat_loop(self) -> None:
        # Never do org forwarding, provider callbacks, or release guards here.
        # Any of them may wait on a running turn's publication fence.
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self._lease_queue.heartbeat(self.instance_id)
            except Exception:
                LOG.exception('turn host heartbeat failed')
            self._stop.wait(max(0, turnqueue.HEARTBEAT_SECONDS - (time.monotonic() - started)))

    def stop(self) -> None:
        """Stops threads; running providers and unresolved outcomes keep their claims."""
        self._stop.set()
        self._wake.set()
        with self._condition:
            self._condition.notify_all()
        pending = []
        for thread in (self._heartbeat_thread, self._thread):
            if thread is not None:
                thread.join(10)
                if thread.is_alive():
                    pending.append(thread.name)
        if pending:
            raise RuntimeError('turn host threads did not stop: ' + ', '.join(pending))
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


class Admission:
    """One supervisor slot/provider scope, with a UUID minted once.

    The supervisor supplies only memory publication, its cancel predicate
    and provider-stop signal. No database operation runs under its state
    lock. A release guard owns org completion before the app slot is freed.
    """
    def __init__(self, host: Host, slug: str, agent: str, reason: str,
                 cancelled: Callable[[], bool], queued: Callable[[dict[str, Any]], None],
                 stop_provider: Callable[[], None]) -> None:
        self.host, self.slug, self.agent, self.reason = host, slug, agent, reason
        self.cancelled, self.queued, self.stop_provider = cancelled, queued, stop_provider
        self.request_id = str(uuid4())
        self.org: jobs.Org | None = None
        self.run: context.Run | None = None
        self._contexts = ExitStack()
        self._acquired = False

    def __enter__(self) -> context.Run:
        try:
            # Remember the registry identity even if prepare's committed
            # deciding request loses its reply before returning to us.
            self.org = self.host.org(self.slug)
            org, request = self.host.prepare(self.slug, self.agent, self.reason,
                                             self.request_id, self.cancelled)
            self.org = org
            app = turnqueue.Request(request.request_id, org.org_id, request.agent_id,
                                    self.agent, self.reason)
            self._contexts.enter_context(turnslots.bind_request(app))
            self.host.slots.acquire(self.slug, self.cancelled, self.queued)
            self._acquired = True
            claim = self.host.slots.current_claim
            self.host.slots.guard_release(lambda: self.host.abandon(org, self.request_id, claim))
            self.run = self.host.begin(org, self.agent, self.request_id, claim, self.stop_provider)
            if self.cancelled():
                raise turnslots.Cancelled()
            self.host.slots.guard_release(lambda: self.host.complete(org, self.run))
            self._contexts.enter_context(context.bind(self.run))
            return self.run
        except BaseException:
            try:
                if self._acquired:
                    self.host.slots.release()
                elif self.org is not None:
                    # The app adapter retains any uncertain enqueue/claim;
                    # the host retains the corresponding native cleanup.
                    self.host.abandon(self.org, self.request_id)
            except Exception:
                LOG.exception('unstarted admission cleanup retained for retry')
            finally:
                self._contexts.close()
            raise

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        try:
            if self._acquired:
                self.host.slots.release()
        finally:
            self._contexts.close()

    def abort_before_launch(self) -> None:
        """A final supervisor gate refused after entry but before any provider."""
        if self._acquired:
            claim = self.host.slots.current_claim
            self.host.slots.guard_release(lambda: self.host.abandon(self.org, self.request_id, claim))
        self.__exit__(None, None, None)
