"""Single-body public views against the complete canonical ledger oracle."""
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, pgstore, workread, workquery, workdetail
from orgtree.ledger import Org, USER, LedgerError


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Detail(unittest.TestCase):
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh
    asks = fixture.Counts.asks

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        fixture.Counts.setUp(self)
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"live\"')::text")

    def item(self, slug='one', **kw):
        org = store.load_org(self.slug)
        it = org.work_create('a', 'Detail '+slug, 'Full description')['created']
        row = dict(org._work_find(it)[0])
        row.update(slug=slug, **kw)
        return row

    def get(self, viewer=USER, wid='one', **kw):
        return workdetail.get(self.slug, viewer, wid, now_ts=self.now, **kw)

    def test_full_compact_summary_fields_equal_canonical(self):
        item = self.item(evidence=[{'kind':'note','ref':'test','note':'large '*100}],
                         participants=['b'], reviewer={'node':'b','generation':0})
        self.add(item); self.refresh()
        for viewer in (USER,'a','b'):
            for kw in ({},{'compact':True},{'projection':'summary'},
                       {'fields':['objective','owner','scope','candidate','reply_recipients']}):
                with self.subTest(viewer=viewer,kw=kw):
                    expected=store.load_org(self.slug).work_get(viewer,'one',now_ts=self.now,**kw)
                    self.assertEqual(self.get(viewer,**kw),expected)

    def test_pointers_and_artifacts_preserve_non_disclosure(self):
        self.add(self.item('secret',owner={'node':'c','generation':0},created_by={'node':'c'}),True)
        self.add(self.item('public',participants=['b']),True)
        self.add(self.item(dependencies=['secret','public'],parent='secret',superseded_by='secret',
            history=[{'op':'move','from':'secret','to':'public'}],
            artifacts=[{'id':'artifact-1','name':'secret.txt','scope':'named','grants':[]}]))
        self.refresh()
        for viewer in (USER,'a'):
            expected=store.load_org(self.slug).work_get(viewer,'one',now_ts=self.now)
            result=self.get(viewer)
            self.assertEqual(result,expected)
            if viewer=='a':
                self.assertIsNone(result['parent']); self.assertFalse(result['dependencies'][0]['visible'])
                self.assertIsNone(result['history'][0]['from'])

    def test_missing_hidden_and_old_id_refusals_equal_ledger(self):
        self.add(self.item('hidden',owner={'node':'c'},created_by={'node':'c'}),True); self.refresh()
        for slug in ('hidden','missing','w12345678'):
            with self.assertRaises(LedgerError) as old:
                store.load_org(self.slug).work_get('a',slug,now_ts=self.now)
            with patch.object(store,'load_org',side_effect=AssertionError('whole read')), self.assertRaises(LedgerError) as new:
                self.get('a',slug)
            self.assertEqual(str(new.exception),str(old.exception))

    def test_archived_questions_scope_and_current_generation(self):
        item=self.item('archive',status='done',scope_logged=2,scope_rolled=1,
            scope=[{'seq':3,'kind':'decision','text':'third','at':'2023'}])
        self.add(item,True)
        for seq in (1,2):
            self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','archive',%s)",
                (json.dumps({'seq':seq,'kind':'decision','text':str(seq),'at':'202'+str(seq)}),))
        self.asks()
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{generation}}','4')::text WHERE id='a'")
        self.refresh()
        expected=store.load_org(self.slug).work_get(USER,'archive',now_ts=self.now)
        result=self.get(wid='archive')
        self.assertEqual(result,expected); self.assertEqual(result['owner']['generation'],4)
        self.assertFalse(result['archived']); self.assertTrue(result['questions'])
        self.assertEqual(len(result['scope_archive']),1); self.assertEqual(len(result['scope']),2)

    def test_reminted_and_retired_actors_and_viewer_guard(self):
        item=self.item(owner={'node':'a','generation':0,'born':'old-mint'},participants=['b'])
        self.add(item); self.refresh()
        result=self.get('b'); self.assertEqual(result,store.load_org(self.slug).work_get('b','one',now_ts=self.now))
        self.assertFalse(result['owner_current'])
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"retired\"')::text WHERE id='b'")
        self.refresh()
        with self.assertRaisesRegex(LedgerError,'not live'): self.get('b')

    def test_one_body_constant_for_small_and_tenfold_history(self):
        exemplar=self.item(status='done',evidence=[{'kind':'note','note':'x'*1000}])
        observed=[]
        for start,end in ((0,30),(30,300)):
            with self.c.transaction():
                for n in range(start,end): self.add(dict(exemplar,slug='old-'+str(n)),True)
                workread.refresh(self.c,self.oid)
            calls=[]; original=workquery.Snapshot.detail
            def count(query,slug):
                result=original(query,slug); calls.append(slug); return result
            with patch.object(workquery.Snapshot,'detail',count), patch.object(store,'load_org',side_effect=AssertionError('whole Org')):
                result=self.get(wid='old-17')
            self.assertEqual(calls,['old-17']); observed.append(result)
        self.assertEqual(observed[0],observed[1])

    def test_context_cannot_save_or_mutate_and_scope_mismatch_falls_back(self):
        self.add(self.item(scope_logged=1)); self.refresh()
        self.assertIsNone(self.get())
        with pgstore.connect() as raw,raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            ctx=workdetail.Context(workquery.Snapshot(raw,self.oid,viewer=USER,now_ts=self.now))
            self.assertFalse(isinstance(ctx,Org)); self.assertFalse(hasattr(ctx,'d'))
            self.assertFalse(hasattr(ctx,'work_update'))
            with self.assertRaises((AttributeError,TypeError)): store.save_org(ctx)
            with self.assertRaises(TypeError): ctx._work_scope_log_rows({},create=True)

    def test_dirty_and_unnormalized_data_return_exact_fallback_signal(self):
        self.add(self.item()); self.assertIsNone(self.get()); self.refresh()
        self.assertIsNotNone(self.get())
        self.c.execute(f"UPDATE {self.s}.nodes SET val=(val::jsonb-'seat_id')::text WHERE id='a'")
        self.refresh(); self.assertIsNone(self.get())

    def test_nodes_and_questions_share_body_snapshot_during_commit(self):
        self.add(self.item('archive',status='done'),True); self.asks(); self.refresh()
        with pgstore.connect() as raw,raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            ctx=workdetail.Context(workquery.Snapshot(raw,self.oid,viewer=USER,now_ts=self.now))
            before=ctx.work_get(USER,'archive',now_ts=self.now)
            # No node cache can manufacture coherence: change the independent
            # writer after the index snapshot is pinned but before new reads.
            with self.c.transaction():
                self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{generation}}','5')::text WHERE id='a'")
                self.asks(False); workread.refresh(self.c,self.oid)
            ctx.nodes.cache.clear()
            self.assertEqual(ctx.work_get(USER,'archive',now_ts=self.now),before)
        after=self.get(wid='archive')
        self.assertEqual(after['owner']['generation'],5); self.assertFalse(after['questions'])
        self.assertTrue(after['archived'])

    def test_projection_errors_and_legacy_identity_http_guard_unchanged(self):
        from orgtree import api
        self.add(self.item()); self.refresh()
        for kw in ({'projection':'bogus'},{'fields':['not_a_field']},{'fields':17}):
            with self.assertRaises(LedgerError) as old:
                store.load_org(self.slug).work_get(USER,'one',now_ts=self.now,**kw)
            with self.assertRaises(LedgerError) as new: self.get(**kw)
            self.assertEqual(str(new.exception),str(old.exception))
        self.add(self.item('legacy',id='w12345678')); self.refresh()
        with self.assertRaises(api.HTTPException) as error: api.work_item_get(self.slug,'one')
        self.assertEqual(error.exception.status_code,409)

    def test_routes_use_indexed_view_and_preserve_legacy_fallback(self):
        from orgtree import api
        self.add(self.item()); self.refresh()
        expected=self.get()
        with patch.object(store,'load_org',side_effect=AssertionError('whole load')), patch.object(store,'cached_org',side_effect=AssertionError('whole cache')):
            desktop=api.work_item_get(self.slug,'one')
            agent=api._work_read_call(api.AgentCall(org=self.slug,node='a',tool='orgtree_work',args={}),{'action':'get','slug':'one'})
        self.assertEqual(desktop['item']['objective'],expected['objective'])
        self.assertEqual(agent['item']['objective'],expected['objective'])
        with patch.object(workdetail,'get',return_value=None), patch.object(store,'load_org',wraps=store.load_org) as legacy:
            fallback=api.work_item_get(self.slug,'one')
            self.assertEqual(fallback,desktop); self.assertEqual(legacy.call_count,1)


if __name__ == '__main__':
    unittest.main()
