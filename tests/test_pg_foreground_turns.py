"""The foreground store reads only the tree's newest turns, and nothing else changes."""
import copy
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
from engine.launch import TokenGate
from orgtree import api, foreground_cache, foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


def full_rows(raw, ids):
    """The pre-trim reader: the whole stored node body."""
    if not ids:
        return {}
    rows = raw.execute(
        'SELECT i.id,i.ord,i.meta,i.lineage_count,i.consult_id,c.meta,n.val '
        'FROM node_index i JOIN nodes n ON n.id=i.id '
        'LEFT JOIN node_index c ON c.id=i.consult_id '
        'WHERE i.id=ANY(%s) ORDER BY i.ord,i.id', (ids,)).fetchall()
    return {nid: {'node': json.loads(value), 'meta': meta, 'ordinal': ordinal,
                  'lineage_count': count,
                  'consultable_predecessor': ({'id': consult, 'generation': cm['generation']}
                                             if consult is not None else None)}
            for nid, ordinal, meta, count, consult, cm, value in rows}


def turns(count, **extra):
    return [{'at': f'2026-09-28T00:{i // 60:02d}:{i % 60:02d}Z', 'cost': round(i * 0.0137, 4),
             'ran_as': 'claude-4', 'n': i, **extra} for i in range(count)]


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ForegroundTurnsPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-turns-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Visible charter é\U0001f600')
        for nid in ('busy', 'fresh', 'odd'):
            org.hire(ledger.USER, 'boss', 'luna', 0, nid)
        org.nodes['boss']['turns'] = turns(40, note='x' * 200)
        org.nodes['busy']['turns'] = turns(300)
        org.nodes['fresh']['turns'] = turns(3)
        # Numbers jsonb cannot round-trip exactly; this node must be served as stored.
        org.nodes['odd']['turns'] = turns(20, big=1e16, neg=-0.0, tiny=1e-7)
        org.work_create(ledger.USER, 'Visible work', objective='Keep counts exact.', owner='boss')
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        saved = store.load_org(self.slug)
        self.stored = {nid: copy.deepcopy(dict(saved.nodes[nid])) for nid in ('boss', 'busy', 'fresh', 'odd')}
        self.assertGreater(len(self.stored['busy']['turns']), ledger.TREE_TURNS)
        self.client = TestClient(TokenGate(api.app, 'foreground-turns'))
        self.headers = {'X-Orgtree-Desktop-Token': 'foreground-turns', 'Accept-Encoding': 'identity'}

    def test_rows_carry_only_the_newest_tree_turns_and_every_other_field_unchanged(self):
        graph = fg.read_foreground(self.slug)
        for nid in ('boss', 'busy', 'fresh'):
            node, stored = graph['rows'][nid]['node'], self.stored[nid]
            self.assertEqual(node['turns'], stored['turns'][-ledger.TREE_TURNS:], nid)
            self.assertEqual({k: v for k, v in node.items() if k != 'turns'},
                             {k: v for k, v in stored.items() if k != 'turns'}, nid)
        self.assertEqual(len(graph['rows']['busy']['node']['turns']), ledger.TREE_TURNS)
        self.assertEqual(len(graph['rows']['fresh']['node']['turns']), 3)

    def test_a_node_jsonb_cannot_round_trip_is_served_exactly_as_stored(self):
        node = fg.read_foreground(self.slug)['rows']['odd']['node']
        self.assertEqual(node['turns'], self.stored['odd']['turns'])
        self.assertIsInstance(node['turns'][0]['big'], float)
        self.assertEqual(str(node['turns'][0]['neg']), '-0.0')
        self.assertEqual(str(node['turns'][0]['tiny']), '1e-07')

    def test_foreground_payload_is_byte_identical_to_the_whole_body_read(self):
        url = f'/api/orgs/{self.slug}/foreground-tree'
        with patch.object(api, '_tree_runtime_stamp', return_value=('fixed',)):
            foreground_cache._cache.clear()
            with patch.object(fg, '_rows', full_rows):
                before = self.client.get(url, headers=self.headers)
            foreground_cache._cache.clear()
            after = self.client.get(url, headers=self.headers)
        self.assertEqual(before.status_code, 200, before.text)
        self.assertEqual(after.status_code, 200, after.text)
        self.assertEqual(set(after.json()['nodes']), {'boss', 'busy', 'fresh', 'odd'})
        self.assertEqual(after.json()['nodes']['busy']['turns'], self.stored['busy']['turns'][-8:])
        self.assertEqual(before.content, after.content)
        self.assertEqual(before.headers['etag'], after.headers['etag'])

    def direct(self, sql, params=()):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.raw.execute(sql, params)
            conn.execute('COMMIT')

    def test_a_direct_sql_write_keeps_the_trimmed_copy_current(self):
        # The copy is kept by the node trigger, so a writer that bypasses the
        # Python store is covered too, in the same commit.
        value = copy.deepcopy(self.stored['busy'])
        value['turns'].append({'at': '2026-09-28T09:00:00Z', 'cost': 0.5, 'n': 'direct'})
        self.direct('UPDATE nodes SET val=%s WHERE id=%s', (store._dumps(value), 'busy'))
        node = fg.read_foreground(self.slug)['rows']['busy']['node']
        self.assertEqual(node['turns'], value['turns'][-ledger.TREE_TURNS:])
        self.assertEqual(node['turns'][-1]['n'], 'direct')

    def test_install_rederives_a_stale_copy(self):
        self.direct("UPDATE node_tree_val SET val='{\"turns\":[]}' WHERE id='busy'")
        self.assertEqual(fg.read_foreground(self.slug)['rows']['busy']['node'], {'turns': []})
        with store._POOL.acquire(self.slug) as conn:
            org_id = conn.org_id
        self.direct('SELECT public.orgtree_install_tree_val(%s)', (org_id,))
        node = fg.read_foreground(self.slug)['rows']['busy']['node']
        self.assertEqual(node['turns'], self.stored['busy']['turns'][-ledger.TREE_TURNS:])
        self.assertEqual({k: v for k, v in node.items() if k != 'turns'},
                         {k: v for k, v in self.stored['busy'].items() if k != 'turns'})

    def test_status_fast_path_still_applies_after_the_trim(self):
        url = f'/api/orgs/{self.slug}/foreground-tree'
        with patch.object(api, '_tree_runtime_stamp', return_value=('fixed',)):
            foreground_cache._cache.clear()
            first = self.client.get(url, headers=self.headers)
            org = store.load_org(self.slug)
            org.nodes['busy']['last_status'] = {'status': 'working', 'summary': 'trimmed'}
            store.save_org(org)
            with patch.object(fg, 'select_foreground', side_effect=AssertionError('full projection rebuilt')):
                changed = self.client.get(url, headers={**self.headers, 'If-None-Match': first.headers['etag']})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()['kind'], 'delta')
        self.assertEqual(changed.json()['nodes']['busy']['set']['last_status']['summary'], 'trimmed')


if __name__ == '__main__':
    unittest.main()
