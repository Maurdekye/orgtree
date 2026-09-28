"""Real PG controls for atomic derived docket metadata; skips are not passes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, store, workrows, workindex


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Index(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        self.slug = f._fresh_org('index-' + self._testMethodName)
        self.c = pgstore.connect()
        self.oid = self.c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (self.slug,)).fetchone()[0]
        self.s = 'org_' + str(self.oid)

    def tearDown(self):
        self.c.close()

    def source(self, slug='one', **extra):
        return json.dumps(dict(slug=slug, rev=1, title='Visible', status='open',
            owner={'node':'a','generation':3,'born':'mint'}, participants=['b'],
            evidence=[{'unknown_future_field': 'x'*100}], **extra), indent=2)

    def add(self, body, archive=False):
        slug = json.loads(body)['slug']
        if archive:
            return self.c.execute(f"INSERT INTO {self.s}.log_l(sect,val) VALUES('work_items_archive',%s) RETURNING seq", (body,)).fetchone()[0]
        self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s)', (workrows.PREFIX+slug,body))
        ids = [r[0] for r in self.c.execute(f"SELECT slug FROM {self.s}.work_index WHERE location='active' ORDER BY slug")]
        self.c.execute(f'INSERT INTO {self.s}.doc(key,val) VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val', ('work_items',workrows.header(ids)))

    def check(self):
        self.assertTrue(workindex.reconcile(self.c,self.oid))
        self.assertTrue(workindex.ready(self.c,self.oid))

    def test_exact_summary_raw_digest_and_unknown_fields_preserved(self):
        raw=self.source(future={'number':1.234567890123456789,'nested':[True,None]})
        self.add(raw); self.check()
        summary,digest=self.c.execute(f"SELECT summary,body_sha256 FROM {self.s}.work_index WHERE slug='one'").fetchone()
        self.assertEqual(summary['owner'],{'node':'a','generation':3,'born':'mint'})
        self.assertEqual(summary['participants'],['b'])
        self.assertNotIn('evidence',summary); self.assertNotIn('future',summary)
        self.assertEqual(bytes(digest),hashlib.sha256(raw.encode()).digest())
        self.assertEqual(self.c.execute(f'SELECT val FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone()[0],raw)

    def test_move_archive_reopen_and_delete_are_atomic(self):
        body=self.source(); self.add(body)
        with self.c.transaction():
            seq=self.add(body,True)  # insert before delete: deferrable identity
            self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.check()
        self.assertEqual(self.c.execute(f'SELECT active_rows,archive_rows FROM {self.s}.work_index_state').fetchone(),(0,1))
        with self.c.transaction():
            self.add(body)
            self.c.execute(f'DELETE FROM {self.s}.log_l WHERE seq=%s',(seq,))
        self.check()
        self.assertEqual(self.c.execute(f'SELECT active_rows,archive_rows FROM {self.s}.work_index_state').fetchone(),(1,0))
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.check()

    def test_duplicate_commit_and_invalid_slug_roll_back(self):
        self.add(self.source()); before=self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall()
        with self.assertRaises(Exception),self.c.transaction():
            self.add(self.source(),True)
        self.assertEqual(self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall(),before)
        with self.assertRaises(Exception):
            self.c.execute(f'UPDATE {self.s}.doc SET val=%s WHERE key=%s',(self.source('different'),workrows.PREFIX+'one'))
        self.check()

    def test_summary_and_counter_updates_roll_back_with_cas(self):
        self.add(self.source()); before=self.c.execute(f'SELECT * FROM {self.s}.work_index').fetchall()
        counter=self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall()
        with self.assertRaisesRegex(RuntimeError,'stale'),self.c.transaction():
            self.c.execute(f'UPDATE {self.s}.doc SET val=%s WHERE key=%s',(self.source(manual_attention={'reason':'look'}),workrows.PREFIX+'one'))
            raise RuntimeError('stale CAS later in transaction')
        self.assertEqual(self.c.execute(f'SELECT * FROM {self.s}.work_index').fetchall(),before)
        self.assertEqual(self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall(),counter)
        self.check()

    def test_reconciliation_catches_counter_summary_hash_and_omission(self):
        self.add(self.source()); self.check()
        corruptions = [
            f'UPDATE {self.s}.work_index_state SET active_rows=99',
            f"UPDATE {self.s}.work_index SET summary=summary || '{{\"participants\":[\"stranger\"]}}'::jsonb",
            f"UPDATE {self.s}.work_index SET body_sha256=decode('00','hex')",
            f'DELETE FROM {self.s}.work_index',
        ]
        for sql in corruptions:
            self.c.execute('BEGIN')
            try:
                self.c.execute(sql)
                with self.assertLogs('orgtree.workindex',level='ERROR') as messages:
                    self.assertFalse(workindex.reconcile(self.c,self.oid))
                self.assertIn('exact raw path',messages.output[0])
                self.assertFalse(workindex.ready(self.c,self.oid))
                # Source is still reachable with the exact compatibility path.
                self.assertEqual(self.c.execute(f'SELECT val FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone()[0],self.source())
            finally:
                self.c.execute('ROLLBACK')
        self.check()

    def test_header_orphan_mismatch_refuses_health(self):
        self.add(self.source())
        for header in (workrows.header([]),workrows.header(['one','one']),'{"format":"future","ids":["one"]}'):
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(header,))
            with self.assertLogs('orgtree.workindex',level='ERROR'):
                self.assertFalse(workindex.reconcile(self.c,self.oid))
            self.assertFalse(workindex.ready(self.c,self.oid))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header(['one']),))
        self.check()

    def test_copy_import_and_unrelated_log_do_not_bypass_index(self):
        rows=[('work_items_archive',self.source('archive-'+str(i))) for i in range(4)]
        with self.c.cursor().copy(f'COPY {self.s}.log_l(sect,val) FROM STDIN') as copy:
            for row in rows: copy.write_row(row)
        self.check()
        before=self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall()
        self.c.execute(f"INSERT INTO {self.s}.log_l(sect,val) VALUES('events','{{}}')")
        self.assertEqual(self.c.execute(f'SELECT * FROM {self.s}.work_index_state').fetchall(),before)
        self.c.execute(f"DELETE FROM {self.s}.log_l WHERE sect='work_items_archive'")
        self.check()

    def test_reader_keeps_source_and_index_in_one_snapshot(self):
        self.add(self.source())
        with pgstore.connect() as reader:
            reader.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            before=reader.execute(f"SELECT summary FROM {self.s}.work_index WHERE slug='one'").fetchone()[0]
            revised=json.loads(self.source()); revised['rev']=2; revised['participants']=['c']
            self.c.execute(f'UPDATE {self.s}.doc SET val=%s WHERE key=%s',(json.dumps(revised),workrows.PREFIX+'one'))
            old_body=reader.execute(f'SELECT val FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone()[0]
            self.assertEqual(before['rev'],json.loads(old_body)['rev'])
            self.assertEqual(before['participants'],json.loads(old_body)['participants'])
            reader.execute('COMMIT')
        self.assertEqual(self.c.execute(f"SELECT summary->'participants' FROM {self.s}.work_index WHERE slug='one'").fetchone()[0],['c'])
        self.check()

    def test_runtime_role_creates_and_writes_through_wrapped_creator(self):
        if not self.c.execute("SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime'").fetchone():
            self.skipTest('runtime role absent: NOT RUN')
        with self.c.transaction():
            self.c.execute('SET LOCAL ROLE orgtree_runtime')
            oid=self.c.execute("INSERT INTO public.orgs(slug) VALUES('runtime-index') RETURNING org_id").fetchone()[0]
            schema=self.c.execute('SELECT public.orgtree_create_org_schema(%s)',(oid,)).fetchone()[0]
            body=self.source('runtime')
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',('work_items',workrows.header(['runtime'])))
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',(workrows.PREFIX+'runtime',body))
            self.assertTrue(workindex.reconcile(self.c,oid))
            self.assertTrue(workindex.ready(self.c,oid))
            self.assertEqual(self.c.execute(f'SELECT active_rows FROM {schema}.work_index_state').fetchone()[0],1)

    def test_tenfold_archive_keeps_active_answer_and_exact_lookup_one_row(self):
        self.add(self.source()); active=[]
        for size in (40,400):
            start=0 if size==40 else 40
            with self.c.cursor().copy(f'COPY {self.s}.log_l(sect,val) FROM STDIN') as copy:
                for i in range(start,size): copy.write_row(('work_items_archive',self.source('old-'+str(i))))
            self.check()
            active.append(self.c.execute(f"SELECT slug,summary FROM {self.s}.work_index WHERE location='active'").fetchall())
            for slug in ('old-0','old-'+str(size//2),'old-'+str(size-1)):
                rows=self.c.execute(f"SELECT l.val FROM {self.s}.work_index i JOIN {self.s}.log_l l ON l.seq=i.source_key::bigint WHERE i.slug=%s AND i.location='archive'",(slug,)).fetchall()
                self.assertEqual(len(rows),1); self.assertEqual(json.loads(rows[0][0])['slug'],slug)
            self.assertEqual(self.c.execute(f'SELECT active_rows,archive_rows FROM {self.s}.work_index_state').fetchone(),(1,size))
        self.assertEqual(active[0],active[1])


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Migration(unittest.TestCase):
    def setUp(self):
        self.name='work_index_upgrade_'+str(os.getpid())
        with pgstore.connect(f.ADMIN) as c:
            c.execute(f'DROP DATABASE IF EXISTS {self.name} WITH (FORCE)'); c.execute(f'CREATE DATABASE {self.name}')
        self.c=pgstore.connect(f._with_db(f.ADMIN,self.name))
        self.folder=tempfile.TemporaryDirectory()
        for p in pgstore.migration_files():
            if p.name < '0006': shutil.copy(p,Path(self.folder.name)/p.name)
        pgstore.migrate(self.c,Path(self.folder.name))
        self.c.execute("INSERT INTO public.orgs(slug) VALUES('upgrade')")
        self.c.execute('SELECT public.orgtree_create_org_schema(1)')
        self.raw='{"slug":"old","future":{"number":1.0000},"evidence":[{"x":"retained"}]}'
        self.c.execute("INSERT INTO org_1.doc VALUES('work_items',%s)",(workrows.header(['old']),))
        self.c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',(workrows.PREFIX+'old',self.raw))

    def tearDown(self):
        self.c.close(); self.folder.cleanup()
        with pgstore.connect(f.ADMIN) as c: c.execute(f'DROP DATABASE {self.name} WITH (FORCE)')

    def test_migration_preserves_raw_text_and_reconciles(self):
        before=self.c.execute('SELECT key,val FROM org_1.doc ORDER BY key').fetchall()
        result=pgstore.migrate(self.c)
        self.assertIn('0006_work_index.sql',result['applied'])
        self.assertEqual(self.c.execute('SELECT key,val FROM org_1.doc ORDER BY key').fetchall(),before)
        self.assertTrue(workindex.ready(self.c,1)); self.assertTrue(workindex.reconcile(self.c,1))
        receipt=json.loads(self.c.execute("SELECT result FROM public.receipts WHERE op_key='work-index/v1'").fetchone()[0])
        self.assertEqual(receipt['count'],1); self.assertEqual(len(receipt['source_sha256']),64)
        self.assertEqual(pgstore.migrate(self.c)['applied'],[])

    def test_migration_missing_header_member_refuses_and_rolls_back(self):
        self.c.execute("UPDATE org_1.doc SET val=%s WHERE key='work_items'",(workrows.header(['old','missing']),))
        with self.assertRaisesRegex(Exception,'reconciliation mismatch'): pgstore.migrate(self.c)
        self.assertIsNone(self.c.execute("SELECT to_regclass('org_1.work_index')").fetchone()[0])
        self.assertEqual(self.c.execute('SELECT val FROM org_1.doc WHERE key=%s',(workrows.PREFIX+'old',)).fetchone()[0],self.raw)


if __name__=='__main__': unittest.main()
