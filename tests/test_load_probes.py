"""S-A (pg-per-call-cost-find-where-postgresql-time-goes): an org load's
existence probes are a constant number of statements.

`store._load_lazy` used to run, per load, one `log_d` probe plus one owners
meta read per dict log, one `log_l` probe per list log, and two more meta
reads (about 35 statements; each a round trip on PostgreSQL). Now: one meta
`IN (...)` read and one UNION ALL presence read.

  * a plain load runs exactly 4 statements inside its BEGIN..COMMIT (meta,
    presence, doc, nodes), however many log sections are present;
  * `_load_probes` answers exactly what the per-section probes answered
    (the old algorithm is re-implemented here) across fixtures: no logs,
    list and dict rows, an owners meta row without rows; and a loaded
    document still has its sections;
  * the probe does not fetch the owners lists' values (N-sized), only
    their presence.

Run:  python tools/run-python-verification.py tests/test_load_probes.py
"""
import os
from pathlib import Path
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-load-probes-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store  # noqa: E402


def _old_probes(conn):
    """The per-section probes as they were before S-A (store.py at 1a8432f)."""
    raw_order = store._meta_get(conn, store._META_KEY_ORDER)
    schema_version = store._meta_get(conn, 'schema_version')
    present = set()
    for sect in store.DICT_LOGS:
        if conn.execute('SELECT 1 FROM log_d WHERE sect=? LIMIT 1', (sect,)).fetchone() \
                or store._meta_get(conn, store._META_OWNERS + sect) is not None:
            present.add(sect)
    for sect in store.LIST_LOGS:
        if conn.execute('SELECT 1 FROM log_l WHERE sect=? LIMIT 1', (sect,)).fetchone():
            present.add(sect)
    return raw_order, schema_version, present


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


class LoadProbes(unittest.TestCase):
    def setUp(self) -> None:
        self.slug = _fresh_org(f'probes-{self._testMethodName}'[:58].replace('_', '-'))

    def _both(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            try:
                new = store._load_probes(conn)
                # the 4th field is the custody receipt-rows marker (absent here)
                self.assertIs(new[3], False)
                return new[:3], _old_probes(conn)
            finally:
                conn.execute('ROLLBACK')

    def _statements(self) -> list[str]:
        seen: list[str] = []
        with store._POOL.acquire(self.slug) as conn:
            conn.set_trace_callback(seen.append)
            try:
                store._load_lazy(conn, self.slug)
            finally:
                conn.set_trace_callback(None)
        return [s for s in seen if s.strip().upper() not in ('BEGIN', 'COMMIT')]

    def _fill_logs(self) -> None:
        org = store.load_org(self.slug)
        org.d.setdefault('events', []).append({'id': 'e1', 'kind': 'x'})
        org.d.setdefault('notice_log', []).append({'id': 'n1'})
        org.d.setdefault('mail_log', {})['a'] = [{'id': 'm1'}]
        store.save_org(org)

    def test_a_load_is_four_statements(self) -> None:
        empty = self._statements()
        self.assertEqual(len(empty), 4, empty)
        self._fill_logs()
        full = self._statements()
        self.assertEqual(len(full), 4, full)       # independent of what is present

    def test_same_answer_with_no_logs(self) -> None:
        new, old = self._both()
        self.assertEqual(new, old)
        self.assertIsNotNone(new[1])               # schema_version really read

    def test_same_answer_with_list_and_dict_rows(self) -> None:
        self._fill_logs()
        new, old = self._both()
        self.assertEqual(new, old)
        self.assertTrue({'events', 'notice_log', 'mail_log'} <= new[2], new[2])

    def test_an_owners_meta_row_alone_makes_a_dict_log_present(self) -> None:
        # (meta.val is NOT NULL, so a NULL owners value cannot exist)
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            store._meta_set(conn, store._META_OWNERS + 'steered_log', '[]')
            conn.execute('COMMIT')
        new, old = self._both()
        self.assertEqual(new, old)
        self.assertIn('steered_log', new[2])
        self.assertNotIn('turn_error_log', new[2])

    def test_the_owner_lists_are_not_fetched(self) -> None:
        # scale preflight N=100 -> 1000: every load read each dict log's
        # whole owner list (N names) only to learn that the row exists
        big = '[' + ','.join(f'"agent-{i:04d}"' for i in range(1000)) + ']'
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            for sect in store.DICT_LOGS:
                store._meta_set(conn, store._META_OWNERS + sect, big)
            conn.execute('COMMIT')
            conn.execute('BEGIN')
            try:
                rows = conn.execute(store._LOAD_META_SQL, store._LOAD_META_PARAMS).fetchall()
                probed = store._load_probes(conn)
                old = _old_probes(conn)
            finally:
                conn.execute('ROLLBACK')
        got = dict(rows)
        for sect in store.DICT_LOGS:
            self.assertEqual(got[store._META_OWNERS + sect], '', sect)
        self.assertIsNotNone(got['schema_version'])      # other values still read
        self.assertLess(sum(len(v or '') for v in got.values()), 2000)
        self.assertEqual(probed[:3], old)
        self.assertTrue(set(store.DICT_LOGS) <= probed[2])
        # the section itself still loads its owners, in order
        self.assertEqual(list(store.load_org(self.slug).d['mail_log'])[:2],
                         ['agent-0000', 'agent-0001'])

    def test_a_loaded_document_is_unchanged(self) -> None:
        self._fill_logs()
        org = store.load_org(self.slug)
        keys = list(org.d.keys())
        events = list(org.d['events'])
        mail = dict(org.d['mail_log'])
        self.assertEqual([e['id'] for e in events], ['e1'])
        self.assertEqual(list(mail), ['a'])
        self.assertIn('notice_log', keys)


if __name__ == '__main__':
    unittest.main()
