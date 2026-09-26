"""S11: halts keep every unconfirmed carrier with the transition fence OFF.

`halt.worker` held ONE pending-carrier slot per agent runtime and relied on
the transition fence (`halt._FENCE`, DOC_LOCK around admission) to admit one
turn worker at a time. With the fence off, turn workers admitted side by side
on one agent overwrote each other's carrier, and a halt retained only the last
one. The guard test
`test_halt_racing_send_and_manual_drive_never_overlaps_a_running_turn`
passed 4 times in 20 with the fence off when the fence was put back
(e0306b8), and 7 in 20 with this module before S11.

This module runs that guard test, unchanged, 20 times with both fences off
(`halt._FENCE` and `orgtx.TRANSITION_FENCE`). Every run must pass. Two
direct tests pin the slot's ownership: a nested turn worker (`_run_turn` →
`_run_one_turn`) shares its outer worker's slot, and a worker that ends
drops its own slot while another still runs.
"""
import threading
import unittest

import test_agent_halt as _base
from orgtree import halt, orgtx, supervisor as sup

RUNS = 20
_GUARD = _base.AgentHaltTests.test_halt_racing_send_and_manual_drive_never_overlaps_a_running_turn


def setUpModule():
    global _saved
    _saved = (halt._FENCE, orgtx.TRANSITION_FENCE)
    halt._FENCE = False
    orgtx.TRANSITION_FENCE = False


def tearDownModule():
    halt._FENCE, orgtx.TRANSITION_FENCE = _saved


class FenceOffGuard(_base.AgentHaltTests):

    def test_a_nested_turn_worker_shares_the_outer_slot(self):
        """`_run_turn` → `_run_one_turn` on one thread is ONE carrier: once
        the provider acknowledged it (`halt.consumed`, from inside the nested
        worker), nothing is left pending for a later halt to replay."""
        seen = {}

        @halt.worker
        def _run_one_turn(slug, nid, carrier):
            halt.consumed(slug, nid)

        @halt.worker
        def _run_turn(slug, nid, carrier):
            _run_one_turn(slug, nid, carrier)
            with sup._state_lock:
                seen["after"] = halt.pending_carriers(self.st)

        _run_turn(self.slug, self.nid, {"text": "one"})
        self.assertEqual(seen["after"], [])

    def _two_slots(self):
        a, b = object(), object()
        with sup._state_lock:
            self.st["halt_pending_carriers"] = {
                a: {"text": "a", "toks": ["tok-a"]},
                b: {"text": "b", "toks": ["tok-b"]}}
            self.st["halt_carrier_ids"] = {a: None, b: None}

    def _pending_texts(self):
        with sup._state_lock:
            return sorted(c["text"] for c in halt.pending_carriers(self.st))

    def _consume_on_a_fresh_thread(self, toks):
        # a plain Thread starts with an EMPTY context: no worker's slot
        t = threading.Thread(target=halt.consumed,
                             args=(self.slug, self.nid, toks))
        t.start()
        t.join(5)

    def test_an_ack_off_the_turn_thread_spends_the_carrier_it_confirmed(self):
        """p03-ws3b's review: `_confirm_delivered` may run off the worker's
        thread (mail-drain recovery, a tool hook), where the ContextVar is
        empty. With two slots it must still spend the carrier whose journal
        token it confirmed — and only that one."""
        self._two_slots()
        self._consume_on_a_fresh_thread(["tok-a"])
        self.assertEqual(self._pending_texts(), ["b"])

    def test_a_delivery_confirmed_off_the_turn_thread_spends_its_carrier(self):
        """Review B1: the PRODUCTION path — `_confirm_delivered` (what
        maildrain.recover and the tool hooks call) on a fresh thread must hand
        its tokens to `halt.consumed`, so exactly the confirmed carrier is
        spent and the other worker's is kept."""
        self._two_slots()
        t = threading.Thread(target=sup._confirm_delivered,
                             args=(self.slug, self.nid, ["tok-b"]))
        t.start()
        t.join(5)
        self.assertEqual(self._pending_texts(), ["a"])

    def test_the_confirmed_tokens_beat_the_threads_own_slot(self):
        """Review N3: on a worker thread whose own slot does NOT hold the
        confirmed tokens, the slot that does is the one spent."""
        seen = {}
        b_in, b_go = threading.Event(), threading.Event()

        @halt.worker
        def _run_turn(slug, nid, carrier):
            if carrier["text"] == "b":
                b_in.set()
                b_go.wait(5)
                return
            halt.consumed(slug, nid, ["tok-b"])
            seen["after"] = self._pending_texts()

        t = threading.Thread(target=_run_turn, args=(
            self.slug, self.nid, {"text": "b", "toks": ["tok-b"]}))
        t.start()
        self.assertTrue(b_in.wait(5))
        _run_turn(self.slug, self.nid, {"text": "a", "toks": ["tok-a"]})
        b_go.set()
        t.join(5)
        self.assertEqual(seen["after"], ["a"])

    def test_two_turns_in_a_row_on_one_thread_leave_nothing_behind(self):
        """Review N2: a worker resets its `_SLOT` entry when it ends, so the
        next turn on the SAME thread owns a fresh slot (and drops it on exit)
        instead of mistaking itself for a nested worker. With another worker
        still running, a stale entry would outlive both turns."""
        b_in, b_go = threading.Event(), threading.Event()
        seen = {}

        @halt.worker
        def _run_turn(slug, nid, carrier):
            if carrier["text"] == "b":
                b_in.set()
                b_go.wait(5)
                with sup._state_lock:
                    seen["during"] = sorted(
                        c["text"] for c in halt.pending_carriers(self.st))

        t = threading.Thread(target=_run_turn,
                             args=(self.slug, self.nid, {"text": "b"}))
        t.start()
        self.assertTrue(b_in.wait(5))
        _run_turn(self.slug, self.nid, {"text": "a1"})
        _run_turn(self.slug, self.nid, {"text": "a2"})
        b_go.set()
        t.join(5)
        self.assertEqual(seen["during"], ["b"])

    def test_an_ambiguous_ack_off_the_turn_thread_spends_nothing(self):
        self._two_slots()
        self._consume_on_a_fresh_thread([])
        self.assertEqual(self._pending_texts(), ["a", "b"])

    def test_a_finished_worker_leaves_no_carrier_behind(self):
        """A turn worker that ends while another still runs drops its own
        slot: the running one's carrier is the only one a halt would keep."""
        b_in, b_go = threading.Event(), threading.Event()
        seen = {}

        @halt.worker
        def _run_turn(slug, nid, carrier):
            if carrier["text"] == "b":
                b_in.set()
                b_go.wait(5)
                with sup._state_lock:
                    seen["during"] = sorted(
                        c["text"] for c in halt.pending_carriers(self.st))

        t = threading.Thread(target=_run_turn,
                             args=(self.slug, self.nid, {"text": "b"}))
        t.start()
        self.assertTrue(b_in.wait(5))
        _run_turn(self.slug, self.nid, {"text": "a"})   # starts and ends
        b_go.set()
        t.join(5)
        self.assertEqual(seen["during"], ["b"])


# only the guard, RUNS times; none of the base class's other tests
for _name in [n for n in dir(_base.AgentHaltTests) if n.startswith("test_")]:
    setattr(FenceOffGuard, _name, None)
for _i in range(RUNS):
    setattr(FenceOffGuard, f"test_guard_fence_off_{_i:02d}", _GUARD)


if __name__ == "__main__":
    unittest.main()
