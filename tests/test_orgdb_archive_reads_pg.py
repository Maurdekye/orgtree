"""Native archive facts: exact headers, caller snapshots and retained-history guards."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
import copy
import json
import os
from pathlib import Path
import statistics
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as f
from orgdb_history_fixture import load_census, targets
from orgtree import api, ledger, store, supervisor, work_ui
from orgtree.orgdb import archive_reads, codec, conn, registry
from orgtree.orgdb.mappers.docket import WORK_ITEM

setUpModule = f.setUpModule
tearDownModule = f.tearDownModule
ARCHIVE = 'work_items_archive'
REPORT = {}


def seed(slug):
    org = store.load_org(slug)
    org.d[ARCHIVE] = [dict(f.item('old-' + str(n), 'Archived'), status='done',
                           objective='kept body ' * 5000) for n in range(6)]
    store.save_org(org)


def unique(values):
    return {json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
            for value in values}


@contextmanager
def no_archive_decodes():
    original = codec.decode
    attempts = []
    loads = []
    original_load = store._load_section

    def decode(spec, row, *args, **kw):
        if spec is WORK_ITEM and row.get('list_key') == 'archive':
            attempts.append(row['id'])
        return original(spec, row, *args, **kw)

    def load(slug, section, *args, **kw):
        if section == ARCHIVE:
            loads.append(slug)
        return original_load(slug, section, *args, **kw)

    with patch.object(codec, 'decode', decode), patch.object(store, '_load_section', load):
        yield attempts, loads


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


def explained(raw, sql):
    plan = raw.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql).fetchone()[0][0]['Plan']
    physical = [p for p in nodes(plan) if p.get('Relation Name') == 'work_items']
    examined = sum((p.get('Actual Rows', 0) + p.get('Rows Removed by Filter', 0)
                    + p.get('Rows Removed by Index Recheck', 0)) * p.get('Actual Loops', 0)
                   for p in physical)
    return dict(plan=plan, examined=examined, scans=[p['Node Type'] for p in physical],
                heap_fetches=sum(p.get('Heap Fetches', 0) for p in physical))


@f.needs_pg
class ArchiveReads(unittest.TestCase):
    def setUp(self):
        self.twins = f.Twins('archive-' + self._testMethodName[5:], before=seed)
        self.slug = self.twins.copy

    def edit(self, callback):
        with f.storage(True):
            org = store.load_org(self.slug)
            callback(org.d[ARCHIVE])
            store.save_org(org)

    def test_same_answers_as_full_decode_for_stored_shapes(self):
        values = ['done', None, 1, True, 1.0, False, 0, ['x', None],
                  {'nested': [1]}, 'nul\x00\ud800']

        def shapes(items):
            template = items[0]
            items[:] = [dict(template, slug='shape-' + str(n), status=value)
                        for n, value in enumerate(values)]
            items.append(dict(template, slug='missing'))
            items[-1].pop('status')
            for n, old in enumerate((None, 0, {}, 'nul\x00\ud800')):
                items[n]['id'] = old
            items[0]['future'] = {'large': 'x' * 50000}
        self.edit(shapes)
        with f.storage(True):
            decoded = list(store.load_org(self.slug).d[ARCHIVE])
            self.assertEqual([x.get('status') for x in decoded], values + [None])
            with no_archive_decodes() as (decodes, loads):
                lazy = store.load_org(self.slug).d
                identity = lazy.archive_identity()
                statuses = lazy.archive_statuses()
            self.assertEqual(identity, [(x['slug'], 'id' in x) for x in decoded])
            expected = unique(x.get('status') for x in decoded)
            self.assertEqual(len(statuses), len(expected))
            self.assertEqual(unique(statuses), expected)
            self.assertEqual((decodes, loads), ([], []))

    def test_same_identity_decision_as_row_walk(self):
        for value in ('absent', None, 7, {'kept': True}):
            if value != 'absent':
                self.edit(lambda items: items[2].update(id=value))
            with f.storage(True), no_archive_decodes() as (decodes, loads):
                indexed = store.load_org(self.slug).work_identity_state()
            with f.storage(True):
                whole = store.load_org(self.slug)
                list(whole.d[ARCHIVE])
                walked = whole.work_identity_state()
            self.assertEqual(indexed, walked)
            self.assertEqual(indexed, 'slug' if value == 'absent' else 'legacy')
            self.assertEqual((decodes, loads), ([], []))

    def test_resident_and_buffered_refusals_precede_native_queries(self):
        def resident(d): dict.__setitem__(d, ARCHIVE, [])
        cases = [resident, lambda d: d._dropped.add(ARCHIVE),
                 lambda d: d._pending.update({ARCHIVE: []}),
                 lambda d: d._snap_doc.update({ARCHIVE: '[]'}),
                 lambda d: d._deferred_doc.update({ARCHIVE: []}),
                 lambda d: d._present.discard(ARCHIVE)]
        for on, slug in ((False, self.twins.legacy), (True, self.slug)):
            for modify in cases:
                with self.subTest(on=on, refusal=repr(modify)), f.storage(on):
                    d = store.load_org(slug).d
                    modify(d)
                    with patch.object(store._POOL, 'acquire', side_effect=AssertionError('guard queried')):
                        self.assertIsNone(d.archive_identity())
                        self.assertIsNone(d.archive_statuses())

    def test_unindexable_headers_refuse_without_truncating_the_document(self):
        self.edit(lambda items: items[0].update(status='x' * 3000))
        with f.storage(True):
            d = store.load_org(self.slug).d
            self.assertIsNone(d.archive_statuses())
            self.assertEqual(d[ARCHIVE][0]['status'], 'x' * 3000)
        self.edit(lambda items: items[0].update(slug='x' * 1500, status='done'))
        with f.storage(True):
            d = store.load_org(self.slug).d
            self.assertIsNone(d.archive_identity())
            self.assertEqual(d[ARCHIVE][0]['slug'], 'x' * 1500)
        self.edit(lambda items: items[0].update(slug=123))
        with f.storage(True):
            d = store.load_org(self.slug).d
            self.assertIsNone(d.archive_identity())
            self.assertEqual(d[ARCHIVE][0]['slug'], 123)

    def test_duplicate_headers_and_uncommitted_writes_use_pinned_connection(self):
        with f.storage(True), store._POOL.acquire(self.slug) as view:
            view.execute('BEGIN')
            view.pinned = True  # match orgdb.compat.tx's pinned caller contract
            try:
                with patch.object(store._orgtx_local, 'pinned', {self.slug: view}, create=True):
                    view.raw.execute("UPDATE orgtree.work_items SET slug='old-0' WHERE slug='old-1'")
                    d = store.load_org(self.slug).d
                    facts = d.archive_identity()
                    self.assertIsNotNone(facts)
                    self.assertEqual(sum(name == 'old-0' for name, _ in facts), 2)
                    self.assertEqual(store.load_org(self.slug).work_identity_state(), 'legacy')
                    self.assertFalse(archive_reads.current_identity(view.raw))
                    view.raw.execute("UPDATE orgtree.work_items SET status='dropped' WHERE slug='old-2'")
                    self.assertIn('dropped', d.archive_statuses())
            finally:
                view.pinned = False
                view.execute('ROLLBACK')
        with f.storage(True):
            self.assertEqual(store.load_org(self.slug).work_identity_state(), 'slug')

    def test_reader_uses_the_callers_repeatable_read_snapshot(self):
        with f.storage(True), store._POOL.acquire(self.slug) as view:
            view.execute('BEGIN')
            view.pinned = True
            try:
                with patch.object(store._orgtx_local, 'pinned', {self.slug: view}, create=True):
                    d = store.load_org(self.slug).d
                    before = d.archive_statuses()
                    with registry.connection(self.slug) as writer:
                        writer.execute("UPDATE orgtree.work_items SET status='dropped' WHERE slug='old-2'")
                    self.assertEqual(d.archive_statuses(), before)
                    self.assertNotIn('dropped', before)
            finally:
                view.pinned = False
                view.execute('ROLLBACK')
        with f.storage(True):
            self.assertIn('dropped', store.load_org(self.slug).d.archive_statuses())

    def test_tool_paths_and_abandoned_tick_decode_no_archive_items(self):
        request = SimpleNamespace(state=SimpleNamespace())
        with f.storage(True), no_archive_decodes() as (decodes, loads), \
                patch.object(supervisor, 'send_message', lambda *a, **kw: {}), \
                patch.object(api, 'mail_notify', lambda *a, **kw: None), \
                patch.object(api, 'hub_changed', lambda *a, **kw: None):
            def tool(**args):
                return api.agent_call(api.AgentCall(org=self.slug, node='boss',
                    tool='orgtree_work', args=args), request)
            made = tool(action='create', title='Fresh item', objective='Problem. Solution.')
            name = made.get('created') or made.get('slug')
            self.assertTrue(name, made)
            changed = tool(action='update', slug=name, done_so_far=['checked'], working_on_next=[])
            self.assertNotIn('error', changed)
            org = store.load_org(self.slug)
            self.assertTrue(org.work_abandoned_pending(now_ts=time.time()))
            moved = org.work_reassign_abandoned(now_ts=time.time())
            self.assertEqual({row['assigned'] for row in moved}, {'fix-the-thing', 'second-item'})
            self.assertFalse(org.work_abandoned_pending(now_ts=time.time()))
        self.assertEqual((decodes, loads), ([], []))

    def grow(self, count):
        with registry.connection(self.slug) as raw:
            current = raw.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='archive'").fetchone()[0]
            raw.execute("""INSERT INTO orgtree.work_items
                (slug,status,list_key,ord,docket_manual,docket_order,objective)
                SELECT 'growth-' || n, CASE WHEN n%%3=0 THEN 'dropped' ELSE 'done' END,
                       'archive', n, false, '', repeat('retained body ',4000)
                FROM generate_series(%s,%s) n""", (current, count-1))
        row = registry.lookup(self.slug)
        with conn.connect(f.ADMIN, row[1]) as admin:
            admin.execute('VACUUM (ANALYZE) orgtree.work_items')

    def test_status_probes_are_flat_and_identity_is_covering(self):
        measurements = []
        with f.storage(True):
            for size in (2048, 20480):
                self.grow(size)
                with no_archive_decodes() as (decodes, loads):
                    lazy = store.load_org(self.slug).d
                    self.assertEqual(set(lazy.archive_statuses()), {'done', 'dropped'})
                    self.assertEqual(len(lazy.archive_identity()), size)
                self.assertEqual((decodes, loads), ([], []))
                with store._POOL.acquire(self.slug) as view:
                    statuses = view.raw.execute(archive_reads.STATUSES_SQL).fetchall()
                    self.assertEqual(set(json.loads(x[0]) for x in statuses), {'done', 'dropped'})
                    status = explained(view.raw, archive_reads.STATUSES_SQL)
                    refusal = explained(view.raw, archive_reads.UNREADABLE_STATUS_SQL)
                    identity = explained(view.raw, archive_reads.IDENTITY_SQL)
                    records = explained(view.raw, archive_reads.RECORD_IDENTITY_SQL)
                self.assertTrue(status['scans'])
                self.assertTrue(all(x == 'Index Only Scan' for x in status['scans']), status)
                self.assertEqual(identity['scans'], ['Index Only Scan'], identity)
                self.assertEqual(identity['examined'], size)
                self.assertEqual(identity['heap_fetches'], 0)
                self.assertEqual(refusal['examined'], 0)
                self.assertTrue(all(x == 'Index Only Scan' for x in records['scans']), records)
                measurements.append(dict(size=size,status=status,refusal=refusal,
                                         identity=identity,records=records))
        self.assertEqual(measurements[0]['status']['examined'], measurements[1]['status']['examined'])
        REPORT['growth'] = measurements

    def test_identity_latency_at_the_shared_5000_hour_target(self):
        census = load_census()
        limits = [targets(census, hours=h)['archived_docket'] for h in (1, 5000)]
        samples = []
        with f.storage(True):
            for count in limits:
                self.grow(max(6, count))
                def call(): return store.load_org(self.slug).work_identity_state()
                with no_archive_decodes() as (decodes, loads):
                    self.assertEqual(call(), 'slug')
                self.assertEqual((decodes, loads), ([], []))
                call()  # ordinary warmup, followed by nine uninstrumented calls
                times = []
                for _ in range(9):
                    start = time.perf_counter()
                    answer = call()
                    times.append((time.perf_counter()-start)*1000)
                    self.assertEqual(answer, 'slug')
                samples.append(dict(headers=max(6, count),samples_ms=times,median_ms=statistics.median(times)))
        added = samples[1]['median_ms']-samples[0]['median_ms']
        REPORT['latency'] = dict(calibration='recorded combined turn time; shared numeric census',
                                 hours=[1,5000],samples=samples,added_ms=added,limit_ms=100)
        self.assertLessEqual(added, 100, REPORT['latency'])

    def test_native_docket_uses_records_not_a_marker_and_preserves_unusual_names(self):
        with f.storage(True):
            # A false marker cannot refuse current records, nor bless old ones.
            with registry.connection(self.slug) as raw:
                raw.execute("UPDATE orgtree.org_settings SET work_identity='legacy'")
                self.assertTrue(archive_reads.current_identity(raw))
            response = api.work_items_view(self.slug)
            self.assertEqual(response.status_code, 200)
            for value in (123, True, {'kept': [1]}, 'nul\x00\ud800', 'x' * 1500):
                with self.subTest(value=repr(value)):
                    self.edit(lambda items: items[0].update(slug=value))
                    whole = store.load_org(self.slug)
                    list(whole.d[ARCHIVE])
                    expected = whole.work_identity_state() == 'slug'
                    with no_archive_decodes() as (decodes, loads), registry.connection(self.slug) as raw:
                        self.assertEqual(archive_reads.current_identity(raw), expected)
                    self.assertEqual((decodes, loads), ([], []))
            self.edit(lambda items: items[0].update(slug='old-0', id=None))
            with registry.connection(self.slug) as raw:
                raw.execute("UPDATE orgtree.org_settings SET work_identity='slug'")
            with self.assertRaises(api.HTTPException) as refused:
                # Bypass the previous body cache: this asserts the native guard.
                with work_ui._lock:
                    work_ui._cache.clear()
                api.work_items_view(self.slug)
            self.assertEqual(refused.exception.status_code, 409)

    def test_new_org_docket_is_available_without_identity_marker(self):
        with f.storage(True):
            fresh = store.create_org('new docket ' + self._testMethodName)
            slug = fresh.d['slug']
            with registry.connection(slug) as raw:
                self.assertNotEqual(raw.execute('SELECT work_identity FROM orgtree.org_settings').fetchone()[0], 'slug')
            self.assertEqual(api.work_items_view(slug).status_code, 200)
            fresh.hire(ledger.USER, None, 'luna', 0, 'boss')
            fresh.work_create('boss', 'First item', objective='Problem. Solution.', owner='boss')
            store.save_org(fresh)
            with no_archive_decodes() as (decodes, loads):
                response = api.work_items_view(slug)
            self.assertEqual(response.status_code, 200)
            self.assertEqual((decodes, loads), ([], []))


def tearDownModule():
    try:
        if os.environ.get('ORGTREE_ARCHIVE_REPORT'):
            Path(os.environ['ORGTREE_ARCHIVE_REPORT']).write_text(json.dumps(REPORT,indent=2),encoding='utf-8')
    finally:
        f.tearDownModule()


if __name__ == '__main__':
    unittest.main()
