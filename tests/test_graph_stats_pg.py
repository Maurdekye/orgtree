"""Full org schema: eager raw/native aggregates, batch overlap and FK deletion."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import contextlib
import json
import os
from pathlib import Path
import random
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from orgtree import orgtx
from orgtree.orgdb import conn, graph, migrate

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DATABASE = 'qstats_' + uuid.uuid4().hex[:14]
needs_pg = unittest.skipUnless(ADMIN, 'requires an owned disposable PostgreSQL')

SEED = """
INSERT INTO orgtree.agents(id,name,parent_id,state,tombstone,successor_id) VALUES
 (1,'root',NULL,'live',false,NULL),(2,'a',1,'live',false,NULL),
 (3,'b',2,'archived',false,NULL),(4,'c',3,'live',false,NULL),
 (5,'destination',NULL,'live',false,NULL),(6,'hidden',1,NULL,true,NULL),
 (7,'under_hidden',6,'live',false,NULL),(8,'bearer',1,'archived',false,5),
 (9,'unrecoverable',1,'unrecoverable',false,5),(10,'',NULL,NULL,true,NULL),
 (11,'empty_successor',1,'archived',false,10)
"""


def setUpModule():
    if not ADMIN:
        return
    import psycopg
    from psycopg import sql
    conn.pgstore.refuse_live_cluster(ADMIN)
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DATABASE)))
    try:
        with psycopg.connect(conn.with_db(ADMIN, DATABASE), autocommit=True) as c:
            c.execute('CREATE SCHEMA orgtree')
            for migration in migrate.files(migrate.ORG_DIR):
                with c.transaction():
                    if migration.name == '0016_agent_graph.sql':
                        # A populated upgrade, not an empty-table-only backfill.
                        c.execute(SEED)
                    c.execute(migration.read_text(encoding='utf-8'))
    except BaseException:
        tearDownModule()
        raise


def tearDownModule():
    if not ADMIN:
        return
    import psycopg
    from psycopg import sql
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(DATABASE)))


@needs_pg
class GraphStats(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.c = psycopg.connect(conn.with_db(ADMIN, DATABASE), autocommit=True)
        self.addCleanup(self.c.close)
        self.c.execute('BEGIN')
        self.addCleanup(self.rollback)

    def rollback(self):
        with contextlib.suppress(Exception):
            self.c.execute('ROLLBACK')

    def check_reference(self):
        self.assertEqual(self.c.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall(), [])

    def stats(self, agent):
        return self.c.execute('SELECT parent_agent_id,descendants,height,org_children_count '
                              'FROM orgtree.agent_subtree_stats WHERE agent_id=%s', (agent,)).fetchone()

    def test_populated_backfill_matches_independent_reference_and_exact_axes(self):
        self.check_reference()
        self.assertEqual(self.stats(1), (None, 6, 3, 3))
        self.assertEqual(self.stats(6), (1, 1, -1, 1))
        self.assertEqual(self.stats(2), (1, 2, 2, 1))

    def test_typed_selected_reader_refuses_missing_or_wrong_parent_cache(self):
        from orgtree.ledger import LedgerError
        stats = graph.subtree_stats(self.c, 'a')
        self.assertEqual((stats.agent_id, stats.parent_id, stats.descendants, stats.height,
                          stats.org_children_count), (2, 1, 2, 2, 1))
        self.c.execute('UPDATE orgtree.agent_subtree_stats SET parent_agent_id=5 WHERE agent_id=2')
        with self.assertRaisesRegex(LedgerError, 'reconciliation'):
            graph.subtree_stats(self.c, 'a')
        self.assertIn((2, 'parent copy'), graph.verify_stats(self.c))
        self.c.execute('DELETE FROM orgtree.agent_subtree_stats WHERE agent_id=2')
        with self.assertRaisesRegex(LedgerError, 'reconciliation'):
            graph.subtree_stats(self.c, 'a')
        with self.assertRaisesRegex(LedgerError, 'no such agent'):
            graph.subtree_stats(self.c, 'missing')

    def test_subtree_move_changes_paths_without_touching_ordinary_descendants(self):
        before = self.c.execute('SELECT a.id,a.xmin::text,s.xmin::text FROM orgtree.agents a '
                                'JOIN orgtree.agent_subtree_stats s ON s.agent_id=a.id '
                                'WHERE a.id IN (3,4) ORDER BY a.id').fetchall()
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.check_reference()
        self.assertEqual(self.stats(1), (None, 3, 1, 2))
        self.assertEqual(self.stats(5), (None, 3, 3, 1))
        self.assertEqual(self.c.execute('SELECT a.id,a.xmin::text,s.xmin::text FROM orgtree.agents a '
                                        'JOIN orgtree.agent_subtree_stats s ON s.agent_id=a.id '
                                        'WHERE a.id IN (3,4) ORDER BY a.id').fetchall(), before)

    def test_overlapping_batch_counts_each_branch_once(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id IN (2,3)')
        self.check_reference()
        self.assertEqual(self.stats(2), (5, 0, 0, 0))
        self.assertEqual(self.stats(5), (None, 3, 2, 2))

    def test_atomic_multirow_reparent_uses_final_acyclic_shape(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=CASE id WHEN 2 THEN 3 WHEN 3 THEN 5 END '
                       'WHERE id IN (2,3)')
        self.check_reference()
        self.assertEqual(self.stats(3), (5, 2, 1, 2))

    def test_later_statement_sees_eager_stats_of_earlier_leg(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.assertEqual(self.stats(5)[1:], (3, 3, 1))
        self.c.execute('UPDATE orgtree.agents SET parent_id=1 WHERE id=2')
        self.check_reference()
        self.assertEqual(self.stats(1), (None, 6, 3, 3))

    def test_tombstone_and_revival_keep_latent_branch_and_visible_height(self):
        self.c.execute('UPDATE orgtree.agents SET tombstone=true WHERE id=2')
        self.check_reference()
        self.assertEqual(self.stats(2), (1, 2, -1, 1))
        self.assertEqual(self.stats(1)[1:], (3, 1, 2))
        self.c.execute('UPDATE orgtree.agents SET tombstone=false WHERE id IN (2,6)')
        self.check_reference()
        self.assertEqual(self.stats(1)[1:], (8, 3, 4))

    def test_delete_old_component_survives_stats_fk_cascade_for_delta(self):
        self.c.execute('DELETE FROM orgtree.agents WHERE id IN (2,3,4)')
        self.check_reference()
        self.assertEqual(self.stats(1)[1:], (3, 1, 2))
        self.assertEqual(self.c.execute('SELECT count(*) FROM orgtree.agent_subtree_stats '
                                       'WHERE agent_id IN (2,3,4)').fetchone()[0], 0)

    def test_delete_leaf_and_hidden_component(self):
        self.c.execute('DELETE FROM orgtree.agents WHERE id IN (4,6,7)')
        self.check_reference()
        self.assertEqual(self.stats(1)[1:], (5, 2, 3))

    def test_child_axis_excludes_only_archived_and_truthy_successor(self):
        self.c.execute("UPDATE orgtree.agents SET state='live' WHERE id=8")
        self.assertEqual(self.stats(1)[3], 4)
        self.c.execute("UPDATE orgtree.agents SET state='archived' WHERE id=9")
        self.assertEqual(self.stats(1)[3], 3)
        self.c.execute("UPDATE orgtree.agents SET successor_id=NULL,extra=%s::json WHERE id=8",
                       ('{"successor":[0]}',))
        self.c.execute("UPDATE orgtree.agents SET state='archived' WHERE id=8")
        self.assertEqual(self.stats(1)[3], 2)
        self.c.execute("UPDATE orgtree.agents SET extra=%s::json WHERE id=8", ('{"successor":[]}',))
        self.assertEqual(self.stats(1)[3], 3)
        self.check_reference()

    def test_empty_successor_name_boundary_updates_unwritten_referrer_parent(self):
        self.c.execute("UPDATE orgtree.agents SET name='nonempty' WHERE id=10")
        self.assertEqual(self.stats(1)[3], 2)
        self.check_reference()
        self.c.execute("UPDATE orgtree.agents SET name='' WHERE id=10")
        self.assertEqual(self.stats(1)[3], 3)
        self.check_reference()

    def test_successor_truthiness_with_nul_surrogates_and_unrelated_misfits(self):
        from orgtree.orgdb import codec
        values = [None, False, 0, 0.0, -0.0, '', [], {}, '\x00', '\ud800',
                  [0], {'v': '\x00'}, True, 4, r'\u0000', '\ud83d\ude00']
        for value in values:
            extra = {'successor': value, 'unknown': {'nul': '\x00', 'surrogate': '\ud800'}}
            self.c.execute('UPDATE orgtree.agents SET successor_id=NULL,extra=%s WHERE id=8',
                           (codec.to_column('json', extra),))
            self.assertEqual(self.stats(1)[3], 3 if bool(value) else 4, repr(value))
            actual = self.c.execute('SELECT extra FROM orgtree.agents WHERE id=8').fetchone()[0]
            # JSON reads valid surrogate pairs as one Unicode scalar.
            self.assertEqual(json.dumps(actual, sort_keys=True), json.dumps(extra, sort_keys=True))
            self.check_reference()

    def test_name_payload_permission_and_grant_changes_do_not_touch_stats(self):
        before = self.c.execute('SELECT agent_id,xmin::text FROM orgtree.agent_subtree_stats '
                                'ORDER BY agent_id').fetchall()
        self.c.execute("UPDATE orgtree.agents SET name='renamed',credit_grant=99,"
                       "scope_permission_mode='plan',extra=%s::json WHERE id=2", ('{"unrelated":123}',))
        self.assertEqual(self.c.execute('SELECT agent_id,xmin::text FROM orgtree.agent_subtree_stats '
                                        'ORDER BY agent_id').fetchall(), before)
        self.check_reference()

    def test_raw_insert_nested_branches_and_subsequent_child_delete(self):
        self.c.execute("INSERT INTO orgtree.agents(id,name,parent_id,state) VALUES"
                       "(21,'newroot',5,'live'),(22,'newchild',21,'archived'),(23,'newleaf',22,'live')")
        self.check_reference()
        self.assertEqual(self.stats(5)[1:], (3, 3, 1))
        self.c.execute('DELETE FROM orgtree.agents WHERE id=23')
        self.check_reference()
        self.assertEqual(self.stats(5)[1:], (2, 2, 1))

    def test_native_missing_prelock_refuses_whole_statement(self):
        import psycopg
        self.c.execute("SELECT set_config('orgtree.graph_plan','{\"stats\":[2],\"whole\":false}',true)")
        self.c.execute('SAVEPOINT missed_plan')
        with self.assertRaises(psycopg.errors.SerializationFailure):
            self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.c.execute('ROLLBACK TO missed_plan')
        self.assertEqual(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id=2').fetchone()[0], 1)
        self.check_reference()

    def test_native_covered_paths_allow_update_without_hidden_late_agent_locks(self):
        tx = orgtx._new_tx('test', nodes=['a'], structural_roots=['a', 'destination'])
        plan = graph.plan_locks(self.c, tx)
        self.c.execute('SELECT id FROM orgtree.agents WHERE id=ANY(%s) ORDER BY id FOR UPDATE',
                       (sorted(plan.agent_ids),))
        self.c.execute('SELECT agent_id FROM orgtree.agent_subtree_stats WHERE agent_id=ANY(%s) '
                       'ORDER BY agent_id FOR UPDATE', (sorted(plan.stats_ids),))
        graph.install_plan(self.c, tx, plan)
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.check_reference()

    def test_savepoint_and_full_rollback_restore_caches_on_reused_connection(self):
        self.c.execute('SAVEPOINT before_move')
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.c.execute('ROLLBACK TO before_move')
        self.check_reference()
        self.assertEqual(self.stats(5)[1:], (0, 0, 0))
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.c.execute('ROLLBACK')
        self.c.execute('BEGIN')
        self.check_reference()
        self.assertEqual(self.stats(5)[1:], (0, 0, 0))

    def test_reference_reports_missing_corrupt_counts_and_parent_copy(self):
        self.c.execute('UPDATE orgtree.agent_subtree_stats SET descendants=88 WHERE agent_id=2')
        self.assertIn((2, 'descendants'), self.c.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall())
        self.c.execute('UPDATE orgtree.agent_subtree_stats SET parent_agent_id=5 WHERE agent_id=3')
        self.assertIn((3, 'parent copy'), self.c.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall())
        self.c.execute('DELETE FROM orgtree.agent_subtree_stats WHERE agent_id=4')
        self.assertIn((4, 'missing cache'), self.c.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall())

    def test_missing_cache_is_refused_without_silent_reconstruction(self):
        import psycopg
        self.c.execute('DELETE FROM orgtree.agent_subtree_stats WHERE agent_id=2')
        self.c.execute('SAVEPOINT corrupted_cache')
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=2')
        self.c.execute('ROLLBACK TO corrupted_cache')
        self.assertIsNone(self.stats(2))

    def test_mixed_random_batch_changes_match_reference_after_each_statement(self):
        # Deterministic raw writer coverage; final trees are valid, no mocked paths.
        rng = random.Random(1947)
        self.c.execute("INSERT INTO orgtree.agents(id,name,parent_id,state) "
                       "SELECT i,'generated_'||i,5,'live' FROM generate_series(21,60) g(i)")
        for _ in range(12):
            selected = rng.sample(range(21,61), 8)
            # Lower physical ids form a DAG even with overlapping statement rows.
            parents = [rng.choice([1,5] + list(range(21,i))) for i in selected]
            self.c.execute('UPDATE orgtree.agents a SET parent_id=v.parent,tombstone=v.hidden '
                           'FROM unnest(%s::bigint[],%s::bigint[],%s::boolean[]) v(id,parent,hidden) '
                           'WHERE a.id=v.id', (selected, parents, [rng.randrange(5)==0 for _ in selected]))
            self.check_reference()

    def scalar_plan(self, names, roots=()):
        tx = orgtx._new_tx('test', nodes=names, structural_roots=roots)
        plan = graph.plan_locks(self.c, tx)
        ids = sorted(plan.agent_ids) if plan is not None else [int(i) for i, in self.c.execute(
            'SELECT id FROM orgtree.agents WHERE name=ANY(%s)', (list(names),)).fetchall()]
        self.c.execute('SELECT id FROM orgtree.agents WHERE id=ANY(%s) ORDER BY id FOR UPDATE', (ids,))
        if plan is not None:
            self.c.execute('SELECT agent_id FROM orgtree.agent_subtree_stats WHERE agent_id=ANY(%s) '
                           'ORDER BY agent_id FOR UPDATE', (sorted(plan.stats_ids),))
        graph.install_plan(self.c, tx, plan)

    def scalar_patch(self, name, **values):
        agent_id, version = self.c.execute('SELECT id,row_version FROM orgtree.agents WHERE name=%s '
                                           'AND NOT tombstone', (name,)).fetchone()
        return graph.ScalarPatch(int(agent_id), name, int(version), values)

    def scalar_payload(self):
        from orgtree.orgdb.compat import rows as R
        self.c.execute('UPDATE orgtree.agents SET ord=id WHERE NOT tombstone')
        value = {'parent': 'root', 'state': 'live', 'grant': 3.0, 'model': 'sol',
                 'scope': {'tools': {'bash': True, 'mcp': ['*']},
                           'add_dirs': [{'path': 'E:/kept', 'mode': 'ro'}]},
                 'charter': 'unchanged long text', 'frozen': {'opaque': [2, 1]},
                 'unknown': {'nul': 'before\x00after', 'values': [None, True, 4.0]}}
        R.node_put(self.c, 'a', value, R.Names(self.c))
        return value

    def scalar_doc(self, names=('a',)):
        from orgtree import store
        from orgtree.orgdb.compat import rows as R
        doc = store.LazyDoc('test')
        nodes = store.NodesMap()
        for name, text, _ in R.nodes(self.c, names):
            dict.__setitem__(nodes, name, json.loads(text))
            doc._snap_nodes[name] = text
        dict.__setitem__(doc, 'nodes', nodes)
        return doc

    def test_scalar_batch_fences_versions_and_keeps_payload_and_children(self):
        from orgtree import store
        self.scalar_payload()
        before = self.c.execute('SELECT extra::text,scope_tools_bash,model FROM orgtree.agents WHERE id=2').fetchone()
        children = self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_dir_grants WHERE agent_id=2').fetchall()
        runtime = self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_runtime WHERE agent_id=2').fetchall()
        self.scalar_plan(['a', 'bearer', 'root'], ['a', 'bearer', 'destination'])
        requested = [self.scalar_patch('a', parent='destination'),
                     self.scalar_patch('bearer', parent='destination'), self.scalar_patch('root', grant=8.0)]
        versions = graph.apply_scalars(self.c, requested)
        self.assertEqual(set(versions), {1, 2, 8})
        self.assertEqual(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id IN (2,8) '
                                       'ORDER BY id').fetchall(), [(5,), (5,)])
        self.assertEqual(self.c.execute('SELECT extra::text,scope_tools_bash,model FROM orgtree.agents WHERE id=2').fetchone(), before)
        self.assertEqual(self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_dir_grants WHERE agent_id=2').fetchall(), children)
        self.assertEqual(self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_runtime WHERE agent_id=2').fetchall(), runtime)
        with self.assertRaises(store.StaleWrite):
            graph.apply_scalars(self.c, requested)
        self.check_reference()

    def test_scalar_partial_return_rolls_back_the_whole_batch(self):
        from orgtree import store
        self.scalar_plan(['a', 'b'], ['a', 'b', 'destination'])
        self.c.execute("CREATE FUNCTION orgtree.test_suppress_one() RETURNS trigger LANGUAGE plpgsql AS "
                       "$$ BEGIN IF NEW.id=3 THEN RETURN NULL; END IF; RETURN NEW; END $$")
        self.c.execute('CREATE TRIGGER test_suppress_one BEFORE UPDATE ON orgtree.agents '
                       'FOR EACH ROW EXECUTE FUNCTION orgtree.test_suppress_one()')
        with self.assertRaisesRegex(store.StaleWrite, 'batch rolled back'):
            graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination'),
                                        self.scalar_patch('b', parent='destination')])
        self.assertEqual(self.c.execute('SELECT id,parent_id FROM orgtree.agents WHERE id IN (2,3) '
                                       'ORDER BY id').fetchall(), [(2, 1), (3, 2)])
        self.assertEqual(graph._scalar_records(self.c), {})
        self.check_reference()

    def test_scalar_top_level_null_and_misfit_replacement_keep_unknown_values(self):
        from orgtree.orgdb import codec
        from orgtree.orgdb.compat import rows as R
        self.scalar_payload()
        extra = self.c.execute('SELECT extra FROM orgtree.agents WHERE id=2').fetchone()[0]
        extra['grant'] = [False]
        self.c.execute('UPDATE orgtree.agents SET credit_grant=NULL,extra=%s WHERE id=2',
                       (codec.to_column('json', extra),))
        # The JSON contains an escaped NUL; a JSONB cast of the entire extra would fail.
        self.scalar_plan(['a'], ['a'])
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent=None, grant=4.0)])
        value = json.loads(R.nodes(self.c, ['a'])[0][1])
        self.assertIsNone(value['parent'])
        self.assertEqual(value['grant'], 4.0)
        self.assertIsInstance(value['grant'], float)
        self.assertEqual(value['unknown']['nul'], 'before\x00after')
        self.assertEqual(self.c.execute('SELECT parent_id,parent_null FROM orgtree.agents WHERE id=2').fetchone(), (None, True))
        self.check_reference()

    def test_scalar_records_follow_savepoint_and_full_rollback_on_reused_connection(self):
        from orgtree.ledger import LedgerError
        self.scalar_payload()
        self.scalar_plan(['a'], ['a', 'destination'])
        doc = self.scalar_doc()
        original = dict(doc._snap_nodes)
        self.c.execute('SAVEPOINT scalar_outer')
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination')])
        view = graph.save_baselines(SimpleNamespace(raw=self.c), doc, doc, None)
        self.assertEqual(json.loads(view._snap_nodes['a'])['parent'], 'destination')
        self.assertEqual(doc._snap_nodes, original)
        self.c.execute('ROLLBACK TO scalar_outer')
        self.assertIs(graph.save_baselines(SimpleNamespace(raw=self.c), doc, doc, None), doc)
        self.assertEqual(graph._scalar_records(self.c), {})
        self.c.execute('ROLLBACK')
        self.c.execute('BEGIN')
        with self.assertRaisesRegex(LedgerError, 'planned org transaction'):
            graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination')])
        self.assertEqual(graph._scalar_records(self.c), {})
        self.check_reference()

    def test_scalar_save_skips_full_node_writer_and_reports_changes(self):
        from orgtree import store
        from orgtree.orgdb.compat import conn as C, rows as R
        from orgtree.stateprobe import SaveChanges
        self.scalar_payload()
        self.scalar_plan(['a'], ['a', 'destination'])
        doc = self.scalar_doc()
        original = dict(doc._snap_nodes)
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination', grant=5.0)])
        dict.__getitem__(doc, 'nodes')['a'].update(parent='destination', grant=5.0)
        wrapped = C.OrgDbConn(self.c, 'test', 1, DATABASE)
        changes = SaveChanges()
        with patch.object(store, 'STORE_BACKEND', 'postgres'), patch.object(store, '_ROW_CAS', True), \
                patch.object(store, '_SCOPED_SAVE', False), \
                patch.object(R, 'node_put', wraps=R.node_put) as put:
            _, nodes, _, _ = store._write_doc(wrapped, doc, doc, changes)
        self.assertEqual(put.call_count, 0)
        self.assertEqual(changes.node_updates, ['a'])
        self.assertEqual(json.loads(nodes['a'])['parent'], 'destination')
        self.assertEqual(doc._snap_nodes, original)  # _write_doc never adopts a rollback point
        self.check_reference()

    def test_scalar_mixed_payload_save_uses_post_patch_baseline_and_ordinary_cas(self):
        from orgtree import store
        from orgtree.orgdb.compat import conn as C, rows as R
        from orgtree.stateprobe import SaveChanges
        self.scalar_payload()
        self.scalar_plan(['a'], ['a', 'destination'])
        doc = self.scalar_doc()
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination')])
        dict.__getitem__(doc, 'nodes')['a'].update(parent='destination', charter='intentional mixed edit')
        wrapped = C.OrgDbConn(self.c, 'test', 1, DATABASE)
        with patch.object(store, 'STORE_BACKEND', 'postgres'), patch.object(store, '_ROW_CAS', True), \
                patch.object(store, '_SCOPED_SAVE', False), \
                patch.object(R, 'node_put', wraps=R.node_put) as put:
            store._write_doc(wrapped, doc, doc, SaveChanges())
        self.assertEqual(put.call_count, 1)
        value = json.loads(R.nodes(self.c, ['a'])[0][1])
        self.assertEqual(value['parent'], 'destination')
        self.assertEqual(value['charter'], 'intentional mixed edit')
        self.assertEqual(value['unknown']['nul'], 'before\x00after')
        self.check_reference()

    def test_scalar_handoff_does_not_refresh_or_accept_unrelated_stale_payload(self):
        from orgtree import store
        from orgtree.orgdb.compat import conn as C
        from orgtree.stateprobe import SaveChanges
        self.scalar_payload()
        self.scalar_plan(['a'], ['a', 'destination'])
        doc = self.scalar_doc()
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination')])
        dict.__getitem__(doc, 'nodes')['a'].update(parent='destination', charter='stale edit')
        self.c.execute("UPDATE orgtree.agent_texts SET charter='other committed payload' WHERE agent_id=2")
        self.c.execute('UPDATE orgtree.agents SET row_version=row_version+1 WHERE id=2')
        view = graph.save_baselines(SimpleNamespace(raw=self.c), doc, doc, None)
        self.assertEqual(json.loads(view._snap_nodes['a'])['charter'], 'unchanged long text')
        with patch.object(store, 'STORE_BACKEND', 'postgres'), patch.object(store, '_ROW_CAS', True), \
                patch.object(store, '_SCOPED_SAVE', False):
            with self.assertRaises(store.StaleWrite):
                store._write_doc(C.OrgDbConn(self.c, 'test', 1, DATABASE), doc, doc, SaveChanges())
        self.check_reference()

    def test_scalar_handoff_is_idempotent_across_legs_and_physical_reference_rename(self):
        from orgtree import store
        self.scalar_payload()
        self.scalar_plan(['a', 'root'], ['a', 'destination'])
        doc = self.scalar_doc()
        original = dict(doc._snap_nodes)
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination')])
        first = graph.save_baselines(SimpleNamespace(raw=self.c), doc, doc, None)
        self.assertEqual(graph.save_baselines(SimpleNamespace(raw=self.c), doc, first, None)._snap_nodes,
                         first._snap_nodes)
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='root')])
        second = graph.save_baselines(SimpleNamespace(raw=self.c), doc, first, None)
        self.assertEqual(json.loads(second._snap_nodes['a'])['parent'], 'root')
        self.c.execute("UPDATE orgtree.agents SET name='renamed_root',row_version=row_version+1 WHERE id=1")
        renamed = store.LazyDoc.__new__(store.LazyDoc)
        renamed.__dict__.update(second.__dict__)
        renamed._snap_nodes = {'a': json.dumps({**json.loads(second._snap_nodes['a']), 'parent': 'renamed_root'})}
        final = graph.save_baselines(SimpleNamespace(raw=self.c), doc, renamed, None)
        self.assertEqual(json.loads(final._snap_nodes['a'])['parent'], 'renamed_root')
        self.assertEqual(doc._snap_nodes, original)
        self.check_reference()

    def test_structural_node_adapters_refuse_before_existing_lookup_or_header_write(self):
        from orgtree import pgdoor
        from orgtree.orgdb.compat import rows as R
        self.scalar_payload()
        self.scalar_plan(['a'])   # no stats tier was declared
        class Trace:
            def __init__(self, raw):
                self.raw, self.calls = raw, []
            def execute(self, statement, params=()):
                self.calls.append(statement)
                return self.raw.execute(statement, params)
        traced = Trace(self.c)
        with self.assertRaises(pgdoor.Widen):
            R.node_put(traced, 'a', {'state': 'live', 'parent': 'destination'}, R.Names(traced))
        with self.assertRaises(pgdoor.Widen):
            R.node_delete(traced, 'a')
        self.assertFalse(any('FOR UPDATE' in call or call.startswith(('UPDATE ', 'INSERT ', 'DELETE '))
                             for call in traced.calls))
        self.check_reference()

    def test_nonstructural_native_payload_writer_needs_no_stats_locks(self):
        from orgtree.orgdb.compat import rows as R
        value = self.scalar_payload()
        self.scalar_plan(['a'])
        before = self.c.execute('SELECT agent_id,xmin::text,ctid::text FROM orgtree.agent_subtree_stats '
                                'ORDER BY agent_id').fetchall()
        value['charter'] = 'changed payload'
        R.node_put(self.c, 'a', value, R.Names(self.c))
        self.assertEqual(self.c.execute('SELECT agent_id,xmin::text,ctid::text FROM orgtree.agent_subtree_stats '
                                        'ORDER BY agent_id').fetchall(), before)
        self.check_reference()


if __name__ == '__main__':
    unittest.main()
