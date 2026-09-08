"""Live reply handover with real journals and snapshots, no provider process."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-reply-lifecycle-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, supervisor, store


class ReplyLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org('reply-' + self._testMethodName)
        self.org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(self.org)
        self.slug = self.org.d['slug']
        self.sid = self.org.node('agent')['session_id']
        self.st = supervisor.state(self.slug, 'agent')
        self.st['busy'] = True

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def emit(self, kind, text=''):
        return supervisor.capture_reply_stream(self.slug, 'agent', {'kind': kind, 'text': text})

    def chat(self):
        return supervisor.read_chat(self.org, 'agent', hold_back=False)

    def journal(self, identity, text):
        supervisor._codex_journal(self.slug, self.sid, [{
            'type': 'assistant', 'timestamp': '2026-09-08T18:42:23Z',
            'message': {'id': identity, 'role': 'assistant',
                        'content': [{'type': 'text', 'text': text}]}}])
        supervisor.live_row(self.slug, 'agent', {'kind': 'text', 'text': text})

    def test_draft_promotion_retires_scaffolding_but_keeps_exact_reply(self):
        self.emit('thinking_start')
        streamed = self.emit('delta', 'Same final reply')
        self.assertEqual(len(self.chat()['transient']), 2)
        self.journal('native-final-1', 'Same final reply')
        current = self.chat()
        self.assertEqual([r['text'] for r in current['messages']], ['Same final reply'])
        self.assertEqual(current['live'], [])
        self.assertEqual(current['transient'], [])
        ref = {'org': self.slug, 'agent': 'agent', 'generation': 0,
               'eventId': streamed['event_id']}
        self.assertEqual(supervisor.resolve_chat_event(self.org, 'agent', ref)[1], 'Same final reply')
        # Equal words from another native event remain a second real message.
        self.journal('native-final-2', 'Same final reply')
        self.assertEqual(len(self.chat()['messages']), 2)

    def test_tool_boundary_retires_thinking_without_dropping_draft(self):
        self.emit('thinking_start')
        self.emit('delta', 'Unfinished draft')
        supervisor.live_row(self.slug, 'agent', {'kind': 'tool', 'id': 'tool-1', 'text': 'Read'})
        rows = self.chat()['transient']
        self.assertEqual([r['kind'] for r in rows], ['delta'])
        self.assertEqual(rows[0]['text'], 'Unfinished draft')

    def test_idle_scaffolding_is_not_a_message_and_errors_remain(self):
        self.emit('thinking_start')
        self.emit('delta', 'Aborted unfinished draft')
        self.emit('error', 'Provider unavailable')
        self.st['busy'] = False
        rows = self.chat()['transient']
        self.assertEqual([(r['kind'], r['text']) for r in rows], [('error', 'Provider unavailable')])


if __name__ == '__main__':
    unittest.main()
