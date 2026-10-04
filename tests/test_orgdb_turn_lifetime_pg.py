"""Real supervisor exception cleanup through durable admission and native writes."""
import import_provenance  # noqa: F401

from contextlib import ExitStack
import os
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import test_orgdb_compat_pg as fixture
from orgtree import halt, ledger, orgtx, store, supervisor as sup, turnslots
from orgtree.orgdb import turn_context, turn_requests, turn_runtime

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Lifetime(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(fixture.storage(True))
        store.claim_data_root()
        self.slug = 'lifetime-' + uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'worker')
        org.node('worker')['session_id'] = str(uuid4())
        store.save_org(org)
        self.stack.enter_context(patch.multiple(
            turnslots, _database_queue=None, _database_instance=None,
            _database_resolver=None, _host_slots=None, _host_limit=None,
            _activation_callbacks=list(turnslots._activation_callbacks)))
        self.host = turn_runtime.Host(fixture.RUNTIME, fixture.LC[0].instance_id,
                                      prefix=fixture.PREFIX)
        self.stack.enter_context(patch.object(turn_runtime, '_host', self.host))
        self.host.start(limit=1)
        self.stack.callback(self.host.stop)
        self.runs = []
        self.observed = []

    def provider(self, cancelled):
        def fail(*args, **kwargs):
            run = turn_context.current()
            if run is None:
                raise AssertionError('actual provider seam has no admitted run')
            self.runs.append(run)
            if cancelled:
                self.host.cancel(self.slug, run.request_id)
            raise RuntimeError('lifetime provider failure')
        return fail

    def observe_error(self, slug, nid, text):
        run = self.runs[0]
        with self.host.org_connection(self.host.org(slug)) as c:
            request = turn_requests.get(c, run.request_id)
        self.observed.append((turn_context.current(), request.state,
                              self.host.queue.snapshot()['held']))
        self.real_error(slug, nid, text)

    def run_failure(self, cancelled=False):
        self.real_error = sup._log_turn_error
        with patch.object(sup, '_codex_leg', self.provider(cancelled)), \
                patch.object(sup, '_log_turn_error', self.observe_error), \
                patch.object(sup, 'spawn_env', return_value={}), \
                patch.object(sup.subprocess, 'Popen', side_effect=FileNotFoundError(
                    'external provider process forbidden')):
            answer = sup._run_one_turn(self.slug, 'worker', 'lifetime request')
        self.assertEqual(len(self.runs), 1, sup.state(self.slug, 'worker').get('last_error'))
        self.assertIsNone(answer)
        self.assertIsNone(turn_context.current())
        self.assertFalse(sup.state(self.slug, 'worker')['busy'])
        return self.runs[0]

    def test_exception_bookkeeping_keeps_original_running_claim(self):
        run = self.run_failure()
        self.assertEqual(self.observed, [(run, 'running', 1)])
        saved = orgtx.org_read(self.slug)
        errors = saved.d.get('turn_error_log', {}).get('worker', [])
        self.assertEqual([row['text'] for row in errors], ['lifetime provider failure'])
        self.assertEqual(self.host.queue.get(run.request_id).state, 'done')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)

    def test_cancelled_provider_cannot_write_late_native_error(self):
        run = self.run_failure(cancelled=True)
        saved = orgtx.org_read(self.slug)
        self.assertEqual(saved.d.get('turn_error_log', {}).get('worker', []), [])
        self.assertEqual(self.observed, [(run, 'stopping', 1)])
        self.assertEqual(self.host.queue.get(run.request_id).state, 'cancelled')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)

    def request_state(self, run):
        with self.host.org_connection(self.host.org(self.slug)) as c:
            return turn_requests.get(c, run.request_id).state

    def controlled_turn(self, action):
        """Run the actual supervisor; only its external provider is replaced."""
        ready, stopped = threading.Event(), threading.Event()
        outcome, signals = [], []
        alive = [True]

        def signal():
            if alive[0]:
                run = self.runs[0]
                signals.append((self.request_state(run),
                                self.host.queue.get(run.request_id).state,
                                self.host.queue.snapshot()['held']))
                alive[0] = False
                stopped.set()
            return True

        control = SimpleNamespace(interrupt=signal, client=SimpleNamespace(
            close=signal, proc=SimpleNamespace(poll=lambda: None if alive[0] else 0)))

        def provider(*args, **kwargs):
            run = turn_context.current()
            self.assertIsNotNone(run)
            self.runs.append(run)
            st = sup.state(self.slug, 'worker')
            with sup._state_lock:
                st['responding'] = True
                st['codex_turn'] = control
            ready.set()
            try:
                self.assertTrue(stopped.wait(8), 'control never stopped provider')
                raise RuntimeError('lifetime controlled stop')
            finally:
                with sup._state_lock:
                    st['responding'] = False
                    st.pop('codex_turn', None)

        def worker():
            try:
                outcome.append(sup._run_one_turn(self.slug, 'worker', 'controlled request'))
            except BaseException as error:
                outcome.append(error)

        with patch.object(sup, '_codex_leg', provider), \
                patch.object(sup, 'spawn_env', return_value={}), \
                patch.object(sup.subprocess, 'Popen', side_effect=FileNotFoundError(
                    'external provider process forbidden')):
            thread = threading.Thread(target=worker)
            thread.start()
            try:
                self.assertTrue(ready.wait(8), 'actual provider was not reached')
                result = action()
            finally:
                stopped.set()
                thread.join(10)
            self.assertFalse(thread.is_alive(), 'actual supervisor did not settle')
        self.assertEqual(len(self.runs), 1)
        if outcome and isinstance(outcome[0], BaseException):
            raise outcome[0]
        self.assertEqual(outcome, [None])
        self.assertEqual(signals, [('stopping', 'stopping', 1)])
        run = self.runs[0]
        self.assertEqual(self.request_state(run), 'cancelled')
        self.assertEqual(self.host.queue.get(run.request_id).state, 'cancelled')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)
        self.assertFalse(sup.state(self.slug, 'worker')['busy'])
        self.assertNotIn('turn_request_id', sup.state(self.slug, 'worker'))
        self.assertEqual(orgtx.org_read(self.slug).d.get('turn_error_log', {}).get('worker', []), [])
        return result

    def test_actual_interrupt_cancels_before_provider_signal_and_cleanup(self):
        result = self.controlled_turn(lambda: sup.interrupt_turn(self.slug, 'worker'))
        self.assertTrue(result['interrupted'])

    def test_actual_halt_commits_halting_then_cancels_before_provider_close(self):
        phases = []
        real_cancel = self.host.cancel

        def cancel(slug, request_id):
            phases.append(orgtx.org_read(slug).node('worker')['halt']['phase'])
            return real_cancel(slug, request_id)

        with patch.object(self.host, 'cancel', cancel):
            result = self.controlled_turn(lambda: halt.halt(self.slug, 'worker', timeout=5))
        self.assertEqual(phases, ['halting'])
        self.assertTrue(result['settled'])
        self.assertEqual(orgtx.org_read(self.slug).node('worker')['halt']['phase'], 'halted')

    def test_actual_retire_interrupt_settles_original_request_before_archive(self):
        result = self.controlled_turn(lambda: sup.interrupt_before_archive(
            self.slug, orgtx.org_read(self.slug), 'worker', timeout=5))
        self.assertEqual(result, [])
        with orgtx.org_tx(self.slug, nodes=['worker']) as tx:
            tx.org.retire(ledger.USER, 'worker')
        self.assertEqual(orgtx.org_read(self.slug).node('worker')['state'], 'archived')

    def test_manual_compaction_releases_before_queued_successor_at_limit_one(self):
        seen = []

        def compact(slug, nid):
            run = turn_context.current()
            self.assertIsNotNone(run)
            self.runs.append(run)
            self.assertEqual(self.host.queue.snapshot()['held'], 1)
            with sup._state_lock:
                sup.state(slug, nid)['queue'].append('successor')

        def successor(slug, nid, carrier):
            old = self.runs[0]
            seen.append((carrier, turn_context.current(), self.request_state(old),
                         self.host.queue.snapshot()['held']))
            with turn_runtime.supervisor_scope(), sup._InterruptibleTurnSlot(
                    sup.state(slug, nid), slug, nid, 'turn'):
                self.runs.append(turn_context.current())
                self.assertEqual(self.host.queue.snapshot()['held'], 1)
            sup.state(slug, nid)['busy'] = False

        with patch.object(sup, '_compact_split', compact), patch.object(sup, '_run_turn', successor):
            sup.manual_compact(self.slug, 'worker')
        self.assertEqual(seen, [('successor', None, 'done', 0)])
        self.assertEqual(len(self.runs), 2)
        self.assertNotEqual(self.runs[0].request_id, self.runs[1].request_id)
        self.assertEqual([self.host.queue.get(run.request_id).state for run in self.runs], ['done', 'done'])
        self.assertIsNone(turn_context.current())
        self.assertEqual(self.host.queue.snapshot()['held'], 0)

    def test_manual_compaction_cancellation_fences_native_error_and_clears_claim(self):
        def compact(slug, nid):
            run = turn_context.current()
            self.assertIsNotNone(run)
            self.runs.append(run)
            self.host.cancel(slug, run.request_id)
            self.assertEqual(self.host.queue.snapshot()['held'], 1)
            sup._log_turn_error(slug, nid, 'cancelled compaction error')
            raise halt.Cancelled('compaction cancelled')

        with patch.object(sup, '_compact_split', compact):
            sup.manual_compact(self.slug, 'worker')
        self.assertEqual(len(self.runs), 1)
        run = self.runs[0]
        self.assertEqual(self.request_state(run), 'cancelled')
        self.assertEqual(self.host.queue.get(run.request_id).state, 'cancelled')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)
        self.assertIsNone(turn_context.current())
        self.assertFalse(sup.state(self.slug, 'worker')['busy'])
        self.assertEqual(orgtx.org_read(self.slug).d.get('turn_error_log', {}).get('worker', []), [])


if __name__ == '__main__':
    unittest.main()
