"""Full org schema: eager raw/native aggregates, batch overlap and FK deletion."""
import import_provenance  # noqa: F401 asserts own-checkout engine imports
import contextlib
import os
from pathlib import Path
import random
import unittest
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


if __name__ == '__main__':
    unittest.main()
