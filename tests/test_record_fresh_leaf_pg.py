"""Closed fresh-leaf certificate: current edits, identities and bounded reads."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import copy
import inspect
import json
import unittest
import uuid
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
import test_record_placement_pg as placement
import test_orgdb_hot_paths_pg as plans
from orgtree import api, ledger, orgtx, pgdoor, store
from orgtree.orgdb import graph, native_move, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class FreshLeaf(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values
    tx = placement.Placement.tx
    outcome = placement.Placement.outcome

    def stage(self, org, name='new'):
        node = copy.deepcopy(org.node('leaf'))
        node.update(parent='a', state='live', predecessor=None, successor=None,
                    generation=0, seat_id=str(uuid.uuid4()))
        org.nodes[name] = node
        return node

    def test_certified_depth_count_and_cap_messages_equal_decoded_with_no_walk(self):
        with self.assertRaises(placement.Discard):
            reference = ledger.Org(fixture.document(self.slug))
            self.stage(reference)
            with self.tx() as tx:
                self.stage(tx.org)
                raw = native_move.connection(tx.org)
                old = graph.DECISION_STATS['decoded_fallbacks']
                with patch.object(ledger.Org, 'descendants', side_effect=AssertionError('stored walk')):
                    self.assertEqual(graph.placement_depth(tx.org, raw, 'a', 'new'), 2)
                    self.assertEqual(graph.placement_children(tx.org, raw, 'new'), 0)
                self.assertEqual(graph.DECISION_STATS['decoded_fallbacks'], old)
                for cap in (2, 3, 4, 10):
                    reference.d['max_depth'] = tx.org.d['max_depth'] = cap
                    expected = self.outcome(lambda: reference.check_placement(ledger.USER, 'a', 'superior', 'new'))
                    actual = self.outcome(lambda: tx.org.check_placement(ledger.USER, 'a', 'superior', 'new'))
                    self.assertEqual(actual, expected)
                raise placement.Discard()
        self.assertEqual(self.values(), self.before)

    def test_second_edits_birth_delete_lineage_and_rare_inputs_keep_fallback(self):
        for kind in ('parent', 'state', 'successor', 'birth', 'delete', 'predecessor', 'null', 'empty'):
            with self.subTest(kind=kind), self.assertRaises(placement.Discard):
                with self.tx() as tx:
                    node = self.stage(tx.org)
                    if kind == 'birth':
                        self.stage(tx.org, 'other')
                    elif kind == 'delete':
                        del tx.org.nodes['leaf']
                    elif kind == 'predecessor':
                        node['predecessor'] = 'leaf'
                    elif kind in ('null', 'empty'):
                        node['parent'] = None if kind == 'null' else ''
                    else:
                        tx.org.node('leaf')[kind] = {'parent':'b', 'state':'archived', 'successor':'b'}[kind]
                    raw = native_move.connection(tx.org)
                    old = graph.DECISION_STATS['decoded_fallbacks']
                    self.assertIsNone(graph.placement_depth(tx.org, raw, 'a', 'new'))
                    self.assertIsNone(graph.placement_children(tx.org, raw, 'new'))
                    self.assertGreater(graph.DECISION_STATS['decoded_fallbacks'], old)
                    raise placement.Discard()

    def test_second_edit_mutant_is_caught_then_restored(self):
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                self.stage(tx.org)
                tx.org.node('leaf')['state'] = 'archived'
                raw = native_move.connection(tx.org)
                self.assertIsNone(graph.placement_depth(tx.org, raw, 'a', 'new'))
                source = inspect.getsource(graph.fresh_leaf_depth)
                needle = 'if type(old) is not type(new) or old != new:\n                return None'
                self.assertIn(needle, source)
                scope = dict(graph.__dict__)
                exec(compile(source.replace(needle, 'if False:\n                return None'), '<second-edit-mutant>', 'exec'), scope)
                with patch.object(graph, 'fresh_leaf_depth', scope['fresh_leaf_depth']):
                    with self.assertRaises(AssertionError):
                        self.assertIsNone(graph.placement_depth(tx.org, raw, 'a', 'new'))
                self.assertIsNone(graph.placement_depth(tx.org, raw, 'a', 'new'))
                print('Reached second-staged-edit mutant; fallback oracle caught it and restoration passed', flush=True)
                raise placement.Discard()

    def test_same_transaction_placeholder_and_savepoint_rollback_are_explicit(self):
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                self.stage(tx.org)
                raw = native_move.connection(tx.org)
                raw.execute('SAVEPOINT birth')
                aid = raw.execute("INSERT INTO orgtree.agents(name,tombstone) VALUES('new',true) RETURNING id").fetchone()[0]
                self.assertIn(aid, graph.current_plan(raw)['created'])
                self.assertEqual(graph.placement_depth(tx.org, raw, 'a', 'new'), 2)
                self.assertEqual(graph.placement_children(tx.org, raw, 'new'), 0)
                raw.execute('ROLLBACK TO SAVEPOINT birth')
                self.assertNotIn(aid, graph.current_plan(raw).get('created', ()))
                self.assertEqual(graph.placement_depth(tx.org, raw, 'a', 'new'), 2)
                raise placement.Discard()
        self.assertEqual(self.values(), self.before)

    def test_existing_tombstone_and_exception_never_certify(self):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            c.raw.execute("INSERT INTO orgtree.agents(name,tombstone) VALUES('new',true)")
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                self.stage(tx.org)
                raw = native_move.connection(tx.org)
                self.assertIsNone(graph.placement_depth(tx.org, raw, 'a', 'new'))
                self.assertIsNone(graph.placement_children(tx.org, raw, 'new'))
                raise placement.Discard()

    def test_missing_stats_refuse_and_missing_early_plan_widens(self):
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                self.stage(tx.org)
                raw = native_move.connection(tx.org)
                raw.execute("DELETE FROM orgtree.agent_subtree_stats WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='a' AND NOT tombstone)")
                with self.assertRaisesRegex(ledger.LedgerError, 'missing or corrupt'):
                    graph.placement_depth(tx.org, raw, 'a', 'new')
                raise placement.Discard()
        with self.assertRaises(pgdoor.Widen):
            with orgtx.org_tx(self.slug, nodes=['a','leaf','new']) as tx:
                self.stage(tx.org)
                graph.placement_depth(tx.org, native_move.connection(tx.org), 'a', 'new')
        self.assertEqual(self.values(), self.before)

    def test_public_hire_reaches_certificate_and_preserves_result_and_revision(self):
        reference = ledger.Org(fixture.document(self.slug))
        body = api.Op(op='hire', actor=ledger.USER, tier='luna', name='new', grant=0, parent='boss', above='a')
        expected = api._op_hire(reference, body, None)
        with store._POOL.acquire(self.slug) as c:
            before = c.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
        start = graph.DECISION_STATS['bounded_births']
        with patch.object(graph, 'fresh_leaf_depth', wraps=graph.fresh_leaf_depth) as certificate:
            result = api.org_op(self.slug, body, endpoints.REQUEST)
        self.assertGreater(certificate.call_count, 0)
        self.assertGreater(graph.DECISION_STATS['bounded_births'], start)
        for key, value in expected.items():
            self.assertEqual(result[key], value, key)
        self.assertEqual(self.values(), {name:(n['parent'],n['grant']) for name,n in reference.nodes.items()})
        with store._POOL.acquire(self.slug) as c:
            self.assertEqual(c.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0], before+1)


    def test_birth_reads_remain_indexed_at_scale_and_unindexed_fault_is_caught(self):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            c.raw.execute("INSERT INTO orgtree.agents(name,ord,ui_order,lineage_born,parent_id,state,model,credit_grant,created) "
                "SELECT 'birth-scale-'||i,100+i,100+i,'birth-seat-'||i,"
                "(SELECT id FROM orgtree.agents WHERE name='a' AND NOT tombstone),"
                "'archived','luna',0,%s::timestamptz FROM generate_series(1,5000) i", (fixture.AT,))
        with fixture.dbconn.connect(fixture.ADMIN, registry.lookup(self.slug)[1], autocommit=True) as admin:
            admin.execute('ANALYZE orgtree.agents')
            admin.execute('ANALYZE orgtree.agent_subtree_stats')
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                self.stage(tx.org)
                raw = native_move.connection(tx.org)
                queries = []
                recorded = plans.RecordingConnection(raw, queries)
                with patch.object(ledger.Org, 'descendants', side_effect=AssertionError('stored walk')):
                    self.assertEqual(graph.placement_depth(tx.org, recorded, 'a', 'new'), 2)
                    self.assertEqual(graph.placement_children(tx.org, recorded, 'new'), 0)
                self.assertLessEqual(len(queries), 24)
                total, indexes = 0, set()
                for sql, params in queries:
                    plan = raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql, params).fetchone()[0][0]['Plan']
                    self.assertEqual(plans.violations(plan, {'agents','agent_subtree_stats'}, sql), [])
                    total += plans.examined(plan)
                    indexes.update(n['Index Name'] for n in plans.nodes(plan) if 'Index Name' in n)
                self.assertLessEqual(total, 150)
                self.assertIn('agents_name_all', indexes)
                self.assertIn('graph_alias_parents', indexes)
                self.assertIn('graph_parent_exceptions', indexes)
                print('fresh leaf work:', dict(selects=len(queries), examined=total, indexes=sorted(indexes)), flush=True)
                raw.execute('SAVEPOINT unindexed')
                raw.execute('SET LOCAL enable_indexscan=off')
                raw.execute('SET LOCAL enable_indexonlyscan=off')
                raw.execute('SET LOCAL enable_bitmapscan=off')
                bad = []
                self.assertEqual(graph.placement_depth(tx.org, plans.RecordingConnection(raw,bad), 'a','new'), 2)
                faults = []
                for sql, params in bad:
                    plan = raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql, params).fetchone()[0][0]['Plan']
                    faults.extend(plans.violations(plan, {'agents','agent_subtree_stats'}, sql))
                self.assertTrue(any('sequential scan' in fault for fault in faults), faults)
                raw.execute('ROLLBACK TO SAVEPOINT unindexed')
                self.assertEqual(graph.placement_depth(tx.org, raw, 'a','new'), 2)
                print('fresh leaf forced-unindexed faults:', faults, flush=True)
                raise placement.Discard()

if __name__ == '__main__':
    unittest.main()