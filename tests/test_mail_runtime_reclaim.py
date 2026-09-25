"""Synthetic real-store controls for atomic reclaim and ambiguous save outcomes."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='mail-runtime-reclaim-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import halt, ledger, maildrain, mailruntime, orgtx, store, supervisor as sup, transcript_ingest

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class ReclaimTransactionTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(self._testMethodName.replace('_', '-')[:58])
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        org.post_mail(ledger.USER, 'worker', 'synthetic mail')
        maildrain.request(org, 'worker')
        mails = list(org.d['mail']['worker'])
        self.message = copy.deepcopy(mails[0])
        org.d['mail']['worker'] = []
        self.tok = sup._journal_drain(org, 'worker', mails, [], via='steer')
        org.d['delivering']['worker'][0]['at'] = '2000-01-01T00:00:00Z'
        store.save_org(org)
        # PG-0's first org_tx per slug runs a one-time heal SAVE before its
        # locks. Run it here, so the patched store.save_org of a fault test
        # sees reclaim_orphans' own commit, not the heal.
        with orgtx.org_tx(self.slug):
            pass
        self.st = sup.state(self.slug, 'worker')
        self.before = store.load_org(self.slug)
        self.original = copy.deepcopy(self.before.d['delivering']['worker'][0])
        self.save = store.save_org
        self.load = store.load_org

    def tearDown(self):
        maildrain._forget(self.slug, 'worker')
        halt._workers.pop((self.slug, 'worker'), None)
        sup._state.pop((self.slug, 'worker'), None)
        store._POOL.close_all(self.slug)

    def canonical(self):
        return json.dumps(self.load(self.slug).d, sort_keys=True, ensure_ascii=False)

    def recover(self, **kw):
        return sup.reclaim_orphans(self.slug, 'worker', now=time.time(), **kw)

    def assert_once(self):
        fresh = self.load(self.slug)
        self.assertEqual(fresh.d.get('delivering', {}).get('worker', []), [])
        rows = fresh.d['mail']['worker']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['id'], self.message['id'])
        self.assertEqual(rows[0]['redelivered'], 1)
        for key in ('mailbox', 'recv_seq', 'seq_origin'):
            self.assertEqual(rows[0].get(key), self.message.get(key))
        self.assertEqual(fresh.nodes['worker']['mail_seq'], self.before.nodes['worker']['mail_seq'])
        self.assertFalse(self.st.get('mail_reclaiming'))
        self.assertFalse(self.st.get('mail_reclaim_intents'))
        return fresh


    def test_internal_inspection_is_pure_and_agrees_with_reclaim(self):
        # LazyDoc equality materialises only its left operand, so two plain
        # loads can compare unequal; compare the complete canonical documents.
        before = self.canonical()
        result = sup.inspect_mail_ownership(self.slug, 'worker')
        self.assertEqual(result.reclaimable_tokens, {self.tok})
        self.assertEqual(self.canonical(), before)
        self.st['queue'] = [self.carrier()]
        self.assertFalse(sup.inspect_mail_ownership(self.slug, 'worker').reclaimable_tokens)
        self.assertFalse(self.recover()['folded'])

    def test_halt_capture_preserves_handoff_and_publication_wait_across_state_loss(self):
        one, two = self.carrier(), self.carrier(base='second command')
        self.st['mail_handoffs'] = [one]
        self.st['mail_publication_wait'] = [two]
        with store.DOC_LOCK:
            halt._capture(self.load(self.slug), 'worker', self.st)
        self.assertFalse(self.st['mail_handoffs'])
        self.assertFalse(self.st['mail_publication_wait'])
        held = self.load(self.slug).node('worker')['halt_queue']
        self.assertEqual([c['text'] for c in held], [one['text'], two['text']])
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        self.assertFalse(self.recover()['folded'])

    def test_prelaunch_cancel_retains_composed_carrier_without_starting_provider(self):
        carrier = self.carrier()
        self.st['busy'] = True
        with patch.object(sup, '_cancel_working_cache'), patch.object(sup, '_note_working_activity'), \
             patch.object(sup, '_hold_for_deploy', return_value=False), \
             patch.object(sup, '_run_one_turn', side_effect=AssertionError('provider must not start')):
            sup._run_turn(self.slug, 'worker', carrier)
        held = self.load(self.slug).node('worker')['halt_queue']
        self.assertEqual(held, [carrier])
        self.assertFalse(self.st['busy'])
        self.assertFalse(self.recover()['folded'])

    def test_prelaunch_save_failure_keeps_complete_runtime_copy(self):
        carrier = self.carrier()
        with patch.object(sup, '_cancel_working_cache', side_effect=OSError('setup failed')), \
             patch.object(store, 'save_org', side_effect=OSError('storage failed')):
            with self.assertRaises(OSError):
                sup._run_turn(self.slug, 'worker', carrier)
        self.assertIn(carrier, self.st['halt_aux_carriers'])
        self.assertFalse(self.recover()['folded'])

    def test_first_notice_drain_allocates_identity_only_at_write_boundary(self):
        org = self.load(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'noticeonly')
        org.node('noticeonly').pop('mailbox_id', None)
        self.assertNotIn('mailbox_id', org.node('noticeonly'))
        tok = sup._journal_drain(org, 'noticeonly', [], [{'text': 'notice'}])
        row = org.d['delivering']['noticeonly'][0]
        self.assertEqual(row['custody']['mailbox'], org.node('noticeonly')['mailbox_id'])
        self.assertEqual(mailruntime.revalidate(org, 'noticeonly', [tok]), (frozenset([tok]), {}))
        org.node('noticeonly')['mailbox_id'] = False
        sup._journal_drain(org, 'noticeonly', [], [{'text': 'next notice'}])
        self.assertIs(org.node('noticeonly')['mailbox_id'], False)
        sup._state.pop((self.slug, 'noticeonly'), None)

    def confirm(self):
        sup._confirm_delivered(self.slug, 'worker', [self.tok])

    def assert_confirmed(self):
        fresh = self.load(self.slug)
        self.assertIn(self.tok, mailruntime.confirmed_tokens(fresh, 'worker'))
        self.assertFalse(fresh.d.get('delivering', {}).get('worker'))
        self.assertFalse(fresh.d.get('mail', {}).get('worker'))
        self.assertFalse(self.st.get('mail_confirmed'))
        return fresh

    def test_confirmation_precommit_failure_remains_protected_until_retry(self):
        with patch.object(store, 'save_org', side_effect=OSError('before commit')):
            self.confirm()
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.assertEqual(self.load(self.slug).d['delivering']['worker'], [self.original])
        self.assertFalse(self.recover()['folded'])
        self.confirm()
        fresh = self.assert_confirmed()
        self.assertEqual(len(fresh.d['mail_transitions']['worker']), 1)
        self.confirm()
        self.assertEqual(len(self.assert_confirmed().d['mail_transitions']['worker']), 1)

    def test_confirmation_response_lost_after_commit_has_positive_proof(self):
        def lost(org):
            self.save(org)
            raise OSError('lost response')
        with patch.object(store, 'save_org', side_effect=lost):
            self.confirm()
        self.assert_confirmed()

    def test_confirmation_outcome_read_failure_retains_evidence(self):
        entered = False
        def lost(org):
            nonlocal entered
            self.save(org)
            entered = True
            raise OSError('lost response')
        def load(slug):
            if entered:
                raise OSError('outcome unreadable')
            return self.load(slug)
        # PG-3d: the confirmation's outcome read is `orgtx.org_read` now
        with patch.object(store, 'load_org', side_effect=load),                 patch.object(orgtx, 'org_read', side_effect=lambda slug, **_: load(slug)),                 patch.object(store, 'save_org', side_effect=lost):
            self.confirm()
        self.assertTrue(entered, 'the lost-response injection never ran')
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.confirm()
        self.assert_confirmed()

    def test_missing_journal_does_not_confirm_without_a_receipt(self):
        org = self.load(self.slug)
        org.d['delivering'].pop('worker')
        self.save(org)
        self.confirm()
        # No row: nothing is confirmed durably, and nothing is left to protect.
        self.assertFalse(mailruntime.confirmed_tokens(self.load(self.slug), 'worker'))
        self.assertFalse(self.load(self.slug).d.get('mail_transitions'))
        self.assertFalse(self.st.get('mail_confirmed'))

    def test_reclaim_receipt_is_not_a_confirmation_receipt(self):
        self.recover()
        self.confirm()
        self.assertFalse(mailruntime.confirmed_tokens(self.load(self.slug), 'worker'))
        self.assertFalse(self.st.get('mail_confirmed'))

    def test_late_confirmation_after_reclaim_does_not_stall_recovery(self):
        self.recover()
        self.confirm()                      # late positive evidence; the row is gone
        started = []
        with patch.object(sup, '_start_turn_worker',
                          side_effect=lambda *a: started.append(a)):
            self.assertTrue(maildrain.recover(self.slug, 'worker'))
        self.assertEqual(len(started), 1)
        self.assertEqual([m['id'] for m in self.load(self.slug).d['mail']['worker']],
                         [self.message['id']])

    def fresh_batch(self, body):
        org = self.load(self.slug)
        org.post_mail(ledger.USER, 'worker', body)
        mails = list(org.d['mail']['worker'])
        org.d['mail']['worker'] = []
        tok = sup._journal_drain(org, 'worker', mails, [], via='steer')
        self.save(org)
        return tok

    def test_settled_receipts_do_not_accumulate(self):
        self.confirm()
        for i in range(4):
            tok = self.fresh_batch(f'next {i}')
            sup._confirm_delivered(self.slug, 'worker', [tok])
        records = self.load(self.slug).d['mail_transitions']['worker']
        self.assertEqual([set(r['before']) for r in records.values()], [{tok}])
        # A carrier paused in this process still cannot deliver pruned mail.
        self.assertEqual(mailruntime.reclaimed(self.st, [self.tok]), {self.tok})
        with sup._state_lock:
            projected = sup._publishable(self.st, self.carrier())
        self.assertEqual(projected['text'], 'authored [MAIL] quotation')
        self.assertEqual(projected['toks'], [])
        self.assertFalse(self.st.get('mail_confirmed'))

    def test_receipt_named_by_a_durable_record_is_kept(self):
        self.confirm()
        org = self.load(self.slug)
        org.node('worker')['inflight'] = {
            'at': '2000-01-01T00:00:00Z', 'text': 'x', 'view': 'x',
            'mail_input': {'attempt': 'a', 'tokens': [self.tok],
                           'base': {'text': 'x', 'view': 'x'}}}
        self.save(org)
        sup._confirm_delivered(self.slug, 'worker', [self.fresh_batch('next')])
        fresh = self.load(self.slug)
        self.assertIn(self.tok, mailruntime.confirmed_tokens(fresh, 'worker'))
        self.assertIsNotNone(mailruntime.replay_ready(fresh, 'worker',
                                                      fresh.node('worker')['inflight']))
        org = self.load(self.slug)
        org.node('worker').pop('inflight')
        self.save(org)
        sup._confirm_delivered(self.slug, 'worker', [self.fresh_batch('last')])
        self.assertNotIn(self.tok, mailruntime.confirmed_tokens(self.load(self.slug), 'worker'))

    def test_admission_hold_leaves_one_complete_copy_and_no_stale_handoff(self):
        carrier = self.carrier()
        with sup._state_lock:
            self.st['busy'] = True
            mailruntime.fence(self.st, [self.tok])     # a reclaim is mid-flight
            mailruntime.hold_handoff(self.st, carrier)  # as _start_turn_worker does
        with patch.object(sup, '_cancel_working_cache'),              patch.object(sup, '_note_working_activity'),              patch.object(sup, '_hold_for_deploy', return_value=True):
            sup._run_turn(self.slug, 'worker', carrier)
        self.assertFalse(self.st['busy'])
        self.assertEqual(self.st.get('mail_handoffs'), [])
        self.assertEqual(self.st['mail_publication_wait'], [carrier])
        with sup._state_lock:
            mailruntime.unfence(self.st, [self.tok])  # that reclaim never committed
        # The retained copy returns to the queue WHOLE and keeps its batch.
        self.assertFalse(self.recover()['folded'])
        self.assertEqual(self.st['queue'], [carrier])
        self.assertFalse(self.st.get('mail_publication_wait'))
        self.assertEqual(self.st.get('mail_handoffs'), [])
        self.assertEqual(self.load(self.slug).d['delivering']['worker'], [self.original])

    def test_unresolved_reclaim_intent_keeps_its_receipt(self):
        self.recover()
        operation, receipt = next(iter(
            self.load(self.slug).d['mail_transitions']['worker'].items()))
        self.st.setdefault('mail_reclaim_intents', {})[operation] = receipt
        sup._confirm_delivered(self.slug, 'worker', [self.fresh_batch('next')])
        self.assertIn(operation, self.load(self.slug).d['mail_transitions']['worker'])

    def test_confirmation_receipt_survives_empty_runtime_state(self):
        self.confirm()
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        with patch.object(store, 'save_org', side_effect=AssertionError('duplicate write')):
            self.confirm()
        self.assert_confirmed()

    def carrier(self, *, tok=None, base='authored [MAIL] quotation', prefix='generated mail\n\n'):
        tok = tok or self.tok
        original = {'text': base, 'view': base, 'retry_payload': base,
                    'segs': [{'kind': 'text', 'text': base}]}
        return {'toks': [tok], 'text': prefix + base, 'view': prefix + base,
                'retry_payload': base, 'segs': original['segs'],
                'mail_projection': {'base': original,
                    'chunks': [{'tok': tok, 'text': prefix, 'view': prefix}]}}

    def test_late_publisher_preserves_authored_payload_after_successful_fold(self):
        carrier = self.carrier()
        def save(org):
            with sup._state_lock:
                self.assertIsNone(sup._publishable(self.st, carrier))
            self.assertEqual(self.st['mail_publication_wait'], [carrier])
            self.save(org)
        with patch.object(store, 'save_org', side_effect=save):
            self.recover()
        self.assert_once()
        self.assertFalse(self.st.get('mail_publication_wait'))
        ready = self.st['queue'][0]
        self.assertEqual(ready['text'], 'authored [MAIL] quotation')
        self.assertEqual(ready['view'], ready['text'])
        self.assertEqual(ready['retry_payload'], ready['text'])
        self.assertEqual(ready['segs'], carrier['segs'])
        self.assertEqual(ready['toks'], [])
        self.assertEqual(carrier['toks'], [self.tok])

    def test_late_publisher_keeps_entire_envelope_when_save_never_committed(self):
        carrier = self.carrier()
        def fail(org):
            with sup._state_lock:
                self.assertIsNone(sup._publishable(self.st, carrier))
            raise OSError('before commit')
        with patch.object(store, 'save_org', side_effect=fail):
            with self.assertRaises(OSError):
                self.recover()
        self.assertFalse(self.recover()['folded'])
        self.assertEqual(self.st['queue'], [carrier])
        self.assertEqual(self.load(self.slug).d['delivering']['worker'], [self.original])

    def test_unproven_stale_composition_is_retained_without_editing_words(self):
        carrier = {'toks': [self.tok], 'text': 'mail or an authored quotation?',
                   'view': 'exact human words', 'cmd': True, 'retry_payload': 'original replay'}
        mailruntime.note_reclaimed(self.st, [self.tok])
        with sup._state_lock:
            self.assertIsNone(sup._publishable(self.st, carrier))
        self.assertEqual(self.st['mail_publication_wait'], [carrier])

    def test_mixed_batch_projection_keeps_only_surviving_generated_chunk(self):
        carrier = self.carrier(prefix='first\n\n')
        chunk = {'tok': 'other', 'text': 'second\n\n', 'view': 'second\n\n'}
        carrier['mail_projection']['chunks'].append(chunk)
        carrier['toks'].append('other')
        carrier['text'] = carrier['view'] = 'first\n\nsecond\n\nauthored [MAIL] quotation'
        mailruntime.note_reclaimed(self.st, [self.tok])
        ready, outcome = mailruntime.project_carrier(self.st, carrier)
        self.assertEqual(outcome, 'ready')
        self.assertEqual(ready['toks'], ['other'])
        self.assertEqual(ready['text'], 'second\n\nauthored [MAIL] quotation')
        carrier['text'] += 'changed outside composer'
        held, outcome = mailruntime.project_carrier(self.st, carrier)
        self.assertEqual(outcome, 'composition_unproven')
        self.assertEqual(held, carrier)

    def test_queue_pop_is_protected_before_next_attempt_adopts_it(self):
        self.st['queue'].append(self.carrier())
        with sup._state_lock:
            carrier = sup._take_queued_carrier(self.st)
        self.assertFalse(self.st['queue'])
        self.assertFalse(self.recover()['folded'])
        org = self.load(self.slug)
        with sup._state_lock:
            self.st.update(busy=True, lifecycle_operation_id='new-attempt')
            mailruntime.register(self.st, org, 'worker', attempt='new-attempt', toks=carrier['toks'])
            mailruntime.adopt_handoffs(self.st, carrier['toks'])
        self.assertFalse(self.st['mail_handoffs'])
        self.assertFalse(self.recover()['folded'])

    def test_local_steer_pump_is_protected_without_queue_or_limbo(self):
        self.st.setdefault('steer', []).append(self.carrier())
        carriers = sup.pop_steer(self.slug, 'worker', defer_commit=True)
        self.assertEqual(len(carriers), 1)
        self.assertFalse(self.st['steer'])
        self.assertFalse(self.st.get('steer_limbo'))
        self.assertFalse(self.recover()['folded'])

    def test_steer_confirmation_failure_retains_pending_and_retry_is_once(self):
        carrier = self.carrier()
        with patch.object(sup, 'stream'), patch.object(store, 'save_org', side_effect=OSError('before commit')):
            sup.commit_steer(self.slug, 'worker', [carrier])
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.assertFalse(self.recover()['folded'])
        with patch.object(sup, '_emit_committed_steer'), patch.object(sup, 'stream'):
            sup.commit_steer(self.slug, 'worker', [carrier])
            sup.commit_steer(self.slug, 'worker', [carrier])
        fresh = self.assert_confirmed()
        self.assertEqual(len(fresh.d['steered_log']['worker']), 1)

    def test_steer_confirmation_lost_response_does_not_duplicate_log(self):
        carrier = self.carrier()
        def lost(org):
            self.save(org)
            raise OSError('response lost')
        with patch.object(sup, '_emit_committed_steer'), patch.object(sup, 'stream'), patch.object(store, 'save_org', side_effect=lost):
            sup.commit_steer(self.slug, 'worker', [carrier])
        self.assert_confirmed()
        with patch.object(sup, '_emit_committed_steer'), patch.object(sup, 'stream'):
            sup.commit_steer(self.slug, 'worker', [carrier])
        self.assertEqual(len(self.load(self.slug).d['steered_log']['worker']), 1)

    def test_restart_refuses_durable_claims_uncertainty_and_retention(self):
        for field in ('claim', 'attempt', 'manual', 'input', 'halt', 'native', 'durable_attempt'):
            with self.subTest(field=field):
                org = self.load(self.slug)
                org.d['delivering']['worker'] = [copy.deepcopy(self.original)]
                org.nodes['worker'].pop('halt_queue', None)
                org.nodes['worker'].pop('native_held_carriers', None)
                org.d.get('steer_attempts', {}).pop('worker', None)
                row = org.d['delivering']['worker'][0]
                if field == 'claim': row['claim'] = {'delivery_id': 'claim', 'acked': False}
                if field == 'attempt': row['attempt'] = {'outcome': 'unknown'}
                if field == 'manual': row['mode'] = 'manual_fetch'
                if field == 'input': row['input_attempt'] = 'attempt before process death'
                if field == 'halt': org.nodes['worker']['halt_queue'] = [self.carrier()]
                if field == 'native': org.nodes['worker']['native_held_carriers'] = [self.carrier()]
                if field == 'durable_attempt': org.d['steer_attempts'] = {'worker': {'claim': {'toks': [self.tok], 'acked': False}}}
                self.save(org)
                sup._state.pop((self.slug, 'worker'), None)
                with store.DOC_LOCK:
                    fresh = self.load(self.slug)
                    self.assertFalse(sup._reconcile_mail_journal(fresh))
        self.st = sup.state(self.slug, 'worker')

    def test_restart_folds_old_unowned_batch_once_with_positive_receipt(self):
        with store.DOC_LOCK:
            org = self.load(self.slug)
            self.assertEqual(sup._reconcile_mail_journal(org), {self.tok})
            self.save(org)
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        with store.DOC_LOCK:
            fresh = self.load(self.slug)
            self.assertFalse(sup._reconcile_mail_journal(fresh))
        self.assert_once()

    def test_competing_reclaims_and_late_publication_are_serialized(self):
        import threading
        entered, release, second_started = (threading.Event() for _ in range(3))
        outcomes, errors = [], []
        def save(org):
            entered.set()
            if not release.wait(5):
                raise AssertionError('barrier timed out')
            self.save(org)
        def first():
            try: outcomes.append(self.recover())
            except BaseException as exc: errors.append(exc)
        def second():
            second_started.set()
            first()
        threads = [threading.Thread(target=first), threading.Thread(target=second)]
        with patch.object(store, 'save_org', side_effect=save):
            threads[0].start()
            try:
                self.assertTrue(entered.wait(5))
                threads[1].start()
                self.assertTrue(second_started.wait(5))
                with sup._state_lock:
                    self.assertIsNone(sup._publishable(self.st, self.carrier()))
                self.assertEqual(outcomes, [])
            finally:
                release.set()
                for thread in threads:
                    if thread.ident is not None: thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(sum(bool(o['folded']) for o in outcomes), 1)
        self.assert_once()

    def test_cleanup_cannot_fold_a_batch_held_by_another_carrier(self):
        self.st['queue'].append(self.carrier())
        sup._fold_back_undelivered(self.slug, 'worker')
        self.assertEqual(self.load(self.slug).d['delivering']['worker'], [self.original])
        self.st['queue'].clear()
        sup._fold_back_undelivered(self.slug, 'worker')
        self.assert_once()

    def test_fold_bookkeeping_and_positive_receipt_share_one_save(self):
        seen = []
        def save(org):
            self.assertEqual(org.nodes['worker']['synthetic_recovery'], 'same transaction')
            self.assertEqual(len(org.d['mail_transitions']['worker']), 1)
            self.assertFalse(org.d['delivering'].get('worker'))
            acquired = sup._state_lock.acquire(blocking=False)
            self.assertTrue(acquired, 'save callback must not inherit the state lock')
            if acquired:
                sup._state_lock.release()
            seen.append(True)
            self.save(org)
        with patch.object(store, 'save_org', side_effect=save):
            out = self.recover(mutate=lambda org: org.nodes['worker'].__setitem__('synthetic_recovery', 'same transaction'))
        self.assertEqual(seen, [True])
        self.assertTrue(out['saved'])
        self.assertEqual(out['folded'], {self.tok})
        self.assert_once()

    def test_precommit_failure_keeps_original_rows_and_retry_folds_once(self):
        with patch.object(store, 'save_org', side_effect=OSError('before commit')):
            with self.assertRaisesRegex(OSError, 'before commit'):
                self.recover()
        fresh = self.load(self.slug)
        self.assertEqual(fresh.d['delivering']['worker'], [self.original])
        self.assertFalse(fresh.d.get('mail_transitions'))
        self.assertFalse(self.st.get('mail_reclaiming'))
        self.recover()
        self.assert_once()

    def test_response_lost_after_commit_is_resolved_by_exact_receipt(self):
        def lost(org):
            self.save(org)
            raise OSError('response lost')
        with patch.object(store, 'save_org', side_effect=lost):
            out = self.recover()
        self.assertTrue(out['saved'])
        self.assertEqual(out['outcome'], 'committed')
        self.assert_once()
        again = self.recover()
        self.assertFalse(again['saved'])
        self.assertFalse(again['folded'])
        self.assert_once()

    def test_unreadable_postcommit_outcome_retains_fence_until_fresh_receipt(self):
        org = self.load(self.slug)
        def lost(doc):
            self.save(doc)
            raise OSError('response lost')
        with store.DOC_LOCK, patch.object(store, 'save_org', side_effect=lost), \
                patch.object(store, 'load_org', side_effect=OSError('read unavailable')):
            with self.assertRaisesRegex(OSError, 'read unavailable'):
                self.recover(org=org)
        self.assertEqual(self.st['mail_reclaiming'], {self.tok})
        self.assertEqual(len(self.st['mail_reclaim_intents']), 1)
        out = self.recover()
        self.assertEqual(list(out['resolved'].values()), ['committed'])
        self.assert_once()

    def test_unreadable_precommit_outcome_retains_fence_and_retries_original(self):
        org = self.load(self.slug)
        with store.DOC_LOCK, patch.object(store, 'save_org', side_effect=OSError('no commit')), \
                patch.object(store, 'load_org', side_effect=OSError('read unavailable')):
            with self.assertRaisesRegex(OSError, 'read unavailable'):
                self.recover(org=org)
        self.assertEqual(self.st['mail_reclaiming'], {self.tok})
        out = self.recover()
        self.assertEqual(list(out['resolved'].values()), ['unchanged'])
        self.assert_once()

    def test_absent_journal_without_positive_receipt_is_ambiguous(self):
        def missing(_org):
            fresh = self.load(self.slug)
            fresh.d['delivering'].pop('worker')
            self.save(fresh)
            raise OSError('uncertain external transition')
        with patch.object(store, 'save_org', side_effect=missing):
            with self.assertRaisesRegex(OSError, 'uncertain'):
                self.recover()
        self.assertEqual(self.st['mail_reclaiming'], {self.tok})
        self.assertFalse(self.st.get('mail_reclaimed'))
        out = self.recover()
        self.assertEqual(list(out['resolved'].values()), ['ambiguous'])
        self.assertFalse(out['saved'])
        self.assertEqual(self.st['mail_reclaiming'], {self.tok})

    def test_partial_mutation_is_discarded_before_retry(self):
        def fail(org):
            org.nodes['worker']['must_not_persist'] = True
            raise RuntimeError('after in-memory fold')
        with self.assertRaisesRegex(RuntimeError, 'in-memory fold'):
            self.recover(mutate=fail)
        fresh = self.load(self.slug)
        self.assertNotIn('must_not_persist', fresh.nodes['worker'])
        self.assertEqual(fresh.d['delivering']['worker'], [self.original])
        self.recover()
        self.assert_once()

    def test_retained_fence_is_also_visible_to_the_shared_classifier(self):
        with sup._state_lock:
            mailruntime.fence(self.st, [self.tok])
            facts = mailruntime.runtime_facts(self.st)
        classification, _ = mailruntime.classify(self.before, 'worker', facts, now=time.time(), pump_toks=())
        self.assertFalse(classification.by_token[self.tok].reclaimable)
        self.assertFalse(self.recover()['folded'])

    def test_old_tombstone_survives_many_unrelated_reclaims(self):
        with sup._state_lock:
            mailruntime.note_reclaimed(self.st, [self.tok])
            mailruntime.note_reclaimed(self.st, [f'unrelated-{i}' for i in range(1024)])
        self.assertEqual(mailruntime.reclaimed(self.st, [self.tok]), {self.tok})

    def test_busy_unrelated_worker_does_not_hide_orphan_or_start_another_turn(self):
        self.st['busy'] = True
        halt._workers[(self.slug, 'worker')] = 1
        with patch.object(sup, '_native_context_hold', return_value=None), \
                patch.object(sup, 'scan_steer_records'), \
                patch.object(sup, '_start_turn_worker') as launch:
            self.assertFalse(maildrain.recover(self.slug, 'worker'))
        launch.assert_not_called()
        self.assert_once()
        self.assertTrue(self.st['busy'])

    def test_outer_completion_cannot_erase_newer_attempt_identity_or_custody(self):
        seen = []
        def switched(_slug, _nid, _text, **kwargs):
            seen.append(kwargs['operation_id'])
            self.st['lifecycle_operation_id'] = 'new-attempt'
            self.st['mail_attempt_id'] = 'new-attempt'
            self.st['mail_attempt_tokens'] = [self.tok]
            mailruntime.register(self.st, self.before, 'worker', attempt='new-attempt', toks=[self.tok])
        with patch.object(transcript_ingest, 'capture_safely'), \
                patch.object(sup.turnlog, 'start', return_value=None), \
                patch.object(sup, '_run_one_turn_recorded', side_effect=switched):
            sup._run_one_turn.__wrapped__(self.slug, 'worker', 'synthetic')
        self.assertEqual(len(seen), 1)
        self.assertNotEqual(seen[0], 'new-attempt')
        self.assertEqual(self.st['lifecycle_operation_id'], 'new-attempt')
        self.assertEqual(self.st['mail_attempt_tokens'], [self.tok])
        self.assertEqual(self.st['mail_custody'][0]['attempt'], 'new-attempt')

    def record_input(self, *, carrier=None):
        carrier = self.carrier() if carrier is None else carrier
        org = self.load(self.slug)
        marker = {'at': '2000-01-01T00:00:01Z', 'text': carrier['text'],
                  'view': carrier['view'], 'segments': copy.deepcopy(carrier.get('segs', []))}
        mailruntime.record_input(org, 'worker', [self.tok], attempt='actual-attempt',
            base=mailruntime.replay_base(carrier), marker=marker)
        org.nodes['worker']['inflight'] = marker
        self.save(org)
        return copy.deepcopy(marker)

    def startup(self):
        dispatched = []
        def dispatch(slug, nid, carrier, **kwargs):
            dispatched.append((nid, carrier))
            return {'accepted': True, 'queued': 0}
        with patch.object(sup, '_transcript_evidence', return_value=set()), \
                patch.object(sup, '_native_context_hold', return_value=None), \
                patch.object(sup, '_reconcile_steer_records', return_value=0), \
                patch.object(sup, 'send_message', side_effect=dispatch):
            sup.reconcile(self.slug, active_only=True)
        return dispatched

    # ---- decision33: restart fold-back once the prior runtime is proven gone ----

    MINE = 1000.0      # this engine's creation time in the synthetic process table
    PRIOR = 4242       # the engine the restart-wake registry names

    def restart_proof(self, *, prior=None, dead=None, parents=None, created=None,
                      table=True):
        """Patch only the OS/registry evidence; every product rule stays real."""
        import contextlib
        from orgtree import restart_wake
        prior = self.PRIOR if prior is None else prior
        dead = {prior} if dead is None else set(dead)
        created = dict(created or {})
        created.setdefault(os.getpid(), self.MINE)
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(restart_wake, '_wakes_read',
                                         return_value={'running_backend_pid': prior}))
        stack.enter_context(patch.object(sup, '_pid_provably_dead',
                                         side_effect=lambda pid: pid in dead))
        stack.enter_context(patch.object(sup, '_process_created',
                                         side_effect=lambda pid: created.get(pid)))
        stack.enter_context(patch.object(sup, '_process_parents',
                                         return_value=(dict(parents or {}) if table else None)))
        return stack

    def fresh_state(self):
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')

    def make_legacy(self):
        org = self.load(self.slug)
        row = org.d['delivering']['worker'][0]
        row.pop('custody')
        row.pop(mailruntime.ENGINES, None)
        self.save(org)

    def written_by_prior(self):
        """The rows a restart meets were written by the engine before it."""
        org = self.load(self.slug)
        for row in org.d['delivering']['worker']:
            row[mailruntime.ENGINES] = [self.PRIOR]
        self.save(org)

    def test_rows_written_by_this_engine_are_never_restart_folded(self):
        self.record_input()                   # engines == [this process]
        with self.restart_proof():
            self.fresh_state()
            self.assertEqual(self.startup(), [])
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])

    def disclosures(self):
        return [e for e in self.load(self.slug).d.get('steered_log', {}).get('worker', [])
                if e.get('where') == 'restart']

    def test_restart_folds_legacy_row_once_when_prior_runtime_is_gone(self):
        self.make_legacy()
        self.fresh_state()
        with self.restart_proof():
            self.startup()
        fresh = self.assert_once()
        self.assertEqual([d['fold'] for d in self.disclosures()], [1])
        self.assertIn(self.tok, mailruntime.settled_tokens(fresh, 'worker',
                                                           outcomes={'reclaimed'}))
        self.fresh_state()
        with self.restart_proof():           # repeated restart is idempotent
            self.startup()
        self.assert_once()
        self.assertEqual(len(self.disclosures()), 1)

    def test_restart_folds_uncertain_input_and_replays_authored_base_only(self):
        self.record_input()
        self.written_by_prior()
        self.fresh_state()
        with self.restart_proof():
            dispatched = self.startup()
        self.assertEqual(len(dispatched), 1)
        self.assertIn('authored [MAIL] quotation', dispatched[0][1])
        self.assertNotIn('generated mail', dispatched[0][1])
        self.assert_once()
        self.assertEqual([d['fold'] for d in self.disclosures()], [1])
        self.fresh_state()
        with self.restart_proof():
            again = self.startup()
        # The marker was spent: no second replay. The folded mail still waits
        # (the fake dispatch ran no turn), so only the ordinary nudge remains.
        self.assertNotIn('authored [MAIL] quotation', ''.join(c for _, c in again))
        self.assertNotIn('generated mail', ''.join(c for _, c in again))
        self.assert_once()
        self.assertEqual(len(self.disclosures()), 1)

    def test_surviving_child_of_prior_runtime_keeps_the_row_until_it_is_gone(self):
        self.record_input()
        self.written_by_prior()
        child = {9001: self.PRIOR}
        with self.restart_proof(parents=child, created={9001: self.MINE - 5}):
            self.fresh_state()
            self.assertEqual(self.startup(), [])
        fresh = self.load(self.slug)
        row = fresh.d['delivering']['worker'][0]
        self.assertEqual(row['input_attempt'], 'actual-attempt')
        self.assertIn(self.PRIOR, row[mailruntime.ENGINES])       # owner remembered
        self.assertFalse(self.disclosures())
        # A later restart names a newer engine; the old child is still alive.
        with self.restart_proof(prior=5555, dead={5555, self.PRIOR},
                                parents=child, created={9001: self.MINE - 5}):
            self.fresh_state()
            self.assertEqual(self.startup(), [])
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])
        # The child has ended: now the row returns, once.
        with self.restart_proof(prior=5555, dead={5555, self.PRIOR, 9001}):
            self.fresh_state()
            self.assertEqual(len(self.startup()), 1)
        self.assert_once()

    def test_unproven_legacy_owner_is_remembered_across_restarts(self):
        self.make_legacy()
        child = {9001: self.PRIOR}
        with self.restart_proof(parents=child, created={9001: self.MINE - 5}):
            self.fresh_state()
            self.startup()
        row = self.load(self.slug).d['delivering']['worker'][0]
        self.assertEqual(row.get(mailruntime.ENGINES), [self.PRIOR])
        # Next restart: a newer engine, while the first one's child still runs.
        with self.restart_proof(prior=5555, dead={5555, self.PRIOR},
                                parents=child, created={9001: self.MINE - 5}):
            self.fresh_state()
            self.startup()
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])
        with self.restart_proof(prior=5555, dead={5555, self.PRIOR, 9001}):
            self.fresh_state()
            self.startup()
        self.assert_once()

    def sandboxed(self):
        org = self.load(self.slug)
        org.d['sandbox'] = {'enabled': True}
        self.save(org)
        self.assertTrue(sup.sbx.is_sandboxed(self.load(self.slug)))

    def test_sandboxed_org_needs_container_evidence_not_just_host_proof(self):
        # decision35: the provider runs inside the container; the host table
        # sees only the docker client, so host proof alone is not proof.
        self.make_legacy()
        self.sandboxed()
        for state in (None,                          # docker cannot say
                      (True, self.MINE - 60),        # running since before us
                      # clock skew: the daemon (VM) clock says the running
                      # container started after us; a running container is
                      # still never proof (review N2)
                      (True, self.MINE + 3600),
                      (True, None)):
            with self.subTest(state=state):
                with self.restart_proof(), \
                        patch.object(sup, '_sandbox_container_state', return_value=state):
                    self.fresh_state()
                    self.startup()
                rows = self.load(self.slug).d.get('delivering', {}).get('worker')
                self.assertTrue(rows, 'sandboxed row folded without container evidence')
                self.assertEqual(rows[0].get(mailruntime.ENGINES), [self.PRIOR])
                self.assertFalse(self.disclosures())

    def test_sandboxed_org_folds_once_container_evidence_is_positive(self):
        for name, state in (('stopped', (False, self.MINE - 60)),
                            ('stopped_unreadable_start', (False, None))):
            with self.subTest(name=name):
                org = self.load(self.slug)
                org.d['delivering']['worker'] = [copy.deepcopy(self.original)]
                org.d['delivering']['worker'][0].pop('custody')
                org.d['delivering']['worker'][0].pop(mailruntime.ENGINES, None)
                org.d['mail']['worker'] = []
                org.d['sandbox'] = {'enabled': True}
                self.save(org)
                with self.restart_proof(), \
                        patch.object(sup, '_sandbox_container_state', return_value=state):
                    self.fresh_state()
                    self.startup()
                fresh = self.load(self.slug)
                self.assertFalse(fresh.d.get('delivering', {}).get('worker'))
                self.assertEqual([m['id'] for m in fresh.d['mail']['worker']],
                                 [self.message['id']])

    def test_container_state_parsing_refuses_anything_unclear(self):
        from types import SimpleNamespace as NS
        cases = {
            'false 2026-09-22T21:00:00.123456789Z': (False, 1790110800.123456),
            'true 0001-01-01T00:00:00Z': (True, -62135596800.0),
            'maybe 2026-09-22T21:00:00Z': None,
            '': None,
        }
        for out, want in cases.items():
            with self.subTest(out=out), patch.object(
                    sup.sbx, '_docker', return_value=NS(returncode=0, stdout=out)):
                got = sup._sandbox_container_state(self.slug)
                if want is None:
                    self.assertIsNone(got)
                else:
                    self.assertEqual(got[0], want[0])
                    self.assertAlmostEqual(got[1], want[1], places=3)
        with patch.object(sup.sbx, '_docker', return_value=NS(returncode=1, stdout='')):
            self.assertIsNone(sup._sandbox_container_state(self.slug))
        with patch.object(sup.sbx, '_docker', side_effect=OSError('no docker')):
            self.assertIsNone(sup._sandbox_container_state(self.slug))

    def test_recorded_row_engine_alive_keeps_the_row(self):
        self.record_input()
        org = self.load(self.slug)
        org.d['delivering']['worker'][0][mailruntime.ENGINES] = [7777]
        self.save(org)
        with self.restart_proof(created={7777: self.MINE - 60}):
            self.fresh_state()
            self.assertEqual(self.startup(), [])
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])

    def test_pid_reused_after_this_engine_started_counts_as_gone(self):
        self.make_legacy()
        with self.restart_proof(dead=set(), created={self.PRIOR: self.MINE + 30},
                                parents={9002: self.PRIOR},
                                ) as _:
            with patch.object(sup, '_process_created',
                              side_effect=lambda pid: {os.getpid(): self.MINE,
                                                       self.PRIOR: self.MINE + 30,
                                                       9002: self.MINE + 40}.get(pid)):
                self.fresh_state()
                self.startup()
        self.assert_once()

    def test_no_restart_fold_outside_a_process_restart(self):
        self.make_legacy()
        with self.restart_proof(prior=os.getpid()):
            self.fresh_state()
            self.startup()
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])
        self.assertFalse(self.disclosures())

    def test_unreadable_process_table_keeps_the_row(self):
        self.make_legacy()
        with self.restart_proof(table=False):
            self.fresh_state()
            self.startup()
        self.assertTrue(self.load(self.slug).d['delivering']['worker'])

    def test_restart_proof_never_releases_other_custody(self):
        for field in ('claim', 'manual', 'halt', 'native', 'durable_attempt',
                      'mailbox_changed', 'malformed_stamp', 'malformed_engines'):
            with self.subTest(field=field):
                org = self.load(self.slug)
                org.d['delivering']['worker'] = [copy.deepcopy(self.original)]
                org.nodes['worker'].pop('halt_queue', None)
                org.nodes['worker'].pop('native_held_carriers', None)
                org.d.get('steer_attempts', {}).pop('worker', None)
                row = org.d['delivering']['worker'][0]
                row['input_attempt'] = 'uncertain'      # would fold on its own
                row[mailruntime.ENGINES] = [self.PRIOR]  # owners proven gone
                if field == 'claim': row['claim'] = {'delivery_id': 'claim', 'acked': False}
                if field == 'manual': row['mode'] = 'manual_fetch'
                if field == 'halt': org.nodes['worker']['halt_queue'] = [self.carrier()]
                if field == 'native': org.nodes['worker']['native_held_carriers'] = [self.carrier()]
                if field == 'durable_attempt': org.d['steer_attempts'] = {'worker': {'claim': {'toks': [self.tok], 'acked': False}}}
                if field == 'mailbox_changed': row['custody'] = dict(row['custody'], mailbox='older-box')
                if field == 'malformed_stamp': row['custody'] = 'not a stamp'
                if field == 'malformed_engines': row[mailruntime.ENGINES] = 'not a list'
                self.save(org)
                self.fresh_state()
                with self.restart_proof(), store.DOC_LOCK:
                    fresh = self.load(self.slug)
                    owners = sup._restart_owners_gone()
                    self.assertFalse(sup._reconcile_mail_journal(fresh, owners_gone=owners))

    def test_restart_preserves_unknown_input_without_replay_or_reclaim(self):
        marker = self.record_input()
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        self.assertEqual(self.startup(), [])
        fresh = self.load(self.slug)
        self.assertEqual(fresh.nodes['worker']['inflight'], marker)
        self.assertEqual(fresh.d['delivering']['worker'][0]['input_attempt'], 'actual-attempt')
        self.assertFalse(self.recover()['folded'])

    def test_late_confirmation_replays_authored_base_without_confirmed_mail(self):
        self.record_input()
        self.assertEqual(self.startup(), [])
        self.confirm()
        marker = self.assert_confirmed().nodes['worker']['inflight']
        self.assertEqual(marker['text'], 'authored [MAIL] quotation')
        self.assertEqual(marker['segments'], self.carrier()['segs'])
        dispatched = self.startup()
        self.assertEqual(len(dispatched), 1)
        carrier = dispatched[0][1]
        self.assertIn('authored [MAIL] quotation', carrier)
        self.assertNotIn('generated mail', carrier)
        self.assertEqual(self.startup(), [])

    def test_input_marker_and_row_are_one_failed_transaction(self):
        before = copy.deepcopy(self.load(self.slug).d['delivering']['worker'])
        with patch.object(self, 'save', side_effect=OSError('before commit')):
            with self.assertRaises(OSError):
                self.record_input()
        fresh = self.load(self.slug)
        self.assertNotIn('inflight', fresh.nodes['worker'])
        self.assertEqual(fresh.d['delivering']['worker'], before)

    def test_confirmation_failure_keeps_unknown_replay_marker(self):
        marker = self.record_input()
        with patch.object(store, 'save_org', side_effect=OSError('before commit')):
            self.confirm()
        self.assertEqual(self.load(self.slug).nodes['worker']['inflight'], marker)
        self.assertEqual(self.startup(), [])
        self.confirm()
        self.assertEqual(self.assert_confirmed().nodes['worker']['inflight']['text'],
                         'authored [MAIL] quotation')

    def test_unproven_composition_is_not_rewritten_even_after_confirmation(self):
        carrier = {'text': 'unproven [MAIL] prose', 'view': 'original', 'toks': [self.tok]}
        marker = self.record_input(carrier=carrier)
        self.confirm()
        self.assertEqual(self.load(self.slug).nodes['worker']['inflight'], marker)
        self.assertEqual(self.startup(), [])

    def test_positive_confirmation_after_halt_retires_only_consumed_mail(self):
        self.record_input()
        org = self.load(self.slug)
        org.nodes['worker']['halt'] = {'phase': 'halted', 'at': ledger.now()}
        org.nodes['worker']['halt_queue'] = [self.carrier(),
            {'text': 'unrelated retained command', 'cmd': True, 'toks': []}]
        self.save(org)
        self.confirm()
        fresh = self.assert_confirmed()
        self.assertEqual(fresh.nodes['worker']['halt']['phase'], 'halted')
        self.assertEqual(fresh.nodes['worker']['halt_queue'],
            [{'text': 'unrelated retained command', 'cmd': True, 'toks': []}])

    def test_auxiliary_retention_is_visible_to_reclaim(self):
        self.st['halt_aux_carriers'] = [self.carrier()]
        self.assertFalse(self.recover()['folded'])
        self.st['halt_aux_carriers'] = []
        self.recover()
        self.assert_once()

    def test_reclaim_respects_existing_node_and_org_gates(self):
        for where, key in [('node', 'halt'), ('node', 'frozen'), ('node', 'limit_locked'),
                           ('node', 'remote_controlled'), ('org', 'killswitch'),
                           ('org', 'spend_frozen'), ('org', 'storage_blocked')]:
            with self.subTest(key=key):
                org = self.load(self.slug)
                target = org.nodes['worker'] if where == 'node' else org.d
                target[key] = True
                if key == 'limit_locked':
                    org.d['fable_lock'] = {'no_reset': True}
                self.save(org)
                with patch.object(sup.sbx, 'on_disk', return_value=True):
                    self.assertFalse(self.recover()['folded'])
                org = self.load(self.slug)
                target = org.nodes['worker'] if where == 'node' else org.d
                target.pop(key)
                if key == 'limit_locked':
                    org.d.pop('fable_lock')
                self.save(org)
        with patch.object(sup, '_native_context_hold', return_value='held'):
            self.assertFalse(self.recover()['folded'])
        self.recover()
        self.assert_once()

    def test_confirmed_carrier_after_state_loss_uses_positive_durable_proof(self):
        original = self.carrier()
        self.confirm()
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        with store.DOC_LOCK:
            org = self.load(self.slug)
            with sup._state_lock:
                mailruntime.resolve_reclaims(org, self.st, nid='worker')
                ready = sup._publishable(self.st, original)
        self.assertEqual(ready['text'], 'authored [MAIL] quotation')
        self.assertEqual(ready['toks'], [])
        self.assertEqual(original, self.carrier())

    def test_reclaimed_carrier_after_state_loss_is_not_delivered_twice(self):
        original = self.carrier()
        self.recover()
        sup._state.pop((self.slug, 'worker'), None)
        self.st = sup.state(self.slug, 'worker')
        org = self.load(self.slug)
        with sup._state_lock:
            mailruntime.resolve_reclaims(org, self.st, nid='worker')
            ready = sup._publishable(self.st, original)
        self.assertEqual(ready['text'], 'authored [MAIL] quotation')
        self.assertEqual(ready['toks'], [])
        self.assertFalse(mailruntime.confirmed_tokens(org, 'worker'))
        self.assertEqual(org.d['mail']['worker'][0]['redelivered'], 1)


if __name__ == '__main__':
    unittest.main()
