"""Actual PostgreSQL root collection, final cycles and transaction-local state."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import contextlib
import json
import os
from pathlib import Path
import unittest
import uuid

from orgtree import orgtx
from orgtree.orgdb import conn, graph

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DATABASE = 'qgraph_' + uuid.uuid4().hex[:14]
needs_pg = unittest.skipUnless(ADMIN, 'requires an owned disposable PostgreSQL')


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
            c.execute('CREATE SCHEMA orgtree; '
                      'CREATE TABLE orgtree.agents(id bigint PRIMARY KEY,name text NOT NULL,'
                      'parent_id bigint REFERENCES orgtree.agents(id),'
                      'tombstone boolean NOT NULL DEFAULT false,note text); '
                      'CREATE TABLE orgtree.org_revision(singleton boolean PRIMARY KEY DEFAULT true,'
                      'rev bigint NOT NULL DEFAULT 0); '
                      'INSERT INTO orgtree.org_revision DEFAULT VALUES; '
                      'CREATE TABLE orgtree.agent_subtree_stats(agent_id bigint PRIMARY KEY)')
            migration = Path(__file__).resolve().parents[1] / (
                'engine/backend/orgtree/pg_migrations/org/0017_agent_graph.sql')
            # Kernel-only fixture. The full-schema aggregate suite separately
            # tests eager stats, whose intermediate graph must itself be acyclic.
            c.execute(migration.read_text(encoding='utf-8').split('-- Eager aggregate section')[0])
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
class GraphCycles(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.c = psycopg.connect(conn.with_db(ADMIN, DATABASE), autocommit=True)
        self.addCleanup(self.c.close)
        self.c.execute('DELETE FROM orgtree.agents; DELETE FROM orgtree.agent_subtree_stats')
        self.c.execute("INSERT INTO orgtree.agents(id,name,parent_id) VALUES"
                       "(1,'root',NULL),(2,'moved',1),(3,'child',2),"
                       "(4,'bearer',1),(5,'stranded',4),(6,'destination',NULL)")
        self.c.execute('INSERT INTO orgtree.agent_subtree_stats SELECT id FROM orgtree.agents')
        self.c.execute('BEGIN')
        self.addCleanup(self.rollback)

    def rollback(self):
        with contextlib.suppress(Exception):
            self.c.execute('ROLLBACK')

    def pending(self):
        return self.c.execute("SELECT coalesce(nullif(current_setting('orgtree.graph_pending',true),''),'0'),"
                              "coalesce(nullif(current_setting('orgtree.graph_roots',true),''),'[]')").fetchone()

    def test_raw_commit_refuses_cycle_and_rolls_back_parent(self):
        import psycopg
        self.c.execute('UPDATE orgtree.agents SET parent_id=3 WHERE id=1')
        self.assertEqual(self.pending(), ('1', '[1]'))
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.c.execute('COMMIT')
        self.rollback()
        self.assertIsNone(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id=1').fetchone()[0])
        self.assertEqual(self.pending()[0], '0')

    def test_every_changed_bearer_root_is_collected_and_rearmed(self):
        import psycopg
        self.c.execute('UPDATE orgtree.agents SET parent_id=6 WHERE id IN (2,4)')
        self.assertEqual(json.loads(self.pending()[1]), [2, 4])
        self.c.execute('SELECT singleton FROM orgtree.org_revision FOR UPDATE')
        graph.assert_final_cycles(self.c)
        self.assertEqual(self.pending(), ('0', '[]'))
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=4')
        self.assertEqual(json.loads(self.pending()[1]), [4])
        with self.assertRaises(psycopg.errors.CheckViolation):
            graph.assert_final_cycles(self.c)

    def test_savepoint_rollback_restores_the_prior_pending_root_set(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=6 WHERE id=2')
        self.c.execute('SAVEPOINT change_bearer')
        self.c.execute('UPDATE orgtree.agents SET parent_id=5 WHERE id=4')
        self.assertEqual(json.loads(self.pending()[1]), [2, 4])
        self.c.execute('ROLLBACK TO change_bearer')
        self.assertEqual(json.loads(self.pending()[1]), [2])
        self.c.execute('COMMIT')
        self.assertEqual(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id=2').fetchone()[0], 6)
        self.assertEqual(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id=4').fetchone()[0], 1)

    def test_full_rollback_and_connection_reuse_leave_no_pending_roots(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=6 WHERE id=2')
        self.c.execute('ROLLBACK')
        self.assertEqual(self.pending()[0], '0')
        self.c.execute('BEGIN')
        self.c.execute('UPDATE orgtree.agents SET note=%s WHERE id=4', ('ordinary',))
        self.assertEqual(self.pending()[0], '0')
        self.c.execute('COMMIT')
        self.assertEqual(self.pending()[0], '0')

    def test_multirow_final_shape_is_checked_without_rejecting_intermediate_cycle(self):
        self.c.execute('UPDATE orgtree.agents SET parent_id=3 WHERE id=2')
        self.c.execute('UPDATE orgtree.agents SET parent_id=6 WHERE id=3')
        self.c.execute('COMMIT')
        self.assertEqual(self.c.execute('SELECT parent_id FROM orgtree.agents WHERE id=2').fetchone()[0], 3)
        self.assertEqual(self.pending()[0], '0')

    def test_kernel_adds_no_agent_row_lock_or_org_write(self):
        self.c.execute("SELECT set_config('orgtree.graph_pending','1',true),"
                       "set_config('orgtree.graph_roots','[3,5]',true)")
        self.c.execute('SELECT singleton FROM orgtree.org_revision FOR UPDATE')
        before = self.c.execute('SELECT id,parent_id,xmin::text FROM orgtree.agents ORDER BY id').fetchall()
        graph.assert_final_cycles(self.c)
        after = self.c.execute('SELECT id,parent_id,xmin::text FROM orgtree.agents ORDER BY id').fetchall()
        self.assertEqual(after, before)
        self.assertEqual(self.c.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0], 0)
        modes = self.c.execute("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() "
                               "AND relation='orgtree.agents'::regclass").fetchall()
        self.assertEqual(modes, [('AccessShareLock',)])

    def test_native_plan_authority_does_not_survive_transaction_or_savepoint(self):
        tx = orgtx._new_tx('test', nodes=['moved'], structural_roots=['moved', 'destination'])
        plan = graph.plan_locks(self.c, tx)
        self.c.execute('SELECT id FROM orgtree.agents ORDER BY id FOR UPDATE')
        self.c.execute('SELECT agent_id FROM orgtree.agent_subtree_stats ORDER BY agent_id FOR UPDATE')
        self.c.execute('SAVEPOINT before_plan')
        graph.install_plan(self.c, tx, plan)
        self.assertIsNotNone(graph.current_plan(self.c))
        self.c.execute('ROLLBACK TO before_plan')
        self.assertIsNone(graph.current_plan(self.c))
        graph.install_plan(self.c, tx, plan)
        self.c.execute('COMMIT')
        self.c.execute('BEGIN')
        self.assertIsNone(graph.current_plan(self.c))

    def test_an_early_explicit_constraint_check_cannot_skip_a_later_cycle(self):
        import psycopg
        self.c.execute('SET CONSTRAINTS ALL IMMEDIATE')
        self.c.execute('UPDATE orgtree.agents SET parent_id=3 WHERE id=1')
        self.assertEqual(self.pending()[0], '1')
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.c.execute('COMMIT')


if __name__ == '__main__':
    unittest.main()
