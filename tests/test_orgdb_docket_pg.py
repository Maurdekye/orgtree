"""Native docket request readers, against the unchanged ledger authorization oracle.

Creates one disposable app and org database. Run only under the P03 heavy lock.
Each public-path regression executes against stage 1-B before the native port.
"""
import import_provenance  # noqa: F401  asserts this checkout before engine imports

import copy
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '')
PREFIX = f'tdk{os.getpid()}_'
SLUG = 'native-docket'
TEMP = tempfile.TemporaryDirectory(prefix='orgdb-docket-')
os.environ.update(ORGTREE_DATA=str(Path(TEMP.name) / 'data'), ORGTREE_STORE='postgres',
                  ORGTREE_ORGDB_PREFIX=PREFIX)
if RUNTIME:
    os.environ['ORGTREE_PG_URL'] = RUNTIME
    os.environ.pop('ORGTREE_PG_CONNINFO', None)

from orgtree import store, workdetail, worklist, workquery, work_ui  # noqa: E402
from orgtree.ledger import Org, USER, LedgerError  # noqa: E402
from orgtree.orgdb import conn, lifecycle, mappers, names, registry, sections  # noqa: E402
from orgtree.orgdb.convert import rowio  # noqa: E402

LC = None
OID = None
DATABASE = None
NOW = time.time()
AT = '2026-10-02T00:00:00.000Z'
DOC = None


def item(slug, **values):
    record = dict(slug=slug, rev=1, kind='code', title='Title ' + slug,
                  objective='Description ' + slug, status='in_progress',
                  owner={'node': 'worker', 'generation': 0, 'born': 'worker-seat'},
                  created_by={'node': 'boss', 'generation': 0}, participants=[],
                  at=AT, updated_at=AT, docket_at=AT, status_at=AT,
                  done_so_far=['done'], working_on_next=['next'], scope=[],
                  acceptance=[], history=[], evidence=[], dependencies=[])
    record.update(values)
    return record


def seed():
    nodes = {}
    for name, parent, state in [('boss', None, 'live'), ('worker', 'boss', 'live'),
                                ('other', None, 'live'), ('worker@0', 'other', 'retired')]:
        nodes[name] = dict(parent=parent, state=state, generation=0, created=AT,
                           seat_id=name + '-seat', model='sonnet', grant=0, charter='test')
    doc = dict(name=SLUG, nodes=nodes, work_identity='slug',
               work_items=[item('one', dependencies=['secret'], parent='secret',
                                scope_logged=2, scope_rolled=1,
                                scope=[{'seq': 3, 'kind': 'decision', 'text': 'third', 'at': AT}]),
                           item('back', status='backlogged'), item('expired', status='done'),
                           item('w12345678')],
               work_items_archive=[item('old', status='done', archived_at=AT),
                                   item('secret', status='done', archived_at=AT,
                                        owner={'node': 'other'}, created_by={'node': 'other'}),
                                   item('held', status='done', archived_at=AT,
                                        manual_attention={'reason': 'read', 'set_rev': 2}),
                                   item('asked', status='done', archived_at=AT),
                                   item('bearer', status='done', archived_at=AT,
                                        owner={'node': 'worker@0'}, created_by={'node': 'other'})],
               work_scope_log={'one': [{'seq': n, 'kind': 'decision', 'text': str(n), 'at': AT}
                                      for n in (1, 2)]},
               asks=[{'id': 'ask-1', 'node': 'worker', 'status': 'open', 'rev': 3, 'at': AT,
                      'work_items': ['asked'], 'questions': [{'question': 'Which?',
                                                           'work_item': 'asked', 'header': 'Pick'}]}])
    return Org(doc).d


@contextmanager
def writer():
    with conn.connect(RUNTIME, DATABASE) as raw, raw.transaction():
        yield raw


@contextmanager
def snapshot(viewer=USER, clock=NOW):
    from orgtree.orgdb import docket
    with docket.read(SLUG, viewer=viewer, now_ts=clock) as query:
        yield query


def setUpModule():
    global LC, OID, DATABASE, DOC
    if not (ADMIN and RUNTIME):
        return
    unittest.addModuleCleanup(cleanupModule)
    DOC = seed()
    LC = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
    LC.bootstrap()
    registry.use_lifecycle(LC)
    OID = LC.create_org(SLUG)
    DATABASE = LC.row(OID)['database']
    rows, _, _ = sections.encode_document(DOC, mappers.sections(), ignored=mappers.ignored_keys())
    with conn.connect(RUNTIME, DATABASE) as raw, raw.transaction():
        rowio.write(raw, rows)


def cleanupModule():
    registry.close_idle()
    registry.close_registry()
    if LC is not None:
        if DATABASE is not None:
            LC._drop_db(DATABASE)
        LC._drop_db(names.app(PREFIX))
    TEMP.cleanup()


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable admin/runtime URLs: NOT EXECUTED')
class NativePaths(unittest.TestCase):
    def setUp(self):
        self.switch = patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'})
        self.switch.start()
        self.addCleanup(self.switch.stop)
        self.oracle = Org(copy.deepcopy(DOC))

    def test_detail_full_compact_summary_and_disclosure(self):
        for options in ({}, {'compact': True}, {'projection': 'summary'},
                        {'fields': ['objective', 'owner', 'scope', 'reply_recipients']}):
            with self.subTest(options=options), patch.object(store, 'load_org', side_effect=AssertionError('whole org')):
                actual = workdetail.get(SLUG, 'worker', 'one', now_ts=NOW, **options)
                self.assertEqual(actual, self.oracle.work_get('worker', 'one', now_ts=NOW, **options))

    def test_detail_archived_scope_and_open_questions(self):
        for slug in ('old', 'asked', 'one'):
            with self.subTest(slug=slug):
                self.assertEqual(workdetail.get(SLUG, USER, slug, now_ts=NOW),
                                 self.oracle.work_get(USER, slug, now_ts=NOW))

    def test_lookup_many_and_hidden_bearer_names(self):
        result = worklist.lookup_many(SLUG, 'boss', ['one', 'old', 'secret', 'bearer', 'w12345678'], now_ts=NOW)
        self.assertIsNotNone(result)
        self.assertEqual({r['slug'] for r in result['references']}, {'one', 'old', 'w12345678'})
        self.assertFalse(worklist.lookup(SLUG, 'boss', 'bearer', now_ts=NOW)['found'])

    def test_foreground_questions_and_classification(self):
        result = worklist.foreground(SLUG, 'worker', backlogged=True, now_ts=NOW)
        self.assertIsNotNone(result)
        expected = self.oracle.work_list('worker', include_archived=True, include_backlogged=True, now_ts=NOW)
        self.assertEqual({r['slug'] for r in result['items']}, {r['slug'] for r in expected['items']})
        self.assertEqual({r['slug'] for r in result['backlogged']}, {'back'})
        self.assertNotIn('archived',result['counts'])
        asked = next(r for r in result['items'] if r['slug'] == 'asked')
        self.assertTrue(asked['questions'])

    def test_agent_list_has_no_unrequested_archive_total(self):
        result = worklist.agent_list(SLUG, 'worker', now_ts=NOW)
        self.assertIsNotNone(result)
        self.assertNotIn('archived', result['counts'])
        self.assertNotIn('count', result['groups']['archived'])
        expected = self.oracle.work_list('worker', include_backlogged=True, now_ts=NOW)
        self.assertEqual([r['slug'] for r in result['items']], [r['slug'] for r in expected['items']])
        self.assertEqual(result['counts'], {k:v for k,v in expected['counts'].items() if k!='archived'})
        requested = worklist.agent_list(SLUG, 'worker', include_archived=True, now_ts=NOW)
        self.assertEqual(requested['counts']['archived'], len(requested['archived']))
        self.assertEqual({r['slug'] for r in requested['archived']}, {'old', 'expired'})

    def test_archive_pages_use_authorized_rows_and_bound_cursor(self):
        slugs, cursor = [], ''
        while True:
            result = worklist.archive(SLUG, 'worker', limit=1, cursor=cursor, now_ts=NOW)
            self.assertIsNotNone(result)
            slugs.extend(r['slug'] for r in result['archived'])
            cursor = result['next_cursor']
            if not cursor:
                break
        self.assertEqual(set(slugs), {'old', 'expired'})
        first = worklist.archive(SLUG, 'worker', limit=1, now_ts=NOW)
        with self.assertRaises(workquery.CursorReset):
            worklist.archive(SLUG, 'boss', limit=1, cursor=first['next_cursor'], now_ts=NOW)

    def test_native_etag_shortcut_and_catalog_snapshot(self):
        tag, body = worklist.foreground_conditional(SLUG, now_ts=NOW)
        self.assertTrue(body['items'])
        self.assertEqual(worklist.foreground_conditional(SLUG, since=tag, now_ts=NOW), (tag, None))
        self.assertTrue(worklist.foreground_unchanged(SLUG, since=tag, now_ts=NOW))

    def test_store_selected_rows_and_header(self):
        result = store.read_work_items_rows(SLUG, ['one', 'old', 'missing'])
        self.assertIsNotNone(result)
        self.assertEqual(result['ids'], [r['slug'] for r in DOC['work_items']])
        self.assertEqual(result['items'], {'one': next(r for r in DOC['work_items'] if r['slug'] == 'one')})
        self.assertIsInstance(result['work_revision'], int)

    def test_work_ui_transport_uses_native_readers(self):
        with patch.object(store, 'load_org', side_effect=AssertionError('whole org')):
            token, body = work_ui.read(SLUG)
            self.assertTrue(body['items'])
            self.assertNotIn('archived', body)
            self.assertEqual(work_ui.read(SLUG, since=token), (token, None))

    def test_native_counts_and_attention_interfaces_match_ledger(self):
        from orgtree.orgdb import docket
        for viewer in (USER, 'worker', 'boss', 'other'):
            with self.subTest(viewer=viewer), snapshot(viewer) as q:
                expected = (self.oracle.work_counts(now_ts=NOW) if viewer==USER else
                    self.oracle.work_list(viewer, include_archived=True, include_backlogged=True, now_ts=NOW)['counts'])
                self.assertEqual(docket.counts_raw(q.raw, OID, viewer=viewer, now_ts=NOW), expected)
                self.assertEqual(q.counts(include_archived=False), {k:v for k,v in expected.items() if k!='archived'})
                self.assertEqual(docket.attention_raises_raw(q.raw,OID,viewer=viewer),
                                 [['held',2]] if viewer!= 'other' else [])

    def test_revision_flush_is_once_and_zero_rows_or_rollback_do_not_move_it(self):
        with snapshot() as q:
            before = q.catalog[0]
        with writer() as raw:
            raw.execute("UPDATE orgtree.work_items SET title=title WHERE slug IN ('one','back')")
            raw.execute("UPDATE orgtree.work_item_participants SET value=value WHERE false")
            raw.execute("UPDATE orgtree.work_items SET title=title WHERE slug='one'")
            self.assertEqual(raw.execute('SELECT docket_rev FROM orgtree.org_revision').fetchone()[0], before)
        with snapshot() as q:
            self.assertEqual(q.catalog[0],before+1)
        with writer() as raw:
            raw.execute('UPDATE orgtree.work_items SET title=title WHERE false')
        with conn.connect(RUNTIME,DATABASE) as raw:
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.work_items SET title='rolled back' WHERE slug='one'")
            raw.execute('ROLLBACK')
        with snapshot() as q:
            self.assertEqual(q.catalog[0],before+1)
            self.assertEqual(q.lookup('one').summary['title'],'Title one')

    def test_repeatable_snapshot_does_not_mix_committed_title_and_catalog(self):
        try:
            with snapshot() as old:
                old_catalog = list(old.catalog)
                with writer() as raw:
                    raw.execute("UPDATE orgtree.work_items SET title='new committed title' WHERE slug='one'")
                self.assertEqual(old.detail('one')[0]['title'],'Title one')
                self.assertEqual(old.catalog,old_catalog)
            with snapshot() as new:
                self.assertEqual(new.detail('one')[0]['title'],'new committed title')
                self.assertGreater(new.catalog[0],old_catalog[0])
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET title='Title one' WHERE slug='one'")

    def test_cursor_survives_turn_revision_but_rejects_docket_changes(self):
        first = worklist.archive(SLUG,'worker',limit=1,now_ts=NOW)
        with writer() as raw:
            raw.execute('UPDATE orgtree.org_revision SET rev=rev+1 WHERE singleton')
        self.assertTrue(worklist.archive(SLUG,'worker',limit=1,cursor=first['next_cursor'],now_ts=NOW)['archived'])
        with writer() as raw:
            raw.execute("UPDATE orgtree.work_items SET title=title WHERE slug='one'")
        with self.assertRaises(workquery.CursorReset):
            worklist.archive(SLUG,'worker',limit=1,cursor=first['next_cursor'],now_ts=NOW)

    def test_cursor_rejects_limit_expiry_and_restored_database_identity(self):
        first = worklist.archive(SLUG,'worker',limit=1,now_ts=NOW)
        token = first['next_cursor']
        for limit, clock in ((2,NOW),(1,NOW+workquery.CURSOR_SECONDS+0.01)):
            with self.subTest(limit=limit,clock=clock), self.assertRaises(workquery.CursorReset):
                worklist.archive(SLUG,'worker',limit=limit,cursor=token,now_ts=clock)
        value = workquery._decode(token)
        value['binding'][-1] = 'another database incarnation'
        with self.assertRaises(workquery.CursorReset):
            worklist.archive(SLUG,'worker',limit=1,cursor=workquery._encode(value),now_ts=NOW)

    def test_deadline_is_strict_and_missing_deadline_keeps_open_rows(self):
        boundary = datetime.fromisoformat(AT.replace('Z','+00:00')).timestamp()+3600
        with snapshot('worker',boundary) as q:
            main = {r.summary['slug'] for r in q.foreground()}
            self.assertTrue({'expired','one','w12345678'} <= main)
        with snapshot('worker',boundary+0.001) as q:
            self.assertNotIn('expired',{r.summary['slug'] for r in q.foreground()})
        with snapshot() as q:
            for status,stamp in ((None,AT),('in_progress',AT),('done','not a date'),('done',None)):
                with self.subTest(status=status,stamp=stamp):
                    self.assertIsNone(q.raw.execute('SELECT orgtree.docket_deadline(%s,%s)',(status,stamp)).fetchone()[0])

    def test_per_tab_question_links_ignore_incorrect_rollup_and_move_with_ask(self):
        from psycopg.types.json import Json
        try:
            with writer() as raw:
                raw.execute("UPDATE orgtree.asks SET questions=%s WHERE public_id='ask-1'",
                            (Json([{'question':'Backlog question','work_item':'back'}]),))
            with snapshot('worker') as q:
                rows = {r.summary['slug']:r for r in q.foreground()}
                self.assertIn('back',rows)
                self.assertTrue(rows['back'].questions)
                self.assertNotIn('asked',rows)
                self.assertEqual(q.questions('asked'),[])
                self.assertEqual(q.counts()['backlogged'],0)
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.asks SET questions=%s WHERE public_id='ask-1'",
                            (Json(DOC['asks'][0]['questions']),))

    def test_birth_identity_changes_currentness_without_changing_recorded_access(self):
        try:
            with writer() as raw:
                raw.execute("UPDATE orgtree.agents SET lineage_born='replacement-seat' WHERE name='worker'")
            result = workdetail.get(SLUG,'worker','one',now_ts=NOW)
            self.assertFalse(result['owner_current'])
            self.assertEqual(result['slug'],'one')
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.agents SET lineage_born='worker-seat' WHERE name='worker'")

    def test_ancestor_access_follows_exact_parent_chain_and_tombstones(self):
        try:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET created_by_node='other' WHERE slug='one'")
            with snapshot('boss') as q:
                self.assertIsNotNone(q.lookup('one'))
            with writer() as raw:
                raw.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='other'),parent='other' WHERE name='worker'")
            with snapshot('boss') as q:
                self.assertIsNone(q.lookup('one'))
            with writer() as raw:
                raw.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='boss'),parent='boss',tombstone=true WHERE name='worker'")
            with snapshot('boss') as q:
                self.assertIsNone(q.lookup('one'))
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='boss'),parent='boss',tombstone=false WHERE name='worker'")
                raw.execute("UPDATE orgtree.work_items SET created_by_node='boss' WHERE slug='one'")

    def test_falsy_original_date_uses_update_date_for_archive_policy(self):
        from psycopg.types.json import Json
        try:
            with writer() as raw:
                original = raw.execute("SELECT extra FROM orgtree.work_items WHERE slug='expired'").fetchone()[0]
            for value in (False,0,'',[],{}):
                with self.subTest(value=value):
                    with writer() as raw:
                        raw.execute("UPDATE orgtree.work_items SET docket_at=NULL,docket_at_text=NULL,extra=%s WHERE slug='expired'",
                                    (Json({**(original or {}),'docket_at':value}),))
                    with snapshot('worker') as q:
                        self.assertNotIn('expired',{r.summary['slug'] for r in q.foreground()})
                        rows,_ = q.archive()
                        self.assertIn('expired',{r.summary['slug'] for r in rows})
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET docket_at=%s,docket_at_text=NULL,extra=%s WHERE slug='expired'",(AT,Json(original)))

    def test_desktop_stamp_and_body_use_one_snapshot(self):
        original = work_ui._native_stamp
        def commit_after_stamp(q):
            stamp = original(q)
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET title='desktop concurrent edit' WHERE slug='one'")
            return stamp
        try:
            with work_ui._lock:
                work_ui._cache.clear()
            with patch.object(work_ui,'_native_stamp',side_effect=commit_after_stamp):
                old_token,old = work_ui.read(SLUG)
            self.assertEqual(next(r for r in old['items'] if r['slug']=='one')['title'],'Title one')
            new_token,new = work_ui.read(SLUG,since=old_token)
            self.assertNotEqual(new_token,old_token)
            self.assertEqual(next(r for r in new['delta']['items']['upsert'] if r['slug']=='one')['title'],'desktop concurrent edit')
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET title='Title one' WHERE slug='one'")

    def test_light_scope_summary_matches_ledger_without_authored_history(self):
        result = worklist.foreground(SLUG,USER,now_ts=NOW)
        light = next(r for r in result['items'] if r['slug']=='one')
        full = self.oracle.work_get(USER,'one',now_ts=NOW)
        self.assertEqual(light['scope_archive_summary'],full['scope_archive_summary'])
        self.assertEqual(light['objective_notice'],full['objective_notice'])
        self.assertEqual(light['status_at'],full['status_at'])
        self.assertNotIn('history',light)
        self.assertNotIn('scope',light)

    def test_hot_rows_exclude_retained_legacy_text_while_detail_preserves_it(self):
        from psycopg.types.json import Json
        marker = 'detail-only-legacy-\x00' + 'z'*200
        encoded_marker = json.dumps(marker)[1:-1]
        archive = [dict(seq=-n,at=AT,kind='decision',text=marker) for n in range(1000,0,-1)]
        try:
            with writer() as raw:
                original = raw.execute("SELECT extra FROM orgtree.work_items WHERE slug='one'").fetchone()[0]
                extra = dict(original or {},scope_archive=archive,private_notes=marker,
                             history=[dict(op='note',text=marker)],evidence=[dict(note=marker)])
                raw.execute("UPDATE orgtree.work_items SET extra=%s WHERE slug='one'",(Json(extra),))
            with snapshot() as q:
                row = q.lookup('one')
                self.assertFalse(encoded_marker in json.dumps(row.summary))
                body = q.detail('one')[0]
                self.assertEqual(body['scope_archive'],archive)
                self.assertEqual(body['private_notes'],marker)
                inputs = q.list_inputs([row])[0]
                self.assertFalse(encoded_marker in json.dumps(inputs))
                self.assertNotIn('scope_archive',inputs)
                light = worklist.Context(q).light(row,SLUG)
                full = workdetail.get(SLUG,USER,'one',now_ts=NOW)
                self.assertEqual(light['scope_archive_summary'],full['scope_archive_summary'])
                self.assertEqual(light['objective_notice'],full['objective_notice'])
                self.assertEqual(light['scope_archive_summary']['count'],1001)
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET extra=%s WHERE slug='one'",(Json(original),))

    def test_status_metadata_query_stays_bounded_as_history_grows(self):
        from orgtree.orgdb import docket
        class Cursor:
            def __init__(self,cur,calls):
                self.cur,self.calls = cur,calls
            def __enter__(self):
                self.cur.__enter__()
                return self
            def __exit__(self,*args):
                return self.cur.__exit__(*args)
            def execute(self,sql,params=()):
                self.calls.append((sql,params))
                return self.cur.execute(sql,params)
            def __getattr__(self,key):
                return getattr(self.cur,key)
        class Trace:
            def __init__(self,raw):
                self.raw,self.calls = raw,[]
            def cursor(self,**kwargs):
                return Cursor(self.raw.cursor(**kwargs),self.calls)
            def execute(self,sql,params=()):
                self.calls.append((sql,params))
                return self.raw.execute(sql,params)
            def __getattr__(self,key):
                return getattr(self.raw,key)
        def plans(node):
            yield node
            for child in node.get('Plans',[]):
                yield from plans(child)
        try:
            with writer() as raw:
                iid = raw.execute("SELECT id FROM orgtree.work_items WHERE slug='one'").fetchone()[0]
                raw.execute('UPDATE orgtree.work_items SET status_at=NULL,status_at_text=NULL WHERE id=%s',(iid,))
                raw.execute("INSERT INTO orgtree.work_item_history(item_id,pos,at,op) VALUES(%s,0,%s,'accept')",(iid,AT))
            for size in (1000,10000):
                with self.subTest(size=size):
                    with writer() as raw:
                        raw.execute("INSERT INTO orgtree.work_item_history(item_id,pos,at,op) "
                            "SELECT %s,p,'2026-10-03T00:00:00Z','update' FROM generate_series(1,%s) p "
                            "ON CONFLICT DO NOTHING",(iid,size))
                    with conn.connect(ADMIN,DATABASE) as admin:
                        admin.execute('ANALYZE orgtree.work_item_history')
                    with snapshot() as original:
                        traced = Trace(original.raw)
                        q = docket.Snapshot(traced,OID,viewer=USER,now_ts=NOW)
                        row = q.lookup('one')
                        light = worklist.Context(q).light(row,SLUG)
                        self.assertEqual(light['status_at'],AT)
                        queries = [(sql,args) for sql,args in traced.calls if 'orgtree.work_item_history h' in sql]
                        self.assertEqual(len(queries),1)
                        sql,args = queries[0]
                        self.assertNotIn('SELECT *',sql)
                        plan = original.raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,args).fetchone()[0][0]['Plan']
                        history = [n for n in plans(plan) if n.get('Relation Name')=='work_item_history']
                        self.assertTrue(history)
                        self.assertTrue(all(n.get('Index Name')=='docket_status_history' for n in history))
                        self.assertLessEqual(sum(n.get('Actual Rows',0)*n.get('Actual Loops',1) for n in history),2)
        finally:
            with writer() as raw:
                raw.execute("DELETE FROM orgtree.work_item_history WHERE item_id=(SELECT id FROM orgtree.work_items WHERE slug='one')")
                raw.execute("UPDATE orgtree.work_items SET status_at=%s,status_at_text=NULL WHERE slug='one'",(AT,))


if __name__ == '__main__':
    unittest.main()
