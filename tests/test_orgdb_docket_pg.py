"""Native docket request readers, against the unchanged ledger authorization oracle.

Creates one disposable app and org database. Run only under the P03 heavy lock.
Each public-path regression executes against stage 1-B before the native port.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

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
from orgtree.orgdb import codec, conn, lifecycle, mappers, names, registry, sections  # noqa: E402
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
    # Match Lifecycle.mark_filled: conversion supplies identities explicitly.
    with conn.connect(ADMIN, DATABASE) as admin:
        for table, column in admin.execute("SELECT table_name,column_name FROM information_schema.columns "
                "WHERE table_schema='orgtree' AND is_identity='YES'").fetchall():
            admin.execute(f"SELECT setval(pg_get_serial_sequence('orgtree.{table}','{column}'),"
                          f"coalesce((SELECT max({column}) FROM orgtree.{table}),0)+1,false)")


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

    @staticmethod
    def replace_record(raw, record):
        """Use the real mapper columns, including its preserved misfit values."""
        from orgtree.orgdb.mappers.docket import WORK_ITEM, WORK_ITEMS, row_keys
        rid, placement, position = raw.execute(
            'SELECT id,list_key,ord FROM orgtree.work_items WHERE slug=%s',
            (record['slug'],)).fetchone()
        rows = {}
        codec.encode(WORK_ITEM, record, row_keys(record,id=rid,list_key=placement,ord=position),
                     rows,link=WORK_ITEMS.link)
        row = rows['work_items'][0]
        columns = [c for c in row if c not in ('id','list_key','ord')]
        raw.execute('UPDATE orgtree.work_items SET '+','.join(codec.quote(c)+'=%s' for c in columns)+
                    ' WHERE id=%s',tuple(row[c] for c in columns)+(rid,))

    def test_iso_deadlines_follow_the_canonical_parser_and_original_text(self):
        original = next(r for r in DOC['work_items'] if r['slug']=='expired')
        stamps = (AT,'2026-10-02X00:00:00+00:00','20261002T000000+0000',
                  '2026-W40-5T00:00:00+00:00','2026-10-02\n00:00:00+00:00',
                  '2026-10-02\U0001f60000:00:00+00:00','2026-10-02','2026-W40-5',
                  '20261002','2026-10-02T00:00:00','2026-10-02T00:00:00+01:02:03.5',
                  '2026-10-02T24:00:00+00:00','2026-02-30T00:00:00Z',
                  '2026-10-02T00:00:00z','not-a-date',20261002,False)
        try:
            for stamp in stamps:
                with self.subTest(stamp=repr(stamp)):
                    record = dict(original,docket_at=stamp)
                    with writer() as raw:
                        self.replace_record(raw,record)
                    age = self.oracle._work_age_s(record,NOW)
                    deadline = None if age is None else NOW-age+3600
                    with snapshot('worker') as q:
                        self.assertEqual(q.detail('expired')[0],record)
                        actual = q.raw.execute("SELECT docket_deadline FROM orgtree.work_items WHERE slug='expired'").fetchone()[0]
                        if deadline is None:
                            self.assertIsNone(actual)
                        else:
                            self.assertAlmostEqual(actual,deadline,places=5)
                        main = {r.summary['slug'] for r in q.foreground()}
                        self.assertEqual('expired' not in main,deadline is not None and deadline<NOW)
                    if deadline is not None:
                        with snapshot('worker',deadline) as q:
                            self.assertIn('expired',{r.summary['slug'] for r in q.foreground()})
                        with snapshot('worker',deadline+0.001) as q:
                            self.assertNotIn('expired',{r.summary['slug'] for r in q.foreground()})
        finally:
            with writer() as raw:
                self.replace_record(raw,original)

    def test_unrepresentable_timestamp_text_saves_without_changing_detail_or_order(self):
        original = next(r for r in DOC['work_items'] if r['slug']=='expired')
        try:
            for stamp in ('not-a-date\x00preserved','not-a-date\ud800preserved',
                          '__orgtree_docket_escape__\x00','\\u0000literal'):
                with self.subTest(stamp=repr(stamp)):
                    record = dict(original,docket_at=stamp)
                    with writer() as raw:
                        self.replace_record(raw,record)
                    with snapshot('worker') as q:
                        self.assertEqual(q.detail('expired')[0],record)
                        self.assertIn('expired',{r.summary['slug'] for r in q.foreground()})
            # Unsupported characters must still sort in Python Unicode order.
            records = [dict(next(r for r in DOC['work_items'] if r['slug']==slug),
                            docket_at=stamp,status='in_progress')
                       for slug,stamp in (('one','x\x00'),('expired','x\ud800'),('w12345678','x\U0001f600'))]
            with writer() as raw:
                for record in records:
                    self.replace_record(raw,record)
            expected = sorted(records,key=lambda r:(r['docket_at'],r['slug']),reverse=True)
            with snapshot('worker') as q:
                actual = [r.summary['slug'] for r in q.foreground() if r.summary['slug'] in {r['slug'] for r in records}]
                self.assertEqual(actual,[r['slug'] for r in expected])
        finally:
            with writer() as raw:
                for slug in ('one','expired','w12345678'):
                    self.replace_record(raw,next(r for r in DOC['work_items'] if r['slug']==slug))

    def test_recorded_role_names_and_anchor_follow_canonical_truth_and_str(self):
        original = next(r for r in DOC['work_items'] if r['slug']=='expired')
        cases = [(role,value) for role in ('owner','created_by','reviewer')
                 for value in (1,True,1.5,[1],{'x':1},'é','\U0001f600')]
        cases += [('fallback',value) for value in ('',0,False,None,[],{})]
        try:
            for role,value in cases:
                with self.subTest(role=role,value=value):
                    name = 'worker' if role=='fallback' else str(value)
                    record = dict(original,owner={'node':'other'},created_by={'node':'other'},reviewer={'node':'other'})
                    if role=='fallback':
                        record.update(owner={'node':value},created_by={'node':name})
                    else:
                        record[role] = {'node':value}
                    doc = copy.deepcopy(DOC)
                    doc['nodes'][name] = doc['nodes'].pop('worker')
                    oracle = Org(doc)
                    self.assertTrue(oracle._work_can_read(name,record))
                    boss_reads = oracle._work_can_read('boss',record)
                    with writer() as raw:
                        raw.execute("UPDATE orgtree.agents SET name=%s WHERE name='worker'",(name,))
                        self.replace_record(raw,record)
                    try:
                        with snapshot(name) as q:
                            self.assertEqual(q.detail('expired')[0],record)
                            rows,_ = q.archive()
                            self.assertIn('expired',{r.summary['slug'] for r in rows})
                        with snapshot('boss') as q:
                            self.assertEqual(q.lookup('expired') is not None,boss_reads)
                            rows,_ = q.archive()
                            self.assertEqual('expired' in {r.summary['slug'] for r in rows},boss_reads)
                    finally:
                        with writer() as raw:
                            raw.execute('UPDATE orgtree.agents SET name=\'worker\' WHERE name=%s',(name,))
                            self.replace_record(raw,original)
        finally:
            with writer() as raw:
                self.replace_record(raw,original)

    def test_converter_and_compat_save_store_identical_canonical_headers(self):
        from orgtree.orgdb import docket
        from orgtree.orgdb.compat import rows as compat_rows
        from orgtree.orgdb.mappers.docket import Docket
        cases = [(stamp,node) for stamp in
                 ('2026-10-02X00:00:00+00:00','20261002T000000+0000','2026-W40-5',
                  '2026-10-02T24:00:00+00:00','2026-10-02T00:00:00z',
                  'not-a-date\x00preserved','not-a-date\ud800preserved')
                 for node in (1,True,'\x00')]
        records = [item('derived-edge-'+str(n),status='done',docket_at=stamp,
                        owner={'node':node},created_by={'node':''})
                   for n,(stamp,node) in enumerate(cases)]
        converted = {}
        Docket().encode(dict(work_items=records),sections.Context(),converted)
        columns = list(docket.write_fields(records[0]))
        slugs = [r['slug'] for r in records]
        try:
            with writer() as raw:
                base = int(raw.execute('SELECT max(id)+100 FROM orgtree.work_items').fetchone()[0])
                for table,rows in converted.items():
                    for row in rows:
                        key = 'id' if table=='work_items' else 'item_id'
                        row[key] += base
                        if table=='work_items':
                            row['ord'] += base
                            row['archive_seq'] += base
                rowio.write(raw,converted)
                for record in records:
                    with self.subTest(stamp=repr(record['docket_at']),node=repr(record['owner']['node'])):
                        saved = raw.execute('SELECT '+codec.quoted(columns)+
                            ' FROM orgtree.work_items WHERE slug=%s',(record['slug'],)).fetchone()
                        expected = tuple(docket.write_fields(record).values())
                        self.assertEqual(saved,expected)
                        compat_rows.item_put(raw,compat_rows.Tx(),record['slug'],record)
                        self.assertEqual(raw.execute('SELECT '+codec.quoted(columns)+
                            ' FROM orgtree.work_items WHERE slug=%s',(record['slug'],)).fetchone(),saved)
                        body = json.loads(compat_rows.item(raw,record['slug'])[1])
                        self.assertEqual(body,record)
        finally:
            with writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE slug=ANY(%s)',(slugs,))

    def test_old_converted_database_refuses_0007_then_empty_database_migrates(self):
        from orgtree.orgdb import migrate
        database = PREFIX+'stale_docket'
        with tempfile.TemporaryDirectory(prefix='docket-old-migrations-') as folder:
            old = Path(folder)
            for path in migrate.files(migrate.ORG_DIR):
                if path.name<'0007':
                    (old/path.name).write_bytes(path.read_bytes())
            try:
                with conn.connect(ADMIN,'postgres') as admin:
                    admin.execute('CREATE DATABASE '+codec.quote(database))
                with conn.connect(ADMIN,database) as admin:
                    migrate.migrate(admin,old,migrate.ORG_LOCK)
                    admin.execute("INSERT INTO orgtree.work_items(list_key,ord,slug) VALUES('active',0,'pre-0007')")
                    with self.assertRaisesRegex(Exception,'converted before 0007: re-convert it from its legacy data'):
                        migrate.migrate(admin,migrate.ORG_DIR,migrate.ORG_LOCK)
                    self.assertNotIn('0007_docket_readers.sql',migrate.applied(admin))
                    self.assertIsNone(admin.execute("SELECT 1 FROM information_schema.columns WHERE table_schema='orgtree' "
                        "AND table_name='work_items' AND column_name='docket_order'").fetchone())
                    admin.execute('DELETE FROM orgtree.work_items')
                    self.assertIn('0007_docket_readers.sql',migrate.migrate(admin,migrate.ORG_DIR,migrate.ORG_LOCK)['applied'])
                    self.assertEqual(admin.execute("SELECT is_generated FROM information_schema.columns "
                        "WHERE table_schema='orgtree' AND table_name='work_items' AND column_name='docket_order'").fetchone()[0],'NEVER')
            finally:
                with conn.connect(ADMIN,'postgres') as admin:
                    admin.execute('DROP DATABASE IF EXISTS '+codec.quote(database)+' WITH (FORCE)')

    def test_archive_cursor_keeps_unicode_order_for_preserved_unsupported_dates(self):
        from orgtree.orgdb.mappers.docket import Docket
        records = [item('unicode-archive-'+str(n),status='done',docket_at=stamp)
                   for n,stamp in enumerate(('x\x00','x\ud800','x\U0001f600','x','x\\u0000'))]
        encoded = {}
        Docket().encode(dict(work_items_archive=records),sections.Context(),encoded)
        slugs = {r['slug'] for r in records}
        try:
            with writer() as raw:
                base = int(raw.execute('SELECT max(id)+100 FROM orgtree.work_items').fetchone()[0])
                for table,rows in encoded.items():
                    for row in rows:
                        row['id' if table=='work_items' else 'item_id'] += base
                        if table=='work_items':
                            row['ord'] += base
                rowio.write(raw,encoded)
            actual,cursor = [],''
            while True:
                with snapshot('worker') as q:
                    rows,cursor = q.archive(limit=1,cursor=cursor)
                    actual.extend(r.summary['slug'] for r in rows if r.summary['slug'] in slugs)
                if not cursor:
                    break
            self.assertEqual(actual,[r['slug'] for r in sorted(records,
                key=lambda r:(r['docket_at'],r['slug']),reverse=True)])
        finally:
            with writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE slug=ANY(%s)',(list(slugs),))

    def test_actual_policy_context_consumes_docket_in_its_existing_snapshot(self):
        from psycopg.types.json import Json
        from orgtree import policy_context
        from orgtree.orgdb import docket
        original_build, real_snapshot = policy_context._build, docket.Snapshot
        seen = {}
        def build(connection, graph, *, docket):
            seen['raw'],seen['org_id'] = connection.raw,connection.org_id
            return original_build(connection,graph,docket=docket)
        def query(raw,org_id,**kwargs):
            self.assertIs(raw,seen['raw'])
            self.assertEqual(org_id,seen['org_id'])
            self.assertEqual(kwargs['viewer'],USER)
            self.assertEqual(raw.execute('SHOW transaction_isolation').fetchone()[0],'repeatable read')
            self.assertEqual(raw.execute('SHOW transaction_read_only').fetchone()[0],'on')
            with writer() as other:
                other.execute("UPDATE orgtree.work_items SET title='after policy snapshot' WHERE slug='one'")
            seen['called'] = True
            return real_snapshot(raw,org_id,**kwargs)
        try:
            with writer() as raw:
                raw.execute("UPDATE orgtree.asks SET questions=%s WHERE public_id='ask-1'",
                            (Json([dict(question='Active item?',work_item='one'),
                                   dict(question='Archived item?',work_item='asked')]),))
            with patch.object(policy_context,'_build',side_effect=build), \
                    patch.object(docket,'Snapshot',side_effect=query), \
                    patch.object(store,'cached_org',side_effect=AssertionError('whole-org fallback')), \
                    patch.object(store,'load_org',side_effect=AssertionError('whole-org fallback')):
                context = policy_context.read(SLUG,docket=True)
            self.assertIsInstance(context,policy_context.PolicyContext)
            self.assertTrue(seen['called'])
            items = {r['slug']:r for r in context._work_active()}
            self.assertEqual(set(items),{'one','back','w12345678'})
            self.assertEqual(items['one']['title'],'Title one')
            self.assertTrue(context._work_questions('one'))
            self.assertEqual(context._work_questions('asked'),[])
            with snapshot() as q:
                self.assertEqual(q.lookup('one').summary['title'],'after policy snapshot')
        finally:
            with writer() as raw:
                raw.execute("UPDATE orgtree.work_items SET title='Title one' WHERE slug='one'")
                raw.execute("UPDATE orgtree.asks SET questions=%s WHERE public_id='ask-1'",
                            (Json(DOC['asks'][0]['questions']),))

    def test_all_dispatched_work_item_encoders_supply_exact_derived_fields(self):
        from orgtree.orgdb import docket
        from orgtree.orgdb.compat import rows as compat_rows
        from orgtree.orgdb.mappers.docket import Docket, WORK_ITEM
        original_active = next(r for r in DOC['work_items'] if r['slug']=='expired')
        original_archive = next(r for r in DOC['work_items_archive'] if r['slug']=='old')
        real_encode,seen = codec.encode,[]
        def encode(spec,record,keys,*args,**kwargs):
            if spec is WORK_ITEM:
                fields = docket.write_fields(record)
                self.assertTrue(set(fields)<=set(keys),'work-item encoder skipped row_keys')
                self.assertEqual({key:keys[key] for key in fields},fields)
                seen.append(spec)
            return real_encode(spec,record,keys,*args,**kwargs)
        with conn.connect(ADMIN,DATABASE) as admin:
            admin.execute("SELECT setval(pg_get_serial_sequence('orgtree.work_items','id'),"
                          "(SELECT max(id) FROM orgtree.work_items),true)")
        try:
            for path in ('convert','save','archive_append','archive_replace'):
                with self.subTest(path=path), patch.object(codec,'encode',side_effect=encode):
                    seen.clear()
                    if path=='convert':
                        Docket().encode(dict(work_items=[dict(original_active,docket_at='2026-W40-5')]),
                                        sections.Context(),{})
                    else:
                        with writer() as raw:
                            ls = compat_rows.model().logs['work_items_archive']
                            if path=='save':
                                record = dict(original_active,docket_at='2026-10-02X00:00:00+00:00',owner={'node':1})
                                compat_rows.item_put(raw,compat_rows.Tx(),record['slug'],record)
                                body = json.loads(compat_rows.item(raw,record['slug'])[1])
                            else:
                                record = dict(original_archive,docket_at='invalid\x00date',owner={'node':True})
                                if path=='archive_append':
                                    record['slug'] = 'archive-derived-edge'
                                    compat_rows.log_insert(raw,ls,None,json.dumps(record),compat_rows.Names(raw),tx=compat_rows.Tx())
                                else:
                                    seq = raw.execute("SELECT archive_seq FROM orgtree.work_items WHERE slug='old'").fetchone()[0]
                                    self.assertEqual(compat_rows.log_replace(raw,ls,seq,json.dumps(record),expected=None,tx=compat_rows.Tx()),1)
                                seq = raw.execute('SELECT archive_seq FROM orgtree.work_items WHERE slug=%s',(record['slug'],)).fetchone()[0]
                                body = json.loads(compat_rows.log_rows(raw,ls,ids=[seq])[0][3])
                            self.assertEqual(body,record)
                            fields = docket.write_fields(record)
                            self.assertEqual(raw.execute('SELECT '+codec.quoted(fields)+
                                ' FROM orgtree.work_items WHERE slug=%s',(record['slug'],)).fetchone(),tuple(fields.values()))
                    self.assertTrue(seen,'work-item encoder did not execute')
        finally:
            with writer() as raw:
                self.replace_record(raw,original_active)
                self.replace_record(raw,original_archive)
                raw.execute("DELETE FROM orgtree.work_items WHERE slug='archive-derived-edge'")

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
            from orgtree.orgdb.docket import write_fields
            for status,stamp in ((None,AT),('in_progress',AT),('done','not a date'),('done',None)):
                with self.subTest(status=status,stamp=stamp):
                    self.assertIsNone(write_fields(dict(status=status,docket_at=stamp))['docket_deadline'])

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
        original = next(r for r in DOC['work_items'] if r['slug']=='one')
        try:
            with writer() as raw:
                self.replace_record(raw,dict(original,created_by={'node':'other'}))
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
                self.replace_record(raw,original)

    def test_falsy_original_date_uses_update_date_for_archive_policy(self):
        original = next(r for r in DOC['work_items'] if r['slug']=='expired')
        try:
            for value in (False,0,'',[],{}):
                with self.subTest(value=value):
                    with writer() as raw:
                        self.replace_record(raw,dict(original,docket_at=value))
                    with snapshot('worker') as q:
                        self.assertNotIn('expired',{r.summary['slug'] for r in q.foreground()})
                        rows,_ = q.archive()
                        self.assertIn('expired',{r.summary['slug'] for r in rows})
        finally:
            with writer() as raw:
                self.replace_record(raw,original)

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
        from orgtree.orgdb.compat import rows as compat_rows
        marker = 'detail-only-legacy-\x00' + 'z'*200
        encoded_marker = json.dumps(marker)[1:-1]
        archive = [dict(seq=-n,at=AT,kind='decision',text=marker) for n in range(1000,0,-1)]
        try:
            with writer() as raw:
                original = json.loads(compat_rows.item(raw,'one')[1])
                for text in ('\x00','\\u0000','\x00\x00','\\\x00',
                             '__orgtree_docket_escape__\x00','\ud800','\U0001f600'):
                    with self.subTest(text=repr(text)), raw.transaction():
                        projected = raw.execute('SELECT orgtree.docket_extra(%s,ARRAY[\'objective\'])',
                            (Json(dict(objective=text,unrelated=text)),)).fetchone()[0]
                        self.assertEqual(projected,dict(objective=text))
                record = dict(original,scope_archive=archive,private_notes=marker,
                             history=[dict(op='note',text=marker)],evidence=[dict(note=marker)])
                compat_rows.item_put(raw,compat_rows.Tx(),'one',record)
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
                compat_rows.item_put(raw,compat_rows.Tx(),'one',original)

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
                raw.execute("INSERT INTO orgtree.work_item_events(item_id,seq,source,kind,history_at,history_op,status_change) "
                            "VALUES(%s,1,'history','history',%s,'accept',true)",(iid,AT))
            for size in (1000,10000):
                with self.subTest(size=size):
                    with writer() as raw:
                        raw.execute("INSERT INTO orgtree.work_item_events(item_id,seq,source,kind,history_at,history_op,status_change) "
                            "SELECT %s,p+1,'history','history','2026-10-03T00:00:00Z','update',false FROM generate_series(1,%s) p "
                            "ON CONFLICT DO NOTHING",(iid,size))
                    with conn.connect(ADMIN,DATABASE) as admin:
                        admin.execute('ANALYZE orgtree.work_item_events')
                    with snapshot() as original:
                        traced = Trace(original.raw)
                        q = docket.Snapshot(traced,OID,viewer=USER,now_ts=NOW)
                        row = q.lookup('one')
                        light = worklist.Context(q).light(row,SLUG)
                        self.assertEqual(light['status_at'],AT)
                        queries = [(sql,args) for sql,args in traced.calls if 'orgtree.work_item_events h' in sql]
                        self.assertEqual(len(queries),1)
                        sql,args = queries[0]
                        self.assertNotIn('SELECT *',sql)
                        plan = original.raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,args).fetchone()[0][0]['Plan']
                        history = [n for n in plans(plan) if n.get('Relation Name')=='work_item_events']
                        self.assertTrue(history)
                        self.assertTrue(all(n.get('Index Name')=='docket_status_history' for n in history))
                        self.assertLessEqual(sum(n.get('Actual Rows',0)*n.get('Actual Loops',1) for n in history),2)
        finally:
            with writer() as raw:
                raw.execute("DELETE FROM orgtree.work_item_events WHERE source='history' AND item_id=(SELECT id FROM orgtree.work_items WHERE slug='one')")
                raw.execute("UPDATE orgtree.work_items SET status_at=%s,status_at_text=NULL WHERE slug='one'",(AT,))


if __name__ == '__main__':
    unittest.main()
