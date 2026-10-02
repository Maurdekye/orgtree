"""Real per-org queues: claim races, expiry fencing, retry, scheduler and history.

Needs disposable ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL.
Uses two owned t<pid>_org_* databases and one app database; run under the P03
heavy lock. No URL means skipped tests, not a pass.
"""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
import statistics
import threading
import time
import unittest
from unittest.mock import patch

from orgtree.orgdb import conn, jobs, lifecycle, names

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
class Queues(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        drop_owned()
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
        cls.lc.bootstrap()
        cls.orgs = []
        cls.runtime = jobs.Runtime(RUNTIME, prefix=PREFIX)
        for slug in ('alpha', 'beta'):
            oid = cls.lc.create_org(slug)
            row = cls.lc.row(oid)
            cls.orgs.append(jobs.Org(oid, slug, row['database'], str(row['org_uuid'])))
            with conn.connect(ADMIN, row['database']) as c:
                c.execute('CREATE TABLE orgtree.job_effects (job_id bigint PRIMARY KEY, value text)')
                from psycopg import sql
                c.execute(sql.SQL('GRANT SELECT, INSERT, UPDATE, DELETE ON orgtree.job_effects TO {}')
                          .format(sql.Identifier(conn.role_of(RUNTIME))))

    @classmethod
    def tearDownClass(cls):
        drop_owned()

    def setUp(self):
        for org in self.orgs:
            with conn.connect(ADMIN, org.database) as c:
                c.execute('TRUNCATE orgtree.jobs, orgtree.job_effects RESTART IDENTITY')

    def connection(self, org=None):
        return self.runtime.connect(org or self.orgs[0])

    def enqueue(self, key='key', **kw):
        with self.connection() as c, c.transaction():
            return jobs.enqueue(c, 'test', key, **kw)

    def claimed(self, owner=1, **kw):
        with self.connection() as c, c.transaction():
            return jobs.claim(c, owner, **kw)

    def row(self, jid):
        with self.connection() as c:
            return c.execute('SELECT state, attempts, last_error, lease_owner, lease_until, '
                             'run_at FROM orgtree.jobs WHERE id = %s', (jid,)).fetchone()

    def expire(self, jid):
        with self.connection() as c:
            c.execute("UPDATE orgtree.jobs SET lease_until = clock_timestamp() - interval '1 second' "
                      'WHERE id = %s', (jid,))

    @staticmethod
    def effect(c, job):
        c.execute('INSERT INTO orgtree.job_effects VALUES (%s, %s)', (job.id, job.dedupe_key))

    def test_enqueue_is_concurrently_idempotent_preserves_due_and_allows_finished_key(self):
        barrier = threading.Barrier(8)
        future = datetime.now(timezone.utc) + timedelta(hours=1)

        def put(_):
            with self.connection() as c:
                barrier.wait(timeout=5)
                with c.transaction():
                    return jobs.enqueue(c, 'test', 'same', run_at=future).id

        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(put, range(8)))
        self.assertEqual(len(set(ids)), 1)
        with self.connection() as c, c.transaction():
            same = jobs.enqueue(c, 'test', 'same')
            self.assertEqual(same.run_at, future)
            self.assertEqual(jobs.claim(c, 1), [])
            c.execute('UPDATE orgtree.jobs SET run_at = clock_timestamp() WHERE id = %s', (same.id,))
        (leased,) = self.claimed()
        with self.connection() as c:
            self.assertTrue(jobs.execute(c, leased, self.effect))
        self.assertNotEqual(self.enqueue('same').id, same.id)

    def test_enqueue_and_notification_rollback_with_condition(self):
        with self.connection() as listener, self.connection() as c:
            listener.execute('LISTEN org_jobs')
            with self.assertRaises(RuntimeError):
                with c.transaction():
                    jobs.enqueue(c, 'test', 'rolled-back')
                    raise RuntimeError('condition rolled back')
            self.assertEqual(list(listener.notifies(timeout=0.05)), [])
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.jobs').fetchone()[0], 0)
            with c.transaction():
                jobs.enqueue(c, 'test', 'committed')
            self.assertEqual(len(list(listener.notifies(timeout=0.2))), 1)

    def test_concurrent_workers_execute_each_job_once(self):
        with self.connection() as c, c.transaction():
            for i in range(48):
                jobs.enqueue(c, 'test', str(i))
        barrier = threading.Barrier(6)

        def worker(i):
            with self.connection() as c:
                barrier.wait(timeout=5)
                while True:
                    with c.transaction():
                        claimed = jobs.claim(c, i + 1)
                    if not claimed:
                        return
                    self.assertTrue(jobs.execute(c, claimed[0], self.effect))

        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(worker, range(6)))
        with self.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.job_effects').fetchone()[0], 48)
            self.assertEqual(c.execute("SELECT count(*) FROM orgtree.jobs WHERE state='done'")
                             .fetchone()[0], 48)
            self.assertEqual(c.execute('SELECT max(attempts) FROM orgtree.jobs').fetchone()[0], 1)

    def test_locked_due_job_does_not_block_an_unrelated_claim(self):
        first = self.enqueue('first')
        other = self.enqueue('other')
        with self.connection() as locker, locker.transaction(), self.connection() as c:
            locker.execute('SELECT id FROM orgtree.jobs WHERE id = %s FOR UPDATE', (first.id,))
            c.execute("SET statement_timeout = '750ms'")
            with c.transaction():
                (got,) = jobs.claim(c, 2)
            self.assertEqual(got.id, other.id)

    def test_expiry_reclaim_fences_old_execute_and_failure_even_same_owner(self):
        created = self.enqueue()
        (old,) = self.claimed(1)
        self.expire(created.id)
        with self.connection() as c, c.transaction():
            self.assertEqual(jobs.sweep(c), 1)
        (new,) = self.claimed(1)
        self.assertEqual(new.attempts, old.attempts + 1)
        with self.connection() as c:
            self.assertFalse(jobs.execute(c, old, self.effect))
            with c.transaction():
                self.assertFalse(jobs.fail(c, old, 'old worker'))
            self.assertTrue(jobs.execute(c, new, self.effect))
        self.assertEqual(self.row(created.id)[:2], ('done', 2))

    def test_expired_attempt_cannot_begin_before_reclaim(self):
        created = self.enqueue()
        (old,) = self.claimed()
        self.expire(created.id)
        with self.connection() as c:
            self.assertFalse(jobs.execute(c, old, self.effect))

    def test_wrong_engine_owner_cannot_execute_or_fail(self):
        self.enqueue()
        (leased,) = self.claimed(1)
        wrong = replace(leased, lease_owner=2)
        with self.connection() as c:
            self.assertFalse(jobs.execute(c, wrong, self.effect))
            with c.transaction():
                self.assertFalse(jobs.fail(c, wrong, 'wrong engine'))
            self.assertTrue(jobs.execute(c, leased, self.effect))

    def test_execution_waits_on_its_own_row_and_rechecks_expiry_after_wait(self):
        created = self.enqueue()
        (leased,) = self.claimed()
        started = threading.Event()
        def execute(job):
            with self.connection() as c:
                started.set()
                return jobs.execute(c, job, self.effect)
        # A brief competing lock must not abandon a valid claimed attempt.
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.connection() as locker, locker.transaction():
                locker.execute('SELECT id FROM orgtree.jobs WHERE id=%s FOR UPDATE', (created.id,))
                result = pool.submit(execute, leased)
                self.assertTrue(started.wait(5))
                time.sleep(0.1)
                self.assertFalse(result.done())
            self.assertTrue(result.result(timeout=5))
        created = self.enqueue('expiring')
        (leased,) = self.claimed(lease_seconds=0.3)
        started.clear()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.connection() as locker, locker.transaction():
                locker.execute('SELECT id FROM orgtree.jobs WHERE id=%s FOR UPDATE', (created.id,))
                result = pool.submit(execute, leased)
                self.assertTrue(started.wait(5))
                time.sleep(0.4)
            self.assertFalse(result.result(timeout=5))

    def test_scheduler_throttles_a_locked_expired_job_without_false_notifications(self):
        created = self.enqueue()
        self.claimed()
        self.expire(created.id)
        worker = jobs.Worker({}, owner=2, active_orgs=self.runtime.active_orgs,
                             connect=self.connection)
        try:
            with self.connection() as locker, locker.transaction():
                locker.execute('SELECT id FROM orgtree.jobs WHERE id=%s FOR UPDATE', (created.id,))
                delay = worker.step()
                self.assertGreater(delay, 0.5)
                with patch.object(worker, '_run_org', wraps=worker._run_org) as run:
                    worker.step()
                    run.assert_not_called()
        finally:
            worker.close()

    def test_handler_lock_prevents_reclaim_after_expiry_and_duplicate_execution(self):
        created = self.enqueue()
        (leased,) = self.claimed(lease_seconds=0.1)
        entered = threading.Event()
        release = threading.Event()

        def handler(c, job):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test release missing')
            self.effect(c, job)

        def execute():
            with self.connection() as c:
                return jobs.execute(c, leased, handler)

        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(execute)
            try:
                self.assertTrue(entered.wait(5))
                time.sleep(0.15)
                with self.connection() as c:
                    c.execute("SET statement_timeout = '750ms'")
                    with c.transaction():
                        self.assertEqual(jobs.sweep(c), 0)
                        self.assertEqual(jobs.claim(c, 2), [])
                    self.assertFalse(jobs.execute(c, leased, self.effect))
            finally:
                release.set()
            self.assertTrue(running.result(timeout=5))
        self.assertEqual(self.row(created.id)[0], 'done')

    def test_error_rolls_back_effects_backs_off_and_terminal_failure(self):
        created = self.enqueue(max_attempts=2)

        def broken(c, job):
            self.effect(c, job)
            raise RuntimeError('broken handler')

        (first,) = self.claimed()
        before = datetime.now(timezone.utc)
        with self.connection() as c:
            self.assertTrue(jobs.execute(c, first, broken, base_seconds=5))
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.job_effects').fetchone()[0], 0)
            row = self.row(created.id)
            self.assertEqual(row[:2], ('queued', 1))
            self.assertIn('broken handler', row[2])
            self.assertIsNone(row[3])
            self.assertGreaterEqual((row[5] - before).total_seconds(), 5)
            with c.transaction():
                self.assertEqual(jobs.claim(c, 2), [])
                c.execute('UPDATE orgtree.jobs SET run_at=clock_timestamp() WHERE id=%s', (created.id,))
        (second,) = self.claimed()
        with self.connection() as c:
            jobs.execute(c, second, broken)
        self.assertEqual(self.row(created.id)[:2], ('failed', 2))
        self.assertEqual(self.claimed(), [])

    def test_crashed_last_attempt_becomes_terminal(self):
        created = self.enqueue(max_attempts=1)
        self.claimed()
        self.expire(created.id)
        with self.connection() as c, c.transaction():
            self.assertEqual(jobs.sweep(c), 1)
        self.assertEqual(self.row(created.id)[:3], ('failed', 1, 'lease expired'))

    def test_org_identity_and_same_key_are_isolated(self):
        with self.connection(self.orgs[0]) as a, self.connection(self.orgs[1]) as b:
            one = jobs.enqueue(a, 'test', 'same')
            two = jobs.enqueue(b, 'test', 'same')
            self.assertEqual(one.id, two.id)
            with a.transaction():
                (ja,) = jobs.claim(a, 1)
            jobs.execute(a, ja, self.effect)
            self.assertEqual(b.execute('SELECT state FROM orgtree.jobs').fetchone()[0], 'queued')
        wrong = jobs.Org(self.orgs[0].org_id, 'wrong', self.orgs[0].database, self.orgs[0].org_uuid)
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            self.runtime.connect(wrong)

    def test_worker_runs_every_active_org_and_survives_one_org_failure(self):
        for org in self.orgs:
            with self.connection(org) as c:
                jobs.enqueue(c, 'test', 'same')
        errors = []

        def connect(org):
            if org == self.orgs[0]:
                raise RuntimeError('alpha unavailable')
            return self.connection(org)

        worker = jobs.Worker({'test': self.effect}, owner=1, active_orgs=self.runtime.active_orgs,
                             connect=connect, on_error=lambda org, exc: errors.append(org.slug))
        try:
            worker.step()
        finally:
            worker.close()
        self.assertEqual(errors, ['alpha'])
        with self.connection(self.orgs[1]) as c:
            self.assertEqual(c.execute('SELECT state FROM orgtree.jobs').fetchone()[0], 'done')
        worker = jobs.Worker({'test': self.effect}, owner=1, active_orgs=self.runtime.active_orgs,
                             connect=self.connection)
        try:
            worker.step()
        finally:
            worker.close()
        self.assertEqual(self.row(1)[0], 'done')

    def test_scheduler_notifications_deadlines_dormant_sweep_and_lease_wakeup(self):
        # A scheduled job retains a listener; an earlier enqueue wakes it.
        self.enqueue('later', run_at=datetime.now(timezone.utc) + timedelta(seconds=40))
        worker = jobs.Worker({'test': self.effect}, owner=1, active_orgs=self.runtime.active_orgs,
                             connect=self.connection)
        try:
            worker.step()
            self.assertIn(self.orgs[0].org_id, worker.served)
            self.enqueue('earlier')
            worker.step()
            self.assertEqual(self.row(2)[0], 'done')
            with self.connection() as c:
                c.execute('UPDATE orgtree.jobs SET run_at = clock_timestamp() WHERE id=1')
            worker.step()
            self.assertEqual(self.row(1)[0], 'done')
            self.assertEqual(worker.served, {})  # idle orgs hold no listener
            created = self.enqueue('dormant')
            worker.step()
            self.assertEqual(self.row(created.id)[0], 'queued')
            worker._next_sweep = 0  # simulate the next 60-second sweep
            worker.step()
            self.assertEqual(self.row(created.id)[0], 'done')
            created = self.enqueue('crashed')
            self.claimed()
            self.expire(created.id)
            worker._next_sweep = 0
            worker.step()
            self.assertEqual(self.row(created.id)[:2], ('done', 2))
        finally:
            worker.close()

    def test_handler_failure_does_not_stop_other_org_and_unknown_kind_retries(self):
        for org in self.orgs:
            with self.connection(org) as c:
                jobs.enqueue(c, 'test', org.slug)
        def handler(c, job):
            if job.dedupe_key == 'alpha':
                raise RuntimeError('alpha job failed')
            self.effect(c, job)
        worker = jobs.Worker({'test': handler}, owner=1, active_orgs=self.runtime.active_orgs,
                             connect=self.connection)
        try:
            worker.step()
        finally:
            worker.close()
        self.assertEqual(self.row(1)[0], 'queued')
        self.assertIn('alpha job failed', self.row(1)[2])
        with self.connection(self.orgs[1]) as c:
            self.assertEqual(c.execute('SELECT state FROM orgtree.jobs').fetchone()[0], 'done')
            unknown = jobs.enqueue(c, 'unknown', 'unregistered', max_attempts=1)
        worker = jobs.Worker({}, owner=1, active_orgs=self.runtime.active_orgs,
                             connect=self.connection)
        try:
            worker.step()
        finally:
            worker.close()
        with self.connection(self.orgs[1]) as c:
            state, error = c.execute('SELECT state, last_error FROM orgtree.jobs WHERE id=%s',
                                     (unknown.id,)).fetchone()
            self.assertEqual(state, 'failed')
            self.assertIn('no handler', error)

    def test_worker_run_stops_and_closes_listeners(self):
        self.enqueue(run_at=datetime.now(timezone.utc) + timedelta(seconds=40))
        ready = threading.Event()
        stop = threading.Event()
        def active():
            ready.set()
            return self.runtime.active_orgs()
        worker = jobs.Worker({}, owner=1, active_orgs=active, connect=self.connection)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(worker.run, stop)
            try:
                self.assertTrue(ready.wait(5))
            finally:
                stop.set()
            running.result(timeout=5)
        self.assertEqual(worker.served, {})

    def test_failed_registry_drops_cached_orgs_and_callback_cannot_stop_worker(self):
        self.enqueue(run_at=datetime.now(timezone.utc) + timedelta(seconds=40))
        worker = jobs.Worker({}, owner=1, active_orgs=self.runtime.active_orgs, connect=self.connection,
                             on_error=lambda org, exc: (_ for _ in ()).throw(RuntimeError('callback')))
        try:
            worker.step()
            self.assertTrue(worker.served)
            worker.active_orgs = lambda: (_ for _ in ()).throw(RuntimeError('registry'))
            worker._next_sweep = 0
            worker.step()
            self.assertEqual(worker.served, {})
        finally:
            worker.close()

    def test_claim_plan_and_rows_do_not_grow_with_finished_history(self):
        def measure(c):
            samples = []
            plans = []
            for i in range(25):
                with c.transaction():
                    jobs.enqueue(c, 'test', f'probe-{i}')
                started = time.perf_counter()
                with c.transaction():
                    plan = c.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + jobs.CLAIM_SQL,
                                     (1, 1, 30)).fetchone()[0][0]
                samples.append((time.perf_counter() - started) * 1000)
                plans.append(plan['Plan'])
                with c.transaction():
                    (jid,) = c.execute("SELECT id FROM orgtree.jobs WHERE state='running'").fetchone()
                    c.execute("UPDATE orgtree.jobs SET state='done', lease_owner=NULL, lease_until=NULL "
                              'WHERE id=%s', (jid,))
            return statistics.median(samples), plans

        with self.connection() as c:
            # Force generic preparation too: hot predicates must stay literal.
            c.execute('SET plan_cache_mode = force_generic_plan')
            small_ms, _ = measure(c)
            c.execute("INSERT INTO orgtree.jobs(kind,dedupe_key,state) "
                      "SELECT 'history', n::text, 'done' FROM generate_series(1,100000) n")
            with conn.connect(ADMIN, self.orgs[0].database) as admin:
                admin.execute('VACUUM ANALYZE orgtree.jobs')
            large_ms, plans = measure(c)

        def scans(plan):
            yield plan
            for child in plan.get('Plans', []):
                yield from scans(child)

        for plan in plans:
            nodes = list(scans(plan))
            self.assertTrue(any(n.get('Index Name') == 'jobs_due' for n in nodes), json.dumps(plan))
            self.assertFalse(any(n.get('Node Type') == 'Seq Scan' for n in nodes), json.dumps(plan))
            self.assertLessEqual(sum(n.get('Rows Removed by Filter', 0) for n in nodes), 1)
            self.assertLessEqual(max(n.get('Actual Rows', 0) for n in nodes), 1)
        print(json.dumps({'jobs_history_probe': {'finished_rows': 100000,
                          'small_median_ms': small_ms, 'large_median_ms': large_ms}}))
        # Row bounds/plan are the strict guard. Time guard catches catastrophic
        # growth without pretending shared-machine sub-ms noise is performance.
        self.assertLess(large_ms, max(25, small_ms * 5))


if __name__ == '__main__':
    unittest.main()
