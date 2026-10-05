"""Real snapshot/change-log reads; tree body parity is checked separately."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_bulk, record_reads as Q
from orgtree.orgdb.record_registry import Entity, Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Reads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record reads')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    def registry(self):
        registry = Registry()
        def members(state,selection):
            if selection.set == 'shared':
                rows = state.raw.execute("SELECT id::text FROM orgtree.agents WHERE NOT tombstone "
                                         "AND state<>'archived'")
            else:
                rows = state.raw.execute('SELECT id::text FROM orgtree.agents WHERE NOT tombstone '
                                         'AND id=ANY(%s::bigint[])',(list(selection.agents),))
            return frozenset(row[0] for row in rows)
        def bodies(state,ids):
            self.assertEqual(state.raw.execute("SELECT current_setting('transaction_isolation'),"
                "current_setting('transaction_read_only')").fetchone(),('repeatable read','on'))
            return {key:dict(name=name,title=title) for key,name,title in state.raw.execute(
                'SELECT id::text,name,title FROM orgtree.agents WHERE id=ANY(%s::bigint[])',
                (list(ids),))}
        registry.register(Entity('agent',members,bodies))
        return registry

    def connect(self):
        return fixture.dbconn.connect(fixture.ADMIN,self.database)

    def test_snapshot_is_the_real_storage_identity_and_read_only_revision(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            answer = Q.baseline(self.registry(),state)
            self.assertGreater(len(answer['records']),0)
            self.assertEqual(answer['cursor'],Q.cursor(state).wire())
            self.assertGreater(state.now,0)
            self.assertIn('floor',state.stamp)
            with self.assertRaises(fixture.psycopg.errors.ReadOnlySqlTransaction):
                state.raw.execute("UPDATE orgtree.agents SET title='read writer'")

    def test_capture_and_current_membership_make_upserts_and_archive_tombstones(self):
        with self.connect() as raw:
            key = str(raw.execute("SELECT id FROM orgtree.agents WHERE name='dev'").fetchone()[0])
            with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
                after = Q.cursor(state)
            raw.execute("UPDATE orgtree.agents SET title='read changed' WHERE name='dev'")
            with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
                answer = Q.catchup(self.registry(),state,after)
                row = next(r for r in answer['upserts'] if r['id']==key)
                self.assertEqual(row['body']['title'],'read changed')
                after = Q.cursor(state)
            raw.execute("UPDATE orgtree.agents SET state='archived' WHERE name='dev'")
            try:
                with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
                    answer = Q.catchup(self.registry(),state,after,
                                       selections=(Selection(),Selection('sub:1',(key,))))
                    self.assertIn(dict(entity='agent',id=key,set='shared'),answer['tombstones'])
                    self.assertTrue(any(r['id']==key and r['set']=='sub:1' for r in answer['upserts']))
            finally:
                raw.execute("UPDATE orgtree.agents SET state='live' WHERE name='dev'")

    def test_old_snapshot_survives_bulk_rewrite_but_next_snapshot_resets_without_later_write(self):
        with self.connect() as raw,fixture.storage(True):
            with Q.snapshot(self.twin.copy) as old:
                after = Q.cursor(old)
                before = Q.baseline(self.registry(),old)
                raw.execute('BEGIN')
                with record_bulk.writer(raw):
                    raw.execute("UPDATE orgtree.agents SET title='bulk replaced' WHERE name='dev'")
                raw.execute('COMMIT')
                self.assertEqual(Q.baseline(self.registry(),old),before)
                self.assertEqual(Q.catchup(self.registry(),old,after)['to'],after.rev)
            with Q.snapshot(self.twin.copy) as state:
                self.assertEqual(Q.catchup(self.registry(),state,after),{'type':'record_reset'})
                replacement = Q.baseline(self.registry(),state)
                self.assertTrue(any(r['body']['title']=='bulk replaced' for r in replacement['records']))
                self.assertEqual(Q.catchup(self.registry(),state,Q.cursor(state))['upserts'],[])

    def test_replacement_identity_at_lower_or_equal_revision_resets_even_without_write(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            current = Q.cursor(state)
            for revision in (current.rev,current.rev+100):
                after = Q.Cursor(current.org_uuid,'old-incarnation',revision)
                self.assertEqual(Q.catchup(self.registry(),state,after),{'type':'record_reset'})

    def test_wildcard_reaches_pinned_archived_agent_and_bound_resets(self):
        with self.connect() as raw:
            key = str(raw.execute("INSERT INTO orgtree.agents(name,ord,state) "
                "VALUES('record-pinned',940000,'archived') RETURNING id").fetchone()[0])
            with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
                after = Q.cursor(state)
            raw.execute("INSERT INTO orgtree.changes(xid,entity,entity_id) "
                        "VALUES(pg_current_xact_id(),'agent','*')")
            with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
                answer = Q.catchup(self.registry(),state,after,
                                   selections=(Selection(),Selection('sub:9',(key,))))
                self.assertTrue(any(r['id']==key and r['set']=='sub:9' for r in answer['upserts']))
                self.assertEqual(Q.catchup(self.registry(),state,after,bound=1),{'type':'record_reset'})


if __name__ == '__main__':
    unittest.main()
