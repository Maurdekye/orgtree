"""Durable request transactions and both database handshake boundaries.

Needs an owned disposable PostgreSQL cluster and the P03 heavy lock.
"""
import import_provenance  # noqa: F401

from dataclasses import replace
import os
from pathlib import Path
import json
import queue as messages
import subprocess
import threading
import time
import unittest
from uuid import uuid4
import child_python

from orgtree import turnqueue
from orgtree import turnslots
from orgtree.orgdb import conn, jobs, lifecycle, names, turn_forwarder, turn_requests as requests
from orgtree.orgdb import turn_context, turn_runtime

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'


def drop_owned():
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute('SELECT datname FROM pg_database WHERE datname LIKE %s',
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable admin and runtime URLs')
class Requests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        drop_owned()
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
        cls.lc.bootstrap()
        oid = cls.lc.create_org('alpha')
        row = cls.lc.row(oid)
        cls.org = jobs.Org(oid, 'alpha', row['database'], str(row['org_uuid']))
        cls.runtime = jobs.Runtime(RUNTIME, prefix=PREFIX)
        cls.owner = cls.lc.instance_id
        cls.queue = turnqueue.Queue(lambda: conn.connect(RUNTIME, names.app(PREFIX)))
        cls.bridge = turn_forwarder.Bridge(cls.runtime.connect, cls.queue, cls.owner, batch=2)
        with conn.connect(ADMIN, row['database']) as c:
            cls.agent = c.execute("INSERT INTO orgtree.agents (name, state) "
                                  "VALUES ('seat', 'live') RETURNING id").fetchone()[0]
            cls.other = c.execute("INSERT INTO orgtree.agents (name, state) "
                                  "VALUES ('other', 'live') RETURNING id").fetchone()[0]

    @classmethod
    def tearDownClass(cls):
        drop_owned()

    def setUp(self):
        with conn.connect(ADMIN, self.org.database) as c:
            c.execute('TRUNCATE orgtree.jobs, orgtree.turn_requests')
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            c.execute('TRUNCATE orgtree.turn_tickets, orgtree.turn_queue_orgs')
        self.queue.heartbeat(self.owner)
        self.queue.set_limit(1)

    def connection(self):
        return self.runtime.connect(self.org)

    def create(self, agent=None):
        with self.connection() as c, c.transaction():
            return requests.create(c, str(uuid4()), agent or self.agent, 'turn', self.owner)

    def read(self, request):
        with self.connection() as c:
            return requests.get(c, request.request_id)

    def app(self, request):
        return turnqueue.Request(request.request_id, self.org.org_id, request.agent_id,
                                 'seat' if request.agent_id == self.agent else 'other', 'turn')

    def queued(self, agent=None):
        request = self.create(agent)
        self.bridge.step(self.org)
        return self.read(request)

    def running(self):
        request = self.queued()
        ticket = self.queue.claim(self.owner, request.request_id)
        with self.connection() as c, c.transaction():
            current = requests.activate(c, request.request_id, ticket)
        self.assertIsNotNone(current)
        return current, ticket

    def test_request_job_atomic_rollback_savepoint_and_no_autocommit_fence(self):
        rid = str(uuid4())
        with self.connection() as c:
            with self.assertRaises(RuntimeError):
                requests.create(c, rid, self.agent, 'turn', self.owner)
            with self.assertRaisesRegex(RuntimeError, 'rollback'):
                with c.transaction():
                    requests.create(c, rid, self.agent, 'turn', self.owner)
                    raise RuntimeError('rollback')
            self.assertIsNone(requests.get(c, rid))
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.jobs').fetchone()[0], 0)
            with c.transaction():
                with self.assertRaisesRegex(RuntimeError, 'savepoint'):
                    with c.transaction():
                        requests.create(c, rid, self.agent, 'turn', self.owner)
                        raise RuntimeError('savepoint')
                committed = requests.create(c, rid, self.agent, 'turn', self.owner)
            self.assertEqual(committed.state, 'pending')
            with self.assertRaises(RuntimeError):
                requests.fence(c, committed)

    def test_queued_done_job_crash_gap_and_lost_app_reply_repair(self):
        request = self.create()
        with self.connection() as c, c.transaction():
            (job,) = requests.claim_jobs(c, self.owner)
        with self.connection() as c:
            self.assertTrue(jobs.execute(c, job, requests.queue_job))
            self.assertEqual(c.execute('SELECT state FROM orgtree.jobs WHERE id=%s',
                                       (job.id,)).fetchone()[0], 'done')
        # Process dies here: job is done, no app ticket. The durable queued
        # request is sufficient to repair without a job callback.
        self.assertIsNone(self.queue.get(request.request_id))
        queued = self.read(request)
        self.assertEqual(queued.state, 'queued')
        self.assertTrue(queued.app_pending)
        real_enqueue = self.queue.enqueue

        def lost_reply(*a, **kw):
            real_enqueue(*a, **kw)
            raise OSError('committed app reply lost')

        from unittest.mock import patch
        with patch.object(self.queue, 'enqueue', lost_reply):
            with self.assertRaises(OSError):
                self.bridge.repair(self.org)
        self.assertTrue(self.read(request).app_pending)
        self.assertEqual(self.queue.get(request.request_id).state, 'waiting')
        self.assertEqual(self.bridge.repair(self.org), 1)
        self.assertFalse(self.read(request).app_pending)
        with self.queue.connect() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.turn_tickets').fetchone()[0], 1)

    def test_bridge_leases_only_start_jobs_and_repair_never_holds_org_transaction(self):
        request = self.create()
        with self.connection() as c, c.transaction():
            alien = jobs.enqueue(c, 'another_domain', 'keep')
        opened = []
        real_connect = self.bridge.connect
        real_enqueue = self.queue.enqueue

        def connect(org):
            raw = real_connect(org)
            opened.append(raw)
            return raw

        def enqueue(*a, **kw):
            from psycopg.pq import TransactionStatus
            self.assertTrue(all(c.closed or c.info.transaction_status == TransactionStatus.IDLE
                                for c in opened))
            return real_enqueue(*a, **kw)

        from unittest.mock import patch
        with patch.object(self.bridge, 'connect', connect), patch.object(self.queue, 'enqueue', enqueue):
            self.assertEqual(self.bridge.step(self.org), 1)
        with self.connection() as c:
            self.assertEqual(c.execute('SELECT state, attempts FROM orgtree.jobs WHERE id=%s',
                                       (alien.id,)).fetchone(), ('queued', 0))
        self.assertEqual(self.queue.get(request.request_id).state, 'waiting')

    def test_cancel_pending_delayed_job_and_enqueue_cannot_revive(self):
        request = self.create()
        with self.connection() as c, c.transaction():
            cancelled = requests.cancel(c, request.request_id)
        self.assertEqual(cancelled.state, 'cancelled')
        self.bridge.step(self.org)
        self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
        self.assertEqual(self.queue.enqueue(self.app(request), self.owner).state, 'cancelled')
        with self.connection() as c, c.transaction():
            again = requests.create(c, request.request_id, request.agent_id, request.reason, self.owner)
            self.assertEqual(again.state, 'cancelled')
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.jobs').fetchone()[0], 1)

    def test_admitted_then_cancelled_request_never_activates_and_frees_unstarted(self):
        request = self.queued()
        ticket = self.queue.claim(self.owner, request.request_id)
        with self.connection() as c, c.transaction():
            requests.cancel(c, request.request_id)
        with self.connection() as c, c.transaction():
            self.assertIsNone(requests.activate(c, request.request_id, ticket))
        self.bridge.repair(self.org)
        self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
        self.assertEqual(self.queue.snapshot()['held'], 0)
        with self.connection() as c, c.transaction():
            self.assertIsNone(requests.activate(c, request.request_id, ticket))

    def test_stopping_holds_slot_and_agent_until_exact_owner_stop_ack(self):
        import psycopg
        current, ticket = self.running()
        with self.connection() as c, c.transaction():
            stopping = requests.cancel(c, current.request_id)
        self.assertEqual(stopping.epoch, current.epoch + 1)
        self.assertEqual(stopping.state, 'stopping')
        self.bridge.repair(self.org)
        self.assertEqual(self.queue.get(current.request_id).state, 'stopping')
        with self.assertRaises(psycopg.errors.UniqueViolation):
            self.create()
        other = self.queued(self.other)
        self.assertIsNone(self.queue.claim(self.owner, other.request_id))
        with self.connection() as c, c.transaction():
            self.assertIsNone(requests.finish(c, current))
            self.assertIsNone(requests.acknowledge_stop(c, current.request_id, self.owner, current.epoch))
            self.assertIsNone(requests.acknowledge_stop(c, current.request_id, self.owner + 100, stopping.epoch))
            acknowledged = requests.acknowledge_stop(c, current.request_id, self.owner, stopping.epoch)
        self.assertIsNotNone(acknowledged)
        self.bridge.repair(self.org)
        self.assertEqual(self.queue.get(current.request_id).state, 'cancelled')
        self.assertIsNotNone(self.queue.claim(self.owner, other.request_id))
        self.assertEqual(self.create().state, 'pending')

    def test_shared_operation_finishes_before_cancel_and_old_epoch_is_refused(self):
        import psycopg
        current, _ = self.running()
        with self.connection() as operation, self.connection() as cancellation:
            with operation.transaction():
                requests.fence(operation, current)
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with cancellation.transaction():
                        cancellation.execute("SET LOCAL lock_timeout = '100ms'")
                        requests.cancel(cancellation, current.request_id)
                # A transaction already holding the share lock still has
                # the exact authorization until its own commit.
                requests.fence(operation, current)
            with cancellation.transaction():
                stopping = requests.cancel(cancellation, current.request_id)
            with operation.transaction():
                with self.assertRaises(requests.StaleRun):
                    requests.fence(operation, current)
                self.assertIsNone(requests.finish(operation, current))
                self.assertEqual(requests.cancel(operation, current.request_id).epoch, stopping.epoch)

    def test_completed_retry_and_stale_synced_reply_preserve_cancellation(self):
        current, _ = self.running()
        with self.connection() as c, c.transaction():
            self.assertIsNone(requests.finish(c, replace(current, epoch=current.epoch + 1)))
            self.assertIsNone(requests.finish(c, replace(current, token=str(uuid4()))))
            completed = requests.finish(c, current)
        self.assertEqual(completed.state, 'done')
        self.bridge.repair(self.org)
        self.assertEqual(self.queue.get(current.request_id).state, 'done')
        with self.connection() as c, c.transaction():
            self.assertEqual(requests.create(c, current.request_id, current.agent_id,
                                            current.reason, self.owner).state, 'done')
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.jobs').fetchone()[0], 1)
        other = self.queued(self.other)
        with self.connection() as c, c.transaction():
            requests.cancel(c, other.request_id)
            self.assertFalse(requests.app_synced(c, other))
        self.assertTrue(self.read(other).app_pending)
        self.bridge.repair(self.org)
        self.assertEqual(self.queue.get(other.request_id).state, 'cancelled')

    def test_dead_owner_invalidation_is_bounded_before_app_slot_reclaim(self):
        current, _ = self.running()
        pending = self.create(self.other)
        with self.connection() as c, c.transaction():
            first = requests.reclaim_owner(c, self.owner, limit=1)
        self.assertEqual(len(first), 1)
        with self.connection() as c, c.transaction():
            rest = requests.reclaim_owner(c, self.owner, limit=1)
        self.assertEqual(len(rest), 1)
        with self.connection() as c, c.transaction():
            self.assertEqual(requests.reclaim_owner(c, self.owner, limit=1), [])
            with self.assertRaises(requests.StaleRun):
                requests.fence(c, current)
        # No org-side mutation alone frees an active provider's app slot.
        self.assertEqual(self.queue.get(current.request_id).state, 'running')
        self.assertEqual(self.read(pending).state, 'lost')

    def worker(self, request, boundary):
        """Own child with a bounded readiness wait and unconditional cleanup."""
        p = subprocess.Popen(child_python.argv(
            str(Path(__file__).with_name('turn_requests_worker.py')),
            PREFIX, self.org.database, str(self.org.org_id), self.org.slug,
            str(self.owner), request.request_id, boundary, flags=('-I',)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=os.environ.copy())
        output = messages.Queue()

        def read():
            for line in p.stdout:
                output.put(line)
            output.put(None)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()

        def cleanup():
            if p.poll() is None:
                p.kill()
            p.wait(timeout=10)
            reader.join(5)
            self.assertFalse(reader.is_alive(), 'fault worker reader did not stop')
            p.stdin.close()
            p.stdout.close()
            p.stderr.close()

        self.addCleanup(cleanup)
        try:
            line = output.get(timeout=10)
            if line is None:
                p.wait(timeout=10)
                self.fail('fault worker exited before boundary: ' + p.stderr.read())
            ready = json.loads(line)
        except messages.Empty:
            p.kill()
            p.wait(timeout=10)
            self.fail('fault worker did not reach boundary: ' + p.stderr.read())
        self.assertEqual(ready['boundary'], boundary)
        self.assertEqual(ready['request_id'], request.request_id)
        self.assertEqual(Path(ready['checkout']).resolve(), Path(__file__).resolve().parents[1])
        self.assertEqual(ready['pid'], p.pid)
        return p, output

    def assert_one_attempt(self, request):
        with self.queue.connect() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.turn_tickets '
                                       'WHERE request_id=%s', (request.request_id,)).fetchone()[0], 1)
        with self.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.jobs '
                                       'WHERE dedupe_key=%s', (request.request_id,)).fetchone()[0], 1)

    def test_killed_process_after_queued_done_commit_repairs_exact_request(self):
        request = self.create()
        p, _ = self.worker(request, 'queued')
        self.assertEqual(self.read(request).state, 'queued')
        self.assertIsNone(self.queue.get(request.request_id))
        p.kill()
        p.wait(timeout=10)
        self.assertNotEqual(p.returncode, 0, 'fault process was not killed')
        self.assertEqual(self.bridge.repair(self.org), 1)
        self.assertEqual(self.queue.get(request.request_id).state, 'waiting')
        self.assert_one_attempt(request)

    def test_killed_process_after_app_commit_repairs_without_second_ticket(self):
        request = self.create()
        with self.connection() as c, c.transaction():
            (job,) = requests.claim_jobs(c, self.owner)
        with self.connection() as c:
            self.assertTrue(jobs.execute(c, job, requests.queue_job))
        p, _ = self.worker(request, 'inserted')
        self.assertEqual(self.queue.get(request.request_id).state, 'waiting')
        p.kill()
        p.wait(timeout=10)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.bridge.repair(self.org), 1)
        self.assertFalse(self.read(request).app_pending)
        self.assert_one_attempt(request)

    def test_delayed_other_process_app_insert_observes_cancellation_tombstone(self):
        request = self.create()
        p, output = self.worker(request, 'queued')
        with self.connection() as c, c.transaction():
            requests.cancel(c, request.request_id)
        self.bridge.repair(self.org)
        p.stdin.write('insert\n')
        p.stdin.flush()
        self.assertEqual(json.loads(output.get(timeout=10)), {'state': 'cancelled'})
        p.wait(timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr.read())
        self.assertEqual(self.queue.snapshot()['held'], 0)
        self.assert_one_attempt(request)

    def test_two_actual_processes_compete_for_one_request_with_one_admission(self):
        request = self.queued()
        first, a = self.worker(request, 'compete')
        second, b = self.worker(request, 'compete')
        for process in (first, second):
            process.stdin.write('claim\n')
            process.stdin.flush()
        results = []
        for process, output in ((first, a), (second, b)):
            line = output.get(timeout=10)
            if line is None:
                process.wait(timeout=10)
                self.fail('competing worker exited before result: ' + process.stderr.read())
            results.append(json.loads(line))
        for process in (first, second):
            process.wait(timeout=10)
            self.assertEqual(process.returncode, 0, process.stderr.read())
        accepted = [result for result in results if result['admitted']]
        self.assertEqual(len(accepted), 1, results)
        self.assertIn(accepted[0]['pid'], (first.pid, second.pid))
        run = turn_context.Run(**accepted[0]['run'])
        self.assertEqual(run.request_id, request.request_id)
        self.assertEqual(self.read(request).state, 'running')
        self.assertEqual(self.queue.snapshot()['held'], 1)
        self.assert_one_attempt(request)
        self.host().complete(self.org, run)  # both processes have exited
        self.assertEqual(self.read(request).state, 'done')
        self.assertEqual(self.queue.snapshot()['held'], 0)

    @unittest.skipUnless(os.name == 'nt', 'real Windows guardian tree control')
    def test_paused_owner_keeps_claim_until_guardian_tree_death_and_root_recovery(self):
        import ctypes
        from ctypes import wintypes as w
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        from engine.process_lifetime import RootLock

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.OpenProcess.restype = w.HANDLE
        kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        kernel.WaitForSingleObject.restype = w.DWORD
        kernel.CloseHandle.argtypes = [w.HANDLE]
        native = ctypes.WinDLL('ntdll')
        native.NtSuspendProcess.argtypes = [w.HANDLE]
        native.NtSuspendProcess.restype = ctypes.c_long
        native.NtResumeProcess.argtypes = [w.HANDLE]
        native.NtResumeProcess.restype = ctypes.c_long

        # Two real trees: a running owner, then an owner paused between the
        # cancellation commit and its provider-stop acknowledgement.
        for cancel_before_crash in (False, True):
            with self.subTest(cancel_before_crash=cancel_before_crash), TemporaryDirectory(
                    prefix='orgtree-turn-owned-guardian-') as root:
                rid = str(uuid4())
                p = subprocess.Popen(child_python.argv(
                    str(Path(__file__).with_name('turn_host_worker.py')), PREFIX, root, rid,
                    flags=('-I',)), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True, env=os.environ.copy(),
                    creationflags=subprocess.CREATE_NO_WINDOW)
                output = messages.Queue()
                reader = threading.Thread(target=lambda: output.put(p.stdout.readline()))
                reader.start()
                handles = []
                suspended = False
                try:
                    try:
                        line = output.get(timeout=25)
                    except messages.Empty:
                        p.kill()
                        p.wait(timeout=10)
                        self.fail('guardian worker did not reach boundary: ' + p.stderr.read())
                    if not line:
                        p.wait(timeout=10)
                        self.fail('guardian worker failed: ' + p.stderr.read())
                    ready = json.loads(line)
                    self.assertEqual(Path(ready['checkout']).resolve(),
                                     Path(__file__).resolve().parents[1])
                    self.assertEqual(ready['engine'], p.pid)
                    run = turn_context.Run(**ready['run'])
                    owner = ready['owner']
                    self.assertEqual(run.owner, owner)
                    for name in ('guardian', 'provider', 'grandchild'):
                        handle = kernel.OpenProcess(0x100000 | 0x1000, False, ready[name])
                        self.assertTrue(handle, 'cannot pin owned ' + name)
                        handles.append(handle)
                        self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258,
                                         'positive control: owned process is alive')
                    # Pinning the Popen handle prevents a reused PID from being
                    # paused or killed. Its heartbeat thread is suspended too.
                    self.assertEqual(native.NtSuspendProcess(int(p._handle)), 0)
                    suspended = True
                    with self.queue.connect() as c:
                        c.execute("UPDATE orgtree.engine_instances SET heartbeat_at="
                                  "clock_timestamp()-interval '2 minutes' WHERE id=%s", (owner,))
                        stale = turnqueue.stale_instances(c)
                        self.assertIn(owner, [row[0] for row in stale])
                        self.assertEqual(next(row[2] for row in stale if row[0] == owner), p.pid)
                    host = self.host()
                    if cancel_before_crash:
                        host.cancel('alpha', rid)
                    before_org = self.read(run)
                    before_app = self.queue.get(rid)
                    expected = 'stopping' if cancel_before_crash else 'running'
                    host.tick()  # a new live host heartbeat must not reclaim stale owners
                    self.assertEqual(self.read(run).state, expected)
                    self.assertEqual(self.queue.get(rid).state, expected)
                    self.assertEqual(self.queue.snapshot()['held'], 1)
                    self.assertIsNone(p.poll())
                    self.assertTrue(all(kernel.WaitForSingleObject(h, 0) == 258 for h in handles))
                    with self.assertRaisesRegex(RuntimeError, 'another engine owns'):
                        RootLock(Path(root))

                    p.kill()
                    p.wait(timeout=10)
                    for handle in handles:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0,
                                         'guardian must stop its entire owned tree')
                    # This is the real startup boundary: only after process
                    # handles prove death and the guardian releases the root.
                    lock = RootLock(Path(root))
                    try:
                        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                                            _database_resolver=None, _host_slots=None, _host_limit=None,
                                            _activation_callbacks=[]):
                            try:
                                host.start(limit=1, previous_tree_stopped=True)
                                self.assertEqual(self.read(run).state, 'lost')
                                self.assertEqual(self.read(run).epoch, before_org.epoch + 1)
                                self.assertEqual(self.queue.get(rid).state, 'lost')
                                self.assertEqual(self.queue.get(rid).epoch, before_app.epoch + 1)
                                self.assertEqual(self.queue.snapshot()['held'], 0)
                                with self.queue.connect() as c:
                                    self.assertIsNotNone(c.execute('SELECT dead_at FROM '
                                        'orgtree.engine_instances WHERE id=%s', (owner,)).fetchone()[0])
                                with self.connection() as c, c.transaction():
                                    with self.assertRaises(requests.StaleRun):
                                        requests.fence(c, run)
                                with turn_runtime.Admission(host, 'alpha', 'seat', 'turn',
                                        lambda: False, lambda info: None, lambda: None) as successor:
                                    self.assertNotEqual(successor.request_id, rid)
                                    self.assertEqual(successor.owner, self.owner)
                                    self.assertEqual(self.queue.snapshot()['held'], 1)
                                    self.assertTrue(all(kernel.WaitForSingleObject(h, 0) == 0
                                                        for h in handles))
                                self.assertEqual(self.queue.get(successor.request_id).state, 'done')
                                self.assertEqual(self.queue.snapshot()['held'], 0)
                            finally:
                                host.stop()
                    finally:
                        lock.close()
                finally:
                    if p.poll() is None:
                        if suspended:
                            native.NtResumeProcess(int(p._handle))
                        p.kill()
                    p.wait(timeout=10)
                    for handle in handles:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0,
                                         'owned guardian cleanup did not stop')
                        kernel.CloseHandle(handle)
                    reader.join(5)
                    self.assertFalse(reader.is_alive(), 'owned process reader did not stop')
                    for pipe in (p.stdin, p.stdout, p.stderr):
                        pipe.close()

    def test_start_step_waits_on_request_before_locking_its_job(self):
        import psycopg
        request = self.create()
        opened = []
        real_connect = self.bridge.connect
        worker_pid = messages.Queue()
        outcome = messages.Queue()

        def connect(org):
            c = real_connect(org)
            opened.append(c)
            if len(opened) == 2:
                worker_pid.put(c.execute('SELECT pg_backend_pid()').fetchone()[0])
            return c

        def step():
            try:
                outcome.put(self.bridge.step(self.org))
            except BaseException as exc:
                outcome.put(exc)

        from unittest.mock import patch
        with self.connection() as holding, self.connection() as probe:
            # Manual bracket lets the cleanup release the barrier before
            # joining, including when the job-lock assertion fails.
            holding.execute('BEGIN')
            try:
                holding.execute('SELECT request_id FROM orgtree.turn_requests '
                                'WHERE request_id=%s FOR UPDATE', (request.request_id,))
                with patch.object(self.bridge, 'connect', connect):
                    thread = threading.Thread(target=step)
                    thread.start()
                    try:
                        pid = worker_pid.get(timeout=5)
                        until = time.monotonic() + 5
                        with conn.connect(ADMIN, self.org.database) as monitor:
                            while time.monotonic() < until:
                                wait = monitor.execute('SELECT wait_event_type FROM pg_stat_activity '
                                                       'WHERE pid=%s', (pid,)).fetchone()
                                if wait == ('Lock',):
                                    break
                                time.sleep(.01)
                            else:
                                self.fail('start handler did not wait on the held request')
                        with probe.transaction():
                            # A request-first handler leaves its leased job unlocked
                            # until the earlier tier is available.
                            probe.execute('SELECT id FROM orgtree.jobs WHERE dedupe_key=%s '
                                          'FOR UPDATE NOWAIT', (request.request_id,)).fetchone()
                    finally:
                        holding.commit()
                        thread.join(10)
                    self.assertFalse(thread.is_alive(), 'start handler did not settle')
                    result = outcome.get_nowait()
                    if isinstance(result, BaseException):
                        raise result
            finally:
                if holding.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                    holding.rollback()
        self.assertEqual(self.read(request).state, 'queued')

    def test_dead_owner_reclaim_cannot_skip_an_in_progress_operation(self):
        import psycopg
        current, _ = self.running()
        with self.connection() as operation, self.connection() as reclaim:
            with operation.transaction():
                requests.fence(operation, current)
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with reclaim.transaction():
                        reclaim.execute("SET LOCAL lock_timeout='100ms'")
                        requests.reclaim_owner(reclaim, self.owner)
                self.assertEqual(self.queue.get(current.request_id).state, 'running')
            with reclaim.transaction():
                self.assertEqual(len(requests.reclaim_owner(reclaim, self.owner)), 1)
        self.assertEqual(self.read(current).state, 'lost')

    def host(self):
        return turn_runtime.Host(RUNTIME, self.owner, prefix=PREFIX,
                                 active_orgs=lambda: [self.org])

    def test_heartbeat_snapshot_cannot_cancel_a_later_admitted_run(self):
        from unittest.mock import patch
        host = self.host()
        heartbeat = host.queue.heartbeat
        admitted, signals = [], []

        def heartbeat_then_admit(owner):
            snapshot = heartbeat(owner)
            org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
            ticket = host.queue.claim(owner, request.request_id)
            admitted.append(host.begin(org, 'seat', request.request_id, ticket,
                                       lambda: signals.append(request.request_id)))
            return snapshot

        with patch.object(host.queue, 'heartbeat', heartbeat_then_admit):
            host.tick()
        self.assertEqual(signals, [], 'a newly admitted run was absent from the older snapshot')
        run = admitted[0]
        self.assertEqual(self.read(run).state, 'running')
        self.assertEqual(self.queue.get(run.request_id).state, 'running')
        host.complete(self.org, run)
        self.assertEqual(self.queue.snapshot()['held'], 0)

    def test_host_prepare_commits_request_job_before_app_then_exact_begin_and_finish(self):
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        self.assertEqual(request.state, 'queued')
        ticket = self.queue.claim(self.owner, request.request_id)
        run = host.begin(org, 'seat', request.request_id, ticket, lambda: None)
        with self.connection() as c, c.transaction(), turn_context.bind(run):
            turn_context.fence(c, 'alpha', self.org.org_id)
        host.complete(org, run)
        self.assertEqual(self.read(request).state, 'done')
        self.assertEqual(self.queue.get(request.request_id).state, 'done')
        host.complete(org, run)  # committed completion reply lost: exact retry
        with self.connection() as c, c.transaction(), turn_context.bind(run):
            with self.assertRaises(requests.StaleRun):
                turn_context.fence(c, 'alpha', self.org.org_id)

    def test_release_guard_failure_retains_org_and_app_claim_until_recovery(self):
        from unittest.mock import patch
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        with patch.multiple(turnslots, _database_queue=self.queue, _database_instance=self.owner):
            slots = turnslots.DatabaseSlots()
            try:
                with turnslots.bind_request(self.app(request)):
                    slots.acquire('alpha')
                    run = host.begin(org, 'seat', request.request_id, slots.current_claim, lambda: None)
                    slots.guard_release(lambda: host.complete(org, run))
                    with patch.object(requests, 'finish', side_effect=OSError('org write unavailable')):
                        with self.assertRaises(OSError):
                            slots.release()
                        self.assertEqual(self.read(request).state, 'running')
                        self.assertEqual(self.queue.get(request.request_id).state, 'running')
                        self.assertEqual(len(slots.pending_recovery()), 1)
                        self.assertIsNotNone(slots.current_claim)
                    slots.recover_pending()
                    self.assertEqual(self.read(request).state, 'done')
                    self.assertEqual(self.queue.get(request.request_id).state, 'done')
                    self.assertEqual(slots.pending_recovery(), [])
                    slots.release()
                    self.assertIsNone(slots.current_claim)
            finally:
                slots.close()

    def test_activation_commit_lost_reply_aborts_only_its_unstarted_claim(self):
        from contextlib import contextmanager
        from unittest.mock import patch
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        ticket = self.queue.claim(self.owner, request.request_id)
        real_connection = host.org_connection

        @contextmanager
        def lost_reply(org):
            with real_connection(org) as c:
                yield c
                # The inner transaction committed before this outer scope
                # reports a lost transport reply. No provider was launched.
                raise OSError('committed activation reply lost')

        with patch.object(host, 'org_connection', lost_reply):
            with self.assertRaises(OSError):
                host.begin(org, 'seat', request.request_id, ticket, lambda: None)
        self.assertEqual(self.read(request).state, 'running')
        self.assertFalse(host.abort_unstarted(org, request.request_id))
        self.assertFalse(host.abort_unstarted(org, request.request_id,
                                              replace(ticket, token=str(uuid4()))))
        self.assertEqual(self.read(request).state, 'running')
        self.assertTrue(host.abort_unstarted(org, request.request_id, ticket))
        self.assertEqual(self.read(request).state, 'cancelled')
        self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
        self.assertEqual(self.queue.snapshot()['held'], 0)

    def test_host_activation_preserves_imported_slot_subscribers_and_signing_keys(self):
        from unittest.mock import patch
        host = self.host()
        events = []
        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                            _database_resolver=None, _host_slots=None, _host_limit=None,
                            _activation_callbacks=[]), patch.dict(os.environ, ORGTREE_STORAGE='orgdb'):
            turnslots.on_activation(lambda slots, limit: events.append((slots, limit)))
            with self.queue.connect() as c:
                instances = c.execute('SELECT count(*) FROM orgtree.engine_instances').fetchone()[0]
            try:
                host.start(limit=3)
                self.assertEqual(events, [(host.slots, 3)])
                with patch.object(self.queue, 'snapshot', side_effect=AssertionError('import-time I/O')):
                    self.assertIs(turnslots.FairSlots(99), host.slots)
                    self.assertEqual(turnslots.activated_limit(), 3)
                with self.queue.connect() as c:
                    self.assertEqual(c.execute('SELECT count(*) FROM orgtree.engine_instances').fetchone()[0], instances)
                org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
                ticket = self.queue.claim(self.owner, request.request_id)
                run = host.begin(org, 'seat', request.request_id, ticket, lambda: None)
                credential = host.credential(run)
                verifier = self.host()  # another trusted process can fetch the owner key
                self.assertEqual(turn_context.verify(credential, verifier.key_for), run)
                host.complete(org, run)
            finally:
                host.stop()
            self.assertFalse(host._thread.is_alive())

    def test_host_heartbeat_is_owned_and_shutdown_does_not_free_active_provider(self):
        from unittest.mock import patch
        host = self.host()
        beat = threading.Event()
        real = host.queue.heartbeat

        def heartbeat(owner):
            if threading.current_thread().name == 'turn-host-heartbeat':
                beat.set()
            return real(owner)

        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                            _database_resolver=None, _host_slots=None, _host_limit=None,
                            _activation_callbacks=[]), patch.object(host.queue, 'heartbeat', heartbeat):
            try:
                host.start(limit=1)
                self.assertTrue(beat.wait(7), 'host heartbeat thread never executed')
                self.assertEqual(turnqueue.HEARTBEAT_SECONDS, 5)
                org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
                ticket = self.queue.claim(self.owner, request.request_id)
                host.begin(org, 'seat', request.request_id, ticket, lambda: None)
                host.stop()
                self.assertEqual(self.read(request).state, 'running')
                self.assertEqual(self.queue.get(request.request_id).state, 'running')
                self.assertEqual(self.queue.snapshot()['held'], 1)
            finally:
                host.stop()

    def test_forwarder_current_selection_is_flat_across_retained_request_and_job_history(self):
        request = self.create()
        samples = []

        class Spy:
            def __init__(self, c):
                self.c = c
                self.sql = []

            def __getattr__(self, key):
                return getattr(self.c, key)

            def execute(self, sql, args=None):
                self.sql.append((sql, args))
                return self.c.execute(sql, args)

        def examined(plan):
            return (plan.get('Actual Rows', 0) + plan.get('Rows Removed by Filter', 0) +
                    plan.get('Rows Removed by Index Recheck', 0)) * plan.get('Actual Loops', 1) + \
                   sum(examined(child) for child in plan.get('Plans', []))

        previous = 0
        for retained in (2048, 20480):
            with conn.connect(ADMIN, self.org.database) as c, c.transaction():
                c.execute("INSERT INTO orgtree.turn_requests "
                          "(request_id,agent_id,reason,state,lease_owner,ended_at) "
                          "SELECT md5('retained-'||g::text)::uuid,%s,'turn','cancelled',%s,clock_timestamp() "
                          "FROM generate_series(%s::integer,%s::integer) AS g",
                          (self.agent, self.owner, previous + 1, retained))
                c.execute("INSERT INTO orgtree.jobs(kind,dedupe_key,state) "
                          "SELECT 'start_turn',md5('retained-'||g::text)::uuid::text,'done' "
                          "FROM generate_series(%s::integer,%s::integer) AS g", (previous + 1, retained))
                c.execute('ANALYZE orgtree.turn_requests')
                c.execute('ANALYZE orgtree.jobs')
            previous = retained
            with self.connection() as c, c.transaction():
                spy = Spy(c)
                self.assertEqual(requests.pending_batch(spy, limit=2), [request.request_id])
                self.assertEqual(requests.repair_batch(spy, limit=2), [])
                self.assertEqual(requests.end_unrunnable(spy, request.request_id).state, 'pending')
                costs = []
                for sql, args in spy.sql:
                    if not sql.startswith('SELECT'):
                        continue
                    plan = c.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, args).fetchone()[0][0]
                    costs.append(examined(plan['Plan']))
                self.assertEqual(len(costs), 4, 'all real forwarder selection/lock queries must be measured')
                samples.append(costs)
        self.assertTrue(all(cost <= 12 for costs in samples for cost in costs), samples)
        self.assertTrue(all(large <= small + 4 for small, large in zip(*samples)), samples)

    def test_final_journal_and_visible_publication_hold_the_original_request_fence(self):
        from unittest.mock import patch
        from test_orgdb_turn_hooks import function
        host = self.host()
        current, _ = self.running()
        run = turn_context.Run('alpha', 'seat', self.org.org_id, self.agent,
                               current.request_id, current.epoch, current.owner, current.token)
        callback = function('supervisor.py', '_turn_callback', {})
        publish = function('supervisor.py', '_publish_turn_records', {'_turn_callback': callback})
        writes = []

        def journal(rows):
            import psycopg
            self.assertEqual(turn_context.current(), run)
            with self.connection() as c:
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with c.transaction():
                        c.execute("SET LOCAL lock_timeout='100ms'")
                        requests.cancel(c, run.request_id)
            writes.append(('journal', rows))

        with patch.object(turn_runtime, 'current', return_value=host), turn_context.bind(run):
            self.assertTrue(publish([{'text': 'final'}], journal,
                                    lambda row: writes.append(('visible', row)), {'text': 'final'}))
            self.assertEqual([kind for kind, _ in writes], ['journal', 'visible'])
            with self.connection() as c, c.transaction():
                requests.cancel(c, run.request_id)
            self.assertFalse(publish([{'text': 'late'}], journal,
                                     lambda row: writes.append(('visible', row)), {'text': 'late'}))
            self.assertEqual([kind for kind, _ in writes], ['journal', 'visible'])
        self.assertIsNone(turn_context.current())

    def test_failed_missing_or_done_start_job_cancels_pending_without_new_uuid(self):
        for state in ('failed', 'done', None):
            with self.subTest(job_state=state):
                request = self.create()
                with self.connection() as c, c.transaction():
                    if state is None:
                        c.execute('DELETE FROM orgtree.jobs WHERE dedupe_key=%s', (request.request_id,))
                    else:
                        c.execute("UPDATE orgtree.jobs SET state=%s WHERE dedupe_key=%s",
                                  (state, request.request_id))
                self.bridge.step(self.org)
                stopped = self.read(request)
                self.assertEqual(stopped.state, 'cancelled')
                self.assertEqual(stopped.request_id, request.request_id)
                self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
                # A delayed old start step/app insertion cannot revive it.
                self.assertEqual(self.queue.enqueue(self.app(request), self.owner).state, 'cancelled')
                self.assertEqual(self.read(request).state, 'cancelled')
                self.assertEqual(self.queue.snapshot()['held'], 0)

    def test_host_publication_fence_serializes_cancel_and_refuses_each_stale_identity(self):
        import psycopg
        host = self.host()
        current, ticket = self.running()
        run = turn_context.Run('alpha', 'seat', self.org.org_id, self.agent,
                               current.request_id, current.epoch, current.owner, current.token)
        with host.operation(run):
            self.assertEqual(turn_context.current(), run)
            with self.connection() as c:
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with c.transaction():
                        c.execute("SET LOCAL lock_timeout='100ms'")
                        requests.cancel(c, run.request_id)
        self.assertIsNone(turn_context.current())
        for change in ({'agent_id': self.other}, {'epoch': run.epoch + 1},
                       {'owner': self.owner + 1}, {'token': str(uuid4())},
                       {'request_id': str(uuid4())}, {'org_id': run.org_id + 1}):
            with self.assertRaises(requests.StaleRun):
                host.authorize(replace(run, **change))
        host.authorize(run)
        host.cancel('alpha', run.request_id)
        with self.assertRaises(requests.StaleRun):
            host.authorize(run)
        host.complete(self.org, run)

    def test_real_provider_process_keeps_slot_until_terminated_and_waited(self):
        import psycopg
        from unittest.mock import patch
        host = self.host()
        stopped = threading.Event()
        provider = None
        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                            _database_resolver=None, _host_slots=None, _host_limit=None,
                            _activation_callbacks=[]):
            try:
                host.start(limit=1)
                with turn_runtime.Admission(host, 'alpha', 'seat', 'turn', lambda: False,
                                             lambda info: None, stopped.set) as run:
                    # A real owned child, with no network/provider access.
                    provider = subprocess.Popen(child_python.argv(
                        '-c', 'import os,time;print(os.getpid(),flush=True);time.sleep(60)',
                        flags=('-I',)), stdout=subprocess.PIPE, text=True)
                    ready = messages.Queue()
                    reader = threading.Thread(target=lambda: ready.put(provider.stdout.readline()))
                    reader.start()
                    self.assertEqual(int(ready.get(timeout=10)), provider.pid)
                    reader.join(5)
                    self.assertFalse(reader.is_alive())
                    self.assertIsNone(provider.poll())
                    host.cancel('alpha', run.request_id)
                    host.tick()
                    self.assertTrue(stopped.is_set())
                    self.assertIsNone(provider.poll())
                    self.assertEqual(self.queue.snapshot()['held'], 1)
                    self.assertEqual(self.queue.get(run.request_id).state, 'stopping')
                    with self.assertRaises(psycopg.errors.UniqueViolation):
                        self.create()  # one request per agent includes stopping
                    provider.terminate()
                    provider.wait(timeout=5)
                    self.assertIsNotNone(provider.poll())
                self.assertEqual(self.queue.snapshot()['held'], 0)
                self.assertEqual(self.queue.get(run.request_id).state, 'cancelled')
                with self.connection() as c:
                    self.assertEqual(requests.get(c, run.request_id).state, 'cancelled')
            finally:
                if provider is not None and provider.poll() is None:
                    provider.kill()
                    provider.wait(timeout=5)
                if provider is not None:
                    provider.stdout.close()
                host.stop()

    def test_actual_ready_startup_activates_existing_instance_after_org_migrations(self):
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        from orgtree.orgdb import registry, startup
        events = []
        migrate_orgs = self.lc.migrate_orgs

        def migrated():
            events.append('migrations')
            return migrate_orgs()

        with TemporaryDirectory() as root, patch.multiple(
                turnslots, _database_queue=None, _database_instance=None,
                _database_resolver=None, _host_slots=None, _host_limit=None,
                _activation_callbacks=[]), patch.object(turn_runtime, '_host', None), \
                patch.object(registry, 'use_lifecycle'), \
                patch.object(startup, 'first_pass', return_value={'ran': False}), \
                patch.object(startup, 'resume_claims', return_value=[]), \
                patch.object(self.lc, 'migrate_orgs', side_effect=migrated), \
                patch.object(startup, 'retry_new_build', side_effect=lambda *a: events.append('retry') or []):
            turnslots.on_activation(lambda *a: events.append('slots'))
            try:
                report = startup.start(runtime=RUNTIME, data_root=root, lc=self.lc,
                                       env={'ORGTREE_MAX_TURNS': '4'})
                host = turn_runtime.current()
                self.assertIsNotNone(host)
                self.assertEqual(host.instance_id, self.owner)
                self.assertEqual(events, ['migrations', 'retry', 'slots'])
                self.assertEqual(host.slots.limit, 4)
                with host.app_connection() as c:
                    self.assertEqual(c.execute('SELECT count(*) FROM orgtree.engine_instances').fetchone()[0], 1)
                self.assertIn('migrations', report)
            finally:
                startup.stop()
            self.assertFalse(host._thread.is_alive())

    def test_admission_binds_full_scope_and_keeps_stopping_until_scope_is_stopped(self):
        from unittest.mock import patch
        host = self.host()
        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                            _database_resolver=None, _host_slots=None, _host_limit=None,
                            _activation_callbacks=[]):
            try:
                host.start(limit=1)
                admission = turn_runtime.Admission(host, 'alpha', 'seat', 'turn',
                                                   lambda: False, lambda info: None, lambda: None)
                with admission as run:
                    self.assertEqual(turn_context.current(), run)
                    self.assertEqual(host.slots.current_claim.request_id, run.request_id)
                    host.cancel('alpha', run.request_id)
                    self.assertEqual(self.queue.get(run.request_id).state, 'stopping')
                    self.assertEqual(self.queue.snapshot()['held'], 1)
                    with self.connection() as c:
                        self.assertEqual(requests.get(c, run.request_id).state, 'stopping')
                self.assertIsNone(turn_context.current())
                self.assertEqual(self.queue.get(admission.request_id).state, 'cancelled')
                self.assertEqual(self.queue.snapshot()['held'], 0)
            finally:
                host.stop()

    def test_failed_unstarted_org_cleanup_is_retained_and_repaired_by_host(self):
        from unittest.mock import patch
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        with patch.object(host, 'abort_unstarted', side_effect=OSError('org unreachable')):
            with self.assertRaises(OSError):
                host.abandon(org, request.request_id)
            self.assertIn(request.request_id, host._unstarted)
        host.tick()
        self.assertEqual(self.read(request).state, 'cancelled')
        self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
        self.assertEqual(host._unstarted, {})

    def test_multi_org_fence_survives_origin_commit_until_whole_operation_ends(self):
        import psycopg
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        with TemporaryDirectory() as root, patch.dict(os.environ, ORGTREE_DATA=root):
            from orgtree import orgtx
            from orgtree.orgdb.compat import tx as native
        oid = self.lc.create_org('beta')
        beta = self.lc.row(oid)
        rows = {'alpha': (self.org.org_id, self.org.database, 'active', self.org.org_uuid),
                'beta': (oid, beta['database'], 'active', str(beta['org_uuid']))}
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        ticket = self.queue.claim(self.owner, request.request_id)
        run = host.begin(org, 'seat', request.request_id, ticket, lambda: None)
        opened = []

        def checkout(slug, database, uuid):
            raw = conn.connect(RUNTIME, database)
            opened.append((slug, raw))
            return raw

        class AfterLocks(Exception):
            pass

        def pause(phase, tx):
            if phase != 'after_lock' or tx.slug != 'beta':
                return
            origins = [raw for slug, raw in opened if slug == 'alpha']
            self.assertEqual(len(origins), 2, 'multi-org origin needs the retained operation fence')
            # The existing multi-org protocol can commit one action org
            # before the other. Its actual origin connection releases its
            # share lock here; the separate operation fence must remain.
            origins[0].execute('COMMIT')
            with self.connection() as c:
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with c.transaction():
                        c.execute("SET LOCAL lock_timeout='100ms'")
                        requests.cancel(c, run.request_id)
            raise AfterLocks()

        actions = [orgtx.OrgTx(slug, None, share_nodes=frozenset(['seat'])) for slug in rows]
        with patch.object(native._reg, 'lookup', side_effect=rows.get), \
                patch.object(native._reg, 'checkout', side_effect=checkout), \
                patch.object(native._reg, 'release', side_effect=lambda raw, db: raw.close()), \
                patch.object(orgtx, '_pause', side_effect=pause), turn_context.bind(run):
            with self.assertRaises(AfterLocks):
                with native.OrgDbBackend().transaction_many(actions, 1):
                    self.fail('multi-org lock barrier was not reached')
        self.assertTrue(all(raw.closed for slug, raw in opened))
        host.cancel('alpha', run.request_id)  # no retained share lock leaked
        host.complete(org, run)

    def test_actual_native_transaction_fences_before_action_locks_and_rejects_stale_run(self):
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        # Import the actual backend with an owned data root, without starting
        # the API or a provider. The lock-phase barrier ends before a ledger
        # load: the protection exercised is the backend's real transaction.
        with TemporaryDirectory() as root, patch.dict(os.environ, ORGTREE_DATA=root):
            from orgtree import orgtx
            from orgtree.orgdb.compat import tx as native
        host = self.host()
        org, request = host.prepare('alpha', 'seat', 'turn', str(uuid4()))
        ticket = self.queue.claim(self.owner, request.request_id)
        run = host.begin(org, 'seat', request.request_id, ticket, lambda: None)
        row = (org.org_id, org.database, 'active', org.org_uuid)
        statements = []
        connections = []

        class Spy:
            def __init__(self, raw):
                self.raw = raw

            def __getattr__(self, key):
                return getattr(self.raw, key)

            def execute(self, sql, args=None):
                statements.append(str(sql))
                return self.raw.execute(sql, args)

        def checkout(*a):
            raw = conn.connect(RUNTIME, org.database)
            connections.append(raw)
            return Spy(raw)

        class AfterLocks(Exception):
            pass

        def pause(phase, tx):
            if phase == 'after_lock':
                import psycopg
                with self.connection() as canceller:
                    with self.assertRaises(psycopg.errors.LockNotAvailable):
                        with canceller.transaction():
                            canceller.execute("SET LOCAL lock_timeout='100ms'")
                            requests.cancel(canceller, run.request_id)
                raise AfterLocks()

        action = orgtx.OrgTx('alpha', None, share_nodes=frozenset(['seat']))
        with patch.object(native._reg, 'lookup', return_value=row), \
                patch.object(native._reg, 'checkout', side_effect=checkout), \
                patch.object(native._reg, 'release', side_effect=lambda raw, db: raw.close()), \
                patch.object(orgtx, '_pause', side_effect=pause), turn_context.bind(run):
            with self.assertRaises(AfterLocks):
                with native.OrgDbBackend().transaction(action, 1):
                    self.fail('lock barrier was not reached')
            fence_at = next(i for i, sql in enumerate(statements) if 'turn_requests' in sql and 'FOR SHARE' in sql)
            advisory_at = next(i for i, sql in enumerate(statements) if 'pg_advisory_xact_lock' in sql)
            self.assertLess(fence_at, advisory_at)
            host.cancel('alpha', run.request_id)
            statements.clear()
            with self.assertRaises(requests.StaleRun):
                with native.OrgDbBackend().transaction(action, 1):
                    self.fail('cancelled run reached the body')
            self.assertFalse(any('pg_advisory_xact_lock' in sql for sql in statements))
        self.assertTrue(all(raw.closed for raw in connections))
        host.complete(org, run)


if __name__ == '__main__':
    unittest.main()
