"""Public native rehire-and-insert preserves a valid final graph atomically."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import contextlib
import json
import random
import sqlite3
import statistics
import time
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
from orgtree import api, ledger, orgtx, pgdoor, store
from orgtree.orgdb import graph, native_move
from orgtree.orgdb.compat import rows as R
from orgtree.orgdb.compat import sql as S


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

    @contextlib.contextmanager
    def rollback_batch(self):
        with store._POOL.acquire(self.slug) as conn, conn.raw.transaction():
            conn.raw.execute('SAVEPOINT order_control')
            try:
                yield conn
            finally:
                conn.raw.execute('ROLLBACK TO SAVEPOINT order_control')
                conn.raw.execute('RELEASE SAVEPOINT order_control')

    def batch(self, conn, writes):
        return S._nodes_cas_batch(conn, tuple([write[i] for write in writes] for i in range(3)))

    def test_adapter_keeps_input_results_and_compares_each_old_image_once(self):
        before = self.snapshot()
        for order in (('a', 'leaf'), ('leaf', 'a')):
            with self.subTest(order=order), self.rollback_batch() as conn:
                writes = self.accepted_writes(conn.raw, order)
                executed = []
                original = R.node_put

                def put(raw, name, value, names):
                    executed.append(name)
                    return original(raw, name, value, names)

                with patch.object(R, 'same', wraps=R.same) as same, \
                        patch.object(R, 'node_put', side_effect=put):
                    result = self.batch(conn, writes)
                self.assertEqual(same.call_count, 2)
                self.assertEqual(executed, ['leaf', 'a'])
                self.assertEqual(result.fetchall(), [(name,) for name in order])
                self.assertEqual(result.rowcount, 2)
                self.assertEqual(graph.verify_stats(conn.raw), [])
            self.assertEqual(self.snapshot(), before)

    def test_adapter_stale_and_missing_rows_never_enter_the_parent_overlay(self):
        import psycopg
        before = self.snapshot()
        with self.rollback_batch() as conn:
            writes = self.accepted_writes(conn.raw)
            writes[0] = ('a', writes[0][1], '{}')
            writes.append(('missing', '{}', '{}'))
            with patch.object(R, 'node_put', wraps=R.node_put) as put:
                result = self.batch(conn, writes)
            self.assertEqual(result.fetchall(), [('leaf',)])
            self.assertEqual(result.rowcount, 1)
            self.assertEqual(put.call_count, 1)
            self.assertEqual(put.call_args.args[1], 'leaf')
            self.assertEqual(self.values()['a'][0], 'boss')
        self.assertEqual(self.snapshot(), before)
        # The rejected leaf detachment must not make the accepted a->leaf
        # appear acyclic: only the real accepted subset may guide the helper.
        with self.rollback_batch() as conn:
            writes = self.accepted_writes(conn.raw)
            writes[1] = ('leaf', writes[1][1], '{}')
            with self.assertRaises(psycopg.errors.CheckViolation):
                self.batch(conn, writes)
        self.assertEqual(self.snapshot(), before)

    def test_adapter_repeated_inputs_keep_occurrences_and_last_body(self):
        with self.rollback_batch() as conn:
            old = R.nodes(conn.raw, ['a'], lock=True)[0][1]
            first, second = json.loads(old), json.loads(old)
            first['unknown_insertion_payload'] = {'occurrence': 1}
            second['unknown_insertion_payload'] = {'occurrence': 2}
            writes = [('a', store._dumps(value), old) for value in (first, second)]
            with patch.object(R, 'same', wraps=R.same) as same:
                result = self.batch(conn, writes)
            self.assertEqual(same.call_count, 2)
            self.assertEqual(result.fetchall(), [('a',), ('a',)])
            self.assertEqual(result.rowcount, 2)
            self.assertEqual(json.loads(R.nodes(conn.raw, ['a'])[0][1]), second)
            self.assertEqual(graph.verify_stats(conn.raw), [])

    def test_helper_follows_unchanged_intermediate_ancestors(self):
        with self.rollback_batch() as conn:
            # boss->a->middle->leaf becomes boss->leaf->a->middle.
            # The unchanged middle edge must participate in final ordering.
            names = R.Names(conn.raw)
            R.node_put(conn.raw, 'middle', fixture.node('middle', 'a'), names)
            leaf = json.loads(R.nodes(conn.raw, ['leaf'])[0][1])
            leaf['parent'] = 'middle'
            R.node_put(conn.raw, 'leaf', leaf, names)
            writes = self.accepted_writes(conn.raw)
            result = self.batch(conn, writes)
            self.assertEqual(result.fetchall(), [('a',), ('leaf',)])
            found = {n: json.loads(text).get('parent')
                     for n, text, _ in R.nodes(conn.raw, ['a', 'middle', 'leaf'])}
            self.assertEqual(found, {'a': 'leaf', 'middle': 'a', 'leaf': 'boss'})
            self.assertEqual(graph.verify_stats(conn.raw), [])

    def test_cached_namesake_empty_and_misfit_parents_match_existing_codec(self):
        with self.rollback_batch() as conn:
            from psycopg.types.json import Json
            raw = conn.raw
            alias = raw.execute("INSERT INTO orgtree.agents(name,tombstone) "
                                "VALUES('boss',true) RETURNING id").fetchone()[0]
            empty = raw.execute("INSERT INTO orgtree.agents(name,tombstone) "
                                "VALUES('',true) RETURNING id").fetchone()[0]
            original = R.nodes(raw, ['a'])[0][1]
            for parent in ('boss', '', None, 7, '\x00', '\ud800', {'odd': 1}, 'new-parent'):
                with self.subTest(parent=repr(parent)):
                    raw.execute('SAVEPOINT parent_codec')
                    value = json.loads(original)
                    value['parent'] = parent
                    value['unknown_insertion_payload'] = {'escaped': '\x00\ud800'}
                    text = store._dumps(value)
                    names = R.Names(raw)
                    if parent == 'boss':
                        # A previously resolved tombstone namesake must keep
                        # its physical identity, exactly as DbContext does.
                        names.by_name['boss'] = int(alias)
                    cache = dict(names.by_name)
                    arranged = graph.write_order(raw, [('a', text, None)], names)
                    self.assertEqual(names.by_name, cache)
                    self.assertEqual(arranged, [('a', text, None)])
                    R.node_put(raw, 'a', value, names)
                    self.assertEqual(json.loads(R.nodes(raw, ['a'])[0][1]), value)
                    physical = raw.execute("SELECT parent_id FROM orgtree.agents "
                                           "WHERE name='a' AND NOT tombstone").fetchone()[0]
                    if parent == 'boss':
                        self.assertEqual(physical, alias)
                    elif parent == '':
                        self.assertEqual(physical, empty)
                    elif parent == 'new-parent':
                        self.assertEqual(physical, raw.execute("SELECT id FROM orgtree.agents "
                            "WHERE name='new-parent'").fetchone()[0])
                    else:
                        self.assertIsNone(physical)
                    self.assertEqual(graph.verify_stats(raw), [])
                    raw.execute('ROLLBACK TO SAVEPOINT parent_codec')
                    raw.execute('RELEASE SAVEPOINT parent_codec')

    def test_new_parent_head_in_batch_wins_over_cached_tombstone(self):
        with self.rollback_batch() as conn:
            raw = conn.raw
            alias = raw.execute("INSERT INTO orgtree.agents(name,tombstone) "
                                "VALUES('leaf',true) RETURNING id").fetchone()[0]
            names = R.Names(raw)
            names.by_name['leaf'] = int(alias)
            writes = self.accepted_writes(raw)
            arranged = graph.write_order(raw, writes, names)
            self.assertEqual([w[0] for w in arranged], ['leaf', 'a'])
            self.assertEqual(names.by_name['leaf'], alias)
            for name, text, _ in arranged:
                R.node_put(raw, name, json.loads(text), names)
            self.assertEqual(raw.execute("SELECT a.parent_id=l.id FROM orgtree.agents a "
                "JOIN orgtree.agents l ON l.name='leaf' AND NOT l.tombstone "
                "WHERE a.name='a' AND NOT a.tombstone").fetchone()[0], True)
            self.assertEqual(graph.verify_stats(raw), [])

    def test_adapter_partial_failure_savepoint_rollback_then_fresh_retry(self):
        before = self.snapshot()
        with self.rollback_batch() as conn:
            writes = self.accepted_writes(conn.raw)
            conn.raw.execute('SAVEPOINT failed_body')
            original = R.node_put
            count = 0

            def fail_second(raw, name, value, names):
                nonlocal count
                count += 1
                if count == 2:
                    raise RuntimeError('planted second-body failure')
                return original(raw, name, value, names)

            with patch.object(R, 'node_put', side_effect=fail_second):
                with self.assertRaisesRegex(RuntimeError, 'planted second-body'):
                    self.batch(conn, writes)
            self.assertEqual(count, 2)
            conn.raw.execute('ROLLBACK TO SAVEPOINT failed_body')
            conn.raw.execute('RELEASE SAVEPOINT failed_body')
            self.assertEqual({name: text for name, text, _ in R.nodes(conn.raw, ['a', 'leaf'])},
                             {name: old for name, _, old in writes})
            self.assertFalse(graph._scalar_records(conn.raw))
            self.assertEqual(self.batch(conn, self.accepted_writes(conn.raw)).rowcount, 2)
            self.assertEqual(graph.verify_stats(conn.raw), [])
        self.assertEqual(self.snapshot(), before)

    def test_many_final_acyclic_permutations_never_make_a_temporary_cycle(self):
        # Independent random rooted trees include crossing ancestors and
        # unchanged intermediates. Each save still exercises real eager SQL.
        rng = random.Random(90121)
        with self.rollback_batch() as conn:
            raw = conn.raw
            names = R.Names(raw)
            nodes = [f'order-{i}' for i in range(9)]
            for i, name in enumerate(nodes):
                R.node_put(raw, name, fixture.node(name, 'boss' if not i else nodes[i - 1]), names)
            for trial in range(12):
                raw.execute('SAVEPOINT permutation')
                final_order = rng.sample(nodes, len(nodes))
                desired = {name: rng.choice(['boss', *final_order[:i]])
                           for i, name in enumerate(final_order)}
                input_order = rng.sample(nodes, len(nodes))
                old = {name: text for name, text, _ in R.nodes(raw, nodes, lock=True)}
                writes = []
                for name in input_order:
                    value = json.loads(old[name])
                    value['parent'] = desired[name]
                    value['unknown_insertion_payload'] = {'trial': trial}
                    writes.append((name, store._dumps(value), old[name]))
                result = self.batch(conn, writes)
                self.assertEqual(result.fetchall(), [(name,) for name in input_order])
                self.assertEqual({name: json.loads(text)['parent'] for name, text, _ in
                                  R.nodes(raw, nodes)}, desired)
                self.assertEqual(graph.verify_stats(raw), [])
                raw.execute('ROLLBACK TO SAVEPOINT permutation')
                raw.execute('RELEASE SAVEPOINT permutation')

    def test_native_helper_uses_preheld_agent_and_stats_modes_without_late_locks(self):
        import psycopg
        from orgtree.orgdb import registry
        with orgtx.org_tx(self.slug, nodes=['a', 'leaf'],
                          structural_roots=['boss', 'a', 'leaf']) as tx:
            raw = native_move.connection(tx.org)
            plan = graph.current_plan(raw)
            paths = {name: int(aid) for aid, name in raw.execute(
                "SELECT id,name FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone",
                (['boss', 'a', 'leaf'],)).fetchall()}
            db = registry.lookup(self.slug)[1]
            with psycopg.connect(fixture._with_db(fixture.RUNTIME, db), autocommit=True) as probe:
                for name, mode in (('a', 'SHARE'), ('leaf', 'SHARE'), ('boss', 'UPDATE')):
                    with self.subTest(name=name), self.assertRaises(psycopg.errors.LockNotAvailable):
                        probe.execute('SELECT id FROM orgtree.agents WHERE id=%s FOR ' + mode +
                                      ' NOWAIT', (paths[name],))
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    probe.execute('SELECT agent_id FROM orgtree.agent_subtree_stats '
                                  'WHERE agent_id=%s FOR SHARE NOWAIT', (paths['boss'],))
            class ReadTrace:
                def execute(self, query, params=()):
                    self.queries.append(query)
                    return raw.execute(query, params)
            trace = ReadTrace()
            trace.queries = []
            writes = self.accepted_writes(raw)
            self.assertEqual([w[0] for w in graph.write_order(trace, writes, R.Names(raw))],
                             ['leaf', 'a'])
            self.assertTrue(trace.queries)
            for query in trace.queries:
                self.assertTrue(query.startswith(('SELECT ', 'WITH RECURSIVE ')), query)
                self.assertNotIn('FOR UPDATE', query)
                self.assertNotIn('FOR SHARE', query)
                self.assertNotIn('set_config', query)
            self.assertEqual(graph.current_plan(raw), plan)

    def test_name_preserving_physical_alias_change_widens_before_write(self):
        # The decoded parent stays boss, but the encoder selects the current
        # boss head instead of a retained tombstone with that name. The guard
        # must cover both physical paths even though the decoded name agrees.
        with store._POOL.acquire(self.slug) as conn, conn.raw.transaction():
            alias = conn.raw.execute("INSERT INTO orgtree.agents(name,tombstone) "
                                    "VALUES('boss',true) RETURNING id").fetchone()[0]
            conn.raw.execute("UPDATE orgtree.agents SET parent_id=%s WHERE name='a' "
                             "AND NOT tombstone", (alias,))
        before = self.snapshot()
        with orgtx.org_tx(self.slug, nodes=['a'], structural_roots=['a']) as tx:
            raw = native_move.connection(tx.org)
            old = R.nodes(raw, ['a'], lock=True)[0][1]
            self.assertEqual(json.loads(old)['parent'], 'boss')
            with patch.object(R, 'node_put', side_effect=AssertionError('late body write')):
                with self.assertRaises(pgdoor.Widen):
                    graph.write_order(raw, [('a', old, None)], R.Names(raw))
        self.assertEqual(self.snapshot(), before)

    def test_complete_helper_queries_stay_indexed_at_one_and_100k_subtree_rows(self):
        class CursorTrace:
            def __init__(self, cursor, record):
                self.cursor, self.record = cursor, record

            def fetchone(self):
                row = self.cursor.fetchone()
                self.record['returned'] += int(row is not None)
                return row

            def fetchall(self):
                rows = self.cursor.fetchall()
                self.record['returned'] += len(rows)
                return rows

        class QueryTrace:
            def __init__(self, raw):
                self.raw, self.records = raw, []

            def execute(self, query, params=()):
                record = {'sql': query, 'params': params, 'returned': 0}
                self.records.append(record)
                self_test.assertTrue(query.startswith(('SELECT ', 'WITH RECURSIVE ')), query)
                return CursorTrace(self.raw.execute(query, params), record)

        def nodes(plan):
            yield plan
            for child in plan.get('Plans', []):
                yield from nodes(child)

        def plans(raw, records):
            result = []
            for record in records:
                explained = raw.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' +
                                        record['sql'], record['params']).fetchone()[0][0]
                result.append({'query': record, 'explain': explained})
            return result

        def bounded(explained):
            total = 0
            for record in explained:
                for part in nodes(record['explain']['Plan']):
                    self.assertFalse(part.get('Relation Name') == 'agents' and
                                     part['Node Type'] == 'Seq Scan', record)
                    total += (part.get('Actual Rows', 0) +
                              part.get('Rows Removed by Filter', 0)) * part.get('Actual Loops', 1)
            self.assertLessEqual(total, 100)
            return total

        self_test = self
        measured = []
        with self.rollback_batch() as conn:
            raw = conn.raw
            leaf_id = raw.execute("SELECT id FROM orgtree.agents WHERE name='leaf' "
                                  'AND NOT tombstone').fetchone()[0]
            for size in (1, 100000):
                if size > 1:
                    raw.execute("INSERT INTO orgtree.agents(name,ord,state,parent_id) "
                                "SELECT 'order-scale-'||i,100+i,'live',%s "
                                'FROM generate_series(1,%s) i', (leaf_id, size - 1))
                    raw.execute('ANALYZE orgtree.agents')
                    raw.execute('ANALYZE orgtree.agent_subtree_stats')
                writes = self.accepted_writes(raw)
                before = raw.execute('SELECT id,parent_id,row_version FROM orgtree.agents '
                                     'WHERE id=ANY(%s)', ([leaf_id],)).fetchall()
                timing = []
                for _ in range(5):
                    trace = QueryTrace(raw)
                    started = time.perf_counter_ns()
                    arranged = graph.write_order(trace, writes, R.Names(raw))
                    timing.append((time.perf_counter_ns() - started) / 1000000)
                    self.assertEqual([w[0] for w in arranged], ['leaf', 'a'])
                    self.assertLessEqual(len(trace.records), 8)
                    self.assertLessEqual(sum(r['returned'] for r in trace.records), 12)
                explained = plans(raw, trace.records)
                # At the tiny shape a natural sequential scan is cheaper; the
                # 100k shape must prove every actual query's indexed bound.
                work = bounded(explained) if size > 1 else None
                measured.append({'subtree_size': size, 'queries': len(trace.records),
                    'returned_rows': sum(r['returned'] for r in trace.records),
                    'median_ms': statistics.median(timing), 'samples_ms': timing,
                    'examined_plan_work': work, 'complete_queries_and_plans': explained})
                self.assertEqual(raw.execute('SELECT id,parent_id,row_version FROM orgtree.agents '
                    'WHERE id=ANY(%s)', ([leaf_id],)).fetchall(), before)
                if size > 1:
                    raw.execute('SET LOCAL enable_indexscan=off')
                    raw.execute('SET LOCAL enable_bitmapscan=off')
                    try:
                        forced = QueryTrace(raw)
                        self.assertEqual([w[0] for w in graph.write_order(
                            forced, writes, R.Names(raw))], ['leaf', 'a'])
                        with self.assertRaises(AssertionError):
                            bounded(plans(raw, forced.records))
                    finally:
                        raw.execute('SET LOCAL enable_indexscan=on')
                        raw.execute('SET LOCAL enable_bitmapscan=on')
                    # Restoring the planner must restore the same measured gate.
                    bounded(plans(raw, trace.records))
            self.assertEqual(graph.verify_stats(raw), [])
        print('MEASURED insertion-order query plans: ' + json.dumps(measured), flush=True)

    def test_omitted_permutation_fault_fails_public_api_then_restored_passes(self):
        with patch.object(graph, 'write_order', side_effect=lambda _raw, writes, _names: writes):
            with self.assertRaisesRegex(sqlite3.IntegrityError, '23514.*parent cycle'):
                self.test_public_rehire_insert_preserves_identity_credit_and_one_revision()
        self.test_public_rehire_insert_preserves_identity_credit_and_one_revision()

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
