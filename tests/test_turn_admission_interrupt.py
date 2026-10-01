"""Cancellable turn-slot admission keeps waiting workers from stranding busy state."""
import os
import tempfile
import threading
import time
import unittest

_ROOT = tempfile.TemporaryDirectory(prefix="v2-turn-admission-")
os.environ["ORGTREE_DATA"] = _ROOT.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, supervisor, warmpool  # noqa: E402

#: How long a positive control waits for the worker to reach the slot wait,
#: and how long a join waits for it to settle. The polls exit as soon as the
#: condition holds, so this costs nothing when the machine is fast. It was
#: 1 s, which flaked under load (2026-09-25, v3 4389f17: 1-2 of 8 red on
#: every sha tried, 8/8 at 10 s) — the worker's pre-slot path can take over
#: a second when the machine is running other suites.
WAIT_S = 10


class TurnAdmissionInterruptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A real org with a real agent: a worker thread that outlives its
        # test (see tearDown) then fails quietly on its own terms instead of
        # dying on "no such org" in the middle of the next test.
        org = store.create_org("turn-admission")
        org.hire(ledger.USER, None, "haiku", 0, "worker")
        store.save_org(org)

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all("turn-admission")

    def setUp(self):
        self.old_slots = supervisor._turn_slots
        self._threads = []
        self.state = supervisor.state("turn-admission", "worker")
        with supervisor._state_lock:
            self.state.clear()
            self.state.update({"busy": True, "waiting": False, "queue": [{"text": "queued mail"}],
                               "steer": [], "responding": False})
        self.assertTrue(os.path.abspath(store.DATA_ROOT).startswith(
            os.path.abspath(_ROOT.name)))

    def _start(self, thread):
        """Start `thread` and remember it, so tearDown can settle it."""
        self._threads.append(thread)
        thread.start()
        return thread

    def tearDown(self):
        # Settle every worker this test started BEFORE the real semaphore is
        # restored: a waiter still polling `_turn_slots` would otherwise take a
        # REAL slot the moment it is swapped back, run a turn nobody asked
        # for, and fail inside whatever test runs next.
        for thread in self._threads:
            if thread.is_alive():
                supervisor.interrupt_turn("turn-admission", "worker")
                thread.join(WAIT_S)
        leaked = [t for t in self._threads if t.is_alive()]
        supervisor._turn_slots = self.old_slots
        self.assertEqual(leaked, [], "a worker thread outlived its test")

    def test_cancel_before_slot_acquisition_settles_without_releasing_slot(self):
        supervisor._turn_slots = supervisor.turnslots.FairSlots(0)
        entered = threading.Event()
        outcome = []

        def admit():
            try:
                with supervisor._InterruptibleTurnSlot(self.state):
                    entered.set()
            except supervisor._AdmissionCancelled:
                outcome.append("cancelled")

        thread = self._start(threading.Thread(target=admit))
        deadline = time.monotonic() + WAIT_S
        while not self.state.get("waiting") and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.state.get("waiting"), "positive control: admission really waits")
        result = supervisor.interrupt_turn("turn-admission", "worker")
        thread.join(WAIT_S)
        self.assertEqual(result["reason"], "turn waiting for a turn slot")
        self.assertEqual(outcome, ["cancelled"])
        self.assertFalse(entered.is_set())
        self.assertFalse(self.state.get("waiting"))
        snap = supervisor._turn_slots.snapshot()
        self.assertEqual((snap["held"], snap["waiting"]), (0, 0),
                         "a cancelled waiter neither holds a slot nor stays queued")

    def test_cancel_racing_slot_acquisition_releases_only_acquired_slot(self):
        class Gate:
            """A slot scheduler that grants only when the test opens it —
            AFTER the interrupt has landed — so the grant and the cancel race
            exactly as they can in production."""
            limit = 1

            def __init__(self):
                self.called = threading.Event()
                self.open = threading.Event()
                self.releases = 0

            def acquire(self, org, cancelled=lambda: False, on_queued=None, max_wait=5.0):
                self.called.set()
                self.open.wait(WAIT_S)

            def release(self):
                self.releases += 1

            def wake(self):
                pass

        gate = Gate()
        supervisor._turn_slots = gate
        outcome = []

        def admit():
            try:
                with supervisor._InterruptibleTurnSlot(self.state):
                    outcome.append("entered")
            except supervisor._AdmissionCancelled:
                outcome.append("cancelled")

        thread = self._start(threading.Thread(target=admit))
        self.assertTrue(gate.called.wait(WAIT_S), "positive control: acquire was attempted")
        self.assertEqual(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"], True)
        gate.open.set()
        thread.join(WAIT_S)
        self.assertEqual(outcome, ["cancelled"])
        self.assertEqual(gate.releases, 1)
        self.assertFalse(self.state.get("waiting"))

    def test_ordinary_admission_enters_and_returns_slot(self):
        supervisor._turn_slots = supervisor.turnslots.FairSlots(1)
        with supervisor._InterruptibleTurnSlot(self.state):
            self.assertFalse(self.state.get("waiting"))
        self.assertEqual(supervisor._turn_slots.snapshot()["held"], 0)

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
        supervisor._turn_slots = supervisor.turnslots.FairSlots(0)
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
            deadline = time.monotonic() + WAIT_S
            while not state.get("waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(state.get("waiting"),
                            "positive control: compaction really waits")
            result = supervisor.interrupt_turn("compact-admission", nid)
            thread.join(WAIT_S)
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
            def error(self, exc):
                pass
            def close(self):
                pass
        recorder = Recorder()
        old_start = supervisor.turnlog.start
        old_run_turn = supervisor._run_turn
        supervisor.turnlog.start = lambda *args, **kwargs: recorder
        supervisor._run_turn = lambda *args, **kwargs: None
        supervisor._turn_slots = supervisor.turnslots.FairSlots(0)
        with supervisor._state_lock:
            self.state["queue"] = []
        try:
            result = []
            thread = self._start(threading.Thread(target=lambda: result.append(
                supervisor._run_one_turn("turn-admission", "worker", "hello"))))
            deadline = time.monotonic() + WAIT_S
            while not self.state.get("admission_waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(self.state.get("admission_waiting"),
                            "positive control: wrapper really waits for admission")
            self.assertTrue(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"])
            thread.join(WAIT_S)
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
            def error(self, exc):
                pass
            def close(self):
                pass
        first = {"text": "first", "toks": ["t1"]}
        second = {"text": "second", "toks": ["t2"]}
        old_start = supervisor.turnlog.start
        supervisor.turnlog.start = lambda *args, **kwargs: Recorder()
        supervisor._turn_slots = supervisor.turnslots.FairSlots(0)
        with supervisor._state_lock:
            self.state["queue"] = [first, second]
        try:
            result = []
            thread = self._start(threading.Thread(target=lambda: result.append(
                supervisor._run_one_turn("turn-admission", "worker", "hello"))))
            deadline = time.monotonic() + WAIT_S
            while not self.state.get("admission_waiting") and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(self.state.get("admission_waiting"),
                            "positive control: wrapper really waits for admission")
            self.assertTrue(supervisor.interrupt_turn("turn-admission", "worker")["interrupted"])
            thread.join(WAIT_S)
            self.assertFalse(thread.is_alive())
            follow = result[0]
            self.assertEqual(follow, first)
            self.assertEqual(self.state.get("queue"), [second])
            self.assertTrue(self.state.get("busy"))
        finally:
            supervisor.turnlog.start = old_start


    def test_stale_provider_interrupt_does_not_cancel_new_admission(self):
        supervisor._turn_slots = supervisor.turnslots.FairSlots(1)
        with supervisor._state_lock:
            self.state["interrupted"] = True
        with supervisor._InterruptibleTurnSlot(self.state):
            self.assertFalse(self.state.get("waiting"))
            self.assertTrue(self.state.get("interrupted"))
        self.assertTrue(self.state.get("interrupted"))

if __name__ == "__main__":
    unittest.main()