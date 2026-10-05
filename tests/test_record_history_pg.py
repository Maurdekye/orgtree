"""History window endpoint parity, boundary changes and name replacement."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import unittest
import test_orgdb_compat_pg as fixture
from orgtree import api
from orgtree.orgdb import record_reads as Q, record_panels, record_panel_sql, migrate
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class History(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            org.d['events'] = [dict(op='event',actor='dev',at=fixture.AT,
                detail={'node':'ops','index':i},warnings=[f'w{i}']) for i in range(84)]
            org.d['notice_log'] = [dict(node='dev',at=fixture.AT,text=f'n{i}') for i in range(7)]
            fixture.store.save_org(org)
        self.twin = fixture.Twins('history '+self._testMethodName,seed)
        self.database = fixture.registry.lookup(self.twin.copy)[1]
        self.raw = fixture.dbconn.connect(fixture.ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute("SET statement_timeout='10s'")
        self.assertIn('0019_record_panels.sql', migrate.applied(self.raw))
        self.registry = record_panels.register(Registry())
        self.agent = str(self.raw.execute("SELECT id FROM orgtree.agents WHERE name='dev'").fetchone()[0])
        self.selection = (Selection('sub:1',windows=({'kind':'agent_history','agent':self.agent},)),)
        self.enterContext(fixture.storage(True))

    def baseline(self):
        with Q.snapshot(self.twin.copy) as state:
            return {r['id']:r['body'] for r in Q.records(self.registry,state,self.selection)},Q.cursor(state)

    def advance(self,held,after):
        with Q.snapshot(self.twin.copy) as state:
            frame = Q.catchup(self.registry,state,after,selections=self.selection)
            self.assertEqual(frame['type'],'record_changes')
            for row in frame['tombstones']:
                held.pop(row['id'],None)
            for row in frame['upserts']:
                held[row['id']] = row['body']
            for replacement in frame.get('replacements',[]):
                held = {r['id']:r['body'] for r in replacement['records']}
            self.assertEqual(held,{r['id']:r['body'] for r in Q.records(self.registry,state,self.selection)})
            return held,Q.cursor(state),frame

    def test_union_matches_endpoint_ties_and_shared_has_no_history(self):
        held,_ = self.baseline()
        ordered = [body for key,body in sorted(held.items(),key=lambda pair:(
            pair[1]['at'],pair[0].startswith('notice:'),int(pair[0].partition(':')[2])))]
        self.assertEqual(ordered,api.node_history(self.twin.copy,'dev',None)['items'])
        self.assertEqual(len(held),80)
        with Q.snapshot(self.twin.copy) as state:
            self.assertFalse(any(r['entity'].startswith('agent_history:') for r in Q.records(self.registry,state)))

    def test_pushout_delete_promote_warning_and_ref_departure(self):
        held,after = self.baseline()
        key = self.raw.execute("INSERT INTO orgtree.notice_log(ord,node,at,text) VALUES(9999,'dev',%s,'new') RETURNING id",(fixture.AT,)).fetchone()[0]
        held,after,frame = self.advance(held,after)
        self.assertTrue(frame['tombstones'])
        self.raw.execute('DELETE FROM orgtree.notice_log WHERE id=%s',(key,))
        held,after,frame = self.advance(held,after)
        self.assertTrue(frame['upserts'])
        self.raw.execute("UPDATE orgtree.event_warnings SET value='changed' WHERE events_id=(SELECT max(id) FROM orgtree.events)")
        held,after,frame = self.advance(held,after)
        self.assertEqual(len(frame['upserts']),1)
        self.assertEqual(frame['upserts'][0]['body']['warnings'],['changed'])
        self.raw.execute("UPDATE orgtree.events SET actor='ops' WHERE id=(SELECT max(id) FROM orgtree.events)")
        self.advance(held,after)

    def test_rename_and_tombstone_replace_subscription(self):
        held,after = self.baseline()
        self.raw.execute("UPDATE orgtree.agents SET name='renamed' WHERE id=%s",(int(self.agent),))
        held,after,frame = self.advance(held,after)
        self.assertEqual(held,{})
        self.assertEqual(len(frame['replacements']),1)
        self.raw.execute("UPDATE orgtree.agents SET name='dev' WHERE id=%s",(int(self.agent),))
        held,after,frame = self.advance(held,after)
        self.assertEqual(len(held),80)
        self.raw.execute('UPDATE orgtree.agents SET tombstone=true WHERE id=%s',(int(self.agent),))
        held,after,frame = self.advance(held,after)
        self.assertEqual(held,{})

    def test_two_physical_captures_both_commit_orders(self):
        for reverse in (False,True):
            with self.subTest(reverse=reverse), ExitStack() as stack:
                writers = [stack.enter_context(fixture.dbconn.connect(fixture.ADMIN,self.database)) for _ in range(2)]
                for i,raw in enumerate(writers):
                    raw.execute("SET statement_timeout='10s'")
                    raw.execute('BEGIN')
                    raw.execute("INSERT INTO orgtree.notice_log(ord,node,at,text) VALUES(%s,'dev',%s,%s)",
                        (10000+int(reverse)*2+i,fixture.AT,f'writer{i}'))
                order = writers[::-1] if reverse else writers
                try:
                    order[0].execute('COMMIT')
                    held,after = self.baseline()
                    order[1].execute('COMMIT')
                    self.advance(held,after)
                finally:
                    for raw in writers:
                        raw.execute('ROLLBACK')


if __name__ == '__main__':
    unittest.main()
