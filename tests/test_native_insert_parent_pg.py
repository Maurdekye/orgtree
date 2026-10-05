"""Public native rehire-and-insert preserves a valid final graph atomically."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
from orgtree import api, ledger, orgtx, pgdoor, store
from orgtree.orgdb import graph, native_move
from orgtree.orgdb.compat import rows as R


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class NativeInsertParent(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values

    def snapshot(self):
        with store._POOL.acquire(self.slug) as conn:
            revision = conn.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
            rows = conn.raw.execute('SELECT id,name,tombstone,state,parent_id,row_version '
                                    'FROM orgtree.agents ORDER BY id').fetchall()
        return revision, rows

    def accepted_writes(self, raw, order=('a', 'leaf')):
        before = {name: text for name, text, _ in R.nodes(raw, list(order), lock=True)}
        writes = []
        for name in order:
            value = json.loads(before[name])
            value['parent'] = 'leaf' if name == 'a' else 'boss'
            value['unknown_insertion_payload'] = {'escaped': '\u0000\ud800', 'value': [name]}
            writes.append((name, store._dumps(value), before[name]))
        return writes

    def test_helper_orders_both_input_orders_and_preserves_payload_without_handoff(self):
        before = self.snapshot()
        for order in (('a', 'leaf'), ('leaf', 'a')):
            with self.subTest(order=order), store._POOL.acquire(self.slug) as conn:
                with conn.raw.transaction():
                    conn.raw.execute('SAVEPOINT insertion_order_test')
                    names = R.Names(conn.raw)
                    writes = self.accepted_writes(conn.raw, order)
                    cache = dict(names.by_name)
                    arranged = graph.write_order(conn.raw, writes, names)
                    self.assertEqual([write[0] for write in arranged], ['leaf', 'a'])
                    self.assertEqual(writes, self.accepted_writes(conn.raw, order))
                    self.assertEqual(names.by_name, cache)
                    self.assertFalse(graph._scalar_records(conn.raw))
                    for name, text, _ in arranged:
                        R.node_put(conn.raw, name, json.loads(text), names)
                    after = {name: json.loads(text) for name, text, _ in R.nodes(conn.raw, list(order))}
                    for name, text, _ in writes:
                        self.assertEqual(after[name], json.loads(text))
                    self.assertEqual(graph.verify_stats(conn.raw), [])
                    conn.raw.execute('ROLLBACK TO SAVEPOINT insertion_order_test')
                    conn.raw.execute('RELEASE SAVEPOINT insertion_order_test')
            self.assertEqual(self.snapshot(), before)

    def test_helper_preserves_raw_final_cycle_refusal_and_rollback(self):
        import psycopg
        before = self.snapshot()
        with store._POOL.acquire(self.slug) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                with conn.raw.transaction():
                    names = R.Names(conn.raw)
                    writes = self.accepted_writes(conn.raw)
                    value = json.loads(writes[1][1])
                    value['parent'] = 'a'
                    writes[1] = ('leaf', store._dumps(value), writes[1][2])
                    self.assertEqual(graph.write_order(conn.raw, writes, names), writes)
                    for name, text, _ in writes:
                        R.node_put(conn.raw, name, json.loads(text), names)
        self.assertEqual(self.snapshot(), before)

    def test_helper_missing_structural_coverage_widens_before_any_write(self):
        before = self.snapshot()
        with orgtx.org_tx(self.slug, nodes=['a', 'leaf']) as tx:
            raw = native_move.connection(tx.org)
            writes = self.accepted_writes(raw)
            with patch.object(R, 'node_put', side_effect=AssertionError('unexpected body write')):
                with self.assertRaises(pgdoor.Widen) as raised:
                    graph.write_order(raw, writes, R.Names(raw))
            self.assertTrue({'a', 'leaf'} & set(raised.exception.spec.structural_roots))
        self.assertEqual(self.snapshot(), before)

    def test_public_rehire_insert_preserves_identity_credit_and_one_revision(self):
        org = store.load_org(self.slug)
        org.retire('boss', 'leaf')
        store.save_org(org)
        before, rows = self.snapshot()
        identities = {row[1]: row[0] for row in rows if not row[2]}
        before_values = self.values()
        reference = ledger.Org(fixture.document(self.slug))
        args = dict(node='leaf', target='a', hire_type='superior')
        drive = []
        expected = api._rehire_seat(reference, self.slug, 'boss', args, drive, None, [])
        self.assertEqual(drive, [])
        writes = []
        original = R.node_put

        def trace_put(raw, name, value, *rest, **kwargs):
            writes.append((name, value.get('parent'), value.get('state')))
            return original(raw, name, value, *rest, **kwargs)

        try:
            with patch.object(R, 'node_put', side_effect=trace_put):
                result = api.agent_call(api.AgentCall(org=self.slug, node='boss',
                    tool='orgtree_rehire', args=args), endpoints.REQUEST)
        except Exception:
            self.assertEqual(self.snapshot(), (before, rows))
            self.assertEqual(self.values(), before_values)
            print('native insertion node writes before refusal:', writes, flush=True)
            raise
        self.assertNotIn('error', result)
        for key, value in expected.items():
            self.assertEqual(result.get(key), value, key)
        after, changed = self.snapshot()
        self.assertEqual(after, before + 1)
        self.assertEqual({row[1]: row[0] for row in changed if not row[2]}, identities)
        self.assertEqual(self.values(), {name: (node['parent'], node['grant'])
                                        for name, node in reference.nodes.items()})
        self.assertEqual(self.values()['leaf'][0], 'boss')
        self.assertEqual(self.values()['a'][0], 'leaf')
        with store._POOL.acquire(self.slug) as conn:
            self.assertEqual(graph.verify_stats(conn.raw), [])


if __name__ == '__main__':
    unittest.main()
