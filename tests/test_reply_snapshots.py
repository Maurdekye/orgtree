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
        self.assertIsNone(reply_events.lookup('different','agent',0,ids[0]))
        self.assertIsNone(reply_events.lookup('snapshot','different',0,ids[0]))

    def test_updated_event_keeps_old_snapshot_and_issues_new_reference(self):
        org = ledger.Org.create('versions')
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        old = reply_events.remember(org,'agent','stream-id','row','partial')
        new = reply_events.remember(org,'agent','stream-id','row','complete')
        self.assertNotEqual(old,new)
        self.assertEqual(reply_events.lookup('versions','agent',0,old),'partial')
        self.assertEqual(reply_events.lookup('versions','agent',0,new),'complete')

if __name__ == '__main__': unittest.main()
