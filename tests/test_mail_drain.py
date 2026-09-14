"""Queued mail must progress without a second send, including failed cleanup."""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='mail-drain-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store, ledger, supervisor as sup, maildrain, halt

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class MailDrainTests(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        store.save_org(org)
        self.st = sup.state(self.slug, 'worker')
        self.patches = [
            patch.object(sup, '_native_context_hold', return_value=None),
            patch.object(sup, '_cancel_working_cache'),
            patch.object(sup, '_note_working_activity'),
            patch.object(sup, '_hold_for_deploy', return_value=True),
            patch.object(sup, 'scan_steer_records'),
            patch.object(sup, '_phantom_log'),
        ]
        for p in self.patches:
            p.start()
        self.delivered = []
        self.patches.append(patch.object(store, 'list_orgs',
                                         return_value=[{'slug': self.slug}]))
        self.patches[-1].start()

    def tearDown(self):
        maildrain._forget(self.slug, 'worker')
        for p in reversed(self.patches):
            p.stop()
        store._POOL.close_all(self.slug)

    def post(self, text, kind='message'):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            m = org.post_mail(ledger.USER, 'worker', text, kind=kind)
            store.save_org(org)
            return m

    def send(self, text='one', **kw):
        self.post(text, kind='notice' if not kw.get('wake', True) else 'message')
        return sup.send_message(self.slug, 'worker', 'mail pointer',
                                mail_ping=True, **kw)

    def consume(self, slug, nid, carrier, **kw):
        toks = list(carrier.get('toks') or []) if isinstance(carrier, dict) else []
        text = carrier.get('text', '') if isinstance(carrier, dict) else carrier
        ids = carrier.get('mail_ids') if isinstance(carrier, dict) else None
        text, tok, _ = sup._envelope(slug, nid, text, owned_toks=toks, mail_ids=ids)
        if tok:
            toks.append(tok)
        with store.DOC_LOCK:
            org = store.load_org(slug)
            for b in (org.d.get('delivering') or {}).get(nid, []):
                if b['tok'] in toks:
                    self.delivered.extend(m['body'] for m in b['mail'])
        sup._confirm_delivered(slug, nid, toks)
        with sup._state_lock:
            sup._fold_steer(self.st)
            if self.st['queue']:
                return self.st['queue'].pop(0)
            self.st['busy'] = False
        return None

    def recover_inline(self):
        with patch.object(sup, '_start_turn_worker', side_effect=sup._run_turn), \
             patch.object(sup, '_run_one_turn', side_effect=self.consume):
            return maildrain.recover(self.slug, 'worker')

    def test_tool_call_mail_arrives_without_a_nudge_after_finalizer_failure(self):
        # The real run wrapper owns a blocked provider seam. A send takes the
        # ordinary mid-turn ingress while that tool call is in progress.
        inside = threading.Event()
        release = threading.Event()
        failure = []
        stop = threading.Event()

        def first_turn(*args, **kw):
            self.st['responding'] = True
            inside.set()
            self.assertTrue(release.wait(3))
            raise RuntimeError('turn finalizer failed')

        def worker():
            try:
                sup._run_turn(self.slug, 'worker', 'existing work')
            except RuntimeError as exc:
                failure.append(str(exc))

        with patch.object(sup, '_run_one_turn', side_effect=first_turn):
            self.st['busy'] = True
            owner = threading.Thread(target=worker)
            owner.start()
            self.assertTrue(inside.wait(3))
            self.assertTrue(self.send('only message')['steering'])
            release.set()
            owner.join(3)
        self.assertFalse(owner.is_alive())
        self.assertEqual(failure, ['turn finalizer failed'])
        # Actual consumer loop, with no second send and no UI read.
        with patch.object(sup, '_run_one_turn', side_effect=self.consume):
            pump = threading.Thread(target=maildrain.run, args=(stop,))
            pump.start()
            try:
                deadline = time.monotonic() + 3
                while (not self.delivered or self.st['busy']
                       or halt._workers.get((self.slug, 'worker'))) \
                        and time.monotonic() < deadline:
                    time.sleep(.01)
            finally:
                stop.set()
                maildrain.wake()
                pump.join(3)
        self.assertEqual(self.delivered, ['only message'])
        self.assertFalse(self.st['busy'])
        self.recover_inline()
        self.assertEqual(self.delivered, ['only message'])

    def test_mail_immediately_before_completion_is_not_stranded(self):
        self.st.update(busy=True, responding=False)
        self.send('last instant')
        self.st['busy'] = False  # old owner finished; no inflight marker
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['last instant'])

    def test_actual_turn_finalizer_exception_recovers_its_popped_followup(self):
        self.st.update(busy=True, responding=True)
        self.send('popped during finalization')
        def notification(slug, nid, event, *args, **kw):
            if event == 'turn_done':
                raise RuntimeError('notification failed after queue pop')
        # Run the real _run_one_turn and its finally, canceling admission so
        # no provider is launched. The failure is after finally pops `follow`.
        with patch.object(sup, '_InterruptibleTurnSlot',
                          side_effect=sup._AdmissionCancelled()), \
             patch.object(sup, 'notify', side_effect=notification):
            with self.assertRaisesRegex(RuntimeError, 'after queue pop'):
                sup._run_turn(self.slug, 'worker', 'existing turn')
        self.assertEqual(self.st['queue'], [])
        self.assertFalse(self.st['busy'])
        self.assertTrue(store.load_org(self.slug).d['delivering']['worker'])
        with patch.object(maildrain.time, 'time', return_value=time.time() + 40):
            self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['popped during finalization'])

    def test_recovery_does_not_steal_from_a_live_tool_call(self):
        self.st.update(busy=True, responding=True)
        self.send()
        self.assertFalse(self.recover_inline())
        self.assertEqual(self.delivered, [])
        self.assertEqual(len(self.st['steer']), 1)

    def test_restart_retains_wake_after_inflight_was_removed(self):
        self.st['busy'] = True
        self.send('survives restart')
        store._POOL.close_all(self.slug)
        sup._state.pop((self.slug, 'worker'))
        self.st = sup.state(self.slug, 'worker')
        driven = []
        with patch.object(sup, '_transcript_evidence', return_value=set()), \
             patch.object(sup, '_reconcile_steer_records'), \
             patch.object(sup, 'send_message', side_effect=lambda *a, **kw:
                          driven.append((a, kw)) or {'accepted': True}):
            sup.reconcile(self.slug, active_only=True)
        self.assertEqual(len(driven), 1)
        self.assertTrue(driven[0][1]['mail_ping'])
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['survives restart'])

    def test_restart_recovers_journal_with_no_runtime_carrier(self):
        self.st.update(busy=True, responding=True)
        self.send('journal survives')
        store._POOL.close_all(self.slug)
        sup._state.pop((self.slug, 'worker'))
        self.st = sup.state(self.slug, 'worker')
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['journal survives'])

    def test_restart_does_not_replay_a_confirmed_batch(self):
        self.st.update(busy=True, responding=True)
        self.send('confirmed before restart')
        sup._confirm_delivered(self.slug, 'worker', self.st['steer'][0]['toks'])
        store._POOL.close_all(self.slug)
        sup._state.pop((self.slug, 'worker'))
        self.st = sup.state(self.slug, 'worker')
        self.assertFalse(self.recover_inline())
        self.assertEqual(self.delivered, [])

    def test_foldback_storage_failure_keeps_work_for_the_next_attempt(self):
        self.st.update(busy=True, responding=True)
        self.send('remaining after storage failure')
        self.st.update(busy=False, responding=False)
        with patch.object(store, 'save_org', side_effect=OSError('disk busy')):
            self.assertFalse(self.recover_inline())
        store._POOL.close_all(self.slug)
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['remaining after storage failure'])

    def test_self_contained_journal_carrier_keeps_its_replay_context(self):
        self.st.update(busy=True, responding=True)
        self.post('mail beside replay')
        sup.send_message(self.slug, 'worker', 'continue this retained task', mail_ping=False)
        self.st.update(busy=False, responding=False)
        carriers = []
        def consume(slug, nid, carrier, **kw):
            carriers.append(carrier)
            return self.consume(slug, nid, carrier, **kw)
        with patch.object(sup, '_start_turn_worker', side_effect=sup._run_turn), \
             patch.object(sup, '_run_one_turn', side_effect=consume):
            self.assertTrue(maildrain.recover(self.slug, 'worker'))
        self.assertIn('continue this retained task', carriers[0]['text'])
        self.assertEqual(self.delivered, ['mail beside replay'])

    def test_passive_notice_does_not_start_after_restart_or_boundary(self):
        self.send('passive', wake=False)
        self.assertFalse(maildrain.pending(store.load_org(self.slug), 'worker'))
        self.assertFalse(self.recover_inline())

    def test_compaction_keeps_pending_mail_on_successor(self):
        self.st['busy'] = True
        self.send('successor work')
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            pred = org.compact_split('worker', 'successor-session')
            store.save_org(org)
            self.assertTrue(maildrain.pending(org, 'worker'))
            self.assertNotIn('mail_drain', org.node(pred))
        self.st['busy'] = False
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['successor work'])
        self.assertEqual(store.load_org(self.slug).node(pred)['state'], 'archived')

    def test_manual_compact_interruption_hands_pending_mail_forward(self):
        def interrupted(*a):
            self.send('during compact')
            raise sup._AdmissionCancelled()
        with patch.object(sup, '_compact_split', side_effect=interrupted), \
             patch.object(sup, '_run_one_turn', side_effect=self.consume), \
             patch.object(sup, 'notify'):
            sup.manual_compact(self.slug, 'worker')
        self.assertEqual(self.delivered, ['during compact'])

    def test_cheap_compaction_preserves_the_successors_drain(self):
        self.st['busy'] = True
        self.send('cheap compact work')
        org = store.load_org(self.slug)
        result = org.cheap_compact(ledger.USER, 'worker')
        store.save_org(org)
        self.assertTrue(maildrain.pending(org, 'worker'))
        self.assertTrue(all('mail_drain' not in n for k, n in org.nodes.items()
                            if k != 'worker'))
        self.st['busy'] = False
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['cheap compact work'])

    def test_order_and_no_duplicates_after_partial_receipt(self):
        self.st.update(busy=True, responding=True)
        self.send('first')
        first = self.st['steer'][0]
        self.send('second')
        sup._confirm_delivered(self.slug, 'worker', first['toks'])
        self.st.update(busy=False, responding=False)
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['second'])
        self.assertFalse(self.recover_inline())

    def test_owned_batch_precedes_newer_mail_in_the_box(self):
        self.st.update(busy=True, responding=True)
        self.send('older')
        older = self.st['steer'].pop(0)
        self.st['responding'] = False
        self.send('newer')
        text, tok, _ = sup._envelope(self.slug, 'worker', older['text'],
                                    owned_toks=older['toks'])
        self.assertIsNone(tok)
        self.assertNotIn('newer', text)
        self.consume(self.slug, 'worker', older)
        self.st['busy'] = False
        self.recover_inline()
        self.assertEqual(self.delivered, ['older', 'newer'])

    def test_receipt_write_failure_retries_save_without_replaying(self):
        self.st.update(busy=True, responding=True)
        self.send('already consumed')
        toks = self.st['steer'][0]['toks']
        with patch.object(store, 'save_org', side_effect=OSError('disk busy')):
            sup._confirm_delivered(self.slug, 'worker', toks)
        self.assertEqual(self.st['mail_confirmed'], set(toks))
        store._POOL.close_all(self.slug)
        self.st.update(busy=False, responding=False)
        self.assertFalse(self.recover_inline())
        self.assertEqual(self.delivered, [])
        self.assertFalse(self.st['mail_confirmed'])

    def test_failed_admission_retains_intent_and_retries_later(self):
        self.st['busy'] = True
        self.send('retry')
        self.st['busy'] = False
        with patch.object(threading.Thread, 'start', side_effect=RuntimeError('no thread')):
            with self.assertRaises(RuntimeError):
                maildrain.recover(self.slug, 'worker')
        self.assertFalse(self.st['busy'])
        self.assertFalse(self.recover_inline())  # bounded retry deadline
        with patch.object(maildrain.time, 'time', return_value=time.time() + 40):
            self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['retry'])

    def test_gate_holds_leave_mail_unread(self):
        self.st['busy'] = True
        self.send('held')
        self.st['busy'] = False
        for key, value in [('frozen', {'kind': 'limit'}),
                           ('remote_controlled', True), ('halt', {'phase': 'halted'})]:
            with self.subTest(key=key):
                org = store.load_org(self.slug)
                org.node('worker')[key] = value
                store.save_org(org)
                self.assertFalse(self.recover_inline())
                org = store.load_org(self.slug)
                org.node('worker').pop(key)
                store.save_org(org)
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['held'])

    def test_nested_queue_drains_only_a_fixed_batch_per_worker(self):
        seen = []
        handed = []
        def nested(slug, nid, c, **kw):
            seen.append(c)
            return len(seen)
        self.st['busy'] = True
        with patch.object(sup, '_run_one_turn', side_effect=nested), \
             patch.object(sup, '_start_turn_worker', side_effect=lambda s, n, c:
                          handed.append(c)):
            sup._run_turn(self.slug, 'worker', 0)
        self.assertEqual(len(seen), maildrain.MAX_BATCH)
        self.assertEqual(handed, [maildrain.MAX_BATCH])

    def test_cleanup_cannot_clear_the_next_workers_reservation(self):
        next_owner = object()
        @maildrain.worker
        def current(slug, nid):
            self.st['mail_drain_owner'] = next_owner
            self.st['busy'] = True
        current(self.slug, 'worker')
        self.assertTrue(self.st['busy'])
        self.assertIs(self.st['mail_drain_owner'], next_owner)

    def test_obsolete_pointer_does_not_overtake_an_older_journal(self):
        self.st.update(busy=True, responding=False)
        self.send('first')  # raw pointer queues while between responses
        self.st['responding'] = True
        self.send('second')  # steer now owns both first and second
        with sup._state_lock:
            self.st['responding'] = False
            sup._fold_steer(self.st)
        self.send('third')
        with sup._state_lock:
            first_pointer = self.st['queue'].pop(0)
        with patch.object(sup, '_run_one_turn', side_effect=self.consume):
            sup._run_turn(self.slug, 'worker', first_pointer)
        self.assertEqual(self.delivered, ['first', 'second', 'third'])

    def test_failed_turn_does_not_retire_a_newer_queued_send(self):
        self.st.update(busy=True, responding=True)
        self.send('failed attempt')
        first = self.st['steer'].pop(0)
        self.st['mail_attempt_tokens'] = first['toks']
        self.send('new work')
        sup._bump_hard_fail(self.slug, 'worker')
        org = store.load_org(self.slug)
        remaining = org.node('worker')['mail_drain']['ids']
        batches = org.d['delivering']['worker']
        failed_id = batches[0]['mail'][0]['id']
        self.assertNotIn(failed_id, remaining)
        self.assertEqual(len(remaining), 1)

    def test_halt_release_does_not_rearm_an_old_drain(self):
        self.st['busy'] = True
        self.send('held until a new event')
        self.st['busy'] = False
        halt.halt(self.slug, 'worker')
        halt.unhalt(self.slug, 'worker')
        self.assertFalse(self.recover_inline())
        with patch.object(sup, '_start_turn_worker'):
            self.send('new wake')
        self.assertTrue(maildrain.pending(store.load_org(self.slug), 'worker'))

    def test_killswitch_release_does_not_rearm_an_old_drain(self):
        self.st['busy'] = True
        self.send('held')
        self.st['busy'] = False
        with patch.object(sup, 'interrupt_all', return_value={'interrupted': []}):
            halt.killswitch_latch(self.slug)
        halt.killswitch_release(self.slug)
        self.assertFalse(self.recover_inline())

    def test_rejected_idle_checkup_does_not_create_a_drain(self):
        self.st['busy'] = True
        self.post('existing boxed mail')
        result = sup.send_message(self.slug, 'worker', 'checkup',
                                  idle_only=True, mail_ping=True)
        self.assertFalse(result['accepted'])
        self.assertFalse(maildrain.pending(store.load_org(self.slug), 'worker'))

    def test_recovery_visits_bounded_round_robin_batches(self):
        saved = dict(maildrain._pending)
        try:
            maildrain._pending.clear()
            for i in range(maildrain.MAX_BATCH + 5):
                maildrain._track('round-robin', str(i))
            visits = []
            with patch.object(maildrain, 'recover', side_effect=lambda s, n:
                              visits.append(n)):
                maildrain.sweep()
                self.assertEqual(len(visits), maildrain.MAX_BATCH)
                maildrain.sweep()
            self.assertEqual(set(visits), {str(i) for i in range(maildrain.MAX_BATCH + 5)})
        finally:
            maildrain._pending.clear()
            maildrain._pending.update(saved)

    def test_startup_discovery_rebuilds_the_pending_index(self):
        self.st['busy'] = True
        self.send('discover')
        maildrain._forget(self.slug, 'worker')
        maildrain.discover()
        self.assertIn((self.slug, 'worker'), maildrain._pending)

    def test_upgrade_adopts_legacy_queued_mail_without_a_new_send(self):
        self.post('queued before upgrade')
        maildrain.discover()
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['queued before upgrade'])

    def test_upgrade_does_not_retry_legacy_terminal_failure(self):
        self.post('terminal attempt')
        org = store.load_org(self.slug)
        org.node('worker')['hard_fail_run'] = 1
        store.save_org(org)
        maildrain.discover()
        self.assertFalse(self.recover_inline())

    def test_upgrade_preserves_halt_even_after_release_and_restart(self):
        self.post('old halted mail')
        halt.halt(self.slug, 'worker')
        maildrain.discover()
        halt.unhalt(self.slug, 'worker')
        maildrain.discover()
        self.assertFalse(self.recover_inline())

    # ---------------------------------------------------------- native holds
    # User report 2026-09-14: "the coordinator isn't receiving new messages
    # despite not being in a turn". Two independent holds had closed both
    # doors at once — the send path AND this consumer — and neither said so.

    def real_hold(self):
        """Run the real native-hold predicate, not setUp's stub."""
        stub = self.patches[0]
        stub.stop()
        self.addCleanup(stub.start)

    def imported_codex(self, *, thread, recorded):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            n = org.node('worker')
            n['model'] = 'luna'
            n.pop('session_unrun', None)
            n['codex_thread'] = thread
            n['session_id'] = thread
            n['desktop_import'] = {'native_continuity': {
                'status': 'transitioned', 'provider': 'codex',
                'session_id': recorded, 'generation': n.get('generation', 0)}}
            store.save_org(org)
        return store.load_org(self.slug)

    def test_harvested_codex_thread_does_not_hold_mail_after_a_transition(self):
        # The real failure: an account switch started a fresh provider thread,
        # the seat adopted it (session_id IS the threadId for codex), and the
        # id recorded at the transition — a placeholder minted moments before
        # it — no longer matched. Nine messages sat undelivered.
        self.real_hold()
        org = self.imported_codex(thread='01a0a049-2aeb-77c2-bf8c-375e465466',
                                  recorded='1a350a78-b52e-4057-9d7c-0c8261061')
        self.assertIsNone(sup._native_context_hold(org, 'worker'))
        self.post('after the account switch')
        maildrain.discover()
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['after the account switch'])

    def test_an_arbitrary_session_edit_still_holds_and_says_why(self):
        # The other half: the seat's session is NOT its provider handle, so
        # this is an unsanctioned identity change and still refuses — but now
        # the refusal is written down where somebody diagnosing a silent
        # mailbox will find it, instead of nowhere at all.
        self.real_hold()
        org = self.imported_codex(thread='01a0a049-2aeb-77c2-bf8c-375e465466',
                                  recorded='1a350a78-b52e-4057-9d7c-0c8261061')
        with store.DOC_LOCK:
            org.node('worker')['session_id'] = 'hand-edited-elsewhere'
            store.save_org(org)
        self.post('never delivered')
        maildrain.discover()
        self.assertFalse(self.recover_inline())
        self.assertEqual(self.delivered, [])
        held = store.load_org(self.slug).node('worker')['mail_drain']
        self.assertIn('identity changed', held['held_reason'])
        self.assertTrue(held['held_since'])
        # …and it clears itself the moment the seat can be reached again.
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node('worker')['session_id'] = org.node('worker')['codex_thread']
            store.save_org(org)
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['never delivered'])
        self.assertNotIn('held_reason',
                         store.load_org(self.slug).node('worker').get('mail_drain') or {})

    def test_unsettled_import_recovery_never_blocks_ordinary_mail(self):
        # Import recovery owns ONE retained intent, which this consumer never
        # replays. Gating new mail on it switched the drain off for good on an
        # org whose recovery could not settle (archived imported agents).
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.d['desktop_import'] = {
                'active_nodes': ['worker'], 'recovery_pending': True,
                'recovery_attempts': {'worker': {'node': 'worker',
                                                 'phase': 'not-dispatched'}}}
            store.save_org(org)
        self.assertTrue(sup._import_recovery_unsettled(
            store.load_org(self.slug), 'worker'))
        self.post('ordinary mail during recovery')
        maildrain.discover()
        self.assertTrue(self.recover_inline())
        self.assertEqual(self.delivered, ['ordinary mail during recovery'])

    def test_an_archived_seat_cannot_keep_import_recovery_pending(self):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.d['desktop_import'] = {
                'active_nodes': ['worker'], 'recovery_pending': True,
                'recovery_attempts': {'worker': {'node': 'worker',
                                                 'phase': 'uncertain'}}}
            org.node('worker')['state'] = 'archived'
            store.save_org(org)
        self.assertFalse(sup._import_recovery_unsettled(
            store.load_org(self.slug), 'worker'))


if __name__ == '__main__':
    unittest.main()
