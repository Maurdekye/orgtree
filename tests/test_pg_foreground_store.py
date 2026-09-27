"""Committed foreground discovery, including direct writes and feed lag."""
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from orgtree import foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PG not configured: NOT RUN')
class ForegroundIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss')
        store.save_org(org)
        self.prototype = dict(org.nodes['boss'])

    def add(self, **nodes):
        org = store.load_org(self.slug)
        for nid, fields in nodes.items():
            org.nodes[nid] = {**self.prototype, 'id': nid, 'parent': 'boss',
                              'state': 'archived', 'grant': 0, **fields}
        store.save_org(org)

    def direct(self, nid, **fields):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            value = json.loads(conn.execute('SELECT val FROM nodes WHERE id=?', (nid,)).fetchone()[0])
            value.update(fields)
            conn.execute('UPDATE nodes SET val=? WHERE id=?', (store._dumps(value), nid))
            conn.execute('COMMIT')

    def test_active_graph_excludes_history_but_keeps_archived_connectors(self):
        self.add(hidden={}, bridge={}, child={'state': 'live', 'parent': 'bridge'},
                 lost={'state': 'unrecoverable'})
        graph = fg.read_foreground(self.slug)
        self.assertEqual(set(graph['rows']), {'boss', 'bridge', 'child', 'lost'})
        self.assertEqual(graph['hidden_retired_children']['boss'], 1)
        self.assertEqual(graph['missing_ancestors'], [])
        self.assertEqual(graph['stamp']['node_count'], 5)

    def test_revealed_identity_subtracts_only_its_direct_hidden_root(self):
        self.add(old={}, nested={'parent': 'old'}, other={})
        graph = fg.read_foreground(self.slug, ['old'])
        self.assertEqual(set(graph['rows']), {'boss', 'old'})
        self.assertEqual(graph['hidden_retired_children']['boss'], 1)
        self.assertEqual(graph['hidden_retired_children']['old'], 1)

    def test_live_lineage_predecessor_stays_on_axis_and_archived_one_does_not(self):
        self.add(old={'successor': 'boss'}, revived={'successor': 'boss', 'state': 'live'})
        graph = fg.read_foreground(self.slug)
        self.assertEqual(set(graph['rows']), {'boss', 'revived'})
        self.assertEqual(graph['hidden_retired_children']['boss'], 0)
        lookup = fg.read_exact(self.slug, 'old')
        self.assertEqual(lookup['rows']['old']['meta']['successor'], 'boss')
        self.assertEqual(lookup['missing'], [])

    def test_lineage_count_and_newest_consultable_skip_lost_or_live(self):
        self.add(g1={'generation': 1, 'bearer_state': 'available'},
                 g2={'generation': 2, 'predecessor': 'g1', 'bearer_state': 'lost'},
                 now={'state': 'live', 'generation': 3, 'predecessor': 'g2'})
        row = fg.read_exact(self.slug, 'now')['rows']['now']
        self.assertEqual(row['lineage_count'], 2)
        self.assertEqual(row['consultable_predecessor'], {'id': 'g1', 'generation': 1})
        self.direct('g1', state='live')
        row = fg.read_exact(self.slug, 'now')['rows']['now']
        self.assertEqual(row['lineage_count'], 2)
        self.assertIsNone(row['consultable_predecessor'])

    def test_lifetime_cost_includes_hidden_nodes_and_rollback_is_atomic(self):
        self.add(old={'cost_usd': 12.375, 'cost_usd_unknown': True})
        before = fg.read_foreground(self.slug)
        self.assertEqual(float(before['stamp']['cost']), 12.375)
        self.assertEqual(before['stamp']['cost_unknown'], 1)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            value = {**self.prototype, 'parent': 'boss', 'state': 'live', 'cost_usd': 500}
            conn.execute('UPDATE nodes SET val=? WHERE id=?', (store._dumps(value), 'old'))
            conn.execute('ROLLBACK')
        self.assertEqual(fg.read_foreground(self.slug), before)

    def test_child_pagination_stable_across_status_but_resets_on_retirement(self):
        self.add(z={'ui_order': 0}, a={'ui_order': 2}, m={'ui_order': 1})
        first = fg.read_retired_children(self.slug, 'boss', limit=1)
        self.assertEqual(first['matches'], ['z'])
        catalog = first['stamp']['catalog_revision']
        self.direct('boss', last_status={'status': 'working', 'summary': 'new'})
        second = fg.read_retired_children(self.slug, 'boss', limit=1, cursor=first['next_cursor'])
        self.assertEqual(second['matches'], ['m'])
        self.assertEqual(second['stamp']['catalog_revision'], catalog)
        self.assertGreater(second['stamp']['node_revision'], first['stamp']['node_revision'])
        self.direct('z', state='live')
        with self.assertRaises(fg.CursorReset):
            fg.read_retired_children(self.slug, 'boss', cursor=first['next_cursor'])

    def test_parent_move_delete_and_counts_commit_together(self):
        self.add(old={}, parent={})
        self.direct('old', parent='parent')
        graph = fg.read_foreground(self.slug, ['parent'])
        self.assertEqual(graph['hidden_retired_children']['boss'], 0)
        self.assertEqual(graph['hidden_retired_children']['parent'], 1)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('DELETE FROM nodes WHERE id=?', ('old',))
            conn.execute('COMMIT')
        self.assertEqual(fg.read_exact(self.slug, 'old')['missing'], ['old'])
        self.assertEqual(fg.read_foreground(self.slug, ['parent'])['hidden_retired_children']['parent'], 0)

    def test_search_short_substring_filters_false_positive_grams_and_returns_ancestors(self):
        self.add(**{'abc-one': {}, 'zabc-two': {'parent': 'abc-one'},
                    'abca': {}, 'bcab': {}, 'hidden-bearer': {'successor': 'boss'}})
        first = fg.search(self.slug, 'BC', limit=2)
        self.assertEqual(first['matches'], ['abc-one', 'abca'])
        second = fg.search(self.slug, 'bc', limit=2, cursor=first['next_cursor'])
        self.assertEqual(second['matches'], ['bcab', 'zabc-two'])
        self.assertIn('abc-one', second['rows'])
        # Both repeated-query grams exist in abca/bcab, but the whole substring doesn't.
        self.assertEqual(fg.search(self.slug, 'abcab')['matches'], [])
        self.assertEqual(fg.search(self.slug, 'hidden')['matches'], [])

    def test_discovery_loads_metadata_only_and_is_bounded(self):
        self.add(leaf={'state': 'live', 'session_id': 'session-1'}, old={})
        with patch.object(fg, '_rows', side_effect=AssertionError('node body loaded')):
            page = fg.discover(self.slug, limit=1)
            self.assertEqual([n['id'] for n in page['nodes']], ['boss'])
            page = fg.discover(self.slug, limit=1, cursor=page['next_cursor'])
            self.assertEqual(page['nodes'][0]['id'], 'leaf')
            self.assertEqual(page['nodes'][0]['session_id'], 'session-1')
            self.assertIsNone(page['next_cursor'])

    def test_cursor_cannot_be_reused_for_different_parent_or_search(self):
        self.add(a={}, b={})
        page = fg.read_retired_children(self.slug, 'boss', limit=1)
        with self.assertRaises(ValueError):
            fg.read_retired_children(self.slug, 'a', cursor=page['next_cursor'])
        with self.assertRaises(ValueError):
            fg.search(self.slug, 'a', cursor=page['next_cursor'])
        with self.assertRaises(ValueError):
            fg.read_retired_children(self.slug, 'boss', limit=0)

    def test_one_snapshot_never_mixes_external_commit_into_selected_graph(self):
        original = fg._rows
        changed = []
        def interleave(raw, ids):
            if not changed:
                changed.append(True)
                self.direct('boss', last_status={'summary': 'committed later'})
            return original(raw, ids)
        with patch.object(fg, '_rows', side_effect=interleave):
            first = fg.read_foreground(self.slug)
        self.assertTrue(changed)
        self.assertNotEqual(first['rows']['boss']['node'].get('last_status'), {'summary': 'committed later'})
        second = fg.read_foreground(self.slug)
        self.assertEqual(second['rows']['boss']['node']['last_status']['summary'], 'committed later')
        self.assertGreater(second['stamp']['node_revision'], first['stamp']['node_revision'])

    def test_history_growth_does_not_materialize_additional_node_bodies(self):
        self.add(**{f'old-{i}': {'charter': 'unpainted history ' * 1000} for i in range(10)})
        small = fg.read_foreground(self.slug)
        self.add(**{f'old-{i}': {'charter': 'unpainted history ' * 1000} for i in range(10, 100)})
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org read')):
            large = fg.read_foreground(self.slug)
        self.assertEqual(small['rows'], large['rows'])
        self.assertEqual(len(large['rows']), 1)
        self.assertEqual(small['hidden_retired_children']['boss'], 10)
        self.assertEqual(large['hidden_retired_children']['boss'], 100)


if __name__ == '__main__':
    unittest.main()
