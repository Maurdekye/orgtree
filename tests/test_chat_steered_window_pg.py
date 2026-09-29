"""Windowed desk chat reads a bounded tail of steered_log on real PostgreSQL.

desk-chat-read-loads-the-agent-s-whole-steered-m: the windowed read must not
load an agent's whole lifetime steered log, and must return exactly what the
full read returns (rows, ids, seq, has_older, cursor).
"""
import json
import os
import unittest
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_chat_steered_t{os.getpid()}'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import test_chat_window as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

store, sup, chat_window = fixture.store, fixture.sup, fixture.chat_window


def stamp(minute, second):
    return f'2026-09-10T12:{minute:02d}:{second:02d}Z'


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class SteeredWindow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    setUp = fixture.WindowTests.setUp
    write = fixture.WindowTests.write
    rec = fixture.WindowTests.rec

    def steer(self, entries):
        org = store.load_org(self.org.d['slug'])
        log = org.d.setdefault('steered_log', {}).setdefault('agent', [])
        for at, text in entries:
            log.append({'at': at, 'text': text, 'level': 'steered',
                        'visible_id': 'steer:' + uuid.uuid4().hex})
        store.save_org(org)

    def fixture_rows(self, old_steers=0):
        """Transcript records one per 2 s, steers interleaved on odd seconds,
        plus `old_steers` steers before the whole transcript."""
        self.write([self.rec(2 * i) for i in range(30)])
        self.steer([(f'2026-09-10T11:{(k // 60) % 60:02d}:{k % 60:02d}Z', f'old steer {k}')
                    for k in range(old_steers)]
                   + [(stamp(0, 2 * i + 1), f'steer {i}') for i in range(0, 30, 3)])

    def errors(self, entries):
        org = store.load_org(self.org.d['slug'])
        log = org.d.setdefault('turn_error_log', {}).setdefault('agent', [])
        for at, text in entries:
            log.append({'at': at, 'text': text})
        store.save_org(org)

    def reads(self, want=8, sect='steered_log'):
        """(bounded read, fetched `sect` rows, full read) from fresh Orgs."""
        fetched = []
        original = store.log_owner_tail

        def counted(d, section, *a, **k):
            result = original(d, section, *a, **k)
            if section == sect:
                fetched.append(None if result is None else len(result[0]))
            return result
        slug = self.org.d['slug']
        with patch.object(store, 'log_owner_tail', side_effect=counted), \
             patch.object(store.SectionMap, '_load_owner', autospec=True,
                          side_effect=self.forbid_steered_owner_load):
            bounded = chat_window.read_window(store.load_org(slug), 'agent', want)
        with patch.object(store, 'log_owner_tail', return_value=None):
            full = chat_window.read_window(store.load_org(slug), 'agent', want)
        return bounded, fetched, full

    _load_owner = store.SectionMap._load_owner

    @staticmethod
    def forbid_steered_owner_load(self_map, owner):
        if self_map._sect in ('steered_log', 'turn_error_log'):
            raise AssertionError(f'the windowed read loaded the whole {self_map._sect} owner')
        return SteeredWindow._load_owner(self_map, owner)

    def comparable(self, out):
        return ([(m['role'], m['text'], m['event_id'], m['seq']) for m in out['messages']],
                out['has_older'], out['before'])

    def test_bounded_window_equals_the_full_read(self):
        self.fixture_rows()
        bounded, fetched, full = self.reads()
        self.assertEqual(self.comparable(bounded), self.comparable(full))
        self.assertTrue(any('steer' in m['text'] for m in bounded['messages']),
                        'control: steered rows interleave inside the window')
        self.assertTrue(bounded['has_older'])
        self.assertEqual(len(fetched), 1)
        self.assertLessEqual(fetched[0], 8 + sup._STEERED_WINDOW_SLACK)
        self.assertNotIn('_synthetic_omitted', bounded)
        self.assertFalse(any(sup._WINDOW_FLOOR in m for m in bounded['messages']))

    def test_cost_does_not_grow_with_the_steered_log(self):
        """Rows RETURNED stay bounded; the server-side scan is pinned by
        test_server_reads_a_bounded_index_range_at_1x_and_10x."""
        self.fixture_rows(old_steers=300)
        bounded, fetched, full = self.reads()
        self.assertEqual(self.comparable(bounded), self.comparable(full))
        self.assertEqual(len(fetched), 1)
        self.assertLessEqual(fetched[0], 8 + sup._STEERED_WINDOW_SLACK,
                             '310 steered rows exist; the read fetches a bounded tail')
        self.assertEqual(len(full['messages']), 8)
        self.assertFalse(any(sup._WINDOW_FLOOR in m for m in bounded['messages']),
                         'the private floor marker never reaches a published row')

    def test_window_reaching_the_oldest_fetched_steer_falls_back_exactly(self):
        # every newest row is a steer and no slack: the floor lands inside the
        # window, so the bounded assembly must redo itself with the full log
        self.write([self.rec(2 * i) for i in range(4)])
        self.steer([(stamp(10, k), f'late steer {k}') for k in range(20)])
        with patch.object(sup, '_STEERED_WINDOW_SLACK', 0):
            calls = []
            original = sup._synthetic_chat_rows

            def full_rows(*a, **k):
                calls.append(1)
                return original(*a, **k)
            slug = self.org.d['slug']
            with patch.object(sup, '_synthetic_chat_rows', side_effect=full_rows):
                bounded = chat_window.read_window(store.load_org(slug), 'agent', 8)
            with patch.object(store, 'log_owner_tail', return_value=None):
                full = chat_window.read_window(store.load_org(slug), 'agent', 8)
        self.assertEqual(calls, [1], 'control: the guard really fell back')
        self.assertEqual(self.comparable(bounded), self.comparable(full))

    def test_resident_or_modified_owner_uses_the_full_path(self):
        self.fixture_rows()
        org = store.load_org(self.org.d['slug'])
        org.d['steered_log']['agent']            # now resident in this Org
        self.assertIsNone(store.log_owner_tail(org.d, 'steered_log', 'agent', 8))
        org = store.load_org(self.org.d['slug'])
        org.d['steered_log']['agent'] = []       # replaced, unsaved
        self.assertIsNone(store.log_owner_tail(org.d, 'steered_log', 'agent', 8))
        org = store.load_org(self.org.d['slug'])
        entries, older = store.log_owner_tail(org.d, 'steered_log', 'agent', 3)
        self.assertTrue(older)
        self.assertEqual([e['text'] for e in entries], ['steer 21', 'steer 24', 'steer 27'])
        org = store.load_org(self.org.d['slug'])
        entries, older = store.log_owner_tail(org.d, 'steered_log', 'agent', 10)
        self.assertFalse(older, 'exactly 10 steers: none older than the tail')
        self.assertEqual(len(entries), 10)

    def test_unsaved_appends_and_other_sections_use_the_full_path(self):
        self.fixture_rows()
        org = store.load_org(self.org.d['slug'])
        section = org.d.get('steered_log')
        self.assertIsInstance(section, store.SectionMap)
        section._appends['agent'] = [{'at': stamp(59, 59), 'text': 'unsaved', 'level': 'steered'}]
        self.assertIsNone(store.log_owner_tail(org.d, 'steered_log', 'agent', 8),
                          'a buffered, unsaved append is not in SQL yet')
        org = store.load_org(self.org.d['slug'])
        self.assertIsNone(store.log_owner_tail(org.d, 'mail_log', 'agent', 8),
                          'only sections with a tail index are served')
        self.assertIsNotNone(store.log_owner_tail(org.d, 'steered_log', 'agent', 8),
                             'control: the same fresh Org is served for steered_log')

    def test_out_of_order_at_equals_the_full_read(self):
        """transcript-db-review-astra's probe: steers appended LATER with OLDER
        timestamps must not displace the newest-by-time steers (the SQL ranks
        by `at`, then append order, like the merge)."""
        self.write([self.rec(2 * i) for i in range(30)])
        self.steer([(stamp(0, 2 * i + 1), f'recent steer {i}') for i in range(15, 30)])
        self.steer([(f'2026-09-10T11:{k // 60:02d}:{k % 60:02d}Z', f'late-appended old steer {k}')
                    for k in range(60)])
        bounded, fetched, full = self.reads()
        self.assertEqual(self.comparable(bounded), self.comparable(full))
        self.assertTrue(any('recent steer' in m['text'] for m in bounded['messages']), 'control')
        self.assertEqual(fetched[:1], [8 + sup._STEERED_FIRST_SLACK], 'bounded path really used')

    def plan_nodes(self, limit):
        """The executed plan of log_owner_tail's OWN statement and parameters."""
        slug = self.org.d['slug']
        captured = []
        original = store._bounded_read

        class Explaining:
            def __init__(self, conn):
                self.conn = conn

            def execute(self, sql, params=()):
                if sql == store._LOG_TAIL_SQL:
                    captured.append(self.conn.execute(
                        'EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, params).fetchall())
                return self.conn.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self.conn, name)

        def bounded(slug_, body):
            def wrapped(conn):
                conn.execute('ANALYZE log_d')   # production tables are auto-analyzed
                return body(Explaining(conn))
            return original(slug_, wrapped)
        org = store.load_org(slug)
        with patch.object(store, '_bounded_read', side_effect=bounded):
            entries, _ = store.log_owner_tail(org.d, 'steered_log', 'agent', limit)
        self.assertEqual(len(entries), limit, 'control: the real call ran')
        self.assertEqual(len(captured), 1, 'control: its statement was explained')
        plan = captured[0][0][0]
        plan = json.loads(plan) if isinstance(plan, str) else plan
        nodes = []

        def walk(node):
            nodes.append(node)
            for child in node.get('Plans', []):
                walk(child)
        walk(plan[0]['Plan'])
        return nodes

    def test_server_reads_a_bounded_index_range_at_1x_and_10x(self):
        limit = 8 + sup._STEERED_WINDOW_SLACK
        scanned = {}
        for old in (300, 3000):
            self.setUp()
            self.fixture_rows(old_steers=old)
            nodes = self.plan_nodes(limit)
            kinds = [n['Node Type'] for n in nodes]
            self.assertNotIn('Sort', kinds, kinds)
            self.assertNotIn('WindowAgg', kinds, kinds)
            self.assertNotIn('Seq Scan', kinds, kinds)
            scans = [n for n in nodes if n['Node Type'] in ('Index Scan', 'Index Only Scan')]
            self.assertEqual([n.get('Index Name') for n in scans], ['ix_log_d_steered_tail'], kinds)
            scanned[old] = scans[0]['Actual Rows']
            self.assertLessEqual(scanned[old], limit + 1)
        self.assertEqual(scanned[300], scanned[3000], f'rows scanned must be flat 1x vs 10x: {scanned}')

    def test_a_failed_small_slack_retries_with_the_full_slack_not_the_whole_log(self):
        # the first (small) attempt's floor lands in the window; the second,
        # with the full slack, clears it: two bounded reads, no whole-log read
        self.write([self.rec(2 * i) for i in range(4)])
        self.steer([(stamp(10, k), f'late steer {k}') for k in range(40)])
        calls = []
        original = sup._synthetic_chat_rows

        def full_rows(*a, **k):
            calls.append(1)
            return original(*a, **k)
        fetched = []
        tail = store.log_owner_tail

        def counted(d, section, *a, **k):
            result = tail(d, section, *a, **k)
            if section == 'steered_log':
                fetched.append(None if result is None else len(result[0]))
            return result
        slug = self.org.d['slug']
        with patch.object(sup, '_STEERED_FIRST_SLACK', 0), \
             patch.object(sup, '_synthetic_chat_rows', side_effect=full_rows), \
             patch.object(store, 'log_owner_tail', side_effect=counted):
            bounded = chat_window.read_window(store.load_org(slug), 'agent', 8)
        with patch.object(store, 'log_owner_tail', return_value=None):
            full = chat_window.read_window(store.load_org(slug), 'agent', 8)
        self.assertEqual(calls, [], 'no whole-log read')
        self.assertEqual(fetched, [8, 8 + sup._STEERED_WINDOW_SLACK])
        self.assertEqual(self.comparable(bounded), self.comparable(full))

    # ---- turn errors (N1000 read shortcuts): the same bounded tail ----------
    def test_turn_errors_are_a_bounded_tail_equal_to_the_full_read(self):
        self.fixture_rows()
        self.errors([(f'2026-09-10T10:{k // 60:02d}:{k % 60:02d}Z', f'old error {k}') for k in range(200)]
                  + [(stamp(0, 2 * i + 1), f'recent error {i}') for i in range(1, 30, 5)])
        bounded, fetched, full = self.reads(sect='turn_error_log')
        self.assertEqual(self.comparable(bounded), self.comparable(full))
        self.assertTrue(any('recent error' in m['text'] for m in bounded['messages']),
                        'control: turn errors interleave inside the window')
        self.assertEqual(len(fetched), 1)
        self.assertLessEqual(fetched[0], 8 + sup._STEERED_WINDOW_SLACK,
                             '206 turn errors exist; the read fetches a bounded tail')
        self.assertTrue(bounded['has_older'])
        self.assertFalse(any(sup._WINDOW_FLOOR in m for m in bounded['messages']))

    def test_window_reaching_the_oldest_fetched_turn_error_falls_back_exactly(self):
        self.write([self.rec(2 * i) for i in range(4)])
        self.errors([(stamp(10, k), f'late error {k}') for k in range(20)])
        with patch.object(sup, '_STEERED_WINDOW_SLACK', 0):
            calls = []
            original = sup._synthetic_chat_rows

            def full_rows(*a, **k):
                calls.append(1)
                return original(*a, **k)
            slug = self.org.d['slug']
            with patch.object(sup, '_synthetic_chat_rows', side_effect=full_rows):
                bounded = chat_window.read_window(store.load_org(slug), 'agent', 8)
            with patch.object(store, 'log_owner_tail', return_value=None):
                full = chat_window.read_window(store.load_org(slug), 'agent', 8)
        self.assertEqual(calls, [1], 'control: the guard really fell back')
        self.assertEqual(self.comparable(bounded), self.comparable(full))

    def test_both_logs_truncated_need_both_floors_below_the_window(self):
        # Old steers and old errors, newest rows alternating between the two
        # logs: each truncated log's floor is checked on its own.
        self.write([self.rec(2 * i) for i in range(30)])
        self.steer([(f'2026-09-10T11:{k // 60:02d}:{k % 60:02d}Z', f'old steer {k}') for k in range(50)]
                   + [(stamp(0, 4 * i + 1), f'steer {i}') for i in range(15)])
        self.errors([(f'2026-09-10T10:{k // 60:02d}:{k % 60:02d}Z', f'old error {k}') for k in range(50)]
                  + [(stamp(0, 4 * i + 3), f'error {i}') for i in range(15)])
        for slack in (0, 2, sup._STEERED_WINDOW_SLACK):
            with patch.object(sup, '_STEERED_WINDOW_SLACK', slack):
                bounded, _, full = self.reads()
            self.assertEqual(self.comparable(bounded), self.comparable(full), slack)
            self.assertTrue(any('error' in m['text'] for m in bounded['messages']), 'control')
            self.assertTrue(any('steer' in m['text'] for m in bounded['messages']), 'control')

    def test_turn_error_tail_orders_by_at_then_append_like_the_merge(self):
        self.write([self.rec(2 * i) for i in range(30)])
        self.errors([(stamp(0, 2 * i + 1), f'recent error {i}') for i in range(15, 30)])
        self.errors([(f'2026-09-10T11:{k // 60:02d}:{k % 60:02d}Z', f'late-appended old error {k}')
                   for k in range(60)] + [(None, 'no timestamp')])
        bounded, fetched, full = self.reads(sect='turn_error_log')
        self.assertEqual(self.comparable(bounded), self.comparable(full))
        self.assertTrue(any('recent error' in m['text'] for m in bounded['messages']), 'control')
        self.assertEqual(fetched[:1], [8 + sup._STEERED_FIRST_SLACK], 'bounded path really used')

    def test_older_page_from_the_bounded_cursor_is_unchanged(self):
        self.fixture_rows(old_steers=40)
        bounded, _, full = self.reads()
        self.assertEqual(bounded['before'], full['before'])
        slug = self.org.d['slug']
        page = chat_window.read_page(store.load_org(slug), 'agent', 8, bounded['before'])
        self.assertTrue(page['messages'], 'control: the older page has rows')


def tearDownModule():
    fixture.tearDownModule()
    if ADMIN:
        from orgtree import pgstore
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
