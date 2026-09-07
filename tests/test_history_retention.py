"""Behavioral retention checks run in separate processes on private data roots.

Every child gets HOME, USERPROFILE and ORGTREE_DATA before any storage import.
The second child reopens the first child's files, exercising actual restart.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]

SEED = r'''
import json
from pathlib import Path
from orgtree import store, ledger, supervisor, turnlog
assert Path(store.DATA_ROOT).resolve() == Path(__import__('os').environ['ORGTREE_DATA']).resolve()
org = store.create_org('retention')
org.hire('@user', None, 'haiku', 0, 'agent')
# Equal timestamps deliberately attack tie boundaries, rather than assuming
# that millisecond timestamps are unique under a burst.
ledger.now = lambda: '2026-09-07T20:00:00.000Z'
for i in range(135):
    org.post_mail('@user', 'agent', f'mail-{i}')
for i in range(115):
    org.to_user_inbox({'from': 'agent', 'body': f'user-{i}', 'kind': 'notice', 'at': ledger.now()})
for i in range(205):
    org._org_inbox_log('in', '@org:fixture', f'org-{i}')
for i in range(825):
    org._notify(['agent'], f'notice-{i}')
ids = []
for i in range(105):
    ids.append(org.present_document('agent', f'doc-{i}', f'# retained body {i}')['presented'])
store.save_org(org)
for i in range(45):
    supervisor._log_turn_error('retention', 'agent', f'error-{i}')
for i in range(55):
    supervisor._steer_fold_log('retention', 'agent', 1, 'test', 'fixture', text=f'receipt-{i}')
for i in range(65):
    rec = turnlog.start(store.DATA_ROOT, 'retention', 'agent', lane='codex')
    assert rec and rec.close(outcome='completed')
org = store.load_org('retention')
# The provider journal is a real on-disk transcript, not a mocked reader.
journal = Path(supervisor.journal_store(), 'projects', 'retention')
journal.mkdir(parents=True, exist_ok=True)
with (journal / (org.node('agent')['session_id'] + '.jsonl')).open('w', encoding='utf-8') as f:
    for i in range(1005):
        f.write(json.dumps({'type':'assistant', 'uuid':f'chat-{i}', 'timestamp':ledger.now(),
                           'message':{'role':'assistant','content':[{'type':'text','text':f'chat-{i}'}]}}) + '\n')
for i in range(25):
    supervisor._charge_reported_spend('retention','agent',0.1)
org = store.load_org('retention')
org.watchdog_create('agent', 'retention-watch', 'file', str(Path(store.DATA_ROOT, 'watch.log')))
wid = org.d['watchdogs'][0]['id']
for i in range(org.WATCHDOG_EVENTS_KEEP + 5):
    org.watchdog_fire(wid, f'watch-{i}', f'watch body {i}')
store.save_org(org)
Path(store.DATA_ROOT, 'ids.json').write_text(json.dumps(ids))
print('seeded overflow through production writers')
'''

CHECK = r'''
import json
from pathlib import Path
from fastapi.testclient import TestClient
from orgtree import store, api
client = TestClient(api.app)
ids = json.loads(Path(store.DATA_ROOT, 'ids.json').read_text())
def all_rows(section, size=17):
    cursor = ''
    result = []
    while True:
        response = client.get(f'/api/orgs/retention/history/{section}', params={'node':'agent', 'limit':size, 'cursor':cursor})
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page['items']) <= size
        result.extend(page['items'])
        cursor = page['next_cursor']
        if not cursor:
            assert len(result) == page['total'], (section, len(result), page['total'])
            return result
for section, expected, first in [('node-mail',135,'mail-0'),('user-mail',115,'user-0'),('user-sent',135,'mail-0'),('org-mail',205,'org-0')]:
    rows = all_rows(section)
    assert len(rows) >= expected, (section,len(rows))
    assert rows[-1]['body'] == first
    assert len({r['id'] for r in rows}) == len(rows)
assert len(all_rows('notices',113)) >= 825
assert any(r['text']=='notice-0' for r in all_rows('notices',113))
assert len(all_rows('documents')) == 105
assert all_rows('documents')[-1]['body'] == '# retained body 0'
assert len(all_rows('errors')) == 45
assert all_rows('errors')[-1]['text']=='error-0'
assert len(all_rows('steered')) == 55
assert all_rows('steered')[-1]['text']=='receipt-0'
assert len(all_rows('turn-records')) == 65
chat = all_rows('chat', 100)
assert any(r.get('text') == 'chat-0' for r in chat)
assert any(r.get('text') == 'chat-1004' for r in chat)
assert len([r for r in chat if r.get('text','').startswith('chat-')]) == 1005
assert len(all_rows('turns')) == 25
watch = all_rows('watchdogs')
assert watch[-1]['body'] == 'watch body 0'
assert len(watch) == store.load_org('retention').WATCHDOG_EVENTS_KEEP + 5
assert client.get(f'/api/orgs/retention/documents/{ids[0]}').json()['body']=='# retained body 0'
assert len(client.get('/api/orgs/retention/history/node-mail',params={'node':'agent','limit':9999}).json()['items']) == 100
assert len(client.get('/api/orgs/retention/history/node-mail',params={'node':'agent','limit':0}).json()['items']) == 1
old_mail = all_rows('node-mail')[-1]
found = client.get(f"/api/orgs/retention/mail/node/{old_mail['id']}", params={'node':'agent'}).json()
assert found['found'] and found['mail']['body']=='mail-0'
missing = client.get('/api/orgs/retention/mail/node/missing', params={'node':'agent'}).json()
assert missing['found'] is False
# Tree remains a preview, even with all 105 durable documents.
tree = store.load_org('retention').tree()
assert len(tree['roots'][0]['documents']) == 10
assert tree['roots'][0]['documents_count'] == 105
assert len(tree['roots'][0]['turns']) == 8
assert len(tree['watchdogs'][0]['events']) == store.load_org('retention').WATCHDOG_EVENTS_KEEP
assert all('body' not in r for r in tree['roots'][0]['documents'])
gallery = client.get('/api/orgs/retention/documents').json()
assert len(gallery['documents']) == 100 and gallery['total'] == 105
older = client.get('/api/orgs/retention/documents', params={'offset':100}).json()
assert len(older['documents']) == 5 and older['next_offset'] is None
print('restart, overflow, old exact reads, tied pages and bounded graph verified')
'''

class HistoryRetentionTests(unittest.TestCase):
    def child(self, root: Path, code: str, backend: str = 'sqlite') -> None:
        data, home = root / 'data', root / 'home'
        data.mkdir(exist_ok=True); home.mkdir(exist_ok=True)
        env = dict(os.environ, ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                   ORGTREE_STORE=backend, PYTHONPATH=str(REPO / 'engine' / 'backend'),
                   PYTHONIOENCODING='utf-8', ORGTREE_V2='1')
        result = subprocess.run([sys.executable, '-c', code], cwd=REPO, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_sqlite_overflow_and_restart_via_product_apis(self):
        with tempfile.TemporaryDirectory(prefix='v2-history-') as temp:
            root = Path(temp)
            self.child(root, SEED)
            self.child(root, CHECK)

    def test_json_rollback_retains_same_history(self):
        with tempfile.TemporaryDirectory(prefix='v2-history-json-') as temp:
            root = Path(temp)
            self.child(root, SEED, 'json')
            self.child(root, CHECK, 'json')

    def test_user_read_routes_keep_overflow_and_old_sqlite_document_blobs(self):
        with tempfile.TemporaryDirectory(prefix='v2-history-read-') as temp:
            self.child(Path(temp), r'''
import json
from fastapi.testclient import TestClient
from orgtree import store, api
org=store.create_org('read')
org.hire('@user',None,'haiku',0,'agent')
for i in range(110):
    org.to_user_inbox({'from':'agent','body':str(i),'kind':'message','at':f'{i:04d}'})
ids=[row['id'] for row in org.d['user_inbox']]
doc=org.present_document('agent','legacy','legacy body')['presented']
store.save_org(org)
client=TestClient(api.app)
assert client.post('/api/orgs/read/inbox/read',json={'ids':ids[:105]}).status_code==200
assert len(store.load_org('read').d['user_mail_log'])==105
assert client.post('/api/orgs/read/inbox/clear').status_code==200
assert len(store.load_org('read').d['user_mail_log'])==110
# Simulate a valid pre-retention SQLite document that still stores docs as
# a blob. The reader must work before AND after the normal row migration.
with store._POOL.acquire('read') as conn:
    documents=[json.loads(row[0]) for row in conn.execute("SELECT val FROM log_l WHERE sect='documents'")]
    conn.execute("INSERT INTO doc(key,val) VALUES('documents',?)",(json.dumps(documents),))
    conn.execute("DELETE FROM log_l WHERE sect='documents'")
    conn.commit()
assert client.get('/api/orgs/read/history/documents').json()['items'][0]['body']=='legacy body'
org=store.load_org('read');store.save_org(org)
assert client.get(f'/api/orgs/read/documents/{doc}').json()['body']=='legacy body'
assert client.get('/api/orgs/read/history/documents').json()['items'][0]['body']=='legacy body'
''')

    def test_paging_append_manual_removal_and_invalid_inputs(self):
        with tempfile.TemporaryDirectory(prefix='v2-history-cursor-') as temp:
            self.child(Path(temp), r'''
from fastapi.testclient import TestClient
from orgtree import store, api
org = store.create_org('pages')
org.hire('@user',None,'haiku',0,'agent')
ids = [org.present_document('agent',str(i),str(i))['presented'] for i in range(7)]
store.save_org(org)
client = TestClient(api.app)
url='/api/orgs/pages/history/documents'
p1=client.get(url,params={'limit':3}).json()
assert [r['body'] for r in p1['items']]==['6','5','4']
org=store.load_org('pages')
org.present_document('agent','new','new')
store.save_org(org)
p2=client.get(url,params={'limit':3,'cursor':p1['next_cursor']}).json()
assert [r['body'] for r in p2['items']]==['3','2','1']
p3=client.get(url,params={'limit':3,'cursor':p2['next_cursor']}).json()
assert [r['body'] for r in p3['items']]==['0'] and p3['next_cursor'] is None
# Manual dismissal really removes a body from storage, unlike overflow.
org=store.load_org('pages');org.dismiss_document(ids[0]);store.save_org(org)
assert client.get(f'/api/orgs/pages/documents/{ids[0]}').status_code==404
assert '0' not in [r['body'] for r in client.get(url).json()['items']]
org=store.load_org('pages');org.dismiss_document(ids[4]);store.save_org(org)
assert client.get(url,params={'cursor':p1['next_cursor']}).status_code==409
assert client.get(url,params={'cursor':'!bad'}).status_code==422
assert client.get('/api/orgs/pages/history/node-mail',params={'node':'../escape'}).status_code==404
assert client.get('/api/orgs/pages/history/credentials').status_code==404
assert client.get(url,params={'limit':0}).json()['items']
org=store.load_org('pages');org.hire('@user',None,'haiku',0,'other')
org.present_document('other','foreign','foreign');store.save_org(org)
filtered=client.get('/api/orgs/pages/documents',params={'node':'agent','limit':2}).json()
assert len(filtered['documents'])==2 and all(r['node']=='agent' for r in filtered['documents'])
assert filtered['total']==6 and filtered['next_offset']==2
assert len(client.get(url,params={'limit':9999}).json()['items'])<=100
''')

if __name__ == '__main__':
    unittest.main()


