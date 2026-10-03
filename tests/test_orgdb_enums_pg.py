"""Every enum CHECK refuses a native bad value; converted misfits remain exact.

Run only against an OWN disposable PostgreSQL cluster, under the P03 lock.
Each method creates an org database and drops it, along with its app database.
"""

import json
import os
import unittest

import import_provenance  # noqa: F401

from orgtree.orgdb import codec, conn, enums, lifecycle, sections
from orgtree.orgdb.convert import rowio
from test_orgdb_enums import entries, fixture

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_enums_'


def drop_all():
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute('SELECT datname FROM pg_database WHERE starts_with(datname, %s)',
                               (PREFIX,)).fetchall():
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))


@unittest.skipUnless(ADMIN and RUNTIME, 'needs own disposable PostgreSQL URLs')
class EnumConstraints(unittest.TestCase):
    def setUp(self):
        drop_all()
        self.addCleanup(drop_all)
        self.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME),
                                      prefix=PREFIX, build='enum-test')
        self.lc.bootstrap()
        org_id = self.lc.register_org('acme', state='converting')
        self.build = self.lc.open_build(org_id, 'convert')

    def test_every_native_enum_check_refuses_bad_value_and_accepts_all_members(self):
        import psycopg
        from psycopg import sql
        doc, secs, _ = fixture()
        rows, _, _ = sections.encode_document(doc, secs)
        with conn.connect(RUNTIME, self.build.database, autocommit=False) as c:
            rowio.write(c, rows, order=rowio.tables(secs))
            c.commit()
            for entry in entries():
                table, column = entry['table'], entry['column']
                with self.subTest(table=table, column=column):
                    statement = sql.SQL('UPDATE orgtree.{} SET {}=%s').format(
                        sql.Identifier(table), sql.Identifier(column))
                    # The exact CHECK must fail, not some unrelated FK / trigger.
                    with self.assertRaises(psycopg.errors.CheckViolation) as caught:
                        with c.transaction():
                            c.execute(statement, ('zz-out-of-set',))
                    self.assertEqual(f'{table}_{column}_enum', caught.exception.diag.constraint_name)
                    for value in entry['values'] + (None,):
                        with self.assertRaises(RollbackProbe):
                            with c.transaction():
                                changed = c.execute(statement, (value,)).rowcount
                                self.assertEqual(1, changed)
                                raise RollbackProbe()

    def test_every_legacy_enum_misfit_is_null_reported_and_round_trips_through_pg(self):
        doc, secs, side = fixture(bad=True)
        rows, _, _ = sections.encode_document(doc, secs)
        with conn.connect(RUNTIME, self.build.database, autocommit=False) as c:
            rowio.write(c, rows, order=rowio.tables(secs))
            c.commit()
        with conn.connect(RUNTIME, self.build.database) as c:
            back_rows = rowio.read(c, order=rowio.tables(secs))
        for entry in entries():
            with self.subTest(table=entry['table'], column=entry['column']):
                self.assertIsNone(back_rows[entry['table']][0][entry['column']])
        reports = enums.misfits('acme', back_rows, secs)
        self.assertEqual(len(entries()), len(reports))
        self.assertEqual({(e['table'], e['column']) for e in entries()},
                         {(r['table'], r['column']) for r in reports})
        back = sections.decode_document(back_rows, secs, sections.Context())
        self.assertEqual(json.dumps(doc, sort_keys=True), json.dumps(back, sort_keys=True))
        self.assertEqual(side.part, side.read_back)
        # A legacy out-of-set state retains legacy's non-live meaning.
        with conn.connect(RUNTIME, self.build.database) as c:
            self.assertEqual(0, c.execute("SELECT count(*) FROM orgtree.agents WHERE state='live'").fetchone()[0])


class RollbackProbe(Exception):
    """Abort a successful probe without leaving a typed/extra disagreement."""


if __name__ == '__main__':
    unittest.main()
