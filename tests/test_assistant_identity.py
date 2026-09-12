"""Assistant lifecycle against real isolated SQLite, journal and API projection."""
import json
import ast
from contextlib import contextmanager
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

fixture = tempfile.TemporaryDirectory(prefix='orgtree-assistant-identity-')
os.environ['ORGTREE_DATA'] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import assistant_messages as identity, ledger, store, supervisor as sup


class AssistantIdentityTests(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org('assistant-' + uuid.uuid4().hex[:8])
        self.org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(self.org)
        self.slug = self.org.d['slug']
        self.sid = self.org.node('agent')['session_id']
        self.scope = identity.scope(self.org, 'agent')
        self.st = sup.state(self.slug, 'agent')
        self.st['busy'] = True
        self.frames = []
        stream = patch.object(sup, 'stream', side_effect=lambda slug, nid, row:
            self.frames.append(sup.capture_reply_stream(slug, nid, row)))
        stream.start()
        self.addCleanup(stream.stop)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))

    def mid(self, item, provider='codex'):
        return identity.identity(self.scope, provider, item)

    def adapter(self, parent, names, extra):
        # Execute the production event callbacks with an isolated journal and
        # transport. No copied adapter implementation and no provider process.
        tree = ast.parse(Path(sup.__file__).read_text(encoding='utf-8'))
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == parent)
        definitions = [n for n in function.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.assertEqual({n.name for n in definitions}, set(names))
        code = ast.Module(body=[ast.ImportFrom(module='__future__',
            names=[ast.alias(name='annotations')], level=0), *definitions], type_ignores=[])
        env = dict(vars(sup), assistant_messages=identity, assistant_scope=self.scope,
            org=self.org, n=self.org.node('agent'), nid='agent', slug=self.slug, st=self.st, trec=None,
            _journal_records=lambda recs: [self.journal(rec) for rec in recs],
            _visible_live_row=lambda row: sup.live_row(self.slug, 'agent', row),
            _visible_stream=lambda row: sup.stream(self.slug, 'agent', row), **extra)
        exec(compile(ast.fix_missing_locations(code), sup.__file__, 'exec'), env)
        return env

    def test_first_codex_thread_is_adopted_before_held_assistant_output(self):
        tid = str(uuid.uuid4())
        mid = identity.identity(identity.scope(self.org, 'agent', session_id=tid), 'codex', 'turn:item')
        env = self.adapter('_codex_leg_attempt',
            ['_visible','_assistant_payload','_visible_stream','_visible_live_row','_journal_records','_open_journal'],
            {'jstate':{'sid':'','barrier':True,'pending':[],'held':[]},
             'emit_lock':threading.Lock(),'jlock':threading.Lock(),
             'text':'prompt','turn_view':'prompt','view_spans':None,'view_segments':None,'t0':time.time()})
        env['_visible_stream']({'kind':'delta','text':'first partial','assistant_id':mid})
        self.assertEqual(self.frames, [])
        env['_open_journal'](tid)
        self.assertEqual(store.load_org(self.slug).node('agent')['session_id'], tid)
        self.assertEqual(self.frames[0]['assistant_row']['assistant_scope'], identity.scope(self.org, 'agent'))
        self.assertEqual([r['text'] for r in self.prose()], ['first partial'])

    def test_codex_raw_notifications_keep_item_identity_through_batch_and_replay(self):
        batch = identity.TextBatcher(lambda mid, text: sup.stream(self.slug, 'agent',
            {'kind':'delta', 'assistant_id':mid, 'text':text}))
        self.addCleanup(batch.flush)
        env = self.adapter('_codex_leg_attempt',
            ['_assistant_item', '_first_time', '_event_ts', '_on_item', '_on_event'],
            {'assistant_attempt':'attempt', 'assistant_items':{}, 'assistant_anonymous':{}, 'codex_model':'test',
             'jlock':threading.Lock(), 'jstate':{'item_events':0,'item_ids':set(),'agent_items':0},
             '_flush_draft':batch.flush, '_queue_delta':batch.add,
             '_on_plan':lambda *args:None, '_drain_plan_pending':lambda:None})
        def delta(turn, item, text):
            env['_on_event']({'method':'item/agentMessage/delta',
                'params':{'turnId':turn, 'itemId':item, 'delta':text}})
        def done(turn, item, text):
            env['_on_event']({'method':'item/completed',
                'params':{'turnId':turn, 'item':{'id':item,'type':'agentMessage','text':text}}})
        delta('turn-1','item','first')
        delta('turn-1','other','second')
        batch.flush()
        self.assertEqual([r['text'] for r in self.prose()], ['first','second'])
        done('turn-1','item','first final')
        done('turn-1','item','first final')
        done('turn-1','other','second final')
        delta('turn-1','item','late fragment')
        batch.flush()
        self.assertEqual(sorted(r['text'] for r in self.prose()), ['first final','second final'])
        done('turn-2','item','first final')
        self.assertEqual(len(self.prose()), 3, 'reused item id in another turn is distinct')
        delta('turn-2', None, 'without item id')
        done('turn-2', None, 'without item id')
        done('turn-2', None, 'without item id')
        self.assertEqual([r['text'] for r in self.prose()].count('without item id'), 2)

    def test_antigravity_steps_batch_and_commit_partial_errors_by_step_identity(self):
        batch = identity.TextBatcher(lambda mid, text: sup.stream(self.slug, 'agent',
            {'kind':'delta','assistant_id':mid,'text':text}))
        self.addCleanup(batch.flush)
        env = self.adapter('_antigravity_leg',
            ['_item_id','_committed','_mark_committed','_commit_text','_d','_on_event_admitted'],
            {'turn_token':'turn-token','model_id':'test', 'jlock':threading.Lock(),
             'jstate':{'item_ids':set(),'agent_items':0,'text_drained':False,
                       'text_open':{},'text_order':[]},
             '_flush_draft':batch.flush,'_queue_delta':batch.add})
        def event(index, state, text=''):
            env['_on_event_admitted']({'event':'step_update','step_update':
                {'step_type':'agent_response','step_index':index,'state':state,'text_delta':text}})
        event(0,'ACTIVE','first')
        event(1,'ACTIVE','second')
        event(1,'ERROR')
        event(0,'DONE')
        event(0,'DONE')
        event(0,'ACTIVE','late')
        batch.flush()
        self.assertEqual([r['text'] for r in self.prose()], ['first','second'])
        self.assertEqual(len({r['assistant_id'] for r in self.prose()}),2)

    def delta(self, mid, text):
        return sup.capture_reply_stream(self.slug, 'agent',
            {'kind': 'delta', 'text': text, 'assistant_id': mid})['assistant_row']

    def journal(self, record):
        sup._codex_journal(self.slug, self.sid, [record],
                          incarnation=sup._transcript_incarnation(self.org, 'agent'))

    def complete(self, mid, text, *, emit=True):
        record, live = sup._paired_text_rows('2026-09-12T00:00:00Z', mid, 'gpt-test',
                                            text, assistant_id=mid)
        self.journal(record)
        if emit:
            sup.live_row(self.slug, 'agent', live)
        return record, live

    def chat(self, last=8):
        return sup.read_chat(self.org, 'agent', last=last, hold_back=False)

    def prose(self, last=8):
        return [r for r in self.chat(last)['messages'] if r['role'] == 'assistant' and r['text']]

    def test_draft_and_final_and_native_share_id_while_reply_ids_change(self):
        mid = self.mid('turn:item')
        first = self.delta(mid, 'alpha')
        second = self.delta(mid, ' beta')
        self.assertEqual(second['text'], 'alpha beta')
        self.assertEqual(first['assistant_id'], second['assistant_id'])
        self.assertNotEqual(first['event_id'], second['event_id'])
        self.assertGreater(second['assistant_revision'], first['assistant_revision'])
        self.assertEqual([r['text'] for r in self.prose()], ['alpha beta'])
        self.complete(mid, 'alpha beta gamma')
        rows = self.prose()
        self.assertEqual([r['text'] for r in rows], ['alpha beta gamma'])
        self.assertEqual(rows[0]['assistant_id'], mid)
        self.assertFalse(rows[0].get('assistant_pending'))
        for snapshot, quote in ((first, 'alpha'), (second, 'alpha beta')):
            ref = {'org':self.slug, 'agent':'agent', 'generation':0,
                   'eventId':snapshot['event_id']}
            self.assertEqual(sup.resolve_chat_event(self.org, 'agent', ref)[1], quote)
        self.assertFalse(self.chat()['live'])
        self.assertFalse(any(r['kind'] in ('delta', 'draft') for r in self.chat()['transient']))

    def test_native_record_before_completion_frame_is_already_a_receipt(self):
        mid = self.mid('before-frame')
        self.delta(mid, 'partial')
        _, live = self.complete(mid, 'final', emit=False)
        self.assertEqual([r['text'] for r in self.prose()], ['final'])
        sup.live_row(self.slug, 'agent', live)
        self.assertEqual([r['text'] for r in self.prose()], ['final'])

    def test_late_delta_and_duplicate_completion_cannot_reopen_final(self):
        mid = self.mid('late')
        self.delta(mid, 'before')
        record, live = self.complete(mid, 'complete')
        late = self.delta(mid, 'replayed old fragment')
        self.assertEqual(late['assistant_state'], 'complete')
        self.assertEqual(late['text'], 'complete')
        self.journal(record)  # provider/native record replay at a new byte offset
        sup.live_row(self.slug, 'agent', live)
        self.assertEqual([r['text'] for r in self.prose()], ['complete'])

    def test_identical_assistant_messages_and_timestamps_remain_distinct(self):
        a, b = self.mid('turn1:item'), self.mid('turn2:item')
        self.complete(a, 'continue')
        self.delta(b, 'continue')
        self.assertEqual(len(self.prose()), 2)
        self.complete(b, 'continue')
        rows = self.prose()
        self.assertEqual([r['text'] for r in rows], ['continue', 'continue'])
        self.assertEqual({r['assistant_id'] for r in rows}, {a, b})

    def test_restart_and_idle_keep_partial_then_native_replaces_it(self):
        mid = self.mid('interrupted')
        self.delta(mid, 'retained partial')
        sup.forget_state(self.slug, ['agent'])
        self.assertEqual([r['text'] for r in self.prose()], ['retained partial'])
        self.assertEqual(self.prose()[0]['assistant_state'], 'partial')
        # A different interpreter has no supervisor/cache/stream state.
        process = subprocess.run([sys.executable, '-c',
            'import json,sys; from orgtree import store,supervisor; '
            'print(json.dumps(supervisor.read_chat(store.load_org(sys.argv[1]), "agent")["messages"]))',
            self.slug], env={**os.environ, 'PYTHONPATH':str(Path(sup.__file__).parents[1])},
            capture_output=True, text=True, check=True, timeout=20)
        self.assertEqual([r['text'] for r in json.loads(process.stdout)], ['retained partial'])
        self.complete(mid, 'retained complete', emit=False)
        self.assertEqual([r['text'] for r in self.prose()], ['retained complete'])
        path = Path(sup.transcript_path_for_node(self.org, 'agent'))
        path.unlink()  # only this fixture's source; SQLite is now authoritative
        sup._chat_cache_clear()
        self.assertEqual([r['text'] for r in self.prose()], ['retained complete'])

    def test_paged_out_receipt_never_revives_an_old_snapshot(self):
        a = self.mid('old')
        self.delta(a, 'old partial')
        self.complete(a, 'old complete')
        self.prose()
        for i in range(15):
            self.complete(self.mid('new-' + str(i)), str(i))
        self.delta(a, 'late old text')
        self.assertNotIn(a, {r['assistant_id'] for r in self.prose(2)})

    def test_receipt_is_sent_even_when_no_window_ever_saw_the_native_row(self):
        mid = self.mid('native-first')
        self.complete(mid, 'saved before websocket', emit=False)
        self.prose()  # another window or reconnect reads the native record
        late = self.delta(mid, 'late old fragment')
        self.assertTrue(late['assistant_materialized'])
        self.assertEqual([r['text'] for r in self.prose()], ['saved before websocket'])

    def test_native_receipt_polling_does_not_keep_writing_the_database(self):
        from orgtree import transcript_records
        mid = self.mid('quiet')
        self.complete(mid, 'complete')
        self.prose()
        statements = []
        database = transcript_records.database
        @contextmanager
        def traced():
            with database() as conn:
                conn.set_trace_callback(statements.append)
                yield conn
        with patch.object(transcript_records, 'database', traced):
            identity.reconcile(self.scope, [{'assistant_id':mid, 'role':'assistant', 'text':'complete'}])
        self.assertTrue(any('assistant_receipts' in sql for sql in statements))
        self.assertFalse(any(sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for sql in statements))

    def test_known_other_native_id_never_retires_equal_live_text(self):
        self.complete(self.mid('one'), 'same text')
        sup.live_row(self.slug, 'agent', {'kind': 'text', 'text': 'same text',
                                         'event_id': str(uuid.uuid4())})
        self.assertEqual([r['text'] for r in self.chat()['live']], ['same text'])

    def test_claude_block_identity_is_same_before_and_after_native_projection(self):
        tracker = identity.ClaudeIdentity(self.scope)
        tracker.event({'type': 'message_start', 'message': {'id': 'claude-message'}})
        ids = []
        records = []
        for index, text in enumerate(['same words', 'same words']):
            mid = tracker.event({'type': 'content_block_start', 'index': index,
                                 'content_block': {'type': 'text'}})
            ids.append(mid)
            self.delta(mid, text)
            rec = {'type': 'assistant', 'uuid': str(uuid.uuid4()),
                   'timestamp': '2026-09-12T00:00:00Z',
                   'message': {'id': 'claude-message', 'role': 'assistant',
                               'content': [{'type': 'text', 'text': text}]}}
            self.assertEqual(tracker.frame(rec), [mid])
            self.journal(rec)
            records.append(rec)
        self.assertNotEqual(*ids)
        rows = self.prose()
        self.assertEqual([r['assistant_id'] for r in rows], ids)
        self.assertEqual([r['text'] for r in rows], ['same words', 'same words'])
        self.journal(records[0])
        self.assertEqual(len(self.prose()), 2)

    def test_multiblock_record_replaces_all_its_partial_blocks(self):
        tracker = identity.ClaudeIdentity(self.scope)
        tracker.event({'type': 'message_start', 'message': {'id': 'multi'}})
        mids = []
        for text in ['left', 'right']:
            mid = tracker.event({'type': 'content_block_start', 'content_block': {'type': 'text'}})
            mids.append(mid)
            self.delta(mid, text)
        rec = {'type': 'assistant', 'uuid': str(uuid.uuid4()),
               'message': {'id': 'multi', 'content': [
                   {'type': 'text', 'text': 'left'}, {'type': 'text', 'text': 'right'}]}}
        self.journal(rec)
        self.assertEqual(self.prose()[0]['assistant_ids'], mids)
        self.assertEqual([r['text'] for r in self.prose()], ['left\n\nright'])

    def test_claude_block_ids_survive_empty_blocks_and_tail_window_boundaries(self):
        tracker = identity.ClaudeIdentity(self.scope)
        tracker.event({'type':'message_start', 'message':{'id':'long-response'}})
        self.journal({'type':'user', 'message':{'role':'user','content':'prompt'}})
        mids = []
        for i in range(35):
            mid = tracker.event({'type':'content_block_start', 'content_block':{'type':'text'}})
            body = '' if i == 0 else 'part ' + str(i)
            record = {'type':'assistant', 'uuid':str(uuid.uuid4()),
                'message':{'id':'long-response', 'content':[{'type':'text', 'text':body}]}}
            self.assertEqual(tracker.frame(record), [mid] if body else [])
            if body:
                mids.append(mid)
                self.delta(mid, body)
            self.journal(record)
        for want in (3, 17, 4):
            sup._chat_cache_clear()
            rows = self.prose(want)
            self.assertEqual([row['assistant_id'] for row in rows], mids[-want:])
            self.assertTrue(all(not row.get('assistant_pending') for row in rows))

    def test_scope_survives_quote_clear_but_not_new_session(self):
        from orgtree import reply_events
        mid = self.mid('item')
        self.delta(mid, 'partial')
        reply_events.clear(self.org, 'agent')
        self.assertEqual(identity.scope(self.org, 'agent'), self.scope)
        self.org.node('agent')['session_id'] = str(uuid.uuid4())
        self.assertNotEqual(identity.identity(identity.scope(self.org, 'agent'), 'codex', 'item'), mid)

    def test_partial_survives_retire_rehire_and_stays_with_its_compacted_session(self):
        self.delta(self.mid('unfinished'), 'partial in predecessor')
        self.org.retire(ledger.USER, 'agent')
        store.save_org(self.org)
        self.assertEqual([r['text'] for r in self.prose()], ['partial in predecessor'])
        self.org.rehire(ledger.USER, 'agent')
        store.save_org(self.org)
        self.assertEqual(identity.scope(self.org, 'agent'), self.scope)
        predecessor = self.org.compact_split('agent', str(uuid.uuid4()))
        store.save_org(self.org)
        rows = sup.read_chat(self.org, predecessor, last=8)['messages']
        self.assertEqual([r['text'] for r in rows], ['partial in predecessor'])
        self.assertFalse(self.prose(), 'successor cannot adopt another session\'s partial')

    def test_partial_remains_reachable_through_older_pages(self):
        from orgtree.chat_window import read_page
        for i in range(5):
            self.complete(self.mid('before-' + str(i)), 'before ' + str(i))
        mid = self.mid('unfinished')
        self.delta(mid, 'unfinished between turns')
        # A later turn has its own distinct provider identities and timestamps.
        for i in range(15):
            record, live = sup._paired_text_rows('2026-09-13T00:00:00Z', str(i), 'test',
                'after ' + str(i), assistant_id=self.mid('after-' + str(i)))
            self.journal(record)
            sup.live_row(self.slug, 'agent', live)
        page = self.chat(3)
        found = list(page['messages'])
        seen = set()
        while page.get('before') and page['before'] not in seen:
            seen.add(page['before'])
            page = read_page(self.org, 'agent', 3, page['before'])
            found = page['messages'] + found
        self.assertEqual(sum(row.get('assistant_id') == mid for row in found), 1)
        self.assertEqual(len(found), 21)

    def test_partial_only_newest_page_still_reaches_native_history(self):
        from orgtree.chat_window import read_page
        self.complete(self.mid('earlier'), 'earlier native')
        self.delta(self.mid('unfinished'), 'unfinished')
        page = self.chat(1)
        self.assertEqual(page['messages'][0]['text'], 'unfinished')
        older = read_page(self.org, 'agent', 1, page['before'])
        self.assertEqual([row['text'] for row in older['messages']], ['earlier native'])

    def test_partial_only_history_pages_and_equal_timestamps_keep_order(self):
        from orgtree.chat_window import read_page
        mids = [self.mid(str(i)) for i in range(11)]
        for i, mid in enumerate(mids):
            identity.observe(self.scope, mid, str(i), '2026-09-12T00:00:00Z')
        page = self.chat(3)
        found = page['messages']
        while page.get('before'):
            page = read_page(self.org, 'agent', 3, page['before'])
            found = page['messages'] + found
        self.assertEqual([r['assistant_id'] for r in found], mids)
        self.complete(mids[1], '1', emit=False)
        self.complete(mids[0], '0', emit=False)
        self.assertEqual([r['assistant_id'] for r in self.prose(20)], mids)


if __name__ == '__main__':
    unittest.main()
