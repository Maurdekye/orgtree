"""Mailbox record projection equals the existing endpoint in one snapshot."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from unittest.mock import patch
from contextlib import ExitStack
import unittest
import test_orgdb_compat_pg as fixture
from orgtree import api
from orgtree.orgdb import record_reads as Q, record_mail as M, record_panels, record_panel_sql, migrate
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
            for name,node in org.nodes.items():
                node.setdefault('session_id','record-'+name)
                node.setdefault('bearer_state',None)
            for ask in org.d['asks']:
                ask['questions'] = [{'id':'question-1','question':ask['question']}]
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
        self.assertIn('0019_record_panels.sql', migrate.applied(self.raw))
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

    def test_production_worker_retains_only_subscribed_dirty_mail_inputs(self):
        from orgtree.orgdb.record_host import OrgHost
        from orgtree.orgdb import record_mail_runtime
        host = OrgHost(self.twin.copy,self.fail)
        _, initial = host._worker('baseline',None,None,(Selection(),))
        self.assertEqual(initial.mail,{})
        aid = str(self.raw.execute("SELECT id FROM orgtree.agents WHERE name='dev'").fetchone()[0])
        selected = (Selection(),Selection('sub:1',(aid,),({'kind':'agent_mail','agent':aid},)))
        _, subscribed = host._worker('changes',initial.cursor,selected[1:],selected,
            previous=(initial.cursor,initial.held))
        self.assertEqual(set(subscribed.mail),{aid})
        self.assertEqual(subscribed.mail[aid]['batches'][0]['tok'],'batch')
        with patch.object(record_mail_runtime,'inputs',wraps=record_mail_runtime.inputs) as read:
            _, unchanged = host._worker('changes',subscribed.cursor,selected[1:],selected,
                previous=(subscribed.cursor,subscribed.held),previous_mail=frozenset({aid}))
            self.assertEqual(unchanged.mail,{})
            self.assertFalse(read.call_args.args[1])
        self.raw.execute('DELETE FROM orgtree.delivery_batches WHERE agent_id=%s',(int(aid),))
        _, changed = host._worker('changes',unchanged.cursor,selected[1:],selected,
            previous=(unchanged.cursor,unchanged.held),previous_mail=frozenset({aid}))
        self.assertEqual(changed.mail[aid]['batches'],[])
        _, unsubscribed = host._worker('changes',changed.cursor,(),(Selection(),),
            previous=(changed.cursor,changed.held),previous_mail=frozenset({aid}))
        self.assertEqual(unsubscribed.mail_held,frozenset())

    def test_recipient_sender_scan_skips_inactive_duplicates_and_obeys_cap(self):
        owner = self.raw.execute("SELECT id FROM orgtree.agents WHERE name='ops'").fetchone()[0]
        self.raw.execute('INSERT INTO orgtree.mail_log(agent_id,idx,"from",at,body) '
            "SELECT %s,10000+n,'dev',%s,'inactive' FROM generate_series(1,3000) n",(owner,fixture.AT))
        self.raw.execute('INSERT INTO orgtree.mail_log(agent_id,idx,"from",at,body) '
            "VALUES(%s,20001,'zzz',%s,'tail')",(owner,fixture.AT))
        self.raw.execute('ANALYZE orgtree.mail_log')
        self.assertEqual(self.raw.execute('SELECT * FROM orgtree.record_mail_senders(%s,2)',(owner,)).fetchall(),
                         [('dev',),('zzz',)])
        self.assertEqual(self.raw.execute('SELECT * FROM orgtree.record_mail_senders(%s,1)',(owner,)).fetchall(),[('dev',)])
        # Inspect the actual SQL function body so EXPLAIN exposes each indexed
        # seek rather than the opaque function-scan row alone.
        sql = self.raw.execute("SELECT prosrc FROM pg_proc WHERE proname='record_mail_senders'").fetchone()[0]
        sql = sql.replace('owner_id',str(owner)).replace('cap','2')
        import json
        plan = self.raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+sql).fetchone()[0]
        if isinstance(plan,str): plan = json.loads(plan)
        scans = []
        def visit(node):
            if 'Index' in node.get('Node Type',''): scans.append(node)
            for child in node.get('Plans',[]): visit(child)
        visit(plan[0]['Plan'])
        self.assertGreaterEqual(len(scans),2,plan)
        self.assertTrue(all(scan['Actual Rows'] <= 1 for scan in scans),plan)
        self.assertTrue(all('agent_id' in scan.get('Index Cond','') for scan in scans),plan)

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

    def test_missing_recipient_capture_is_caught_across_reconnect(self):
        from orgtree.orgdb import record_derivations as D
        owner = self.raw.execute("SELECT id FROM orgtree.agents WHERE name='ops' AND NOT tombstone").fetchone()[0]
        # The removed rows belong to another sender. Capturing that sender
        # cannot incidentally repair dev's unchanged Sent ordering key.
        self.raw.execute('UPDATE orgtree.mail_log SET "from"=\'outsider\' WHERE agent_id=%s',(owner,))
        survivor = self.raw.execute('INSERT INTO orgtree.mail_log(agent_id,idx,"from",at,body) '
            "VALUES(%s,1000,'dev',%s,'survivor') RETURNING id",(owner,fixture.AT)).fetchone()[0]
        held,after = self.baseline()
        self.assertFalse(any(body['mail']['body']=='survivor' for body in held.values()))
        source = record_panel_sql.sources(record_panels.EXTENSIONS)['mail_log']
        original = self.raw.execute('SELECT id,agent_id,idx,"from",at,body FROM orgtree.mail_log '
            'WHERE agent_id=%s AND id<>%s',(owner,survivor)).fetchall()
        scope = D.scope('mail_recipient','r.agent_id')
        self.assertIn(scope,source.names)
        fault = D.Source(tuple(name for name in source.names if name != scope))
        def install(declaration):
            self.raw.execute(D.capture_function('mail_log',declaration).replace(
                'CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
        install(fault)
        try:
            self.raw.execute('DELETE FROM orgtree.mail_log WHERE agent_id=%s AND id<>%s',(owner,survivor))
            with self.assertRaises(AssertionError):
                self.advance(dict(held),after)
        finally:
            install(source)
        # Replay the same deletion from a fresh control baseline. A capture
        # restored later cannot repair history deliberately omitted by a fault.
        with self.raw.cursor() as cursor:
            cursor.executemany('INSERT INTO orgtree.mail_log(id,agent_id,idx,"from",at,body) '
                'OVERRIDING SYSTEM VALUE VALUES(%s,%s,%s,%s,%s,%s)',original)
        held,after = self.baseline()
        self.raw.execute('DELETE FROM orgtree.mail_log WHERE agent_id=%s AND id<>%s',(owner,survivor))
        recovered,_,_ = self.advance(held,after)
        self.assertTrue(any(body['mail']['body']=='survivor' for body in recovered.values()))

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
