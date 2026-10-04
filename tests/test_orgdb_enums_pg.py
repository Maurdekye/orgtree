"""Every enum CHECK refuses a native bad value; converted misfits remain exact.

Run only against an OWN disposable PostgreSQL cluster, under the P03 lock.
Each method creates an org database and drops it, along with its app database.
"""

import json
import copy
import importlib.util
import os
from pathlib import Path
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, conn, enums, lifecycle, mappers, sections
from orgtree.orgdb.convert import rowio
from test_orgdb_enums import entries, entry_row, fixture, native_entries

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_enums_'

_SPEC = importlib.util.spec_from_file_location(
    'enum_destination_verifier', Path(__file__).resolve().parents[1] / 'tools/orgdb_verify.py')
verifier = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = verifier
_SPEC.loader.exec_module(verifier)


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
            catalog = set(c.execute("SELECT rel.relname, con.conname FROM pg_constraint con "
                                    "JOIN pg_class rel ON rel.oid=con.conrelid "
                                    "JOIN pg_namespace ns ON ns.oid=rel.relnamespace "
                                    "WHERE ns.nspname='orgtree' AND con.contype='c'").fetchall())
            event_checks = [entry for entry in entries(True) if entry['table'] == 'work_item_events']
            self.assertEqual(33, len(event_checks))
            for entry in event_checks:
                self.assertIn((entry['table'], f"{entry['table']}_{entry['column']}_enum"), catalog)
            native = native_entries()
            self.assertEqual({(e['table'], e['table'] + '_' + e['column'] + '_enum')
                              for e in native if e['kind'] != 'manual'},
                             {(table, name) for table, name in catalog if name.endswith('_enum')})
            for entry in native:
                table, column = entry['table'], entry['column']
                with self.subTest(table=table, column=column):
                    witness = entry_row(rows, entry)
                    where = sql.SQL(' WHERE source=%s') if table == 'work_item_events' else sql.SQL('')
                    params = (witness['source'],) if table == 'work_item_events' else ()
                    statement = sql.SQL('UPDATE orgtree.{} SET {}=%s').format(
                        sql.Identifier(table), sql.Identifier(column))
                    statement += where
                    reached = c.execute(sql.SQL('SELECT count(*) FROM orgtree.{}').format(
                        sql.Identifier(table)) + where, params).fetchone()[0]
                    self.assertEqual(1, reached, 'the refusal probe must reach a real row')
                    # The exact CHECK must fail, not some unrelated FK / trigger.
                    with self.assertRaises(psycopg.errors.CheckViolation) as caught:
                        with c.transaction():
                            bad = 'z' if all(len(member) == 1 for member in entry['values']) else 'zz-out-of-set'
                            c.execute(statement, (bad,) + params)
                    suffix = 'check' if entry['kind'] == 'manual' else 'enum'
                    self.assertEqual(f'{table}_{column}_{suffix}', caught.exception.diag.constraint_name)
                    for value in entry['values'] + ((None,) if entry.get('nullable', True) else ()):
                        with self.assertRaises(RollbackProbe):
                            with c.transaction():
                                changed = c.execute(statement, (value,) + params).rowcount
                                self.assertEqual(1, changed)
                                raise RollbackProbe()

            # Every *_is column also includes the manually generated account containers,
            # whose object-marker CHECKs predate 0009. Check physical catalog coverage.
            marker_cols = c.execute("SELECT table_name, column_name FROM information_schema.columns "
                                    "WHERE table_schema='orgtree' AND right(column_name,3)='_is'").fetchall()
            known = {(e['table'], e['column']) for e in entries(True) if e['kind'] == 'marker'}
            from orgtree.orgdb.mappers import docket
            placements = {('work_items', source + '_events_is') for source in docket.EVENT_SOURCES}
            placements.update(('work_items', col + '_is') for col in docket.CURRENT_POINTERS.values())
            placements.update({('work_items', 'review_seats_is'),
                               ('work_item_artifacts', 'grants_is'),
                               ('work_item_delivery', 'claim_is')})
            self.assertEqual(known | placements | {('org_accounts', 'marks_is'), ('org_accounts', 'spend_is')},
                             set(marker_cols))
            for col in ('marks_is', 'spend_is'):
                for value in codec.MARKER_VALUES['obj'] + (None,):
                    with self.assertRaises(RollbackProbe):
                        with c.transaction():
                            self.assertEqual(1, c.execute(sql.SQL('UPDATE orgtree.org_accounts SET {}=%s')
                                                          .format(sql.Identifier(col)), (value,)).rowcount)
                            raise RollbackProbe()
                with self.assertRaises(psycopg.errors.CheckViolation):
                    with c.transaction():
                        c.execute(sql.SQL('UPDATE orgtree.org_accounts SET {}=%s').format(sql.Identifier(col)), ('z',))

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
                self.assertIsNone(entry_row(back_rows, entry)[entry['column']])
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

    def test_authored_deleted_misfit_and_internal_deleted_tombstone_are_distinct(self):
        doc = {'slug': 'acme', 'nodes': {'boss': {'state': 'deleted', 'seat_id': 'current'}},
               'work_items': [{'slug': 'one', 'owner': {'node': 'boss', 'born': 'former'}}]}
        secs = mappers.sections()
        rows, _, _ = sections.encode_document(doc, secs)
        with conn.connect(RUNTIME, self.build.database, autocommit=False) as c:
            rowio.write(c, rows)
            c.commit()
            back_rows = rowio.read(c)
            authored = next(row for row in back_rows['agents'] if not row['tombstone'])
            internal = next(row for row in back_rows['agents'] if row['tombstone'])
            self.assertIsNone(authored['state'])
            self.assertEqual(internal['state'], 'deleted')
            self.assertEqual([dict(org='acme', table='agents', record={'id': authored['id']},
                                   field='state', column='state')], enums.misfits('acme', back_rows, secs))
            self.assertEqual(doc, sections.decode_document(back_rows, secs, sections.Context()))
            checker = verifier.Verifier(verifier.Dest(c), doc, ())
            checker.run()
            self.assertEqual(checker.problems, [])
            with self.assertRaises(RollbackProbe), c.transaction():
                self.assertEqual(c.execute("UPDATE orgtree.agents SET state='deleted', extra=NULL WHERE id=%s",
                                           (authored['id'],)).rowcount, 1)
                checker = verifier.Verifier(verifier.Dest(c), doc, ())
                checker.run()
                self.assertTrue(any(p['table'] == 'agents' and p['field'] == 'state'
                                    for p in checker.problems))
                raise RollbackProbe()
            self.assertEqual(back_rows, rowio.read(c))

    def test_independent_verifier_accepts_exact_misfits_and_refuses_misplaced_valid_members(self):
        from psycopg import sql
        from psycopg.types.json import Json

        def check(connection, doc):
            checker = verifier.Verifier(verifier.Dest(connection), doc, verifier.IGNORED_DEFAULT)
            checker.run()
            return checker

        # Full correspondence through physical columns: every declared document enum appears.
        for bad in (False, True):
            doc, secs, _ = fixture(bad=bad)
            rows, _, _ = sections.encode_document(doc, secs)
            with conn.connect(RUNTIME, self.build.database, autocommit=False) as c:
                with self.assertRaises(RollbackProbe):
                    with c.transaction():
                        rowio.write(c, rows, order=rowio.tables(secs))
                        checker = check(c, doc)
                        self.assertEqual([], checker.problems)
                        self.assertGreater(sum(checker.stats.values()), len(verifier.enum_columns()))
                        raise RollbackProbe()

        doc, secs, _ = fixture()
        rows, _, _ = sections.encode_document(doc, secs)
        with conn.connect(RUNTIME, self.build.database, autocommit=False) as c:
            rowio.write(c, rows, order=rowio.tables(secs))
            c.commit()
            physical = rowio.read(c, order=rowio.tables(secs))
            for entry in entries():
                table, column = entry['table'], entry['column']
                if (table, column) not in verifier.enum_columns():
                    continue  # account side tables are explicitly outside this document verifier
                witness = entry_row(physical, entry)
                extra = copy.deepcopy(witness['extra'] or {})
                target = extra
                for key in entry['path'][:-1]:
                    target = target.setdefault(key, {})
                target[entry['path'][-1]] = entry['values'][0]
                with self.subTest(table=table, column=column):
                    with self.assertRaises(RollbackProbe):
                        with c.transaction():
                            where = sql.SQL(' WHERE source=%s') if table == 'work_item_events' else sql.SQL('')
                            params = (witness['source'],) if table == 'work_item_events' else ()
                            changed = c.execute(sql.SQL('UPDATE orgtree.{} SET {}=NULL, extra=%s')
                                                .format(sql.Identifier(table), sql.Identifier(column)) + where,
                                                (Json(extra),) + params).rowcount
                            self.assertEqual(1, changed)
                            checker = check(c, doc)
                            self.assertTrue(any(p['table'] == table and p['field'] == column
                                                and p['problem'] == 'value its column can hold is in extra instead'
                                                for p in checker.problems), checker.problems)
                            raise RollbackProbe()


class RollbackProbe(Exception):
    """Abort a successful probe without leaving a typed/extra disagreement."""


if __name__ == '__main__':
    unittest.main()
