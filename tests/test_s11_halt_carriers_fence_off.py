"""S11: halts keep every unconfirmed carrier with the transition fence OFF.

`halt.worker` held ONE pending-carrier slot per agent runtime and relied on
the transition fence (`halt._FENCE`, DOC_LOCK around admission) to admit one
turn worker at a time. With the fence off, turn workers admitted side by side
on one agent overwrote each other's carrier, and a halt retained only the last
one: p01 measured the guard test
`test_halt_racing_send_and_manual_drive_never_overlaps_a_running_turn`
passing 4 times in 20 with the fence off (20/20 with it on).

This module runs that guard test, unchanged, 20 times with both fences off
(`halt._FENCE` and `orgtx.TRANSITION_FENCE`). Every run must pass.
"""
import unittest

import test_agent_halt as _base
from orgtree import halt, orgtx

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
    pass


# only the guard, RUNS times; none of the base class's other tests
for _name in [n for n in dir(_base.AgentHaltTests) if n.startswith("test_")]:
    setattr(FenceOffGuard, _name, None)
for _i in range(RUNS):
    setattr(FenceOffGuard, f"test_guard_fence_off_{_i:02d}", _GUARD)


if __name__ == "__main__":
    unittest.main()
