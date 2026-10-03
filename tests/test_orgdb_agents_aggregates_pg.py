"""A1 aggregate/rare-field controls on disposable PostgreSQL only."""
import import_provenance  # noqa: F401  asserts checkout imports before the fixture opens PG

from contextlib import contextmanager
from decimal import Decimal
import random
import unittest

import test_orgdb_compat_pg as fixture
from orgtree import foreground_store as F

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule

FIELDS = ('parent', 'predecessor', 'successor', 'state', 'ui_order', 'created',
          'generation', 'bearer_state', 'cost_usd', 'cost_usd_unknown')


@fixture.needs_pg
class MaintainedAggregates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('a1 maintained')

    @contextmanager
    def connection(self):
        with fixture.storage(True):
            database = fixture.registry.lookup(self.twin.copy)[1]
            with fixture.dbconn.connect(fixture.RUNTIME, database) as raw:
                yield raw

    def totals(self, raw):
        return raw.execute('SELECT node_count,retired_axis_count,cost,cost_unknown '
                           'FROM orgtree.org_revision').fetchone()

    def recount(self, raw):
        return raw.execute("SELECT count(*),count(*) FILTER (WHERE state='archived' "
            'AND successor_id IS NULL),coalesce(sum(cost_usd),0),'
            'count(*) FILTER (WHERE cost_usd_unknown) FROM orgtree.agents WHERE NOT tombstone').fetchone()

    def test_converter_copy_initializes_all_maintained_values(self):
        with self.connection() as raw:
            self.assertEqual(self.totals(raw), self.recount(raw))

    def test_random_committed_row_batches_match_recount(self):
        rng = random.Random(6320)
        with self.connection() as raw:
            for i in range(12):
                raw.execute('INSERT INTO orgtree.agents(name,ord,state,cost_usd,cost_usd_unknown) '
                    "VALUES (%s,%s,'live',%s,false)", (f'aggregate-{i}',10000+i,Decimal(i)/100))
            for step in range(45):
                raw.execute('BEGIN')
                for _ in range(rng.randint(1,4)):
                    name = f'aggregate-{rng.randrange(12)}'
                    raw.execute('UPDATE orgtree.agents SET state=%s,tombstone=%s,cost_usd=%s,'
                        'cost_usd_unknown=%s WHERE name=%s',
                        (rng.choice(['live','archived',None]),rng.choice([False,False,True]),
                         Decimal(rng.randrange(-10000,10000))/1000,bool(rng.randrange(2)),name))
                raw.execute('COMMIT')
                with self.subTest(step=step):
                    self.assertEqual(self.totals(raw), self.recount(raw))
            raw.execute("DELETE FROM orgtree.agents WHERE name LIKE 'aggregate-%'")
            self.assertEqual(self.totals(raw), self.recount(raw))

    def test_deferred_deltas_survive_only_the_committed_savepoints(self):
        with self.connection() as raw:
            before = self.totals(raw)
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.agents SET cost_usd=cost_usd+0.123,state='archived' WHERE name='dev'")
            self.assertEqual(self.totals(raw), before)
            raw.execute('SAVEPOINT discarded')
            raw.execute("UPDATE orgtree.agents SET cost_usd=cost_usd+0.00000001 WHERE name='boss'")
            raw.execute('ROLLBACK TO SAVEPOINT discarded')
            raw.execute('COMMIT')
            self.assertEqual(self.totals(raw), self.recount(raw))
            committed = self.totals(raw)
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.agents SET cost_usd=999,tombstone=true WHERE name='dev'")
            raw.execute('ROLLBACK')
            self.assertEqual(self.totals(raw), committed)

    def test_agent_body_does_not_take_the_singleton_lock(self):
        with self.connection() as raw, self.connection() as observer:
            raw.execute('BEGIN')
            try:
                raw.execute("UPDATE orgtree.agents SET cost_usd=cost_usd+1 WHERE name='dev'")
                observer.execute('BEGIN')
                try:
                    observer.execute('SELECT singleton FROM orgtree.org_revision FOR UPDATE NOWAIT')
                finally:
                    observer.execute('ROLLBACK')
            finally:
                raw.execute('ROLLBACK')

    def test_generated_flags_distinguish_absent_and_explicit_null_extra(self):
        from psycopg.types.json import Json
        with self.connection() as raw:
            schema = dict(raw.execute('SELECT column_name,is_generated FROM information_schema.columns '
                "WHERE table_schema='orgtree' AND table_name='agents' AND column_name LIKE '%_misfit'"))
            self.assertEqual({field+'_misfit':schema.get(field+'_misfit') for field in FIELDS},
                             {field+'_misfit':'ALWAYS' for field in FIELDS})
            raw.execute('BEGIN')
            try:
                for extra in ({'name':'unrelated'},dict.fromkeys(FIELDS),{'cost_usd_unknown':'true'}):
                    raw.execute("UPDATE orgtree.agents SET extra=%s WHERE name='dev'",(Json(extra),))
                    got = raw.execute('SELECT '+','.join(f+'_misfit' for f in FIELDS)+
                                      " FROM orgtree.agents WHERE name='dev'").fetchone()
                    self.assertEqual(got, tuple(field in extra for field in FIELDS))
            finally:
                raw.execute('ROLLBACK')

    def test_generated_columns_are_ignored_by_exact_load_and_compat_writes(self):
        twin = fixture.Twins('a1 generated decode')
        twin.edit(lambda d:d['nodes']['dev'].update(successor=False,cost_usd=-0.0,
                    cost_usd_unknown='true',state=False,created={'clock':'misfit'}))
        with fixture.storage(False):
            expected = fixture.store.load_org(twin.legacy).nodes['dev']
        with fixture.storage(True):
            actual = fixture.store.load_org(twin.copy).nodes['dev']
            selected = F.read_exact(twin.copy,'dev')['rows']['dev']['node']
        self.assertEqual(actual, expected)
        self.assertEqual(selected, expected)
        self.assertFalse(any(key.endswith('_misfit') for key in actual))

    def test_cost_strings_and_misfits_match_legacy_after_updates(self):
        twin = fixture.Twins('a1 aggregate costs')
        for cost,unknown in ((0.1,False),(0.2,True),(0.1+0.2,'true'),(-0.0,'false'),
                             (0.00000000000000003,False),(7,False),(None,None)):
            twin.edit(lambda d:d['nodes']['dev'].update(cost_usd=cost,cost_usd_unknown=unknown))
            values = []
            for on,slug in ((False,twin.legacy),(True,twin.copy)):
                with fixture.storage(on):
                    values.append(F.read_snapshot(slug,lambda raw,stamp:
                        (stamp['cost'],stamp['cost_unknown'],stamp['node_count'],stamp['retired_axis_count'])))
            with self.subTest(cost=cost,unknown=unknown):
                self.assertEqual(values[0],values[1])


if __name__ == '__main__':
    unittest.main()
