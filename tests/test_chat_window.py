"""Lazy UI transcript reads: real files + persistent SQLite projection rows."""
import os
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

fixture=tempfile.TemporaryDirectory(prefix='orgtree-chat-window-')
os.environ['ORGTREE_DATA']=str(Path(fixture.name)/'data')
os.environ['HOME']=str(Path(fixture.name)/'home')
os.environ['USERPROFILE']=os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir();Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN']='window-test-only'
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'):os.environ.pop(key,None)
from engine.launch import load_app
application=load_app()[0]
from orgtree import store, ledger, supervisor as sup, chat_window

slugs=[]

def tearDownModule():
    for slug in slugs: store._POOL.close_all(slug)
    fixture.cleanup()

class WindowTests(unittest.TestCase):
    def setUp(self):
        slug='window-'+uuid.uuid4().hex[:8];slugs.append(slug)
        self.org=store.create_org(slug)
        self.org.hire(ledger.USER,None,'haiku',0,'agent')
        store.save_org(self.org)
        self.path=Path(fixture.name)/'transcript.jsonl'
        self.lookup=patch.object(sup,'transcript_path',return_value=str(self.path));self.lookup.start()
        self.addCleanup(self.lookup.stop)
        self.path.write_bytes(b'')
    def write(self,rows,mode='w'):
        with self.path.open(mode,encoding='utf-8') as f:
            for r in rows: f.write(json.dumps(r)+'\n')
    def rec(self,i,text=None,role='assistant'):
        return {'type':role,'uuid':f'id-{i}','timestamp':f'2026-09-10T12:{i//60%60:02d}:{i%60:02d}Z',
                'message':{'id':f'm-{i}','role':role,'content':text or f'message {i}'}}
    def read(self,n=8): return chat_window.read_window(self.org,'agent',n)
    def test_large_file_reads_tail_then_queries_sqlite_without_reparsing(self):
        self.write([self.rec(i, f'message {i} '+('x'*6000)) for i in range(7000)])
        first=self.read()
        self.assertEqual(len(first['messages']),8)
        self.assertTrue(first['has_older'])
        self.assertIn('message 6999',first['messages'][-1]['text'])
        self.assertLess(first['window_read']['bytes_read'],self.path.stat().st_size//20)
        self.assertLess(first['window_read']['records_parsed'],40)
        with patch.object(chat_window,'reverse_lines',side_effect=AssertionError('index hit must not reread source')):
            again=self.read()
        self.assertEqual(again['window_read']['index_hit'],1)
        self.assertEqual([m['event_id'] for m in first['messages']],[m['event_id'] for m in again['messages']])
        older=self.read(32)
        self.assertEqual(len(older['messages']),32)
        self.assertEqual([m['event_id'] for m in first['messages']],[m['event_id'] for m in older['messages'][-8:]])
    def test_append_replace_and_torn_tail_are_detected(self):
        self.write([self.rec(i) for i in range(40)])
        before=self.read()
        self.write([self.rec(40)],'a')
        self.assertEqual(self.read()['messages'][-1]['text'],'message 40')
        with self.path.open('ab') as f:f.write(b'{"type":"assistant",')
        self.assertEqual(self.read()['messages'][-1]['text'],'message 40')
        self.write([self.rec(500,'replacement')])
        replaced=self.read()
        self.assertEqual([m['text'] for m in replaced['messages']],['replacement'])
        self.assertFalse(replaced['has_older'])
        self.assertNotEqual(before['messages'][-1]['event_id'],replaced['messages'][-1]['event_id'])
    def test_tool_result_updates_its_visible_call(self):
        rows=[self.rec(i) for i in range(30)]
        call=self.rec(30);call['message']['content']=[{'type':'tool_use','id':'t1','name':'Bash','input':{'command':'echo hello'}}]
        rows.append(call);self.write(rows)
        self.read()
        result=self.rec(31,role='user');result['message']['content']=[{'type':'tool_result','tool_use_id':'t1','content':'hello'}]
        self.write([result],'a')
        after=self.read()
        self.assertEqual(after['messages'][-1]['tools'][0]['result'],'hello')
    def test_duplicate_occurrences_have_distinct_stable_ids(self):
        row=self.rec(1,'same');row.pop('uuid');row['message'].pop('id')
        self.write([row]*35)
        first=self.read(8);older=self.read(30)
        self.assertEqual(len({m['event_id'] for m in older['messages']}),30)
        self.assertEqual([m['event_id'] for m in first['messages']],[m['event_id'] for m in older['messages'][-8:]])

    def test_sidecar_uses_occurrence_before_echo_not_future_queued_copy(self):
        import hashlib
        raw='identical prompt'
        rows=[self.rec(i,raw,role='user') for i in range(40)]
        self.write(rows)
        sidecar=Path(sup._prompt_view_path(self.org.d['slug'],self.org.node('agent')['session_id']))
        sidecar.parent.mkdir(parents=True,exist_ok=True)
        views=[{'sha256':hashlib.sha256(raw.encode()).hexdigest(), 'chars':len(raw),
                'at':self.rec(i)['timestamp'], 'visible':f'visible {i}'} for i in range(41)]
        sidecar.write_text(''.join(json.dumps(v)+'\n' for v in views),encoding='utf-8')
        self.assertEqual([m['text'] for m in self.read(8)['messages']], [f'visible {i}' for i in range(32,40)])
        self.assertEqual(self.read(20)['messages'][-1]['text'],'visible 39')
        views[39]['visible']='corrected projection'
        sidecar.write_text(''.join(json.dumps(v)+'\n' for v in views),encoding='utf-8')
        self.assertEqual(self.read()['messages'][-1]['text'],'corrected projection')

    def test_imported_only_and_clone_merge_keep_distinct_records(self):
        archive=Path(fixture.name)/'archive.jsonl'
        archive.write_text(''.join(json.dumps(self.rec(i))+'\n' for i in range(6)),encoding='utf-8')
        with patch('orgtree.desktop_import.imported_history_path',return_value=str(archive)):
            with patch.object(sup,'transcript_path',return_value=None):
                imported=self.read(8)
            self.assertEqual(len(imported['messages']),6)
            self.assertTrue(all(m['imported_history'] for m in imported['messages']))
            self.write([self.rec(i) for i in range(6)] + [self.rec(6)])
            combined=self.read(20)
            self.assertEqual([m['text'] for m in combined['messages']],[f'message {i}' for i in range(7)])
            self.assertEqual(len({m['seq'] for m in combined['messages']}),7)
            self.write([self.rec(0,'changed native record')])
            self.assertEqual(len(self.read(20)['messages']),7)

    def test_empty_session_does_not_require_native_file(self):
        with patch.object(sup,'transcript_path',return_value=None):
            out=self.read()
        self.assertEqual(out['messages'],[])
        self.assertFalse(out['has_older'])
        self.assertTrue(out['windowed'])

    def test_http_route_uses_bounded_index_not_full_reader(self):
        from fastapi.testclient import TestClient
        self.write([self.rec(i) for i in range(100)])
        # No lifespan startup: the fixture may not start workers or providers.
        client=TestClient(application)
        with patch.object(sup,'read_chat',side_effect=AssertionError('full reader called')):
            response=client.get(f"/api/orgs/{self.org.d['slug']}/nodes/agent/chat?last=8",
                                headers={'X-Orgtree-Desktop-Token':'window-test-only'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(len(response.json()['messages']),8)
        self.assertTrue(response.json()['has_older'])
