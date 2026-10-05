"""Actual native decisions retain decoded parity for exceptional parent graphs."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from test_native_move_endpoints_pg import NativeMoveEndpoints, REQUEST
from orgtree import api, ledger, orgtx, store
from orgtree.orgdb import graph, native_move


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class GraphDecisionGate(unittest.TestCase):
    setUp = NativeMoveEndpoints.setUp
    values = NativeMoveEndpoints.values

    def alias(self, parent):
        with store._POOL.acquire(self.slug) as c:
            with c.raw.transaction():
                identity = c.raw.execute('INSERT INTO orgtree.agents(name,tombstone) '
                    'VALUES(%s,true) RETURNING id', (parent,)).fetchone()[0]
                c.raw.execute("UPDATE orgtree.agents SET parent_id=%s WHERE name='leaf' "
                              'AND NOT tombstone', (identity,))

    def clear_alias(self, parent):
        with store._POOL.acquire(self.slug) as c:
            with c.raw.transaction():
                c.raw.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents "
                    "WHERE name=%s AND NOT tombstone) WHERE name='leaf' AND NOT tombstone", (parent,))
                c.raw.execute('DELETE FROM orgtree.agents WHERE name=%s AND tombstone', (parent,))

    def caps(self, **values):
        org = store.load_org(self.slug)
        org.d.update(values)
        store.save_org(org)

    def move(self):
        return api.org_op(self.slug, api.Op(op='move', actor=ledger.USER,
                                            node='a', new_parent='b'), REQUEST)

    def refused(self, needle):
        from fastapi import HTTPException
        try:
            result = self.move()
        except (ledger.LedgerError, HTTPException) as exc:
            self.assertIn(needle, str(getattr(exc, 'detail', exc)))
            return
        self.assertIn(needle, str(result.get('error', '')),
                      'native endpoint unexpectedly accepted the move')

    def legacy(self):
        return ledger.Org(fixture.document(self.slug))

    def test_alias_child_cap_matches_decoded_oracle_and_removed_alias_uses_stats(self):
        self.alias('b')
        self.caps(max_children=1)
        with self.assertRaisesRegex(ledger.LedgerError, 'reports .cap.'):
            self.legacy().move(ledger.USER, 'a', 'b')
        before = graph.DECISION_STATS['exceptions']
        self.refused('reports (cap)')
        self.assertGreater(graph.DECISION_STATS['exceptions'], before)
        self.assertEqual(self.values()['a'][0], 'boss')
        self.clear_alias('b')
        before = graph.DECISION_STATS['decoded_fallbacks']
        self.refused('reports (cap)')
        self.assertEqual(graph.DECISION_STATS['decoded_fallbacks'], before)

    def test_alias_depth_refusal_and_count_tail_match_decoded_oracle(self):
        self.alias('a')
        self.caps(max_depth=3)
        with self.assertRaisesRegex(ledger.LedgerError, 'max org depth'):
            self.legacy().move(ledger.USER, 'a', 'b')
        self.refused('max org depth')
        self.caps(max_depth=10)
        expected = len(self.legacy().descendants('a', live_only=False))
        with patch.object(graph, 'clean_stats', wraps=graph.clean_stats) as gate:
            result = self.move()
        self.assertNotIn('error', result)
        self.assertGreater(gate.call_count, 0)
        after = self.legacy()
        self.assertEqual(len(after.descendants('a', live_only=False)), expected)
        self.assertIn(f'({expected} node(s))', str(after.d['notices']))

    def test_removed_gate_mutant_is_caught_by_cap_parity_control(self):
        self.alias('b')
        self.caps(max_children=1)
        with patch.object(graph, 'clean_stats', return_value=True):
            with self.assertRaisesRegex(AssertionError, 'unexpectedly accepted'):
                self.refused('reports (cap)')
        self.assertEqual(self.values()['a'][0], 'b', 'mutant did not reach the real endpoint')

    def test_staged_parent_state_birth_and_deletion_select_decoded_view(self):
        class Discard(Exception):
            pass
        for edit in (
            lambda n: n['leaf'].__setitem__('parent', 'b'),
            lambda n: n['leaf'].__setitem__('state', 'archived'),
            lambda n: n.__setitem__('born', fixture.node('born', 'a')),
            lambda n: n.pop('leaf'),
        ):
            with self.subTest(edit=edit), self.assertRaises(Discard):
                with orgtx.org_tx(self.slug, nodes=['a', 'b', 'leaf'], structural_roots=['a', 'b', 'leaf']) as tx:
                    raw = native_move.connection(tx.org)
                    self.assertTrue(graph.clean_stats(tx.org, raw))
                    edit(tx.org.nodes)
                    before = graph.DECISION_STATS['staged']
                    self.assertFalse(graph.clean_stats(tx.org, raw))
                    self.assertEqual(graph.DECISION_STATS['staged'], before+1)
                    raise Discard()
        self.assertEqual(self.values(), self.before)

    def test_already_written_scalar_parent_is_clean_for_later_composite_leg(self):
        with orgtx.org_tx(self.slug, nodes=['boss', 'a', 'b', 'leaf'],
                         structural_roots=['a', 'b'], sections=['audiences', 'notices'],
                         share_sections=['max_children', 'max_depth', 'max_top_grant'],
                         logs=['events', 'notice_log']) as tx:
            tx.org.move(ledger.USER, 'a', 'b')
            raw = native_move.connection(tx.org)
            self.assertTrue(graph.clean_stats(tx.org, raw))
            with patch.object(ledger.Org, 'descendants', side_effect=AssertionError('decoded walk')):
                tx.org.move(ledger.USER, 'a', 'boss')
        self.assertEqual(self.values(), self.before)

    def test_parent_misfit_and_null_empty_alias_are_detected_without_unknown_field_fallback(self):
        with orgtx.org_tx(self.slug, nodes=['leaf'], structural_roots=['leaf']) as tx:
            raw = native_move.connection(tx.org)
            for statement in (
                "UPDATE orgtree.agents SET extra='{\"unknown\":1}'::json WHERE name='leaf'",
                "UPDATE orgtree.agents SET extra='{\"parent\":\"a\"}'::json WHERE name='leaf'",
                "UPDATE orgtree.agents SET extra=NULL,parent_id=NULL,parent='',parent_null=NULL WHERE name='leaf'",
            ):
                raw.execute('SAVEPOINT parent_exception')
                raw.execute(statement)
                self.assertEqual(graph.clean_stats(tx.org, raw), 'unknown' in statement)
                raw.execute('ROLLBACK TO SAVEPOINT parent_exception')
                self.assertTrue(graph.clean_stats(tx.org, raw))

    def test_both_empty_exception_probes_use_ordered_partial_indexes_at_scale(self):
        with store._POOL.acquire(self.slug) as c:
            with c.raw.transaction():
                c.raw.execute("INSERT INTO orgtree.agents(name,parent_null,state) "
                    "SELECT 'gate-scale-'||i,true,'live' FROM generate_series(1,5000) i")
                plan = c.raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+graph.EXCEPTION_PROBE).fetchone()[0]
                indexes = []
                def collect(node):
                    if 'Index Name' in node:
                        indexes.append(node['Index Name'])
                    self.assertNotIn(node['Node Type'], ('Seq Scan', 'Bitmap Heap Scan'))
                    for child in node.get('Plans', []):
                        collect(child)
                collect(plan[0]['Plan'])
                self.assertIn('graph_alias_parents', indexes)
                self.assertIn('graph_parent_exceptions', indexes)
                c.raw.execute("DELETE FROM orgtree.agents WHERE name LIKE 'gate-scale-%'")


if __name__ == '__main__':
    unittest.main()
