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
from orgtree.ledger import USER, Org

_orgs = []
def fixture_org(slug):
    org = store.create_org(slug)
    _orgs.append(slug)
    org.hire(USER, None, 'haiku', 0, 'agent', charter='fixture')
    return org

def tearDownModule():
    for slug in _orgs: store._POOL.close_all(slug)
    _temp.cleanup()

class NotificationsTests(unittest.TestCase):
    def test_cross_org_projection_dismissal_and_gate(self):
        first=fixture_org('one'); second=fixture_org('two')
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

    def test_question_lifecycle_and_urgent_read_state(self):
        org = fixture_org('lifecycle')
        org.ask_user('agent', 'Which approach?')
        store.save_org(org)
        def current():
            return [r for r in desktop_notifications.notices()['notices'] if r['org'] == 'lifecycle']
        notice = current()[0]
        self.assertEqual(notice['source_id'], org.node_ask('agent')['id'])
        self.assertEqual(notice['agent'], 'agent')
        org.ask_user('agent', 'Also choose a color?')
        store.save_org(org)
        self.assertEqual(len(current()), 1, 'amending an unresolved batch does not mint another alert')
        self.assertEqual(current()[0]['id'], notice['id'])
        org.withdraw_ask('agent'); store.save_org(org)
        self.assertEqual(current(), [])
        org.ask_user('agent', 'A new question?'); store.save_org(org)
        self.assertNotEqual(current()[0]['id'], notice['id'])
        ask = org.d['asks'][-1]
        for state in ('answered', 'withdrawn', 'moot', 'interrupted'):
            ask['status'] = state; store.save_org(org)
            self.assertEqual(current(), [], state)
        ask['status'] = 'open'
        org.node('agent')['state'] = 'archived'; store.save_org(org)
        self.assertEqual(current(), [], 'an obsolete request on a retired seat cannot alert')
        org.d['user_inbox'] = [{'id':'urgent','from':'agent','urgent':True,
            'urgent_reason':'A decision is needed now', 'body':'Longer details'}]
        store.save_org(org)
        self.assertEqual(current()[0]['body'], 'A decision is needed now')
        org.d['user_mail_log'] = org.d['user_inbox']; org.d['user_inbox'] = []
        store.save_org(org)
        self.assertEqual(current(), [], 'mail leaves the attention set when read')

    def test_pages_cover_all_attention_and_cleanup_sees_beyond_the_page(self):
        org = fixture_org('pages')
        org.d['user_inbox'] = [{'id':f'm{i}', 'from':'agent', 'urgent':True,
            'body':f'Action {i}'} for i in range(205)]
        store.save_org(org)
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token':'operator'}
        page = client.get('/api/desktop/notifications', headers=headers).json()
        self.assertEqual(len(page['notices']), 200)
        self.assertTrue(page['truncated'])
        self.assertEqual(len(page['active']), page['total'])
        more = client.get('/api/desktop/notifications?offset='+str(page['next_offset']), headers=headers).json()
        self.assertFalse(more['truncated'])
        self.assertIsNone(more['next_offset'])
        identities = {(r['org'], r['id']) for r in page['notices']+more['notices']}
        self.assertEqual(len(identities), page['total'])
        self.assertEqual(identities, {(r['org'], r['id']) for r in page['active']})

    def test_z_attention_is_an_effective_edge_across_rewrites_and_question_handoffs(self):
        org = fixture_org('attention-edges')
        item = {'slug': 'choose', 'title': 'Choose', 'owner': {'node': 'agent'},
                'manual_attention': {'set_rev': 7, 'reason': 'First'}}
        org.d['work_items'] = [item]
        store.save_org(org)
        def work():
            return [r for r in desktop_notifications.notices(limit=1000)['notices']
                    if r['org'] == 'attention-edges' and r['kind'] == 'work-attention']
        initial = work()[0]['id']
        # Loading a pre-feature record must capture its old epoch BEFORE the
        # first write rewrites the manual flag's independent dismissal stamp.
        item.pop('notification_attention_active')
        item.pop('notification_attention_epoch')
        org = Org(org.d)
        item['manual_attention'] = {'set_rev': 8, 'reason': 'Rewritten'}
        store.save_org(org)
        self.assertEqual(work()[0]['id'], initial)
        self.assertEqual(work()[0]['body'], 'Rewritten')
        org.d['asks'] = [{'id': 'attached', 'node': 'agent', 'status': 'open',
                         'questions': [{'question': 'Which?', 'work_item': 'choose'}]}]
        store.save_org(org)
        item['manual_attention'] = None
        store.save_org(org)
        self.assertEqual(work()[0]['id'], initial, 'attached question keeps effective attention set')
        org.d['asks'][0]['status'] = 'withdrawn'
        store.save_org(org)
        self.assertEqual(work(), [])
        # Reassert without any notification read between the two writes.
        item['manual_attention'] = {'set_rev': 9, 'reason': 'New decision'}
        store.save_org(org)
        self.assertNotEqual(work()[0]['id'], initial)
        final_id = work()[0]['id']
        restored = store.load_org('attention-edges')
        store.save_org(restored)
        self.assertEqual(work()[0]['id'], final_id)

    def test_z_document_identity_and_exact_gallery_page_survive_replacement_and_retirement(self):
        org = fixture_org('presentations')
        org.d['documents'] = [{'id': f'd{i}', 'node': 'agent', 'title': f'Plan {i}',
                              'at': f'2026-09-12T00:{i // 60:02}:{i % 60:02}Z', 'body': 'Plan body'} for i in range(105)]
        store.save_org(org)
        def document():
            return next(r for r in desktop_notifications.notices(limit=1000)['notices']
                        if r['org'] == 'presentations' and r.get('source_id') == 'd0')
        initial = document()['id']
        org.d['documents'][0]['title'] = 'Revised plan'
        org.nodes['agent']['state'] = 'archived'
        store.save_org(org)
        self.assertEqual(document()['id'], initial, 'updating one document is not a new presentation')
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token': 'operator'}
        page = client.get('/api/orgs/presentations/documents?locate=d0', headers=headers).json()
        self.assertEqual(page['offset'], 100)
        self.assertEqual(page['located'], 'd0')
        self.assertTrue(any(r['id'] == 'd0' and r['node_state'] == 'archived' for r in page['documents']))
        org.d['documents'] = org.d['documents'][1:]
        store.save_org(org)
        self.assertEqual(client.get('/api/orgs/presentations/documents?locate=d0', headers=headers).status_code, 404)
        self.assertNotIn(initial, [r['id'] for r in desktop_notifications.notices(limit=1000)['notices']])

    def test_z_frozen_identity_changes_on_refreeze_or_generation_and_retires_cleanly(self):
        org = fixture_org('freeze-edges')
        node = org.nodes['agent']
        node['generation'] = 3
        node['frozen'] = {'at': '2026-09-12T10:00:00Z'}
        store.save_org(org)
        def frozen():
            return [r for r in desktop_notifications.notices(limit=1000)['notices']
                    if r['org'] == 'freeze-edges' and r['kind'] == 'agent-frozen']
        initial = frozen()[0]
        self.assertEqual((initial['agent'], initial['generation']), ('agent', 3))
        node['frozen']['until'] = 'tomorrow'
        store.save_org(org)
        self.assertEqual(frozen()[0]['id'], initial['id'])
        node['frozen'] = None
        store.save_org(org)
        self.assertEqual(frozen(), [])
        node['frozen'] = {'at': '2026-09-12T11:00:00Z'}
        store.save_org(org)
        self.assertNotEqual(frozen()[0]['id'], initial['id'])
        second = frozen()[0]['id']
        node['generation'] = 4
        store.save_org(org)
        self.assertNotEqual(frozen()[0]['id'], second)
        node['state'] = 'archived'
        store.save_org(org)
        self.assertEqual(frozen(), [])

if __name__ == '__main__': unittest.main()
