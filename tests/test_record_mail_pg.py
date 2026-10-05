"""Mailbox record projection equals the existing endpoint in one snapshot."""
import import_provenance  # noqa: F401
from unittest.mock import patch
from contextlib import ExitStack
import unittest
import test_orgdb_compat_pg as fixture
from orgtree import api
from orgtree.orgdb import record_reads as Q, record_mail as M, record_panels, record_panel_sql
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class MailReaders(unittest.TestCase):
    def setUp(self):
        def mail(mid, sender='dev', body=None):
            return dict(id=mid,at=fixture.AT,body=body or mid,**{'from':sender})
        def seed(slug):
            org = fixture.store.load_org(slug)
            org.d['mail_log'] = {
                'ops':[mail('ops'+str(i)) for i in range(55)],
                'boss':[mail('boss'+str(i)) for i in range(55)],
                'dev':[mail('dev'+str(i),'boss') for i in range(55)]}
            org.d['mail'] = {'dev':[mail('pending','boss'),mail('duplicate','boss','dev54')]}
            org.d['delivering'] = {'dev':[dict(tok='batch',at=fixture.AT,via='turn',
                mail=[mail('carrier','ops'),mail('batchduplicate','boss','dev53')])]}
            org.d['user_inbox'] = [mail('userpending')]
            org.d['user_mail_log'] = [mail('userlog')]
            fixture.store.save_org(org)
        self.twin = fixture.Twins('mail readers '+self._testMethodName,seed)
        self.database = fixture.registry.lookup(self.twin.copy)[1]
        self.raw = fixture.dbconn.connect(fixture.ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute(record_panel_sql.migration_sql((),record_panels.EXTENSIONS))
        self.enterContext(fixture.storage(True))
        self.enterContext(patch('orgtree.supervisor._delivery_stages',return_value={}))
        self.registry = M.register(Registry())

    def project(self,state,name):
        aid = str(state.raw.execute('SELECT id FROM orgtree.agents WHERE name=%s',(name,)).fetchone()[0])
        rows = Q.records(self.registry,state,(Selection('sub:1',windows=({'kind':'agent_mail','agent':aid},)),))
        output = {folder:[] for folder in ('pending','delivered','sent')}
        for record in sorted(rows,key=lambda r:(r['body']['folder'],r['body']['order'])):
            body = record['body']
            output[body['folder']].append(body['mail'])
        return output

    def baseline(self):
        with Q.snapshot(self.twin.copy) as state:
            aid = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone").fetchone()[0])
            self.selection = (Selection('sub:1',windows=({'kind':'agent_mail','agent':aid},)),)
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

    def test_pending_duplicate_delivery_updates_subscription(self):
        held,after = self.baseline()
        self.raw.execute("DELETE FROM orgtree.delivery_batches WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone)")
        held,after,frame = self.advance(held,after)
        self.assertTrue(any('/pending:delivery:' in r['id'] for r in frame['tombstones']))
        self.assertTrue(any(r['body']['mail']['body']=='dev53' for r in frame['upserts']))
        self.raw.execute("DELETE FROM orgtree.mail WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone)")
        self.advance(held,after)

    def test_first_recipient_row_delete_moves_unchanged_sent_row_into_window(self):
        owner = self.raw.execute("SELECT id FROM orgtree.agents WHERE name='ops' AND NOT tombstone").fetchone()[0]
        row = self.raw.execute('INSERT INTO orgtree.mail_log(agent_id,idx,"from",at,body) VALUES(%s,1000,\'dev\',%s,\'survivor\') RETURNING id',
            (owner,fixture.AT)).fetchone()[0]
        held,after = self.baseline()
        self.assertFalse(any(body['mail']['body']=='survivor' for body in held.values()))
        self.raw.execute('DELETE FROM orgtree.mail_log WHERE agent_id=%s AND id<>%s',(owner,row))
        held,after,frame = self.advance(held,after)
        self.assertTrue(any(body['mail']['body']=='survivor' for body in held.values()))
        self.assertTrue(frame['tombstones'])

    def test_sql_sent_selector_matches_compatibility_algorithm(self):
        from orgtree.orgdb.compat import sql as compat
        for cap in (1,3,50,100,200):
            self.assertEqual([r[0] for r in self.raw.execute('SELECT * FROM orgtree.record_sent_ids(%s,%s)',('dev',cap))],
                compat._sent_ids(self.raw,'orgtree.mail_log','dev',cap))

    def test_two_physical_mail_writers_both_commit_orders(self):
        for reverse in (False,True):
            with self.subTest(reverse=reverse), ExitStack() as stack:
                writers = [stack.enter_context(fixture.dbconn.connect(fixture.ADMIN,self.database)) for _ in range(2)]
                for i,raw in enumerate(writers):
                    raw.execute("SET statement_timeout='10s'")
                    raw.execute('BEGIN')
                    raw.execute('INSERT INTO orgtree.mail_log(agent_id,idx,"from",at,body) '
                        'SELECT id,%s,\'dev\',%s,%s FROM orgtree.agents WHERE name=%s AND NOT tombstone',
                        (2000+int(reverse),fixture.AT,f'writer {reverse} {i}',('ops','boss')[i]))
                order = writers[::-1] if reverse else writers
                try:
                    order[0].execute('COMMIT')
                    held,after = self.baseline()
                    order[1].execute('COMMIT')
                    self.advance(held,after)
                finally:
                    for raw in writers:
                        raw.execute('ROLLBACK')

    def test_all_folders_equal_endpoint_with_pending_duplicates_and_recipient_ties(self):
        for name in ('dev','ops','boss'):
            with self.subTest(name=name), Q.snapshot(self.twin.copy) as state:
                self.assertEqual(self.project(state,name),api.node_inbox(self.twin.copy,name))
        with Q.snapshot(self.twin.copy) as state:
            actual = self.project(state,'dev')
            self.assertEqual(len(actual['pending']),4)
            self.assertEqual(len(actual['delivered']),50)
            self.assertFalse({'dev53','dev54'} & {m['body'] for m in actual['delivered']})
            self.assertEqual(actual['sent'][-1]['id'],'userlog')
            self.assertEqual(Q.records(self.registry,state),[])

    def test_recipient_first_delete_reorders_sent_like_existing_reader(self):
        with Q.snapshot(self.twin.copy) as state:
            before = self.project(state,'dev')
        self.raw.execute("DELETE FROM orgtree.mail_log WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='ops' AND NOT tombstone) AND id IN (SELECT id FROM orgtree.mail_log WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='ops' AND NOT tombstone) ORDER BY id LIMIT 54)")
        with Q.snapshot(self.twin.copy) as state:
            self.assertEqual(self.project(state,'dev'),api.node_inbox(self.twin.copy,'dev'))
        self.assertEqual(before['sent'][-1]['id'],'userlog')

    def test_new_snapshot_sees_delivery_but_open_snapshot_keeps_pending(self):
        with Q.snapshot(self.twin.copy) as state:
            before = self.project(state,'dev')
            self.raw.execute("DELETE FROM orgtree.delivery_batches WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone)")
            state.cache.clear()
            self.assertEqual(self.project(state,'dev'),before)
        with Q.snapshot(self.twin.copy) as state:
            after = self.project(state,'dev')
            self.assertEqual(after,api.node_inbox(self.twin.copy,'dev'))
            self.assertEqual(len(after['pending']),2)
            self.assertIn('dev53',{m['body'] for m in after['delivered']})


if __name__ == '__main__':
    unittest.main()
