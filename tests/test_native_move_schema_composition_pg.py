""Actual landed G/O1 composition: rename prepass after owned scalar writes.""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
import unittest
from unittest.mock import patch

import test_graph_stats_pg as f
from orgtree import ledger, store
from orgtree.orgdb import graph, renames
from orgtree.orgdb.compat import conn as C, rows as R
from orgtree.stateprobe import SaveChanges


def setUpModule():
    f.setUpModule()


def tearDownModule():
    f.tearDownModule()


@f.needs_pg
class CombinedRename(unittest.TestCase):
    rollback = f.GraphStats.rollback
    scalar_plan = f.GraphStats.scalar_plan
    scalar_patch = f.GraphStats.scalar_patch
    scalar_payload = f.GraphStats.scalar_payload
    scalar_doc = f.GraphStats.scalar_doc
    check_reference = f.GraphStats.check_reference

    def setUp(self):
        f.GraphStats.setUp(self)
        self.initialize()

    def initialize(self):
        self.scalar_payload()
        names = [name for name, in self.c.execute(
            'SELECT name FROM orgtree.agents WHERE NOT tombstone ORDER BY id').fetchall()]
        self.doc = self.scalar_doc(names)
        self.org = ledger.Org(self.doc)
        # Save constructor defaults before taking the deliberate stale-write
        # baseline. The move/rename must not be confused with legacy healing.
        for name, value in self.org.nodes.items():
            R.node_put(self.c, name, value, R.Names(self.c))
        self.doc._snap_nodes = {name: text for name, text, _ in R.nodes(self.c, names)}
        self.original = copy.deepcopy(self.doc._snap_nodes)
        self.scalar_plan(names, names)
        self.wrapped = C.OrgDbConn(self.c, 'test', 1, f.DATABASE)

    def move_and_rename(self, mixed=False):
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination', grant=4.0)])
        self.org.nodes['a'].update(parent='destination', grant=4.0)
        if mixed:
            self.org.nodes['a']['charter'] = 'mixed payload edit'
        with patch.object(store, '_orgdb_on', return_value=True):
            self.org.rename(ledger.USER, 'a', 'moved-a')

    def save(self):
        changes = SaveChanges()
        with patch.object(store, 'STORE_BACKEND', 'postgres'), \
                patch.object(store, '_ROW_CAS', True), \
                patch.object(store, '_SCOPED_SAVE', False):
            result = store._write_doc(self.wrapped, self.doc, self.doc, changes,
                                     rename_intent=self.org._native_rename_intent)
        self.assertEqual(self.doc._snap_nodes, self.original)
        self.assertIn('moved-a', changes.node_updates)
        self.assertIn('a', changes.node_deletes)
        return result

    def assert_result(self, mixed=False):
        identity, name, parent, grant = self.c.execute(
            'SELECT a.id,a.name,p.name,a.credit_grant FROM orgtree.agents a '
            'LEFT JOIN orgtree.agents p ON p.id=a.parent_id WHERE a.id=2').fetchone()
        self.assertEqual((identity, name, parent, float(grant)), (2, 'moved-a', 'destination', 4.0))
        value = json.loads(R.nodes(self.c, ['moved-a'])[0][1])
        self.assertEqual(value['charter'], 'mixed payload edit' if mixed else 'unchanged long text')
        self.assertEqual(value['unknown']['nul'], 'before\x00after')
        self.check_reference()

    def test_scalar_move_and_actual_rename_keep_child_rows_and_baselines(self):
        children = self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_dir_grants '
                                  'WHERE agent_id=2 ORDER BY ctid').fetchall()
        self.move_and_rename()
        self.save()
        self.assert_result()
        self.assertEqual(self.c.execute('SELECT xmin::text,ctid::text FROM orgtree.agent_dir_grants '
                                        'WHERE agent_id=2 ORDER BY ctid').fetchall(), children)

    def test_scalar_move_rename_and_mixed_payload_use_the_ordinary_cas(self):
        self.move_and_rename(mixed=True)
        with patch.object(R, 'node_put', wraps=R.node_put) as put:
            self.save()
        self.assertGreater(put.call_count, 0)
        self.assert_result(mixed=True)

    def test_missing_prevalidation_handoff_is_caught_then_restored_passes(self):
        self.move_and_rename()
        original = graph.save_baselines
        calls = []
        def missing_first(conn, d, lazy, changes):
            calls.append(True)
            return lazy if len(calls) == 1 else original(conn, d, lazy, changes)
        with patch.object(graph, 'save_baselines', missing_first), \
                self.assertRaisesRegex(store.StaleWrite, 'changed before rename'):
            self.save()
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.c.execute('SELECT name FROM orgtree.agents WHERE id=2').fetchone(), ('a',))
        self.assertEqual(self.doc._snap_nodes, self.original)
        self.save()
        self.assert_result()

    def test_mixed_save_failure_rolls_back_scalar_and_rename_then_retry_works(self):
        self.c.execute('SAVEPOINT before_combined')
        self.move_and_rename(mixed=True)
        with patch.object(store, '_cas_nodes', side_effect=store.StaleWrite('planted combined CAS')), \
                self.assertRaisesRegex(store.StaleWrite, 'planted combined CAS'):
            self.save()
        self.c.execute('ROLLBACK TO before_combined')
        self.assertEqual(self.c.execute('SELECT name,parent_id FROM orgtree.agents WHERE id=2').fetchone(), ('a', 1))
        self.assertEqual(graph._scalar_records(self.c), {})
        self.assertEqual(self.doc._snap_nodes, self.original)
        self.wrapped.tx = R.Tx()
        graph.apply_scalars(self.c, [self.scalar_patch('a', parent='destination', grant=4.0)])
        self.save()
        self.assert_result(mixed=True)

    def test_unrelated_stale_payload_is_not_refreshed_by_scalar_handoff(self):
        self.move_and_rename(mixed=True)
        self.c.execute("UPDATE orgtree.agent_texts SET charter='independent stale payload' WHERE agent_id=2")
        self.c.execute('UPDATE orgtree.agents SET row_version=row_version+1 WHERE id=2')
        with self.assertRaisesRegex(store.StaleWrite, 'changed before rename'):
            self.save()
        self.assertEqual(self.c.execute('SELECT name FROM orgtree.agents WHERE id=2').fetchone(), ('a',))
        self.assertEqual(self.doc._snap_nodes, self.original)

    def test_committed_external_payload_is_refused_and_fresh_retry_works(self):
        import psycopg
        from psycopg import sql
        from orgtree.orgdb import conn
        import uuid

        # Clone only the fixture's disposable seed, after releasing our
        # connection to it. Commit setup and the independent writer only in
        # this isolated database, so other methods keep their original seed.
        self.c.execute('ROLLBACK')
        self.c.close()
        database = 'qrename_' + uuid.uuid4().hex[:14]
        with psycopg.connect(f.ADMIN, autocommit=True) as admin:
            admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE {}').format(
                sql.Identifier(database), sql.Identifier(f.DATABASE)))

        def drop():
            with psycopg.connect(f.ADMIN, autocommit=True) as admin:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(
                    sql.Identifier(database)))

        self.addCleanup(drop)
        self.c = psycopg.connect(conn.with_db(f.ADMIN, database), autocommit=True)
        self.addCleanup(self.c.close)
        self.c.execute('BEGIN')
        self.initialize()
        self.c.execute('COMMIT')
        with psycopg.connect(conn.with_db(f.ADMIN, database), autocommit=True) as other:
            with other.transaction():
                other.execute("UPDATE orgtree.agent_texts SET charter='external committed edit' "
                              'WHERE agent_id=2')
                other.execute('UPDATE orgtree.agents SET row_version=row_version+1 WHERE id=2')
        self.c.execute('BEGIN')
        names = list(self.org.nodes)
        self.scalar_plan(names, names)
        self.wrapped = C.OrgDbConn(self.c, 'test', 1, database)
        self.move_and_rename(mixed=True)
        with self.assertRaisesRegex(store.StaleWrite, 'changed before rename'):
            self.save()
        self.c.execute('ROLLBACK')
        self.assertEqual(self.doc._snap_nodes, self.original)
        self.assertEqual(graph._scalar_records(self.c), {})
        self.assertEqual(self.c.execute(
            'SELECT a.name,a.parent_id,t.charter FROM orgtree.agents a '
            'JOIN orgtree.agent_texts t ON t.agent_id=a.id WHERE a.id=2').fetchone(),
            ('a', 1, 'external committed edit'))
        self.check_reference()

        # A retry must load the committed external payload as its baseline,
        # rather than silently adopting it while saving the stale document.
        self.c.execute('BEGIN')
        self.doc = self.scalar_doc(names)
        self.org = ledger.Org(self.doc)
        self.original = copy.deepcopy(self.doc._snap_nodes)
        self.scalar_plan(names, names)
        self.wrapped = C.OrgDbConn(self.c, 'test', 1, database)
        self.move_and_rename(mixed=True)
        self.save()
        self.assert_result(mixed=True)


if __name__ == '__main__':
    unittest.main()

