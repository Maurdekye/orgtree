"""A1 aggregate/rare-field controls on disposable PostgreSQL only."""
import import_provenance  # noqa: F401  asserts checkout imports before the fixture opens PG

from contextlib import contextmanager
from decimal import Decimal
import random
import threading
import time
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
        return raw.execute("SELECT count(*),count(*) FILTER (WHERE a.state='archived' "
            "AND (a.successor_id IS NULL OR s.name='')),coalesce(sum(a.cost_usd),0),"
            'count(*) FILTER (WHERE a.cost_usd_unknown) FROM orgtree.agents a '
            'LEFT JOIN orgtree.agents s ON s.id=a.successor_id WHERE NOT a.tombstone').fetchone()

    def assert_parents(self, raw):
        maintained=dict(raw.execute('SELECT parent_id,retired_children FROM orgtree.foreground_parent_counts '
                                   'WHERE retired_children<>0'))
        counted=dict(raw.execute('SELECT coalesce(a.parent_id,0),count(*) FROM orgtree.agents a '
            'LEFT JOIN orgtree.agents s ON s.id=a.successor_id WHERE NOT a.tombstone '
            "AND a.state='archived' AND (a.successor_id IS NULL OR s.name='') GROUP BY a.parent_id"))
        self.assertEqual(maintained,counted)
        self.assertEqual(self.totals(raw),self.recount(raw))

    def test_parent_counts_copy_moves_deletes_savepoints_and_rollback(self):
        rng=random.Random(106320)
        with self.connection() as raw:
            self.assert_parents(raw)
            parent_ids=[None,*[r[0] for r in raw.execute("SELECT id FROM orgtree.agents WHERE name IN ('boss','dev')")]]
            for i in range(9):
                raw.execute("INSERT INTO orgtree.agents(name,ord,parent_id,state) VALUES(%s,%s,%s,'archived')",
                            (f'parent-count-{i}',20000+i,rng.choice(parent_ids)))
            for step in range(30):
                raw.execute('BEGIN')
                for _ in range(3):
                    raw.execute('UPDATE orgtree.agents SET state=%s,parent_id=%s,tombstone=%s WHERE name=%s',
                        (rng.choice(['live','archived']),rng.choice(parent_ids),bool(rng.randrange(3)==0),
                         f'parent-count-{rng.randrange(9)}'))
                raw.execute('SAVEPOINT discard')
                raw.execute("DELETE FROM orgtree.agents WHERE name='parent-count-0'")
                raw.execute('ROLLBACK TO SAVEPOINT discard')
                raw.execute('ROLLBACK' if step%5==0 else 'COMMIT')
                self.assert_parents(raw)
            raw.execute("DELETE FROM orgtree.agents WHERE name LIKE 'parent-count-%'")
            self.assert_parents(raw)

    def test_empty_reference_rename_updates_axis_and_keeps_parent_ids(self):
        from orgtree.orgdb import agents
        with self.connection() as raw:
            target=raw.execute("INSERT INTO orgtree.agents(name,ord,state) VALUES('',30000,'live') RETURNING id").fetchone()[0]
            raw.execute("INSERT INTO orgtree.agents(name,ord,parent_id,successor_id,state) "
                "VALUES('empty-link-child',30001,%s,%s,'archived')",(target,target))
            for name in ('','renamed-empty',''):
                raw.execute('UPDATE orgtree.agents SET name=%s WHERE id=%s',(name,target))
                self.assert_parents(raw)
                expected=raw.execute("SELECT count(*) FROM orgtree.agents a LEFT JOIN orgtree.agents p "
                    "ON p.id=a.parent_id LEFT JOIN orgtree.agents s ON s.id=a.successor_id "
                    "WHERE NOT a.tombstone AND a.state='archived' AND coalesce(s.name,'')='' "
                    "AND coalesce(p.name,'')='' ").fetchone()[0]
                self.assertEqual(agents.retired_counts(raw,[''])[''],expected)
            raw.execute("DELETE FROM orgtree.agents WHERE name='empty-link-child'")
            raw.execute('DELETE FROM orgtree.agents WHERE id=%s',(target,))
            self.assert_parents(raw)

    def test_save_and_standalone_retire_share_singleton_before_parent_lock_order(self):
        from orgtree.orgdb.compat import conn as compatibility
        errors=[]
        committing=threading.Event()
        with fixture.storage(True), self.connection() as observer:
            parent=observer.execute("SELECT id FROM orgtree.agents WHERE name='boss'").fetchone()[0]
            observer.execute("INSERT INTO orgtree.agents(name,ord,parent_id,state) VALUES"
                "('save-counter-child',31000,%s,'live'),('standalone-counter-child',31001,%s,'live')",(parent,parent))
            saved=compatibility.open_conn(self.twin.copy)
            saved.raw.execute("SET statement_timeout='8s'")
            saved.raw.execute('BEGIN')
            saved.raw.execute("UPDATE orgtree.agents SET state='archived' WHERE name='save-counter-child'")
            saved.on_save_commit(True)  # the real save seam already owns org_revision
            pid=[]
            def standalone():
                try:
                    with self.connection() as raw:
                        raw.execute("SET statement_timeout='8s'")
                        raw.execute('BEGIN')
                        raw.execute("UPDATE orgtree.agents SET state='archived' WHERE name='standalone-counter-child'")
                        pid.append(raw.execute('SELECT pg_backend_pid()').fetchone()[0])
                        committing.set()
                        raw.execute('COMMIT')
                except BaseException as error:
                    errors.append(error)
                    committing.set()
            worker=threading.Thread(target=standalone)
            worker.start()
            try:
                self.assertTrue(committing.wait(3))
                self.assertFalse(errors)
                deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    if observer.execute('SELECT cardinality(pg_blocking_pids(%s))',(pid[0],)).fetchone()[0]:
                        break
                    time.sleep(.01)
                else:
                    self.fail('standalone COMMIT never waited for the save singleton')
                saved.execute('COMMIT')
            finally:
                if saved.in_transaction:
                    saved.execute('ROLLBACK')
                worker.join(10)
                saved.close()
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors,[],str(errors))
            self.assert_parents(observer)
            observer.execute("DELETE FROM orgtree.agents WHERE name IN ('save-counter-child','standalone-counter-child')")

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

    def test_request_flags_select_only_metadata_misfits_and_exact_extra_survives(self):
        from psycopg.types.json import Json
        from orgtree.orgdb import reader_rows
        with self.connection() as raw:
            raw.execute('BEGIN')
            try:
                for table in ('asks','credit_requests','scope_requests'):
                    rid=raw.execute(f'INSERT INTO orgtree.{table}(ord,node,status,extra) '
                        "VALUES(40000,'dev','open',%s) RETURNING id",(Json({'unrelated':'kept'}),)).fetchone()[0]
                    flags='node_misfit,status_misfit,at_misfit,resolved_at_misfit'
                    self.assertEqual(raw.execute(f'SELECT {flags} FROM orgtree.{table} WHERE id=%s',(rid,)).fetchone(),
                                     (False,False,False,False))
                    raw.execute(f'UPDATE orgtree.{table} SET extra=%s WHERE id=%s',
                                (Json({'unrelated':'kept','at':None,'resolved_at':'odd'}),rid))
                    self.assertEqual(raw.execute(f'SELECT {flags} FROM orgtree.{table} WHERE id=%s',(rid,)).fetchone(),
                                     (False,False,True,True))
                    body=reader_rows.read_records(raw,table,[rid])[0]
                    self.assertEqual(body['unrelated'],'kept')
                    self.assertEqual(body['resolved_at'],'odd')
                    self.assertFalse(any(key.endswith('_misfit') for key in body))
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
