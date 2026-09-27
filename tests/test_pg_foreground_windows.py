"""Visible header/card windows stay exact without reading closed history."""
import copy
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from orgtree import foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PG not configured: NOT RUN')
class ForegroundWindows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('window-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss')
        org.hire(ledger.USER, 'boss', 'luna', 0, 'leaf')
        store.save_org(org)

    def windows(self, ids=('boss', 'leaf'), header=True):
        with fg._snapshot(self.slug) as (raw, stamp):
            return fg.read_card_windows(raw, list(ids), header=header)

    def inbox(self):
        with fg._snapshot(self.slug) as (raw, stamp):
            return fg.read_org_inbox_window(raw)

    def test_ask_batch_linger_and_header_match_shared_ledger_with_large_history(self):
        org = store.load_org(self.slug)
        stamp = ledger.now()
        org.d['asks'] = [{'id': str(i), 'node': 'leaf', 'status': 'answered',
                         'at': '2000-01-01T00:00:00Z', 'resolved_at': stamp,
                         'question': 'history', 'questions': []} for i in range(100)]
        org.d['asks'].append({'id': 'pending', 'node': 'boss', 'status': 'open',
                             'at': stamp, 'rev': 4,
                             'questions': [{'id': 'tab', 'question': 'Visible?'}]})
        org.d['credit_requests'] = [{'id': 'credit', 'node': 'boss', 'status': 'pending',
                                    'at': stamp, 'old': 100, 'new': 200, 'reason': 'more'}]
        # A newer withdrawn credit must not hide the resolved question on leaf.
        org.d['credit_requests'].append({'id': 'gone', 'node': 'leaf', 'status': 'withdrawn',
                                        'at': '2099-01-01T00:00:00Z'})
        store.save_org(org)
        expected = store.load_org(self.slug)
        result = self.windows()
        projected = ledger.Org(copy.deepcopy(expected.d))
        for section, rows in result['asks'].items():
            projected.d[section] = rows
        with patch.object(ledger.Org, '_boot_at', return_value=''):
            for nid in ('boss', 'leaf'):
                self.assertEqual(projected.node_ask(nid), expected.node_ask(nid))
        self.assertEqual(projected.tree()['asks'], expected.tree()['asks'])
        self.assertEqual(projected.tree()['asks_open'], expected.tree()['asks_open'])
        self.assertLessEqual(sum(map(len, result['asks'].values())), 12)

    def test_document_counts_and_metadata_tails_follow_replace_move_and_delete(self):
        org = store.load_org(self.slug)
        org.d['documents'] = [{'id': str(i), 'node': 'boss', 'title': f'Title {i}',
                               'at': str(i), 'body': 'not a list field' * 1000}
                              for i in range(25)]
        store.save_org(org)
        result = self.windows()
        self.assertEqual(result['document_counts'], {'boss': 25, 'leaf': 0})
        self.assertEqual([d['id'] for d in result['documents']['boss']], [str(i) for i in range(15, 25)])
        self.assertTrue(all(set(d) == {'id', 'title', 'at', 'format'}
                            for d in result['documents']['boss']))
        org = store.load_org(self.slug)
        org.d['documents'][24]['node'] = 'leaf'
        org.d['documents'][24]['title'] = 'moved'
        del org.d['documents'][0]
        store.save_org(org)
        result = self.windows()
        self.assertEqual(result['document_counts'], {'boss': 23, 'leaf': 1})
        self.assertEqual(result['documents']['leaf'][0]['title'], 'moved')
        self.assertEqual([d['id'] for d in result['documents']['boss']], [str(i) for i in range(14, 24)])

    def test_org_inbox_preview_ack_and_sequence_gaps_use_count_not_max(self):
        org = store.load_org(self.slug)
        org.d['org_inbox'] = [{'id': str(i), 'body': str(i)} for i in range(40)]
        org.d['org_inbox_read'] = 35
        store.save_org(org)
        expected = {'total': 40, 'unread': 5, 'entries': list(org.d['org_inbox'])[-3:]}
        self.assertEqual(self.inbox(), expected)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("DELETE FROM log_l WHERE sect='org_inbox' AND seq=(SELECT MIN(seq) FROM log_l WHERE sect='org_inbox')")
            conn.execute('COMMIT')
        expected.update(total=39, unread=4)
        self.assertEqual(self.inbox(), expected)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("DELETE FROM log_l WHERE sect='org_inbox'")
            conn.execute('ROLLBACK')
        self.assertEqual(self.inbox(), expected)

    def test_pre_rowed_blob_shadows_row_history_then_delete_reveals_it(self):
        org = store.load_org(self.slug)
        org.d['org_inbox'] = [{'id': 'row', 'body': 'retained'}]
        org.d['documents'] = [{'id': 'row', 'node': 'boss', 'title': 'row', 'at': '0'}]
        store.save_org(org)
        docs = [{'id': f'blob-{i}', 'node': 'leaf', 'title': 'blob', 'at': str(i)} for i in range(15)]
        mail = [{'id': f'blob-{i}'} for i in range(15)]
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            for key, value in [('documents', docs), ('org_inbox', mail)]:
                conn.execute('INSERT INTO doc(key,val) VALUES(?,?)', (key, store._dumps(value)))
            conn.execute('COMMIT')
        result = self.windows()
        self.assertEqual(result['document_counts'], {'boss': 0, 'leaf': 15})
        self.assertEqual([d['id'] for d in result['documents']['leaf']], [d['id'] for d in docs[-10:]])
        self.assertEqual(self.inbox(), {'total': 15, 'unread': 15, 'entries': mail[-3:]})
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("DELETE FROM doc WHERE key IN ('documents','org_inbox')")
            conn.execute('COMMIT')
        self.assertEqual(self.windows()['document_counts'], {'boss': 1, 'leaf': 0})
        self.assertEqual(self.inbox()['total'], 1)

    def test_header_windows_keep_one_snapshot_across_external_commit(self):
        org = store.load_org(self.slug)
        org.d['org_inbox'] = [{'id': 'before'}]
        store.save_org(org)
        with fg._snapshot(self.slug) as (raw, stamp):
            first = fg.read_org_inbox_window(raw)
            org.d['org_inbox'].append({'id': 'after'})
            store.save_org(org)
            second = fg.read_org_inbox_window(raw)
            self.assertEqual(first, second)
        self.assertEqual(self.inbox()['total'], 2)
        self.assertEqual(self.inbox()['entries'][-1]['id'], 'after')


if __name__ == '__main__':
    unittest.main()
