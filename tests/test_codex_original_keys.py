"""P08a: Codex manual-inbox calls carry their ORIGINAL key, door CLOSED.

A Codex tool call is answered by the turn's `_tool_call` closure. For the
manual inbox's two receipted actions (fetch, chunk) it is now issued as
`orgtree_op_call` under a key derived from the authenticated seat and
generation and the app-server's own request identity (thread, turn,
callId), so the same original call always presents the same key and the
real `opreceipts.admit` decides it. Every other call is unchanged.

Synthetic only. No backend dispatcher answers the inbox verb (the door is
closed, and one test below proves the real API still refuses it), so the
end-to-end tests stand a FAKE door in front of the real receipted
supervisor functions: it forwards the wrapped call's key and epoch exactly
as a future door would have to. What that proves is the client half — the
key, its stability and what the real admission does with it — not a door.
The negative-control harness in the author's scratch removes one guarantee
at a time and shows the test that names it fails.
"""
import copy
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='codex-original-keys-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import (api, codexrun, inbox, ledger, mailruntime, opreceipts,
                     store, supervisor as sup)

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []
LIVE = 'op-live'
W = 'worker'
_SERIAL = itertools.count()


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


def call(cid='call-1', thread='thr-1', turn='turn-1', rid=7):
    return {'call_id': cid, 'thread_id': thread, 'turn_id': turn, 'rid': str(rid)}


class CodexOriginalKeyTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"cxk-{self._testMethodName.replace('_', '-')[:44]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        node = self.load().node(W)
        self.gen = node['generation']
        self.seat = str(node.get('seat_id') or '')
        self.st = sup.state(self.slug, W)
        self.n = 0
        self.sent = []
        self.lose = 0
        sup._CODEX_KEYS.clear()
        sup._CODEX_EPOCH.clear()

    def tearDown(self):
        sup._CODEX_KEYS.clear()
        sup._CODEX_EPOCH.clear()
        sup._state.pop((self.slug, W), None)
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def canonical(self):
        return json.dumps(self.load().d, sort_keys=True, ensure_ascii=False)

    def deposit(self, body='hello', count=1):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(W, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                 'from': 'boss', 'kind': 'message', 'body': body,
                                 'at': ledger.now()})
            ids.append(mid)
        store.save_org(org)
        return ids

    def begin(self, attempt=LIVE):
        org = self.load()
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = attempt
            self.st['busy'] = True
            mailruntime.register(self.st, org, W, attempt=attempt, toks=[])

    def epoch(self):
        with store.DOC_LOCK:
            return opreceipts.custody(self.load().d, store.DATA_ROOT, self.slug)[0]

    def box_ids(self):
        return [m['id'] for m in (self.load().d.get('mail') or {}).get(W) or []]

    def batches(self):
        return copy.deepcopy((self.load().d.get('delivering') or {}).get(W) or [])

    def receipts(self):
        return [r for r in self.load().d.get(opreceipts.SECTION) or []]

    def post(self, verb, args):
        """The FAKE door: the backend's epoch read, and the wrapped call
        forwarded — key and epoch untouched — to the real receipted
        supervisor functions. `self.lose` answers drop AFTER the call ran."""
        self.sent.append((verb, copy.deepcopy(args)))
        if verb == opreceipts.OP_EPOCH:
            return 'ok', json.dumps({'epoch': self.epoch()})
        self.assertEqual(verb, opreceipts.OP_CALL)
        inner, key, ep = args['args'], args['op_key'], args['op_epoch']
        if inner['action'] == 'fetch':
            out = sup.manual_fetch(self.slug, W, self.gen, inner['message_ids'],
                                   op_key=key, op_epoch=ep)
        else:
            out = sup.manual_fetch_chunk(self.slug, W, self.gen, inner['delivery_id'],
                                         inner['message_id'], inner['chunk_index'],
                                         op_key=key, op_epoch=ep)
        if self.lose:
            self.lose -= 1
            return 'lost', 'timed out'
        return 'ok', json.dumps(out)

    def dispatch(self, args, c=None, **kw):
        out = sup.codex_keyed_dispatch(self.post, self.slug, W, self.seat, self.gen,
                                       inbox.TOOL, args, call() if c is None else c, **kw)
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out

    def op_calls(self):
        return [a for v, a in self.sent if v == opreceipts.OP_CALL]

    # ------------------------------------------------ the call identity
    def test_codexrun_hands_the_dispatcher_the_requests_own_identity(self):
        """The identity comes from the app-server request params, only for
        the length of the dispatch, and never from the model's arguments."""
        seen = []

        def dispatch(tool, args):
            seen.append((tool, dict(args), codexrun.current_tool_call()))
            return 'ok'

        client = object.__new__(codexrun.AppServerClient)
        client._jobs_cv = threading.Condition()
        client._epoch = 1
        client._send_quiet = lambda obj: True
        rec = {'rid': 41, 'method': 'item/tool/call', 'tool': 'orgtree_chart',
               'call_id': 'c-9'}
        params = {'tool': 'orgtree_chart', 'callId': 'c-9', 'threadId': 't-3',
                  'turnId': 'u-5', 'arguments': {'callId': 'forged', 'threadId': 'x'}}
        client._run_job({'rec': rec, 'params': params, 'epoch': 1,
                         'tool_dispatch': dispatch, 'approval_decide': None,
                         'on_result': None}, False)
        [(tool, args, ident)] = seen
        self.assertEqual(ident, {'call_id': 'c-9', 'thread_id': 't-3',
                                 'turn_id': 'u-5', 'rid': '41'})
        self.assertEqual(args, {'callId': 'forged', 'threadId': 'x'})
        self.assertIsNone(codexrun.current_tool_call())
        self.assertTrue(rec['ok'])

    def test_a_missing_or_non_string_field_is_empty_never_guessed(self):
        got = codexrun.tool_call_identity({'callId': 5, 'threadId': None}, 'r')
        self.assertEqual(got, {'call_id': '', 'thread_id': '', 'turn_id': '', 'rid': 'r'})

    def test_no_original_identity_sends_nothing(self):
        ids = self.deposit()
        self.begin()
        before = self.canonical()
        for c in ({}, {'call_id': 'c'}, {'thread_id': 't'}):
            out = self.dispatch({'action': 'fetch', 'message_ids': ids}, c=c)
            self.assertIn('no_call_identity', out)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.canonical(), before)

    # ------------------------------------------------ the key
    def test_every_identity_field_moves_the_key_and_arguments_do_not(self):
        base = sup.codex_call_digest(self.slug, W, 'seat', 3, call())
        self.assertEqual(base, sup.codex_call_digest(self.slug, W, 'seat', 3, call()))
        self.assertEqual(len(base), 64)
        variants = [
            sup.codex_call_digest('other', W, 'seat', 3, call()),
            sup.codex_call_digest(self.slug, 'peer', 'seat', 3, call()),
            sup.codex_call_digest(self.slug, W, 'seat2', 3, call()),
            sup.codex_call_digest(self.slug, W, 'seat', 4, call()),
            sup.codex_call_digest(self.slug, W, 'seat', 3, call(thread='thr-2')),
            sup.codex_call_digest(self.slug, W, 'seat', 3, call(turn='turn-2')),
            sup.codex_call_digest(self.slug, W, 'seat', 3, call(cid='call-2')),
            # a field split that would spell the same concatenation
            sup.codex_call_digest(self.slug, W, 'seat', 3, call(thread='thr-1turn-1', turn='')),
        ]
        self.assertEqual(len(set(variants + [base])), len(variants) + 1)
        # the JSON-RPC request id is transport, not the call: a re-request
        # under another id is the same original call
        self.assertEqual(base, sup.codex_call_digest(self.slug, W, 'seat', 3, call(rid=99)))

    def test_the_key_has_the_receipt_shape_and_is_stable_for_one_call(self):
        ids = self.deposit(count=2)
        self.begin()
        self.dispatch({'action': 'fetch', 'message_ids': ids[:1]})
        self.dispatch({'action': 'fetch', 'message_ids': ids[:1]}, c=call(rid=8))
        k1, k2 = (a['op_key'] for a in self.op_calls())
        self.assertEqual(k1, k2)
        self.assertIsNotNone(opreceipts.parse_key(k1))
        digest = sup.codex_call_digest(self.slug, W, self.seat, self.gen, call())
        self.assertTrue(k1.endswith('-' + digest[:24]))

    # ------------------------------------------------ replay, conflict
    def test_the_same_original_call_replays_and_drains_nothing(self):
        ids = self.deposit(count=2)
        self.begin()
        first = self.dispatch({'action': 'fetch', 'message_ids': ids})
        self.assertTrue(first['ok'], first)
        self.assertEqual(first['fetched_count'], 2)
        box, batches = self.box_ids(), self.batches()
        again = self.dispatch({'action': 'fetch', 'message_ids': ids}, c=call(rid=8))
        self.assertIsInstance(again, dict, again)
        self.assertTrue(again.get('replayed'), again)
        self.assertEqual(again['result']['delivery_id'], first['delivery_id'])
        self.assertEqual((self.box_ids(), self.batches()), (box, batches))
        self.assertEqual(len(self.receipts()), 1)

    def test_changed_arguments_under_the_same_call_conflict(self):
        ids = self.deposit(count=2)
        self.begin()
        self.dispatch({'action': 'fetch', 'message_ids': ids[:1]})
        before = self.canonical()
        out = self.dispatch({'action': 'fetch', 'message_ids': ids[1:]})
        # the unkeyed path's answer shaping: an `error` answers as its text
        self.assertEqual(out, 'op_key_conflict')
        self.assertEqual(self.canonical(), before)
        self.assertIn(ids[1], self.box_ids())

    def test_another_call_is_its_own_operation(self):
        ids = self.deposit(count=2)
        self.begin()
        a = self.dispatch({'action': 'fetch', 'message_ids': ids[:1]})
        b = self.dispatch({'action': 'fetch', 'message_ids': ids[1:]}, c=call(cid='call-2'))
        self.assertIsInstance(b, dict, b)
        self.assertEqual((a['fetched_count'], b['fetched_count']), (1, 1))
        self.assertNotEqual(a['delivery_id'], b['delivery_id'])
        k1, k2 = (x['op_key'] for x in self.op_calls())
        self.assertNotEqual(k1, k2)
        self.assertEqual(len(self.receipts()), 2)

    def test_a_chunk_call_replays_the_same_bytes(self):
        body = '€' * 70000 + 'end'                   # 4 chunks of 3-byte characters
        ids = self.deposit(body=body)
        self.begin()
        f = self.dispatch({'action': 'fetch', 'message_ids': ids})
        did = f['delivery_id']
        args = {'action': 'chunk', 'delivery_id': did, 'message_id': ids[0], 'chunk_index': 0}
        first = self.dispatch(args, c=call(cid='call-c'))
        self.assertTrue(first['ok'], first)
        atts = self.load().d['manual_attempts'][W][did]
        calls = copy.deepcopy(atts.get('chunk_calls'))
        again = self.dispatch(args, c=call(cid='call-c', rid=9))
        self.assertTrue(again['replayed'], again)
        self.assertEqual(again['content'], first['content'])
        self.assertEqual(again['chunk_sha256'], first['chunk_sha256'])
        self.assertEqual(self.load().d['manual_attempts'][W][did].get('chunk_calls'), calls)

    # ------------------------------------------------ lost answers
    def test_a_lost_answer_is_resent_under_the_same_key_and_replays(self):
        ids = self.deposit(count=2)
        self.begin()
        self.lose = 1
        out = self.dispatch({'action': 'fetch', 'message_ids': ids})
        self.assertIsInstance(out, dict, out)
        self.assertTrue(out['replayed'], out)
        self.assertEqual(out['result']['fetched_count'], 2)
        k1, k2 = (a['op_key'] for a in self.op_calls())
        e1, e2 = (a['op_epoch'] for a in self.op_calls())
        self.assertEqual((k1, e1), (k2, e2))
        self.assertEqual(len(self.batches()), 1)
        self.assertEqual(len(self.receipts()), 1)

    def test_two_lost_answers_are_unknown_and_a_re_request_still_replays(self):
        ids = self.deposit(count=2)
        self.begin()
        self.lose = 2
        out = self.dispatch({'action': 'fetch', 'message_ids': ids})
        self.assertIn('state unknown', out)
        self.assertEqual(len(self.op_calls()), 2)
        again = self.dispatch({'action': 'fetch', 'message_ids': ids}, c=call(rid=8))
        self.assertTrue(again['replayed'], again)
        self.assertEqual(len(self.batches()), 1)
        self.assertEqual(len(self.receipts()), 1)

    def test_an_unsent_call_is_not_resent(self):
        ids = self.deposit()
        self.begin()
        self.dispatch({'action': 'fetch', 'message_ids': ids})      # binds the epoch
        sent = len(self.sent)
        with patch.object(self, 'post', lambda v, a: (self.sent.append((v, a)), ('unsent', 'refused'))[1]):
            out = self.dispatch({'action': 'fetch', 'message_ids': ids}, c=call(cid='call-u'))
        self.assertEqual(out, 'orgtree API unreachable: refused')
        self.assertEqual(len(self.sent), sent + 1)

    # ------------------------------------------------ epoch and restart
    def test_a_rotated_epoch_is_reported_and_never_reissued(self):
        ids = self.deposit(count=2)
        self.begin()
        first = self.dispatch({'action': 'fetch', 'message_ids': ids[:1]})
        old = self.op_calls()[0]['op_epoch']
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)      # the epoch rotates
        self.assertNotEqual(self.epoch(), old)
        before = self.canonical()
        out = self.dispatch({'action': 'fetch', 'message_ids': ids[:1]}, c=call(rid=8))
        self.assertIn('stale_epoch', out)
        self.assertEqual(self.canonical(), before)
        last = self.op_calls()[-1]
        self.assertEqual((last['op_key'], last['op_epoch']),
                         (self.op_calls()[0]['op_key'], old))
        self.assertNotIn(self.slug, sup._CODEX_EPOCH)
        # the same original call stays bound to its old epoch: refused again
        out = self.dispatch({'action': 'fetch', 'message_ids': ids[:1]}, c=call(rid=9))
        self.assertIn('stale_epoch', out)
        # a NEW call reads the new epoch and runs
        fresh = self.dispatch({'action': 'fetch', 'message_ids': ids[1:]}, c=call(cid='call-2'))
        self.assertEqual(fresh['fetched_count'], 1, fresh)
        self.assertEqual(self.op_calls()[-1]['op_epoch'], self.epoch())
        self.assertNotEqual(first['delivery_id'], fresh['delivery_id'])

    def test_a_later_process_mints_a_fresh_key_and_custody_still_holds(self):
        """The disclosed limit: the memo is per process. After a simulated
        restart (memo and custody gone) the same original call presents a
        NEW key — and the mail its first fetch took is still journaled, so
        it is reported moved, not drained a second time."""
        ids = self.deposit()
        self.begin()
        first = self.dispatch({'action': 'fetch', 'message_ids': ids})
        k1 = self.op_calls()[0]['op_key']
        sup._CODEX_KEYS.clear()
        sup._CODEX_EPOCH.clear()
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        time.sleep(0.002)
        out = self.dispatch({'action': 'fetch', 'message_ids': ids}, c=call(rid=8))
        self.assertNotEqual(self.op_calls()[-1]['op_key'], k1)
        self.assertEqual(out['fetched_count'], 0, out)
        self.assertEqual([r['message_id'] for r in out['already_moved']], ids)
        self.assertEqual(len(self.batches()), 1)
        self.assertEqual(self.batches()[0]['manual']['delivery_id'], first['delivery_id'])

    def test_the_epoch_preflight_failing_sends_no_call(self):
        ids = self.deposit()
        self.begin()
        before = self.canonical()
        with patch.object(self, 'post', lambda v, a: (self.sent.append((v, a)), ('refused', 'nope'))[1]):
            out = self.dispatch({'action': 'fetch', 'message_ids': ids})
        self.assertIn('no_epoch', out)
        self.assertEqual([v for v, _ in self.sent], [opreceipts.OP_EPOCH])
        self.assertEqual(self.canonical(), before)

    # ------------------------------------------------ the memo bound
    def test_a_live_key_is_never_evicted_to_make_room(self):
        now = int(time.time() * 1000)
        with patch.object(sup, '_CODEX_KEYS_CAP', 2):
            self.assertIsNotNone(sup._codex_bind_key('a' * 64, 'e', now))
            self.assertIsNotNone(sup._codex_bind_key('b' * 64, 'e', now))
            self.assertIsNone(sup._codex_bind_key('c' * 64, 'e', now))
            self.assertEqual(sup._codex_bind_key('a' * 64, 'x', now + 5),
                             (f'{now}-' + 'a' * 24, 'e'))
            late = now + opreceipts.HORIZON_MS + opreceipts.SKEW_MS + 1
            self.assertIsNotNone(sup._codex_bind_key('c' * 64, 'e', late))
            self.assertEqual(set(sup._CODEX_KEYS), {'c' * 64})

    def test_full_memo_refuses_unsent(self):
        ids = self.deposit()
        self.begin()
        with patch.object(sup, '_CODEX_KEYS_CAP', 0):
            out = self.dispatch({'action': 'fetch', 'message_ids': ids})
        self.assertIn('key_memo_full', out)
        self.assertEqual(self.op_calls(), [])

    # ------------------------------------------------ nothing else changes
    def test_only_receipted_fetch_and_chunk_are_keyed(self):
        keyed = sup.codex_keyed_call
        self.assertTrue(keyed(inbox.TOOL, {'action': 'fetch'}))
        self.assertTrue(keyed(inbox.TOOL, {'action': 'chunk'}))
        for tool, args in ((inbox.TOOL, {'action': 'list'}),
                           (inbox.TOOL, {'action': 'no-such-action'}),
                           (inbox.TOOL, {}),
                           ('orgtree_message', {'to': 'x', 'body': 'y'}),
                           ('orgtree_work', {'action': 'update'}),
                           ('orgtree_hire', {}), ('orgtree_chart', {}),
                           (opreceipts.OP_CALL, {'action': 'fetch'})):
            self.assertFalse(keyed(tool, args), (tool, args))
        with patch.dict(opreceipts._ACTION_COVERAGE, {inbox.TOOL: {'fetch': opreceipts.NONE}}):
            self.assertFalse(keyed(inbox.TOOL, {'action': 'fetch'}))

    def test_the_turn_closure_keys_only_through_the_predicate(self):
        """The one change inside `_run_codex_turn`: `_tool_call` branches to
        the keyed path on `codex_keyed_call` and otherwise runs its original
        request unchanged."""
        import inspect
        src = inspect.getsource(sup)
        start = src.index('    def _tool_call(tool: str, args: dict[str, Any]) -> str:\n')
        body = src[start:src.index('    denials: list[dict[str, Any]] = []', start)]
        head, rest = body.split('        # the same request the MCP server makes', 1)
        self.assertIn('if codex_keyed_call(tool, args):', head)
        self.assertIn('codexrun.current_tool_call()', head)
        self.assertNotIn('op_key', rest)
        self.assertIn('"args": args}).encode()', rest)

    def test_the_real_backend_still_refuses_the_inbox_verb(self):
        """Door closed: the wrapped call reaches no inbox code at all."""
        from fastapi import HTTPException
        from starlette.requests import Request
        ids = self.deposit()
        self.begin()
        before = self.canonical()
        body = api.AgentCall(org=self.slug, node=W, tool=opreceipts.OP_CALL, args={
            'tool': inbox.TOOL, 'args': {'action': 'fetch', 'message_ids': ids},
            'op_key': opreceipts.mint_key(), 'op_epoch': self.epoch()})
        with self.assertRaises(HTTPException) as cm:
            api.agent_call(body, Request({'type': 'http', 'headers': []}))
        self.assertIn(f"unknown orgtree tool '{inbox.TOOL}'", str(cm.exception.detail))
        self.assertEqual(self.canonical(), before)


if __name__ == '__main__':
    unittest.main()
