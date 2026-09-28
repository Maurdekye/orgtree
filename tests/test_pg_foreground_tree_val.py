"""Reviewer probes (pg-workitems) for migration 0016: node_tree_val never stale.

Adopted from the F2b review (artifact r1 on foreground-tree-at-n1000-full-server-rebuilds-on,
sha256 8956df8719cd...). They cover write shapes the owner's suite missed: delete, id rename,
shrinking to <=8 turns, and orphan cleanup on install.
"""
import copy
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import test_pgstore as fixture
from orgtree import foreground_store as fg, ledger, pgstore, store


def tearDownModule():
    fixture.tearDownModule()


def turns(count, **extra):
    return [{'at': f'2026-09-28T00:{i // 60:02d}:{i % 60:02d}Z', 'n': i, **extra} for i in range(count)]


STALE = ('SELECT coalesce(n.id,t.id) FROM nodes n FULL JOIN node_tree_val t ON t.id=n.id '
         'WHERE t.val IS DISTINCT FROM public.orgtree_foreground_tree_val(n.val)')


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class TreeValProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('tv-' + self._testMethodName[:40].replace('_', '-'))
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss')
        for nid in ('busy', 'other'):
            org.hire(ledger.USER, 'boss', 'luna', 0, nid)
        org.nodes['busy']['turns'] = turns(30)
        org.nodes['other']['turns'] = turns(12)
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.assertEqual(self.stale(), [])
        self.assertEqual(self.copies(), {'busy', 'other'})

    def sql(self, *stmts):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            out = None
            for s in stmts:
                s, p = s if isinstance(s, tuple) else (s, ())
                cur = conn.raw.execute(s, p)
                out = cur.fetchall() if cur.description else out
            conn.execute('COMMIT')
            return out

    def stale(self):
        return [r[0] for r in self.sql(STALE)]

    def copies(self):
        return {r[0] for r in self.sql('SELECT id FROM node_tree_val')}

    def val(self, nid):
        return self.sql(('SELECT val FROM nodes WHERE id=%s', (nid,)))[0][0]

    def test_p1_python_delete_removes_the_copy(self):
        org = store.load_org(self.slug)
        del org.d['nodes']['other']
        store.save_org(org)
        self.assertEqual(self.stale(), [])
        self.assertNotIn('other', self.copies())

    def test_p1b_direct_delete_removes_the_copy(self):
        self.sql("DELETE FROM nodes WHERE id='other'")
        self.assertEqual(self.stale(), [])
        self.assertNotIn('other', self.copies())

    def test_p2_shrinking_to_eight_or_fewer_removes_the_copy(self):
        org = store.load_org(self.slug)
        org.nodes['busy']['turns'] = turns(5)
        store.save_org(org)
        self.assertEqual(self.stale(), [])
        self.assertNotIn('busy', self.copies())
        self.assertEqual(len(fg.read_foreground(self.slug)['rows']['busy']['node']['turns']), 5)

    def test_p3_direct_id_rename_moves_the_copy(self):
        # node_index follows the rename too, so the tree reads the new id
        self.sql("UPDATE nodes SET id='renamed' WHERE id='other'")
        self.assertEqual(self.stale(), [])
        self.assertIn('renamed', self.copies())
        self.assertNotIn('other', self.copies())

    def test_p4_two_writes_in_one_tx_keep_the_last(self):
        v = store._dumps
        a = dict(store.load_org(self.slug).nodes['busy']); a['turns'] = turns(40, w='a')
        b = dict(a); b['turns'] = turns(50, w='b')
        self.sql(('UPDATE nodes SET val=%s WHERE id=%s', (v(a), 'busy')),
                 ('UPDATE nodes SET val=%s WHERE id=%s', (v(b), 'busy')))
        self.assertEqual(self.stale(), [])
        node = fg.read_foreground(self.slug)['rows']['busy']['node']
        self.assertEqual(node['turns'], b['turns'][-ledger.TREE_TURNS:])

    def test_p4b_write_then_revert_in_one_tx(self):
        v = store._dumps
        orig = self.val('busy')
        a = dict(store.load_org(self.slug).nodes['busy']); a['turns'] = turns(3)
        self.sql(('UPDATE nodes SET val=%s WHERE id=%s', (v(a), 'busy')),
                 ('UPDATE nodes SET val=%s WHERE id=%s', (orig, 'busy')))
        self.assertEqual(self.stale(), [])
        self.assertIn('busy', self.copies())

    def test_p5_delete_and_reinsert_in_one_tx(self):
        orig = self.val('other')
        ordv = self.sql("SELECT ord FROM nodes WHERE id='other'")[0][0]
        n = dict(store.load_org(self.slug).nodes['other']); n['turns'] = turns(25, w='re')
        self.sql("DELETE FROM nodes WHERE id='other'",
                 ('INSERT INTO nodes(id,ord,val) VALUES(%s,%s,%s)', ('other', ordv, store._dumps(n))))
        self.assertEqual(self.stale(), [])
        self.assertNotEqual(self.val('other'), orig)

    def test_p6_rolled_back_savepoint_leaves_the_copy(self):
        before = self.sql("SELECT val FROM node_tree_val WHERE id='busy'")
        n = dict(store.load_org(self.slug).nodes['busy']); n['turns'] = turns(99, w='gone')
        self.sql('SAVEPOINT s', ('UPDATE nodes SET val=%s WHERE id=%s', (store._dumps(n), 'busy')),
                 'ROLLBACK TO SAVEPOINT s')
        self.assertEqual(self.stale(), [])
        self.assertEqual(self.sql("SELECT val FROM node_tree_val WHERE id='busy'"), before)

    def test_p7_becoming_non_round_trip_removes_the_copy(self):
        org = store.load_org(self.slug)
        org.nodes['busy']['turns'][-1]['big'] = 1e16
        store.save_org(org)
        self.assertEqual(self.stale(), [])
        self.assertNotIn('busy', self.copies())
        self.assertEqual(fg.read_foreground(self.slug)['rows']['busy']['node']['turns'],
                         store.load_org(self.slug).nodes['busy']['turns'])

    def test_p8_install_removes_orphans(self):
        self.sql("INSERT INTO node_tree_val VALUES('ghost','{}')")
        oid = self.sql('SELECT current_schema()')[0][0].split('_')[1]
        self.sql(('SELECT public.orgtree_install_tree_val(%s)', (int(oid),)))
        self.assertEqual(self.stale(), [])

    def test_p9_bulk_python_save_many_nodes(self):
        org = store.load_org(self.slug)
        for i in range(20):
            org.hire(ledger.USER, 'boss', 'luna', 0, f'n{i}')
            org.nodes[f'n{i}']['turns'] = turns(i)
        store.save_org(org)
        self.assertEqual(self.stale(), [])
        self.assertEqual({x for x in self.copies() if x.startswith('n')},
                         {f'n{i}' for i in range(9, 20)})


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class LateMigrationOrder(unittest.TestCase):
    """0004 applied AFTER 0016 (migrate applies any pending file)."""

    def test_late_0004(self):
        import psycopg
        db = f'orgtree_tvlate_{os.getpid()}'
        with psycopg.connect(fixture.ADMIN, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS {db}')
            c.execute(f'CREATE DATABASE {db}')
        url = fixture._with_db(fixture.ADMIN, db)
        try:
            d = Path(tempfile.mkdtemp())
            for p in pgstore.migration_files():
                if not p.name.startswith('0004'):
                    shutil.copy(p, d / p.name)
            with psycopg.connect(url, autocommit=True) as c:
                res = pgstore.migrate(c, d)
                self.assertNotIn('0004_foreground_nodes.sql', res['applied'])
                oid = c.execute("INSERT INTO public.orgs(slug) VALUES('late') RETURNING org_id").fetchone()[0]
                c.execute('SELECT public.orgtree_create_org_schema(%s)', (oid,))
                s = f'org_{oid}'
                big = store._dumps({'id': 'x', 'turns': turns(20)})
                c.execute(f'INSERT INTO {s}.nodes(id,ord,val) VALUES(%s,%s,%s)', ('x', 0, big))
                self.assertEqual(c.execute(f'SELECT count(*) FROM {s}.node_tree_val').fetchone()[0], 1)
                res = pgstore.migrate(c)          # now 0004 lands, late
                self.assertEqual(res['applied'], ['0004_foreground_nodes.sql'])
                # an old org keeps both triggers and a current copy
                big2 = store._dumps({'id': 'x', 'turns': turns(21)})
                c.execute(f'UPDATE {s}.nodes SET val=%s WHERE id=%s', (big2, 'x'))
                c.execute(f'SET search_path TO {s},public')
                self.assertEqual(c.execute(STALE).fetchall(), [])
                self.assertEqual(c.execute('SELECT count(*) FROM node_index').fetchone()[0], 1)
                # a new org gets both
                oid2 = c.execute("INSERT INTO public.orgs(slug) VALUES('late2') RETURNING org_id").fetchone()[0]
                c.execute('SELECT public.orgtree_create_org_schema(%s)', (oid2,))
                c.execute(f'SET search_path TO org_{oid2},public')
                c.execute('INSERT INTO nodes(id,ord,val) VALUES(%s,%s,%s)', ('x', 0, big))
                self.assertEqual(c.execute(STALE).fetchall(), [])
                self.assertEqual(c.execute('SELECT count(*) FROM node_tree_val').fetchone()[0], 1)
                self.assertEqual(c.execute('SELECT count(*) FROM node_index').fetchone()[0], 1)
        finally:
            with psycopg.connect(fixture.ADMIN, autocommit=True) as c:
                c.execute(f'DROP DATABASE IF EXISTS {db} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
