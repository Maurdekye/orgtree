"""Actual API move dispatch on owned org databases; no whole preflight/save.

Calls the production API handlers (not an HTTP transport benchmark). Creation,
migration and teardown use the existing disposable compatibility fixture.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import contextlib
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import test_orgdb_compat_pg as fixture
from orgtree import api, ledger, orgtx, pgdoor, store, supervisor
from orgtree.orgdb import graph, native_move
from orgtree.orgdb import conn as native_conn, registry
from orgtree.orgdb.compat import rows as R

REQUEST = SimpleNamespace(state=SimpleNamespace(), headers={})


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class NativeMoveEndpoints(unittest.TestCase):
    def setUp(self):
        self.enterContext(fixture.storage(True))
        self.enterContext(patch.object(pgdoor, 'enabled', return_value=True))
        self.enterContext(patch.object(api, 'hub_changed'))
        self.enterContext(patch.object(supervisor, 'send_message', return_value={}))
        self.slug = 'native-move-' + uuid.uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 50, 'boss')
        org.hire(ledger.USER, 'boss', 'luna', 5, 'a')
        org.hire(ledger.USER, 'boss', 'luna', 5, 'b')
        org.hire(ledger.USER, 'a', 'luna', 0, 'leaf')
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, self.slug)
        self.before = self.values()

    def values(self):
        org = store.load_org(self.slug)
        return {name: (node['parent'], node['grant']) for name, node in org.nodes.items()}

    @contextlib.contextmanager
    def bounded_path(self):
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole preflight')), \
                patch.object(store, 'write_org', side_effect=AssertionError('whole write cycle')), \
                patch.object(ledger.Org, 'descendants', side_effect=AssertionError('descendant walk')), \
                patch.object(ledger.Org, 'descendant_set', side_effect=AssertionError('descendant union')), \
                patch.object(ledger.Org, '_sweep_dirs', side_effect=AssertionError('scope sweep')), \
                patch.object(ledger.Org, '_sweep_audiences', side_effect=AssertionError('audience sweep')), \
                patch.object(native_move, 'persist', wraps=native_move.persist) as persist, \
                patch.object(R, 'node_put', wraps=R.node_put) as put:
            yield persist, put

    def test_operator_handler_routes_to_scalar_move_without_whole_plan_or_node_put(self):
        with self.bounded_path() as (persist, put):
            result = api.org_op(self.slug, api.Op(op='move', actor=ledger.USER,
                                                 node='a', new_parent='b'), REQUEST)
        self.assertNotIn('error', result)
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(put.call_count, 0)
        self.assertEqual(self.values()['a'][0], 'b')
        self.assertEqual(self.values()['leaf'][0], 'a')

    def test_agent_handler_routes_to_scalar_move_with_current_authority(self):
        with self.bounded_path() as (persist, put):
            result = api.agent_call(api.AgentCall(org=self.slug, node='boss', tool='orgtree_move',
                                                  args={'node': 'a', 'new_parent': 'b'}), REQUEST)
        self.assertNotIn('error', result)
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(put.call_count, 0)
        after = self.values()
        self.assertEqual(after['a'][0], 'b')
        self.assertEqual(after['leaf'], self.before['leaf'])
        self.assertEqual(after['boss'][1], self.before['boss'][1])
        self.assertEqual(after['b'][1], self.before['b'][1] + self.before['a'][1] + 0.1)

    def test_agent_batch_failure_rolls_back_earlier_scalar_leg_and_receipt(self):
        from fastapi import HTTPException
        with self.bounded_path() as (persist, _):
            with self.assertRaises((ledger.LedgerError, HTTPException)):
                api.agent_call(api.AgentCall(org=self.slug, node='boss', tool='orgtree_move',
                               args={'moves': [{'node': 'a', 'new_parent': 'b'},
                                               {'node': 'a', 'new_parent': 'a'}]}), REQUEST)
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(self.values(), self.before)

    def test_standalone_move_uses_the_same_selected_prediction_and_scalar_body(self):
        from orgtree import lifecycle_tx
        with self.bounded_path() as (persist, put):
            lifecycle_tx.move(self.slug, ledger.USER, 'a', 'b')
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(put.call_count, 0)
        self.assertEqual(self.values()['a'][0], 'b')

    def configure_capabilities(self):
        org = store.load_org(self.slug)
        for name in ('boss', 'a', 'b', 'leaf'):
            org.node(name)['scope']['tools']['bash'] = True
        org.node('b')['scope']['tools']['bash'] = False
        store.save_org(org)

    def test_locked_scope_uses_current_chain_and_move_back_restores_configured_grants(self):
        self.configure_capabilities()
        configured = copy.deepcopy(store.load_org(self.slug).node('leaf')['scope'])
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            self.assertTrue(tx.org.capability_scope('leaf')['tools']['bash'])
            raw = native_move.connection(tx.org)
            self.assertEqual(graph.current_plan(raw)['stats'], [])
        with self.bounded_path():
            api.org_op(self.slug, api.Op(op='move', actor=ledger.USER,
                                        node='a', new_parent='b'), REQUEST)
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            self.assertFalse(tx.org.capability_scope('leaf')['tools']['bash'])
            self.assertFalse(tx.org._holds_scope_item('leaf', {'kind': 'tool', 'tool': 'bash'}))
            self.assertEqual(tx.org.node('leaf')['scope'], configured)
        with self.bounded_path():
            api.org_op(self.slug, api.Op(op='move', actor=ledger.USER,
                                        node='a', new_parent='boss'), REQUEST)
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            self.assertTrue(tx.org.capability_scope('leaf')['tools']['bash'])
            self.assertEqual(tx.org.node('leaf')['scope'], configured)

    def test_scope_prelock_path_replacement_retries_before_authorizing_action(self):
        import psycopg
        self.configure_capabilities()
        row = registry.lookup(self.slug)
        attempts = []
        original = graph.plan_locks

        def replace_after_prediction(raw, tx):
            plan = original(raw, tx)
            attempts.append(plan)
            if len(attempts) == 1:
                with psycopg.connect(native_conn.with_db(fixture.ADMIN, row[1]),
                                     autocommit=True) as other:
                    with other.transaction():
                        other.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM "
                                      "orgtree.agents WHERE name='b') WHERE name='a'")
            return plan

        bodies = []
        with patch.object(graph, 'plan_locks', side_effect=replace_after_prediction):
            with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
                bodies.append(tx.org.capability_scope('leaf')['tools']['bash'])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(bodies, [False])
        self.assertTrue(all(not plan.stats_ids for plan in attempts))

    def test_scope_action_holds_ancestor_share_until_write_finishes(self):
        import psycopg
        self.configure_capabilities()
        row = registry.lookup(self.slug)
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            self.assertTrue(tx.org.capability_scope('leaf')['tools']['bash'])
            with psycopg.connect(native_conn.with_db(fixture.ADMIN, row[1]),
                                 autocommit=True) as other:
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    with other.transaction():
                        other.execute("SET LOCAL lock_timeout='100ms'")
                        other.execute("UPDATE orgtree.agents SET row_version=row_version+1 "
                                      "WHERE name='boss'")
            tx.org.node('leaf')['charter'] = 'authorized while its chain remains held'
        self.assertEqual(store.load_org(self.slug).node('leaf')['charter'],
                         'authorized while its chain remains held')


if __name__ == '__main__':
    unittest.main()
