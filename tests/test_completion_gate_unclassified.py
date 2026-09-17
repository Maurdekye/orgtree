"""W11: completing with nothing classified is RECORDED, not refused.

User ruling, 2026-09-17, on `an-item-with-no-classified-acceptance-condition`:
an item whose acceptance conditions were never classified completes, and the
acceptance record says plainly how much of it closed without classified
evidence.  Blocking was offered and declined -- the cheapest way past a block
is a fake `met`, which writes a false record where an honest gap now goes.

Two further halves of the same ruling are pinned here because they are the
parts most likely to be "tidied" later by someone who did not read it:

* the PARTIAL shape still refuses.  Some-classified was already blocked before
  this change and stays blocked; only the nothing-classified shape moved.
* `update(status="done")` stays UNGATED and records no gap.  The user was
  asked whether the ruling should fire on that route too and answered "only
  accept() and reviewer approval".  A test that starts failing because someone
  gated it is a test doing its job.
"""
from __future__ import annotations

import sys
import os
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_DATA = tempfile.TemporaryDirectory(prefix="completion-gate-unclassified-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0


def fixture(conds, kind="code"):
    global _n
    _n += 1
    org = ledger.Org.create(f"w11-{_n}")
    org.hire(USER, None, "haiku", 0, "owner")
    made = org.work_create(
        "owner", "W11 fixture",
        "Problem: an unclassified item completed with nothing checked. "
        "Solution: record the gap on the acceptance record.",
        acceptance=list(conds), kind=kind)
    return org, str(made["created"])


def check(org, wid, i, cls="met", res="passed"):
    org.work_check("owner", wid, i, "tests/run.log", classification=cls,
                   artifact="tests/run.log", runner="python",
                   execution="independent", result=res)


class UngatedShapeIsRecorded(unittest.TestCase):
    """Nothing classified -> completes, and says so."""

    def test_nothing_classified_completes_and_records_the_gap(self):
        org, wid = fixture(["one holds.", "two holds.", "three holds."])
        out = org.work_accept("owner", wid, None)
        self.assertEqual(org.work_get("owner", wid)["status"], "done")
        gap = org.work_get("owner", wid)["accepted"]["evidence_gap"]
        self.assertEqual(gap["unclassified"], 3)
        self.assertEqual(gap["total"], 3)
        self.assertIn("3 of 3", gap["summary"])
        self.assertIn("without classified evidence", gap["summary"])
        # the WARN half: the caller is told at the moment of completion
        self.assertIn("3 of 3", out["warning"])

    def test_an_item_with_no_conditions_at_all_says_that_instead(self):
        """172 of 473 archived items had this shape -- it is not the same as
        'conditions exist but nobody classified them' and must not read as it.
        """
        org, wid = fixture([])
        out = org.work_accept("owner", wid, None)
        gap = org.work_get("owner", wid)["accepted"]["evidence_gap"]
        self.assertEqual((gap["unclassified"], gap["total"]), (0, 0))
        self.assertIn("no acceptance conditions", gap["summary"])
        self.assertIn("no acceptance conditions", out["warning"])

    def test_a_fully_met_item_completes_with_NO_gap_recorded(self):
        """The negative control.  If this ever grows an `evidence_gap`, the
        record has started crying wolf on exactly the items that did the work.
        """
        org, wid = fixture(["one holds.", "two holds."])
        check(org, wid, 0)
        check(org, wid, 1)
        out = org.work_accept("owner", wid, None)
        self.assertEqual(org.work_get("owner", wid)["status"], "done")
        self.assertNotIn("evidence_gap", org.work_get("owner", wid)["accepted"])
        self.assertNotIn("warning", out)

    def test_the_gap_is_visible_in_the_item_history(self):
        org, wid = fixture(["one holds."])
        org.work_accept("owner", wid, None)
        # _work_hist merges its payload at the top level of the row
        last = org.work_get("owner", wid)["history"][-1]
        self.assertEqual(last["op"], "accept")
        self.assertIn("without classified evidence", last["evidence_gap"])


class GatedShapeStillRefuses(unittest.TestCase):
    """The blocking behaviour that existed before this change is untouched."""

    def test_a_qualified_classification_still_refuses(self):
        org, wid = fixture(["one holds."])
        check(org, wid, 0, cls="not_exercised", res="not_executed")
        with self.assertRaises(LedgerError) as caught:
            org.work_accept("owner", wid, None)
        self.assertIn("every acceptance condition needs", str(caught.exception))

    def test_the_PARTIAL_shape_still_refuses(self):
        """Some classified, some not -> refused, as before.

        This is the half of the ruling most at risk of being "made consistent"
        later.  It was already blocked, the user was shown that it was already
        blocked, and only the nothing-classified shape was moved.
        """
        org, wid = fixture(["one holds.", "two holds.", "three holds."])
        check(org, wid, 0)
        with self.assertRaises(LedgerError):
            org.work_accept("owner", wid, None)

    def test_a_refused_item_records_no_completion_and_no_gap(self):
        """A refusal mutates nothing -- no status, no acceptance record."""
        org, wid = fixture(["one holds.", "two holds."])
        check(org, wid, 0)
        before = org.work_get("owner", wid)["rev"]
        with self.assertRaises(LedgerError):
            org.work_accept("owner", wid, None)
        after = org.work_get("owner", wid)
        self.assertEqual(after["rev"], before)
        self.assertNotEqual(after["status"], "done")
        self.assertIsNone(after["accepted"])


class TheUpdateRouteStaysUngated(unittest.TestCase):
    """User ruling: only accept() and reviewer approval carry the gap."""

    def test_update_to_done_completes_and_records_no_gap(self):
        org, wid = fixture(["one holds.", "two holds."])
        org.work_update("owner", wid, status="done",
                        done_so_far=["the work"], working_on_next=[])
        got = org.work_get("owner", wid)
        self.assertEqual(got["status"], "done")
        self.assertEqual(got["accepted"]["via"], "update")
        self.assertNotIn("evidence_gap", got["accepted"])

    def test_update_to_done_still_bypasses_the_refusal_too(self):
        """Documenting the ruled-on consequence rather than hiding it.

        An item `accept()` refuses completes through `update`.  That was put
        to the user as its own question and left as it is deliberately, so it
        is written down here where the next reader will find it instead of
        rediscovering it as a surprise.
        """
        org, wid = fixture(["one holds."])
        check(org, wid, 0, cls="not_exercised", res="not_executed")
        with self.assertRaises(LedgerError):
            org.work_accept("owner", wid, None)
        org.work_update("owner", wid, status="done",
                        done_so_far=["the work"], working_on_next=[])
        self.assertEqual(org.work_get("owner", wid)["status"], "done")


class TheAmendedShapeIsCoveredToo(unittest.TestCase):
    """Finding f2: amending every condition empties the classified set.

    Before this change that turned the guard off and completed silently.  It
    still completes -- the ruling is warn, not block -- but it can no longer
    do so without saying that nothing was checked.
    """

    def test_rewriting_every_condition_completes_with_the_gap_recorded(self):
        org, wid = fixture(["one holds.", "two holds."])
        check(org, wid, 0)
        check(org, wid, 1)
        org.work_update("owner", wid,
                        acceptance=["one holds, narrowed.",
                                    "two holds, narrowed."],
                        done_so_far=["amended"], working_on_next=[])
        out = org.work_accept("owner", wid, None)
        gap = org.work_get("owner", wid)["accepted"]["evidence_gap"]
        self.assertEqual(gap["unclassified"], 2)
        self.assertIn("2 of 2", out["warning"])

    def test_rewriting_one_of_several_still_refuses(self):
        """The partial shape again, reached by amendment instead of by age."""
        org, wid = fixture(["one holds.", "two holds.", "three holds."])
        for i in range(3):
            check(org, wid, i)
        org.work_update("owner", wid,
                        acceptance=["one holds, narrowed.", "two holds.",
                                    "three holds."],
                        done_so_far=["amended"], working_on_next=[])
        with self.assertRaises(LedgerError):
            org.work_accept("owner", wid, None)


if __name__ == "__main__":
    unittest.main()
