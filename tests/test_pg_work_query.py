"""Bounded raw selectors: actual PostgreSQL, independent canonical oracle."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, store, workrows, workread, workquery
from orgtree.ledger import USER, Org


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Queries(unittest.TestCase):
    setUp = fixture.Counts.setUp
    tearDown = fixture.Counts.tearDown
    item = fixture.Counts.item
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh
    node = fixture.Counts.node
    asks = fixture.Counts.asks

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    @contextmanager
    def read(self, viewer=USER, now=None):
        with pgstore.connect() as c, c.transaction():
            c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            yield workquery.Snapshot(c, self.oid, viewer=viewer, now_ts=self.now if now is None else now)

    def oracle(self, viewer=USER, archive=False, backlog=False):
        org=store.load_org(self.slug)
        values=[]
        for rows, physical in ((org.d.get('work_items',[]),False),(org.d.get('work_items_archive',[]),True)):
            for item in rows:
                if not org._work_can_read(viewer,item): continue
                if org._work_archived(item,physical,self.now) != archive: continue
                if not archive and not backlog and org._work_backlogged(item): continue
                values.append(item)
        return [it['slug'] for it in sorted(values,key=lambda it:(str(it.get('docket_at') or it.get('updated_at') or ''),it['slug']),reverse=True)]

    def test_foreground_matches_authority_attention_and_backlog(self):
        self.node('a','b')
        self.add(self.item('one',docket_at='2020',evidence=['big'*1000]))
        self.add(dict(self.item('waiting'),status='waiting'))
        self.add(dict(self.item('backlog'),status='backlogged'))
        self.add(dict(self.item('flagged'),status='backlogged',manual_attention={'why':'open'}))
        self.add(dict(self.item('archive'),status='done'),True)
        self.add(dict(self.item('hidden'),owner={'node':'c'}),True)
        self.asks(); self.refresh()
        for viewer in (USER,'a','b','c','stranger'):
            for backlog in (False,True):
                with self.read(viewer) as query:
                    rows=query.foreground(include_backlogged=backlog)
                    self.assertEqual([r.summary['slug'] for r in rows],self.oracle(viewer,backlog=backlog))
                    self.assertTrue(all('evidence' not in r.summary and '_query' not in r.summary for r in rows))

    def test_exact_detail_reads_one_body_at_small_and_tenfold_history(self):
        self.add(self.item()); retained=[]; old_rows=[]; new_rows=[]
        for start, end in ((0,40),(40,400)):
            with self.c.transaction():
                for n in range(start,end):
                    self.add(dict(self.item('old-'+str(n)),status='done',evidence=['x'*1000]),True)
                workread.refresh(self.c,self.oid)
            with self.read() as query:
                original=workquery.json.loads; decoded=[]
                def observe(raw,*a,**kw):
                    value=original(raw,*a,**kw)
                    if isinstance(value,dict) and 'slug' in value: decoded.append(value['slug'])
                    return value
                with patch.object(workquery.json,'loads',observe):
                    body,physical=query.detail('old-17')
                self.assertEqual(decoded,['old-17'])
                new_rows.append(len(decoded))
                self.assertTrue(physical); self.assertEqual(body['evidence'],['x'*1000])
                retained.append([r.summary for r in query.foreground()])
                self.assertIsNone(query.lookup('missing'))
            with self.read('stranger') as query:
                self.assertIsNone(query.detail('old-17'))
                self.assertIsNone(query.detail('missing'))
            # The prior lookup really materializes the entire source archive.
            original_archive=Org._work_archive
            def observe_archive(org):
                values=original_archive(org); old_rows.append(len(values)); return values
            with patch.object(Org,'_work_archive',observe_archive):
                legacy,physical=store.load_org(self.slug)._work_find('old-17')
            self.assertTrue(physical); self.assertEqual(legacy,body)
        self.assertEqual(retained[0],retained[1])
        self.assertEqual(old_rows,[40,400]); self.assertEqual(new_rows,[1,1])

    def test_archive_pages_match_exact_order_without_gaps(self):
        for name,stamp in [('a',''),('z','same'),('é','same'),('😀','same'),('fallback',None),('new','zzz')]:
            self.add(dict(self.item(name),status='done',docket_at=stamp,updated_at='fall'),True)
        self.add(dict(self.item('aged'),status='done',docket_at='2020-01-01T00:00:00Z'))
        self.add(dict(self.item('attention'),status='done',manual_attention={'why':'look'}),True)
        self.refresh(); actual=[]; cursor=''
        while True:
            with self.read() as query:
                rows,cursor=query.archive(limit=2,cursor=cursor)
                self.assertLessEqual(len(rows),2); actual.extend(r.summary['slug'] for r in rows)
            if cursor is None: break
        self.assertEqual(actual,self.oracle(archive=True))
        self.assertEqual(len(actual),len(set(actual)))

    def seed_pages(self):
        for name in ('a','b','c'): self.add(self.item(name),True)
        self.refresh()
        with self.read() as query: return query.archive(limit=1)[1]

    def test_cursor_binds_viewer_size_catalog_and_refuses_tampering(self):
        cursor=self.seed_pages()
        for viewer,limit,token in [('a',1,cursor),(USER,2,cursor),(USER,1,cursor[:-2]+'AA'),(USER,1,'bad')]:
            with self.read(viewer) as query, self.assertRaises(workquery.CursorReset):
                query.archive(limit=limit,cursor=token)
        with self.read(now=self.now+61) as query, self.assertRaises(workquery.CursorReset):
            query.archive(limit=1,cursor=cursor)
        self.node('a','b'); self.refresh()
        with self.read() as query, self.assertRaises(workquery.CursorReset):
            query.archive(limit=1,cursor=cursor)

    def test_clock_boundary_is_strict_and_paging_clock_stays_fixed(self):
        from datetime import datetime,timezone
        stamp=datetime.fromtimestamp(self.now-3600,tz=timezone.utc).isoformat()
        self.add(dict(self.item('boundary'),status='done',docket_at=stamp))
        cursor=self.seed_pages()
        with self.read() as query:
            self.assertIn('boundary',[r.summary['slug'] for r in query.foreground()])
        with self.read(now=self.now+1) as query:
            self.assertNotIn('boundary',[r.summary['slug'] for r in query.foreground()])
            continued,_=query.archive(limit=1,cursor=cursor)
            self.assertEqual([r.summary['slug'] for r in continued],['b'])
            fresh,_=query.archive(limit=1)
            self.assertEqual([r.summary['slug'] for r in fresh],['boundary'])

    def test_snapshot_preserves_old_authority_and_body_across_writer(self):
        self.add(self.item('old',future={'precise':'1.0000'}),True); self.refresh()
        with self.read('a') as query:
            before=query.detail('old')
            with self.c.transaction():
                self.c.execute(f"UPDATE {self.s}.log_l SET val=(val::jsonb || '{{\"owner\":{{\"node\":\"c\"}}}}')::text WHERE sect='work_items_archive'")
                workread.refresh(self.c,self.oid)
            self.assertEqual(query.detail('old'),before)
        with self.read('a') as query: self.assertIsNone(query.detail('old'))
        with self.read('c') as query: self.assertEqual(query.detail('old')[0]['future'],{'precise':'1.0000'})

    def test_dirty_and_legacy_identity_require_whole_fallback(self):
        self.add(self.item('w1234abcd')); self.refresh()
        with self.read() as query: self.assertIsNotNone(query.detail('w1234abcd'))
        self.add(self.item('legacy',id='old'))
        with self.assertRaises(workquery.CompatibilityRequired),self.read(): pass
        self.refresh()
        with self.assertRaises(workquery.CompatibilityRequired),self.read(): pass
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s',(workrows.PREFIX+'legacy',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'",(workrows.header(['w1234abcd']),))
        self.refresh()
        with self.read() as query: self.assertIsNotNone(query.lookup('w1234abcd'))

    def test_unsupported_order_and_exact_body_hash_refuse(self):
        self.add(self.item(docket_at=123)); self.refresh()
        with self.assertRaises(workquery.CompatibilityRequired),self.read(): pass
        self.add(self.item()); self.refresh()
        self.c.execute(f"UPDATE {self.s}.work_index SET body_sha256=decode('00','hex')")
        self.refresh()
        with self.read() as query, self.assertLogs('orgtree.workquery',level='ERROR'), self.assertRaises(workquery.CompatibilityRequired):
            query.detail('one')

    def test_read_only_snapshot_and_bounded_limits_required(self):
        self.refresh()
        with self.assertRaisesRegex(ValueError,'read-only'):
            workquery.Snapshot(self.c,self.oid,viewer=USER,now_ts=self.now)
        with self.read() as query:
            for size in (0,101,-1,True,1.5):
                with self.assertRaises(ValueError): query.archive(limit=size)

    def test_runtime_role_and_order_indexes_exist(self):
        self.add(self.item(),True); self.refresh()
        with pgstore.connect() as raw,raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            raw.execute('SET LOCAL ROLE orgtree_runtime')
            query=workquery.Snapshot(raw,self.oid,viewer='a',now_ts=self.now)
            self.assertEqual(query.detail('one')[0]['slug'],'one')
            self.assertEqual(len(query.archive()[0]),1)
        names=[r[0] for r in self.c.execute('SELECT indexname FROM pg_indexes WHERE schemaname=%s',(self.s,))]
        self.assertIn('work_query_order',names); self.assertIn('work_query_unsupported',names)


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Upgrade(unittest.TestCase):
    def test_initialized_upgrade_refreshes_without_raw_rewrite(self):
        name='work_query_upgrade_'+str(os.getpid())
        with pgstore.connect(f.ADMIN) as c: c.execute(f'CREATE DATABASE {name}')
        try:
            with pgstore.connect(f._with_db(f.ADMIN,name)) as c, tempfile.TemporaryDirectory() as folder:
                for p in pgstore.migration_files():
                    if p.name<'0009': shutil.copy(p,Path(folder)/p.name)
                pgstore.migrate(c,Path(folder))
                c.execute("INSERT INTO public.orgs(slug) VALUES('upgrade')")
                c.execute('SELECT public.orgtree_create_org_schema(1)')
                body='{"slug":"old", "owner":{"node":"a"},"future":1.0000}'
                c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',('work_items',workrows.header(['old'])))
                c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',(workrows.PREFIX+'old',body))
                self.assertTrue(workread.refresh(c,1))
                self.assertTrue(c.execute('SELECT initialized FROM org_1.work_read_state').fetchone()[0])
                c.execute("UPDATE org_1.work_index SET body_sha256=decode('00','hex')")
                with self.assertRaisesRegex(Exception,'query migration reconciliation failed'):
                    pgstore.migrate(c)
                self.assertIsNone(c.execute("SELECT to_regclass('org_1.work_query_order')").fetchone()[0])
                self.assertIsNone(c.execute("SELECT to_regprocedure('public.orgtree_work_summary_before_query(text)')").fetchone()[0])
                c.execute("UPDATE org_1.work_index SET body_sha256=sha256(convert_to(%s,'UTF8'))",(body,))
                self.assertIn('0009_work_query.sql',pgstore.migrate(c)['applied'])
                self.assertIsNone(workread.counts_raw(c,1,viewer=USER,now_ts=2e9))
                workread.bootstrap(c)
                self.assertTrue(workread.reconcile(c,1))
                self.assertEqual(c.execute('SELECT val FROM org_1.doc WHERE key=%s',(workrows.PREFIX+'old',)).fetchone()[0],body)
                with c.transaction():
                    c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    self.assertEqual(workquery.Snapshot(c,1,viewer='a',now_ts=2e9).detail('old')[0]['slug'],'old')
                self.assertEqual(pgstore.migrate(c)['applied'],[])
        finally:
            with pgstore.connect(f.ADMIN) as c: c.execute(f'DROP DATABASE {name} WITH (FORCE)')


if __name__=='__main__': unittest.main()
