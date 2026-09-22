"""Synthetic real-store controls for atomic reclaim and ambiguous save outcomes."""
import copy
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
from orgtree import halt, ledger, maildrain, mailruntime, store, supervisor as sup, transcript_ingest

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
        before = copy.deepcopy(self.load(self.slug).d)
        result = sup.inspect_mail_ownership(self.slug, 'worker')
        self.assertEqual(result.reclaimable_tokens, {self.tok})
        self.assertEqual(self.load(self.slug).d, before)
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
        with patch.object(store, 'load_org', side_effect=load), patch.object(store, 'save_org', side_effect=lost):
            self.confirm()
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.confirm()
        self.assert_confirmed()

    def test_missing_journal_does_not_confirm_without_a_receipt(self):
        org = self.load(self.slug)
        org.d['delivering'].pop('worker')
        self.save(org)
        self.confirm()
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.assertFalse(mailruntime.confirmed_tokens(self.load(self.slug), 'worker'))

    def test_reclaim_receipt_is_not_a_confirmation_receipt(self):
        self.recover()
        self.confirm()
        self.assertEqual(self.st['mail_confirmed'], {self.tok})
        self.assertFalse(mailruntime.confirmed_tokens(self.load(self.slug), 'worker'))

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
