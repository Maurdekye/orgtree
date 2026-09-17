"""THE REVIEW SEAT: an owner asks, the shared superior grants, the peer reviews.

The refusal these tests exist for is the one twenty-four agents met:

    "you may ask yourself, an agent in your subtree, or your own superior to
     review this — 'X' is none of those"

In an org whose every genuinely INDEPENDENT reviewer is a peer, that leaves the
one status meaning "an agent is reviewing this" unreachable for the reviews the
org actually runs, and the workaround it forced — naming the shared coordinator
as reviewer while somebody else reviewed — put a false line in the record the
docket exists to keep true.

What is pinned here is both halves of the fix and the authority that must NOT
have moved: an owner still cannot name a peer unilaterally, and the seat is
granted by the agent above them both or not at all.

Isolated ORGTREE_DATA, in-memory Org fixtures; no live item is touched.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-review-seat-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

# The ticket requires this assertion, not just the assignment above it: a suite
# that mutated the real docket while proving a docket feature would be the one
# failure no amount of passing could make up for.
assert os.path.realpath(store.DATA_ROOT) == os.path.realpath(_data.name), (
    f"ORGTREE_DATA did not take effect before import: {store.DATA_ROOT}")

_n = 0


def fixture(participants=None):
    """coordinator over owner-a and peer-b — the shape the whole org has, and
    the shape the old rule could not express a review in. `outsider-c` sits in
    a branch of its own so "no grant" can be tested against somebody the
    coordinator is NOT above."""
    global _n
    _n += 1
    org = ledger.Org.create(f"seat-{_n}")
    org.hire(USER, None, "haiku", 0, "coordinator")
    org.hire(USER, None, "haiku", 0, "other-coordinator")
    for node in ("owner-a", "peer-b", "peer-d"):
        org.hire(USER, "coordinator", "haiku", 0, node)
    org.hire(USER, "other-coordinator", "haiku", 0, "outsider-c")
    slug = org.work_create(
        "owner-a", f"Review seat fixture {_n}",
        objective="Problem: the docket will not let an owner name a peer as "
                  "reviewer. Solution: the shared superior grants the seat.",
        participants=list(participants or []),
    )["created"]
    return org, slug


def item(org, slug):
    for row in list(org.d.get("work_items", [])) + list(
            org.d.get("work_items_archive", [])):
        if row["slug"] == slug:
            return row
    raise AssertionError(slug)


def seats(org, slug):
    return [s["reviewer"] for s in (item(org, slug).get("review_seats") or [])
            if s.get("state") == "granted"]


class ReviewSeatEndToEndTests(unittest.TestCase):
    def test_owner_requests_superior_grants_peer_reviews_end_to_end(self):
        """The whole loop the ticket asks to see, in order, with the record
        naming the agent that actually reviewed at every step."""
        org, slug = fixture()

        # 1. The owner cannot name the peer, and the refusal now says how to ask.
        with self.assertRaises(LedgerError) as caught:
            org.work_update("owner-a", slug, ["ready"], [], status="review",
                            reviewer="peer-b")
        self.assertIn("review_request", str(caught.exception))
        self.assertIsNone(item(org, slug)["reviewer"])

        # 2. The owner ASKS. This grants nothing.
        asked = org.work_review_request("owner-a", slug, "peer-b",
                                        note="peer-b wrote the ledger half")
        self.assertEqual(asked["to"], "coordinator")
        self.assertEqual(asked["notified"], "coordinator")
        self.assertEqual(seats(org, slug), [])
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["ready"], [], status="review",
                            reviewer="peer-b")

        # The ask reaches the shared superior as a typed request it can act on.
        mail = org.d["mail"]["coordinator"][-1]
        self.assertEqual(mail["ev"]["variant"], "docket.review_seat_requested")
        self.assertEqual(mail["ev"]["reviewer"], "peer-b")
        self.assertEqual(mail["ev"]["grantor"], "coordinator")

        # 3. The shared superior GRANTS — while the item is NOT at review,
        #    which is the whole point: no false reviewer is ever written.
        self.assertNotEqual(item(org, slug)["status"], "review")
        granted = org.work_review_grant("coordinator", "peer-b", [slug])
        self.assertEqual(granted["granted"], [slug])
        self.assertEqual(granted["seated"], [])        # not handed over yet
        self.assertEqual(seats(org, slug), ["peer-b"])
        self.assertIsNone(item(org, slug)["reviewer"])
        self.assertEqual(
            [r["state"] for r in item(org, slug)["review_seat_requests"]],
            ["granted"])
        owner_mail = org.d["mail"]["owner-a"][-1]
        self.assertEqual(owner_mail["ev"]["variant"], "docket.review_seat_decided")
        self.assertEqual(owner_mail["ev"]["decision"], "granted")
        self.assertIs(owner_mail["ev"]["seated"], False)

        # 4. The owner names the peer. THE RECORD NAMES THE AGENT THAT REVIEWS.
        org.work_update("owner-a", slug, ["ready"], ["peer review"],
                        status="review", reviewer="peer-b")
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")
        self.assertEqual(org.d["mail"]["peer-b"][-1]["ev"]["variant"],
                         "docket.review_requested")

        # 5. THE NAMING SPENT THE SEAT (user ruling 2026-09-16: one round per
        #    grant). A changes verdict, and the recheck needs a FRESH grant.
        self.assertEqual(seats(org, slug), [])
        self.assertEqual(
            [(s["reviewer"], s["state"], s["spent_via"])
             for s in item(org, slug)["review_seats"]],
            [("peer-b", "spent", "named")])
        org.work_review_decide("peer-b", slug, "changes", "one finding")
        self.assertEqual(item(org, slug)["status"], "in_progress")
        with self.assertRaises(LedgerError) as caught:
            org.work_update("owner-a", slug, ["finding fixed"], [],
                            status="review", reviewer="peer-b")
        self.assertIn("spent by the round it authorized", str(caught.exception))
        self.assertEqual(item(org, slug)["status"], "in_progress")

        # The owner asks again and the superior grants again — every round is
        # seen, which is exactly what the ruling bought.
        org.work_review_request("owner-a", slug, "peer-b", note="round two")
        org.work_review_grant("coordinator", "peer-b", [slug])
        org.work_update("owner-a", slug, ["finding fixed"], [],
                        status="review", reviewer="peer-b")
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")
        self.assertEqual([s["state"] for s in item(org, slug)["review_seats"]],
                         ["spent", "spent"])

        # 6. The approval lands, and the completion names the peer.
        org.work_review_decide("peer-b", slug, "approve", "looks right")
        row = item(org, slug)
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["accepted"]["by"]["node"], "peer-b")
        self.assertEqual(row["accepted"]["via"], "review_approve")
        self.assertEqual(row["reviewer"]["node"], "peer-b")

    def test_an_agent_with_no_grant_still_cannot_be_named(self):
        """The authority has NOT moved. This is the condition the fix is worth
        nothing without."""
        org, slug = fixture()
        before = copy.deepcopy(item(org, slug))

        # A peer with no seat: refused, and nothing is written.
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["ready"], [], status="review",
                            reviewer="peer-b")
        self.assertEqual(item(org, slug), before)

        # A grant to ONE peer does not seat another.
        org.work_review_grant("coordinator", "peer-b", [slug])
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["ready"], [], status="review",
                            reviewer="peer-d")
        self.assertIsNone(item(org, slug)["reviewer"])

        # The owner cannot grant itself a peer: it is not above peer-d.
        with self.assertRaises(LedgerError):
            org.work_review_grant("owner-a", "peer-d", [slug])
        self.assertEqual(seats(org, slug), ["peer-b"])

        # Nor can a coordinator grant somebody it is not above and who has no
        # other standing on the item.
        with self.assertRaises(LedgerError):
            org.work_review_grant("coordinator", "outsider-c", [slug])
        self.assertEqual(seats(org, slug), ["peer-b"])

        # And the seat is PER ITEM: a second item starts with none.
        second = org.work_create(
            "owner-a", "Second seat fixture",
            objective="Problem: a grant must not leak to other work. "
                      "Solution: seats are recorded on the item.")["created"]
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", second, ["ready"], [], status="review",
                            reviewer="peer-b")

    def test_a_granted_reviewer_holds_exactly_what_a_reviewer_holds(self):
        """It does not gain the item, and its update does not claim it."""
        org, slug = fixture()
        org.work_review_grant("coordinator", "peer-b", [slug])
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="peer-b")

        # read + evidence + full participant-level state control...
        org.work_evidence("peer-b", slug, "note", "tests/seat.log", "ran it")
        self.assertEqual(item(org, slug)["evidence"][-1]["ref"], "tests/seat.log")
        org.work_update("peer-b", slug, ["reviewer checked the build"], [])

        # ...and the item is STILL owner-a's after the reviewer wrote to it.
        self.assertEqual(item(org, slug)["owner"]["node"], "owner-a")
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")

        # A granted peer may not choose its own successor in the review seat.
        with self.assertRaises(LedgerError):
            org.work_update("peer-b", slug, ["handing off"], [],
                            status="review", reviewer="peer-d")

    def test_request_is_refused_when_no_request_is_needed(self):
        """Granting a seat that changes nothing would read, later, as though it
        had — so asking for one you do not need is refused, saying why."""
        org, slug = fixture(participants=["peer-d"])
        # your own superior
        with self.assertRaises(LedgerError) as e:
            org.work_review_request("owner-a", slug, "coordinator")
        self.assertIn("already name", str(e.exception))
        # an existing participant
        with self.assertRaises(LedgerError) as e:
            org.work_review_request("owner-a", slug, "peer-d")
        self.assertIn("participant", str(e.exception))
        # the owner itself
        with self.assertRaises(LedgerError) as e:
            org.work_review_request("owner-a", slug, "owner-a")
        self.assertIn("self-review", str(e.exception))
        # and a seat already standing
        org.work_review_grant("coordinator", "peer-b", [slug])
        with self.assertRaises(LedgerError) as e:
            org.work_review_request("owner-a", slug, "peer-b")
        self.assertIn("already holds the review seat", str(e.exception))
        self.assertEqual(item(org, slug)["review_seat_requests"], [])

    def test_duplicate_request_is_refused_while_one_is_pending(self):
        org, slug = fixture()
        org.work_review_request("owner-a", slug, "peer-b")
        with self.assertRaises(LedgerError) as e:
            org.work_review_request("owner-a", slug, "peer-b")
        self.assertIn("still pending", str(e.exception))
        self.assertEqual(len(item(org, slug)["review_seat_requests"]), 1)

    def test_a_seat_spent_by_naming_has_nothing_left_to_revoke(self):
        """The one-round rule and revoke reach the same end state by different
        routes, and the row says which route it was."""
        org, slug = fixture()
        org.work_review_request("owner-a", slug, "peer-b")
        org.work_review_grant("coordinator", "peer-b", [slug])
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="peer-b")
        with self.assertRaises(LedgerError) as e:
            org.work_review_revoke("coordinator", slug, "peer-b")
        self.assertIn("nothing to revoke", str(e.exception))
        self.assertEqual(item(org, slug)["review_seats"][0]["state"], "spent")

    def test_revoke_takes_an_unspent_seat_back_and_declines_a_pending_ask(self):
        org, slug = fixture()
        org.work_review_request("owner-a", slug, "peer-b")
        org.work_review_grant("coordinator", "peer-b", [slug])

        # Granted but never named, so the seat is still standing — and this is
        # the one a superior can genuinely take back.
        self.assertEqual(seats(org, slug), ["peer-b"])
        out = org.work_review_revoke("coordinator", slug, "peer-b",
                                     note="peer-b is being retired")
        self.assertTrue(out["seat_revoked"])
        self.assertEqual(seats(org, slug), [])
        self.assertEqual(item(org, slug)["review_seats"][0]["state"], "revoked")
        with self.assertRaises(LedgerError):
            org.work_update("owner-a", slug, ["ready"], [], status="review",
                            reviewer="peer-b")

        # A pending ask with no seat behind it is declined by the same verb.
        org.work_review_request("owner-a", slug, "peer-d")
        out = org.work_review_revoke("coordinator", slug, "peer-d",
                                     note="peer-d has no context here")
        self.assertFalse(out["seat_revoked"])
        # seq counts every ask on the item, so peer-d's is the second one.
        self.assertEqual(out["requests"], [2])
        states = {r["reviewer"]: r["state"]
                  for r in item(org, slug)["review_seat_requests"]}
        self.assertEqual(states["peer-d"], "declined")
        # ...and the owner withdrawing its own ask is recorded as a withdrawal,
        # not as its superior turning it down.
        org.work_review_request("owner-a", slug, "peer-d")
        org.work_review_revoke("owner-a", slug, "peer-d")
        self.assertEqual(
            [r["state"] for r in item(org, slug)["review_seat_requests"]
             if r["reviewer"] == "peer-d"], ["declined", "withdrawn"])

        with self.assertRaises(LedgerError):
            org.work_review_revoke("coordinator", slug, "peer-d")

    def test_a_seat_is_spent_only_when_it_was_what_authorized_the_naming(self):
        """An agent the owner could have named anyway does not burn somebody's
        grant by being named through standing it already had."""
        org, slug = fixture(participants=["peer-d"])
        org.work_review_grant("coordinator", "peer-d", [slug])
        # peer-d is a participant, so participation is what lets the owner name
        # it; the seat is untouched and still standing afterwards.
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="peer-d")
        self.assertEqual(seats(org, slug), ["peer-d"])
        self.assertIsNone(item(org, slug)["review_seats"][0]["spent_at"])
        # And the coordinator naming its own subordinate spends nothing either.
        org.work_review_decide("peer-d", slug, "changes", "again")
        org.work_review_grant("coordinator", "peer-b", [slug])
        org.work_update("coordinator", slug, ["fixed"], [], status="review",
                        reviewer="peer-b", owner="owner-a")
        self.assertIn("peer-b", seats(org, slug))

    def test_the_next_round_can_be_asked_for_while_one_is_still_in_flight(self):
        """Revoking then does not cancel the verdict already owed — the item
        keeps saying who is actually reviewing it, which is the state this
        whole feature exists to protect."""
        org, slug = fixture()
        org.work_review_grant("coordinator", "peer-b", [slug])
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="peer-b")
        org.work_review_request("owner-a", slug, "peer-b", note="round two")
        out = org.work_review_revoke("coordinator", slug, "peer-b",
                                     note="not a second round")
        self.assertFalse(out["seat_revoked"])
        self.assertIn("in flight", out["status"])
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")
        self.assertEqual(item(org, slug)["status"], "review")
        org.work_review_decide("peer-b", slug, "approve", "fine as it stands")
        self.assertEqual(item(org, slug)["status"], "done")

    def test_grant_on_an_item_already_at_review_still_hands_the_seat_over(self):
        """The behaviour `orgtree_staff`/`hire` review_items has always had, and
        the one branch that must not change: at `review`, a grant IS a handover."""
        org, slug = fixture(participants=["peer-d"])
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="peer-d")
        out = org.work_review_grant("coordinator", "peer-b", [slug])
        self.assertEqual(out["seated"], [slug])
        self.assertEqual(item(org, slug)["reviewer"]["node"], "peer-b")
        self.assertTrue(org.d["mail"]["owner-a"][-1]["ev"]["seated"])
        # The handover IS the round the grant authorized, so it spends the seat
        # exactly as an owner naming the peer would.
        seat = [s for s in item(org, slug)["review_seats"]
                if s["reviewer"] == "peer-b"][0]
        self.assertEqual((seat["state"], seat["spent_via"]),
                         ("spent", "granted_at_review"))

    def test_grant_groups_stay_all_or_nothing(self):
        org, first = fixture()
        second = org.work_create(
            "owner-a", "Grouped seat fixture",
            objective="Problem: a half-applied grant group is worse than none. "
                      "Solution: validate every item first.")["created"]
        before = {s: copy.deepcopy(item(org, s)) for s in (first, second)}
        with self.assertRaises(LedgerError):
            org.work_review_grant("coordinator", "peer-b",
                                  [first, "missing-item", second])
        self.assertEqual({s: item(org, s) for s in (first, second)}, before)
        org.work_review_grant("coordinator", "peer-b", [first, second])
        self.assertEqual(seats(org, first), ["peer-b"])
        self.assertEqual(seats(org, second), ["peer-b"])

    def test_seats_and_asks_are_served_on_the_wire(self):
        """"Who may review this, and who said so" is unanswerable if the answer
        is not readable."""
        org, slug = fixture()
        org.work_review_request("owner-a", slug, "peer-b", note="why peer-b")
        org.work_review_grant("coordinator", "peer-b", [slug], note="agreed")
        view = org.work_get("owner-a", slug)
        self.assertEqual([s["reviewer"] for s in view["review_seats"]], ["peer-b"])
        self.assertEqual(view["review_seats"][0]["granted_by"], "coordinator")
        self.assertEqual(view["review_seats"][0]["note"], "agreed")
        ask = view["review_seat_requests"][0]
        self.assertEqual((ask["reviewer"], ask["to"], ask["state"]),
                         ("peer-b", "coordinator", "granted"))
        ops = [h["op"] for h in view["history"]]
        self.assertIn("review_seat_requested", ops)
        self.assertIn("review_seat_granted", ops)

    def test_the_grantor_is_the_nearest_shared_superior_not_the_root(self):
        org, slug = fixture()
        org.hire(USER, "owner-a", "haiku", 0, "sub-owner")
        org.hire(USER, "coordinator", "haiku", 0, "mid")
        org.hire(USER, "mid", "haiku", 0, "deep-peer")
        org.work_assign("owner-a", slug, "sub-owner")
        # sub-owner's ask for deep-peer goes to `coordinator` — the nearest node
        # on deep-peer's OWN chain that is also owner-level here. `mid` is above
        # deep-peer but holds nothing on this item, so it is not asked.
        out = org.work_review_request("sub-owner", slug, "deep-peer")
        self.assertEqual(out["to"], "coordinator")

    def test_the_user_is_asked_when_the_org_has_no_shared_superior(self):
        org, slug = fixture()
        out = org.work_review_request("owner-a", slug, "outsider-c")
        self.assertEqual(out["to"], USER)
        # The user is not a mail node, so nothing was posted — and the request
        # stands anyway, saying so, rather than being lost to a bounced notice.
        self.assertEqual(
            [r["to"] for r in item(org, slug)["review_seat_requests"]], [USER])
        self.assertTrue(out.get("notified") is None or
                        out.get("notice_refused"))
        # ...and the user can answer it.
        org.work_review_grant(USER, "outsider-c", [slug])
        org.work_update("owner-a", slug, ["ready"], [], status="review",
                        reviewer="outsider-c")
        self.assertEqual(item(org, slug)["reviewer"]["node"], "outsider-c")

    def test_asking_is_owner_level_and_a_stranger_cannot_ask(self):
        org, slug = fixture()
        with self.assertRaises(LedgerError):
            org.work_review_request("peer-d", slug, "peer-b")
        self.assertEqual(item(org, slug).get("review_seat_requests") or [], [])


if __name__ == "__main__":
    unittest.main()
