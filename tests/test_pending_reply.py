import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

root=tempfile.TemporaryDirectory(prefix='v2-pending-reply-')
data=Path(root.name)/'data'; data.mkdir()
home=Path(root.name)/'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data),HOME=str(home),USERPROFILE=str(home),ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'): os.environ.pop(key,None)
from engine.launch import load_app
app,*_=load_app()
from orgtree import store,ledger,supervisor,reply_events

def tearDownModule():
    store._POOL.close_all('pending'); root.cleanup()

class PendingReplyTests(unittest.TestCase):
    def test_sent_reply_keeps_canonical_quote_in_pending_http_row(self):
        org=store.create_org('pending'); org.hire(ledger.USER,None,'haiku',0,'agent'); store.save_org(org)
        eid=reply_events.remember(org,'agent','source','thinking','canonical thought')
        ref={'org':'pending','agent':'agent','generation':0,'eventId':eid}
        client=TestClient(app); headers={'X-Orgtree-Desktop-Token':'operator'}
        with patch.object(supervisor,'send_message',return_value={'accepted':True}) as drive:
            sent=client.post('/api/orgs/pending/nodes/agent/message',headers=headers,
                json={'text':'reply body','reply_to':{'source_event_ref':ref,'quoted_context':'untrusted client quote'}})
        self.assertEqual(sent.status_code,200,sent.text)
        drive.assert_called_once()
        canonical=store.load_org('pending').d['mail']['agent'][-1]['reply_to']
        self.assertEqual(canonical['quoted_context'],'canonical thought')
        self.assertEqual(client.get('/api/orgs/pending/nodes/agent/chat').status_code,401)
        response=client.get('/api/orgs/pending/nodes/agent/chat',headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertIn('application/json',response.headers['content-type'])
        row=next(row for row in response.json()['pending_mail'] if row['body']=='reply body')
        self.assertEqual(row['reply_to'],canonical)
        self.assertEqual(row['reply_to']['source_event_ref']['generation'],0)

if __name__=='__main__': unittest.main()
