"""The completion gate: invariants that hold under EVERY candidate ruling.

`an-item-with-no-classified-acceptance-condition` asks the user to choose what
completion requires when no acceptance condition carries an evidence
classification -- block, warn-and-record, or a rule that depends on the item's
kind.  That choice is not made here.

What IS pinned here is the part no answer may change: an item that has already
been completed is never re-judged.  The guard is consulted only on a transition
INTO ``done``, so a stricter rule applies to completions made after it lands and
reaches backwards to nothing.  Without this the "already-archived items are
unaffected" constraint rests on an argument about control flow rather than on a
result, and the 473 archived items on this docket are the thing it is protecting.

These tests pass on the pre-fix tree.  That is the point: they describe a
boundary the fix must not move, so they are written before it and re-run after.
"""
from __future__ import annotations

import sys
import os
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# The ledger imports the store lazily while constructing an Org.  Give the
# development guard an independent disposable root before that import.
_DATA = tempfile.TemporaryDirectory(prefix="completion-gate-invariants-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402


class CompletionGateInvariants(unittest.TestCase):
    """A written completion is never re-judged, by either route."""

    def _item(self, name, acceptance=("the composition is verified",),
              kind="code"):
        org = ledger.Org.create(name)
        org.hire(USER, None, "haiku", 0, "owner")
        made = org.work_create(
            "owner", "Gate invariant fixture",
            "Problem: a completed item must not be re-judged by a later, "
            "stricter gate. Solution: pin the transition boundary.",
            acceptance=list(acceptance), kind=kind)
        return org, str(made["created"])

    def _complete(self, org, wid):
        return org.work_update("owner", wid, status="done",
                               done_so_far=["the work"], working_on_next=[])

    # ---- the boundary itself -------------------------------------------

    def test_a_completed_item_cannot_be_completed_again_via_accept(self):
        """`accept` refuses a closed item BEFORE it reaches the guard.

        ledger.py:16198 raises on the closed status, so the acceptance record
        already written is never re-tested against a rule that did not exist
        when it was written.
        """
        org, wid = self._item("inv-accept")
        self._complete(org, wid)
        with self.assertRaises(LedgerError) as caught:
            org.work_accept("owner", wid, None)
        self.assertIn("already done", str(caught.exception))

    def test_a_completed_item_cannot_be_completed_again_via_update(self):
        """The same boundary on the route that actually gets used."""
        org, wid = self._item("inv-update")
        self._complete(org, wid)
        with self.assertRaises(LedgerError) as caught:
            self._complete(org, wid)
        self.assertIn("done", str(caught.exception))

    def test_an_unclassified_completion_survives_untouched_once_written(self):
        """The archived shape: closed with nothing classified, and it STAYS.

        This is the 238-item shape in the archive.  Re-reading the item after
        completion must return the completion as written -- no later evaluation
        of the acceptance conditions may revoke or annotate it retroactively.
        """
        org, wid = self._item("inv-unclassified",
                              acceptance=("never classified one",
                                          "never classified two"))
        self._complete(org, wid)
        got = org.work_get("owner", wid)
        self.assertEqual(got["status"], "done")
        self.assertIsNotNone(got["accepted"])
        # no condition acquired a check as a side effect of completing
        for cond in got["acceptance"]:
            self.assertIsNone(cond["checked"])

    def test_reopening_clears_the_acceptance_record(self):
        """The one route from closed back to open is EXPLICIT, and it resets.

        Four of the 473 archived items are not in a closed status and could in
        principle be reopened.  `reopen=true` clears the acceptance record, so
        the completion that follows is new work judged under whatever rule is
        then in force -- which is correct, and is not a retroactive change to
        the record it replaced.
        """
        org, wid = self._item("inv-reopen")
        self._complete(org, wid)
        org.work_update("owner", wid, status="in_progress", reopen=True,
                        done_so_far=["prior work"],
                        working_on_next=["more work"])
        got = org.work_get("owner", wid)
        self.assertEqual(got["status"], "in_progress")
        self.assertIsNone(got["accepted"])

    # ---- the guard is reached only on the transition into done ----------

    def test_the_guard_runs_on_entry_to_done_and_not_on_later_reads(self):
        """A `get` never raises, whatever the acceptance record looks like.

        The gate is a transition check.  If it ever became a read-time check,
        every archived item would be re-evaluated on display -- which is the
        failure mode the "archived items are unaffected" constraint forbids.
        """
        org, wid = self._item("inv-read", acceptance=("unclassified",))
        self._complete(org, wid)
        for _ in range(3):
            got = org.work_get("owner", wid)
            self.assertEqual(got["status"], "done")


if __name__ == "__main__":
    unittest.main()
