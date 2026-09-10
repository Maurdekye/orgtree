"""Participant ticket-state authority (user rulings 2026-09-10 13:47+14:51).

ANY ticket participant may update its state in any manner — completion,
reopen and drop included — without superior review, and the owner may
complete its own item. The NAMED REVIEWER holds the same state control
(user 14:51: "include reviewer and assignee as part of the participants
able to mutate state") — but a reviewer's update leaves the assignment
where it is instead of claiming, and an assignment that lands the item on
its own reviewer empties the review seat (self-review stays prohibited).
The refusal half is exercised alongside: an unrelated agent stays locked
out entirely, and the item's IDENTITY (title/objective) stays owner-level.
Behavioral, against the real ledger: every leg calls the same methods the
orgtree_work tool calls.
"""
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-workstates-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0


def fixture():
    """A fresh org per test: owner-a holds an item, peer-b is a PARTICIPANT,
    outsider-c is an unrelated top-level agent, rev-r reviews."""
    global _n
    _n += 1
    # in-memory Org (the deploy_ready suite's pattern): no store, no data
    # root coupling with sibling test modules in one unittest process
    org = ledger.Org.create(f"ws-{_n}")
    for nid in ("owner-a", "peer-b", "outsider-c"):
        org.hire(USER, None, "haiku", 0, nid)
    # the reviewer must be nameable by the owner: in its subtree
    org.hire(USER, "owner-a", "haiku", 0, "rev-r")
    org.work_create("owner-a", "State authority fixture",
                    objective="Problem: authorization under test. "
                              "Solution: these assertions.",
                    participants=["peer-b"])
    wid = org.d["work_items"][-1]["slug"]
    return org, wid


def item(org, wid):
    for it in org.d.get("work_items", []):
        if it["slug"] == wid:
            return it
    for it in org.d.get("work_items_archive", []):
        if it["slug"] == wid:
            return it
    raise AssertionError(f"{wid} vanished")


class ParticipantStateTests(unittest.TestCase):
    def test_participant_completes_directly_and_it_is_a_real_completion(self):
        org, wid = fixture()
        r = org.work_update("peer-b", wid, ["built"], [], status="done")
        self.assertEqual(r["status"], "done")
        it = item(org, wid)
        self.assertEqual(it["status"], "done")
        acc = it.get("accepted") or {}
        self.assertEqual(acc.get("via"), "update",
                         "a done set through update writes the acceptance record")
        self.assertEqual((acc.get("by") or {}).get("node"), "peer-b")

    def test_participant_drops_with_reason_and_reopens(self):
        org, wid = fixture()
        org.work_update("peer-b", wid, ["dead end"], [], status="dropped",
                        dropped_reason="CANCELLED by peer-b under test; "
                                       "resume if the fixture changes")
        self.assertEqual(item(org, wid)["status"], "dropped")
        # ...and the reason requirement did not weaken with the authority
        org2, wid2 = fixture()
        with self.assertRaises(LedgerError):
            org2.work_update("peer-b", wid2, ["dead end"], [], status="dropped")
        # the same participant resumes it
        org.work_update("peer-b", wid, [], ["resuming"],
                        status="in_progress", reopen=True)
        it = item(org, wid)
        self.assertEqual(it["status"], "in_progress")
        self.assertIsNone(it.get("dropped_reason"))

    def test_participant_and_owner_accept(self):
        org, wid = fixture()
        r = org.work_accept("peer-b", wid, note="participant acceptance")
        self.assertEqual(item(org, wid)["status"], "done")
        self.assertEqual((item(org, wid)["accepted"]["by"] or {}).get("node"), "peer-b")
        self.assertTrue(r)
        # the owner too — the historical never-the-owner gate is retired
        org2, wid2 = fixture()
        org2.work_accept("owner-a", wid2)
        self.assertEqual(item(org2, wid2)["status"], "done")

    def test_owner_completes_its_own_item_through_update(self):
        org, wid = fixture()
        org.work_update("owner-a", wid, ["shipped"], [], status="done")
        it = item(org, wid)
        self.assertEqual(it["status"], "done")
        self.assertEqual(it["accepted"]["via"], "update")
        # a completed item still refuses a plain update — reopen is the door
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", wid, ["more"], [])

    def test_unrelated_agent_is_refused_every_route(self):
        org, wid = fixture()
        for call in (
            lambda: org.work_update("outsider-c", wid, ["x"], [], status="done"),
            lambda: org.work_update("outsider-c", wid, ["x"], []),
            lambda: org.work_accept("outsider-c", wid),
        ):
            with self.assertRaises(LedgerError):
                call()
        self.assertEqual(item(org, wid)["status"], "open",
                         "nothing the outsider tried touched the item")

    def _at_review(self):
        org, wid = fixture()
        org.work_update("owner-a", wid, ["ready"], [], status="review",
                        reviewer="rev-r")
        return org, wid

    def test_reviewer_mutates_state_without_claiming(self):
        # user 2026-09-10 14:51: the reviewer counts among the participants
        # able to mutate state — and doing so leaves the assignment alone
        org, wid = self._at_review()
        org.work_update("rev-r", wid, ["found gaps"], ["owner to fix"],
                        status="in_progress")
        it = item(org, wid)
        self.assertEqual(it["status"], "in_progress")
        self.assertEqual((it["owner"] or {}).get("node"), "owner-a",
                         "a reviewer's status update does not claim the item")
        self.assertEqual((it.get("reviewer") or {}).get("node"), "rev-r",
                         "…and it stays the reviewer")

    def test_reviewer_completes_through_update(self):
        org, wid = self._at_review()
        org.work_update("rev-r", wid, ["verified"], [], status="done")
        it = item(org, wid)
        self.assertEqual(it["status"], "done")
        self.assertEqual(it["accepted"]["via"], "update")
        self.assertEqual((it["accepted"]["by"] or {}).get("node"), "rev-r")
        self.assertEqual((it["owner"] or {}).get("node"), "owner-a")
        # the decision lane still works too, on a fresh fixture
        org2, wid2 = self._at_review()
        org2.work_review_decide("rev-r", wid2, "approve")
        self.assertEqual(item(org2, wid2)["status"], "done")

    def test_reviewer_explicit_self_assign_takes_item_and_empties_seat(self):
        org, wid = self._at_review()
        org.work_update("rev-r", wid, [], ["taking this over"],
                        status="in_progress", owner="rev-r")
        it = item(org, wid)
        self.assertEqual((it["owner"] or {}).get("node"), "rev-r")
        self.assertIsNone(it.get("reviewer"),
                          "the review seat empties: the owner cannot review "
                          "its own work")

    def test_reviewer_keep_in_place_target_and_refused_third_party(self):
        org, wid = self._at_review()
        # spelling out the owner the item already has = the implicit behavior
        org.work_update("rev-r", wid, ["checked"], [], owner="owner-a")
        self.assertEqual((item(org, wid)["owner"] or {}).get("node"), "owner-a")
        # a third party is a real reassignment and stays owner-level
        with self.assertRaises(LedgerError):
            org.work_update("rev-r", wid, ["x"], [], owner="peer-b")
        # …and so does naming a replacement reviewer
        with self.assertRaises(LedgerError):
            org.work_update("rev-r", wid, ["x"], [], status="review",
                            reviewer="peer-b")

    def test_reviewer_identity_stays_owner_level(self):
        org, wid = self._at_review()
        with self.assertRaises(LedgerError):
            org.work_update("rev-r", wid, ["x"], [], title="renamed by reviewer")
        with self.assertRaises(LedgerError):
            org.work_update("rev-r", wid, ["x"], [],
                            objective="rescoped by reviewer")

    def test_owner_assigning_to_reviewer_empties_seat(self):
        org, wid = self._at_review()
        org.work_update("owner-a", wid, [], ["handing to rev"],
                        owner="rev-r")
        it = item(org, wid)
        self.assertEqual((it["owner"] or {}).get("node"), "rev-r")
        self.assertIsNone(it.get("reviewer"))

    def test_identity_stays_owner_level_for_participants(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_update("peer-b", wid, ["x"], [], title="renamed by peer")
        with self.assertRaises(LedgerError):
            org.work_update("peer-b", wid, ["x"], [],
                            objective="rescoped by peer")


if __name__ == "__main__":
    unittest.main()
