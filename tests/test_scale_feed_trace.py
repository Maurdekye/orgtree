"""The opt-in diagnostic must preserve frames and expose missing evidence."""
import asyncio
import json
from types import SimpleNamespace
import unittest

import import_provenance  # noqa: F401
from tools.scale.feed_trace import Trace, install, marker


class FeedTraceTests(unittest.IsolatedAsyncioTestCase):
    def test_wait_totals_are_bounded_and_snapshot_is_detached(self):
        trace = Trace(limit=1)
        trace.wait_cost('ignored', 5, 1)
        trace.local.marker, trace.local.stage = 1, 'identity'
        trace.wait_cost('pg:SELECT', 20, 2)
        trace.wait_cost('pg:SELECT', 30, 3)
        trace.local.marker = 2
        trace.wait_cost('pg:SELECT', 99, 9)
        value = trace.snapshot()
        self.assertEqual(value['dropped'], 1)
        self.assertEqual(value['waits'][1]['identity:pg:SELECT'],
                         {'calls': 2, 'wall_ns': 50, 'thread_cpu_ns': 5})
        value['waits'][1]['identity:pg:SELECT']['calls'] = 99
        self.assertEqual(trace.snapshot()['waits'][1]['identity:pg:SELECT']['calls'], 2)

    def test_bounded_evidence_reports_overflow_without_payloads(self):
        trace = Trace(limit=2)
        trace.note('a', 1)
        trace.note('b', 1)
        trace.note('c', 1)
        trace.note('ignored', None)
        result = trace.snapshot()
        self.assertEqual(result['dropped'], 1)
        self.assertEqual([r['stage'] for r in result['rows']], ['a', 'b'])
        self.assertEqual(set(result['rows'][0]), {'stage', 'm', 'wall_ns', 'mono_ns', 'thread_cpu_ns', 'thread'})
        result['rows'].clear()
        self.assertEqual(len(trace.snapshot()['rows']), 2)

    async def test_wrappers_preserve_order_bytes_returns_and_thread_identity(self):
        sent = []
        class Socket:
            def __init__(self, window):
                self.window = window
            async def send_text(self, text):
                sent.append((self.window, text))
                await asyncio.sleep(0)

        class Hub:
            def __init__(self):
                self.sockets = []
            async def join(self, slug, ws, **kwargs):
                self.sockets.append(ws)
                return 'joined'
            async def _send(self, slug, payload):
                for ws in self.sockets:
                    await ws.send_text(json.dumps(payload, separators=(',', ':')))
                return 'sent'

        messages = SimpleNamespace(scope_ident=lambda *a: 'scope', observe=lambda *a: {'durable': True})
        replies = SimpleNamespace(identity=lambda *a: ('scope', 0), annotate_ident=lambda *a: 'annotated')
        store = SimpleNamespace(cached_org=lambda *a: 'org', read_stream_identity=lambda *a: 'fields')
        replies.store = store
        def capture(slug, nid, payload):
            self.assertEqual(store.cached_org(slug), 'org')
            self.assertEqual(store.read_stream_identity(slug, nid), 'fields')
            replies.identity(slug, nid)
            messages.scope_ident(slug, nid)
            messages.observe(payload)
            replies.annotate_ident(payload)
            return dict(payload, captured=True)
        supervisor = SimpleNamespace(capture_reply_stream=capture)
        api = SimpleNamespace(hub=Hub(), _ws_window_id=lambda ws: ws.window)
        trace = install(api, supervisor, messages, replies)
        for window in ('w0', 'w1'):
            self.assertEqual(await api.hub.join('org', Socket(window)), 'joined')
        expected = []
        for seq in (9, 3):
            # Intentionally descending IDs: instrumentation must not sort them.
            payload = await asyncio.to_thread(supervisor.capture_reply_stream, 'org', 'agent',
                                               {'text': f'[[m{seq}]] new'})
            self.assertTrue(payload['captured'])
            frame = {'type': 'node_stream', **payload, 'assistant_row': {'text': '[[m1]] old'}}
            expected.extend((window, json.dumps(frame, separators=(',', ':'))) for window in ('w0', 'w1'))
            self.assertEqual(await api.hub._send('org', frame), 'sent')
        self.assertEqual(sent, expected)
        rows = trace.snapshot()['rows']
        self.assertEqual({r['m'] for r in rows}, {9, 3})
        stages = ['capture_start', 'identity_start', 'identity_end', 'scope_start', 'scope_end',
                  'observe_start', 'observe_end', 'annotate_start', 'annotate_end', 'capture_end',
                  'hub_start', 'send_start', 'send_end', 'send_start', 'send_end', 'hub_end']
        for seq in (9, 3):
            own = [r for r in rows if r['m'] == seq]
            self.assertEqual([r['stage'] for r in own], stages)
            self.assertEqual([r['mono_ns'] for r in own], sorted(r['mono_ns'] for r in own))
            self.assertNotEqual(own[0]['thread'], own[-1]['thread'])
        before = len(rows)
        supervisor.capture_reply_stream('org', 'agent', {'text': 'unmarked'})
        await api.hub._send('org', {'type': 'changed'})
        self.assertEqual(len(trace.snapshot()['rows']), before)
        costs = trace.snapshot()['costs']
        for name in ('cached_org', 'read_stream_identity'):
            self.assertEqual(costs[name + ':all']['calls'], 3)
            self.assertEqual(costs[name + ':stream']['calls'], 2)
            self.assertGreaterEqual(costs[name + ':all']['thread_cpu_ns'],
                                    costs[name + ':stream']['thread_cpu_ns'])
        costs['cached_org:all']['calls'] = 99
        self.assertEqual(trace.snapshot()['costs']['cached_org:all']['calls'], 3)


if __name__ == '__main__':
    unittest.main()
