"""W01 candidate-bound review workflow and failure atomicity.

These tests use only in-memory Org fixtures.  They pin the distinction between
an integration verdict (a review of one exact candidate) and the existing
formal review decision, which still completes the docket item.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-authorized-review-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0


def fixture():
    global _n
    _n += 1
    org = ledger.Org.create(f"w01-{_n}")
    for node in ("owner-a", "peer-b", "outsider-c"):
        org.hire(USER, None, "haiku", 0, node)
    org.work_create(
        "owner-a", "Candidate review fixture",
        objective="Problem: candidate and completion reviews were conflated. "
                  "Solution: keep a nonterminal exact-candidate verdict.",
        participants=["peer-b"],
    )
    return org, org.d["work_items"][-1]["slug"]


def item(org, slug):
    for row in org.d.get("work_items", []):
        if row["slug"] == slug:
            return row
    for row in org.d.get("work_items_archive", []):
        if row["slug"] == slug:
            return row
    raise AssertionError(slug)


def review(org, slug, reviewer="peer-b"):
    org.work_update("owner-a", slug, ["implementation ready"],
                    ["review exact candidate"], status="review",
                    reviewer=reviewer)


class AuthorizedReviewTests(unittest.TestCase):
    def test_participant_and_same_reviewer_round_trip_without_peer_escalation(self):
        org, slug = fixture()
        # An existing participant is explicitly authorized to receive review.
        review(org, slug)
        org.work_review_decide("peer-b", slug, "changes", "Fix finding")
        self.assertEqual(item(org, slug)["status"], "in_progress")
        # The owner can send the next round back to the same live reviewer.
        org.work_update("owner-a", slug, ["finding fixed"], [],
                        status="review", reviewer="peer-b")
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")
        # Self and unrelated reviewers remain refused, with no write leakage.
        before = copy.deepcopy(item(org, slug))
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["bad"], [], status="review",
                            reviewer="owner-a")
        self.assertEqual(item(org, slug), before)
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["bad"], [], status="review",
                            reviewer="outsider-c")
        self.assertEqual(item(org, slug), before)

    def test_review_packet_is_atomic_and_visible_without_completion(self):
        org, slug = fixture()
        packet_note = "Full review packet: test evidence and findings."
        org.work_update(
            "owner-a", slug, ["ready"], [], status="review", reviewer="peer-b",
            review_candidate="a" * 40,
            review_evidence=[{"kind": "log", "ref": "tests/w01.log",
                              "note": "focused controls"}],
            review_note=packet_note,
        )
        row = item(org, slug)
        self.assertEqual(row["status"], "review")
        self.assertEqual(row["review_packet"]["candidate"], "a" * 40)
        self.assertEqual(row["review_packet"]["note"], packet_note)
        self.assertEqual(row["review_packets"][-1]["evidence"][0]["ref"],
                         "tests/w01.log")
        self.assertIsNone(row["accepted"])
        # A malformed packet fails before status/reviewer/history changes.
        before = copy.deepcopy(row)
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["still ready"], [],
                            status="review", reviewer="peer-b",
                            review_candidate="not-a-sha")
        self.assertEqual(item(org, slug), before)

    def test_grouped_verdict_and_grant_validate_all_items_before_writing(self):
        org, first = fixture()
        second = org.work_create(
            "owner-a", "Second candidate fixture",
            objective="Problem: grouped review needs atomicity. "
                      "Solution: validate the full group first.",
            participants=["peer-b"],
        )["created"]
        review(org, first)
        review(org, second)
        snapshots = {s: copy.deepcopy(item(org, s)) for s in (first, second)}
        with self.assertRaises(LedgerError):
            org.work_candidate_verdict(
                "peer-b", first, items=[
                    {"slug": first, "candidate": "b" * 40,
                     "decision": "approve"},
                    {"slug": "missing-item", "candidate": "c" * 40,
                     "decision": "approve"},
                ])
        self.assertEqual(item(org, first), snapshots[first])
        self.assertEqual(item(org, second), snapshots[second])
        result = org.work_candidate_verdict(
            "peer-b", first, items=[
                {"slug": first, "candidate": "b" * 40,
                 "decision": "approve", "evidence": ["tests/a.log"]},
                {"slug": second, "candidate": "c" * 40,
                 "decision": "changes", "evidence": ["tests/b.log"]},
            ])
        self.assertEqual(result["count"], 2)
        self.assertEqual(item(org, first)["candidate_verdict"]["candidate"],
                         "b" * 40)
        self.assertEqual(item(org, second)["candidate_verdict"]["decision"],
                         "changes")
        # Grant groups are likewise all-or-nothing.
        before = {s: item(org, s)["reviewer"] for s in (first, second)}
        with self.assertRaises(LedgerError):
            org.work_review_grant("owner-a", "outsider-c",
                                  [{"slug": first}, {"slug": "missing-item"}])
        self.assertEqual({s: item(org, s)["reviewer"] for s in (first, second)},
                         before)

    def test_candidate_verdict_does_not_replace_formal_approve_and_reopen_clears_pointer(self):
        org, slug = fixture()
        review(org, slug)
        org.work_candidate_verdict("peer-b", slug, "d" * 40, "approve",
                                   evidence=["tests/verified.log"],
                                   next_actor="owner-a")
        self.assertEqual(item(org, slug)["status"], "review")
        self.assertIsNone(item(org, slug)["accepted"])
        org.work_review_decide("peer-b", slug, "approve", "formal approval")
        self.assertEqual(item(org, slug)["status"], "done")
        self.assertEqual(item(org, slug)["accepted"]["via"], "review_approve")
        org.work_update("owner-a", slug, ["extension"], [],
                        status="in_progress", reopen=True)
        row = item(org, slug)
        self.assertIsNone(row["candidate_verdict"])
        self.assertEqual(row["candidate_verdicts"][-1]["candidate"], "d" * 40)
        reopen = [h for h in row["history"] if h.get("op") == "reopen"][-1]
        self.assertEqual(reopen["candidate_verdict_was"]["candidate"], "d" * 40)


if __name__ == "__main__":
    unittest.main()
