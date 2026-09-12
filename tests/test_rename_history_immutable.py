"""A rename moves live holders and leaves authored docket history alone.

THE DEFECT. A work item's `owner` dict is THE SAME PYTHON OBJECT the assignment
history row holds as its `to`: `_work_assign_core` writes
`_work_hist(..., {"from": frm, "to": it["owner"]})`, storing the live dict
rather than a copy, and `_work_name_reviewer` does the same with the reviewer.
`_rekey_work_identity` then moved a rename onto the item with
`a["node"] = new`, which reached through that alias and rewrote a row authored
before the rename — no `rev` bump, no `updated_at` move, no event. The rename's
own warning says historical records keep the old name, and its docstring says
so twice; the docket quietly disagreed.

It was found while fixing the generation-ownership bug (the delete path had the
identical alias, fixed there as `_work_mark_deleted_holders`) and deferred to
this ticket. These tests are behavioural against the real ledger: real hires,
real docket rows written through the real verbs, real `rename` and real
`repair_rename_identity`. The deep comparisons snapshot the whole history with
`copy.deepcopy` and compare it back afterwards, because a length-and-rev check
is exactly what let the defect through the first time.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-renamehist-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import ledger  # noqa: E402
from orgtree.ledger import USER, LedgerError  # noqa: E402

_n = 0


def fixture(tier="haiku"):
    """A coordinator, the agent that owns the work, a peer, and a reviewer
    inside the owner's own subtree (so it is nameable as reviewer today)."""
    global _n
    _n += 1
    org = ledger.Org.create(f"renamehist-{_n}")
    org.hire(USER, None, tier, 3, "coordinator")
    org.hire(USER, "coordinator", tier, 0, "owner-agent")
    org.hire(USER, "coordinator", tier, 0, "peer-agent")
    org.hire(USER, "owner-agent", tier, 0, "reviewer-sub")
    return org


def make_item(org, owner, title):
    org.work_create(owner, title,
                    objective=f"Problem: {title} is not done. Solution: do it.",
                    owner=owner)
    return org.d["work_items"][-1]["slug"]


def stored(org, slug):
    for it in org._work_all():
        if it["slug"] == slug:
            return it
    raise AssertionError(f"{slug} vanished")


def rows(it, op):
    return [h for h in (it.get("history") or []) if h.get("op") == op]


def rename_at(org):
    """The `at` of the last logged rename — how `repair_rename_identity`
    identifies which rename it is finishing (it takes no old/new arguments)."""
    hits = [e for e in (org.d.get("events") or []) if e.get("op") == "rename"]
    if not hits:
        raise AssertionError("no rename event was logged")
    return str(hits[-1]["at"])


def stamps(it):
    """Everything a re-key promises not to move."""
    return {k: it.get(k) for k in ("rev", "updated_at", "docket_at",
                                   "status_at")}


class RenameKeepsAuthoredHistoryTests(unittest.TestCase):

    def test_owner_rename_leaves_the_assignment_row_naming_the_old_id(self):
        """THE REPORTED DEFECT, end to end."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Owner is renamed under it")
        org.work_assign(USER, slug, "peer-agent")
        it = stored(org, slug)
        assign = rows(it, "assign")[-1]
        self.assertEqual(assign["to"]["node"], "peer-agent")
        before, marks = copy.deepcopy(it["history"]), stamps(it)

        org.rename(USER, "peer-agent", "peer-renamed")

        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "peer-renamed")   # live moved
        self.assertEqual(it["history"], before)                 # history did not
        self.assertEqual(stamps(it), marks)
        self.assertEqual(rows(it, "assign")[-1]["to"]["node"], "peer-agent")

    def test_the_live_holder_is_no_longer_the_same_object_as_the_row(self):
        """The structural invariant behind the fix: rebound, not mutated."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Alias must be broken")
        org.work_assign(USER, slug, "peer-agent")
        it = stored(org, slug)
        row = rows(it, "assign")[-1]
        self.assertIs(it["owner"], row["to"])        # authored aliased, as before
        org.rename(USER, "peer-agent", "peer-renamed")
        it = stored(org, slug)
        self.assertIsNot(it["owner"], rows(it, "assign")[-1]["to"])

    def test_the_holder_keeps_its_mint_id_through_the_rename(self):
        """A rebound holder is the SAME AGENT, so `born` has to survive — it is
        what `_work_identity_state` reads to tell a continued session from a
        namesake, and dropping it would silently downgrade every renamed item
        to the weaker generation comparison."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Mint id survives")
        born = stored(org, slug)["owner"].get("born")
        self.assertTrue(born)
        org.rename(USER, "owner-agent", "owner-renamed")
        it = stored(org, slug)
        self.assertEqual(it["owner"].get("born"), born)
        self.assertEqual(org._work_identity_state(it["owner"]), (True, "live"))

    def test_reviewer_rename_moves_the_seat_and_keeps_its_row(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Reviewer is renamed under it")
        org.work_update("owner-agent", slug, ["drafted"], ["await review"],
                        status="review", reviewer="reviewer-sub")
        it = stored(org, slug)
        row = rows(it, "reviewer")[-1]
        self.assertEqual(row["to"]["node"], "reviewer-sub")
        before, marks = copy.deepcopy(it["history"]), stamps(it)

        org.rename(USER, "reviewer-sub", "reviewer-renamed")

        it = stored(org, slug)
        self.assertEqual(it["reviewer"]["node"], "reviewer-renamed")
        self.assertEqual(it["history"], before)
        self.assertEqual(stamps(it), marks)
        self.assertEqual(rows(it, "reviewer")[-1]["to"]["node"], "reviewer-sub")

    def test_a_renamed_reviewer_can_still_decide_the_review(self):
        """Why the reviewer belongs in the re-key at all: `work_review_decide`
        compares the actor against the stored reviewer, so a rename that left
        the old id there took the seat away from the only agent holding it."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Verdict after a rename")
        org.work_update("owner-agent", slug, ["drafted"], ["await review"],
                        status="review", reviewer="reviewer-sub")
        org.rename(USER, "reviewer-sub", "reviewer-renamed")
        out = org.work_review_decide("reviewer-renamed", slug, "changes",
                                     note="one more pass please")
        self.assertEqual(out["decision"], "changes")
        self.assertEqual(stored(org, slug)["status"], "in_progress")

    def test_an_archived_item_keeps_its_history_through_a_rename(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Archived before the rename")
        org.work_assign(USER, slug, "peer-agent")
        org.work_update("peer-agent", slug, ["shipped"], [], status="done")
        org.work_archive_now(USER, slug)
        self.assertTrue(any(it["slug"] == slug
                            for it in org.d["work_items_archive"]))
        it = stored(org, slug)
        before, marks = copy.deepcopy(it["history"]), stamps(it)

        org.rename(USER, "peer-agent", "peer-renamed")

        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "peer-renamed")
        self.assertEqual(it["history"], before)
        self.assertEqual(stamps(it), marks)

    def test_a_chain_of_renames_never_rewrites_an_earlier_row(self):
        """A → B → C. Each row keeps the id it was authored with, so the
        history reads as the sequence of things that happened rather than as
        the last name anybody used."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Renamed twice")
        org.work_assign(USER, slug, "peer-agent")
        org.rename(USER, "peer-agent", "peer-b")
        mid = copy.deepcopy(stored(org, slug)["history"])
        org.work_update("peer-b", slug, ["a step"], ["another"])
        after_update = copy.deepcopy(stored(org, slug)["history"])
        org.rename(USER, "peer-b", "peer-c")
        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "peer-c")
        self.assertEqual(it["history"], after_update)
        self.assertEqual(it["history"][:len(mid)], mid)
        self.assertEqual(rows(it, "assign")[-1]["to"]["node"], "peer-agent")
        # the update was authored by `peer-b`, and that is what it still says
        self.assertEqual(rows(it, "update")[-1]["by"]["node"], "peer-b")

    def test_participants_move_without_touching_the_membership_row(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Participant is renamed")
        org.work_participants("owner-agent", slug, add=["peer-agent"])
        it = stored(org, slug)
        before, marks = copy.deepcopy(it["history"]), stamps(it)
        org.rename(USER, "peer-agent", "peer-renamed")
        it = stored(org, slug)
        self.assertEqual(it["participants"], ["peer-renamed"])
        self.assertEqual(it["history"], before)
        self.assertEqual(stamps(it), marks)
        self.assertEqual(rows(it, "participants")[-1]["now"], ["peer-agent"])


class RepairPathTests(unittest.TestCase):
    """`repair_rename_identity` finishes a rename for rows an OLDER rename
    stranded, so its inputs are rows written by the code that had the defect:
    a live holder that is still the very object an authored row holds. The
    fixture below reconstructs exactly that, which is the only way to exercise
    the path a current rename no longer produces."""

    def _stranded(self, org, slug, old):
        it = stored(org, slug)
        row = rows(it, "assign")[-1]
        holder = dict(row["to"])
        holder["node"] = old
        it["owner"] = row["to"] = holder      # aliased, as the old code left it
        return it

    def test_repair_moves_the_live_field_and_leaves_the_row(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Stranded by an older rename")
        org.work_assign(USER, slug, "peer-agent")
        org.rename(USER, "peer-agent", "peer-renamed")
        it = self._stranded(org, slug, "peer-agent")
        before, marks = copy.deepcopy(it["history"]), stamps(it)
        at = rename_at(org)

        org.repair_rename_identity(USER, at, work_items=[slug])

        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "peer-renamed")
        self.assertEqual(it["history"], before)
        self.assertEqual(stamps(it), marks)
        self.assertEqual(rows(it, "assign")[-1]["to"]["node"], "peer-agent")
        self.assertIsNot(it["owner"], rows(it, "assign")[-1]["to"])

    def test_repair_still_refuses_an_item_that_holds_nothing_to_repair(self):
        """The guard that keeps repair from being a general re-key facility."""
        org = fixture()
        slug = make_item(org, "owner-agent", "Already correct")
        org.work_assign(USER, slug, "peer-agent")
        org.rename(USER, "peer-agent", "peer-renamed")
        at = rename_at(org)
        with self.assertRaises(LedgerError):
            org.repair_rename_identity(USER, at, work_items=[slug])


class UnchangedBehaviourTests(unittest.TestCase):
    """The fix is a rebind, so everything around it has to read exactly as it
    did. These are the neighbours the ticket names."""

    def test_a_renamed_owner_still_holds_its_items(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Still mine after a rename")
        org.rename(USER, "owner-agent", "owner-renamed")
        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "owner-renamed")
        self.assertTrue(org._work_can_manage("owner-renamed", it))
        self.assertEqual(org.work_reassign_abandoned(now_ts=10_000_000.0), [])

    def test_a_compaction_after_a_rename_still_keeps_the_item(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Compacted after a rename")
        org.rename(USER, "owner-agent", "owner-renamed")
        org.cheap_compact(USER, "owner-renamed")
        it = stored(org, slug)
        self.assertTrue(org._work_identity_state(it["owner"])[0])
        self.assertEqual(org.work_reassign_abandoned(now_ts=10_000_000.0), [])

    def test_deleting_a_renamed_holder_still_invalidates_the_item(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Held by a deleted namesake")
        org.work_assign(USER, slug, "peer-agent")
        org.rename(USER, "peer-agent", "peer-renamed")
        for it in org._work_all():
            it["docket_at"] = it["updated_at"] = "1970-01-01T00:00:00Z"
        org.delete(USER, "peer-renamed")
        it = stored(org, slug)
        self.assertTrue(it["owner"]["deleted"])
        self.assertEqual(rows(it, "assign")[-1]["to"]["node"], "peer-agent")
        moved = org.work_reassign_abandoned(now_ts=10_000_000.0)
        self.assertEqual([m["assigned"] for m in moved], [slug])

    def test_explicit_assignment_after_a_rename_still_records_itself(self):
        org = fixture()
        slug = make_item(org, "owner-agent", "Handed over after a rename")
        org.rename(USER, "owner-agent", "owner-renamed")
        org.work_assign(USER, slug, "peer-agent")
        it = stored(org, slug)
        self.assertEqual(it["owner"]["node"], "peer-agent")
        self.assertEqual(rows(it, "assign")[-1]["from"]["node"],
                         "owner-renamed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
