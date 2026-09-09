"""Cancellable turn-slot admission keeps waiting workers from stranding busy state."""
import os
import tempfile
import threading
import time
import unittest

_ROOT = tempfile.TemporaryDirectory(prefix="v2-turn-admission-")
os.environ["ORGTREE_DATA"] = _ROOT.name

from orgtree import store, supervisor, warmpool  # noqa: E402


class TurnAdmissionInterruptTests(unittest.TestCase):
    def setUp(self):
        self.old_slots = supervisor._turn_slots
        self.state = supervisor.state("turn-admission", "worker")
        with supervisor._state_lock:
            self.state.clear()
            self.state.update({"busy": True, "waiting": False, "queue": [{"text": "queued mail"}],
                               "steer": [], "responding": False})
        self.assertTrue(os.path.abspath(store.DATA_ROOT).startswith(
            os.path.abspath(_ROOT.name)))

    def tearDown(self):
        supervisor._turn_slots = self.old_slots

    def test_cancel_before_slot_acquisition_settles_without_releasing_slot(self):
        supervisor._turn_slots = threading.Semaphore(0)
        entered = threading.Event()
        outcome = []

        def admit():
            try:
                with supervisor._InterruptibleTurnSlot(self.state):
                    entered.set()
            except supervisor._AdmissionCancelled:
                outcome.append("cancelled")

        thread = threading.Thread(target=admit)
        thread.start()
        deadline = time.monotonic() + 1
        while not self.state.get("waiting") and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.state.get("waiting"), "positive control: admission really waits")
        result = supervisor.interrupt_turn("turn-admission", "worker")
        thread.join(1)
        self.assertEqual(result["reason"], "turn waiting for a turn slot")
        self.assertEqual(outcome, ["cancelled"])
        self.assertFalse(entered.is_set())
        self.assertFalse(self.state.get("waiting"))
        self.assertEqual(supervisor._turn_slots._value, 0)

    def test_cancel_racing_slot_acquisition_releases_only_acquired_slot(self):
        class Gate:
            def __init__(self):
                self.called = threading.Event()
                self.open = threading.Event()
                self.releases = 0

            def acquire(self, timeout=None):
                self.called.set()
                self.open.wait(1)
                return True

            def release(self):
                self.releases += 1

        gate = Gate()
        supervisor._turn_slots = gate
        outcome = []

        def admit():
            try:
                with supervisor._InterruptibleTurnSlot(self.state):
                    outcome.append("entered")
            except supervisor._AdmissionCancelled:
                outcome.append("cancelled")

        thread = threading.Thread(target=admit)
        thread.start()
        self.assertTrue(gate.called.wait(1), "positive control: acquire was attempted")
        self.assertEqual(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"], True)
        gate.open.set()
        thread.join(1)
        self.assertEqual(outcome, ["cancelled"])
        self.assertEqual(gate.releases, 1)
        self.assertFalse(self.state.get("waiting"))

    def test_ordinary_admission_enters_and_returns_slot(self):
        supervisor._turn_slots = threading.Semaphore(1)
        with supervisor._InterruptibleTurnSlot(self.state):
            self.assertFalse(self.state.get("waiting"))
        self.assertEqual(supervisor._turn_slots._value, 1)

    def test_waiting_and_active_status_wording_are_distinct(self):
        waiting = {"waiting": True, "busy": True, "responding": False,
                   "proc_control": False, "queued": False, "proc": False,
                   "mcp_readiness_waiting": False, "phase": None,
                   "steer": False, "cache_keepalive": False, "tasks": False,
                   "bg_tasks": False, "proc_relaunch": False, "claimed": False}
        active = dict(waiting, waiting=False, responding=True, proc=True)
        self.assertEqual(warmpool._control_busy_reason(waiting),
                         "the agent is waiting for a turn slot")
        self.assertEqual(warmpool._control_busy_reason(active),
                         "the agent is responding")


    def test_manual_compact_cancel_clears_busy_and_hands_queue_forward(self):
        org = store.create_org("compact-admission")
        nid = "worker"
        state = supervisor.state("compact-admission", nid)
        with supervisor._state_lock:
            state["busy"] = False
            state["waiting"] = False
            state["queue"] = [{"text": "queued compact mail"}]
        supervisor._turn_slots = threading.Semaphore(0)
        forwarded = []
        original_run_turn = supervisor._run_turn
        original_split = supervisor._compact_split
        def run_forwarded(slug, node, carrier):
            self.assertTrue(state.get("busy"))
            forwarded.append((slug, node, carrier))
            state["busy"] = False
        supervisor._run_turn = run_forwarded
        supervisor._compact_split = lambda slug, node: self.fail(
            "cancelled compaction must not reach the fork")
        try:
            thread = threading.Thread(target=supervisor.manual_compact,
                                      args=("compact-admission", nid))
            thread.start()
            deadline = time.monotonic() + 1
            while not state.get("waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(state.get("waiting"),
                            "positive control: compaction really waits")
            result = supervisor.interrupt_turn("compact-admission", nid)
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertTrue(result["interrupted"])
            self.assertFalse(state.get("busy"))
            self.assertFalse(state.get("waiting"))
            self.assertEqual([row[2] for row in forwarded],
                             [{"text": "queued compact mail"}])
        finally:
            supervisor._run_turn = original_run_turn
            supervisor._compact_split = original_split
            store._POOL.close_all("compact-admission")


    def test_run_wrapper_finalizes_interrupted_record_and_clears_busy(self):
        class Recorder:
            def __init__(self):
                self.disposition = None
            def set(self, **kwargs):
                pass
            def book(self, **kwargs):
                pass
            def dispose(self, disposition):
                self.disposition = disposition
            def close(self):
                pass
        recorder = Recorder()
        old_start = supervisor.turnlog.start
        old_run_turn = supervisor._run_turn
        supervisor.turnlog.start = lambda *args, **kwargs: recorder
        supervisor._run_turn = lambda *args, **kwargs: None
        supervisor._turn_slots = threading.Semaphore(0)
        with supervisor._state_lock:
            self.state["queue"] = []
        try:
            result = []
            thread = threading.Thread(target=lambda: result.append(
                supervisor._run_one_turn("turn-admission", "worker", "hello")))
            thread.start()
            deadline = time.monotonic() + 1
            while not self.state.get("admission_waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(self.state.get("admission_waiting"),
                            "positive control: wrapper really waits for admission")
            self.assertTrue(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"])
            thread.join(1)
            self.assertFalse(thread.is_alive())
            follow = result[0]
            self.assertIsNone(follow)
            self.assertEqual(recorder.disposition, "interrupted")
            self.assertFalse(self.state.get("busy"))
            self.assertFalse(self.state.get("waiting"))
        finally:
            supervisor.turnlog.start = old_start
            supervisor._run_turn = old_run_turn


    def test_run_wrapper_returns_first_carrier_and_keeps_queue_order(self):
        class Recorder:
            def set(self, **kwargs):
                pass
            def book(self, **kwargs):
                pass
            def dispose(self, disposition):
                pass
            def close(self):
                pass
        first = {"text": "first", "toks": ["t1"]}
        second = {"text": "second", "toks": ["t2"]}
        old_start = supervisor.turnlog.start
        supervisor.turnlog.start = lambda *args, **kwargs: Recorder()
        supervisor._turn_slots = threading.Semaphore(0)
        with supervisor._state_lock:
            self.state["queue"] = [first, second]
        try:
            result = []
            thread = threading.Thread(target=lambda: result.append(
                supervisor._run_one_turn("turn-admission", "worker", "hello")))
            thread.start()
            deadline = time.monotonic() + 1
            while not self.state.get("admission_waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(self.state.get("admission_waiting"),
                            "positive control: wrapper really waits for admission")
            self.assertTrue(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"])
            thread.join(1)
            self.assertFalse(thread.is_alive())
            follow = result[0]
            self.assertEqual(follow, first)
            self.assertEqual(self.state.get("queue"), [second])
            self.assertTrue(self.state.get("busy"))
        finally:
            supervisor.turnlog.start = old_start


    def test_stale_provider_interrupt_does_not_cancel_new_admission(self):
        supervisor._turn_slots = threading.Semaphore(1)
        with supervisor._state_lock:
            self.state["interrupted"] = True
        with supervisor._InterruptibleTurnSlot(self.state):
            self.assertFalse(self.state.get("waiting"))
            self.assertTrue(self.state.get("interrupted"))
        self.assertTrue(self.state.get("interrupted"))

if __name__ == "__main__":
    unittest.main()