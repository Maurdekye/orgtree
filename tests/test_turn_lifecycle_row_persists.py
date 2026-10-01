"""A turn's lifecycle outcome row is STORED, and the turn-end transaction that
stores it takes only the node's row and list logs.

mem-leak-probe reproduced on v3 e7ed5d6 (item possible-lost-write-after-turn-
records-the-turn): `_after_turn` recorded the turn's `completed` /
`interrupted` row into the ADMISSION copy of the org, whose transaction had
committed before the provider ran, so the row was never saved. It is now
written inside `_after_turn`'s own transaction.

Real turn (`_run_turn` against a fake CLI that blocks, then answers) on actual
PostgreSQL with on-demand rows on (the fixture of test_turn_org_state_shared).
A control row written the ordinary way proves the read sees stored rows.

Run:  python tools/run-python-verification.py tests/test_turn_lifecycle_row_persists.py
"""
import os
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import test_turn_org_state_shared as base
from test_turn_org_state_shared import tearDownModule  # noqa: F401
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import halt, lifecycle, orgtx, supervisor as sup


def stored_rows(slug):
    with orgtx.org_tx(slug, logs=["lifecycle"]) as tx:
        return [dict(r) for r in (tx.org.d.get("lifecycle") or [])]


class TurnLifecycleRow(base.RunningTurn):

    def test_the_turns_outcome_row_is_stored_by_a_node_scoped_transaction(self):
        calls, txns = [], []
        real_record, real_txn = lifecycle.record, halt.txn

        def record_spy(doc, **kw):
            calls.append(kw)
            return real_record(doc, **kw)

        def txn_spy(slug, **kw):
            f = sys._getframe(1)
            while f is not None and f.f_code.co_filename.endswith("mock.py"):
                f = f.f_back            # past unittest.mock's own call frames
            if f is not None and f.f_code.co_name == "_after_turn":
                txns.append(kw)
            return real_txn(slug, **kw)
        control = "probe:" + uuid.uuid4().hex
        with orgtx.org_tx(self.slug, logs=["lifecycle"]) as tx:
            real_record(tx.org.d, operation_id=control, kind="probe", state="written", at="now")
        with patch.object(lifecycle, "record", side_effect=record_spy), \
                patch.object(halt, "txn", side_effect=txn_spy):
            thread = threading.Thread(target=lambda: sup._run_turn(self.slug, self.nid, "hello"),
                                      daemon=True)
            thread.start()
            deadline = time.time() + 60
            while not os.path.exists(self.flag + ".blocked"):
                self.assertTrue(thread.is_alive(), "the turn ended before the CLI blocked")
                self.assertLess(time.time(), deadline, "the fake CLI never got its prompt")
                time.sleep(0.05)
            Path(self.flag + ".release").touch()
            thread.join(60)
        self.assertFalse(thread.is_alive(), "the turn runner must settle")
        rows = stored_rows(self.slug)
        self.assertTrue(any(r.get("operation_id") == control for r in rows),
                        "the control row is not stored: this read proves nothing")
        turn = [c for c in calls if c.get("kind") == "turn"]
        self.assertEqual(len(turn), 1, f"expected one turn outcome record, got {calls}")
        op = turn[0]["operation_id"]
        stored = [r for r in rows if r.get("operation_id") == op and r.get("kind") == "turn"]
        self.assertEqual([(r.get("state"), r.get("node")) for r in stored],
                         [("completed", self.nid)],
                         f"the turn's outcome row was recorded but not stored: {rows}")
        # the turn-end transaction: this node's row, no org-wide section (the
        # org's api_cost_usd only on an on-key turn, not this one), list logs
        self.assertEqual(len(txns), 1, txns)
        spec = txns[0]
        self.assertEqual(list(spec.get("nodes") or []), [self.nid])
        self.assertEqual(list(spec.get("sections") or []), [])
        self.assertIn("lifecycle", spec.get("logs") or [])
        self.assertFalse(spec.get("share_sections") or spec.get("share_nodes") or spec.get("whole"),
                         spec)


if __name__ == "__main__":
    unittest.main()
