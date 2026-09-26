"""Fence-off S5 parity: P01's receipt-lookup boundary contract
(tests/test_state_receipt_lookup_boundary.py), run again with the door ON and
the transition fence OFF — so OP_EPOCH, OP_LOOKUP and the keyed calls it
asks about (orgtree_reallocate is a door tool) take the row-transaction path
S5 adds, and every pinned answer, fence row and refusal must come out the
same as on the legacy path.

Run:  python tools/run-python-verification.py tests/test_fence_s5_receipts_parity.py
"""
import os
import sys
from pathlib import Path

os.environ['ORGTREE_PGDOOR'] = '1'          # before orgtree is imported
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_state_receipt_lookup_boundary as boundary  # noqa: E402
from test_state_receipt_lookup_boundary import *  # noqa: E402,F401,F403
from orgtree import orgtx, pgdoor  # noqa: E402
import unittest  # noqa: E402

orgtx.TRANSITION_FENCE = False


class DoorIsOn(unittest.TestCase):
    def test_the_door_really_is_on_for_this_run(self):
        # without this the parity run could silently be the legacy run again
        self.assertTrue(pgdoor.enabled())
        self.assertFalse(orgtx.TRANSITION_FENCE)
        self.assertTrue(boundary.api.pgdoor.routed(boundary.RA))


if __name__ == '__main__':
    unittest.main()
