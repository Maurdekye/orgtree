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
from orgtree.orgdb import conn, jobs, lifecycle, names, turn_forwarder, turn_requests as requests

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
        with self.connection() as c:
            c.execute('TRUNCATE orgtree.jobs, orgtree.turn_requests')
        with self.queue.connect() as c:
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
            ready = json.loads(output.get(timeout=10))
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


if __name__ == '__main__':
    unittest.main()
