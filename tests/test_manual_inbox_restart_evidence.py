"""Manual inbox P08c: restart confirms a manual read from durable evidence.

P08b confirms a Codex manual delivery only in the turn-end scan. When the
engine dies mid-turn, or that scan fails, the batch is still journaled at the
next startup, and the restart fold would return it as a possible duplicate —
even when every chunk's matched provider echo is already committed to the
durable journal (or waiting in its recovery spool). `reconcile()` gives steers
a positive-evidence pass before that fold; this is the manual counterpart,
`_reconcile_manual_records`: the SAME selection, matcher and confirmation,
positive-only, run on the org in hand after the steer pass and before
`_reconcile_mail_journal`. The door stays CLOSED.

Synthetic stores only. The chain is real from the P08a keyed dispatch through
the receipted chunk reader, the Codex journal writer into the real transcript
database under a temporary data root, and the startup passes. The door
stand-in (`post`) is the same one the P08b suite uses. A "restart" is what
the landed restart tests simulate: the runtime state is dropped and the rows
name a prior engine.

⚠ ASSUMED, NOT OBSERVED (U2), as in P08b: the app-server's `item/completed`
`dynamicToolCall` `item.id` equals the `item/tool/call` `callId`. If it does
not, nothing matches here either and restart folds exactly as before.
"""
import copy
import itertools
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='manual-restart-evidence-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import (halt, inbox, ledger, mailruntime, net, opreceipts, store,
                     supervisor as sup, transcript_records)

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []
LIVE = 'op-live'
W = 'worker'
THREAD = 'thread-A'
TURN = 'turn-1'
OLD = '2000-01-01T00:00:00Z'
BIG = '€' * 70000 + 'end'          # 4 chunks of 3-byte characters
_SERIAL = itertools.count()


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class ManualRestartEvidenceTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"mre-{self._testMethodName.replace('_', '-')[:40]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.node(W)['session_id'] = THREAD
        store.save_org(org)
        self.st = sup.state(self.slug, W)
        self.gen = org.node(W)['generation']
        self.seat = org.node(W).get('seat_id')
        self.assertTrue(self.seat, 'a hired node has a seat (P04a)')
        self.n = 0
        self.calls = itertools.count()

    def tearDown(self):
        sup._state.pop((self.slug, W), None)
        sup._CODEX_EPOCH.pop(self.slug, None)
        sup._CODEX_KEYS.clear()
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def deposit(self, body='hello', count=1, **extra):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(W, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                 'from': 'boss', 'kind': 'message', 'body': body,
                                 'at': ledger.now(), **extra})
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

    def call(self, args):
        call_id = f'call_{next(self.calls)}'
        ident = {'call_id': call_id, 'thread_id': THREAD, 'turn_id': TURN, 'rid': call_id}
        text = sup.codex_keyed_dispatch(self.post, self.slug, W, self.seat, self.gen,
                                        inbox.TOOL, args, ident)
        return call_id, text

    def echo(self, call_id, text, *, mutate=None):
        """Journal the echo exactly as the Codex leg's `_on_item` does."""
        params = {'threadId': THREAD, 'turnId': TURN, 'item': {
            'type': 'dynamicToolCall', 'id': call_id, 'tool': inbox.TOOL, 'arguments': {},
            'status': 'completed', 'success': True,
            'contentItems': [{'type': 'inputText', 'text': text}]}}
        rec = sup._codex_result_record(params, params['item'], ledger.now())
        if mutate is not None:
            mutate(rec)
        sup._codex_journal(self.slug, THREAD, [rec],
                           incarnation=sup._transcript_incarnation(self.load(), W))

    def fetch(self, ids):
        _cid, text = self.call({'action': 'fetch', 'message_ids': ids})
        out = json.loads(text)
        self.assertTrue(out['ok'], out)
        return out

    def chunk(self, did, mid, k):
        cid, text = self.call({'action': 'chunk', 'delivery_id': did,
                               'message_id': mid, 'chunk_index': k})
        out = json.loads(text)
        self.assertTrue(out['ok'], out)
        self.assertIsNotNone(out['content'])
        return cid, text

    def plan(self):
        [row] = [r for r in self.journal_rows() if r.get('manual')]
        return {mid: p['chunk_total'] for mid, p in row['manual']['plan'].items()}

    def read_everything(self, did, *, skip=(), mutate=None):
        for mid, total in self.plan().items():
            for k in range(total):
                cid, text = self.chunk(did, mid, k)
                if (mid, k) not in skip:
                    self.echo(cid, text, mutate=mutate)

    def journal_rows(self):
        return copy.deepcopy((self.load().d.get('delivering') or {}).get(W) or [])

    def box(self):
        return (self.load().d.get('mail') or {}).get(W) or []

    def confirmed_receipts(self):
        return [r for r in ((self.load().d.get('mail_transitions') or {}).get(W) or {}).values()
                if r.get('outcome') == 'confirmed']

    def disclosures(self):
        return [e for e in (self.load().d.get('steered_log') or {}).get(W) or []
                if 'may see them twice' in e.get('text', '')]

    def delivery(self, *, echo_all=True, **kw):
        """A two-message manual read (one 4-chunk, one small), every chunk
        read by its own keyed call and — unless told otherwise — echoed."""
        ids = self.deposit(body=BIG) + self.deposit(body='small')
        self.begin()
        did = self.fetch(ids)['delivery_id']
        self.assertEqual(self.plan(), {ids[0]: 4, ids[1]: 1})
        if echo_all:
            self.read_everything(did, **kw)
        return ids, did

    def crash(self):
        """The process died mid-turn: no runtime state survives, and the rows
        name a prior engine (what the landed restart tests simulate)."""
        sup._state.pop((self.slug, W), None)
        sup._CODEX_KEYS.clear()
        self.st = sup.state(self.slug, W)
        org = self.load()
        for row in org.d['delivering'][W]:
            if row.get('manual'):
                row['manual']['engine'] = 'prior-engine'
            row['at'] = OLD
        store.save_org(org)

    def restart(self, gone=True, net_ids=None):
        """The two startup passes in `reconcile()`'s order, on one document
        and one save — the manual pass first, then the restart fold."""
        with store.DOC_LOCK:
            org = self.load()
            manual = sup._reconcile_manual_records(org, net_ids=net_ids)
            folded = sup._reconcile_mail_journal(org, owners_gone=lambda row: gone)
            store.save_org(org)
        return manual, folded

    def assert_confirmed(self, ids, did):
        self.assertFalse([r for r in self.journal_rows() if r.get('manual')])
        self.assertEqual(self.box(), [])
        [receipt] = self.confirmed_receipts()
        self.assertIn(did, receipt['deliveries'].values())
        self.assertEqual(self.disclosures(), [])
        gone = sup.manual_fetch_chunk(self.slug, W, self.gen, did, ids[0], 0)
        self.assertEqual(gone['content_state'], 'confirmed')
        self.assertIsNone(gone['content'])

    def assert_folded_as_before(self, ids):
        self.assertFalse(self.journal_rows())
        self.assertEqual([m['id'] for m in self.box()], ids)
        self.assertEqual([m.get('redelivered') for m in self.box()], [1] * len(ids))
        self.assertEqual(self.confirmed_receipts(), [])
        self.assertEqual(len(self.disclosures()), 1)

    # -------------------------------------------------------- the positive
    def test_restart_confirms_a_delivery_whose_every_chunk_was_echoed(self):
        ids, did = self.delivery()
        self.crash()
        self.assertEqual(self.restart(), (1, frozenset()))
        self.assert_confirmed(ids, did)
        self.assertEqual(len(self.load().d['manual_attempts'][W][did]['chunk_calls']), 5)
        before = json.dumps(self.load().d, sort_keys=True)
        self.assertEqual(self.restart(), (0, frozenset()))      # repeated startup
        self.assertEqual(json.dumps(self.load().d, sort_keys=True), before)

    def test_positive_evidence_confirms_without_the_restart_owner_proof(self):
        """Like the steer pass: delivery evidence is not a release of custody,
        so it does not wait for the prior engine to be proven gone."""
        ids, did = self.delivery()
        self.crash()
        self.assertEqual(self.restart(gone=False), (1, frozenset()))
        self.assert_confirmed(ids, did)

    def test_an_echo_still_in_the_recovery_spool_confirms_at_restart(self):
        ids, did = self.delivery(echo_all=False)
        with patch.object(transcript_records, '_commit_owned',
                          side_effect=sqlite3.OperationalError('database is locked')):
            self.read_everything(did)
        spool = Path(transcript_records._spool_path())
        self.assertTrue(spool.exists() and spool.read_text(encoding='utf-8').strip(),
                        'the control never reached the spool')
        self.crash()
        self.assertEqual(self.restart(), (1, frozenset()))
        self.assert_confirmed(ids, did)

    def test_the_whole_startup_reconcile_confirms_before_it_folds(self):
        ids, did = self.delivery()
        self.crash()
        with patch.object(sup, '_transcript_evidence', return_value=set()), \
                patch.object(sup, '_native_context_hold', return_value=None), \
                patch.object(sup, '_reconcile_steer_records', return_value=0), \
                patch.object(sup, '_restart_owners_gone', return_value=lambda row: True), \
                patch.object(sup, 'send_message', return_value={'accepted': True}):
            sup.reconcile(self.slug, active_only=True)
        self.assert_confirmed(ids, did)

    # --------------------------------------------------- negative controls
    def test_one_chunk_without_an_echo_folds_as_before(self):
        ids = self.deposit(body=BIG) + self.deposit(body='small')
        self.begin()
        did = self.fetch(ids)['delivery_id']
        self.read_everything(did, skip={(ids[0], 2)})
        self.crash()
        self.assertEqual(self.restart()[0], 0)
        self.assert_folded_as_before(ids)

    def test_an_unmarked_row_is_not_evidence_at_restart(self):
        def unmark(rec):
            rec.pop('orgtree_origin', None)
        self.assertIn('orgtree_origin', self._one_marked_record())
        ids, _did = self.delivery(mutate=unmark)
        self.crash()
        self.assertEqual(self.restart()[0], 0)
        self.assert_folded_as_before(ids)

    def _one_marked_record(self):
        params = {'threadId': THREAD, 'turnId': TURN, 'item': {
            'type': 'dynamicToolCall', 'id': 'c', 'tool': inbox.TOOL, 'arguments': {},
            'status': 'completed', 'success': True,
            'contentItems': [{'type': 'inputText', 'text': '{}'}]}}
        return sup._codex_result_record(params, params['item'], ledger.now())

    def test_a_halted_node_is_left_exactly_as_it_was(self):
        _ids, _did = self.delivery()
        self.crash()
        org = self.load()
        org.nodes[W]['halt'] = {'phase': 'halted', 'at': ledger.now()}
        store.save_org(org)
        before = self.journal_rows()
        self.assertEqual(self.restart(), (0, frozenset()))
        self.assertEqual(self.journal_rows(), before)
        self.assertEqual(self.confirmed_receipts(), [])

    def identity_changed(self, field, value):
        self.delivery()
        self.crash()
        org = self.load()
        org.nodes[W][field] = value
        store.save_org(org)
        with store.DOC_LOCK:
            org = self.load()
            self.assertEqual(len(sup._manual_candidates(org, W)), 0)
            self.assertEqual(sup._reconcile_manual_records(org), 0)
            self.assertFalse(mailruntime.confirmed_tokens(org, W))
        self.assertEqual(self.confirmed_receipts(), [])
        self.assertEqual(len(self.journal_rows()), 1)

    def test_a_changed_generation_is_never_confirmed(self):
        self.identity_changed('generation', self.gen + 1)

    def test_a_changed_seat_is_never_confirmed(self):
        self.identity_changed('seat_id', 'seat-other')

    def test_an_unreadable_journal_confirms_nothing(self):
        ids, _did = self.delivery()
        self.crash()
        with patch.object(transcript_records, 'records_containing',
                          side_effect=sqlite3.OperationalError('disk I/O error')) as read:
            self.assertEqual(self.restart()[0], 0)
        self.assertTrue(read.called, 'the control never reached the journal read')
        self.assert_folded_as_before(ids)

    def test_a_confirmation_failing_part_way_leaves_the_document_untouched(self):
        ids, _did = self.delivery()
        self.crash()
        org = self.load()
        # A drain demand naming the batch: confirmation retires it from the
        # NODE record before the injected failure, so the node is restored too.
        org.nodes[W]['mail_drain'] = {'ids': list(ids), 'at': OLD}
        store.save_org(org)
        with store.DOC_LOCK:
            org = self.load()
            before = json.dumps(org.d, sort_keys=True, default=str)
            with patch.object(mailruntime, 'write_reclaim_receipt',
                              side_effect=RuntimeError('boom')) as write:
                self.assertEqual(sup._reconcile_manual_records(org), 0)
            self.assertTrue(write.called, 'the failure was never injected')
            self.assertEqual(json.dumps(org.d, sort_keys=True, default=str), before)
        self.assertFalse(self.st.get('mail_confirmed'))

    # f1: a failure AFTER the confirmation receipt is written. `_confirm_locked`
    # writes `mail_transitions[nid]` in `write_reclaim_receipt`, then runs
    # `settle_replay` and `compact_receipts`; a failure there must still leave
    # the whole document as it was, for each shape that section can have.
    PRIOR = {'operation': 'op-prior', 'outcome': 'reclaimed', 'node': W,
             'identity': [], 'before': {'tok-prior': '0' * 64}}

    def fail_after_receipt_write(self, shape, *, at='compact_receipts'):
        ids, _did = self.delivery()
        self.crash()
        org = self.load()
        if shape == 'absent':
            org.d.pop('mail_transitions', None)
        elif shape == 'other_node_only':
            org.d['mail_transitions'] = {'someone-else': {'op-x': dict(self.PRIOR, node='someone-else')}}
        elif shape == 'node_receipt':
            org.d['mail_transitions'] = {W: {'op-prior': dict(self.PRIOR)}}
        store.save_org(org)
        real_write = mailruntime.write_reclaim_receipt
        written = []

        def write(org_, receipt):
            real_write(org_, receipt)
            written.append(receipt['operation'])
        with store.DOC_LOCK:
            org = self.load()
            self.assertEqual(('mail_transitions' in org.d,
                              W in (org.d.get('mail_transitions') or {})),
                             {'absent': (False, False), 'other_node_only': (True, False),
                              'node_receipt': (True, True)}[shape], 'precondition')
            before = json.dumps(org.d, sort_keys=True, default=str)
            with patch.object(mailruntime, 'write_reclaim_receipt', write), \
                    patch.object(mailruntime, at, side_effect=RuntimeError('boom')) as failed:
                self.assertEqual(sup._reconcile_manual_records(org), 0)
            self.assertEqual(len(written), 1, 'the receipt write was never reached')
            self.assertTrue(failed.called, 'the failure was never injected')
            self.assertEqual(json.dumps(org.d, sort_keys=True, default=str), before)
            self.assertFalse(mailruntime.confirmed_tokens(org, W))
            folded = sup._reconcile_mail_journal(org, owners_gone=lambda row: True)
            store.save_org(org)
        self.assertFalse(self.st.get('mail_confirmed'))
        self.assertEqual(len(folded), 1)                       # restart stays conservative
        self.assertEqual([m['id'] for m in self.box()], ids)
        self.assertEqual([m.get('redelivered') for m in self.box()], [1] * len(ids))
        self.assertEqual(self.confirmed_receipts(), [])
        self.assertEqual(len(self.disclosures()), 1)

    def test_a_failure_after_the_receipt_write_restores_an_absent_section(self):
        self.fail_after_receipt_write('absent')

    def test_a_failure_after_the_receipt_write_restores_a_section_without_the_node(self):
        self.fail_after_receipt_write('other_node_only')

    def test_a_failure_after_the_receipt_write_restores_the_nodes_prior_receipts(self):
        self.fail_after_receipt_write('node_receipt')

    def test_a_failure_in_settle_replay_after_the_receipt_write_also_rolls_back(self):
        self.fail_after_receipt_write('node_receipt', at='settle_replay')

    def test_a_failed_startup_save_is_resolved_by_the_next_startup(self):
        ids, did = self.delivery()
        self.crash()
        with patch.object(store, 'save_org', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.restart()
        self.assertEqual(len(self.journal_rows()), 1)           # nothing lost, nothing folded
        self.assertEqual(self.confirmed_receipts(), [])
        self.assertTrue(self.st.get('mail_confirmed'), 'pending evidence protects the batch')
        self.crash()                                            # and the process died again
        self.assertEqual(self.restart(), (1, frozenset()))
        self.assert_confirmed(ids, did)

    def test_the_manual_pass_sits_after_the_steer_pass_and_before_the_fold(self):
        text = Path(sup.__file__).read_text(encoding='utf-8')
        # S7 L3: reconcile's first block is `_reconcile_block`, one
        # org_tx(whole=True); its step 6 ends by recording whether to settle
        body = text[text.index('\ndef _reconcile_block(org: Org, slug: str'):]
        body = body[:body.index('\ndef ', 1)]
        steer = body.index('recorded = _reconcile_steer_records(org)')
        manual = body.index('manual = _reconcile_manual_records(org, net_ids=out["manual_net"])')
        fold = body.index('folded = _reconcile_mail_journal(org, owners_gone=_restart_owners_gone(),')
        save = body.index('out["settle"] = bool(recorded or manual or folded or restart_changed)')
        self.assertLess(steer, manual)
        self.assertLess(manual, fold)
        self.assertLess(fold, save)
        self.assertEqual(len(re.findall(r'(?<!def )\b_reconcile_manual_records\(', text)), 1)

    def test_restart_never_spends_the_initial_ack_and_marks_network_mail_read(self):
        ids = self.deposit(body='small', net_id='net-1')
        self.begin()
        did = self.fetch(ids)['delivery_id']
        self.read_everything(did)
        self.crash()
        with patch.object(sup, '_transcript_evidence', return_value=set()), \
                patch.object(sup, '_native_context_hold', return_value=None), \
                patch.object(sup, '_reconcile_steer_records', return_value=0), \
                patch.object(sup, '_restart_owners_gone', return_value=lambda row: True), \
                patch.object(sup, 'send_message', return_value={'accepted': True}), \
                patch.object(halt, 'consumed') as consumed, \
                patch.object(net, 'note_read') as note_read:
            sup.reconcile(self.slug, active_only=True)
        consumed.assert_not_called()
        note_read.assert_called_once_with(self.slug, ['net-1'])
        self.assert_confirmed(ids, did)

    def test_the_default_confirmation_is_unchanged(self):
        with patch.object(halt, 'consumed') as consumed:
            sup._confirm_delivered(self.slug, W, [])
        consumed.assert_called_once_with(self.slug, W, [])

    def test_rows_that_are_not_manual_reads_are_never_touched(self):
        _ids, did = self.delivery()
        self.crash()
        org = self.load()
        other = {'tok': 'tok-ordinary', 'at': OLD, 'mail': [
            {'id': 'x1', 'message_id': 'x1', 'from': 'boss', 'body': 'b'}]}
        org.d['delivering'][W].append(other)
        store.save_org(org)
        with store.DOC_LOCK:
            org = self.load()
            self.assertEqual(sup._reconcile_manual_records(org), 1)
            [left] = org.d['delivering'][W]
        self.assertEqual(left, other)
        del did


if __name__ == '__main__':
    unittest.main()
