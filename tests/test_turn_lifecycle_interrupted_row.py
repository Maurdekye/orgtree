"""The INTERRUPTED outcome row is stored too (review-astra's finding f1 on item
possible-lost-write-after-turn-records-the-turn, candidate 08d9d4a).
Same real-turn fixture as test_turn_lifecycle_row_persists."""
import os
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import test_turn_org_state_shared as base
from test_turn_org_state_shared import tearDownModule  # noqa: F401
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import lifecycle, orgtx, supervisor as sup


def stored_rows(slug):
    with orgtx.org_tx(slug, logs=["lifecycle"]) as tx:
        return [dict(r) for r in (tx.org.d.get("lifecycle") or [])]


class InterruptedRow(base.RunningTurn):

    def _turn(self, mid=None, forced=None):
        calls = []
        real = lifecycle.record

        def spy(doc, **kw):
            calls.append(kw)
            return real(doc, **kw)
        control = "probe:" + uuid.uuid4().hex
        with orgtx.org_tx(self.slug, logs=["lifecycle"]) as tx:
            real(tx.org.d, operation_id=control, kind="probe", state="written", at="now")
        ctx = [patch.object(lifecycle, "record", side_effect=spy)]
        if forced is not None:
            ctx.append(patch.object(sup, "_turn_observed_success", return_value=forced))
        for c in ctx:
            c.start()
        try:
            th = threading.Thread(target=lambda: sup._run_turn(self.slug, self.nid, "hello"),
                                  daemon=True)
            th.start()
            deadline = time.time() + 60
            while not os.path.exists(self.flag + ".blocked"):
                self.assertTrue(th.is_alive())
                self.assertLess(time.time(), deadline)
                time.sleep(0.05)
            if mid:
                mid()
            Path(self.flag + ".release").touch()
            th.join(60)
        finally:
            for c in reversed(ctx):
                c.stop()
        self.assertFalse(th.is_alive())
        rows = stored_rows(self.slug)
        self.assertTrue(any(r.get("operation_id") == control for r in rows), "control not stored")
        turn = [c for c in calls if c.get("kind") == "turn"]
        self.assertEqual(len(turn), 1, calls)
        op = turn[0]["operation_id"]
        return turn[0], [r for r in rows if r.get("operation_id") == op and r.get("kind") == "turn"]

    def test_forced_interrupted_outcome_is_stored(self):
        rec, stored = self._turn(forced=False)
        self.assertEqual(rec["state"], "interrupted")
        self.assertEqual([(r.get("state"), r.get("settlement"), r.get("node")) for r in stored],
                         [("interrupted", "foreground-stopped", self.nid)])


if __name__ == "__main__":
    unittest.main()
