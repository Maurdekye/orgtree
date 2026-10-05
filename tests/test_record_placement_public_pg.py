"""Public placement identities and independently witnessed early lock modes."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
import json
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
from orgtree import api, ledger, orgtx, store
from orgtree.orgdb import graph, native_move, registry
from orgtree.orgdb.compat import rows as R

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class PublicPlacement(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values

    def snapshot(self):
        with store._POOL.acquire(self.slug) as c:
            rev = c.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
            rows = c.raw.execute('SELECT id,name,tombstone,state FROM orgtree.agents '
                                 'ORDER BY id').fetchall()
        return rev, rows

    def assert_decoded_result(self, result, expected, reference):
        self.assertNotIn('error', result)
        # Compare every handler result field, including warnings and caller instructions.
        for key, value in expected.items():
            self.assertEqual(result[key], value, key)
        self.assertEqual(self.values(), {name: (node['parent'], node['grant'])
                                        for name, node in reference.nodes.items()})

    def test_public_hire_insert_reuses_minted_tombstone_identity_and_commits_once(self):
        with store._POOL.acquire(self.slug) as c, c.raw.transaction():
            minted = c.raw.execute('INSERT INTO orgtree.agents(name,tombstone) '
                                   "VALUES('new',true) RETURNING id").fetchone()[0]
        before, rows = self.snapshot()
        old_ids = {name: physical for physical, name, tomb, state in rows if not tomb}
        reference = ledger.Org(fixture.document(self.slug))
        body = api.Op(op='hire', actor=ledger.USER, tier='luna', name='new',
                      grant=0, parent='boss', above='a')
        expected = api._op_hire(reference, body, None)
        staged = graph.DECISION_STATS['staged']
        result = api.org_op(self.slug, body, endpoints.REQUEST)
        self.assert_decoded_result(result, expected, reference)
        after, rows = self.snapshot()
        self.assertEqual(after, before + 1)
        current = {name: (physical, state) for physical, name, tomb, state in rows if not tomb}
        self.assertEqual(current['new'], (minted, 'live'))
        for name, physical in old_ids.items():
            self.assertEqual(current[name][0], physical)
        self.assertGreater(graph.DECISION_STATS['staged'], staged)
        self.assertEqual(self.values()['new'][0], 'boss')
        self.assertEqual(self.values()['a'][0], 'new')
        self.assertEqual(self.values()['leaf'][0], 'a')

    def test_public_agent_rehire_insert_preserves_identity_results_and_credit(self):
        org = store.load_org(self.slug)
        org.retire('boss', 'leaf')
        store.save_org(org)
        before, rows = self.snapshot()
        old_ids = {name: physical for physical, name, tomb, state in rows if not tomb}
        self.assertEqual(next(state for physical, name, tomb, state in rows
                              if name == 'leaf' and not tomb), 'archived')
        reference = ledger.Org(fixture.document(self.slug))
        args = dict(node='leaf', target='a', hire_type='superior')
        drive = []
        expected = api._rehire_seat(reference, self.slug, 'boss', args, drive, None, [])
        self.assertEqual(drive, [])  # Fixture has notices, no waking mail or kickoff.
        staged = graph.DECISION_STATS['staged']
        before_values = self.values()
        writes = []
        original = R.node_put

        def trace_put(c, name, value, names):
            body = json.loads(value) if isinstance(value, str) else value
            writes.append(dict(name=name, parent=body.get('parent'), state=body.get('state')))
            return original(c, name, value, names)

        try:
            with patch.object(R, 'node_put', side_effect=trace_put):
                result = api.agent_call(api.AgentCall(org=self.slug, node='boss',
                    tool='orgtree_rehire', args=args), endpoints.REQUEST)
        except Exception:
            # Retain the failed public control; independently prove rollback before rethrowing.
            self.assertEqual(self.snapshot(), (before, rows))
            self.assertEqual(self.values(), before_values)
            print('rehire failed-save rollback verified; body writes:', writes, flush=True)
            raise
        self.assert_decoded_result(result, expected, reference)
        after, rows = self.snapshot()
        self.assertEqual(after, before + 1)
        current = {name: (physical, state) for physical, name, tomb, state in rows if not tomb}
        for name, physical in old_ids.items():
            self.assertEqual(current[name][0], physical)
        self.assertEqual(current['leaf'], (old_ids['leaf'], 'live'))
        self.assertGreater(graph.DECISION_STATS['staged'], staged)
        self.assertEqual(self.values()['leaf'][0], 'boss')
        self.assertEqual(self.values()['a'][0], 'leaf')

    def test_target_update_ancestor_share_and_stats_update_are_held_before_reads(self):
        import psycopg
        db = registry.lookup(self.slug)[1]
        with orgtx.org_tx(self.slug, nodes=['a', 'leaf'],
                         structural_roots=['a', 'leaf']) as tx:
            raw = native_move.connection(tx.org)
            plan = graph.current_plan(raw)
            ids = dict(raw.execute('SELECT name,id FROM orgtree.agents '
                                   'WHERE NOT tombstone').fetchall())
            self.assertEqual(set(plan['updates']), {'a', 'leaf'})
            self.assertTrue({ids['boss'], ids['a'], ids['leaf']} <= set(plan['stats']))
            with fixture.dbconn.connect(fixture.ADMIN, db) as other:
                # SHARE is compatible with an ancestor SHARE, but not target UPDATE.
                with other.transaction():
                    self.assertEqual(other.execute('SELECT id FROM orgtree.agents '
                        'WHERE id=%s FOR SHARE NOWAIT', (ids['boss'],)).fetchone(), (ids['boss'],))
                for table, column, physical, mode in (
                        ('agents', 'id', ids['a'], 'SHARE'),
                        ('agents', 'id', ids['boss'], 'NO KEY UPDATE'),
                        ('agent_subtree_stats', 'agent_id', ids['a'], 'SHARE'),
                        ('agent_subtree_stats', 'agent_id', ids['boss'], 'SHARE')):
                    with self.subTest(table=table, physical=physical, mode=mode):
                        with self.assertRaises(psycopg.errors.LockNotAvailable):
                            with other.transaction():
                                other.execute(f'SELECT {column} FROM orgtree.{table} '
                                    f'WHERE {column}=%s FOR {mode} NOWAIT', (physical,))
            self.assertEqual(graph.placement_depth(tx.org, raw, 'a', 'leaf'), 1)
            self.assertEqual(graph.placement_children(tx.org, raw, 'a'), 1)
        self.assertEqual(self.values(), self.before)


if __name__ == '__main__':
    unittest.main()
