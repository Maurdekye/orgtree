"""Bounded desktop lists against the unchanged complete ledger oracle."""
import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_detail as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, pgstore, workread, workquery, worklist, work_ui, refs
from orgtree.ledger import USER, LedgerError


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Lists(unittest.TestCase):
    setUp = fixture.Detail.setUp
    tearDown = fixture.Detail.tearDown
    add = fixture.Detail.add
    refresh = fixture.Detail.refresh
    item = fixture.Detail.item
    asks = fixture.Detail.asks

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def foreground(self, viewer=USER, **kw):
        return worklist.foreground(self.slug, viewer, now_ts=self.now, **kw)

    def oracle(self, viewer=USER):
        payload = store.load_org(self.slug).work_list(viewer, True, self.now, True)
        for group in ('items','archived','backlogged'):
            for row in payload[group]: row['ref'] = refs.item(self.slug,row['slug'])
        return work_ui.project(payload)

    def test_foreground_rows_counts_order_and_fields_equal_legacy(self):
        for slug,status in [('open','open'),('review','review'),('deploy','deploy_ready'),
                            ('backlog','backlogged'),('old','done'),('held','done')]:
            self.add(self.item(slug,status=status,reviewer={'node':'b','generation':0},
                participants=['b'], manual_attention={'reason':'look'} if slug=='held' else None),
                slug in ('old','held'))
        self.refresh()
        for viewer in (USER,'a','b','c'):
            for backlogged in (False,True):
                with self.subTest(viewer=viewer,backlogged=backlogged):
                    expected=self.oracle(viewer); got=self.foreground(viewer,backlogged=backlogged)
                    self.assertEqual(got['items'],expected['items'])
                    self.assertEqual(got['counts'],expected['counts'])
                    self.assertEqual(got.get('backlogged'),expected['backlogged'] if backlogged else None)
                    selected=got['items']+got.get('backlogged',[])
                    self.assertEqual(got['references'],[worklist.reference(row) for row in sorted(
                        selected,key=lambda row:(row.get('docket_at') or row.get('updated_at') or '',row['slug']),reverse=True)])
                    self.assertNotIn('archived',got)

    def test_scope_history_and_current_identity_are_preserved(self):
        self.add(self.item(scope_logged=2,scope_rolled=1,
            scope=[{'seq':3,'kind':'decision','text':'third','at':'2023'}],
            history=[{'op':'status','to':'open','at':'2024'}]))
        for seq in (1,2):
            self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
                (json.dumps({'seq':seq,'kind':'decision','text':str(seq),'at':'202'+str(seq)}),))
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{generation}}','4')::text WHERE id='a'")
        self.refresh()
        expected=self.oracle()['items']
        with patch.object(worklist.Context,'_work_scope_log_rows',side_effect=AssertionError('scope history read')):
            got=self.foreground()['items']
        self.assertEqual(got,expected); self.assertEqual(got[0]['owner']['generation'],4)

    def test_attention_archive_and_hidden_pointer_authority(self):
        self.add(self.item('archive',status='done'),True); self.asks()
        self.add(self.item('secret',owner={'node':'c'},created_by={'node':'c'}),True)
        self.add(self.item(parent='secret',superseded_by='secret',dependencies=['secret','archive']))
        self.refresh()
        got=self.foreground('a'); self.assertEqual(got['items'],self.oracle('a')['items'])
        self.assertEqual(got['counts']['attention'],1)
        row=next(row for row in got['items'] if row['slug']=='one')
        self.assertIsNone(row['parent']); self.assertEqual(row['dependencies'][0],{'visible':False})
        hidden=worklist.lookup(self.slug,'a','secret',now_ts=self.now)
        missing=worklist.lookup(self.slug,'a','missing',now_ts=self.now)
        self.assertEqual(hidden,missing); self.assertFalse(hidden['found'])
        self.assertTrue(worklist.lookup(self.slug,USER,'secret',now_ts=self.now)['found'])

    def test_archive_pages_match_legacy_without_duplicates_and_reset_on_identity(self):
        for n in range(7): self.add(self.item('old-'+str(n),status='done',docket_at='2020-01-01'),True)
        self.refresh(); expected=self.oracle()['archived']; actual=[]; cursor=''
        while True:
            page=worklist.archive(self.slug,limit=2,cursor=cursor,now_ts=self.now)
            actual.extend(page['archived']); cursor=page['next_cursor']
            if not cursor: break
        self.assertEqual(actual,expected)
        cursor=worklist.archive(self.slug,limit=2,now_ts=self.now)['next_cursor']
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{generation}}','5')::text WHERE id='a'")
        self.refresh()
        with self.assertRaises(workquery.CursorReset):
            worklist.archive(self.slug,limit=2,cursor=cursor,now_ts=self.now)

    def test_archive_start_is_one_snapshot_and_later_pages_keep_its_clock(self):
        self.add(self.item('active'))
        for n in range(5): self.add(self.item('old-'+str(n),status='done'),True)
        self.refresh()
        expected = self.oracle()
        start = self.foreground(archive_limit=2)
        self.assertEqual(start['items'], expected['items'])
        self.assertEqual(start['archived'], expected['archived'][:2])
        self.assertEqual(start['counts'], expected['counts'])
        seen_clocks = []
        original = worklist.Context.light
        def observe(ctx, row, slug):
            seen_clocks.append(ctx.query.now)
            return original(ctx, row, slug)
        with patch.object(worklist.Context, 'light', observe):
            page = worklist.archive(self.slug, limit=2, cursor=start['next_cursor'],
                                    now_ts=self.now+10)
        self.assertEqual(page['catalog'], start['catalog'])
        self.assertEqual(page['archived'], expected['archived'][2:4])
        self.assertEqual(seen_clocks, [self.now, self.now])
        # A real writer between the combined start and the next page resets
        # the chain rather than mixing the new foreground with an old archive.
        self.add(self.item('new-active')); self.refresh()
        with self.assertRaises(workquery.CursorReset):
            worklist.archive(self.slug, limit=2, cursor=start['next_cursor'], now_ts=self.now+10)
        for limit in (-1, 101):
            with self.assertRaises(ValueError): self.foreground(archive_limit=limit)

    def test_visible_reference_batch_is_exact_authorized_and_bounded(self):
        self.add(self.item('historical',status='done'),True)
        self.add(self.item('secret',owner={'node':'c'},created_by={'node':'c'}),True)
        self.refresh()
        with patch.object(store, 'load_org', side_effect=AssertionError('whole history')):
            result = worklist.lookup_many(self.slug,'a',['historical','secret','missing','historical'],now_ts=self.now)
        self.assertEqual([row['slug'] for row in result['references']], ['historical'])
        self.assertEqual(result['references'][0],worklist.lookup(self.slug,'a','historical',now_ts=self.now)['reference'])
        with self.assertRaises(ValueError):
            worklist.lookup_many(self.slug,USER,['name']*129,now_ts=self.now)
        from orgtree import api
        response=asyncio.run(api._work_references_route(self.slug,names='historical,missing'))
        self.assertEqual([row['slug'] for row in json.loads(response.body)['references']],['historical'])

    def test_archived_edit_refreshes_references_with_unchanged_active_answer(self):
        from orgtree import api
        self.add(self.item('active'))
        self.add(self.item('old-ticket', status='done', title='Before'), True)
        self.refresh()
        before = self.foreground()
        before_refs = worklist.lookup_many(self.slug, USER, ['old-ticket'], now_ts=self.now)
        self.c.execute(f"UPDATE {self.s}.log_l SET val=jsonb_set(val::jsonb,'{{title}}','\"After\"')::text WHERE sect='work_items_archive'")
        self.refresh()
        with (patch.object(store, 'load_org', side_effect=AssertionError('whole history')),
              patch.object(workquery.Snapshot, 'detail', side_effect=AssertionError('raw body'))):
            after = self.foreground()
            lookup = worklist.lookup_many(self.slug, USER, ['old-ticket'], now_ts=self.now)
            response = api._bounded_work_response(self.slug, 'foreground', since=before['revision'])
        # Optional cross-layer replay uses actual PG responses, including the
        # old implementation's unchanged revision, in the mounted hook control.
        if capture := os.environ.get('ORGTREE_TEST_WORK_FRESHNESS_PAYLOADS'):
            Path(capture).write_text(json.dumps({
                'before': before, 'after': after,
                'before_references': before_refs['references'],
                'after_references': lookup['references'],
            }), encoding='utf-8')
        self.assertEqual(lookup['references'][0]['title'], 'After')
        for field in ('items', 'references', 'counts', 'attention'):
            self.assertEqual(before[field], after[field], field)
        self.assertNotIn('archived', after)
        self.assertNotEqual(before['revision'], after['revision'])
        self.assertEqual(response.status_code, 200, 'remote edit must not reuse cached foreground')
        self.assertEqual(self.foreground()['revision'], after['revision'], 'stable without another write')

    def test_archived_rename_invalidates_positive_and_negative_reference_keys(self):
        self.add(self.item('active'))
        self.add(self.item('old-ticket', status='done'), True)
        self.refresh()
        before = self.foreground()
        names = ['old-ticket', 'new-ticket']
        old = worklist.lookup_many(self.slug, USER, names, now_ts=self.now)
        self.assertEqual([row['slug'] for row in old['references']], ['old-ticket'])
        self.c.execute(f"UPDATE {self.s}.log_l SET val=jsonb_set(val::jsonb,'{{slug}}','\"new-ticket\"')::text WHERE sect='work_items_archive'")
        self.refresh()
        after = self.foreground()
        new = worklist.lookup_many(self.slug, USER, names, now_ts=self.now)
        self.assertEqual([row['slug'] for row in new['references']], ['new-ticket'])
        for field in ('items', 'references', 'counts', 'attention'):
            self.assertEqual(before[field], after[field], field)
        self.assertNotEqual(before['revision'], after['revision'])

    def test_dirty_stamp_and_missing_metadata_require_whole_compatibility(self):
        self.add(self.item()); self.assertIsNone(self.foreground()); self.refresh()
        self.assertIsNotNone(self.foreground())
        self.c.execute(f"UPDATE {self.s}.work_list_summary SET body_sha256='\\x00'::bytea WHERE slug='one'")
        self.assertIsNone(self.foreground())
        self.c.execute(f'DELETE FROM {self.s}.work_list_summary')
        self.assertIsNone(self.foreground())

    def test_scope_only_invalidation_refuses_list_until_writer_refresh(self):
        self.add(self.item(scope_logged=1,scope_rolled=1))
        self.c.execute(f"INSERT INTO {self.s}.log_d(sect,owner,val) VALUES('work_scope_log','one',%s)",
            (json.dumps({'seq':1,'at':'before'}),))
        self.refresh(); before=self.foreground()
        self.c.execute(f"UPDATE {self.s}.log_d SET val=%s WHERE sect='work_scope_log' AND owner='one'",
            (json.dumps({'seq':1,'at':'after'}),))
        self.assertIsNone(self.foreground())
        self.refresh(); after=self.foreground()
        self.assertNotEqual(before['revision'],after['revision'])
        self.assertEqual(after['items'],self.oracle()['items'])

    def test_same_snapshot_keeps_counts_questions_and_actor_identity(self):
        self.add(self.item('archive',status='done'),True); self.asks(); self.refresh()
        with pgstore.connect() as raw,raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            q=workquery.Snapshot(raw,self.oid,viewer=USER,now_ts=self.now)
            ctx=worklist.Context(q); row=q.foreground()[0]; before=ctx.light(row,self.slug)
            with self.c.transaction():
                self.asks(False)
                self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{generation}}','6')::text WHERE id='a'")
                workread.refresh(self.c,self.oid)
            ctx.nodes.cache.clear()
            self.assertEqual(ctx.light(q.foreground()[0],self.slug),before)
            self.assertEqual(workread.counts_raw(raw,self.oid,viewer=USER,now_ts=self.now)['attention'],1)
        self.assertEqual(self.foreground()['items'],[])

    def test_small_and_tenfold_history_never_hydrate_hidden_bodies_or_references(self):
        self.add(self.item()); exemplar=self.item(status='done',evidence=[{'note':'x'*1000}])
        outputs=[]; old_sizes=[]
        for start,end in ((0,30),(30,300)):
            with self.c.transaction():
                for n in range(start,end): self.add(dict(exemplar,slug='old-'+str(n)),True)
                workread.refresh(self.c,self.oid)
            old_sizes.append(len(self.oracle()['references']))
            with (patch.object(store,'load_org',side_effect=AssertionError('whole Org')),
                  patch.object(workquery.Snapshot,'detail',side_effect=AssertionError('raw body'))):
                got=self.foreground()
                outputs.append((got['items'],got['references']))
                page=worklist.archive(self.slug,limit=3,now_ts=self.now)
                self.assertEqual(len(page['archived']),3); self.assertEqual(len(page['references']),3)
                ref=worklist.lookup(self.slug,USER,'old-17',now_ts=self.now)
                self.assertEqual(ref['reference']['slug'],'old-17')
            self.assertEqual(len(got['references']),1)
        self.assertEqual(old_sizes,[31,301]); self.assertEqual(outputs[0],outputs[1])

    def test_http_controls_statuses_and_real_async_route_dispatch(self):
        from orgtree import api
        self.add(self.item()); self.refresh()
        with patch.object(store,'load_org',side_effect=AssertionError('whole Org')):
            response=asyncio.run(api._work_foreground_route(self.slug))
            self.assertEqual(response.status_code,200)
            combined=asyncio.run(api._work_foreground_route(self.slug, archive_limit=100))
            self.assertIn('archived',json.loads(combined.body))
            body=json.loads(response.body); self.assertEqual(len(body['items']),1)
            cached=api._bounded_work_response(self.slug,'foreground',since=body['revision'])
            self.assertEqual(cached.status_code,304)
            self.assertEqual(asyncio.run(api._work_reference_route(self.slug,'one')).status_code,200)
            bad=asyncio.run(api._work_archive_page_route(self.slug,cursor='bad'))
            self.assertEqual(bad.status_code,409); self.assertEqual(json.loads(bad.body)['kind'],'reset')
        with (patch.object(worklist,'foreground',return_value=None),
              patch.object(worklist,'foreground_conditional',return_value=None)):
            fallback=api._bounded_work_response(self.slug,'foreground')
            self.assertEqual(fallback.status_code,409)
            self.assertEqual(json.loads(fallback.body)['kind'],'compatibility')
        with self.assertRaises(api.HTTPException) as invalid:
            api._bounded_work_response(self.slug,'archive',limit=101)
        self.assertEqual(invalid.exception.status_code,400)
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"retired\"')::text WHERE id='a'")
        self.refresh()
        with self.assertRaisesRegex(LedgerError,'not live'): self.foreground('a')


if __name__ == '__main__':
    unittest.main()
