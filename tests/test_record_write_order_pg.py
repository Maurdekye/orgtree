"""Reached accepted-CAS ordering, rollback, stale inputs and native coverage."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
from orgtree import orgtx, pgdoor, store
from orgtree.orgdb import graph, native_move
from orgtree.orgdb.compat import rows as R, sql as S

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class AcceptedOrder(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values

    def snapshot(self):
        with store._POOL.acquire(self.slug) as conn:
            revision = conn.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
            rows = conn.raw.execute('SELECT id,name,tombstone,state,parent_id,row_version '
                                   'FROM orgtree.agents ORDER BY id').fetchall()
            bodies = R.nodes(conn.raw)
            stats = conn.raw.execute('SELECT * FROM orgtree.agent_subtree_stats '
                                    'ORDER BY agent_id').fetchall()
        return revision, rows, bodies, stats

    def inputs(self, conn, order=('a', 'leaf')):
        bodies = {name: text for name, text, _ in R.nodes(conn.raw, list(order), lock=True)}
        values = []
        for name in order:
            value = json.loads(bodies[name])
            value['parent'] = 'leaf' if name == 'a' else 'boss'
            value['ordered_payload'] = {'escaped': '\u0000\ud800', 'list': [name]}
            values.append(store._dumps(value))
        return list(order), values, [bodies[name] for name in order]

    def test_both_input_orders_write_final_parent_first_but_return_input_order(self):
        before = self.snapshot()
        for order in (('a', 'leaf'), ('leaf', 'a')):
            with self.subTest(order=order), store._POOL.acquire(self.slug) as conn:
                with conn.raw.transaction():
                    conn.raw.execute('SAVEPOINT ordered_body')
                    inputs = self.inputs(conn, order)
                    written = []
                    original = S._node_write

                    def trace(c, name, text, checked):
                        written.append((name, text, checked))
                        return original(c, name, text, checked)

                    with patch.object(S, '_node_write', side_effect=trace):
                        result = S._nodes_cas_batch(conn, inputs)
                    self.assertEqual(result.fetchall(), [(name,) for name in order])
                    self.assertEqual(result.rowcount, 2)
                    self.assertEqual([row[0] for row in written], ['leaf', 'a'])
                    expected = dict(zip(inputs[0], inputs[1]))
                    for name, text, checked in written:
                        self.assertEqual(text, expected[name])
                        self.assertIsNone(checked)
                    loaded = {name: json.loads(text) for name, text, _ in R.nodes(conn.raw, list(order))}
                    self.assertEqual(loaded, {name: json.loads(text) for name, text in expected.items()})
                    self.assertEqual(graph.verify_stats(conn.raw), [])
                    conn.raw.execute('ROLLBACK TO SAVEPOINT ordered_body')
                    conn.raw.execute('RELEASE SAVEPOINT ordered_body')
            self.assertEqual(self.snapshot(), before)

    def test_stale_missing_empty_and_repeated_inputs_preserve_accepted_order_and_count(self):
        with store._POOL.acquire(self.slug) as conn:
            with conn.raw.transaction():
                before = {name: text for name, text, _ in R.nodes(conn.raw, ['a', 'b'])}
                a1, a2 = (json.loads(before['a']) for _ in range(2))
                a1['charter'], a2['charter'] = 'first accepted', 'last accepted'
                original = R.same
                comparisons = []

                def compare(actual, expected):
                    comparisons.append((actual, expected))
                    return original(actual, expected)

                with patch.object(R, 'same', side_effect=compare):
                    result = S._nodes_cas_batch(conn, (['a', 'missing', 'b', 'a'],
                        [store._dumps(a1), '{}', before['b'], store._dumps(a2)],
                        [before['a'], '{}', '{}', before['a']]))
                self.assertEqual(result.fetchall(), [('a',), ('a',)])
                self.assertEqual(result.rowcount, 2)
                self.assertEqual(comparisons.count((before['a'], before['a'])), 2)
                self.assertEqual(comparisons.count((before['b'], '{}')), 1)
                self.assertEqual(json.loads(R.nodes(conn.raw, ['a'])[0][1]), a2)
                with patch.object(graph, 'write_order', wraps=graph.write_order) as helper:
                    empty = S._nodes_cas_batch(conn, ([], [], []))
                self.assertEqual(empty.fetchall(), [])
                self.assertEqual(empty.rowcount, 0)
                self.assertEqual(helper.call_args.args[1], [])

    def test_removed_helper_reaches_original_cycle_then_restored_adapter_commits_once(self):
        import psycopg
        before = self.snapshot()
        with store._POOL.acquire(self.slug) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                with conn.raw.transaction():
                    inputs = self.inputs(conn)
                    with patch.object(graph, 'write_order', side_effect=lambda raw, writes, names: writes):
                        S._nodes_cas_batch(conn, inputs)
        self.assertEqual(self.snapshot(), before)
        with store._POOL.acquire(self.slug) as conn:
            with conn.raw.transaction():
                result = S._nodes_cas_batch(conn, self.inputs(conn))
                self.assertEqual(result.fetchall(), [('a',), ('leaf',)])
        after = self.snapshot()
        self.assertEqual(after[0], before[0] + 1)
        self.assertEqual([(r[0], r[1]) for r in after[1]], [(r[0], r[1]) for r in before[1]])

    def test_mid_write_fault_rolls_back_savepoint_and_fresh_retry_keeps_one_revision(self):
        before = self.snapshot()
        with store._POOL.acquire(self.slug) as conn:
            with conn.raw.transaction():
                inputs = self.inputs(conn)
                original = S._node_write
                reached = []

                def fail_second(c, name, text, checked):
                    reached.append(name)
                    if len(reached) == 2:
                        raise RuntimeError('fault after rising parent was written')
                    return original(c, name, text, checked)

                with self.assertRaisesRegex(RuntimeError, 'fault after rising'):
                    with conn.raw.transaction():
                        with patch.object(S, '_node_write', side_effect=fail_second):
                            S._nodes_cas_batch(conn, inputs)
                self.assertEqual(reached, ['leaf', 'a'])
                self.assertEqual(graph.verify_stats(conn.raw), [])
                self.assertEqual({name: text for name, text, _ in R.nodes(conn.raw, inputs[0])},
                                 dict(zip(inputs[0], inputs[2])))
                result = S._nodes_cas_batch(conn, self.inputs(conn))
                self.assertEqual(result.rowcount, 2)
        self.assertEqual(self.snapshot()[0], before[0] + 1)

    def test_native_missing_coverage_widens_before_first_accepted_body_write(self):
        before = self.snapshot()
        with orgtx.org_tx(self.slug, nodes=['a', 'leaf']) as tx:
            raw = native_move.connection(tx.org)
            # The production compatibility object remains pinned on this transaction.
            conn = store._orgtx_local.pinned[self.slug]
            self.assertIs(conn.raw, raw)
            with patch.object(S, '_node_write', side_effect=AssertionError('late body write')):
                with self.assertRaises(pgdoor.Widen):
                    S._nodes_cas_batch(conn, self.inputs(conn))
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
