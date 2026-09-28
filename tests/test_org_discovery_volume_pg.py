"""Equal-work discovery read volumes with tenfold inactive node history."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_org_discovery_behavior_pg as behavior
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import org_listing, pgstore, store

tearDownModule = behavior.tearDownModule


@unittest.skipUnless(behavior.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class DiscoveryVolume(unittest.TestCase):
    setUpClass = behavior.DiscoveryBehavior.__dict__['setUpClass']
    setUp = behavior.DiscoveryBehavior.setUp
    query = behavior.DiscoveryBehavior.query
    setting = behavior.DiscoveryBehavior.setting
    listing = behavior.DiscoveryBehavior.listing
    resolve = behavior.DiscoveryBehavior.resolve

    def test_fixed_active_discovery_rows_and_bytes_with_tenfold_history(self):
        import psycopg
        seed = store.load_org(self.slug).node('worker')
        results = []
        outputs = {}
        plans = []
        execute = pgstore.PgConn.execute
        for archived in (1154, 11540):
            with store._POOL.acquire(self.slug) as conn:
                conn.execute('BEGIN')
                conn.execute("DELETE FROM nodes WHERE id<>'worker'")
                rows = []
                for i in range(29 + archived):
                    node = dict(seed, state='live' if i < 29 else 'archived',
                                seat_id=f'seat-{i}', charter='retained content ' * 64)
                    rows.append((f'node-{i:05}', i+10, json.dumps(node)))
                conn.executemany('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)', rows)
                conn.execute('COMMIT')
                conn.execute('ANALYZE nodes')
                conn.execute('ANALYZE doc')
            for mode in ('legacy', 'metadata'):
                for entry, action in (('agent_discovery', self.listing), ('exact_resolver', self.resolve)):
                    count = {'rows': 0, 'bytes': 0}
                    one, many = psycopg.Cursor.fetchone, psycopg.Cursor.fetchall
                    def record(rows):
                        count['rows'] += len(rows)
                        count['bytes'] += sum(len(json.dumps(r, default=str, ensure_ascii=False).encode()) for r in rows)
                    def fetchone(cur):
                        row = one(cur)
                        if row is not None: record([row])
                        return row
                    def fetchall(cur):
                        rows = many(cur); record(rows); return rows
                    with ExitStack() as stack:
                        if mode == 'legacy':
                            stack.enter_context(patch.object(org_listing, '_native', return_value=False))
                        else:
                            stack.enter_context(patch.object(store, 'list_orgs', side_effect=AssertionError('full listing')))
                            stack.enter_context(patch.object(store, 'load_org', side_effect=AssertionError('full load')))
                        stack.enter_context(patch.object(psycopg.Cursor, 'fetchone', fetchone))
                        stack.enter_context(patch.object(psycopg.Cursor, 'fetchall', fetchall))
                        result = action()
                    self.assertGreater(count['rows'], 0)
                    outputs[archived, mode, entry] = result
                    results.append(dict(archived=archived, live=30, mode=mode, entry=entry, **count))
            def explain(conn, sql, params=()):
                if sql.startswith('SELECT key,CASE key'):
                    plans.append(execute(conn, 'EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, params).fetchone()[0])
                return execute(conn, sql, params)
            with patch.object(pgstore.PgConn, 'execute', explain):
                org_listing._metadata(self.slug)
        print('DISCOVERY_VOLUME ' + json.dumps(results), flush=True)
        print('DISCOVERY_PLANS ' + json.dumps(plans), flush=True)
        dest = os.environ.get('DISCOVERY_VOLUME_OUTPUT')
        if dest: Path(dest).write_text(json.dumps({'rows': results, 'plans': plans}, indent=2))
        for entry in ('agent_discovery', 'exact_resolver'):
            for archived in (1154, 11540):
                self.assertEqual(outputs[archived, 'legacy', entry], outputs[archived, 'metadata', entry])
            new = [r for r in results if r['mode']=='metadata' and r['entry']==entry]
            old = [r for r in results if r['mode']=='legacy' and r['entry']==entry]
            self.assertEqual(new[0]['rows'], new[1]['rows'])
            self.assertEqual(new[0]['bytes'], new[1]['bytes'])
            self.assertGreater(old[1]['bytes'], 5 * old[0]['bytes'])
        def walk(plan):
            self.assertNotEqual(plan.get('Relation Name'), 'nodes')
            for child in plan.get('Plans', []): walk(child)
        for plan in plans: walk(plan[0]['Plan'])


if __name__ == '__main__': unittest.main()
