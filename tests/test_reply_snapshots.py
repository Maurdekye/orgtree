import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-reply-snapshots-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, reply_events, supervisor, store


class ReplySnapshotsTests(unittest.TestCase):
    def test_connection_keeps_full_durability(self):
        """perf-review round 3: an intermediate stream quote is NOT
        re-mintable from the final row, so the snapshot store must keep
        synchronous=FULL (2) — WAL is for journal churn, not durability."""
        con = reply_events._connect()
        try:
            self.assertEqual(
                con.execute('PRAGMA synchronous').fetchone()[0], 2)
            self.assertEqual(
                con.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        finally:
            con.close()

    def test_canonical_preview_fields_equal_stored_quotes(self):
        org=store.create_org('canonical-quotes')
        org.hire(ledger.USER,None,'haiku',0,'agent')
        store.save_org(org)
        original={'event_id':'source','text':'row'*2000,'thinking':'thought'*1000,
                  'tools':[{'id':'tool','name':'inspect','input':{'z':[1,2]},'result':{'ok':True}}]}
        row=reply_events.annotate(org,'agent',{'messages':[original]})['messages'][0]
        tool=row['tools'][0]
        pairs=[(row['event_id'],row['reply_quote']),
               (row['thinking_event_id'],row['thinking_reply_quote']),
               (tool['event_id'],tool['reply_quote']),
               (tool['result_event_id'],tool['result_reply_quote'])]
        for eid, quote in pairs:
            stored=reply_events.lookup('canonical-quotes','agent',0,eid,reply_events.incarnation(org,'agent'))
            self.assertEqual(quote,stored)
            self.assertLessEqual(len(quote),4000)
        self.assertEqual(row['event_id'],reply_events.remember(org,'agent','source','row',original['text']))
        self.assertEqual(tool['reply_quote'],"inspect {'z': [1, 2]}")
        self.assertEqual(tool['result_reply_quote'],"{'ok': True}")
        store._POOL.close_all('canonical-quotes')

    def test_removal_route_and_recreated_org_cannot_resolve_old_quote(self):
        from fastapi.testclient import TestClient
        from engine.launch import TokenGate
        from orgtree import api
        org = store.create_org('recreated')
        org.hire(ledger.USER,None,'haiku',0,'agent')
        store.save_org(org)
        eid = reply_events.remember(org,'agent','original','row','private quote')
        ref = {'org':'recreated','agent':'agent','generation':0,'eventId':eid}
        with patch.object(reply_events,'clear_org',side_effect=OSError('controlled erasure failure')):
            with self.assertRaises(OSError): store.delete_org('recreated')
        self.assertEqual(supervisor.resolve_chat_event(store.load_org('recreated'),'agent',ref)[1],'private quote')
        store.delete_org('recreated')
        with reply_events._connect() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM events WHERE org=?', ('recreated',)).fetchone()[0],0)
        replacement = store.create_org('recreated')
        replacement.hire(ledger.USER,None,'haiku',0,'agent')
        store.save_org(replacement)
        with patch.object(supervisor,'read_chat',return_value={'messages':[]}):
            with self.assertRaises(ledger.LedgerError): supervisor.resolve_chat_event(replacement,'agent',ref)
        new = reply_events.remember(replacement,'agent','new','row','new private quote')
        client = TestClient(TokenGate(api.app,'operator'))
        route = '/api/orgs/recreated/nodes/agent/reply-events'
        self.assertEqual(client.delete(route).status_code,401)
        self.assertEqual(client.get(route).status_code, 401)
        self.assertEqual(client.get(route, headers={'X-Orgtree-Desktop-Token':'operator'}).json(), {'count': 1})
        self.assertEqual(reply_events.count('recreated', 'another-agent'), 0)
        result = client.delete(route,headers={'X-Orgtree-Desktop-Token':'operator'})
        self.assertEqual(client.get(route, headers={'X-Orgtree-Desktop-Token':'operator'}).json(), {'count': 0})
        self.assertEqual(result.status_code,200,result.text)
        self.assertGreaterEqual(result.json()['removed'],1)
        with patch.object(supervisor,'read_chat',return_value={'messages':[]}):
            with self.assertRaises(ledger.LedgerError): supervisor.resolve_chat_event(store.load_org('recreated'),'agent',{**ref,'eventId':new})
        store._POOL.close_all('recreated')

    def test_transient_delta_ids_resolve_exact_revision_after_sweep(self):
        org = store.create_org('stream-fixture')
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(org)
        first = supervisor.capture_reply_stream('stream-fixture','agent',{'kind':'delta','text':'hello'})
        second = supervisor.capture_reply_stream('stream-fixture','agent',{'kind':'delta','text':' world'})
        self.assertNotEqual(first['event_id'],second['event_id'])
        self.assertEqual(second['reply_quote'], 'hello world')
        polled = reply_events.annotate(org,'agent',{'transient':list(supervisor.state('stream-fixture','agent')['reply_transient'].values())})
        self.assertEqual(polled['transient'][0]['event_id'],second['event_id'])
        self.assertEqual(polled['transient'][0]['reply_quote'],second['reply_quote'])
        supervisor.state('stream-fixture','agent')['reply_transient'] = {}
        for payload, expected in ((first,'hello'),(second,'hello world')):
            ref = {'org':'stream-fixture','agent':'agent','generation':0,'eventId':payload['event_id']}
            self.assertEqual(supervisor.resolve_chat_event(org,'agent',ref)[1],expected)
        store._POOL.close_all('stream-fixture')

    def test_distinct_nested_events_and_compaction_preserve_exact_quote(self):
        org = ledger.Org.create('snapshot')
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        chat = {'messages':[{'event_id':'source-one','text':'same','thinking':'thought',
            'tools':[{'id':'tool-one','name':'Read','arg':'file','result':'result'}]},
            {'event_id':'source-two','text':'same'}]}
        rows = reply_events.annotate(org, 'agent', chat)['messages']
        ids = [rows[0]['event_id'], rows[1]['event_id'], rows[0]['thinking_event_id'],
               rows[0]['tools'][0]['event_id'], rows[0]['tools'][0]['result_event_id']]
        self.assertEqual(len(set(ids)), 5)
        org.nodes['agent']['generation'] = 1
        with patch.object(supervisor, 'read_chat', return_value={'messages':[]}):
            for eid, expected in zip(ids, ['same','same','thought','Read file','result']):
                ref = {'org':'snapshot','agent':'agent','generation':0,'eventId':eid}
                self.assertEqual(supervisor.resolve_chat_event(org,'agent',ref)[1], expected)
            with self.assertRaises(ledger.LedgerError):
                supervisor.resolve_chat_event(org,'agent',{**ref,'eventId':'reply_forged'})
        self.assertIsNone(reply_events.lookup('different','agent',0,ids[0],reply_events.incarnation(org,'agent')))
        self.assertIsNone(reply_events.lookup('snapshot','different',0,ids[0],reply_events.incarnation(org,'agent')))

    def test_updated_event_keeps_old_snapshot_and_issues_new_reference(self):
        org = ledger.Org.create('versions')
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        old = reply_events.remember(org,'agent','stream-id','row','partial')
        new = reply_events.remember(org,'agent','stream-id','row','complete')
        self.assertNotEqual(old,new)
        self.assertEqual(reply_events.lookup('versions','agent',0,old,reply_events.incarnation(org,'agent')),'partial')
        self.assertEqual(reply_events.lookup('versions','agent',0,new,reply_events.incarnation(org,'agent')),'complete')

if __name__ == '__main__': unittest.main()
