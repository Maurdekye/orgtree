"""The exact codec through real PostgreSQL columns (design §3.0).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL  a superuser URL; this module creates and drops
                             its own database t<pid>_codec
Without the URL every test SKIPS: a skip is not a pass.

What it proves: the tables codec.ddl() generates accept what codec.encode()
writes through COPY, and every record of test_orgdb_codec's cases reads back
equal as canonical JSON: numeric scale (1e20, 5e-324, the largest double),
timestamptz in microseconds with the original text, U+0000 inside json,
char(1) presence states, null flags, flattened objects and nested child
tables in position order.

Run:  python tools/run-python-verification.py tests/test_orgdb_codec_pg.py
"""

import os
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DB = f't{os.getpid()}_codec'

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, conn  # noqa: E402
from test_orgdb_codec import KEYS, LINK, RECORD, canon  # noqa: E402

CASES = [
    {},
    {'name': 'x', 'charter': 'c', 'grant': 5, 'ui_order': 1.5, 'turn_seq': 3, 'primary': True,
     'created': '2026-10-02T15:48:00.123Z', 'envelope': {'a': [1, None], 'nul': 'c\x00d'},
     'scope': {'mode': 'm', 'effort': 'high', 'dirs': ['a', 'b'], 'inner': {'x': 1}},
     'turns': [{'n': 1, 'at': '2026-10-02T15:48:00.123Z', 'cost': 0.25, 'tools': ['t']},
               {'n': 2, 'cost': 3, 'tools': []}],
     'stamps': ['2026-10-02T15:48:00Z', '2026-10-02T15:48:00.000Z']},
    {'charter': None, 'name': None, 'envelope': None, 'scope': None, 'turns': None,
     'stamps': None},
    {'name': 7, 'grant': '5', 'ui_order': 2, 'turn_seq': True, 'primary': 1,
     'created': 1700000000.5, 'charter': ['x'], 'scope': ['l'], 'turns': {'d': 1}, 'stamps': 'x'},
    {'name': 'a\x00b', 'turns': [{'tools': ['ok', 'b\x00d']}]},
    {'name': 'a\ud800b', 'charter': '\U0001f600', 'envelope': {'cut': 'c\udc00d'},
     'turns': [{'tools': ['ok', 'b\ud83d']}]},
    {'scope': {'mode': 1, 'surprise': {'k': 'v'}, 'effort': None, 'inner': 'flat', 'dirs': [1]}},
    {'scope': {'inner': {'x': 1, 'y': 2}}, 'mystery': {'deep': [1, {'a': None}]}},
    {'turns': [{}, {'n': 1, 'extra_key': [1]}], 'stamps': []},
    {'created': '2026-10-02T15:48:00.123456+00:00'},
    {'created': '2026-10-02T17:48:00.123+02:00'},
    {'created': '1969-07-20T20:17:40.000Z'},
    {'created': '2026-10-02T15:48:00.1234567Z'},
] + [{'grant': v} for v in (0, -3, 2 ** 70, 5.0, 1e20, 1e-7, 5e-324, 123.456, 0.1, -1.5,
                            1.7976931348623157e308, -0.0)] + [{'ui_order': -0.0}, {'turn_seq': 2 ** 63}]


def setUpModule() -> None:
    if not ADMIN:
        return
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(DB)))
        c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))


def tearDownModule() -> None:
    if not ADMIN:
        return
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(DB)))


@unittest.skipUnless(ADMIN, 'needs ORGTREE_TEST_PG_ADMIN_URL')
class ThroughPostgres(unittest.TestCase):
    def test_every_case_reads_back_equal(self) -> None:
        from psycopg.rows import dict_row
        lay = codec.layout(RECORD, KEYS, LINK)
        out: codec.Rows = {}
        for i, record in enumerate(CASES, start=1):
            codec.encode(RECORD, record, {'id': i}, out, link=LINK)
        with conn.connect(ADMIN, DB) as c:
            c.execute('CREATE SCHEMA orgtree')
            for stmt in codec.ddl(RECORD, KEYS, link=LINK, record_columns=('id bigint PRIMARY KEY',)):
                c.execute(stmt)
            for table, t in lay.items():
                cols = [k for k, _ in t['keys']] + [k for k, _ in t['columns']]
                cols += ['extra'] if t['extra'] else []
                with c.cursor().copy(f"COPY orgtree.{table} ({codec.quoted(cols)}) FROM STDIN") as cp:
                    for row in out.get(table, []):
                        self.assertEqual(set(row), set(cols), table)
                        cp.write_row([row[k] for k in cols])
            back = {}
            with c.cursor(row_factory=dict_row) as cur:
                for table in lay:
                    back[table] = cur.execute(f'SELECT * FROM orgtree.{table}').fetchall()
        children = codec.Children({t: rows for t, rows in back.items() if t != RECORD.table}, lay)
        rows = {r['id']: r for r in back[RECORD.table]}
        self.assertEqual(len(rows), len(CASES))
        for i, record in enumerate(CASES, start=1):
            with self.subTest(case=i, record=record):
                got = codec.decode(RECORD, rows[i], children, (i,))
                self.assertEqual(canon(got), canon(record))


if __name__ == '__main__':
    unittest.main()
