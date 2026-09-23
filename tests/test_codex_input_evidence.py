"""Manual inbox P08b: Codex chunk-call echoes as input evidence, door CLOSED.

A manual delivery is confirmed at turn end only when EVERY chunk of EVERY
message was served by its own keyed chunk call whose echo the Codex leg
journaled with the structural origin marker, bound to the original call, the
receipt nonce, the session, seat and generation and the exact digest
(decisions 42 D5, 44, 46). Anything short of that folds back as a counted
redelivery, exactly as before.

Synthetic stores only. The chain is real from the P08a original-key dispatch
(`codex_keyed_dispatch`) through the receipted chunk reader, the journal
writer (`_codex_journal` into the real transcript database under a temporary
data root) and the turn-end scan. The one stand-in is the future door: a
`post` that hands the keyed call to `manual_fetch`/`manual_fetch_chunk` and
returns their answer as JSON, as the backend would. There is no door.

⚠ ASSUMED, NOT OBSERVED (U2): the app-server's `item/completed` notification
for a `dynamicToolCall` carries `item.id` equal to the `item/tool/call`
request's `callId`, and echoes `contentItems` verbatim. No test here proves
the real runtime does that; if it does not, nothing ever matches and every
delivery is redelivered as before (the design fails closed).
"""
import copy
import itertools
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='codex-input-evidence-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import (halt, inbox, ledger, mailruntime, opreceipts, store,
                     supervisor as sup, transcript_records)

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []
LIVE = 'op-live'
W = 'worker'
THREAD = 'thread-A'
TURN = 'turn-1'
BIG = '€' * 70000 + 'end'          # 4 chunks of 3-byte characters
_SERIAL = itertools.count()


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class CodexInputEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fresh()

    def tearDown(self):
        self.cleanup()

    # ------------------------------------------------------------ fixtures
    def fresh(self, session=THREAD):
        if getattr(self, 'slug', None):
            self.cleanup()
        org = store.create_org(f"cie-{self._testMethodName.replace('_', '-')[:40]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        if session is not None:
            org.node(W)['session_id'] = session
        store.save_org(org)
        self.st = sup.state(self.slug, W)
        self.gen = org.node(W)['generation']
        self.seat = org.node(W).get('seat_id')
        self.assertTrue(self.seat, 'a hired node has a seat (P04a)')
        self.n = 0
        self.calls = itertools.count()

    def cleanup(self):
        sup._state.pop((self.slug, W), None)
        sup._CODEX_EPOCH.pop(self.slug, None)
        sup._CODEX_KEYS.clear()
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    def load(self):
        return store.load_org(self.slug)

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

    def end(self, attempt=LIVE):
        """The turn-end order `_run_one_turn_recorded` uses: the evidence
        scans, then custody release, then the ordinary fold."""
        sup.scan_manual_records(self.slug, W)
        with sup._state_lock:
            mailruntime.release(self.st, attempt=attempt)
        sup._fold_back_undelivered(self.slug, W, keep_toks=[])
        with sup._state_lock:
            self.st.pop('lifecycle_operation_id', None)
            self.st['busy'] = False

    def epoch(self):
        with store.DOC_LOCK:
            return opreceipts.custody(self.load().d, store.DATA_ROOT, self.slug)[0]

    def post(self, verb, args):
        """Stand-in for the future door: the backend's answer to the keyed call."""
        if verb == opreceipts.OP_EPOCH:
            return 'ok', json.dumps({'epoch': self.epoch()})
        self.assertEqual(verb, opreceipts.OP_CALL)
        a, key, ep = args['args'], args['op_key'], args['op_epoch']
        if a['action'] == 'fetch':
            out = sup.manual_fetch(self.slug, W, self.gen, a['message_ids'],
                                   op_key=key, op_epoch=ep)
        else:
            out = sup.manual_fetch_chunk(self.slug, W, self.gen, a['delivery_id'],
                                         a['message_id'], a['chunk_index'],
                                         op_key=key, op_epoch=ep)
        return 'ok', json.dumps(out, ensure_ascii=False)

    def call(self, args, *, call_id=None, turn=TURN, thread=THREAD):
        """One app-server `item/tool/call` through the P08a keyed dispatch.
        Returns (call_id, the text Codex receives as the tool result)."""
        call_id = call_id or f'call_{next(self.calls)}'
        ident = {'call_id': call_id, 'thread_id': thread, 'turn_id': turn, 'rid': call_id}
        text = sup.codex_keyed_dispatch(self.post, self.slug, W, self.seat, self.gen,
                                        inbox.TOOL, args, ident)
        return call_id, text

    def item(self, call_id, text, *, tool=inbox.TOOL, typ='dynamicToolCall',
             success=True, turn=TURN, thread=THREAD, args=None):
        """The app-server's `item/completed` params echoing one result (U2)."""
        return {'threadId': thread, 'turnId': turn, 'item': {
            'type': typ, 'id': call_id, 'tool': tool, 'arguments': args or {},
            'status': 'completed' if success else 'failed', 'success': success,
            'contentItems': [{'type': 'inputText', 'text': text}]}}

    def echo(self, call_id, text, *, sid=THREAD, mutate=None, **kw):
        """Journal the echo exactly as the Codex leg's `_on_item` does."""
        params = self.item(call_id, text, **kw)
        rec = sup._codex_result_record(params, params['item'], ledger.now())
        if mutate is not None:
            mutate(rec)
        sup._codex_journal(self.slug, sid, [rec],
                           incarnation=sup._transcript_incarnation(self.load(), W))
        return rec

    def fetch(self, ids):
        _cid, text = self.call({'action': 'fetch', 'message_ids': ids})
        out = json.loads(text)
        self.assertTrue(out['ok'], out)
        return out, _cid, text

    def chunk(self, did, mid, k, **kw):
        cid, text = self.call({'action': 'chunk', 'delivery_id': did,
                               'message_id': mid, 'chunk_index': k}, **kw)
        out = json.loads(text)
        self.assertTrue(out['ok'], out)
        self.assertIsNotNone(out['content'])
        return cid, text

    def plan(self):
        [row] = self.journal_rows()
        return {mid: p['chunk_total'] for mid, p in row['manual']['plan'].items()}

    def read_everything(self, did, *, skip=(), mutate=None):
        """A keyed chunk call for every chunk of every message, each echoed —
        except `(mid, k)` in `skip`; `mutate(mid, k, rec)` alters an echo."""
        for mid, total in self.plan().items():
            for k in range(total):
                cid, text = self.chunk(did, mid, k)
                if (mid, k) in skip:
                    continue
                self.echo(cid, text, mutate=(lambda rec, mid=mid, k=k: mutate(mid, k, rec))
                          if mutate else None)

    def journal_rows(self):
        return copy.deepcopy((self.load().d.get('delivering') or {}).get(W) or [])

    def box(self):
        return (self.load().d.get('mail') or {}).get(W) or []

    def confirmed_receipts(self):
        return [r for r in ((self.load().d.get('mail_transitions') or {}).get(W) or {}).values()
                if r.get('outcome') == 'confirmed']

    def two_message_delivery(self):
        ids = self.deposit(body=BIG) + self.deposit(body='small')
        self.begin()
        out, _cid, _text = self.fetch(ids)
        self.assertEqual(self.plan(), {ids[0]: 4, ids[1]: 1})
        return ids, out['delivery_id']

    def assert_confirmed(self, ids, did):
        self.assertFalse(self.journal_rows())
        self.assertEqual(self.box(), [])
        [receipt] = self.confirmed_receipts()
        self.assertIn(did, receipt['deliveries'].values())
        gone = sup.manual_fetch_chunk(self.slug, W, self.gen, did, ids[0], 0)
        self.assertEqual(gone['content_state'], 'confirmed')
        self.assertIsNone(gone['content'])

    def assert_redelivered(self, ids):
        self.assertFalse(self.journal_rows())
        self.assertEqual([m['id'] for m in self.box()], ids)
        self.assertEqual([m.get('redelivered') for m in self.box()], [1] * len(ids))
        self.assertEqual(self.confirmed_receipts(), [])

    # -------------------------------------------------------- the positive
    def test_every_chunk_echoed_confirms_the_delivery_at_turn_end(self):
        ids, did = self.two_message_delivery()
        self.read_everything(did)
        self.end()
        self.assert_confirmed(ids, did)
        att = self.load().d['manual_attempts'][W][did]
        self.assertEqual(len(att['chunk_calls']), 5)

    def test_a_keyed_chunk_answer_names_its_receipt_and_the_receipt_holds_no_nonce_field(self):
        ids, did = self.two_message_delivery()
        _cid, text = self.chunk(did, ids[1], 0)
        answer = json.loads(text)
        row = opreceipts.find(self.load().d, W, next(
            c['op_key'] for c in self.load().d['manual_attempts'][W][did]['chunk_calls']))
        self.assertEqual(answer['op_id'], row['id'])
        self.assertNotIn('op_id', row['result'])
        self.assertNotIn('content', row['result'])

    # ------------------------------------------------ negative controls
    def test_one_chunk_without_an_echo_redelivers_the_whole_delivery(self):
        ids, did = self.two_message_delivery()
        self.read_everything(did, skip={(ids[0], 2)})
        self.end()
        self.assert_redelivered(ids)

    def test_the_final_chunk_alone_confirms_nothing(self):
        ids = self.deposit(body=BIG)
        self.begin()
        out, _c, _t = self.fetch(ids)
        cid, text = self.chunk(out['delivery_id'], ids[0], 3)
        self.echo(cid, text)
        self.end()
        self.assert_redelivered(ids)

    def test_an_unmarked_row_with_the_exact_answer_is_not_evidence(self):
        """A late answer (`_late_tool_result`) is journaled under the same call
        id with our own text and no origin marker: even an otherwise perfect
        row without the marker must not count."""
        ids, did = self.two_message_delivery()
        self.read_everything(did, mutate=lambda mid, k, rec: (
            rec.pop(inbox.ORIGIN_KEY) if (mid, k) == (ids[1], 0) else None))
        self.end()
        self.assert_redelivered(ids)

    def test_a_marker_that_is_not_a_clean_inbox_echo_is_not_evidence(self):
        cases = {
            'item_type': lambda o, b: o.update(item_type='mcpToolCall'),
            'tool': lambda o, b: o.update(tool='orgtree_message'),
            'runtime': lambda o, b: o.update(runtime='antigravity_cli'),
            'kind': lambda o, b: o.update(kind='late'),
            'version': lambda o, b: o.update(v=2),
            'failed': lambda o, b: o.update(failed=True),
            'is_error': lambda o, b: b.update(is_error=True),
            'item_id': lambda o, b: b.update(tool_use_id='call_other'),
        }
        for name, change in cases.items():
            with self.subTest(name):
                self.fresh()
                ids, did = self.two_message_delivery()

                def mutate(mid, k, rec, change=change):
                    if (mid, k) == (ids[1], 0):
                        change(rec[inbox.ORIGIN_KEY], rec['message']['content'][0])
                self.read_everything(did, mutate=mutate)
                self.end()
                self.assert_redelivered(ids)
        with self.subTest('provider_reported_failure'):
            self.fresh()
            ids = self.deposit(body='small')
            self.begin()
            out, _c, _t = self.fetch(ids)
            cid, text = self.chunk(out['delivery_id'], ids[0], 0)
            rec = self.echo(cid, text, success=False)
            self.assertIs(rec[inbox.ORIGIN_KEY]['failed'], True)
            self.end()
            self.assert_redelivered(ids)

    def test_an_echo_of_a_different_original_call_is_not_evidence(self):
        """The P08a key digest binds (seat, generation, thread, turn, callId):
        the same answer echoed under another call or turn does not match."""
        for name, kw in {'call_id': {'call_id': 'call_forged'},
                         'turn': {'turn': 'turn-2'}}.items():
            with self.subTest(name):
                self.fresh()
                ids = self.deposit(body='small')
                self.begin()
                out, _c, _t = self.fetch(ids)
                cid, text = self.chunk(out['delivery_id'], ids[0], 0)
                self.echo(kw.get('call_id', cid), text, turn=kw.get('turn', TURN))
                self.end()
                self.assert_redelivered(ids)

    def test_an_echo_without_this_calls_nonce_is_not_evidence(self):
        ids, did = self.two_message_delivery()

        def mutate(mid, k, rec):
            if (mid, k) == (ids[1], 0):
                block = rec['message']['content'][0]
                answer = json.loads(block['content'])
                answer['op_id'] = '0' * 16
                block['content'] = json.dumps(answer, ensure_ascii=False)
        self.read_everything(did, mutate=mutate)
        self.end()
        self.assert_redelivered(ids)

    def test_one_altered_byte_of_content_is_not_evidence(self):
        ids, did = self.two_message_delivery()

        def mutate(mid, k, rec):
            if (mid, k) == (ids[0], 1):
                block = rec['message']['content'][0]
                answer = json.loads(block['content'])
                answer['content'] = answer['content'][:-1] + 'x'
                block['content'] = json.dumps(answer, ensure_ascii=False)
        self.read_everything(did, mutate=mutate)
        self.end()
        self.assert_redelivered(ids)

    def test_an_echo_naming_another_chunk_is_not_evidence(self):
        ids, did = self.two_message_delivery()

        def mutate(mid, k, rec):
            if (mid, k) == (ids[0], 2):
                block = rec['message']['content'][0]
                answer = json.loads(block['content'])
                answer['chunk_index'] = 3
                block['content'] = json.dumps(answer, ensure_ascii=False)
        self.read_everything(did, mutate=mutate)
        self.end()
        self.assert_redelivered(ids)

    def test_an_echo_from_another_session_is_not_evidence(self):
        """`other_journal`: a perfect echo, but in another session's journal.
        `other_thread`: a call made AND echoed on another thread (so its key
        binds), journaled here: only the session rule refuses it."""
        for name in ('other_journal', 'other_thread'):
            with self.subTest(name):
                self.fresh()
                ids = self.deposit(body='small')
                self.begin()
                out, _c, _t = self.fetch(ids)
                if name == 'other_journal':
                    cid, text = self.chunk(out['delivery_id'], ids[0], 0)
                    self.echo(cid, text, sid='thread-B')
                else:
                    cid, text = self.chunk(out['delivery_id'], ids[0], 0, thread='thread-B')
                    self.echo(cid, text, thread='thread-B')
                self.end()
                self.assert_redelivered(ids)

    def test_a_delivery_of_another_seat_or_generation_is_not_confirmed(self):
        for name in ('seat', 'generation', 'attempt_seat'):
            with self.subTest(name):
                self.fresh()
                ids = self.deposit(body='small')
                self.begin()
                out, _c, _t = self.fetch(ids)
                cid, text = self.chunk(out['delivery_id'], ids[0], 0)
                self.echo(cid, text)
                org = self.load()
                if name == 'seat':
                    org.node(W)['seat_id'] = 'seat-successor'
                elif name == 'generation':
                    org.node(W)['generation'] = self.gen + 1
                else:
                    org.d['manual_attempts'][W][out['delivery_id']]['seat'] = 'seat-other'
                store.save_org(org)
                self.assertEqual(sup.scan_manual_records(self.slug, W)['complete'], 0)
                self.assertEqual(len(self.journal_rows()), 1)
                self.assertEqual(self.confirmed_receipts(), [])

    def test_a_fetch_echo_is_never_a_chunks_evidence(self):
        """decision42 D5: a fetch call serving a whole small body is not that
        chunk's own keyed call. Message B is read only through the fetch."""
        ids = self.deposit(body='alpha') + self.deposit(body='beta')
        self.begin()
        out, fetch_cid, fetch_text = self.fetch(ids)
        self.assertTrue(all(f['complete'] for f in out['fetched']))
        self.echo(fetch_cid, fetch_text)
        cid, text = self.chunk(out['delivery_id'], ids[0], 0)
        self.echo(cid, text)
        self.end()
        self.assert_redelivered(ids)

    def test_a_failed_journal_write_confirms_nothing(self):
        ids, did = self.two_message_delivery()
        real = transcript_records.append_owned
        target = {}

        def failing(slug, sid, path, recs, incarnation=None):
            body = json.dumps(recs, ensure_ascii=False)
            if target and target['op'] in body:
                raise OSError('disk gone')
            return real(slug, sid, path, recs, incarnation=incarnation)
        cid, text = self.chunk(did, ids[1], 0)
        target['op'] = json.loads(text)['op_id']
        with patch.object(transcript_records, 'append_owned', failing):
            self.echo(cid, text)                   # swallowed by _codex_journal
        for k in range(4):
            c, t = self.chunk(did, ids[0], k)
            self.echo(c, t)
        self.end()
        self.assert_redelivered(ids)

    def test_a_record_without_a_session_is_never_confirmed(self):
        self.fresh(session=None)
        ids = self.deposit(body='small')
        self.begin()
        _cid, text = self.call({'action': 'fetch', 'message_ids': ids})
        out = json.loads(text)
        if not out.get('ok'):
            self.assertEqual(out['error'], 'custody_unproven')   # no session: no fetch at all
            return
        cid, text = self.chunk(out['delivery_id'], ids[0], 0)
        self.echo(cid, text)
        self.end()
        self.assert_redelivered(ids)

    def test_duplicate_echoes_confirm_once_and_a_rescan_changes_nothing(self):
        ids = self.deposit(body='small')
        self.begin()
        out, _c, _t = self.fetch(ids)
        did = out['delivery_id']
        for _ in range(2):                              # two distinct calls, same chunk
            cid, text = self.chunk(did, ids[0], 0)
            self.echo(cid, text)
            self.echo(cid, text)                        # and a duplicated echo
        self.end()
        self.assert_confirmed(ids, did)
        before = json.dumps(self.load().d, sort_keys=True)
        self.assertEqual(sup.scan_manual_records(self.slug, W),
                         {'candidates': 0, 'complete': 0})
        self.assertEqual(json.dumps(self.load().d, sort_keys=True), before)

    def test_a_failed_confirmation_save_keeps_the_batch_protected_and_resolves_later(self):
        ids = self.deposit(body='small')
        self.begin()
        out, _c, _t = self.fetch(ids)
        did = out['delivery_id']
        cid, text = self.chunk(did, ids[0], 0)
        self.echo(cid, text)
        with patch.object(store, 'save_org', side_effect=OSError('disk full')):
            self.assertEqual(sup.scan_manual_records(self.slug, W)['complete'], 1)
        self.assertEqual(len(self.journal_rows()), 1)      # nothing lost, nothing folded
        self.assertEqual(self.confirmed_receipts(), [])
        self.end()                                       # the scan runs again first
        self.assert_confirmed(ids, did)

    # ------------------------------------------------------- structure
    def test_the_turn_end_scan_runs_before_custody_release_and_the_fold(self):
        text = (Path(sup.__file__)).read_text(encoding='utf-8')
        steer = text.index('        scan_steer_records(slug, nid)\n')
        manual = text.index('        scan_manual_records(slug, nid)\n')
        release = text.index('mailruntime.release(st, attempt=turn_operation_id)')
        fold = text.index('_fold_back_undelivered(slug, nid, keep_toks=alive)')
        self.assertLess(steer, manual)
        self.assertLess(manual, release)
        self.assertLess(release, fold)
        self.assertEqual(len(re.findall(r'(?<!def )\bscan_manual_records\(', text)), 1)

    def test_a_manual_confirmation_does_not_spend_the_initial_ack_carrier(self):
        with patch.object(halt, 'consumed') as consumed:
            sup._confirm_delivered(self.slug, W, [])
        consumed.assert_called_once_with(self.slug, W)
        ids = self.deposit(body='small')
        self.begin()
        out, _c, _t = self.fetch(ids)
        cid, text = self.chunk(out['delivery_id'], ids[0], 0)
        self.echo(cid, text)
        with patch.object(halt, 'consumed') as consumed:
            self.end()
        consumed.assert_not_called()
        self.assert_confirmed(ids, out['delivery_id'])

    def test_other_codex_tool_results_are_journaled_exactly_as_before(self):
        for typ, tool in (('dynamicToolCall', 'orgtree_message'),
                          ('mcpToolCall', inbox.TOOL), ('commandExecution', None)):
            with self.subTest(typ=typ, tool=tool):
                params = self.item('call_x', 'out', tool=tool, typ=typ)
                rec = sup._codex_result_record(params, params['item'], 'T')
                body, failed = sup._codex_tool_result(params['item'])
                self.assertEqual(rec, {'type': 'user', 'timestamp': 'T', 'message': {
                    'role': 'user', 'content': [{'type': 'tool_result',
                                                 'tool_use_id': 'call_x', 'content': body,
                                                 'is_error': failed}]}})
        params = self.item('call_y', 'out')
        rec = sup._codex_result_record(params, params['item'], 'T')
        self.assertEqual(rec[inbox.ORIGIN_KEY], {
            'v': 1, 'kind': 'provider_echo', 'runtime': 'codex_app_server',
            'item_type': 'dynamicToolCall', 'tool': inbox.TOOL, 'thread_id': THREAD,
            'turn_id': TURN, 'item_id': 'call_y', 'failed': False})

    def test_the_matcher_names_why_it_refused(self):
        """The pure rule, reason by reason, on one real delivery."""
        ids = self.deposit(body='small')
        self.begin()
        out, fetch_cid, fetch_text = self.fetch(ids)
        did = out['delivery_id']
        cid, text = self.chunk(did, ids[0], 0)
        [row] = self.journal_rows()
        att = self.load().d['manual_attempts'][W][did]

        def rec_of(call_id, body, **kw):
            params = self.item(call_id, body, **kw)
            return json.dumps(sup._codex_result_record(params, params['item'], 'T'))

        def digest(seat, gen, call):
            return sup.codex_call_digest(self.slug, W, seat, gen, call)
        rows = [('good', rec_of(cid, text)),
                ('fetch', rec_of(fetch_cid, fetch_text)),
                ('forged', rec_of('call_forged', text)),
                ('thread', rec_of(cid, text, thread='thread-B')),
                ('junk', 'not json')]
        evidence, rejected = inbox.codex_chunk_evidence(row['manual'], att, rows,
                                                        key_digest=digest)
        self.assertEqual(list(evidence), [(ids[0], 0)])
        self.assertEqual(evidence[(ids[0], 0)]['ref'], 'good')
        self.assertEqual(rejected, {'nonce': 1, 'call': 1, 'session': 1, 'unreadable': 1})
        self.assertTrue(inbox.confirmation_complete(row['manual'], evidence))


if __name__ == '__main__':
    unittest.main()
