"""First-use statistics, actual runtime role and transactional import controls."""
import os
import threading
import time
import unittest
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit

import test_pgimport as fixture
from orgtree import pgstore, pgstats, store, workread

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')


@unittest.skipUnless(ADMIN, 'private PostgreSQL required: NOT RUN')
class Statistics(fixture.Base):
    @classmethod
    def setUpClass(cls):
        import psycopg
        cls.db = 'stats_' + uuid.uuid4().hex
        u = urlsplit(ADMIN)
        cls.url = urlunsplit((u.scheme, u.netloc, '/' + cls.db, u.query, u.fragment))
        with psycopg.connect(ADMIN, autocommit=True) as raw:
            raw.execute('CREATE DATABASE ' + cls.db)
        pgstore.migrate(cls.url)

    @classmethod
    def tearDownClass(cls):
        import psycopg
        with psycopg.connect(ADMIN, autocommit=True) as raw:
            raw.execute('DROP DATABASE ' + cls.db + ' WITH (FORCE)')

    def setUp(self):
        super().setUp()
        self.raw = pgstore.connect(self.url)
        self.raw.add_notice_handler(lambda diagnostic: print(diagnostic.message_primary, flush=True))
        self.addCleanup(self.raw.close)
        self.slug = 'stats-' + uuid.uuid4().hex
        self.oid = self.raw.execute('INSERT INTO public.orgs(slug) VALUES(%s) RETURNING org_id', (self.slug,)).fetchone()[0]
        self.raw.execute('SELECT public.orgtree_create_org_schema(%s)', (self.oid,))
        self.schema = 'org_' + str(self.oid)
        self.raw.execute(f"INSERT INTO {self.schema}.doc SELECT 'test-'||i,'null' FROM generate_series(1,100) i")

    def mark(self):
        return self.raw.execute('SELECT schema_version,analyzed_at FROM public.org_statistics_ready WHERE org_id=%s', (self.oid,)).fetchone()

    def estimate(self):
        return self.raw.execute('SELECT reltuples FROM pg_class WHERE oid=%s::regclass', (self.schema + '.doc',)).fetchone()[0]

    def test_runtime_analyzes_first_use_then_skips_without_broader_permissions(self):
        self.assertEqual(self.estimate(), -1)
        with self.raw.transaction():
            self.raw.execute('SET LOCAL ROLE orgtree_runtime')
            self.assertGreater(pgstats.analyze(self.raw, self.oid), 0)
        self.assertEqual(self.estimate(), 100)
        original = self.mark()
        self.assertIsNotNone(original)
        with self.raw.transaction():
            self.raw.execute('SET LOCAL ROLE orgtree_runtime')
            self.assertEqual(pgstats.analyze(self.raw, self.oid), 0)
            self.assertFalse(self.raw.execute("SELECT has_table_privilege(current_user,'public.org_statistics_ready','INSERT')").fetchone()[0])
        self.assertEqual(self.mark(), original)
        self.assertFalse(self.raw.execute("SELECT has_function_privilege('public','public.orgtree_analyze_org(bigint,boolean)','EXECUTE')").fetchone()[0])

    def test_force_and_changed_schema_both_refresh_completion(self):
        pgstats.analyze(self.raw, self.oid)
        self.raw.execute(f"INSERT INTO {self.schema}.doc SELECT 'extra-'||i,'null' FROM generate_series(1,20) i")
        self.assertGreater(pgstats.analyze(self.raw, self.oid, force=True), 0)
        self.assertEqual(self.estimate(), 120)
        with self.raw.transaction():
            self.raw.execute("INSERT INTO public.schema_migrations(name,sha256) VALUES('test-statistics-version','test')")
            self.assertGreater(pgstats.analyze(self.raw, self.oid), 0)
            self.assertEqual(pgstats.analyze(self.raw, self.oid), 0)
            self.raw.execute("DELETE FROM public.schema_migrations WHERE name='test-statistics-version'")

    def test_cancelled_analysis_is_retryable_and_rollback_does_not_mark(self):
        with pgstore.connect(self.url) as holder:
            with holder.transaction():
                holder.execute(f'LOCK TABLE {self.schema}.doc IN ACCESS EXCLUSIVE MODE')
                with self.assertRaises(Exception):
                    with self.raw.transaction():
                        self.raw.execute("SET LOCAL statement_timeout='100ms'")
                        pgstats.analyze(self.raw, self.oid)
                self.assertIsNone(self.mark())
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with self.raw.transaction():
                self.assertGreater(pgstats.analyze(self.raw, self.oid), 0)
                raise RuntimeError('rollback')
        self.assertIsNone(self.mark())
        self.assertGreater(pgstats.analyze(self.raw, self.oid), 0)

    def test_real_import_analyzes_before_receipt_and_rolls_back_on_failure(self):
        fixture.write_db(self.orgs() / 'acme.db', fixture.sample_doc())
        sink = fixture.pgimport.PgSink(self.url, self.orgs())
        self.addCleanup(sink.close)
        observed = []
        original = pgstats.analyze
        def fail(raw, oid, *, force=False):
            observed.append(force)
            raise RuntimeError('analysis failed')
        with patch.object(pgstats, 'analyze', fail):
            with self.assertRaisesRegex(RuntimeError, 'analysis failed'):
                fixture.pgimport.import_root(self.root, sink)
        self.assertEqual(observed, [True])
        self.assertIsNone(sink.recorded('acme'))
        self.assertFalse((self.orgs() / 'acme.pg').exists())
        fixture.pgimport.import_root(self.root, sink)
        oid = sink._org_id('acme')
        self.assertIsNotNone(sink.conn.execute('SELECT 1 FROM public.org_statistics_ready WHERE org_id=%s', (oid,)).fetchone())
        self.assertGreaterEqual(sink.conn.execute(f"SELECT reltuples FROM pg_class WHERE oid='org_{oid}.doc'::regclass").fetchone()[0], 0)
        with patch.object(pgstats, 'analyze', side_effect=AssertionError('repeat COPY')):
            again = fixture.pgimport.import_root(self.root, sink)
        self.assertEqual(again['orgs']['acme']['action'], 'already_imported')

    def test_startup_orders_bootstrap_before_statistics_and_propagates_failure(self):
        calls = []
        def build(raw): calls.append('derived')
        def analyze(raw):
            calls.append('statistics')
            raise RuntimeError('stop before readiness')
        with patch.object(store, '_owner_fd', None), patch.object(store, 'DATA_ROOT', str(self.root)), \
             patch.object(store, 'STORE_BACKEND', 'postgres'), patch.object(store, '_assert_synced_data_root'), \
             patch.object(pgstore, 'connect', return_value=pgstore.connect(self.url)), \
             patch.object(workread, 'bootstrap', build), patch.object(pgstats, 'bootstrap', analyze):
            with self.assertRaisesRegex(RuntimeError, 'stop before readiness'):
                store.claim_data_root()
        self.assertEqual(calls, ['derived', 'statistics'])

    def test_bootstrap_uses_runtime_role_and_refreshes_uninitialized_orgs(self):
        with self.raw.transaction():
            self.raw.execute('SET LOCAL ROLE orgtree_runtime')
            pgstats.bootstrap(self.raw)
        self.assertIsNotNone(self.mark())
        before = self.mark()
        pgstats.bootstrap(self.raw)
        self.assertEqual(self.mark(), before)

    def test_concurrent_initializers_wait_then_skip_completed_analysis(self):
        second = pgstore.connect(self.url)
        result = []
        errors = []
        def run():
            try:
                result.append(pgstats.analyze(second, self.oid))
            except Exception as exc:
                errors.append(exc)
        worker = threading.Thread(target=run)
        try:
            with self.raw.transaction():
                self.assertGreater(pgstats.analyze(self.raw, self.oid), 0)
                worker.start()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    waiting = self.raw.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',
                                               (second.info.backend_pid,)).fetchone()
                    if waiting and waiting[0] == 'Lock': break
                    self.raw.execute('SELECT pg_stat_clear_snapshot()')
                    time.sleep(.01)
                else: self.fail('second initializer never exercised lock wait')
            worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(result, [0])
        finally:
            if worker.is_alive(): second.cancel(); worker.join(5)
            second.close()


if __name__ == '__main__': unittest.main()
