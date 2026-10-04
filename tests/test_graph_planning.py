"""Early graph lock plans: no late promotion, stale path or pooled authority."""
import contextlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgdoor
from orgtree.ledger import LedgerError
from orgtree.orgdb import graph


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class Raw:
    """Controlled planning reads; writes/locks are forbidden in a body guard."""
    def __init__(self):
        # hidden is an old tombstone ancestor: its physical edge still matters.
        self.rows = {1: ('hidden', None), 2: ('boss', 1), 3: ('worker', 2),
                     4: ('destination', 1)}
        self.stats = set(self.rows)
        self.marker = None
        self.calls = []

    def execute(self, sql, args=()):
        self.calls.append((sql, args))
        if 'set_config' in sql:
            self.marker = args[0]
            return Result([(self.marker,)])
        if 'current_setting' in sql:
            return Result([(self.marker,)])
        if 'agent_subtree_stats' in sql:
            return Result([(i,) for i in args[0] if i in self.stats])
        if 'WITH RECURSIVE' in sql:
            seen, todo = set(), [i for i, (name, _) in self.rows.items() if name in args[0]]
            while todo:
                i = todo.pop()
                if i in seen or i not in self.rows:
                    continue
                seen.add(i)
                todo.append(self.rows[i][1])
            return Result([(i, *self.rows[i]) for i in sorted(seen)])
        if sql == 'SELECT id,name,parent_id FROM orgtree.agents ORDER BY id':
            return Result([(i, *self.rows[i]) for i in sorted(self.rows)])
        raise AssertionError(f'unexpected SQL: {sql}')


def native(raw, *, nodes=('worker',), roots=('worker', 'destination')):
    tx = orgtx._new_tx('test', nodes=nodes, structural_roots=roots)
    plan = graph.plan_locks(raw, tx)
    graph.install_plan(raw, tx, plan)
    return tx, plan


class GraphPlanning(unittest.TestCase):
    def test_unrelated_plan_reads_no_paths_or_stats(self):
        raw = Raw()
        self.assertIsNone(graph.plan_locks(raw, orgtx._new_tx('test', sections=['workspace'])))
        self.assertEqual(raw.calls, [])
        self.assertEqual(graph.stats_lock_clause(None), '')

    def test_scope_plan_holds_all_ancestors_without_stats(self):
        raw = Raw()
        tx = orgtx._new_tx('test', nodes=['worker'])
        plan = graph.plan_locks(raw, tx)
        self.assertEqual(plan.agent_ids, {1, 2, 3})
        self.assertEqual(plan.stats_ids, set())
        self.assertEqual(tx.share_nodes, {'boss', 'hidden'})
        self.assertEqual(graph.stats_lock_clause(plan), '')
        graph.install_plan(raw, tx, plan)
        graph.check_scope_paths(raw, {'worker'})
        self.assertFalse(any('agent_subtree_stats' in sql for sql, _ in raw.calls))

    def test_scope_path_changed_while_waiting_retries_before_body(self):
        raw = Raw()
        tx = orgtx._new_tx('test', nodes=['worker'])
        plan = graph.plan_locks(raw, tx)
        raw.rows[3] = ('worker', 4)
        with self.assertRaises(orgtx.SerializationFailure):
            graph.install_plan(raw, tx, plan)
        self.assertIsNone(raw.marker)

    def test_scope_body_miss_requires_rollback_without_late_lock_or_stats(self):
        raw = Raw()
        tx = orgtx._new_tx('test', nodes=['worker'])
        plan = graph.plan_locks(raw, tx)
        graph.install_plan(raw, tx, plan)
        raw.calls.clear()
        with self.assertRaises(pgdoor.Widen) as got:
            graph.check_scope_paths(raw, {'destination'})
        self.assertEqual(got.exception.spec.share_nodes, ('destination',))
        self.assertFalse(any('FOR UPDATE' in sql or 'FOR SHARE' in sql or
                             'agent_subtree_stats' in sql for sql, _ in raw.calls))

    def test_paths_add_shared_ancestors_including_hidden_rows(self):
        raw = Raw()
        tx, plan = native(raw)
        self.assertEqual(plan.agent_ids, {1, 2, 3, 4})
        self.assertEqual(tx.lock_nodes, {'worker'})
        self.assertEqual(tx.share_nodes, {'hidden', 'boss', 'destination'})
        self.assertEqual(plan.stats_ids, plan.agent_ids)
        self.assertEqual(graph.stats_lock_clause(plan),
                         'PERFORM agent_id FROM orgtree.agent_subtree_stats WHERE '
                         'agent_id IN (1,2,3,4) ORDER BY agent_id FOR UPDATE;')

    def test_path_changed_during_wait_widens_before_body(self):
        raw = Raw()
        tx = orgtx._new_tx('test', nodes=['worker'], structural_roots=['worker'])
        plan = graph.plan_locks(raw, tx)
        raw.rows[3] = ('worker', 4)
        with self.assertRaises(pgdoor.Widen) as got:
            graph.install_plan(raw, tx, plan)
        self.assertEqual(got.exception.spec.share_nodes, ('destination',))
        self.assertIsNone(raw.marker)

    def test_missing_aggregate_is_refused_not_scanned_or_repaired(self):
        raw = Raw()
        raw.stats.remove(2)
        with self.assertRaisesRegex(LedgerError, 'reconciliation'):
            native(raw)
        self.assertIsNone(raw.marker)
        self.assertFalse(any('INSERT' in sql or 'UPDATE orgtree' in sql
                             for sql, _ in raw.calls))

    def test_shared_root_cannot_be_promoted_to_update_in_body(self):
        raw = Raw()
        native(raw, nodes=())
        raw.calls.clear()
        with self.assertRaises(pgdoor.Widen) as got:
            graph.check_paths(raw, {'worker', 'destination'}, updates={'worker'})
        self.assertEqual(got.exception.spec.nodes, ('worker',))
        self.assertFalse(any('FOR UPDATE' in sql or 'FOR SHARE' in sql
                             for sql, _ in raw.calls))

    def test_new_root_still_requires_exclusive_name_declaration(self):
        raw = Raw()
        native(raw)
        with self.assertRaises(pgdoor.Widen) as got:
            graph.check_paths(raw, {'new', 'boss'}, updates={'new'})
        self.assertEqual(got.exception.spec.nodes, ('new',))

    def test_body_path_miss_widens_instead_of_taking_late_locks(self):
        raw = Raw()
        native(raw, roots=('worker',))
        raw.rows[3] = ('worker', 4)
        raw.calls.clear()
        with self.assertRaises(pgdoor.Widen) as got:
            graph.check_paths(raw, {'worker'}, updates={'worker'})
        self.assertIn('destination', got.exception.spec.structural_roots)
        self.assertFalse(any('FOR UPDATE' in sql or 'FOR SHARE' in sql
                             for sql, _ in raw.calls))

    def test_native_unplanned_write_widens_but_raw_writer_has_no_native_authority(self):
        raw = Raw()
        tx = orgtx._new_tx('test', nodes=['worker'])
        graph.install_plan(raw, tx, None)
        with self.assertRaises(pgdoor.Widen):
            graph.check_paths(raw, {'worker'}, updates={'worker'})
        # A new raw transaction has no transaction-local native marker. A stale
        # Python attribute must never stand in for a PostgreSQL-owned plan.
        raw.marker = None
        raw._ot_graph_plan = graph.LockPlan(frozenset({'worker'}), frozenset(), frozenset())
        raw.calls.clear()
        graph.check_paths(raw, {'worker'}, updates={'worker'})
        self.assertEqual(len(raw.calls), 1)

    def test_checked_covered_write_does_not_acquire_any_lock(self):
        raw = Raw()
        native(raw)
        raw.calls.clear()
        graph.check_paths(raw, {'worker', 'destination'}, updates={'worker'})
        self.assertFalse(any('FOR UPDATE' in sql or 'FOR SHARE' in sql
                             for sql, _ in raw.calls))
        self.assertEqual(json.loads(raw.marker)['updates'], ['worker'])

    def test_whole_structural_plan_covers_all_physical_rows(self):
        raw = Raw()
        tx = orgtx._new_tx('test', whole=True, structural_roots=['worker'])
        plan = graph.plan_locks(raw, tx)
        self.assertTrue(plan.whole)
        self.assertEqual(plan.agent_ids, set(raw.rows))
        self.assertIn('WHERE true ORDER BY agent_id FOR UPDATE', graph.stats_lock_clause(plan))


class DoorStructuralSpec(unittest.TestCase):
    def test_structural_roots_survive_normalization_and_agent_fences(self):
        s = pgdoor._norm(pgdoor.TxSpec(nodes=('worker',), structural_roots=('boss', 'boss')))
        self.assertEqual(s.structural_roots, ('boss',))
        self.assertFalse(pgdoor.TxSpec(nodes=('boss',)).covers(s).empty())
        self.assertEqual(s.widened(pgdoor.Widen(structural_roots=['destination'])).structural_roots,
                         ('boss', 'destination'))
        body = SimpleNamespace(node='worker', tool='test')
        fenced = pgdoor.agent_spec(body, {}, s)
        self.assertEqual(fenced.structural_roots, ('boss',))

    def test_door_forwards_roots_and_retries_whole_body_before_any_write(self):
        attempts, writes = [], []

        @contextlib.contextmanager
        def begin(slug, **kwargs):
            attempts.append(kwargs)
            yield SimpleNamespace(org=None)

        def body(handle, held):
            if not held.structural_roots:
                raise pgdoor.Widen(structural_roots=['worker'], nodes=['worker'])
            writes.append('once')
            return 'ok'

        with patch.object(pgdoor, '_org_tx', return_value=begin):
            _, result = pgdoor._run('test', pgdoor.TxSpec(), body)
        self.assertEqual(result, 'ok')
        self.assertEqual(len(attempts), 2)
        self.assertNotIn('structural_roots', attempts[0])
        self.assertEqual(attempts[1]['structural_roots'], ['worker'])
        self.assertEqual(writes, ['once'])

    def test_org_transaction_validates_and_retains_structural_roots(self):
        with self.assertRaises(TypeError):
            orgtx._new_tx('test', structural_roots='worker')
        self.assertEqual(orgtx._new_tx('test', structural_roots=['worker']).structural_roots,
                         {'worker'})


if __name__ == '__main__':
    unittest.main()
