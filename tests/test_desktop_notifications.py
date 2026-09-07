import os
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient
_temp = tempfile.TemporaryDirectory(prefix='v2-notifications-')
data = Path(_temp.name)/'data'; data.mkdir()
home = Path(_temp.name)/'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data),HOME=str(home),USERPROFILE=str(home),ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'): os.environ.pop(key,None)
from engine.launch import load_app
app,*_ = load_app()
from orgtree import store, desktop_notifications

def tearDownModule():
    for slug in ('one','two'): store._POOL.close_all(slug)
    _temp.cleanup()

class NotificationsTests(unittest.TestCase):
    def test_cross_org_projection_dismissal_and_gate(self):
        first=store.create_org('one'); second=store.create_org('two')
        first.d['asks']=[{'id':'q1','node':'agent','status':'open','questions':[{'question':'answer me'}]}]
        second.d['user_inbox']=[{'id':'m1','from':'peer','urgent':True,'body':'urgent detail'}]
        second.d['work_items']=[{'slug':'needs-decision','title':'Work decision',
            'owner':{'node':'owner'},'manual_attention':{'set_rev':3,'reason':'Review this choice'}}]
        store.save_org(first); store.save_org(second)
        client=TestClient(app)
        self.assertEqual(client.get('/api/desktop/notifications').status_code,401)
        rows=client.get('/api/desktop/notifications',headers={'X-Orgtree-Desktop-Token':'operator'}).json()['notices']
        self.assertEqual({r['org'] for r in rows},{'one','two'})
        self.assertEqual({r['source_id'] for r in rows if 'source_id' in r},{'q1','m1'})
        self.assertEqual(next(r['body'] for r in rows if r.get('source_id')=='q1'),'answer me')
        work=next(r for r in rows if r['kind']=='work-attention')
        self.assertEqual((work['org'],work['agent'],work['item'],work['body']),
                         ('two','owner','needs-decision','Review this choice'))
        self.assertEqual([r['kind'] for r in rows],['question','urgent-mail','work-attention'])
        self.assertEqual(rows,desktop_notifications.notices()['notices'])
        self.assertTrue(desktop_notifications.notices(limit=1)['truncated'])
        first.d['asks'][0]['status']='answered'; store.save_org(first)
        self.assertEqual(len(desktop_notifications.notices()['notices']),2)
        second.d['work_items'][0].pop('manual_attention'); store.save_org(second)
        self.assertEqual([r['kind'] for r in desktop_notifications.notices()['notices']],['urgent-mail'])

if __name__ == '__main__': unittest.main()
