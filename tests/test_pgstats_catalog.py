"""Runtime temporary relations must not forge ANALYZE completion."""
import unittest
import test_pgstats as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstats


class CatalogBoundary(fixture.Statistics):
    def test_partial_table_pass_refuses_marker(self):
        import psycopg
        definition = self.raw.execute("SELECT pg_get_functiondef('public.orgtree_analyze_org(bigint,boolean)'::regprocedure)").fetchone()[0]
        seam = 'FOREACH table_name IN ARRAY table_names LOOP'
        self.assertEqual(definition.count(seam), 1)
        definition = definition.replace(seam, seam + "\n    IF table_name='doc' THEN CONTINUE; END IF;")
        with self.raw.transaction(force_rollback=True):
            self.raw.execute(definition)
            print('partial pass control: skip doc before analysis/count advancement', flush=True)
            with self.assertRaisesRegex(psycopg.errors.RaiseException, 'Incomplete statistics'):
                with self.raw.transaction():
                    self.raw.execute('SET LOCAL ROLE orgtree_runtime')
                    pgstats.analyze(self.raw, self.oid)
            self.assertIsNone(self.mark())

    def test_runtime_temp_catalogs_cannot_forge_complete_initialization(self):
        query = ("SELECT count(*) FROM pg_catalog.pg_class c "
                 "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "
                 "WHERE n.nspname=%s AND c.relkind='r'")
        expected = self.raw.execute(query, (self.schema,)).fetchone()[0]
        self.assertGreater(expected, 1)
        with self.raw.transaction():
            self.raw.execute('SET LOCAL ROLE orgtree_runtime')
            self.raw.execute('CREATE TEMP TABLE pg_class(relname name,relnamespace oid,relkind "char")')
            self.raw.execute('CREATE TEMP TABLE pg_namespace(oid oid,nspname name)')
            self.raw.execute("INSERT INTO pg_temp.pg_class VALUES('doc',1,'r')")
            self.raw.execute('INSERT INTO pg_temp.pg_namespace VALUES(1,%s)', (self.schema,))
            actual = pgstats.analyze(self.raw, self.oid)
        unknown = self.raw.execute(query + ' AND c.reltuples<0', (self.schema,)).fetchone()[0]
        print(f'catalog collision exercised: expected={expected} analyzed={actual} unknown={unknown}', flush=True)
        self.assertIsNotNone(self.mark())
        self.assertEqual(actual, expected)
        self.assertEqual(unknown, 0)
        marker = self.mark()
        with self.raw.transaction():
            self.raw.execute('SET LOCAL ROLE orgtree_runtime')
            self.assertEqual(pgstats.analyze(self.raw, self.oid), 0)
        self.assertEqual(marker, self.mark())


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([CatalogBoundary(name) for name in (
        'test_runtime_temp_catalogs_cannot_forge_complete_initialization',
        'test_partial_table_pass_refuses_marker')])


if __name__ == '__main__': unittest.main()
