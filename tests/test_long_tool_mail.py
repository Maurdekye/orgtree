"""A stalled managed tool yields without replay, losing its result, or lying about mail."""
import os
import asyncio
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='long-tool-mail-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, store, supervisor as sup, toolwait, maildrain, halt

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class LongToolTests(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        store.save_org(org)
        self.caller = dict(org.node('worker'))
        self.body = SimpleNamespace(org=self.slug, node='worker', tool='orgtree_staff', args={})
        self.release = threading.Event()
        self.calls = 0
        self.drives = patch.object(sup, 'send_message', return_value={'accepted': True})
        self.drives.start()

    def tearDown(self):
        self.release.set()
        deadline = time.monotonic() + 3
        while toolwait._live and time.monotonic() < deadline:
            toolwait.sweep()
            time.sleep(.01)
        self.drives.stop()
        maildrain._forget(self.slug, 'worker')
        store._POOL.close_all(self.slug)

    def long_staff(self):
        self.calls += 1
        self.release.wait(3)
        return {'node': 'new-worker', 'result': 'one side effect'}

    def mails(self):
        return store.load_org(self.slug).d.get('mail', {}).get('worker', [])

    def finish(self):
        self.release.set()
        deadline = time.monotonic() + 2
        while not self.mails() and time.monotonic() < deadline:
            toolwait.sweep()
            time.sleep(.01)
        self.assertEqual(len(self.mails()), 1)

    def test_stalled_staff_yields_without_cancelling_or_second_execution(self):
        out = toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.02)
        self.assertEqual(out['state'], 'running')
        self.assertEqual(self.calls, 1)
        self.assertFalse(self.release.is_set())
        self.assertFalse(self.mails())
        self.assertEqual(toolwait.records()[0]['id'], out['operation_id'])
        self.finish()
        for _ in range(3):
            toolwait.sweep()
        self.assertEqual(self.calls, 1)
        self.assertIn('new-worker', self.mails()[0]['body'])
        self.assertTrue(maildrain.pending(store.load_org(self.slug), 'worker'))

    def test_quick_result_has_no_duplicate_mail(self):
        result = toolwait.invoke(self.body, self.caller, lambda: {'ok': True}, wait_s=1)
        self.assertEqual(result, {'ok': True})
        toolwait.sweep()
        self.assertFalse(self.mails())

    def test_completion_receipt_retries_without_reexecuting(self):
        toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        original = toolwait._save
        failed = threading.Event()

        def fail_result(row):
            if row['state'] == 'completed' and not failed.is_set():
                failed.set()
                raise OSError('temporary storage error')
            return original(row)

        with patch.object(toolwait, '_save', side_effect=fail_result):
            self.release.set()
            self.assertTrue(failed.wait(1))
        self.finish()
        self.assertEqual(self.calls, 1)

    def test_restart_reports_uncertainty_and_never_restarts_call(self):
        row = {'id': 'interrupted-operation', 'org': self.slug, 'node': 'worker',
               'seat': self.caller['seat_id'], 'tool': 'orgtree_staff', 'at': 1,
               'state': 'running', 'yielded': True}
        toolwait._save(row)
        toolwait.sweep()
        toolwait.sweep()
        self.assertEqual(len(self.mails()), 1)
        self.assertIn('NOT restarted', self.mails()[0]['body'])
        self.assertEqual(self.calls, 0)

    def test_compaction_routes_result_to_successor(self):
        toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org._compact_split_apply('worker', 'new-session')
            store.save_org(org)
        self.finish()
        org = store.load_org(self.slug)
        self.assertFalse(org.d.get('mail', {}).get('worker@0'))

    def test_result_publication_is_atomic_with_dedup_receipt(self):
        toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        original = toolwait._delete
        failed = threading.Event()

        def fail_delete(oid):
            if not failed.is_set():
                failed.set()
                raise OSError('crash after mail commit')
            return original(oid)

        with patch.object(toolwait, '_delete', side_effect=fail_delete):
            self.release.set()
            self.assertTrue(failed.wait(1))
        toolwait.sweep()
        self.assertEqual(len(self.mails()), 1)
        self.assertEqual(self.calls, 1)

    def test_authenticated_http_route_uses_safe_wait(self):
        from orgtree import api
        request = SimpleNamespace(state=SimpleNamespace(agent_identity=(self.slug, 'worker', 0)))
        body = api.AgentCall(org=self.slug, node='worker', tool='orgtree_staff', args={})
        invoke = toolwait.invoke
        with patch.object(api, 'agent_call', side_effect=lambda *a: self.long_staff()), \
                patch.object(toolwait, 'invoke', side_effect=lambda *a: invoke(*a, wait_s=.01)):
            out = asyncio.run(api._agent_call_route(body, request))
        self.assertEqual(out['state'], 'running')
        self.finish()

    def test_stale_or_cross_org_identity_cannot_start_operation(self):
        from orgtree import api
        from fastapi import HTTPException
        body = api.AgentCall(org=self.slug, node='worker', tool='orgtree_staff', args={})
        for identity in [(self.slug, 'worker', 99), ('another-org', 'worker', 0)]:
            request = SimpleNamespace(state=SimpleNamespace(agent_identity=identity))
            with patch.object(api, 'agent_call') as call, self.assertRaises(HTTPException):
                asyncio.run(api._agent_call_route(body, request))
            call.assert_not_called()
        self.assertFalse(toolwait.records())

    def test_halt_preserves_result_without_rearming_delivery(self):
        toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        with patch.object(halt, 'blocked', return_value='halt'):
            self.finish()
        self.assertFalse(maildrain.pending(store.load_org(self.slug), 'worker'))
        self.assertEqual(self.calls, 1)

    def test_full_worker_capacity_refuses_before_execution(self):
        from fastapi import HTTPException
        for _ in range(toolwait.MAX_RUNNING):
            self.assertTrue(toolwait._slots.acquire(False))
        try:
            with self.assertRaises(HTTPException):
                toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
            self.assertEqual(self.calls, 0)
        finally:
            for _ in range(toolwait.MAX_RUNNING):
                toolwait._slots.release()

    def test_thread_start_failure_does_not_execute(self):
        with patch.object(threading.Thread, 'start', side_effect=RuntimeError('cannot start')):
            with self.assertRaises(RuntimeError):
                toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        self.assertFalse(toolwait.records())
        self.assertEqual(self.calls, 0)

    def test_transport_acceptance_is_never_a_read_receipt(self):
        note = sup.steer_receipt_text({'level': 'accepted'})
        self.assertIn('model-read receipt unavailable', note)
        self.assertNotIn('delivered', note)
        self.assertIn('recorded by the CLI', sup.steer_receipt_text({'level': 'recorded'}))
        self.assertNotIn('delivered', sup.delivery_note(self.slug, 'worker', {'accepted': True}))

    def test_steering_request_stage_and_bounded_fifo_pump(self):
        st = sup.state(self.slug, 'worker')
        st.update(busy=True, responding=True,
                  steer=[{'text': str(i), 'toks': [str(i)]} for i in range(70)])
        first = sup.pop_steer(self.slug, 'worker', defer_commit=True)
        self.assertEqual([c['text'] for c in first], [str(i) for i in range(32)])
        self.assertEqual(st['steer'][0]['text'], '32')
        st['steer_limbo'] = [{'carriers': first}]
        stages = sup._delivery_stages(self.slug, 'worker', [{'tok': '0'}, {'tok': '32'}])
        self.assertEqual(stages, {'0': 'requested', '32': 'steer'})

    def test_restart_publishes_completed_result_once(self):
        row = {'id': 'completed-operation', 'org': self.slug, 'node': 'worker',
               'seat': self.caller['seat_id'], 'tool': 'orgtree_staff', 'at': 1,
               'state': 'completed', 'result': {'node': 'already-created'}, 'yielded': True}
        toolwait._save(row)
        toolwait.sweep()
        toolwait.sweep()
        self.assertEqual(len(self.mails()), 1)
        self.assertIn('already-created', self.mails()[0]['body'])

    def test_stale_recovery_snapshot_cannot_resurrect_returned_call(self):
        stale = {'id': 'retired', 'state': 'running'}
        with patch.object(toolwait, 'records', side_effect=[[stale], []]), \
                patch.object(toolwait, '_save') as save:
            toolwait.sweep()
        save.assert_not_called()

    def test_failed_marker_cleanup_cannot_reinsert_completed_operation(self):
        toolwait.invoke(self.body, self.caller, self.long_staff, wait_s=.01)
        original = store.save_org
        failed = threading.Event()

        def fail_cleanup(org):
            if 'tool_result_receipts' in org.d and not org.d['tool_result_receipts'] and not failed.is_set():
                failed.set()
                raise OSError('cleanup write failed after result committed')
            return original(org)

        with patch.object(store, 'save_org', side_effect=fail_cleanup):
            self.release.set()
            self.assertTrue(failed.wait(1))
        toolwait.sweep()
        toolwait.sweep()
        self.assertEqual(len(self.mails()), 1)
        self.assertFalse(toolwait.records())
        self.assertEqual(self.calls, 1)

    def test_reused_recipient_name_cannot_inherit_private_result(self):
        row = {'id': 'orphaned-result', 'org': self.slug, 'node': 'worker',
               'seat': 'a-deleted-seat', 'tool': 'orgtree_staff', 'at': 1,
               'state': 'completed', 'result': {'private': 'old caller'}, 'yielded': True}
        toolwait._save(row)
        try:
            toolwait.sweep()
            self.assertFalse(self.mails())
            self.assertEqual(len(toolwait.records()), 1)
        finally:
            toolwait._delete(row['id'])

    def test_refusal_preserves_http_status_and_has_no_completion_mail(self):
        from fastapi import HTTPException

        def refuse():
            raise HTTPException(403, 'scope denied')
        with self.assertRaises(HTTPException) as caught:
            toolwait.invoke(self.body, self.caller, refuse, wait_s=1)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertFalse(self.mails())

    def test_abrupt_worker_exit_reports_unknown_without_reexecution(self):
        def stop():
            self.calls += 1
            self.release.wait(1)
            raise SystemExit('unexpected worker exit')
        toolwait.invoke(self.body, self.caller, stop, wait_s=.01)
        self.finish()
        self.assertEqual(self.calls, 1)
        self.assertIn('unknown', self.mails()[0]['body'])


if __name__ == '__main__':
    unittest.main()
