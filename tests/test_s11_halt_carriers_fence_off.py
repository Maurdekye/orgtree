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
