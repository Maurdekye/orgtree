"""Landing 2 of the `orgtree_inbox` door: a Claude agent's fetched mail is NOT
delivered again when its own session file proves the answer reached it
(decision 2026-09-29, option A, item let-agents-manually-check-their-unread-
inbox). Without that proof the mail returns to the mailbox as before.

Part 1 pins the pure matcher (`inbox.claude_session_evidence`): what counts
as proof and what does not. Part 2 runs it end to end: a fetch through the
real gateway, a Claude session file written the way the CLI writes it, the
turn-end scan, and the ordinary turn-end fold.

Run:  python tools/run-python-verification.py tests/test_inbox_claude_proof.py
"""
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='inbox-claude-proof-')
os.environ['ORGTREE_DATA'] = str(Path(_root.name) / 'data')
Path(os.environ['ORGTREE_DATA']).mkdir()
_home = Path(_root.name) / 'home'
_home.mkdir()
os.environ['HOME'] = os.environ['USERPROFILE'] = str(_home)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from starlette.requests import Request                               # noqa: E402
from orgtree import api, inbox, ledger, mailruntime, store, supervisor as sup  # noqa: E402

SLUGS = []
LIVE = 'op-live'
W = 'worker'
_SERIAL = itertools.count()
SESSION = 'sess-1'
TOOL_NAME = 'mcp__orgtree__orgtree_inbox'


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


def use_line(tid, session=SESSION, name=TOOL_NAME):
    return json.dumps({'type': 'assistant', 'sessionId': session, 'message': {
        'role': 'assistant', 'content': [
            {'type': 'tool_use', 'id': tid, 'name': name, 'input': {'action': 'fetch'}}]}})


def result_line(tid, answer, session=SESSION, is_error=None):
    block = {'tool_use_id': tid, 'type': 'tool_result',
             'content': [{'type': 'text', 'text': json.dumps(answer, separators=(',', ':'))}]}
    if is_error is not None:
        block['is_error'] = is_error
    return json.dumps({'type': 'user', 'sessionId': session,
                       'message': {'role': 'user', 'content': [block]}})


def record_for(bodies, did='mf-abc'):
    return {'session': SESSION, 'delivery_id': did,
            'plan': {mid: inbox.chunk_plan(body) for mid, body in bodies.items()}}


def fetch_answer(record, bodies):
    """A fetch answer as the backend serves it (inbox.fetched_item shapes)."""
    items = [inbox.fetched_item({'id': mid, 'body': body}, record['plan'][mid],
                                record['delivery_id']) for mid, body in bodies.items()]
    return {'ok': True, 'delivery_id': record['delivery_id'], 'fetched': items,
            **inbox.disclosure()}


class ClaudeEvidenceMatcher(unittest.TestCase):
    BODIES = {'m1': 'first message', 'm2': 'second message'}

    def proven(self, record, lines):
        evidence, _ = inbox.claude_session_evidence(record, lines)
        return inbox.confirmation_complete(record, evidence)

    def test_1_a_fetch_result_of_this_tool_proves_every_message_it_served(self):
        rec = record_for(self.BODIES)
        lines = [use_line('t1'), result_line('t1', fetch_answer(rec, self.BODIES))]
        self.assertTrue(self.proven(rec, lines))

    def test_2_nothing_else_proves_it(self):
        rec = record_for(self.BODIES)
        good = fetch_answer(rec, self.BODIES)
        tampered = json.loads(json.dumps(good))
        tampered['fetched'][1]['content'] = 'second messagE'
        other = dict(good, delivery_id='mf-other')
        cases = {
            'no tool_use of this tool': [result_line('t1', good)],
            'another tool': [use_line('t1', name='mcp__orgtree__orgtree_message'),
                             result_line('t1', good)],
            'another session': [use_line('t1', session='s2'),
                                result_line('t1', good, session='s2')],
            'an error result': [use_line('t1'), result_line('t1', good, is_error=True)],
            'changed content': [use_line('t1'), result_line('t1', tampered)],
            'another delivery': [use_line('t1'), result_line('t1', other)],
            'a refusal': [use_line('t1'), result_line('t1', {'ok': False,
                                                              'delivery_id': 'mf-abc'})],
            'unparseable text': [use_line('t1'), '{"type": "user", "sessionId": "sess-1", '
                                 '"message": {"content": [{"type": "tool_result", '
                                 '"tool_use_id": "t1", "content": "not json"}]}}'],
        }
        for name, lines in cases.items():
            self.assertFalse(self.proven(rec, lines), name)

    def test_3_a_fetch_that_served_only_some_messages_proves_only_those(self):
        rec = record_for(self.BODIES)
        part = fetch_answer(rec, {'m1': self.BODIES['m1']})
        self.assertFalse(self.proven(rec, [use_line('t1'), result_line('t1', part)]))

    def test_4_a_chunked_body_needs_every_chunk(self):
        body = 'x' * (inbox.CHUNK_BYTES * 2 + 10)
        rec = record_for({'big': body})
        plan = rec['plan']['big']
        self.assertEqual(plan['chunk_total'], 3, 'fixture: three chunks')
        lines = [use_line('t1'), result_line('t1', fetch_answer(rec, {'big': body}))]
        self.assertFalse(self.proven(rec, lines), 'chunk 0 alone proves nothing')
        for k in (1, 2):
            item = inbox.fetched_item({'id': 'big', 'body': body}, plan, 'mf-abc', k)
            lines += [use_line(f'c{k}'), result_line(f'c{k}', {'ok': True, **item})]
            self.assertEqual(self.proven(rec, lines), k == 2)

    def test_5_a_replay_without_content_proves_nothing(self):
        rec = record_for(self.BODIES)
        replay = {'ok': True, 'replayed': True, 'result': {'delivery_id': 'mf-abc'},
                  'delivery_id': 'mf-abc', 'content': None}
        self.assertFalse(self.proven(rec, [use_line('t1'), result_line('t1', replay)]))


class ClaudeProofEndToEnd(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"claude-proof-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        self.session = str(self.load().node(W)['session_id'])
        self.st = sup.state(self.slug, W)
        self.n = 0
        proj = _home / '.claude' / 'projects' / f'p{next(_SERIAL)}'
        proj.mkdir(parents=True)
        self.path = proj / (self.session + '.jsonl')

    def tearDown(self):
        sup._state.pop((self.slug, W), None)
        store._POOL.close_all(self.slug)

    def load(self):
        return store.load_org(self.slug)

    def deposit(self, count=1):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(W, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                 'from': 'boss', 'kind': 'message', 'body': f'text {mid}',
                                 'at': ledger.now()})
            ids.append(mid)
        store.save_org(org)
        return ids

    def begin(self):
        org = self.load()
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = LIVE
            self.st['busy'] = True
            mailruntime.register(self.st, org, W, attempt=LIVE, toks=[])

    def end(self):
        """Turn end in `_run_one_turn_recorded`'s order: the manual scan, then
        custody release, then the ordinary fold."""
        sup.scan_manual_records(self.slug, W)
        with sup._state_lock:
            mailruntime.release(self.st, attempt=LIVE)
        sup._fold_back_undelivered(self.slug, W, keep_toks=[])
        with sup._state_lock:
            self.st.pop('lifecycle_operation_id', None)
            self.st['busy'] = False

    def fetch(self, ids):
        body = api.AgentCall(org=self.slug, node=W, tool=inbox.TOOL,
                             args={'action': 'fetch', 'message_ids': ids})
        out = api.agent_call(body, Request({'type': 'http', 'headers': []}))
        self.assertTrue(out.get('ok'), out)
        return out

    def write_session(self, answer):
        """The two lines the Claude CLI writes for one MCP call."""
        self.path.write_text(use_line('toolu_1', session=self.session) + '\n'
                             + result_line('toolu_1', answer, session=self.session) + '\n',
                             encoding='utf-8')

    def box(self):
        return [m['id'] for m in (self.load().d.get('mail') or {}).get(W) or []]

    def test_6_proven_mail_is_not_delivered_again(self):
        ids = self.deposit(2)
        self.begin()
        out = self.fetch(ids)
        self.write_session(out)
        self.end()
        self.assertEqual(self.box(), [], 'proven: nothing returns to the mailbox')
        self.assertFalse((self.load().d.get('delivering') or {}).get(W),
                         'and no batch is left journaled')

    def test_7_without_proof_the_mail_comes_back(self):
        # the control for test 6: same fetch, the session file does not show
        # the answer (the agent never received it), so it is redelivered
        ids = self.deposit(2)
        self.begin()
        out = self.fetch(ids)
        out['fetched'][0]['content'] = 'something else'
        self.write_session(out)
        self.end()
        box = (self.load().d.get('mail') or {}).get(W) or []
        self.assertEqual(sorted(m['id'] for m in box), ids, 'nothing lost')
        self.assertTrue(all(m.get('redelivered') == 1 for m in box), 'counted redelivery')

    def test_8_no_session_file_means_redelivery(self):
        ids = self.deposit(1)
        self.begin()
        self.fetch(ids)
        self.end()
        self.assertEqual(self.box(), ids)

    def test_9_an_unreadable_session_file_is_no_proof_and_raises_nothing(self):
        # a failed read of one candidate's file must not abort the scan (which
        # would also drop every other candidate's proof): that candidate is
        # simply unproven and comes back
        self.path.mkdir()
        ids = self.deposit(1)
        self.begin()
        self.fetch(ids)
        org = self.load()
        found = sup._manual_candidates(org, W, need_chunk_calls=False)
        self.assertEqual(len(found), 1)
        self.assertEqual(sup._claude_manual_complete_toks(org, W, found), [])
        self.end()
        self.assertEqual(self.box(), ids)


if __name__ == '__main__':
    unittest.main()
