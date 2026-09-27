"""Actual PostgreSQL candidate filtering, relationship closure and snapshots."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='policy-candidates-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=root.name, ORGTREE_V2_TOKEN='test')
import test_mail_archive_bounds_pg as fixture
from engine.launch import load_app
load_app()
from orgtree import pgstore, policy_candidates as candidates, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class CandidateReads(unittest.TestCase):
    setUpClass = classmethod(fixture.MailArchiveBounds.setUpClass.__func__)
    setUp = fixture.MailArchiveBounds.setUp
    query = fixture.MailArchiveBounds.query

    def node(self, nid, **fields):
        row = dict(state='archived', parent=None)
        row.update(fields)
        self.query('INSERT INTO nodes(id,ord,val) VALUES(?,?,?) '
                   'ON CONFLICT(id) DO UPDATE SET val=excluded.val',
                   (nid, 100 + len(self.query('SELECT id FROM nodes')), json.dumps(row)))
        return row

    def test_python_truthy_freezes_and_live_nodes_are_exact_candidates(self):
        cases = [None, False, 0, 0.0, '', [], {}, True, 1, -1, 'false', [0], {'limit': True}]
        expected = {'worker'}
        for i, frozen in enumerate(cases):
            nid = f'freeze-{i}'
            self.node(nid, frozen=frozen)
            if frozen: expected.add(nid)
        graph = candidates.read(self.slug)
        self.assertEqual(set(graph.candidates), expected)
        self.assertEqual(set(graph.nodes), expected)

    def test_ancestors_and_predecessors_are_read_but_not_promoted_to_candidates(self):
        self.node('ancestor')
        self.node('retired-parent', parent='ancestor')
        self.node('old-cache-owner')
        self.node('worker', state='live', parent='retired-parent', predecessor='old-cache-owner')
        self.node('unrelated')
        graph = candidates.read(self.slug)
        self.assertEqual(graph.candidates, ('worker',))
        self.assertEqual(set(graph.nodes), {'worker', 'retired-parent', 'ancestor', 'old-cache-owner'})
        self.assertEqual(graph.nodes['worker']['parent'], 'retired-parent')
        self.node('retired-parent', parent='worker')  # closure terminates even on legacy cycle
        self.assertEqual(set(candidates.read(self.slug).nodes), {'worker', 'retired-parent', 'old-cache-owner'})
        self.node('worker', state='live', parent='missing')
        graph = candidates.read(self.slug)
        self.assertEqual(graph.nodes['worker']['parent'], 'missing')
        self.assertNotIn('missing', graph.nodes)

    def test_native_index_tracks_updates_rollback_and_delete(self):
        self.node('archived')
        self.assertNotIn('archived', candidates.read(self.slug).candidates)
        self.node('archived', frozen={'connection': True})
        self.assertIn('archived', candidates.read(self.slug).candidates)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("UPDATE nodes SET val='{}' WHERE id='archived'")
            conn.execute('ROLLBACK')
        self.assertIn('archived', candidates.read(self.slug).candidates)
        self.node('archived', frozen={})
        self.assertNotIn('archived', candidates.read(self.slug).candidates)
        self.query("DELETE FROM nodes WHERE id='worker'")
        self.assertEqual(candidates.read(self.slug).candidates, ())

    def test_runtime_role_new_schema_and_idempotent_install_keep_raw_rows(self):
        with pgstore.connect(os.environ['ORGTREE_PG_URL']) as raw:
            raw.execute('SET LOCAL ROLE orgtree_runtime')
            oid = raw.execute("INSERT INTO public.orgs(slug) VALUES('policy-runtime') RETURNING org_id").fetchone()[0]
            schema = raw.execute('SELECT public.orgtree_create_org_schema(%s)', (oid,)).fetchone()[0]
            raw.execute(f"INSERT INTO {schema}.nodes(id,ord,val) VALUES('a',0,'{{\"state\":\"live\"}}')")
            self.assertIsNotNone(raw.execute('SELECT to_regclass(%s)', (schema+'.ix_policy_candidates',)).fetchone()[0])
            self.assertEqual(raw.execute(f'SELECT id FROM {schema}.nodes').fetchone()[0], 'a')
        before = self.query('SELECT id,ord,val FROM nodes ORDER BY ord,id')
        with store._POOL.acquire(self.slug) as conn:
            for _ in range(2): conn.execute('SELECT public.orgtree_install_policy_candidates(?)', (conn.org_id,))
        self.assertEqual(self.query('SELECT id,ord,val FROM nodes ORDER BY ord,id'), before)
        real = pgstore.PgConn.execute
        def runtime(conn, sql, params=()):
            if sql == candidates.FIRST_PAGE: real(conn, 'SET LOCAL ROLE orgtree_runtime')
            return real(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', runtime):
            self.assertEqual(candidates.read(self.slug).candidates, ('worker',))

    def test_graph_and_callback_share_snapshot_across_concurrent_retirement(self):
        self.query("UPDATE doc SET val='false' WHERE key='killswitch'")
        def project(conn, graph):
            with pgstore.connect(os.environ['ORGTREE_PG_URL']) as writer:
                writer.execute(f"UPDATE org_{conn.org_id}.nodes SET val='{{\"state\":\"archived\"}}' WHERE id='worker'")
                writer.execute(f"UPDATE org_{conn.org_id}.doc SET val='true' WHERE key='killswitch'")
            self.assertEqual(graph.nodes['worker']['state'], 'live')
            self.assertEqual(conn.execute("SELECT val FROM doc WHERE key='killswitch'").fetchone()[0], 'false')
            self.assertEqual(conn.execute('SHOW transaction_read_only').fetchone()[0], 'on')
            return graph
        self.assertEqual(candidates.read(self.slug, project).candidates, ('worker',))
        self.assertEqual(candidates.read(self.slug).candidates, ())

    def test_legacy_blob_or_missing_index_requests_full_fallback(self):
        self.query("INSERT INTO doc(key,val) VALUES('nodes','{}')")
        self.assertIsNone(candidates.read(self.slug))
        self.query("DELETE FROM doc WHERE key='nodes'")
        self.query('DROP INDEX ix_policy_candidates')
        self.assertIsNone(candidates.read(self.slug))

    def test_plan_visits_candidates_and_required_relations_not_retired_history(self):
        seed = store.load_org(self.slug).node('worker')
        with store._POOL.acquire(self.slug) as conn:
            for i in range(1183):
                row = dict(seed, state='live' if i < 29 else 'archived', charter='history ' * 100)
                conn.execute('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)',
                             (f'history-{i:04}', i+100, json.dumps(row)))
            conn.execute('ANALYZE nodes')
            plan = conn.execute('EXPLAIN (ANALYZE, FORMAT JSON) '+candidates.FIRST_PAGE).fetchone()[0]
        graph = candidates.read(self.slug)
        self.assertEqual(len(graph.candidates), 30)
        self.assertEqual(len(graph.nodes), 30)
        seen = []
        def walk(node):
            if node.get('Relation Name') == 'nodes':
                seen.append(node)
                self.assertIn('Index', node['Node Type'], json.dumps(plan))
                self.assertLessEqual(node['Actual Rows'], 30)
                self.assertEqual(node.get('Rows Removed by Filter', 0), 0)
            for child in node.get('Plans', []): walk(child)
        walk(plan[0]['Plan'])
        self.assertTrue(seen)
        self.assertTrue(any(n.get('Index Name') == 'ix_policy_candidates' for n in seen))

    def test_multiple_pages_preserve_equal_ordinal_candidates_without_drops(self):
        with store._POOL.acquire(self.slug) as conn:
            for i in range(270):
                conn.execute('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)',
                             (f'candidate-{i:04}', 100, '{"state":"live"}'))
        graph = candidates.read(self.slug)
        self.assertEqual(len(graph.candidates), 271)
        self.assertEqual(len(set(graph.candidates)), 271)
        self.assertEqual(graph.candidates[1:], tuple(f'candidate-{i:04}' for i in range(270)))


if __name__ == '__main__': unittest.main()
