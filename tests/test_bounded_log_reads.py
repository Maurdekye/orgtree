"""The bounded log-tail readers answer exactly what materializing answered.

perf-redesign 2026-09-12 (REPORT.md #4/#5/#6): /events, /nodes/{nid}/history
and /nodes/{nid}/inbox used to materialize whole unbounded sections per poll.
These tests pin the SQL readers to the materialized truth on the same org —
same rows, same order, same totals — and pin the fallback contract (None)
for the shapes the cheap path must not answer.
"""
import os
import sys
from pathlib import Path
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='v2-bounded-reads-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
os.environ.pop('ORGTREE_AGENT_PARENT_DATA', None)
os.environ.pop('ORGTREE_AGENT_LEGACY_DATA', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, store   # noqa: E402


def _fixture(slug='bounded'):
    org = store.create_org(slug.capitalize())
    org.d['slug'] = slug
    org.hire(ledger.USER, None, 'haiku', 0, 'alpha')
    org.hire(ledger.USER, None, 'haiku', 0, 'beta')
    for i in range(40):
        actor = 'alpha' if i % 3 == 0 else 'beta' if i % 3 == 1 else ledger.USER
        store.log_append(org.d, 'events', {
            'op': 'mail', 'actor': actor, 'at': f'2026-09-01T00:00:{i:02d}.000Z',
            'detail': {'to': 'alpha' if i % 2 else 'beta', 'kind': 'message',
                       'gist': f'row {i}'}, 'warnings': []})
    for i in range(25):
        store.log_append(org.d, 'notice_log', {
            'node': 'alpha' if i % 2 else 'beta',
            'at': f'2026-09-01T01:00:{i:02d}.000Z', 'text': f'notice {i}'})
    for i in range(30):
        org.post_mail('alpha' if i % 2 else 'beta',
                      'beta' if i % 2 else 'alpha', f'mail body {i}')
    org.post_mail('alpha', ledger.USER, 'to the user')
    store.save_org(org)
    return org


class BoundedLogReads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.org = _fixture()

    def test_events_page_matches_materialized(self):
        fresh = store.load_org('bounded')
        ev = list(fresh.d['events'])
        page = store.read_events_page('bounded', since=0)
        if store.STORE_BACKEND != 'sqlite':
            self.assertIsNone(page)
            return
        total, rows = page
        self.assertEqual(total, len(ev))
        self.assertEqual(rows, ev)
        total2, tail = store.read_events_page('bounded', last=7)
        self.assertEqual(total2, len(ev))
        self.assertEqual(tail, ev[-7:])
        total3, sliced = store.read_events_page('bounded', since=11)
        self.assertEqual(sliced, ev[11:])
        self.assertEqual(total3 - len(sliced), 11)

    def test_node_history_rows_match_python_filter(self):
        if store.STORE_BACKEND != 'sqlite':
            self.skipTest('sqlite reader only')
        fresh = store.load_org('bounded')
        for nid in ('alpha', 'beta'):
            want_ev = [e for e in fresh.d['events']
                       if (lambda det: det.get('node') == nid
                           or det.get('to') == nid or e.get('actor') == nid
                           or det.get('grantee') == nid
                           or det.get('from') == nid)(e.get('detail', {}))]
            want_nl = [n for n in fresh.d['notice_log'] if n['node'] == nid]
            got = store.read_node_history_rows('bounded', nid, 1000)
            self.assertIsNotNone(got)
            got_ev, got_nl = got
            self.assertEqual(got_ev, want_ev)
            self.assertEqual(got_nl, want_nl)
            capped = store.read_node_history_rows('bounded', nid, 5)
            self.assertEqual(capped[0], want_ev[-5:])
            self.assertEqual(capped[1], want_nl[-5:])

    def test_mail_tails_match_full_scan(self):
        if store.STORE_BACKEND != 'sqlite':
            self.skipTest('sqlite reader only')
        fresh = store.load_org('bounded')
        nid = 'alpha'
        want_delivered = list((fresh.d.get('mail_log') or {}).get(nid, []))
        want_sent = []
        for to, lst in (fresh.d.get('mail_log') or {}).items():
            want_sent += [{**m, 'to': to} for m in lst if m['from'] == nid]
        for m in (fresh.d.get('user_inbox', [])
                  + fresh.d.get('user_mail_log', [])):
            if m['from'] == nid:
                want_sent.append({**m, 'to': ledger.USER})
        want_sent.sort(key=lambda m: m['at'])
        got = store.read_mail_tails('bounded', nid, keep=50)
        self.assertIsNotNone(got)
        delivered, sent = got
        self.assertEqual(delivered, want_delivered[-90:])
        self.assertEqual(sent, want_sent[-90:])

    def test_node_row_exists(self):
        if store.STORE_BACKEND != 'sqlite':
            self.skipTest('sqlite reader only')
        self.assertTrue(store.node_row_exists('bounded', 'alpha'))
        self.assertFalse(store.node_row_exists('bounded', 'nobody'))
        with self.assertRaises(ledger.LedgerError):
            store.node_row_exists('missing-org', 'alpha')


if __name__ == '__main__':
    unittest.main()
