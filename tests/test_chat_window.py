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
    def test_committed_steer_frame_contains_the_same_saved_complete_row(self):
        frames=[]
        text='accepted words '+('x'*4000)
        with patch.object(sup,'stream',side_effect=lambda slug,nid,row:frames.append(row)):
            sup.commit_steer(self.org.d['slug'],'agent',[text],at='2026-09-10T12:10:00Z')
        self.org=store.load_org(self.org.d['slug'])
        wire=frames[0]['committed_row_raw']
        self.assertEqual(wire['text'],text)
        durable=self.read()['messages'][-1]
        self.assertEqual(wire['row_id'],durable['row_id'])
        self.assertEqual(wire['event_id'],durable['event_id'])
        self.assertEqual(wire['ts'],durable['ts'])
        with patch.object(store,'save_org',side_effect=OSError('simulated write failure')), patch.object(sup,'stream') as send:
            sup.commit_steer(self.org.d['slug'],'agent',['not durable'])
        self.assertNotIn('committed_row_raw',send.call_args.args[2])

    def test_committed_steer_wire_projects_each_socket_without_raw_event_leak(self):
        import asyncio
        from orgtree.api import Hub
        class Socket:
            def __init__(self): self.frames=[]
            async def send_json(self, row): self.frames.append(row)
        admin=Socket();visitor=Socket();hub=Hub()
        hub.rooms['room']={admin,visitor};hub.public.add(visitor)
        row={'role':'user','text':'visible','row_id':'same-id','segments':[
            {'kind':'mail','rows':[{'id':'mail-one','body':'visible',
                'ev_raw':{'private':'must stay internal'},
                'ev_error':{'code':'bad_structure','private':'details'}}]}]}
        asyncio.run(hub._send('room',{'kind':'steered','committed_row_raw':row}))
        self.assertNotIn('committed_row_raw',admin.frames[0])
        self.assertNotIn('committed_row_raw',visitor.frames[0])
        self.assertEqual(admin.frames[0]['committed_row']['row_id'],'same-id')
        self.assertEqual(visitor.frames[0]['committed_row']['row_id'],'same-id')
        ar=admin.frames[0]['committed_row']['segments'][0]['rows'][0]
        vr=visitor.frames[0]['committed_row']['segments'][0]['rows'][0]
        self.assertIn('ev_raw',ar,'operator control retains diagnostic provenance')
        self.assertNotIn('ev_raw',vr)
        self.assertEqual(vr['ev_error'],{'code':'bad_structure'})
        self.assertIn('ev_raw',row['segments'][0]['rows'][0],'projection does not mutate the stored record')

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
        self.assertEqual(replaced['messages'][-1]['text'],'replacement')
        self.assertIn('message 40', [m['text'] for m in replaced['messages']])
        self.assertTrue(replaced['has_older'])
        self.assertNotEqual(before['messages'][-1]['event_id'],replaced['messages'][-1]['event_id'])
    def test_tool_result_updates_its_visible_call(self):
        rows=[self.rec(i) for i in range(30)]
        call=self.rec(30);call['message']['content']=[{'type':'tool_use','id':'t1','name':'Bash','input':{'command':'echo hello'}}]
        rows.append(call);self.write(rows)
        before = self.read()
        result=self.rec(31,role='user');result['message']['content']=[{'type':'tool_result','tool_use_id':'t1','content':'hello'}]
        self.write([result],'a')
        after=self.read()
        self.assertEqual(after['messages'][-1]['tools'][0]['result'],'hello')
        self.assertEqual(after['messages'][-1]['row_id'], before['messages'][-1]['row_id'])
        self.assertEqual(after['messages'][-1]['seq'], before['messages'][-1]['seq'])

    def test_app_owned_history_is_read_after_compatibility_file_disappears(self):
        from orgtree import transcript_records
        node = self.org.node('agent')
        node['model'] = 'luna'
        slug, sid = self.org.d['slug'], node['session_id']
        journal = Path(sup.journal_store()) / 'projects' / slug / (sid + '.jsonl')
        sup._codex_journal(slug, sid, [self.rec(1, 'database-owned message')])
        journal.unlink()
        with patch.object(sup, 'transcript_path', return_value=None):
            first = self.read()
            self.assertEqual(first['messages'][-1]['text'], 'database-owned message')
            transcript_records.append_owned(slug, sid, journal, [self.rec(2, 'next database row')])
            second = self.read()
            self.assertEqual(second['messages'][-1]['text'], 'next database row')

    def test_imported_provider_rows_survive_file_deletion_and_projection_rebuild(self):
        self.write([self.rec(i) for i in range(12)])
        before = self.read()
        self.path.unlink()
        # Removing only the DERIVED index must not erase canonical history.
        (Path(store.DATA_ROOT) / 'chat-window-index.sqlite3').unlink()
        with patch.object(sup, 'transcript_path', return_value=None):
            after = self.read()
        self.assertEqual([m['event_id'] for m in before['messages']], [m['event_id'] for m in after['messages']])
        self.assertEqual([m['seq'] for m in before['messages']], [m['seq'] for m in after['messages']])
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
        sidecar.unlink()
        self.path.unlink()
        (Path(store.DATA_ROOT) / 'chat-window-index.sqlite3').unlink()
        with patch.object(sup, 'transcript_path', return_value=None):
            self.assertEqual(self.read()['messages'][-1]['text'], 'corrected projection')

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
            self.assertEqual(len(self.read(20)['messages']),8)

    def test_empty_session_does_not_require_native_file(self):
        with patch.object(sup,'transcript_path',return_value=None):
            out=self.read()
        self.assertEqual(out['messages'],[])
        self.assertFalse(out['has_older'])
        self.assertTrue(out['windowed'])

    def test_cursor_reads_only_older_page_and_keeps_existing_sequence(self):
        self.write([self.rec(i) for i in range(400)])
        newest = self.read(8)
        page = chat_window.read_page(self.org, 'agent', 8, newest['before'])
        self.assertEqual([m['text'] for m in page['messages']], [f'message {i}' for i in range(384,392)])
        self.assertLess(page['window_read']['records_parsed'], 40)
        self.assertLess(page['messages'][-1]['seq'], newest['messages'][0]['seq'])
        next_page = chat_window.read_page(self.org, 'agent', 8, page['before'])
        self.assertEqual([m['text'] for m in next_page['messages']], [f'message {i}' for i in range(376,384)])
        again = self.read(8)
        self.assertEqual([m['seq'] for m in again['messages']], [m['seq'] for m in newest['messages']])
        self.assertEqual(len({m['row_id'] for m in next_page['messages'] + page['messages'] + newest['messages']}),24)

    def test_cursor_rejects_other_conversation(self):
        self.write([self.rec(i) for i in range(40)])
        before = self.read()['before']
        self.org.node('agent')['session_id'] = 'different-session'
        with self.assertRaises(ValueError):
            chat_window.read_page(self.org, 'agent', 8, before)

    def test_older_page_keeps_tool_result_from_a_later_page(self):
        call = self.rec(10)
        call['message']['content'] = [{'type':'tool_use','id':'later-result','name':'Read','input':{'file_path':'example'}}]
        self.write([self.rec(i) for i in range(10)] + [call])
        self.read()
        result = self.rec(20, role='user')
        result['message']['content'] = [{'type':'tool_result','tool_use_id':'later-result','content':'completed result'}]
        self.write([self.rec(i) for i in range(11,20)] + [result] + [self.rec(i) for i in range(21,32)], 'a')
        current = self.read(8)
        while not any(row.get('tools') for row in current['messages']):
            self.assertTrue(current['before'], 'call must remain reachable through history pages')
            current = chat_window.read_page(self.org, 'agent', 8, current['before'])
        tool = next(row['tools'][0] for row in current['messages'] if row.get('tools'))
        self.assertEqual(tool['result'], 'completed result')

    def test_cursor_crosses_import_boundary_without_repeating_clone_rows(self):
        archive = Path(fixture.name) / 'cursor-archive.jsonl'
        archive.write_text(''.join(json.dumps(self.rec(i))+'\n' for i in range(30)), encoding='utf8')
        for cloned in (False, True):
            with self.subTest(cloned=cloned):
                self.org.node('agent')['session_id'] = uuid.uuid4().hex
                self.write([self.rec(i) for i in range(0 if cloned else 30,40)])
                with patch('orgtree.desktop_import.imported_history_path', return_value=str(archive)):
                    page = self.read(8)
                    all_rows = page['messages']
                    for _ in range(20):
                        if not page['before']:
                            break
                        page = chat_window.read_page(self.org, 'agent', 8, page['before'])
                        all_rows = page['messages'] + all_rows
                    else:
                        self.fail('paging did not terminate')
                self.assertEqual([row['text'] for row in all_rows], [f'message {i}' for i in range(40)])

    def test_concurrent_append_during_projection_is_not_pinned_stale(self):
        # review F2: a record committed between the projection's row read and
        # its version snapshot must appear on the VERY NEXT read — the cache
        # is stored under the pre-projection version, so any mid-projection
        # advance is a mismatch and rebuilds, never a hit over missing rows.
        from orgtree import transcript_records
        node = self.org.node('agent')
        node['model'] = 'luna'
        slug, sid = self.org.d['slug'], node['session_id']
        journal = Path(sup.journal_store()) / 'projects' / slug / (sid + '.jsonl')
        sup._codex_journal(slug, sid, [self.rec(1, 'first')])
        journal.unlink()          # absent mirror: file version stays constant
        raced = {'done': False}
        original_tail = transcript_records.tail

        def racy_tail(source, count, before=None):
            out = original_tail(source, count, before=before)
            if not raced['done']:
                raced['done'] = True
                transcript_records.append_owned(slug, sid, journal,
                                                [self.rec(2, 'raced')])
            return out
        with patch.object(sup, 'transcript_path', return_value=None):
            with patch.object(transcript_records, 'tail', side_effect=racy_tail):
                during = self.read()
            self.assertEqual(during['messages'][-1]['text'], 'first',
                             'control: the raced record landed after the row read')
            after = self.read()
        self.assertEqual(after['messages'][-1]['text'], 'raced',
                         'a record appended during projection appears on the next read')

    def test_prompt_views_survive_sidecar_loss_for_never_displayed_history(self):
        # coordinator scope 2026-09-10 17:28: display captures the sidecar
        # into the durable index, so prompts whose occurrences were NEVER
        # matched on screen still project after the sidecar disappears —
        # retained per-offset views alone cannot answer for those.
        import hashlib
        raw = 'identical prompt'
        self.write([self.rec(i, raw, role='user') for i in range(30)])
        sidecar = Path(sup._prompt_view_path(self.org.d['slug'],
                                             self.org.node('agent')['session_id']))
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        sidecar.write_text(''.join(
            json.dumps({'sha256': digest, 'at': self.rec(i)['timestamp'],
                        'visible': f'visible {i}'}) + '\n'
            for i in range(30)), encoding='utf-8')
        first = self.read(2)      # displays (and retains) only the newest few
        self.assertIn('visible', first['messages'][-1]['text'])
        sidecar.unlink()
        (Path(store.DATA_ROOT) / 'chat-window-index.sqlite3').unlink()
        wide = self.read(30)      # needs occurrences never displayed before
        self.assertEqual([m['text'] for m in wide['messages']],
                         [f'visible {i}' for i in range(30)],
                         'unseen history keeps its human projection without the sidecar')

    def test_payloads_carry_the_order_epoch(self):
        self.write([self.rec(i) for i in range(40)])
        newest = self.read(8)
        self.assertIn('order_epoch', newest)
        page = chat_window.read_page(self.org, 'agent', 8, newest['before'])
        self.assertIn('order_epoch', page)
        self.assertEqual(page['order_epoch'], newest['order_epoch'])

    def test_http_route_uses_bounded_index_not_full_reader(self):
        from fastapi.testclient import TestClient
        self.write([self.rec(i) for i in range(100)])
        # No lifespan startup: the fixture may not start workers or providers.
        client=TestClient(application)
        with patch.object(sup,'_read_chat_legacy',side_effect=AssertionError('full reader called')):
            response=client.get(f"/api/orgs/{self.org.d['slug']}/nodes/agent/chat?last=8",
                                headers={'X-Orgtree-Desktop-Token':'window-test-only'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(len(response.json()['messages']),8)
        self.assertTrue(response.json()['has_older'])
