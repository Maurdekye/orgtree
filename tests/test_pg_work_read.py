"""Actual-PG authority and history controls for snapshot-scoped docket counts."""
import json
import threading
import time
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, store, workrows, workread
from orgtree.ledger import Org, USER


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Counts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        self.slug=f._fresh_org('counts-'+self._testMethodName)
        self.c=pgstore.connect()
        self.oid=self.c.execute('SELECT org_id FROM public.orgs WHERE slug=%s',(self.slug,)).fetchone()[0]
        self.s='org_'+str(self.oid)
        self.now=2000000000.0

    def tearDown(self):
        self.c.close()

    def item(self, slug='one', **kw):
        return dict(slug=slug,status='open',owner={'node':'a','generation':0},
                    **kw)

    def add(self,item,archive=False):
        body=json.dumps(item)
        if archive:
            self.c.execute(f"INSERT INTO {self.s}.log_l(sect,val) VALUES('work_items_archive',%s)",(body,))
        else:
            self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val',(workrows.PREFIX+item['slug'],body))
            ids=[r[0] for r in self.c.execute(f"SELECT slug FROM {self.s}.work_index WHERE location='active'")]
            self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val',('work_items',workrows.header(ids)))

    def refresh(self):
        with self.c.transaction():
            self.assertTrue(workread.refresh(self.c,self.oid))

    def counts(self,viewer=USER):
        with pgstore.connect() as c,c.transaction():
            c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            return workread.counts_raw(c,self.oid,viewer=viewer,now_ts=self.now)

    def oracle(self,viewer=USER):
        # Canonical Org policy on complete raw data, independently of summaries.
        org=store.load_org(self.slug)
        result=dict(active=0,attention=0,archived=0,backlogged=0)
        for rows,physical in ((org.d.get('work_items',[]),False),(org.d.get('work_items_archive',[]),True)):
            for item in rows:
                if not org._work_can_read(viewer,item): continue
                if org._work_attention(item): result['attention']+=1
                if org._work_archived(item,physical,self.now): result['archived']+=1
                elif org._work_backlogged(item): result['backlogged']+=1
                elif org._work_counts_active(item): result['active']+=1
        return result

    def node(self,nid,parent):
        self.c.execute(f'INSERT INTO {self.s}.nodes(id,ord,val) VALUES(%s,99,%s) ON CONFLICT(id) DO UPDATE SET val=excluded.val',
            (nid,json.dumps(dict(id=nid,name=nid,parent=parent,children=[]))))

    def asks(self,opened=True):
        value=[dict(id='ask1',node='a',status='open' if opened else 'closed',questions=[dict(work_item='archive',question='why?')])]
        self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val',('asks',json.dumps(value)))

    def test_viewer_roles_use_exact_predicates_and_no_hidden_counts(self):
        self.node('a','b')
        self.add(self.item(created_by={'node':'creator'},reviewer={'node':'reviewer'},participants=['member']))
        self.add(dict(self.item('hidden'),owner={'node':'c'}),True)
        self.refresh()
        for viewer in (USER,'a','b','c','creator','reviewer','member','stranger'):
            with self.subTest(viewer=viewer): self.assertEqual(self.counts(viewer),self.oracle(viewer))
        self.assertEqual(self.counts('stranger'),dict(active=0,attention=0,archived=0,backlogged=0))

    def test_attention_keeps_physical_archive_and_backlog_visible(self):
        self.add(dict(self.item('archive'),status='done'),True)
        self.add(dict(self.item('backlog'),status='backlogged',manual_attention={'reason':'look'}))
        self.asks(); self.refresh()
        self.assertEqual(self.counts(),dict(active=0,attention=2,archived=0,backlogged=0))
        self.assertEqual(self.counts(),self.oracle())
        self.asks(False)
        self.assertIsNone(self.counts())
        self.refresh()
        self.assertEqual(self.counts(),dict(active=0,attention=1,archived=1,backlogged=0))

    def test_attention_raises_name_each_readable_manual_raise_like_the_exact_path(self):
        # One identity per raise (slug, set_rev) beside the toolbar count, so a
        # dismissed raise leaves the Work glow at once and a new one never hides
        # behind it (docket v3-dismissing-a-ticket-s-attention-flag-must-sto).
        self.node('a','b')
        self.add(dict(self.item('one'),manual_attention={'reason':'look','set_rev':4}))
        self.add(dict(self.item('theirs'),owner={'node':'c'},manual_attention={'reason':'x','set_rev':2}))
        self.add(self.item('plain'))
        self.refresh()
        def raises(viewer):
            with pgstore.connect() as c,c.transaction():
                c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                return workread.attention_raises_raw(c,self.oid,viewer=viewer)
        self.assertEqual(raises(USER),[['one',4],['theirs',2]])
        self.assertEqual(raises(USER),store.load_org(self.slug).work_attention_raises())
        self.assertEqual(raises('a'),[['one',4]],'only the tickets this viewer can read')
        self.assertEqual(raises('stranger'),[])
        self.assertEqual(self.counts()['attention'],len(raises(USER)))

    def test_deadline_strict_boundary_malformed_and_legacy_status(self):
        from datetime import datetime,timezone
        stamp=datetime.fromtimestamp(self.now-3600,tz=timezone.utc).isoformat()
        for name,status,date in [('boundary','done',stamp),('malformed','done','bad'),('dropped','dropped',stamp),('waiting','waiting',stamp),('backlog','backlogged',stamp)]:
            self.add(dict(self.item(name),status=status,docket_at=date))
        self.refresh()
        self.assertEqual(self.counts(),self.oracle())
        self.assertEqual(self.counts()['archived'],1)
        self.now+=0.001
        self.assertEqual(self.counts(),self.oracle())
        self.assertEqual(self.counts()['archived'],2)

    def test_external_write_refuses_until_refreshed_and_header_corruption(self):
        self.add(self.item()); self.assertIsNone(self.counts()); self.refresh()
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
        self.assertIsNone(self.counts())
        with self.assertLogs('orgtree.workread',level='ERROR'):
            with self.c.transaction(): self.assertFalse(workread.refresh(self.c,self.oid))
        self.assertIsNone(self.counts())

    def test_reparent_missing_anchor_and_generation(self):
        self.node('a','b'); self.add(self.item()); self.refresh()
        self.assertEqual(self.counts('b')['active'],1)
        self.node('a','c'); self.assertIsNone(self.counts()); self.refresh()
        self.assertEqual(self.counts('b')['active'],0); self.assertEqual(self.counts('c')['active'],1)
        self.add(dict(self.item('absent'),owner={'node':'missing','generation':999}))
        self.refresh(); self.assertEqual(self.counts('missing')['active'],1)
        self.node('missing','b'); self.assertIsNone(self.counts()); self.refresh()
        self.assertEqual(self.counts('b')['active'],1)
        before=self.c.execute(f'SELECT revision FROM {self.s}.work_read_state').fetchone()
        self.c.execute(f"UPDATE {self.s}.nodes SET val=(val::jsonb || '{{\"generation\":100}}'::jsonb)::text WHERE id='missing'")
        self.assertEqual(self.c.execute(f'SELECT revision FROM {self.s}.work_read_state').fetchone(),before)
        self.assertEqual(self.counts('b'),self.oracle('b'))

    def test_delete_and_archive_move_roll_back_with_counts(self):
        item=self.item(); self.add(item); self.refresh(); before=self.counts()
        with self.assertRaisesRegex(RuntimeError,'CAS'),self.c.transaction():
            self.add(item,True)
            self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
            self.assertTrue(workread.refresh(self.c,self.oid))
            raise RuntimeError('CAS refused')
        self.assertEqual(self.counts(),before)
        with self.c.transaction():
            self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',))
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header([]),))
            self.assertTrue(workread.refresh(self.c,self.oid))
        self.assertEqual(self.counts()['active'],0)

    def test_raw_reconciliation_catches_counts_access_policy_and_questions(self):
        self.add(self.item()); self.refresh()
        faults=[f"UPDATE {self.s}.work_read_totals SET total=total+1 WHERE viewer='a'",
                f"DELETE FROM {self.s}.work_read_access WHERE viewer='a'",
                f"UPDATE {self.s}.work_read_policy SET manual=true",
                f"INSERT INTO {self.s}.work_read_dependency VALUES('orphan','b')",
                f"INSERT INTO {self.s}.work_read_questions VALUES('orphan','[]')"]
        for sql in faults:
            self.c.execute('BEGIN')
            try:
                self.c.execute(sql)
                with self.assertLogs('orgtree.workread',level='ERROR'):
                    self.assertFalse(workread.reconcile(self.c,self.oid))
                self.assertIsNone(workread.counts_raw(self.c,self.oid,viewer=USER,now_ts=self.now))
            finally: self.c.execute('ROLLBACK')
        self.assertEqual(self.counts(),self.oracle())

    def test_small_and_tenfold_history_decode_same_foreground(self):
        self.add(self.item()); observed=[]
        for target in (40,400):
            current=self.c.execute(f"SELECT count(*) FROM {self.s}.work_index WHERE location='archive'").fetchone()[0]
            with self.c.transaction():
                for i in range(current,target):
                    self.add(dict(self.item('history-'+str(i)),status='done',evidence=['x'*1000]),True)
                self.assertTrue(workread.refresh(self.c,self.oid))
            decoded=[]; original=workread._Policy._work_archived
            def count(policy,item,*args):
                decoded.append(item['slug']); return original(policy,item,*args)
            with patch.object(workread._Policy,'_work_archived',count): result=self.counts()
            observed.append(decoded)
            self.assertEqual(result,dict(active=1,attention=0,archived=target,backlogged=0))
        self.assertEqual(observed,[['one'],['one']])

    def test_repeatable_read_does_not_mix_counts_or_authority(self):
        self.add(self.item()); self.refresh()
        with pgstore.connect() as reader,reader.transaction():
            reader.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            before=workread.counts_raw(reader,self.oid,viewer='b',now_ts=self.now)
            self.node('a','b'); self.refresh()
            self.assertEqual(workread.counts_raw(reader,self.oid,viewer='b',now_ts=self.now),before)
        self.assertEqual(self.counts('b')['active'],1)

    def test_save_hook_refreshes_same_transaction_and_unrelated_save_is_readonly(self):
        org=store.load_org(self.slug); org.d['work_items']=[self.item()]; store.save_org(org)
        self.assertEqual(self.counts()['active'],1)
        before=self.c.execute(f'SELECT xmin::text,revision FROM {self.s}.work_read_state').fetchone()
        org=store.load_org(self.slug); org.d['settings_x']['v']=7; store.save_org(org)
        self.assertEqual(self.c.execute(f'SELECT xmin::text,revision FROM {self.s}.work_read_state').fetchone(),before)

    def test_concurrent_new_item_and_reparent_do_not_miss_dependency(self):
        started=threading.Event(); errors=[]; backend=[]
        def writer():
            try:
                with pgstore.connect() as c,c.transaction():
                    backend.append(c.execute('SELECT pg_backend_pid()').fetchone()[0])
                    started.set()
                    c.execute(f"UPDATE {self.s}.nodes SET val=(val::jsonb || '{{\"parent\":\"b\"}}')::text WHERE id='a'")
                    self.assertTrue(workread.refresh(c,self.oid))
            except BaseException as exc: errors.append(exc)
        with self.c.transaction():
            self.add(self.item())
            thread=threading.Thread(target=writer); thread.start(); self.assertTrue(started.wait(3))
            deadline=time.monotonic()+3; blocked=False
            with pgstore.connect() as observer:
                while time.monotonic()<deadline:
                    waiting=observer.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',(backend[0],)).fetchone()
                    if waiting and waiting[0]=='Lock': blocked=True; break
                    time.sleep(.01)
            self.assertTrue(blocked,'topology writer did not wait for dependency serialization')
            self.assertTrue(workread.refresh(self.c,self.oid))
        thread.join(10); self.assertFalse(thread.is_alive()); self.assertEqual(errors,[])
        self.assertEqual(self.counts('b')['active'],1)
        self.assertEqual(self.counts('b'),self.oracle('b'))

    def test_bootstrap_reconciles_uninitialized_and_skips_finished(self):
        self.add(self.item())
        self.c.execute(f'UPDATE {self.s}.work_read_state SET initialized=false,ready=false')
        workread.bootstrap(self.c)
        self.assertEqual(self.counts()['active'],1)
        with patch.object(workread,'reconcile',side_effect=AssertionError('repeated raw scan')):
            workread.bootstrap(self.c)

    def test_runtime_role_initializes_reads_and_updates_metadata(self):
        self.assertTrue(self.c.execute("SELECT 1 FROM pg_roles WHERE rolname='orgtree_runtime'").fetchone())
        with self.c.transaction():
            self.c.execute('SET LOCAL ROLE orgtree_runtime')
            oid=self.c.execute("INSERT INTO public.orgs(slug) VALUES('counts-runtime') RETURNING org_id").fetchone()[0]
            schema=self.c.execute('SELECT public.orgtree_create_org_schema(%s)',(oid,)).fetchone()[0]
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',('work_items',workrows.header(['one'])))
            self.c.execute(f'INSERT INTO {schema}.doc VALUES(%s,%s)',(workrows.PREFIX+'one',json.dumps(self.item())))
            self.assertTrue(workread.refresh(self.c,oid))
            self.assertEqual(workread.counts_raw(self.c,oid,viewer='a',now_ts=self.now)['active'],1)

    def test_real_import_replacement_refreshes_counts_without_losing_raw(self):
        import importlib.util
        import os
        import sys
        from pathlib import Path
        path=Path(__file__).resolve().parents[1]/'tools/pypg/pgimport.py'
        spec=importlib.util.spec_from_file_location('count_importer',path)
        module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
        sink=module.PgSink(os.environ['ORGTREE_PG_URL'],f.data/'orgs')
        body=json.dumps(dict(self.item(),future={'untouched':[1,True,None]}))
        rows={name:[] for name in module.TABLES}
        rows['doc']=[('work_items',workrows.header(['one'])),(workrows.PREFIX+'one',body)]
        try:
            sink.replace_org('counts-import',rows,{'source_fingerprint':'test'})
            oid=sink._org_id('counts-import')
            self.assertEqual(workread.counts_raw(sink.conn,oid,viewer='a',now_ts=self.now)['active'],1)
            self.assertEqual(dict(sink.read_org('counts-import')['doc'])[workrows.PREFIX+'one'],body)
            rows['doc']=[('work_items',workrows.header([]))]
            rows['log_l']=[(1,'work_items_archive',None,body)]
            sink.replace_org('counts-import',rows,{'source_fingerprint':'replacement'})
            self.assertEqual(workread.counts_raw(sink.conn,oid,viewer='a',now_ts=self.now),dict(active=0,attention=0,archived=1,backlogged=0))
        finally: sink.close()

    def test_bootstrap_refuses_summary_disagreeing_with_raw_authority(self):
        self.add(self.item())
        self.c.execute(f'UPDATE {self.s}.work_read_state SET initialized=false,ready=false')
        self.c.execute(f"UPDATE {self.s}.work_index SET summary=summary || '{{\"owner\":{{\"node\":\"b\"}}}}'")
        with self.assertLogs('orgtree.workread',level='ERROR'):
            workread.bootstrap(self.c)
        self.assertIsNone(self.counts('b'))
        self.assertEqual(json.loads(self.c.execute(f'SELECT val FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone()[0])['owner']['node'],'a')

    def test_incomplete_legacy_ask_preserves_raw_save_and_refuses_counts(self):
        org=store.load_org(self.slug)
        org.d['work_items']=[self.item()]
        malformed=[dict(id='legacy',status='open',questions=[dict(work_item='one')])]
        org.d['asks']=malformed
        with self.assertLogs('orgtree.workread',level='ERROR'):
            store.save_org(org)
        self.assertEqual(json.loads(self.c.execute(f"SELECT val FROM {self.s}.doc WHERE key='asks'").fetchone()[0]),malformed)
        self.assertIsNone(self.counts())


if __name__ == '__main__':
    unittest.main()
