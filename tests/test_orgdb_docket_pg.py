"""Native docket request readers, against the unchanged ledger authorization oracle.

Creates one disposable app and org database. Run only under the P03 heavy lock.
Each public-path regression executes against stage 1-B before the native port.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
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
        nodes[name] = dict(parent=parent, state=state, generation=0,
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


def setUpModule():
    global LC, OID, DATABASE, DOC
    if not (ADMIN and RUNTIME):
        return
    LC = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
    LC.bootstrap()
    registry.use_lifecycle(LC)
    OID = LC.create_org(SLUG)
    DATABASE = LC.row(OID)['database']
    DOC = seed()
    rows, _, _ = sections.encode_document(DOC, mappers.sections(), ignored=mappers.ignored_keys())
    with conn.connect(RUNTIME, DATABASE) as raw, raw.transaction():
        rowio.write(raw, rows)


def tearDownModule():
    registry.close_idle()
    registry.close_registry()
    if LC is not None:
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
        asked = next(r for r in result['items'] if r['slug'] == 'asked')
        self.assertTrue(asked['questions'])

    def test_agent_list_has_no_unrequested_archive_total(self):
        result = worklist.agent_list(SLUG, 'worker', now_ts=NOW)
        self.assertIsNotNone(result)
        self.assertNotIn('archived', result['counts'])
        self.assertNotIn('count', result['groups']['archived'])
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


if __name__ == '__main__':
    unittest.main()
