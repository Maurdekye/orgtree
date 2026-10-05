"""Private feed/schema/graph placement readers against decoded decisions."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import copy
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
import test_orgdb_hot_paths_pg as plans
from orgtree import api, ledger, orgtx, pgdoor, store
from orgtree.orgdb import graph, native_move, registry
from orgtree.orgdb.mappers import agents as agent_codec

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class Discard(Exception):
    pass


@fixture.needs_pg
class Placement(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values

    def reference(self):
        return ledger.Org(fixture.document(self.slug))

    def tx(self, **extra):
        names = ['boss', 'a', 'b', 'leaf', 'new']
        return orgtx.org_tx(self.slug, nodes=names, structural_roots=names,
                            sections=['max_depth'], **extra)

    def deepest(self, org, target, rising):
        excluded = {rising, *org.descendants(rising, live_only=False)} if rising else set()
        return max((org.depth(k) for k in org.descendants(target, live_only=False)
                    if k not in excluded), default=org.depth(target))

    def outcome(self, call):
        try:
            call()
        except ledger.LedgerError as exc:
            return str(exc)
        return None

    def test_clean_depth_direct_nested_outside_ancestor_and_self_rising(self):
        reference = self.reference()
        with self.tx() as tx:
            raw = native_move.connection(tx.org)
            for target, rising in [('boss', None), ('boss', 'a'), ('boss', 'leaf'),
                                   ('a', 'b'), ('a', 'boss'), ('a', 'a'), ('leaf', None)]:
                with self.subTest(target=target, rising=rising):
                    expected = self.deepest(reference, target, rising)
                    with patch.object(ledger.Org, 'descendants', side_effect=AssertionError('stored walk')):
                        self.assertEqual(graph.placement_depth(tx.org, raw, target, rising), expected)

    def test_clean_cap_and_refusal_text_match_decoded_at_each_boundary(self):
        reference = self.reference()
        with self.tx() as tx:
            for cap in (1, 2, 3, 4, 10):
                reference.d['max_depth'] = tx.org.d['max_depth'] = cap
                for target, rising in [('boss', None), ('a', None), ('a', 'leaf')]:
                    with self.subTest(cap=cap, target=target, rising=rising):
                        expected = self.outcome(lambda: reference.check_placement(
                            ledger.USER, target, 'superior', rising))
                        with patch.object(ledger.Org, 'descendants', side_effect=AssertionError('stored walk')):
                            actual = self.outcome(lambda: tx.org.check_placement(
                                ledger.USER, target, 'superior', rising))
                        self.assertEqual(actual, expected)

    def test_staged_parent_state_successor_birth_delete_retain_actual_decision(self):
        for kind in ('parent', 'state', 'successor', 'birth', 'delete'):
            with self.subTest(kind=kind), self.assertRaises(Discard):
                reference = self.reference()
                with self.tx() as tx:
                    for org in (reference, tx.org):
                        if kind == 'birth':
                            org.nodes['new'] = copy.deepcopy(org.node('leaf'))
                            org.nodes['new']['parent'] = 'leaf'
                        elif kind == 'delete':
                            del org.nodes['leaf']
                        else:
                            org.node('leaf')[kind] = {'parent':'b', 'state':'archived',
                                                     'successor':'b'}[kind]
                    raw = native_move.connection(tx.org)
                    before = graph.DECISION_STATS['staged']
                    self.assertIsNone(graph.placement_depth(tx.org, raw, 'a'))
                    self.assertIsNone(graph.placement_children(tx.org, raw, 'a'))
                    self.assertGreater(graph.DECISION_STATS['staged'], before)
                    self.assertEqual(len(tx.org.org_children('a')), len(reference.org_children('a')))
                    for cap in (2, 3, 4):
                        tx.org.d['max_depth'] = reference.d['max_depth'] = cap
                        self.assertEqual(self.outcome(lambda: tx.org.check_placement(ledger.USER, 'a', 'superior')),
                                         self.outcome(lambda: reference.check_placement(ledger.USER, 'a', 'superior')))
                    raise Discard()
        self.assertEqual(self.values(), self.before)

    def alias(self, nested=False, misfit=False):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            if misfit:
                c.raw.execute("UPDATE orgtree.agents SET extra='{\"parent\":\"b\"}'::json "
                              "WHERE name='leaf' AND NOT tombstone")
                return
            parent = 'a' if nested else 'boss'
            identity = c.raw.execute('INSERT INTO orgtree.agents(name,tombstone) '
                'VALUES(%s,true) RETURNING id', (parent,)).fetchone()[0]
            c.raw.execute("UPDATE orgtree.agents SET parent_id=%s WHERE name='leaf' AND NOT tombstone",
                          (identity,))

    def test_direct_nested_alias_and_parent_misfit_choose_decoded_depth_cap_count(self):
        for nested, misfit in [(False, False), (True, False), (False, True)]:
            with self.subTest(nested=nested, misfit=misfit):
                self.alias(nested, misfit)
                reference = self.reference()
                with self.tx() as tx:
                    raw = native_move.connection(tx.org)
                    self.assertIsNone(graph.placement_depth(tx.org, raw, 'boss', 'a'))
                    self.assertIsNone(graph.placement_children(tx.org, raw, 'boss'))
                    self.assertEqual(len(tx.org.org_children('boss')), len(reference.org_children('boss')))
                    for cap in (2, 3, 4):
                        tx.org.d['max_depth'] = reference.d['max_depth'] = cap
                        self.assertEqual(self.outcome(lambda: tx.org.check_placement(ledger.USER, 'boss', 'superior', 'a')),
                            self.outcome(lambda: reference.check_placement(ledger.USER, 'boss', 'superior', 'a')))

    def test_missing_cache_after_plan_is_not_an_empty_branch(self):
        for chosen in ('a', 'leaf'):
            with self.subTest(chosen=chosen), self.assertRaises(Discard):
                with self.tx() as tx:
                    raw = native_move.connection(tx.org)
                    raw.execute('DELETE FROM orgtree.agent_subtree_stats WHERE agent_id='
                                '(SELECT id FROM orgtree.agents WHERE name=%s AND NOT tombstone)', (chosen,))
                    with self.assertRaisesRegex(ledger.LedgerError, 'missing or corrupt'):
                        graph.placement_depth(tx.org, raw, 'a', 'leaf')
                    raise Discard()

    def test_missing_early_stats_path_widens_without_taking_late_lock(self):
        with self.assertRaises(pgdoor.Widen):
            with orgtx.org_tx(self.slug, nodes=['a', 'leaf']) as tx:
                graph.placement_depth(tx.org, native_move.connection(tx.org), 'a', 'leaf')
        self.assertEqual(self.values(), self.before)

    def test_public_hire_insert_reaches_clean_precheck_and_certified_postcheck(self):
        before = graph.DECISION_STATS['bounded_births']
        with patch.object(graph, 'placement_depth', wraps=graph.placement_depth) as depth:
            result = api.org_op(self.slug, api.Op(op='hire', actor=ledger.USER, tier='luna',
                name='new', grant=0, parent='boss', above='a'), endpoints.REQUEST)
        self.assertNotIn('error', result)
        self.assertGreaterEqual(depth.call_count, 2)
        self.assertGreater(graph.DECISION_STATS['bounded_births'], before)
        current = self.values()
        self.assertEqual(current['new'][0], 'boss')
        self.assertEqual(current['a'][0], 'new')
        self.assertEqual(current['leaf'][0], 'a')

    def test_clean_child_count_matches_exact_archived_successor_predicate(self):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            c.raw.execute("UPDATE orgtree.agents SET state='archived',successor_id="
                          "(SELECT id FROM orgtree.agents WHERE name='b' AND NOT tombstone) "
                          "WHERE name='leaf' AND NOT tombstone")
        with self.tx() as tx:
            raw = native_move.connection(tx.org)
            self.assertEqual(graph.placement_children(tx.org, raw, 'a'), 0)
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            c.raw.execute("UPDATE orgtree.agents SET state='unrecoverable' WHERE name='leaf' AND NOT tombstone")
        with self.tx() as tx:
            self.assertEqual(graph.placement_children(tx.org, native_move.connection(tx.org), 'a'), 1)

    def test_complete_placement_reads_are_indexed_and_decode_no_bodies_at_scale(self):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            c.raw.execute("INSERT INTO orgtree.agents(name,ord,ui_order,lineage_born,"
                "parent_id,state,model,credit_grant,created) "
                "SELECT 'placement-scale-'||i,100+i,100+i,'placement-seat-'||i,"
                "(SELECT id FROM orgtree.agents WHERE name='a' AND NOT tombstone),"
                "'archived','luna',0,%s::timestamptz FROM generate_series(1,5000) i",
                (fixture.AT,))
        # Seed first, then refresh statistics through the owner/admin connection.
        # Runtime readers cannot ANALYZE these tables.
        with fixture.dbconn.connect(fixture.ADMIN, registry.lookup(self.slug)[1],
                                    autocommit=True) as admin:
            admin.execute('ANALYZE orgtree.agents')
            admin.execute('ANALYZE orgtree.agent_subtree_stats')
        with self.tx() as tx:
            raw = native_move.connection(tx.org)
            queries = []
            recorded = plans.RecordingConnection(raw, queries)
            with patch.object(agent_codec, 'decode_node', side_effect=AssertionError('whole body')), \
                    patch.object(ledger.Org, 'descendants', side_effect=AssertionError('stored walk')):
                self.assertEqual(graph.placement_depth(tx.org, recorded, 'a', 'leaf'), 2)
                self.assertEqual(graph.placement_children(tx.org, recorded, 'a'), 5001)
            self.assertGreater(len(queries), 0)
            self.assertLessEqual(len(queries), 16)
            indexes, total = set(), 0
            for sql, params in queries:
                plan = raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql, params).fetchone()[0][0]['Plan']
                self.assertEqual(plans.violations(plan, {'agents', 'agent_subtree_stats'}, sql), [])
                total += plans.examined(plan)
                indexes.update(n['Index Name'] for n in plans.nodes(plan) if 'Index Name' in n)
            self.assertLessEqual(total, 100)
            self.assertIn('agent_subtree_tallest', indexes)
            self.assertIn('graph_alias_parents', indexes)
            self.assertIn('graph_parent_exceptions', indexes)
            print('placement work:', dict(selects=len(queries), examined=total,
                                          indexes=sorted(indexes)), flush=True)
            # An actually executed unindexed arm must fail the same work oracle.
            raw.execute('SET LOCAL enable_indexscan=off')
            raw.execute('SET LOCAL enable_indexonlyscan=off')
            raw.execute('SET LOCAL enable_bitmapscan=off')
            bad_queries = []
            self.assertEqual(graph.placement_depth(tx.org,
                plans.RecordingConnection(raw, bad_queries), 'a', 'leaf'), 2)
            faults = []
            for sql, params in bad_queries:
                plan = raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql, params).fetchone()[0][0]['Plan']
                faults.extend(plans.violations(plan, {'agents', 'agent_subtree_stats'}, sql))
            self.assertTrue(any('sequential scan' in fault for fault in faults), faults)
            print('placement forced-unindexed faults:', faults, flush=True)

    def test_public_alias_depth_refusal_matches_decoded_and_creates_no_birth(self):
        from fastapi import HTTPException
        for nested in (False, True):
            with self.subTest(nested=nested):
                self.alias(nested=nested)
                org = store.load_org(self.slug)
                org.d['max_depth'] = 3 if nested else 2
                store.save_org(org)
                expected = self.outcome(lambda: self.reference().check_placement(
                    ledger.USER, 'a', 'superior'))
                self.assertIsNotNone(expected)
                before = self.values()
                with self.assertRaises(HTTPException) as failure:
                    api.org_op(self.slug, api.Op(op='hire', actor=ledger.USER, tier='luna',
                        name='new', grant=0, parent='boss', above='a'), endpoints.REQUEST)
                self.assertEqual(failure.exception.detail, expected)
                self.assertEqual(self.values(), before)

    def test_multiple_staged_edits_rollback_then_retry_keeps_decoded_decisions(self):
        for attempt in range(2):
            with self.subTest(attempt=attempt), self.assertRaises(Discard):
                reference = self.reference()
                with self.tx() as tx:
                    for org in (reference, tx.org):
                        org.node('leaf')['parent'] = 'b'
                        org.node('leaf')['state'] = 'archived'
                        org.node('leaf')['successor'] = 'a'
                        org.nodes['new'] = copy.deepcopy(org.node('a'))
                        org.nodes['new']['parent'] = 'b'
                    raw = native_move.connection(tx.org)
                    self.assertIsNone(graph.placement_depth(tx.org, raw, 'boss', 'a'))
                    self.assertIsNone(graph.placement_children(tx.org, raw, 'b'))
                    self.assertEqual(len(tx.org.org_children('b')), len(reference.org_children('b')))
                    for cap in (2, 3, 10):
                        tx.org.d['max_depth'] = reference.d['max_depth'] = cap
                        self.assertEqual(self.outcome(lambda: tx.org.check_placement(
                            ledger.USER, 'boss', 'superior', 'a')),
                            self.outcome(lambda: reference.check_placement(
                            ledger.USER, 'boss', 'superior', 'a')))
                    raise Discard()
            self.assertEqual(self.values(), self.before)


if __name__ == '__main__':
    unittest.main()
