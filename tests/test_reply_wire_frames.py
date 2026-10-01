"""Prose delta frames on the websocket carry only the new text.

`capture_reply_stream` returns the whole message so far in `assistant_row`.
Sent as-is, every delta frame was as long as the reply up to that point, so
the bytes of one reply grew with the square of its length: 234 KB mean
screen-feed frames, a 448 MB websocket send queue and 16% missed feed markers
at N1000 (scale item evidence #36, attempt 10 on v3 415aa30).

`supervisor.wire_reply_frame` is the websocket boundary. These tests pin its
three promises: a delta frame's size does not depend on how much of the reply
came before it; a client that appends each fragment to the revision it names
rebuilds exactly the row `capture_reply_stream` produced (text, reply quote,
event id); and every frame that is not an appending prose delta is sent
unchanged, so a first frame, a completion, a reset or a late frame still
carries the full row.
"""
import ast
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

fixture = tempfile.TemporaryDirectory(prefix='orgtree-reply-wire-frames-')
os.environ['ORGTREE_DATA'] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import assistant_messages, ledger, reply_events, store, supervisor as sup

REPO = Path(__file__).resolve().parents[1]


def size(frame):
    return len(json.dumps(frame, ensure_ascii=False).encode())


class Client:
    """What the renderer does with a delta row (assistantMessages.ts
    applyAssistantDelta): append onto the row whose revision it names."""

    def __init__(self):
        self.rows = {}

    def take(self, frame):
        row = frame['assistant_row']
        mid = row['assistant_id']
        if not row.get('assistant_delta'):
            self.rows[mid] = dict(row)
            return 'full'
        base = self.rows.get(mid)
        if base is None or base['assistant_revision'] != row['assistant_base_revision']:
            return 'gap'
        merged = {k: v for k, v in row.items()
                  if k not in ('assistant_delta', 'assistant_base_revision')}
        merged['text'] = base['text'] + row['text']
        merged['reply_quote'] = row.get('reply_quote', base['reply_quote'])
        self.rows[mid] = merged
        return 'delta'


class WireFrameTests(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org('wire-' + uuid.uuid4().hex[:8])
        self.org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(self.org)
        self.slug = self.org.d['slug']
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.addCleanup(reply_events._ident_forget)
        self.addCleanup(assistant_messages._scope_forget)
        reply_events._ident_forget()
        assistant_messages._scope_forget()

    def capture(self, **payload):
        return sup.capture_reply_stream(self.slug, 'agent', payload)

    def stream(self, mid, pieces):
        """(captured, wire) for each piece, as api.stream would send them."""
        out = []
        for piece in pieces:
            captured = self.capture(kind='delta', text=piece, assistant_id=mid)
            out.append((captured, sup.wire_reply_frame(captured)))
        return out

    def test_delta_frame_size_does_not_grow_with_the_reply(self):
        mid = 'm-' + uuid.uuid4().hex
        piece = 'x' * 399 + '\n'
        frames = self.stream(mid, [piece] * 100)          # a 40 KB reply
        captured = [size(c) for c, _ in frames]
        wire = [size(w) for _, w in frames]
        # the control: what used to be sent grows with the reply
        self.assertGreater(captured[-1], 40_000)
        # past the 4000-char quote cap a frame is the fragment plus fixed fields
        tail = wire[11:]
        self.assertLess(max(tail), 2_000, tail)
        self.assertLess(max(tail) - min(tail), 64)
        # while the quote can still change it rides along, bounded by 4000 chars
        self.assertLess(max(wire), 10_000)
        self.assertLess(sum(wire) * 10, sum(captured))

    def test_client_rebuilds_the_captured_row_exactly(self):
        mid = 'm-' + uuid.uuid4().hex
        pieces = ['Hello ', 'wörld 🎉 ', 'y' * 3990, 'across the cap ', '🎉' * 30, 'z' * 500]
        client = Client()
        for index, (captured, wire) in enumerate(self.stream(mid, pieces)):
            self.assertEqual(client.take(wire), 'full' if index == 0 else 'delta')
            row = captured['assistant_row']
            self.assertEqual(client.rows[mid]['text'], row['text'])
            self.assertEqual(client.rows[mid]['reply_quote'], row['reply_quote'])
            self.assertEqual(client.rows[mid]['assistant_revision'], row['assistant_revision'])
            self.assertEqual(wire['event_id'], captured['event_id'])
            self.assertEqual(wire['assistant_row']['event_id'], row['event_id'])
            if index:
                self.assertEqual(wire['assistant_row']['text'], pieces[index])
                self.assertNotIn('reply_quote', wire)
        full = ''.join(pieces)
        self.assertEqual(client.rows[mid]['text'], full)
        self.assertEqual(client.rows[mid]['reply_quote'], full[:4000])

    def test_reply_quote_is_sent_only_while_it_can_change(self):
        mid = 'm-' + uuid.uuid4().hex
        frames = self.stream(mid, ['a' * 3999, 'b', 'c', 'd'])
        rows = [w['assistant_row'] for _, w in frames]
        self.assertEqual(rows[1]['reply_quote'], 'a' * 3999 + 'b')   # base 3999 < 4000
        self.assertNotIn('reply_quote', rows[2])                      # base 4000
        self.assertNotIn('reply_quote', rows[3])

    def test_a_missed_frame_is_a_gap_not_wrong_text(self):
        mid = 'm-' + uuid.uuid4().hex
        frames = self.stream(mid, ['one ', 'two ', 'three '])
        client = Client()
        self.assertEqual(client.take(frames[0][1]), 'full')
        self.assertEqual(client.take(frames[2][1]), 'gap')
        self.assertEqual(client.rows[mid]['text'], 'one ')
        self.assertEqual(frames[2][1]['assistant_row']['assistant_base_revision'], 2)

    def test_frames_that_are_not_appending_prose_deltas_are_unchanged(self):
        mid = 'm-' + uuid.uuid4().hex
        first = self.capture(kind='delta', text='first', assistant_id=mid)
        self.assertIs(sup.wire_reply_frame(first), first)
        self.capture(kind='delta', text=' more', assistant_id=mid)
        reset = self.capture(kind='delta', text='restart', assistant_id=mid, assistant_reset=True)
        self.assertIs(sup.wire_reply_frame(reset), reset)
        draft = self.capture(kind='draft', text='draft body', assistant_id=mid)
        self.assertIs(sup.wire_reply_frame(draft), draft)
        done = self.capture(kind='text', text='the final text', assistant_id=mid)
        self.assertEqual(done['assistant_row']['assistant_state'], 'complete')
        self.assertIs(sup.wire_reply_frame(done), done)
        late = self.capture(kind='delta', text=' late', assistant_id=mid)
        self.assertIs(sup.wire_reply_frame(late), late)
        self.assertEqual(late['assistant_row']['text'], 'the final text')
        thinking = self.capture(kind='thinking', text='hmm')
        self.assertIs(sup.wire_reply_frame(thinking), thinking)
        plain = self.capture(kind='delta', text='no identity')
        self.assertIs(sup.wire_reply_frame(plain), plain)
        tool = {'kind': 'tool', 'text': 'x'}
        self.assertIs(sup.wire_reply_frame(tool), tool)

    def test_command_output_delta_is_unchanged(self):
        mid = 'm-' + uuid.uuid4().hex
        self.capture(kind='delta', text='a', assistant_id=mid)
        frame = self.capture(kind='delta', text='b', assistant_id=mid, cmd_output=True)
        self.assertIs(sup.wire_reply_frame(frame), frame)

    def test_websocket_stream_sends_the_wire_form(self):
        """api's startup `stream` hands the hub wire_reply_frame(capture(...))."""
        tree = ast.parse((REPO / 'engine/backend/orgtree/api.py').read_text(encoding='utf-8'))
        streams = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'stream'
                   and any(isinstance(c, ast.Attribute) and c.attr == 'capture_reply_stream'
                           for c in ast.walk(n))]
        self.assertEqual(len(streams), 1)
        first = streams[0].body[0]
        self.assertIsInstance(first, ast.Assign)
        call = first.value
        self.assertEqual(getattr(call.func, 'attr', None), 'wire_reply_frame')
        self.assertEqual(getattr(call.args[0].func, 'attr', None), 'capture_reply_stream')


if __name__ == '__main__':
    unittest.main()
