"""The Presentations window's reads on real PostgreSQL: the document list and
one document body come from bounded row reads, and equal what the whole-org
load answers.

On a copy of the live org, opening Presentations cost 410-450 ms and 40 MB
for the list (every event row, every node, every body, through `load_org`)
and 160-220 ms and 29 MB for the first body. The bounded reads are
`store._pg_document_gallery` and `store.read_document`; every test here
compares them with `Org.document_gallery()` / `api._document_or_404` on a
fresh `load_org`, and the whole-org path stays the answer wherever the rows
cannot be exact (a transaction pinned on this thread, a section still held as
a `doc` blob).

Actual PostgreSQL (disposable, via test_pgstore).
Run:  python tools/run-python-verification.py tests/test_presentations_pg.py
"""
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
from fastapi import HTTPException
from orgtree import api, orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


def doc(did, nid, at, title=None, **extra):
    return {'id': did, 'node': nid, 'title': title or f'title {did}', 'body': f'body of {did}',
            'at': at, **extra}


def evicted(did, actor, at, **detail):
    return {'op': 'present_evicted', 'actor': actor, 'at': at,
            'detail': {'id': did, 'title': f'gone {did}', **detail}}


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class Presentations(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass
    raw = lazy.LazyRows.raw

    def setUp(self):
        lazy.LazyRows.setUp(self)
        org = store.load_org(self.slug)
        org.nodes['n1']['state'] = 'live'
        org.nodes['n1']['model'] = 'opus'
        org.nodes['n2']['state'] = 'archived'
        org.nodes['n2']['model'] = 'luna'
        org.d['documents'] = [
            doc('d1', 'n1', '2026-09-01T00:00:00.000Z'),
            doc('d2', 'n2', '2026-09-02T00:00:00.000Z', format='html', body='', file='outbox/x.html',
                bytes=1234),
            doc('d3', 'gone-node', '2026-09-03T00:00:00.000Z'),          # deleted presenter
            doc('d4', 'n3', '2026-09-05T00:00:00.000Z', body='mentions d1 and d9 in its text'),
            doc('d1', 'n3', '2026-09-06T00:00:00.000Z', title='duplicate id'),   # first one wins
            doc('d5', 'n1', '2026-09-07T00:00:00.000Z'),
        ]
        events = list(org.d.get('events') or [])
        events += [{'op': 'mail', 'actor': 'n1', 'at': '2026-09-01T00:00:00.000Z',
                    'detail': {'gist': 'present_evicted is only a word here'}}] * 3
        events += [
            evicted('d9', 'n2', '2026-09-04T00:00:00.000Z', format='html'),
            evicted('d4', 'n1', '2026-09-04T12:00:00.000Z'),              # still listed: skipped
            evicted('d8', 'n1', '2026-09-05T00:00:00.000Z'),              # same `at` as d4
            evicted('d7', 'nobody', '2026-09-07T00:00:00.000Z'),          # same `at` as d5
        ]
        org.d['events'] = events
        store.save_org(org)

    def whole(self):
        return store.load_org(self.slug).document_gallery()

    def bounded(self):
        return store.read_document_gallery(self.slug)

    def test_list_equals_the_whole_org_projection(self):
        rows = self.bounded()
        self.assertEqual(rows, self.whole())
        by_id = {r['id']: r for r in rows}
        # the control: the fixture exercises every branch it claims to
        self.assertEqual(by_id['d3']['node_state'], 'deleted')
        self.assertIsNone(by_id['d3']['tier'])
        self.assertEqual(by_id['d2']['bytes'], 1234)
        self.assertEqual(by_id['d1']['title'], 'title d1')
        self.assertTrue(by_id['d9']['evicted'])
        self.assertEqual(by_id['d9']['format'], 'html')
        self.assertFalse(by_id['d4']['evicted'])
        self.assertEqual(by_id['d7']['node_state'], 'deleted')

    def test_ties_between_a_card_and_an_eviction_keep_their_order(self):
        """Equal `at` is broken by position: a card's index in `documents`
        against an eviction's index in `events`. Both orders are exercised."""
        rows = self.bounded()
        order = [r['id'] for r in rows]
        self.assertEqual(order, [r['id'] for r in self.whole()])
        org = store.load_org(self.slug)
        events = list(org.d['events'])
        # move the evictions to the front of the events list: their positions
        # drop below the tied cards' document indexes, which flips the ties
        head = [e for e in events if e.get('op') == 'present_evicted']
        org.d['events'] = head + [e for e in events if e.get('op') != 'present_evicted']
        store.save_org(org)
        flipped = [r['id'] for r in self.bounded()]
        self.assertEqual(flipped, [r['id'] for r in self.whole()])
        self.assertNotEqual(flipped, order)

    def test_list_reads_rows_not_the_org(self):
        with patch.object(store, 'load_org', side_effect=AssertionError('whole-org load')):
            rows = self.bounded()
            out = api.documents_list(self.slug, 0, 100)
            only = api.documents_list(self.slug, 0, 100, node='n1')
        self.assertEqual(len(out['documents']), len(rows))
        self.assertEqual({r['node'] for r in only['documents']}, {'n1'})

    def test_document_body_equals_the_whole_org_read(self):
        for did in ('d1', 'd2', 'd3', 'd4', 'd5'):
            fast = api.document_get(self.slug, did)
            with patch.object(store, 'read_document', return_value=store.DOCUMENT_READ_FALLBACK):
                slow = api.document_get(self.slug, did)
            self.assertEqual(fast, slow, did)
        self.assertEqual(api.document_get(self.slug, 'd1')['title'], 'title d1')
        self.assertEqual(api.document_get(self.slug, 'd3')['node_state'], 'deleted')
        self.assertEqual(api.document_get(self.slug, 'd1')['tier'], None)   # route reads `tier`

    def test_document_body_reads_rows_not_the_org(self):
        with patch.object(store, 'load_org', side_effect=AssertionError('whole-org load')):
            self.assertEqual(api.document_get(self.slug, 'd4')['body'],
                             'mentions d1 and d9 in its text')

    def test_missing_document_is_404_even_when_its_id_is_in_another_body(self):
        for did in ('d9', 'nope'):
            with self.assertRaises(HTTPException) as fast:
                api.document_get(self.slug, did)
            with patch.object(store, 'read_document', return_value=store.DOCUMENT_READ_FALLBACK):
                with self.assertRaises(HTTPException) as slow:
                    api.document_get(self.slug, did)
            self.assertEqual((fast.exception.status_code, fast.exception.detail),
                             (slow.exception.status_code, slow.exception.detail))
            self.assertEqual(fast.exception.status_code, 404)

    def test_a_pinned_transaction_uses_the_whole_org_path(self):
        with orgtx.org_tx(self.slug, logs=['documents']) as tx:
            tx.org.d['documents'].append(doc('d6', 'n1', '2026-09-08T00:00:00.000Z'))
            self.assertIs(store.read_document(self.slug, 'd6'), store.DOCUMENT_READ_FALLBACK)
            self.assertIsNone(store._pg_document_gallery(self.slug))
        self.assertEqual(self.bounded()[0]['id'], 'd6')
        self.assertEqual(self.bounded(), self.whole())

    def test_a_section_held_as_a_blob_uses_the_whole_org_path(self):
        blob = [evicted('d10', 'n1', '2026-09-09T00:00:00.000Z')]
        with self.raw() as raw:
            raw.execute("INSERT INTO doc(key, val) VALUES ('events', %s)", (json.dumps(blob),))
        self.assertIsNone(store._pg_document_gallery(self.slug))
        self.assertIs(store.read_document(self.slug, 'd1'), store.DOCUMENT_READ_FALLBACK)
        rows = self.bounded()
        self.assertEqual(rows, self.whole())
        self.assertIn('d10', {r['id'] for r in rows})

    # -- the first open (v3-presentations-window-still-takes-0-5-s-to-ope) --
    # A cold first open waited 748 ms on one statement: the text search for
    # `present_evicted` over every events row. pg_migrations/0019 indexes
    # exactly those rows, and the position walk runs only for a tie.

    def statements(self, fn):
        seen = []
        real = pgstore.PgConn.execute

        def spy(conn, sql, params=()):
            seen.append(sql)
            return real(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', spy):
            out = fn()
        return out, seen

    def test_the_eviction_search_is_served_by_the_partial_index(self):
        _, seen = self.statements(self.bounded)
        search = [s for s in seen if 'present_evicted' in s]
        self.assertEqual(len(search), 1, seen)
        with self.raw() as raw:
            indexdef = raw.execute(
                "SELECT indexdef FROM pg_indexes WHERE schemaname=%s AND indexname="
                "'ix_log_l_present_evicted'", (f'org_{self.oid}',)).fetchone()
            self.assertIsNotNone(indexdef, 'a new org gets the index (create_org_schema)')
            # a planner that may not scan the table must still answer: only
            # possible when the query implies the index's WHERE clause
            raw.execute('SET LOCAL enable_seqscan = off')
            raw.execute('SET LOCAL enable_bitmapscan = off')
            plan = '\n'.join(r[0] for r in raw.execute('EXPLAIN ' + search[0]).fetchall())
        self.assertIn('ix_log_l_present_evicted', plan)

    def test_the_migration_indexes_an_org_that_already_exists(self):
        with self.raw() as raw:
            raw.execute('DROP INDEX ix_log_l_present_evicted')
        with pgstore.connect() as raw:
            raw.execute('SELECT public.orgtree_install_present_evicted(%s)', (self.oid,))
            self.assertIsNotNone(raw.execute(
                "SELECT 1 FROM pg_indexes WHERE schemaname=%s AND indexname="
                "'ix_log_l_present_evicted'", (f'org_{self.oid}',)).fetchone())

    def test_no_tie_skips_the_walk_over_the_events(self):
        org = store.load_org(self.slug)
        # two evictions tied with EACH OTHER (seq orders them like position
        # does), none tied with a card
        org.d['events'] = [e for e in org.d['events'] if e.get('op') != 'present_evicted'] + [
            evicted('d9', 'n2', '2026-09-04T00:00:00.000Z'),
            evicted('d8', 'n1', '2026-09-04T00:00:00.000Z'),
            evicted('d7', 'n1', '2026-09-06T12:00:00.000Z')]
        store.save_org(org)
        rows, seen = self.statements(self.bounded)
        self.assertEqual(rows, self.whole())
        self.assertEqual([r['id'] for r in rows if r['evicted']], ['d7', 'd8', 'd9'])
        self.assertFalse([s for s in seen if 'row_number' in s], seen)

    def test_a_tie_with_a_card_still_walks_for_the_position(self):
        # the setUp fixture ties d8 with d4 and d7 with d5
        rows, seen = self.statements(self.bounded)
        self.assertEqual(rows, self.whole())
        self.assertEqual(len([s for s in seen if 'row_number' in s]), 1, seen)

    def test_an_org_without_documents(self):
        org = store.load_org(self.slug)
        org.d['documents'] = []
        org.d['events'] = [e for e in org.d['events'] if e.get('op') != 'present_evicted']
        store.save_org(org)
        self.assertEqual(self.bounded(), [])
        self.assertEqual(self.whole(), [])
        self.assertIsNone(store.read_document(self.slug, 'd1'))


if __name__ == '__main__':
    unittest.main()
