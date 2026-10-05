"""App account session reuse and transaction safety on disposable PostgreSQL.

Creates an app database: take the heavy P03 lock. A skip is not a pass.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import contextlib
from dataclasses import replace
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from uuid import uuid4

from orgtree import turnqueue, turnslots
from orgtree.orgdb import accounts, app_pool, conn, jobs, lifecycle, names, registry, turn_runtime

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f'outage{os.getpid()}_'


@unittest.skipUnless(ADMIN and RUNTIME, 'disposable PostgreSQL required; skip is not a pass')
class AppPool(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = mock.patch.dict(os.environ, {'ORGTREE_ORGDB_PREFIX': PREFIX,
                                              'ORGTREE_PG_CONNINFO': RUNTIME})
        cls.env.start()
        cls.addClassCleanup(cls.env.stop)
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME),
                                     prefix=PREFIX, build='outage-test')
        cls.lc.bootstrap()
        cls.addClassCleanup(cls.drop_database)
        cls.orgs = []
        for slug in ('alpha', 'beta'):
            oid = cls.lc.create_org(slug)
            row = cls.lc.row(oid)
            cls.orgs.append(jobs.Org(oid, slug, row['database'], str(row['org_uuid'])))

    @classmethod
    def drop_database(cls):
        from psycopg import sql
        app_pool.close_idle()
        with conn.connect(ADMIN, 'postgres') as raw:
            for db in [o.database for o in getattr(cls, 'orgs', [])] + [names.app(PREFIX)]:
                raw.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))

    def setUp(self):
        app_pool.close_idle()
        self.addCleanup(app_pool.close_idle)
        with conn.connect(RUNTIME, names.app()) as raw:
            raw.execute('UPDATE orgtree.app_settings SET accounts_version=1')

    def version(self):
        with conn.connect(RUNTIME, names.app()) as raw:
            return raw.execute('SELECT accounts_version FROM orgtree.app_settings').fetchone()[0]

    def test_sequential_account_operations_reuse_one_backend(self):
        with mock.patch.object(conn, 'connect', wraps=conn.connect) as opened:
            pids = []
            for _ in range(3):
                with accounts.connection() as raw:
                    pids.append(raw.info.backend_pid)
                    raw.execute('SELECT 1')
            self.assertEqual(len(set(pids)), 1)
            self.assertEqual(opened.call_count, 1)

    def test_overlapping_operations_reuse_distinct_backends(self):
        def wave():
            barrier = threading.Barrier(4)
            def read():
                with accounts.connection() as raw:
                    barrier.wait(timeout=10)
                    raw.execute('SELECT 1')
                    return raw.info.backend_pid
            with ThreadPoolExecutor(max_workers=4) as pool:
                return set(pool.map(lambda _: read(), range(4)))
        first = wave()
        self.assertEqual(len(first), 4)
        self.assertEqual(wave(), first)

    def test_success_commits_and_body_failure_rolls_back_once(self):
        with accounts.connection() as raw:
            raw.execute('BEGIN')
            raw.execute('UPDATE orgtree.app_settings SET accounts_version=17')
        self.assertEqual(self.version(), 17)
        calls = []
        with self.assertRaisesRegex(RuntimeError, 'body control'):
            with accounts.connection() as raw:
                calls.append(1)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.app_settings SET accounts_version=23')
                raise RuntimeError('body control')
        self.assertEqual(calls, [1])
        self.assertEqual(self.version(), 17)
        self.assertTrue(raw.closed)

    def test_ambiguous_commit_is_not_retried_and_session_is_discarded(self):
        import psycopg
        calls = []
        patched = None
        try:
            with self.assertRaisesRegex(psycopg.OperationalError, 'lost acknowledgement'):
                with accounts.connection() as raw:
                    raw.execute('BEGIN')
                    self.addCleanup(raw.close)
                    raw.execute('UPDATE orgtree.app_settings SET accounts_version=accounts_version+1')
                    commit = raw.commit
                    def committed_then_lost():
                        calls.append(1)
                        commit()
                        raise psycopg.OperationalError('lost acknowledgement')
                    patched = mock.patch.object(raw, 'commit', committed_then_lost)
                    patched.start()
        finally:
            if patched is not None:
                patched.stop()
        self.assertEqual(calls, [1])
        self.assertEqual(self.version(), 2)
        self.assertTrue(raw.closed)

    def test_dead_idle_backend_is_replaced_before_body(self):
        with accounts.connection() as raw:
            pid = raw.info.backend_pid
        with conn.connect(ADMIN, names.app()) as admin:
            self.assertTrue(admin.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
        bodies = []
        with accounts.connection() as raw:
            bodies.append(raw.info.backend_pid)
            self.assertEqual(raw.execute('SELECT 1').fetchone(), (1,))
        self.assertEqual(len(bodies), 1)
        self.assertNotEqual(bodies[0], pid)

    def test_reset_failure_discards_the_session(self):
        import psycopg
        patched = None
        seen = []
        try:
            with accounts.connection() as raw:
                execute = raw.execute
                def fail_reset(statement, *args, **kwargs):
                    if statement == 'RESET ALL':
                        seen.append(statement)
                        raise psycopg.OperationalError('reset control')
                    return execute(statement, *args, **kwargs)
                patched = mock.patch.object(raw, 'execute', fail_reset)
                patched.start()
        finally:
            if patched is not None:
                patched.stop()
        self.assertEqual(seen, ['RESET ALL'])
        self.assertTrue(raw.closed)
        with accounts.connection() as next_raw:
            self.assertIsNot(next_raw, raw)
            self.assertEqual(next_raw.execute('SELECT 1').fetchone(), (1,))

    def test_idle_cap_and_expiry_do_not_limit_active_sessions(self):
        with contextlib.ExitStack() as stack:
            held = [stack.enter_context(app_pool.connection(RUNTIME, names.app(),
                       application_name=f'outage-cap-{i}')) for i in range(app_pool.MAX_IDLE+1)]
            self.assertEqual(len({raw.info.backend_pid for raw in held}), app_pool.MAX_IDLE+1)
        self.assertEqual(sum(not raw.closed for raw in held), app_pool.MAX_IDLE)
        with mock.patch.object(registry, 'IDLE_SECONDS', 0):
            with accounts.connection() as fresh:
                self.assertNotIn(fresh, held)
        self.assertTrue(all(raw.closed for raw in held))

    def test_account_host_and_registry_share_backend_with_current_label(self):
        host = turn_runtime.Host(RUNTIME, self.lc.instance_id, prefix=PREFIX)
        runtime = jobs.Runtime(RUNTIME, prefix=PREFIX)
        with accounts.connection() as first:
            pid = first.info.backend_pid
            self.assertEqual(first.execute('SHOW application_name').fetchone()[0], 'orgtree-accounts')
        with host.app_connection() as second:
            self.assertEqual(second.info.backend_pid, pid)
            self.assertEqual(second.execute('SHOW application_name').fetchone()[0], 'orgtree-turn-host')
        execute = first.execute
        labels = []
        def record(statement, *args, **kwargs):
            if statement.startswith('SELECT org_id, slug, database'):
                labels.append(execute('SHOW application_name').fetchone()[0])
            return execute(statement, *args, **kwargs)
        with mock.patch.object(first, 'execute', record):
            self.assertEqual(runtime.active_orgs(), self.orgs)
        self.assertEqual(labels, ['orgtree-jobs-registry'])
        with accounts.connection() as third:
            self.assertEqual(third.info.backend_pid, pid)
            self.assertEqual(third.execute('SHOW application_name').fetchone()[0], 'orgtree-accounts')

    def test_heartbeat_reuses_its_timeout_target_and_lease_queue(self):
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        base = make_conninfo(RUNTIME, options='-c statement_timeout=17000')
        host = turn_runtime.Host(base, self.lc.instance_id, prefix=PREFIX)
        with host.app_connection() as ordinary:
            ordinary_pid = ordinary.info.backend_pid
            self.assertEqual(ordinary.execute('SHOW statement_timeout').fetchone()[0], '17s')
        with mock.patch.object(conn, 'connect', wraps=conn.connect) as opened:
            self.assertEqual(host._lease_queue.heartbeat(self.lc.instance_id), [])
            self.assertEqual(host._lease_queue.heartbeat(self.lc.instance_id), [])
            pids = []
            for _ in range(2):
                with host.heartbeat_connection() as raw:
                    pids.append(raw.info.backend_pid)
                    self.assertEqual(raw.execute('SHOW statement_timeout').fetchone()[0], '5s')
                    self.assertEqual(raw.execute('SHOW application_name').fetchone()[0],
                                     'orgtree-turn-heartbeat')
                    self.assertEqual(conninfo_to_dict(raw.info.dsn)['connect_timeout'], '5')
            self.assertEqual(opened.call_count, 1)
        self.assertEqual(len(set(pids)), 1)
        self.assertNotEqual(pids[0], ordinary_pid)
        with host.app_connection() as ordinary_again:
            self.assertEqual(ordinary_again.info.backend_pid, ordinary_pid)
            self.assertEqual(ordinary_again.execute('SHOW statement_timeout').fetchone()[0], '17s')

    def test_heartbeat_bypasses_exhausted_app_slots(self):
        host = turn_runtime.Host(RUNTIME, self.lc.instance_id, prefix=PREFIX)
        for _ in range(4):
            self.assertTrue(host._app_slots.acquire(blocking=False))
        self.assertFalse(host._app_slots.acquire(blocking=False))
        def heartbeat():
            return host._lease_queue.heartbeat(self.lc.instance_id)
        with ThreadPoolExecutor(max_workers=1) as pool:
            work = pool.submit(heartbeat)
            try:
                self.assertEqual(work.result(timeout=5), [])
            finally:
                # A deliberately broken app-slot adapter must not hang cleanup.
                for _ in range(4):
                    host._app_slots.release()

    def test_actual_listener_stop_discards_subscription_before_recheckout(self):
        host = turn_runtime.Host(RUNTIME, self.lc.instance_id, prefix=PREFIX)
        listener = turnslots.DatabaseSlots()
        ready = threading.Event()
        opened = []
        connect = conn.connect
        def capture(*args, **kwargs):
            raw = connect(*args, **kwargs)
            opened.append(raw)
            return raw
        with mock.patch.object(turnslots, '_configured', return_value=(host.queue, self.lc.instance_id)), \
             mock.patch.object(turnqueue, 'HEARTBEAT_SECONDS', 0.05), \
             mock.patch.object(listener, '_changed', side_effect=ready.set), \
             mock.patch.object(conn, 'connect', capture):
            try:
                listener._start()
                self.assertTrue(ready.wait(5), 'actual LISTEN did not become ready')
                self.assertEqual(len(opened), 1)
                subscribed = opened[0]
                pid = subscribed.info.backend_pid
                self.assertEqual(subscribed.execute('SELECT pg_listening_channels()').fetchall(),
                                 [('turn_tickets',)])
            finally:
                listener.close()
        self.assertFalse(listener._thread.is_alive())
        self.assertTrue(subscribed.closed)
        with accounts.connection() as next_raw:
            self.assertNotEqual(next_raw.info.backend_pid, pid)
            self.assertEqual(next_raw.execute('SELECT pg_listening_channels()').fetchall(), [])

    def test_database_targets_do_not_share_sessions(self):
        with app_pool.connection(RUNTIME, names.app(), application_name='outage-isolation') as first:
            pid = first.info.backend_pid
        with app_pool.connection(RUNTIME, 'postgres', application_name='outage-isolation') as other:
            self.assertNotEqual(other.info.backend_pid, pid)
            self.assertEqual(other.execute('SELECT current_database()').fetchone(), ('postgres',))
        with app_pool.connection(RUNTIME, names.app(), application_name='outage-isolation') as again:
            self.assertEqual(again.info.backend_pid, pid)

    def host(self, runtime=RUNTIME, **kwargs):
        return turn_runtime.Host(runtime, self.lc.instance_id, prefix=PREFIX, **kwargs)

    def test_default_host_bridge_and_compatibility_share_org_sessions(self):
        org = self.orgs[0]
        with registry.connection(org.slug) as first:
            pid = first.info.backend_pid
        host = self.host()
        with mock.patch.object(conn, 'connect', wraps=conn.connect) as opened:
            with host.org_connection(org) as second:
                self.assertEqual(second.info.backend_pid, pid)
                self.assertEqual(second.execute('SHOW application_name').fetchone()[0], 'orgtree-jobs')
            host.bridge.step(org)
            self.assertEqual(opened.call_count, 0)
        with registry.connection(org.slug) as third:
            self.assertEqual(third.info.backend_pid, pid)

    def test_default_host_uses_explicit_runtime_and_isolates_orgs(self):
        from psycopg.conninfo import make_conninfo
        other = make_conninfo(RUNTIME, options='-c statement_timeout=5000')
        host = self.host()
        with mock.patch.dict(os.environ, {'ORGTREE_PG_CONNINFO': other}):
            with host.org_connection(self.orgs[0]) as first:
                pid = first.info.backend_pid
                self.assertEqual(first.execute('SHOW statement_timeout').fetchone(), ('0',))
            with self.host(other).org_connection(self.orgs[0]) as second:
                self.assertNotEqual(second.info.backend_pid, pid)
                self.assertEqual(second.execute('SHOW statement_timeout').fetchone(), ('5s',))
            with host.org_connection(self.orgs[1]) as third:
                self.assertNotEqual(third.info.backend_pid, pid)
                self.assertEqual(third.execute('SELECT slug FROM orgtree.org_identity').fetchone(), ('beta',))
            with host.org_connection(self.orgs[0]) as again:
                self.assertEqual(again.info.backend_pid, pid)

    def test_wrong_identity_refused_warm_fresh_and_after_dead_backend(self):
        host, org = self.host(), self.orgs[0]
        wrong = replace(org, org_uuid=str(uuid4()))
        with host.org_connection(org) as warm:
            pass
        for expected_connects in (0, 1):
            with mock.patch.object(conn, 'connect', wraps=conn.connect) as opened:
                with self.assertRaises((registry.OrgUnavailable, ValueError)):
                    with host.org_connection(wrong):
                        self.fail('wrong identity entered caller body')
                self.assertEqual(opened.call_count, expected_connects)
        self.assertTrue(warm.closed)
        with host.org_connection(org) as dead:
            pid = dead.info.backend_pid
        with conn.connect(ADMIN, org.database) as admin:
            self.assertTrue(admin.execute('SELECT pg_terminate_backend(%s)', (pid,)).fetchone()[0])
        with mock.patch.object(conn, 'connect', wraps=conn.connect) as opened:
            with self.assertRaises((registry.OrgUnavailable, ValueError)):
                with host.org_connection(wrong):
                    self.fail('wrong replacement identity entered caller body')
            self.assertEqual(opened.call_count, 1)
        with host.org_connection(org) as good:
            self.assertNotEqual(good.info.backend_pid, pid)

    def test_injected_callback_keeps_raw_close_and_error_contract(self):
        opened = []
        def connect(org):
            raw = conn.connect(RUNTIME, org.database)
            opened.append(raw)
            return raw
        host = self.host(connect_org=connect)
        with host.org_connection(self.orgs[0]) as first:
            first.execute('SELECT 1')
        self.assertTrue(first.closed)
        with self.assertRaisesRegex(RuntimeError, 'caller error'):
            with host.org_connection(self.orgs[0]) as second:
                raise RuntimeError('caller error')
        self.assertTrue(second.closed)
        self.assertEqual(len(opened), 2)
        failed = mock.Mock(side_effect=ValueError('injected open error'))
        with self.assertRaisesRegex(ValueError, 'injected open error'):
            with self.host(connect_org=failed).org_connection(self.orgs[0]):
                self.fail('failed callback entered body')
        failed.assert_called_once_with(self.orgs[0])

    def test_stalled_registry_read_does_not_block_another_org_checkout(self):
        entered, release = threading.Event(), threading.Event()
        def stall(raw):
            raw.execute('SELECT 1')
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test failed to release stalled read')
        def read():
            with registry.connection(self.orgs[1].slug) as raw:
                return raw.execute('SELECT slug FROM orgtree.org_identity').fetchone()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(registry._on_app, stall)
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(pool.submit(read).result(timeout=2), ('beta',))
            finally:
                release.set()
                first.result(timeout=3)

    def test_dirty_and_subscribed_org_sessions_are_discarded(self):
        org = self.orgs[0]
        for statement in ('BEGIN', 'LISTEN outage_control'):
            raw = registry.checkout(org.slug, org.database, org.org_uuid)
            raw.execute(statement)
            registry.release(raw, org.database)
            self.assertTrue(raw.closed)
        with self.assertRaisesRegex(RuntimeError, 'cancelled caller'):
            with registry.connection(org.slug) as failed:
                raise RuntimeError('cancelled caller')
        self.assertTrue(failed.closed)

    def test_transaction_locks_are_released_before_session_reuse(self):
        import psycopg
        org, host = self.orgs[0], self.host()
        with conn.connect(RUNTIME, org.database) as observer:
            observer.execute("SET lock_timeout = '100ms'")
            for _ in range(2):
                with host.org_connection(org) as raw:
                    pid = raw.info.backend_pid
                    raw.execute('BEGIN')
                    raw.execute('SELECT * FROM orgtree.org_revision FOR SHARE')
                    with self.assertRaises(psycopg.errors.LockNotAvailable):
                        observer.execute('UPDATE orgtree.org_revision SET rev=rev')
                # COMMIT must have released the fence before the session is idle.
                observer.execute('UPDATE orgtree.org_revision SET rev=rev')
                with host.org_connection(org) as reused:
                    self.assertEqual(reused.info.backend_pid, pid)

    def test_default_org_ambiguous_commit_does_not_replay(self):
        import psycopg
        org = self.orgs[0]
        with conn.connect(RUNTIME, org.database) as observer:
            before = observer.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
        bodies = []
        patched = None
        try:
            with self.assertRaisesRegex(psycopg.OperationalError, 'lost org commit'):
                with self.host().org_connection(org) as raw:
                    self.addCleanup(raw.close)
                    bodies.append(1)
                    raw.execute('BEGIN')
                    raw.execute('UPDATE orgtree.org_revision SET rev=rev+1')
                    commit = raw.commit
                    def lost():
                        commit()
                        raise psycopg.OperationalError('lost org commit')
                    patched = mock.patch.object(raw, 'commit', lost)
                    patched.start()
        finally:
            if patched:
                patched.stop()
        self.assertEqual(bodies, [1])
        self.assertTrue(raw.closed)
        with conn.connect(RUNTIME, org.database) as observer:
            self.assertEqual(observer.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0], before+1)

    def test_app_and_org_idle_sessions_share_the_global_cap(self):
        with mock.patch.object(registry, 'IDLE_TOTAL', 3):
            with contextlib.ExitStack() as stack:
                held = [stack.enter_context(self.host().org_connection(org))
                        for org in self.orgs for _ in range(2)]
                held += [stack.enter_context(accounts.connection()) for _ in range(2)]
            self.assertEqual(sum(not raw.closed for raw in held), 3)
            self.assertEqual(registry._idle_count(), 3)

    def test_runtime_target_changes_do_not_reuse_a_session(self):
        from psycopg.conninfo import make_conninfo
        with accounts.connection() as first:
            pid = first.info.backend_pid
        other = make_conninfo(RUNTIME, options='-c statement_timeout=5000')
        with mock.patch.dict(os.environ, {'ORGTREE_PG_CONNINFO': other}):
            with accounts.connection() as second:
                self.assertNotEqual(second.info.backend_pid, pid)
                self.assertEqual(second.execute('SHOW statement_timeout').fetchone()[0], '5s')


if __name__ == '__main__':
    unittest.main()
