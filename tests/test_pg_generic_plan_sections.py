"""Section reads of log_d / log_l keep their index under a GENERIC plan.

N1000 attempt 5 (2026-09-28): getting the active agents ready took 1552 s
instead of 88 s. psycopg prepares a statement on its 5th run. PostgreSQL may
then plan it once for any parameter, and with a few sections of very
different sizes the generic estimate for `sect=$1` is "a large share of the
table". The load's presence probe, and the other section reads, then
sequential-scanned or primary-key-walked the whole of log_d (0.9 GB here, and
growing with turn history) for every empty or small section.

Real PostgreSQL (disposable, via test_pgstore). One org's log tables are
seeded with a few big sections and a few tiny ones, then ANALYZEd. What this
proves:
  * NEGATIVE CONTROL: the old statement shapes DO read the whole table under
    `plan_cache_mode=force_generic_plan` on this seed. Without that, the
    checks below would prove nothing.
  * every statement the real store functions send for a section read
    (recorded at PgConn.execute, then EXPLAINed generically) reads log_d /
    log_l only through ix_log_d / ix_log_l: the load's presence probe,
    _log_has, whole dict and list section reads, list projection, the user
    inbox tail, and section drops;
  * the probes still give the right answers for present, tiny and absent
    sections.

Run:  python tools/run-python-verification.py tests/test_pg_generic_plan_sections.py
"""
import json
import re
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


BIG_D = {'steered_log': 12000, 'mail_log': 6000}
BIG_L = {'events': 12000, 'notice_log': 6000}
TINY_D, TINY_L = 'turn_error_log', 'lifecycle'
OLD_SHAPES = [
    ('SELECT 1 FROM log_d WHERE sect=? LIMIT 1', [TINY_D]),
    ('SELECT 1 WHERE EXISTS (SELECT 1 FROM log_d WHERE sect=?)', ['absent_section']),
    ('SELECT owner, seq, val FROM log_d WHERE sect=? ORDER BY seq', [TINY_D]),
    ('SELECT seq, val FROM log_l WHERE sect=? ORDER BY seq', [TINY_L]),
    ('DELETE FROM log_d WHERE sect=?', [TINY_D]),
]


def _dollars(sql):
    n = iter(range(1, 1000))
    return re.sub(r'%s', lambda _m: f'${next(n)}', sql)


def _full_reads(plan):
    """Scan nodes that read log_d/log_l other than through its sect index."""
    bad = []

    def walk(node, parent=None):
        rel, kind = node.get('Relation Name'), node.get('Node Type')
        if rel in ('log_d', 'log_l') and kind != 'ModifyTable':
            if kind == 'Seq Scan':
                bad.append(f'{kind} on {rel}')
            elif kind in ('Index Scan', 'Index Only Scan') and node.get('Index Name') != 'ix_' + rel:
                bad.append(f"{kind} on {rel} via {node.get('Index Name')}")
            elif kind == 'Bitmap Heap Scan':
                idx = [c.get('Index Name') for c in node.get('Plans', [])]
                if idx != ['ix_' + rel]:
                    bad.append(f'{kind} on {rel} via {idx}')
        for child in node.get('Plans', []):
            walk(child, node)
    walk(plan['Plan'])
    return bad


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class GenericPlanSections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()
        old = orgtx.use_backend(orgtx.PgBackend())
        cls.addClassCleanup(orgtx.use_backend, old)
        org = store.create_org('gplan-' + uuid.uuid4().hex[:10])
        cls.slug = org.d['slug']
        org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
        store.save_org(org)
        with pgstore.connect() as raw:
            cls.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                  (cls.slug,)).fetchone()[0]
            raw.execute(f'SET search_path TO org_{cls.oid},public')
            pad = 'x' * 300
            for sect, n in BIG_D.items():
                raw.execute("INSERT INTO log_d(sect, owner, at, val) SELECT %s, 'o' || (g %% 97), "
                            "NULL, json_build_object('i', g, 'pad', %s::text)::text "
                            "FROM generate_series(1, %s::int) g", (sect, pad, n))
            raw.execute("INSERT INTO log_d(sect, owner, at, val) VALUES "
                        "(%s, 'a', NULL, '{\"i\": 1}'), (%s, 'a', NULL, '{\"i\": 2}')", (TINY_D, TINY_D))
            for sect, n in BIG_L.items():
                raw.execute("INSERT INTO log_l(sect, at, val) SELECT %s, NULL, "
                            "json_build_object('i', g, 'pad', %s::text)::text "
                            "FROM generate_series(1, %s::int) g", (sect, pad, n))
            raw.execute("INSERT INTO log_l(sect, at, val) VALUES (%s, NULL, '{\"i\": 1}')", (TINY_L,))
            raw.execute('ANALYZE log_d')
            raw.execute('ANALYZE log_l')

    def generic(self, sql, params):
        """The generic plan of `sql` (store `?` syntax), without executing it."""
        with pgstore.connect() as raw:
            raw.execute(f'SET search_path TO org_{self.oid},public')
            raw.execute('SET plan_cache_mode = force_generic_plan')
            raw.execute(f'PREPARE q AS {_dollars(pgstore.translate(sql).sql)}')
            args = ','.join(pgstore._psycopg().sql.quote(p) for p in params) if params else ''
            (plan,) = raw.execute(f'EXPLAIN (FORMAT JSON) EXECUTE q({args})' if args
                                  else 'EXPLAIN (FORMAT JSON) EXECUTE q').fetchone()
            raw.execute('DEALLOCATE q')
        plan = plan if isinstance(plan, list) else json.loads(plan)
        return plan[0]

    def test_negative_control_old_shapes_read_the_whole_table(self):
        for sql, params in OLD_SHAPES:
            with self.subTest(sql=sql):
                self.assertTrue(_full_reads(self.generic(sql, params)),
                                'the seed is too small or too even to catch a generic seq scan')

    def record(self, fn):
        seen = []
        real = pgstore.PgConn.execute

        def spy(conn, sql, params=()):
            seen.append((sql, tuple(params)))
            return real(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', spy):
            fn()
        return [(s, p) for s, p in seen
                if re.search(r'\blog_[dl]\b', s) and 'sect' in s and not s.lstrip().upper().startswith('INSERT')]

    def check(self, statements, expect_at_least):
        self.assertGreaterEqual(len(statements), expect_at_least, statements)
        for sql, params in statements:
            with self.subTest(sql=sql):
                self.assertEqual(_full_reads(self.generic(sql, list(params))), [])

    def test_load_presence_probe(self):
        def run():
            with store._POOL.acquire(self.slug) as conn:
                conn.execute('BEGIN')
                try:
                    present = store._load_probes(conn)[2]
                finally:
                    conn.execute('ROLLBACK')
            self.assertTrue({'steered_log', 'mail_log', TINY_D, 'events', 'notice_log', TINY_L} <= present)
            self.assertNotIn('steer_attempts', present)
        self.check(self.record(run), 1)

    def test_log_has(self):
        def run():
            with store._POOL.acquire(self.slug) as conn:
                self.assertTrue(store._log_has(conn, 'log_d', TINY_D))
                self.assertTrue(store._log_has(conn, 'log_l', TINY_L))
                self.assertTrue(store._log_has(conn, 'log_d', 'steered_log'))
                self.assertFalse(store._log_has(conn, 'log_d', 'steer_attempts'))
                # a name sorting between two present sections, and after all of them
                self.assertFalse(store._log_has(conn, 'log_d', 'n'))
                self.assertFalse(store._log_has(conn, 'log_l', 'zzz'))
        self.check(self.record(run), 6)

    def test_whole_section_reads(self):
        def run():
            with store._POOL.acquire(self.slug) as conn:
                snaps, _ = store._read_dict_log(conn, TINY_D, self.slug)
                self.assertEqual(sum(len(v) for v in snaps.values()), 2)
                rows, _ = store._read_list_log(conn, TINY_L)
                self.assertEqual(len(rows), 1)
            org = store.load_org(self.slug)
            self.assertEqual(len(org.d.project(TINY_L, ('i', 'j'))), 1)
            self.assertEqual(len(dict(org.d[TINY_D])['a']), 2)
        self.check(self.record(run), 3)

    def test_user_inbox_tail(self):
        with pgstore.connect() as raw:
            raw.execute(f'SET search_path TO org_{self.oid},public')
            raw.execute("INSERT INTO log_l(sect, at, val) VALUES ('user_mail_log', NULL, '{\"id\": \"u1\"}')")
        self.addCleanup(self._drop_user_mail)
        def run():
            self.assertEqual([m.get('id') for m in store.read_user_inbox(self.slug)['delivered']], ['u1'])
        self.check(self.record(run), 1)

    def _drop_user_mail(self):
        with pgstore.connect() as raw:
            raw.execute(f"DELETE FROM org_{self.oid}.log_l WHERE sect='user_mail_log'")

    def test_foreground_context_list_rows(self):
        from orgtree import foreground_context
        sql = foreground_context._LIST_ROWS_SQL.replace('%s', '?')
        self.assertEqual(_full_reads(self.generic(sql, [TINY_L, TINY_L])), [])

    def test_section_drop(self):
        def run():
            with store._POOL.acquire(self.slug) as conn:
                conn.execute('BEGIN')
                try:
                    store._drop_lazy_rows(conn, TINY_D)
                    store._drop_lazy_rows(conn, TINY_L)
                    self.assertFalse(store._log_has(conn, 'log_d', TINY_D))
                    # only that section: its neighbours in index order survive
                    self.assertTrue(store._log_has(conn, 'log_d', 'steered_log'))
                    self.assertTrue(store._log_has(conn, 'log_d', 'mail_log'))
                    self.assertTrue(store._log_has(conn, 'log_l', 'events'))
                    self.assertTrue(store._log_has(conn, 'log_l', 'notice_log'))
                finally:
                    conn.execute('ROLLBACK')
        self.check(self.record(run), 3)


if __name__ == '__main__':
    unittest.main()
