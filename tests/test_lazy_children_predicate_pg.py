"""Actual lazy child predicate, pending edits, ordering and fallback on PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
from unittest.mock import patch

import test_child_candidates_pg as fixture
from orgtree import orgtx, store
from orgtree.orgdb.compat import rows as R

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class LazyPredicate(fixture.ChildCandidates):
    def lookup(self, parent, *, live_only=False, edits=None, load=None):
        class Discard(Exception):
            pass
        try:
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                self.assertIsInstance(nodes, store.LazyNodesMap)
                self.assertFalse(nodes._complete)
                if load:
                    for name in load:
                        nodes[name]
                if edits:
                    edits(nodes)
                with patch.object(R, 'children_ids', wraps=R.children_ids) as selected:
                    result = store.lazy_children_of(tx.org, parent, live_only=live_only)
                self.assertEqual(selected.call_count, 1)
                self.assertEqual(selected.call_args.kwargs.get('live_only', False), live_only)
                self.assertIsNotNone(result)
                self.assertEqual(nodes._child_queries, 1)
                self.assertFalse(nodes._complete)
                held = set(dict.keys(nodes))
                raise Discard()
        except Discard:
            return result, held

    def test_single_parent_live_predicate_keeps_rare_states_without_decoding_archives(self):
        result, held = self.lookup('boss', live_only=True)
        self.assertEqual(result, self.reference(['boss'], True)['boss'])
        self.assertNotIn('archived-child', held)
        self.assertIn('null-state-child', result)
        self.assertIn('exceptional-state-child', result)

    def test_single_parent_all_states_and_default_keep_archived_candidate_order(self):
        result, _ = self.lookup('boss')
        self.assertEqual(result, self.reference(['boss'])['boss'])
        self.assertIn('archived-child', result)

    def test_single_parent_loaded_and_pending_changes_override_stored_predicate(self):
        def edit(nodes):
            nodes['dev']['parent'] = 'destination'
            nodes['unknown-only']['parent'] = 'boss'
            nodes['archived-child']['state'] = 'live'
            nodes['parent-overlap']['state'] = 'archived'
            nodes.pop('ops')
            nodes['new-child'] = fixture.fixture.node('new-child', 'boss')
        result, _ = self.lookup('boss', live_only=True, edits=edit,
                                load=['dev', 'archived-child', 'parent-overlap'])
        self.assertEqual(result, ['first-name-bearer-child', 'second-name-bearer-child',
                                 'null-state-child', 'exceptional-state-child',
                                 'parent-correction', 'archived-child', 'unknown-only',
                                 'new-child'])
        self.assertIn('dev', self.reference(['boss'], True)['boss'])
        self.assertNotIn('new-child', self.reference(['boss'])['boss'])

    def test_single_parent_top_empty_missing_and_tombstone_namesakes_match_decoded_rows(self):
        for parent in (None, '', 'boss', 'no-such-parent'):
            for live_only in (False, True):
                with self.subTest(parent=parent, live_only=live_only):
                    result, _ = self.lookup(parent, live_only=live_only)
                    self.assertEqual(result, self.reference([parent], live_only)[parent])

    def test_single_parent_query_budget_is_unchanged_and_complete_maps_fall_back(self):
        class Discard(Exception):
            pass
        try:
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                with patch.object(R, 'children_ids', wraps=R.children_ids) as selected:
                    for number in range(store.LAZY_CHILD_QUERIES):
                        result = store.lazy_children_of(tx.org, 'boss', live_only=True)
                        self.assertIsNotNone(result)
                        self.assertEqual(nodes._child_queries, number + 1)
                    self.assertIsNone(store.lazy_children_of(tx.org, 'boss', live_only=True))
                    self.assertEqual(selected.call_count, store.LAZY_CHILD_QUERIES)
                    nodes._child_queries = 0
                    nodes.materialize()
                    self.assertIsNone(store.lazy_children_of(tx.org, 'boss', live_only=True))
                    self.assertEqual(selected.call_count, store.LAZY_CHILD_QUERIES)
                    self.assertEqual(nodes._child_queries, 0)
                raise Discard()
        except Discard:
            pass

    def test_single_parent_plain_document_uses_existing_walk(self):
        org = store.Org(fixture.fixture.document(self.slug))
        self.assertIsNone(store.lazy_children_of(org, 'boss', live_only=True))
        self.assertIsNone(store.lazy_children_of(org, 'boss'))


if __name__ == '__main__':
    unittest.main()
