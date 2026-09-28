"""Actual PostgreSQL assignment, append, migration and rollback controls."""
import json
import os
import threading
import unittest
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_mail_bounds_t{os.getpid()}'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, mailtx, orgtx, pgstore, store  # noqa: E402


def tearDownModule():
    if ADMIN:
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class MailArchiveBounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    def setUp(self):
        org = store.create_org('mail-bounds-' + uuid.uuid4().hex[:8])
        org.hire(ledger.USER, None, 'luna', 0, 'worker')
        self.slug = org.d['slug']
        for i in range(1, 10):
            org.deposit_mail('worker', {'id': f'm{i}', 'from': 'sender', 'at': f'{i:02}', 'body': 'old'})
        org.d['mail']['worker'] = []
        org.node('worker')['mail_seq'] = 0  # deliberately behind its archive
        store.save_org(org)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))

    def tx(self):
        return orgtx.org_tx(self.slug, **mailtx.send_rows('worker'))

    def query(self, sql, args=()):
        with store._POOL.acquire(self.slug) as conn:
            return conn.execute(sql, args).fetchall()

    def bound(self):
        return self.query("SELECT nrows,assigned_max,unknown_rows FROM mail_archive_bounds WHERE owner='worker'")[0]

    def send(self, body='new'):
        with self.tx() as tx:
            return dict(tx.org.deposit_mail('worker', {'id': uuid.uuid4().hex, 'body': body}))

    def test_ordinary_send_never_materializes_archive_and_advances_both_floors(self):
        original = store.SectionMap._load_owner
        def guarded(log, owner):
            if log._sect == 'mail_log':
                raise AssertionError('send loaded retained mail')
            return original(log, owner)
        with patch.object(store.SectionMap, '_load_owner', guarded):
            self.assertEqual(self.send()['recv_seq'], 10)
            self.assertEqual(self.send()['recv_seq'], 11)
        self.assertEqual(tuple(map(int, self.bound())), (11, 11, 0))

    def test_read_after_buffered_append_materializes_once_without_double_append(self):
        with self.tx() as tx:
            tx.org.deposit_mail('worker', {'id': 'a'})
            tx.org.deposit_mail('worker', {'id': 'b'})
            rows = tx.d['mail_log']['worker']
            self.assertEqual([r['recv_seq'] for r in rows][-2:], [10, 11])
        self.assertEqual(tuple(map(int, self.bound())), (11, 11, 0))
        self.assertEqual(len(self.query("SELECT seq FROM log_d WHERE sect='mail_log' AND owner='worker'")), 11)

    def test_rollback_leaves_source_summary_and_counter_unchanged(self):
        with self.assertRaisesRegex(RuntimeError, 'abort'):
            with self.tx() as tx:
                tx.org.deposit_mail('worker', {'id': 'never'})
                raise RuntimeError('abort')
        self.assertEqual(tuple(map(int, self.bound())), (9, 9, 0))
        self.assertEqual(self.send()['recv_seq'], 10)

    def test_unvalidated_summary_falls_back_to_observed_history(self):
        for invalid in ('missing', 'future', 'unknown'):
            with self.subTest(invalid=invalid):
                with store._POOL.acquire(self.slug) as conn:
                    conn.execute('BEGIN')
                    if invalid == 'missing':
                        conn.execute("DELETE FROM mail_archive_bounds WHERE owner='worker'")
                    else:
                        conn.execute("UPDATE mail_archive_bounds SET " +
                            ('format=99' if invalid == 'future' else 'unknown_rows=1') + " WHERE owner='worker'")
                    conn.execute('COMMIT')
                seen = []
                original = store.SectionMap._load_owner
                def measured(log, owner):
                    seen.append((log._sect, owner))
                    return original(log, owner)
                with patch.object(store.SectionMap, '_load_owner', measured):
                    self.send(invalid)
                self.assertIn(('mail_log', 'worker'), seen)
                self.reconcile()

    def reconcile(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('SELECT public.orgtree_install_mail_bounds(?)', (conn.org_id,))
            conn.execute('COMMIT')

    def test_migration_reconciles_counts_and_restarts_without_changing_source(self):
        before = self.query("SELECT seq,owner,val FROM log_d ORDER BY seq")
        self.reconcile()
        self.reconcile()
        self.assertEqual(self.query("SELECT seq,owner,val FROM log_d ORDER BY seq"), before)
        self.assertEqual(tuple(map(int, self.bound())), (9, 9, 0))
        self.assertEqual(self.send()['recv_seq'], 10)

    def test_changed_or_deleted_maximum_is_reflected_without_counter_rewind(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            seq, raw = conn.execute("SELECT seq,val FROM log_d WHERE sect='mail_log' AND owner='worker' ORDER BY seq LIMIT 1").fetchone()
            row = json.loads(raw); row['recv_seq'] = 99
            conn.execute('UPDATE log_d SET val=? WHERE seq=?', (json.dumps(row), seq))
            conn.execute('COMMIT')
        self.assertEqual(self.send()['recv_seq'], 100)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("DELETE FROM log_d WHERE sect='mail_log' AND owner='worker'")
            conn.execute('COMMIT')
        self.assertEqual(tuple(map(int, self.bound())), (0, 0, 0))
        self.assertEqual(self.send()['recv_seq'], 101)

    def test_archive_change_after_read_refuses_stale_buffer_atomically(self):
        with self.assertRaises(store.StaleWrite):
            with self.tx() as tx:
                tx.org.deposit_mail('worker', {'id': 'stale'})
                conn = store._orgtx_local.pinned[self.slug]
                conn.execute("UPDATE mail_archive_bounds SET version=version+1 WHERE owner='worker'")
        self.assertEqual(tuple(map(int, self.bound())), (9, 9, 0))
        self.assertEqual(self.send()['recv_seq'], 10)

    def test_concurrent_senders_keep_unique_monotone_receive_order(self):
        gate = threading.Barrier(3)
        result, errors = [], []
        def sender():
            try:
                gate.wait(3)
                result.append(self.send()['recv_seq'])
            except BaseException as exc:
                errors.append(exc)
        threads = [threading.Thread(target=sender) for _ in range(2)]
        for thread in threads: thread.start()
        gate.wait(3)
        for thread in threads: thread.join(10)
        self.assertFalse(any(t.is_alive() for t in threads))
        self.assertEqual(errors, [])
        self.assertEqual(sorted(result), [10, 11])
        self.assertEqual(tuple(map(int, self.bound())), (11, 11, 0))

    def test_truncate_and_transactional_migration_rollback_reconcile_counts(self):
        before = self.bound()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('SELECT public.orgtree_install_mail_bounds(?)', (conn.org_id,))
            conn.execute('TRUNCATE log_d')
            self.assertEqual(tuple(map(int, conn.execute("SELECT nrows,assigned_max,unknown_rows "
                "FROM mail_archive_bounds WHERE owner='worker'").fetchone())), (0, 0, 0))
            conn.execute('ROLLBACK')
        self.assertEqual(self.bound(), before)
        self.assertEqual(self.send()['recv_seq'], 10)

    def test_retention_and_superseding_keep_full_edit_path(self):
        with self.tx() as tx:
            tx.org.deposit_mail('worker', {'id': 'trim'}, archive_keep=2)
        self.assertEqual(tuple(map(int, self.bound())), (2, 10, 0))
        with self.tx() as tx:
            tx.org.deposit_mail('worker', {'id': 'replace'}, supersede=lambda row: row.get('id') == 'trim')
        self.assertEqual(tuple(map(int, self.bound())), (3, 11, 0))
        org = store.load_org(self.slug)
        self.assertEqual([r['id'] for r in org.d['mail']['worker']], ['replace'])

    def test_unsupported_ordinal_invalidates_fast_summary_without_rewriting_evidence(self):
        raw = json.dumps({'id': 'unsupported', 'recv_seq': True})
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("INSERT INTO log_d(sect,owner,val) VALUES('mail_log','worker',?)", (raw,))
            conn.execute('COMMIT')
        self.assertEqual(tuple(map(int, self.bound())), (10, 9, 1))
        self.assertEqual(self.send()['recv_seq'], 10)
        self.assertIn((raw,), self.query("SELECT val FROM log_d WHERE sect='mail_log' AND owner='worker'"))

    def test_sql_creator_and_copy_import_keep_bounds_in_same_transaction(self):
        with psycopg.connect(os.environ['ORGTREE_PG_URL']) as conn:
            org_id = conn.execute("INSERT INTO public.orgs(slug) VALUES('copy-fixture') RETURNING org_id").fetchone()[0]
            schema = conn.execute('SELECT public.orgtree_create_org_schema(%s)', (org_id,)).fetchone()[0]
            with conn.cursor().copy(f'COPY {schema}.log_d(sect,owner,val) FROM STDIN') as stream:
                for seq in (4, 9, 9):
                    stream.write_row(('mail_log', 'restored', json.dumps({'id': str(seq), 'recv_seq': seq})))
            counts = conn.execute(f'SELECT nrows,assigned_max FROM {schema}.mail_archive_bounds '
                                  "WHERE owner='restored'").fetchone()
            self.assertEqual(tuple(map(int, counts)), (3, 9))
            conn.rollback()

    def test_skipped_insert_and_upsert_do_not_count_unwritten_rows(self):
        before = self.bound()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            seq, raw = conn.execute("SELECT seq,val FROM log_d WHERE sect='mail_log' AND owner='worker' LIMIT 1").fetchone()
            conn.execute("INSERT INTO log_d(seq,sect,owner,val) VALUES(?,'mail_log','worker',?) "
                         "ON CONFLICT(seq) DO NOTHING", (seq, raw))
            conn.execute('COMMIT')
        self.assertEqual(self.bound(), before)
        row = json.loads(raw); row['recv_seq'] = 50
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("INSERT INTO log_d(seq,sect,owner,val) VALUES(?,'mail_log','worker',?) "
                         "ON CONFLICT(seq) DO UPDATE SET val=excluded.val", (seq, json.dumps(row)))
            conn.execute('COMMIT')
        self.assertEqual(tuple(map(int, self.bound())), (9, 50, 0))

    def test_runtime_role_can_send_using_existing_archive_bounds(self):
        with self.tx() as tx:
            conn = store._orgtx_local.pinned[self.slug]
            conn.execute('SET LOCAL ROLE orgtree_runtime')
            self.assertEqual(tx.org.deposit_mail('worker', {'id': 'runtime'})['recv_seq'], 10)
        self.assertEqual(tuple(map(int, self.bound())), (10, 10, 0))

    def test_runtime_role_can_create_schema_and_write_its_bound(self):
        with psycopg.connect(os.environ['ORGTREE_PG_URL']) as conn:
            conn.execute('SET LOCAL ROLE orgtree_runtime')
            org_id = conn.execute("INSERT INTO public.orgs(slug) VALUES('runtime-fixture') RETURNING org_id").fetchone()[0]
            schema = conn.execute('SELECT public.orgtree_create_org_schema(%s)', (org_id,)).fetchone()[0]
            conn.execute(f"INSERT INTO {schema}.log_d(sect,owner,val) VALUES('mail_log','runtime',%s)",
                         (json.dumps({'id': 'a', 'recv_seq': 3}),))
            self.assertEqual(tuple(map(int, conn.execute(f'SELECT nrows,assigned_max FROM {schema}.mail_archive_bounds '
                                                        "WHERE owner='runtime'").fetchone())), (1, 3))
            conn.rollback()

    def test_direct_source_writer_and_buffer_use_same_lock_order(self):
        held, release_source = threading.Event(), threading.Event()
        errors = []
        writer_id = threading.get_ident()
        original = pgstore.PgConn.execute

        def source_writer():
            try:
                with store._POOL.acquire(self.slug) as conn:
                    conn.execute('BEGIN')
                    conn.execute("SET LOCAL lock_timeout='2s'")
                    conn.execute("SELECT pg_advisory_xact_lock(hashtext(?),hashtext(?))",
                                 (f'org_{conn.org_id}', 'mail-bound:worker'))
                    held.set()
                    if not release_source.wait(5): raise AssertionError('buffer did not attempt lock')
                    conn.execute("INSERT INTO log_d(sect,owner,val) VALUES('mail_log','worker',?)",
                                 (json.dumps({'id': 'direct', 'recv_seq': 77}),))
                    conn.execute('COMMIT')
            except BaseException as exc:
                errors.append(exc)

        def observed(conn, sql, *args, **kwargs):
            if threading.get_ident() == writer_id:
                if 'pg_advisory_xact_lock' in sql:
                    release_source.set()
                elif 'FROM mail_archive_bounds' in sql and 'FOR UPDATE' in sql:
                    result = original(conn, sql, *args, **kwargs)
                    release_source.set()  # negative control: row held first
                    return result
            return original(conn, sql, *args, **kwargs)

        thread = threading.Thread(target=source_writer)
        try:
            with self.assertRaises(store.StaleWrite):
                with self.tx() as tx:
                    tx.org.deposit_mail('worker', {'id': 'buffered'})
                    store._orgtx_local.pinned[self.slug].execute("SET LOCAL lock_timeout='2s'")
                    thread.start()
                    self.assertTrue(held.wait(5))
                    with patch.object(pgstore.PgConn, 'execute', observed):
                        # Saving explicitly exercises the same writer before
                        # context-manager commit; refusal rolls back everything.
                        store.save_org(tx.org)
        finally:
            release_source.set()
            if thread.ident is not None: thread.join(6)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(tuple(map(int, self.bound())), (10, 77, 0))


if __name__ == '__main__':
    unittest.main()
