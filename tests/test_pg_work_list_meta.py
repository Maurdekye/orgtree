"""Actual-PG list metadata; raw ledger projection remains the oracle."""
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as fixture
from orgtree import store, pgstore, workread, worklistmeta, workrows


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Metadata(unittest.TestCase):
    setUp = fixture.Counts.setUp
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def read(self, slug='one'):
        return self.c.execute(f'SELECT payload FROM {self.s}.work_list_summary WHERE slug=%s', (slug,)).fetchone()[0]

    def item(self, slug='one', **kw):
        return dict(fixture.Counts.item(self,slug), **kw)

    def test_static_fields_equal_raw_ledger_with_scope_and_legacy_history(self):
        item = self.item(scope_logged=2, scope_rolled=1,
                         scope=[{'seq':3,'at':'2023','kind':'decision'}],
                         history=[{'op':'update','at':'2020','changes':{'status':{}}}])
        item.pop('status_at', None)
        self.add(item)
        for seq in (1,2):
            self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                           (json.dumps({'seq':seq,'at':str(seq),'kind':'decision'}),))
        self.refresh()
        org = store.load_org(self.slug)
        raw = org._work_find('one')[0]
        payload = self.read()
        self.assertEqual(payload['objective_notice'], org._work_objective_notice(raw))
        self.assertEqual(payload['scope_archive_summary'], org._work_scope_archive_summary(raw))
        self.assertEqual(payload['status_at'], org._work_status_at(raw))
        self.assertEqual(payload['status_at'], '2020')
        self.assertNotIn('history', payload)
        self.assertNotIn('scope', payload)
        self.assertTrue(worklistmeta.ready(self.c,self.oid))

    def test_scope_only_external_change_is_dirty_and_refreshed(self):
        self.add(self.item(scope_logged=1, scope_rolled=1))
        self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                       (json.dumps({'seq':1,'at':'old'}),))
        self.refresh()
        self.c.execute(f"UPDATE {self.s}.log_d SET val=%s WHERE sect='work_scope_log' AND owner='one'",
                       (json.dumps({'seq':1,'at':'new'}),))
        self.assertFalse(worklistmeta.ready(self.c,self.oid))
        # The access fast path is clean; list refresh must still run.
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_read_dirty').fetchone())
        self.refresh()
        self.assertEqual(self.read()['scope_archive_summary']['first_at'],'new')
        self.assertTrue(worklistmeta.ready(self.c,self.oid))

    def test_small_and_tenfold_history_refresh_decodes_only_changed_body(self):
        sizes=[]
        for total in (20,200):
            start = 0 if total==20 else 20
            for i in range(start,total):
                self.add(self.item('old-'+str(i),status='done',evidence=[{'note':'x'*1000}]),True)
            self.add(self.item()); self.refresh()
            self.add(self.item(title='changed'))
            original=worklistmeta._body
            with patch.object(worklistmeta,'_body',wraps=original) as body:
                self.refresh()
                self.assertEqual(body.call_count,1)
            sizes.append(len(json.dumps(self.read())))
            with patch.object(worklistmeta,'_body',side_effect=AssertionError('history read on clean save')):
                self.refresh()
        self.assertEqual(sizes[0],sizes[1])

    def test_archive_reopen_delete_and_rollback_preserve_metadata(self):
        self.add(self.item()); self.refresh(); before=self.read()
        with self.assertRaisesRegex(RuntimeError,'rollback'):
            with self.c.transaction():
                self.add(self.item(title='uncommitted')); self.refresh()
                raise RuntimeError('rollback')
        self.assertEqual(self.read(),before)
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.add(self.item(status='done'),True); self.refresh()
        self.assertEqual(self.read()['status'],'done')
        self.c.execute(f"DELETE FROM {self.s}.log_l WHERE sect='work_items_archive'")
        self.add(self.item()); self.refresh()
        self.assertEqual(self.read()['status'],'open')
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.refresh()
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_summary').fetchone())

    def test_reconciliation_catches_payload_hash_and_extra_rows(self):
        self.add(self.item()); self.refresh()
        for sql in (f"UPDATE {self.s}.work_list_summary SET payload='{{}}'",
                    f"UPDATE {self.s}.work_list_summary SET body_sha256='wrong'::bytea",
                    f"INSERT INTO {self.s}.work_list_summary VALUES('ghost','wrong'::bytea,'{{}}')"):
            with self.c.transaction(force_rollback=True):
                self.c.execute(sql)
                with self.assertLogs('orgtree.worklistmeta',level='ERROR'):
                    self.assertFalse(worklistmeta.reconcile(self.c,self.oid))
                self.assertFalse(worklistmeta.ready(self.c,self.oid))

    def test_malformed_scope_fails_closed_without_losing_raw_save(self):
        self.add(self.item(scope_logged=1))
        with self.assertLogs('orgtree.worklistmeta',level='ERROR'):
            self.refresh()
        self.assertFalse(worklistmeta.ready(self.c,self.oid))
        self.assertTrue(self.c.execute(f'SELECT 1 FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone())
        self.assertTrue(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_identity_stamp_excludes_status_text_but_includes_current_mint(self):
        self.add(self.item()); self.refresh()
        def rev():
            return self.c.execute(f'SELECT revision FROM {self.s}.work_list_state').fetchone()[0]
        before=rev()
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{status}}','\"working\"')::text WHERE id='a'")
        self.assertEqual(rev(),before)
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{seat_id}}','\"new-mint\"')::text WHERE id='a'")
        self.assertGreater(rev(),before)
        self.assertFalse(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_bootstrap_initializes_and_refreshes_scope_only_pending(self):
        self.add(self.item())
        with self.c.transaction(): workread.bootstrap(self.c)
        self.assertTrue(worklistmeta.ready(self.c,self.oid))
        self.c.execute(f"UPDATE {self.s}.work_list_summary SET payload='{{}}'")
        self.c.execute(f"INSERT INTO {self.s}.work_list_dirty VALUES('one')")
        with self.c.transaction(): workread.bootstrap(self.c)
        self.assertEqual(self.read()['slug'],'one')

    def test_concurrent_scope_writer_blocks_without_losing_dirty_marker(self):
        import threading
        import time
        self.add(self.item(scope_logged=1,scope_rolled=1))
        self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                       (json.dumps({'seq':1,'at':'old'}),))
        self.refresh()
        done=threading.Event(); entered=threading.Event(); errors=[]; pid=[]
        def writer():
            try:
                with pgstore.connect() as c:
                    pid.append(c.execute('SELECT pg_backend_pid()').fetchone()[0]); entered.set()
                    c.execute(f"UPDATE {self.s}.log_d SET val=%s WHERE sect='work_scope_log' AND owner='one'",
                              (json.dumps({'seq':1,'at':'new'}),))
            except Exception as exc: errors.append(repr(exc))
            finally: done.set()
        with self.c.transaction():
            self.c.execute(f'SELECT singleton FROM {self.s}.work_read_state FOR UPDATE')
            thread=threading.Thread(target=writer); thread.start()
            self.assertTrue(entered.wait(5))
            try:
                observed=False
                for _ in range(100):
                    row=self.c.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',(pid[0],)).fetchone()
                    if row and row[0]=='Lock': observed=True; break
                    time.sleep(.01)
                self.assertTrue(observed,'control must observe the writer blocked on a DB lock')
                self.assertFalse(done.is_set())
                self.refresh()
            finally:
                # Commit releases the lock before joining below.
                pass
        thread.join(5); self.assertTrue(done.is_set()); self.assertEqual(errors,[])
        self.assertFalse(worklistmeta.ready(self.c,self.oid))
        self.refresh()
        self.assertEqual(self.read()['scope_archive_summary']['first_at'],'new')

    def test_runtime_creation_and_real_import_preserve_raw(self):
        import importlib.util
        import os
        import sys
        from pathlib import Path
        with self.c.transaction():
            self.c.execute('SET LOCAL ROLE orgtree_runtime')
            oid=self.c.execute("INSERT INTO public.orgs(slug) VALUES('list-runtime') RETURNING org_id").fetchone()[0]
            schema=self.c.execute('SELECT public.orgtree_create_org_schema(%s)',(oid,)).fetchone()[0]
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',('work_items',workrows.header(['one'])))
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',(workrows.PREFIX+'one',json.dumps(self.item())))
            self.assertTrue(workread.refresh(self.c,oid))
            self.assertTrue(worklistmeta.ready(self.c,oid))
        path=Path(__file__).resolve().parents[1]/'tools/pypg/pgimport.py'
        spec=importlib.util.spec_from_file_location('list_importer',path)
        module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
        sink=module.PgSink(os.environ['ORGTREE_PG_URL'],f.data/'orgs')
        body=json.dumps(dict(self.item(),future={'untouched':[1,True,None]}))
        rows={name:[] for name in module.TABLES}
        rows['doc']=[('work_items',workrows.header(['one'])),(workrows.PREFIX+'one',body)]
        try:
            sink.replace_org('list-import',rows,{'source_fingerprint':'test'})
            oid=sink._org_id('list-import')
            self.assertTrue(worklistmeta.ready(sink.conn,oid))
            self.assertEqual(dict(sink.read_org('list-import')['doc'])[workrows.PREFIX+'one'],body)
            rows['doc']=[('work_items',workrows.header([]))]
            rows['log_l']=[(1,'work_items_archive',None,body)]
            sink.replace_org('list-import',rows,{'source_fingerprint':'replacement'})
            self.assertTrue(worklistmeta.reconcile(sink.conn,oid))
            self.assertEqual(sink.conn.execute(f'SELECT count(*) FROM org_{oid}.work_list_summary').fetchone()[0],1)
        finally: sink.close()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Upgrade(unittest.TestCase):
    def test_populated_migration_refuses_bad_hash_and_bootstraps_exact_raw(self):
        import os
        from pathlib import Path
        import shutil
        import tempfile
        name='work_list_upgrade_'+str(os.getpid())
        with pgstore.connect(f.ADMIN) as c: c.execute(f'CREATE DATABASE {name}')
        try:
            with pgstore.connect(f._with_db(f.ADMIN,name)) as c, tempfile.TemporaryDirectory() as folder:
                for p in pgstore.migration_files():
                    if p.name<'0012': shutil.copy(p,Path(folder)/p.name)
                pgstore.migrate(c,Path(folder))
                c.execute("INSERT INTO public.orgs(slug) VALUES('upgrade')")
                c.execute('SELECT public.orgtree_create_org_schema(1)')
                body='{"slug":"old", "owner":{"node":"a"},"future":1.0000}'
                c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',('work_items',workrows.header(['old'])))
                c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',(workrows.PREFIX+'old',body))
                self.assertTrue(workread.refresh(c,1))
                c.execute("UPDATE org_1.work_index SET body_sha256=decode('00','hex')")
                with self.assertRaisesRegex(Exception,'list migration reconciliation failed'): pgstore.migrate(c)
                self.assertIsNone(c.execute("SELECT to_regclass('org_1.work_list_summary')").fetchone()[0])
                c.execute("UPDATE org_1.work_index SET body_sha256=sha256(convert_to(%s,'UTF8'))",(body,))
                self.assertIn('0012_work_list.sql',pgstore.migrate(c)['applied'])
                self.assertFalse(worklistmeta.ready(c,1))
                workread.bootstrap(c)
                self.assertTrue(worklistmeta.ready(c,1))
                self.assertTrue(worklistmeta.reconcile(c,1))
                self.assertEqual(c.execute('SELECT val FROM org_1.doc WHERE key=%s',(workrows.PREFIX+'old',)).fetchone()[0],body)
        finally:
            with pgstore.connect(f.ADMIN) as c: c.execute(f'DROP DATABASE {name} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
