"""G turn-child ownership at the composed record flush; disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
import unittest

import test_orgdb_compat_pg as fixture

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule
CHILDREN = ('agent_turn_cost_unknown_fields','agent_turn_model_usage_keys')


@fixture.needs_pg
class SchemaCapture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record schema composition')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    @contextmanager
    def connection(self):
        with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
            raw.execute("SET statement_timeout='10s'")
            yield raw

    def revision(self,raw):
        return raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]

    def turns(self,raw):
        owners = [raw.execute('SELECT id FROM orgtree.agents WHERE name=%s AND NOT tombstone',
                              (name,)).fetchone()[0] for name in ('dev','ops')]
        turns = [raw.execute('INSERT INTO orgtree.agent_turns(agent_id,idx,recent_pos) '
                             'SELECT %s,coalesce(max(idx),0)+1,coalesce(max(recent_pos),0)+7 '
                             'FROM orgtree.agent_turns WHERE agent_id=%s RETURNING id',
                             (owner,owner)).fetchone()[0] for owner in owners]
        return owners,turns

    def changes(self,raw,rev,entity='agent'):
        return {row[0] for row in raw.execute('SELECT entity_id FROM orgtree.changes '
            'JOIN orgtree.revisions USING(xid) WHERE rev=%s AND entity=%s',(rev,entity))}

    def assert_revision(self,raw,before,owners):
        self.assertEqual(self.revision(raw),before+1)
        self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.revisions WHERE rev=%s',
                                    (before+1,)).fetchone()[0],1)
        self.assertTrue({str(owner) for owner in owners} <= self.changes(raw,before+1))
        versions = dict(raw.execute('SELECT agent_id,version FROM orgtree.record_detail_versions '
                                   'WHERE agent_id=ANY(%s)',(owners,)).fetchall())
        self.assertEqual(versions,{owner:before+1 for owner in owners})

    def test_turn_children_resolve_only_after_revision_and_name_both_owners(self):
        for table in CHILDREN:
            with self.subTest(table=table),self.connection() as raw:
                owners,turns = self.turns(raw)
                raw.execute(f'INSERT INTO orgtree.{table}(turn_id,pos,value) VALUES(%s,0,%s)',
                            (turns[0],'original'))
                before = self.revision(raw)
                raw.execute('BEGIN')
                raw.execute(f'UPDATE orgtree.{table} SET turn_id=%s,value=%s WHERE turn_id=%s',
                            (turns[1],'moved',turns[0]))
                # Before flush, source capture names only both transition keys.
                captured = set(raw.execute('SELECT entity,entity_id FROM orgtree.changes '
                    'WHERE xid=pg_current_xact_id()').fetchall())
                self.assertEqual(captured,{('~scope',f'turn:{turn}') for turn in turns})
                self.assertEqual(self.revision(raw),before)
                raw.execute('COMMIT')
                self.assert_revision(raw,before,owners)

    def test_turn_child_insert_update_delete_each_refresh_local_detail(self):
        for table in CHILDREN:
            with self.subTest(table=table),self.connection() as raw:
                owners,turns = self.turns(raw)
                for sql,params in (
                    (f'INSERT INTO orgtree.{table}(turn_id,pos,value) VALUES(%s,0,%s)',(turns[0],'a')),
                    (f'UPDATE orgtree.{table} SET value=%s WHERE turn_id=%s',('b',turns[0])),
                    (f'DELETE FROM orgtree.{table} WHERE turn_id=%s',(turns[0],))):
                    before = self.revision(raw)
                    raw.execute('BEGIN')
                    raw.execute(sql,params)
                    raw.execute('COMMIT')
                    self.assert_revision(raw,before,owners[:1])

    def test_turn_delete_cascade_keeps_agent_capture_after_owner_lookup_disappears(self):
        with self.connection() as raw:
            owners,turns = self.turns(raw)
            for table in CHILDREN:
                raw.execute(f'INSERT INTO orgtree.{table}(turn_id,pos,value) VALUES(%s,0,%s)',
                            (turns[0],'cascade'))
            before = self.revision(raw)
            raw.execute('BEGIN')
            raw.execute('DELETE FROM orgtree.agent_turns WHERE id=%s',(turns[0],))
            raw.execute('COMMIT')
            self.assert_revision(raw,before,owners[:1])
            for table in CHILDREN:
                self.assertEqual(raw.execute(f'SELECT count(*) FROM orgtree.{table} WHERE turn_id=%s',
                                             (turns[0],)).fetchone()[0],0)

    def test_turn_child_savepoint_rollback_and_connection_reuse_do_not_leak_scopes(self):
        for table in CHILDREN:
            with self.subTest(table=table),self.connection() as raw:
                owners,turns = self.turns(raw)
                before = self.revision(raw)
                raw.execute('BEGIN')
                raw.execute('SAVEPOINT discarded')
                raw.execute(f'INSERT INTO orgtree.{table}(turn_id,pos,value) VALUES(%s,0,%s)',
                            (turns[0],'discarded'))
                raw.execute('ROLLBACK TO discarded')
                self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.changes '
                    'WHERE xid=pg_current_xact_id()').fetchone()[0],0)
                raw.execute('COMMIT')
                self.assertEqual(self.revision(raw),before)
                raw.execute('BEGIN')
                raw.execute(f'INSERT INTO orgtree.{table}(turn_id,pos,value) VALUES(%s,0,%s)',
                            (turns[1],'reused'))
                raw.execute('COMMIT')
                self.assert_revision(raw,before,owners[1:])
                self.assertNotIn(f'turn:{turns[0]}',self.changes(raw,before+1,'~scope'))


if __name__=='__main__':
    unittest.main()
