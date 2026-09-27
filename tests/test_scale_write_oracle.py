"""Real disposable PG controls for the private scale comparison's write observer."""
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'scale'))
from write_oracle import WriteOracle

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')


@unittest.skipUnless(ADMIN, 'disposable PG admin URL required')
class WriteOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = 'scale_oracle_t' + str(os.getpid())
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.db)))
        cls.url = make_conninfo(ADMIN, dbname=cls.db)
        cls.writer = psycopg.connect(cls.url, autocommit=True)
        cls.writer.execute('CREATE TABLE public.orgs (org_id int, slug text)')
        cls.writer.execute("INSERT INTO public.orgs VALUES (1, 'test')")
        cls.writer.execute('CREATE SCHEMA org_1')
        for table in ('nodes', 'log_d', 'log_l'):
            cls.writer.execute(sql.SQL('CREATE TABLE org_1.{} (id text, val text)').format(sql.Identifier(table)))
        cls.writer.execute('CREATE TABLE org_1.doc (key text, val text)')
        cls.writer.execute("INSERT INTO org_1.doc VALUES ('work_items', '[]')")
        cls.writer.execute("INSERT INTO org_1.nodes VALUES ('worker', '{}')")

    @classmethod
    def tearDownClass(cls):
        cls.writer.close()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.db)))

    def setUp(self):
        self.writer.execute('DELETE FROM org_1.doc')
        self.writer.execute("INSERT INTO org_1.doc VALUES ('work_items', '[]')")
        self.oracle = WriteOracle({'pg_url': self.url, 'org': 'test'})
        self.addCleanup(self.oracle.close)
        self.store_status('initial')

    def store_status(self, summary):
        self.writer.execute('UPDATE org_1.nodes SET val=%s WHERE id=%s',
                            (json.dumps({'last_status': {'status': 'working', 'summary': summary}}), 'worker'))

    def check(self, summary):
        return self.oracle.check_overwrite('worker', 'orgtree_status',
                                           {'status': 'working', 'summary': summary})

    def test_concurrent_checks_share_one_reserved_socket(self):
        # Reserve once, then make new connections impossible while checks run.
        barrier = threading.Barrier(8)
        def check(_):
            barrier.wait(timeout=10)
            return self.check('initial')
        with patch('write_oracle.psycopg.connect', side_effect=AssertionError('unexpected new oracle connection')):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(check, range(8)))
        self.assertEqual(len(results), 8)
        self.assertTrue(all(row['passed'] for row in results))
        count, = self.writer.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                                     "AND application_name='scale-write-oracle'").fetchone()
        self.assertEqual(count, 1)
        self.assertEqual(self.oracle._conn.info.transaction_status, psycopg.pq.TransactionStatus.IDLE)

    def test_checks_see_later_commits_and_reject_wrong_value(self):
        self.assertTrue(self.check('initial')['passed'])
        self.store_status('later committed value')
        self.assertTrue(self.check('later committed value')['passed'])
        self.assertFalse(self.check('initial')['passed'])
        self.assertTrue(self.oracle.snapshot()['passed'])
        self.store_status('after the snapshot')
        self.assertTrue(self.check('after the snapshot')['passed'])
        with self.oracle.connection() as conn:
            self.assertEqual(conn.execute('SHOW transaction_isolation').fetchone()[0], 'read committed')
            self.assertEqual(conn.execute('SHOW transaction_read_only').fetchone()[0], 'on')

    def test_failed_check_rolls_back_before_next_committed_read(self):
        with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):
            with self.oracle.connection() as conn:
                conn.execute("UPDATE org_1.nodes SET val='{}'")
        self.assertEqual(self.oracle._conn.info.transaction_status, psycopg.pq.TransactionStatus.IDLE)
        self.store_status('after failed check')
        self.assertTrue(self.check('after failed check')['passed'])

    def test_close_releases_capacity_and_never_reconnects(self):
        self.oracle.close()
        self.assertTrue(self.oracle._conn.closed)
        with patch('write_oracle.psycopg.connect', side_effect=AssertionError('must not reconnect')):
            with self.assertRaisesRegex(RuntimeError, 'reserved connection is closed'):
                self.check('initial')

    def store_item(self, item):
        self.writer.execute('DELETE FROM org_1.doc')
        self.writer.execute('INSERT INTO org_1.doc VALUES (%s,%s)', ('work_items', json.dumps(
            {'format': 'orgtree.work-items/v1', 'ids': [item['slug']]})))
        self.writer.execute('INSERT INTO org_1.doc VALUES (%s,%s)',
                            ('work_items\x1f' + item['slug'], json.dumps(item)))

    def test_row_layout_checks_overwrite_and_append_values(self):
        item = {'slug': 'row', 'title': 'created', 'objective': 'why', 'done_so_far': ['done'],
                'evidence': [{'ref': 'proof', 'note': 'stored'}]}
        self.store_item(item)
        check = lambda text: self.oracle.check_overwrite('worker', 'orgtree_work',
                            {'action': 'update', 'slug': 'row', 'done_so_far': [text]})
        self.assertTrue(check('done')['passed'])
        self.assertFalse(check('wrong')['passed'])
        receipts = [dict(request_id=1, tool='orgtree_work', args=dict(action='create', title='created',
                      objective='why'), response={'created': 'row'}),
                    dict(request_id=2, tool='orgtree_work', args=dict(action='evidence', slug='row',
                      ref='proof', note='stored'), response={'ok': True})]
        self.assertEqual(len(self.oracle.snapshot(receipts)['append_checks']), 2)
        self.assertTrue(self.oracle.snapshot(receipts)['passed'])
        receipts[1]['args']['note'] = 'wrong'
        self.assertFalse(self.oracle.snapshot(receipts)['passed'])

    def test_missing_committed_item_refuses_verdict(self):
        self.store_item({'slug': 'row'})
        self.writer.execute('DELETE FROM org_1.doc WHERE key=%s', ('work_items\x1frow',))
        with self.assertRaisesRegex(RuntimeError, 'missing or inconsistent'):
            self.oracle.snapshot()


if __name__ == '__main__':
    unittest.main()
