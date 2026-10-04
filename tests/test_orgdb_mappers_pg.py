"""The section mappers through a real org database (design §5.2 steps 1–6).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module creates is named with
                               its own prefix t<pid>_ and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves: test_orgdb_mappers' synthetic document, encoded, written by COPY as the RUNTIME
role into a staging database the lifecycle built (so the generated schema applies through the
org migrations), reads back and decodes equal as canonical JSON, with its key order. After
mark_filled the identity sequences continue past the converter's ids, so the runtime's next
insert does not collide; the build then publishes.

Run:  python tools/run-python-verification.py tests/test_orgdb_mappers_pg.py
"""

import copy
import os
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.orgdb import conn, lifecycle, mappers, sections  # noqa: E402
from orgtree.orgdb.convert import rowio  # noqa: E402
from test_orgdb_mappers import canon, document  # noqa: E402


def _drop_all() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class ThroughAnOrgDatabase(unittest.TestCase):
    def test_document_round_trips_and_publishes(self) -> None:
        _drop_all()
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX,
                                 build='test')
        lc.bootstrap()
        org_id = lc.register_org('acme', state='converting')
        build = lc.open_build(org_id, 'convert')
        doc = document()
        rows, _, _ = sections.encode_document(copy.deepcopy(doc), mappers.sections(),
                                              ignored=mappers.ignored_keys())
        with conn.connect(RUNTIME, build.database, autocommit=False) as c:
            counts = rowio.write(c, rows)
            c.commit()
        self.assertEqual(counts['agents'], 6)  # 3 nodes, 2 name owners, 1 stale identity
        with conn.connect(RUNTIME, build.database) as c:
            stamped = c.execute("SELECT id FROM orgtree.agents WHERE name='x' AND tombstone "
                                "AND state='deleted' AND lineage_born='b' AND generation=0").fetchone()
            self.assertIsNotNone(stamped)
            self.assertEqual(c.execute("SELECT owner_agent_id FROM orgtree.work_items "
                                       "WHERE slug='a-thing'").fetchone()[0], stamped[0])
        with conn.connect(RUNTIME, build.database) as c:
            back = sections.decode_document(rowio.read(c), mappers.sections(), sections.Context())
        want = {k: v for k, v in doc.items() if k not in mappers.ignored_keys()}
        self.assertEqual(canon(back), canon(want))
        self.assertEqual(list(back), list(want))
        lc.mark_filled(build)
        final = lc.publish(build)
        with conn.connect(RUNTIME, final) as c:
            new_id = c.execute("INSERT INTO agents (name, tombstone) VALUES ('fresh', false) "
                               "RETURNING id").fetchone()[0]
            self.assertEqual(new_id, counts['agents'] + 1)
            self.assertEqual(c.execute('SELECT count(*) FROM work_items').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
