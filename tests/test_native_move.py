"""Bounded native plans and ledger dispatch, with controlled SQL boundaries.

These controls do not claim PostgreSQL, HTTP or performance measurements.
The physical scalar/savepoint and endpoint controls run separately.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import contextlib
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from orgtree import ledger, lifecycle_door, lifecycle_tx, pgdoor, store
from orgtree.orgdb import graph, native_move


class SelectedNodes(dict):
    """Reject a whole-node read, including one hidden behind a helper."""
    def __init__(self, values):
        super().__init__(values)
        self.reads = []

    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)

    def __iter__(self):
        raise AssertionError('whole-node iteration')

    def items(self):
        raise AssertionError('whole-node items')

    def values(self):
        raise AssertionError('whole-node values')


def org_fixture():
    def node(name, parent, **kw):
        return dict(name=name, parent=parent, state='live', model='sol',
                    grant=10.0, generation=0, **kw)
    values = {
        'old': node('old', None), 'new': node('new', None),
        'worker': node('worker', 'old', predecessor='worker@0'),
        'worker@0': dict(node('worker@0', 'old'), state='archived',
                         successor='worker'),
        'ordinary': node('ordinary', 'worker'),
        'stranded': node('stranded', 'worker@0'),
        'actor': node('actor', 'old'), 'observer': node('observer', None),
    }
    org = ledger.Org.__new__(ledger.Org)
    org.d = {'nodes': SelectedNodes(values), 'slug': 'selected',
             'max_depth': 20, 'max_children': 10,
             'tiers': {'sol': 2.0}, 'max_top_grant': 1000.0}
    org.node('old')['grant'] = 100.0
    return org


def controlled_leg(org):
    return native_move.Leg(Mock(), ('worker', 'worker@0'),
                           graph.SubtreeStats(3, 1, 25000, 2, 1, 1), {})


class NarrowMovePlanning(unittest.TestCase):
    def test_plan_never_loads_ordinary_or_stranded_descendants(self):
        org = org_fixture()
        update, share = native_move.rows(org, 'actor', [('worker', 'new')])
        self.assertEqual(update, {'worker', 'worker@0', 'old', 'new'})
        self.assertEqual(share, {'actor'})
        self.assertNotIn('ordinary', org.nodes.reads)
        self.assertNotIn('stranded', org.nodes.reads)

    def test_canonical_predecessors_only_and_historical_paths_are_shared(self):
        org = org_fixture()
        org.node('worker@0')['parent'] = 'observer'
        # An unrelated reverse-successor candidate is not the canonical chain.
        dict.__setitem__(org.nodes, 'alternate', {'parent': 'observer',
                                                'successor': 'worker', 'state': 'archived'})
        update, share = native_move.rows(org, ledger.USER, [('worker', 'new')])
        self.assertEqual(update, {'worker', 'worker@0', 'old', 'new'})
        self.assertEqual(share, {'observer'})
        self.assertNotIn('alternate', org.nodes.reads)

    def test_aligned_lineage_coalesces_ancestor_suffix(self):
        org = org_fixture()
        for i in range(100):
            name = f'worker@{i}'
            dict.__setitem__(org.nodes, name, {'parent': 'old', 'state': 'archived',
                                             'predecessor': f'worker@{i + 1}' if i < 99 else None})
        org.nodes.reads.clear()
        update, share = native_move.rows(org, ledger.USER, [('worker', 'new')])
        self.assertEqual(len(update), 103)
        self.assertFalse(share)
        self.assertLess(org.nodes.reads.count('old'), 5)

    def test_later_batch_plan_uses_new_parent_for_root_and_bearers(self):
        org = org_fixture()
        org.node('observer')['parent'] = 'new'
        update, share = native_move.rows(org, ledger.USER,
                                         [('worker', 'new'), ('stranded', 'observer')])
        # The second leg releases through the just-moved bearer, not old.
        self.assertIn('worker@0', update)
        self.assertIn('observer', update)
        self.assertIn('new', update | share)
        self.assertNotIn('ordinary', org.nodes.reads)
        self.assertEqual(org.node('worker@0')['parent'], 'old')

    def test_native_batch_and_promotion_plans_never_copy_or_replay_a_move(self):
        org = org_fixture()
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(store, 'dry_run_copy', side_effect=AssertionError('copy')):
            update, share = lifecycle_tx._move_batch_rows(org, ledger.USER,
                                                          [('worker', 'new')])
            self.assertEqual(update, {'worker', 'worker@0', 'old', 'new'})
            self.assertFalse(share)
            update, share = lifecycle_tx._promote_rows(org, ledger.USER, 'worker', 'ordinary')
            self.assertIn('ordinary', update)
            self.assertIn('worker', update)
            self.assertIn('worker@0', update)
            self.assertNotIn('stranded', org.nodes.reads)

    def test_agent_and_operator_specs_declare_roots_and_no_audience_sweep(self):
        org = org_fixture()
        call = SimpleNamespace(node='actor')
        body = SimpleNamespace(actor=ledger.USER, node='worker', new_parent='new')
        with patch.object(native_move, 'enabled', return_value=True):
            agent = lifecycle_door._spec('move', lifecycle_door._move_rows)(
                org, call, {'node': 'worker', 'new_parent': 'new'})
            operator = lifecycle_door._op_spec('move', lifecycle_door._move_op_rows)(org, body, {})
        for spec in (agent, operator):
            self.assertNotIn('audiences', spec.sections)
            self.assertEqual(set(spec.structural_roots), set(spec.nodes) | set(spec.share_nodes))
            self.assertNotIn('ordinary', spec.structural_roots)
            self.assertNotIn('stranded', spec.structural_roots)

    def test_standalone_graph_miss_rolls_back_and_replans_before_writing(self):
        attempts, writes, rolled_back = [], [], []

        @contextlib.contextmanager
        def begin(slug, **kw):
            attempts.append(kw)
            try:
                yield SimpleNamespace(org=None, lock_nodes=kw['nodes'], share_nodes=kw['share_nodes'])
            except BaseException:
                rolled_back.append(True)
                raise

        def body(org, held, shared):
            if 'new' not in held:
                raise pgdoor.Widen(nodes=['new'], structural_roots=['new', 'observer'])
            writes.append('once')
            return 'ok'

        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole snapshot')), \
                patch.object(native_move, 'planned_rows', side_effect=lambda slug, fn: fn(None)), \
                patch.object(lifecycle_tx.halt, 'txn', side_effect=begin):
            self.assertEqual(lifecycle_tx._run('move', 'test', lambda _: ({'worker'}, set()), body), 'ok')
        self.assertEqual(rolled_back, [True])
        self.assertEqual(writes, ['once'])
        self.assertEqual(attempts[1]['structural_roots'], {'worker', 'new', 'observer'})

    def test_door_prediction_uses_selected_reader_instead_of_whole_snapshot(self):
        org = org_fixture()
        call = SimpleNamespace(org='test', node='actor')
        body = SimpleNamespace(actor=ledger.USER, node='worker', new_parent='new')
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole snapshot')), \
                patch.object(native_move, 'planned_rows', side_effect=lambda slug, fn: fn(org)) as read:
            agent = pgdoor._resolve('orgtree_move', 'test', call,
                                    {'node': 'worker', 'new_parent': 'new'})
            operator = pgdoor._resolve('move', 'test', body, {'org_slug': 'test'})
        self.assertEqual(read.call_count, 2)
        self.assertEqual(set(agent.nodes), set(operator.nodes))
        self.assertIn('actor', agent.share_nodes)
        self.assertNotIn('ordinary', agent.structural_roots)

    def test_planning_reader_selects_names_once_and_forbids_enumeration(self):
        import json
        from orgtree.orgdb.compat import rows as R
        org = org_fixture()
        requested = []

        def selected(raw, wanted, **kw):
            self.assertIsNotNone(wanted)
            self.assertEqual(len(wanted), 1)
            requested.extend(wanted)
            return [(name, json.dumps(org.node(name)), 1) for name in wanted]

        with patch.object(R, 'nodes', side_effect=selected):
            reader = native_move._PlanningNodes(Mock())
            plan = ledger.Org.__new__(ledger.Org)
            plan.d = {'nodes': reader}
            update, share = native_move.rows(plan, ledger.USER, [('worker', 'new')])
            with self.assertRaisesRegex(ledger.LedgerError, 'enumerate'):
                list(iter(reader))
        self.assertEqual(set(requested), {'worker', 'worker@0', 'old', 'new'})
        self.assertEqual(len(requested), len(set(requested)))
        self.assertEqual(update, set(requested))
        self.assertFalse(share)


class NativeLedgerBody(unittest.TestCase):
    def setUp(self):
        self.org = org_fixture()
        self.leg = controlled_leg(self.org)
        self.begin = self.enterContext(patch.object(native_move, 'begin', return_value=self.leg))
        self.enterContext(patch.object(native_move, 'connection', return_value=self.leg.raw))
        self.persist = self.enterContext(patch.object(native_move, 'persist'))
        self.stats = self.enterContext(patch.object(graph, 'subtree_stats',
                                                   return_value=graph.SubtreeStats(2, None, 0, 0, 0, 1)))
        self.notices = self.enterContext(patch.object(self.org, '_notify_ev'))
        self.log = self.enterContext(patch.object(self.org, '_log'))
        self.enterContext(patch.object(self.org, '_peers_of',
                                      side_effect=lambda p, _: ['old_peer'] if p == 'old' else ['new_peer']))
        for name in ('descendants', 'descendant_set', '_sweep_audiences', '_sweep_dirs'):
            self.enterContext(patch.object(self.org, name, side_effect=AssertionError(name)))

    def test_actual_move_dispatch_uses_cached_caps_counts_and_exact_notice_roles(self):
        result = self.org.move(ledger.USER, 'worker', 'new')
        self.persist.assert_called_once_with(self.leg, self.org, 'new', ['old'], ['new'], 12.0)
        self.assertEqual(self.org.node('worker')['parent'], 'new')
        self.assertEqual(self.org.node('worker@0')['parent'], 'new')
        self.assertEqual(self.org.node('ordinary')['parent'], 'worker')
        self.assertEqual(self.org.node('stranded')['parent'], 'worker@0')
        self.assertEqual(self.org.node('old')['grant'], 88.0)
        self.assertEqual(self.org.node('new')['grant'], 22.0)
        self.assertIn('configured grants are kept', result['warnings'][0])
        self.assertEqual([c.args[1]['role'] for c in self.notices.call_args_list],
                         ['old_parent', 'old_peer', 'new_parent', 'new_peer', 'self'])
        self.assertEqual([c.args[0] for c in self.notices.call_args_list],
                         [['old'], ['old_peer'], ['new'], ['new_peer'], ['worker']])
        self.assertTrue(all('25000 node(s)' in c.args[1]['tail'] for c in self.notices.call_args_list))
        self.log.assert_called_once()

    def test_quiet_internal_leg_has_no_per_leg_notice_or_log(self):
        self.org._move('demote', ledger.USER, 'worker', 'new', _quiet=True)
        self.persist.assert_called_once()
        self.notices.assert_not_called()
        self.log.assert_not_called()

    def test_child_and_root_depth_caps_refuse_before_scalar_write(self):
        self.org.d['max_depth'] = 3
        with self.assertRaisesRegex(ledger.LedgerError, 'deepest report at 3'):
            self.org.move(ledger.USER, 'worker', 'new')
        self.persist.assert_not_called()
        self.org.d['max_depth'] = 20
        self.org.d['max_children'] = 0
        with self.assertRaisesRegex(ledger.LedgerError, 'already has 0 reports'):
            self.org.move(ledger.USER, 'worker', 'new')
        self.persist.assert_not_called()

    def test_stranded_child_cycle_refuses_through_destination_chain(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'cycle'):
            self.org.move(ledger.USER, 'worker', 'stranded')
        self.persist.assert_not_called()

    def test_same_parent_preserves_authority_noop_without_native_begin(self):
        with self.assertRaisesRegex(ledger.LedgerError, 'has no authority'):
            self.org.move('observer', 'worker', 'old')
        result = self.org.move(ledger.USER, 'worker', 'old')
        self.assertFalse(result['changed'])
        self.begin.assert_not_called()
        self.persist.assert_not_called()

    def test_invalid_destination_is_refused_before_native_identity_query(self):
        self.org.node('new')['state'] = 'archived'
        with self.assertRaises(ledger.LedgerError):
            self.org.move(ledger.USER, 'worker', 'new')
        self.begin.assert_not_called()
        self.persist.assert_not_called()

    def test_bad_release_and_top_grant_refuse_before_write(self):
        self.org.node('old')['grant'] = 1.0
        with self.assertRaisesRegex(ledger.LedgerError, 'accounting is inconsistent'):
            self.org.move(ledger.USER, 'worker', 'new')
        self.persist.assert_not_called()
        self.org.node('old')['grant'] = 100.0
        self.org.d['max_top_grant'] = 15.0
        with self.assertRaisesRegex(ledger.LedgerError, 'top-level grant'):
            self.org.move(ledger.USER, 'worker', 'new')
        self.persist.assert_not_called()

    def test_scalar_refusal_does_not_publish_parent_grant_or_notices(self):
        before = copy.deepcopy(dict(self.org.d['nodes']))
        self.persist.side_effect = store.StaleWrite('CAS failed')
        with self.assertRaisesRegex(store.StaleWrite, 'CAS failed'):
            self.org.move(ledger.USER, 'worker', 'new')
        self.assertEqual(dict(self.org.d['nodes']), before)
        self.notices.assert_not_called()
        self.log.assert_not_called()


class CompositeBoundary(unittest.TestCase):
    def test_second_refused_batch_leg_restores_scalar_and_document(self):
        org = ledger.Org.__new__(ledger.Org)
        org.d = {'nodes': {'worker': {'parent': 'old', 'grant': 3}}}
        before = copy.deepcopy(org.d)
        raw = Mock()

        def move(actor, name, parent):
            if parent == 'refused':
                raise ledger.LedgerError('later leg refused')
            org.d['nodes'][name]['parent'] = parent
            raw.execute('controlled scalar write')
            return {'warnings': []}

        with patch.object(native_move, 'connection', return_value=raw), \
                patch.object(org, 'move', side_effect=move), patch.object(org, '_log') as log:
            with self.assertRaisesRegex(ledger.LedgerError, 'step 2/2'):
                org.move_batch(ledger.USER, [('worker', 'new'), ('worker', 'refused')])
        self.assertEqual(org.d, before)
        self.assertEqual([c.args[0] for c in raw.execute.call_args_list],
                         ['SAVEPOINT graph_move_verb', 'controlled scalar write',
                          'ROLLBACK TO SAVEPOINT graph_move_verb', 'RELEASE SAVEPOINT graph_move_verb'])
        log.assert_not_called()

    def test_non_domain_failure_also_rolls_back_and_keeps_its_type(self):
        org = ledger.Org.__new__(ledger.Org)
        org.d = {'nodes': {}}
        raw = Mock()
        with patch.object(native_move, 'connection', return_value=raw), \
                patch.object(org, 'move', side_effect=pgdoor.Widen(nodes=['late'])):
            with self.assertRaises(pgdoor.Widen):
                org.move_batch(ledger.USER, [('worker', 'new')])
        self.assertEqual([c.args[0] for c in raw.execute.call_args_list],
                         ['SAVEPOINT graph_move_verb', 'ROLLBACK TO SAVEPOINT graph_move_verb',
                          'RELEASE SAVEPOINT graph_move_verb'])


if __name__ == '__main__':
    unittest.main()
