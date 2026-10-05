"""App account session reuse and transaction safety on disposable PostgreSQL.

Creates an app database: take the heavy P03 lock. A skip is not a pass.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import contextlib
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from orgtree import turnqueue, turnslots
from orgtree.orgdb import accounts, app_pool, conn, jobs, lifecycle, names, turn_runtime

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

    @classmethod
    def drop_database(cls):
        from psycopg import sql
        app_pool.close_idle()
        with conn.connect(ADMIN, 'postgres') as raw:
            raw.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(names.app(PREFIX))))

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
        with mock.patch.object(app_pool, 'IDLE_SECONDS', 0):
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
            self.assertEqual(runtime.active_orgs(), [])
        self.assertEqual(labels, ['orgtree-jobs-registry'])
        with accounts.connection() as third:
            self.assertEqual(third.info.backend_pid, pid)
            self.assertEqual(third.execute('SHOW application_name').fetchone()[0], 'orgtree-accounts')

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
