"""Hire cap reuses the existing clean graph count before staging a birth."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import copy
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
import test_record_placement_pg as placement
from orgtree import api, ledger, store
from orgtree.orgdb import graph, native_move

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class HireCap(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values
    tx = placement.Placement.tx
    outcome = placement.Placement.outcome
    alias = placement.Placement.alias

    def hire(self, org):
        return org.hire(ledger.USER, 'a', 'luna', 0, 'new')

    def refusal(self, edit=None, counter=None):
        reference = ledger.Org(fixture.document(self.slug))
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                for org in (reference, tx.org):
                    if edit:
                        edit(org)
                    org.d['max_children'] = 0
                expected = self.outcome(lambda: self.hire(reference))
                before = graph.DECISION_STATS.get(counter, 0)
                with patch.object(graph, 'placement_children', wraps=graph.placement_children) as reader:
                    actual = self.outcome(lambda: self.hire(tx.org))
                self.assertEqual(actual, expected)
                self.assertEqual(actual, 'a already has 0 reports (cap)')
                self.assertEqual(reader.call_count, 0 if counter else 1)
                self.assertNotIn('new', tx.org.nodes)
                if counter:
                    self.assertEqual(graph.DECISION_STATS[counter], before+1)
                raise placement.Discard()

    def test_clean_cap_refuses_before_mutation_with_identical_error(self):
        before = graph.DECISION_STATS['decoded_fallbacks']
        self.refusal()
        self.assertEqual(graph.DECISION_STATS['decoded_fallbacks'], before)
        self.assertEqual(self.values(), self.before)

    def test_staged_parent_state_successor_birth_delete_use_decoded_cap(self):
        edits = [lambda o:o.node('leaf').__setitem__('parent','b'),
                 lambda o:o.node('leaf').__setitem__('state','archived'),
                 lambda o:o.node('leaf').__setitem__('successor','b'),
                 lambda o:o.nodes.__setitem__('other',json.loads(json.dumps(o.node('leaf')))),
                 lambda o:o.nodes.__delitem__('leaf')]
        for edit in edits:
            self.refusal(edit, 'staged')
        self.assertEqual(self.values(), self.before)

    def test_alias_preserves_decoded_cap_and_counter(self):
        self.alias(nested=True)
        self.refusal(counter='exceptions')

    def test_parent_misfit_preserves_decoded_cap_and_counter(self):
        self.alias(misfit=True)
        self.refusal(counter='exceptions')

    def test_missing_stats_refuses_before_birth(self):
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                raw = native_move.connection(tx.org)
                raw.execute("DELETE FROM orgtree.agent_subtree_stats WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='a' AND NOT tombstone)")
                with self.assertRaisesRegex(ledger.LedgerError, 'missing or corrupt'):
                    self.hire(tx.org)
                self.assertNotIn('new', tx.org.nodes)
                raise placement.Discard()
        self.assertEqual(self.values(), self.before)

    def test_staged_fresh_parent_cannot_use_zero_shortcut(self):
        with self.assertRaises(placement.Discard):
            with self.tx() as tx:
                node = copy.deepcopy(tx.org.node('leaf'))
                node.update(parent='a', predecessor=None, successor=None, generation=0)
                tx.org.nodes['new'] = node
                tx.org.d['max_children'] = 0
                before = graph.DECISION_STATS['staged']
                with patch.object(graph, 'placement_children', side_effect=AssertionError('staged parent accepted')):
                    with self.assertRaisesRegex(ledger.LedgerError, 'new already has 0 reports'):
                        tx.org.hire(ledger.USER,'new','luna',0,'other')
                self.assertEqual(graph.DECISION_STATS['staged'], before+1)
                self.assertNotIn('other',tx.org.nodes)
                raise placement.Discard()

    def seed_archive(self):
        org = store.load_org(self.slug)
        org.d['max_children'] = 1000
        for i in range(40):
            node = copy.deepcopy(org.node('leaf'))
            node.update(state='archived', seat_id='cap-seat-'+str(i),
                        session_id='cap-session-'+str(i), archived_at=fixture.AT)
            org.nodes['cap-archive-'+str(i)] = node
        store.save_org(org)
        with store._POOL.acquire(self.slug) as c:
            self.assertEqual(c.raw.execute("SELECT count(*) FROM orgtree.agents WHERE name LIKE 'cap-archive-%' AND NOT tombstone").fetchone()[0],40)
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)

    def public(self, name):
        with patch.object(api, 'provider_hire_gate', return_value=None):
            result = api.org_op(self.slug, api.Op(op='hire', actor=ledger.USER,
                tier='luna', name=name, grant=0, parent='boss', above='a'), endpoints.REQUEST)
        self.assertIsInstance(result, dict, str(getattr(result,'body',result)))
        self.assertNotIn('error', result)
        return result

    def test_public_hire_does_not_decode_archive_and_removed_path_fault_is_caught(self):
        self.seed_archive()
        decode = store.LazyNodesMap._decode
        children = ledger.Org.org_children
        def count_guard(org, name, *args, **kwargs):
            if name == 'a':
                raise AssertionError('hire cap decoded archived sibling')
            return children(org,name,*args,**kwargs)
        def guard(nodes, name, *args):
            if name.startswith('cap-archive-'):
                raise AssertionError('hire cap decoded archived sibling')
            return decode(nodes, name, *args)
        with store._POOL.acquire(self.slug) as c:
            before = c.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
        with patch.object(store.LazyNodesMap, '_decode', guard), patch.object(ledger.Org, 'org_children', count_guard):
            with patch.object(graph, 'placement_children', return_value=None):
                with self.assertRaisesRegex(AssertionError, 'decoded archived sibling'):
                    self.public('fault-birth')
            result = self.public('new')
        self.assertEqual(result['node'], 'new')
        with store._POOL.acquire(self.slug) as c:
            self.assertEqual(c.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0],before+1)
            self.assertIsNone(c.raw.execute("SELECT id FROM orgtree.agents WHERE name='fault-birth' AND NOT tombstone").fetchone())
        print('Removed hire-cap path fault reached; archived-body guard caught it; restored public call committed once',flush=True)


if __name__ == '__main__':
    unittest.main()