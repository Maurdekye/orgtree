"""The landing slot on `main` as a mechanism rather than a convention.

Exclusive access to `main` used to be granted by one message and released by
another, with nothing in the system actually holding it.  The tool that exists
for it reported `reservation records are malformed` on `list`, which is the
first thing anyone runs, so nobody used it.

These tests cover the four properties that make it a lease: an empty store
reads as empty, one holder at a time, a losing contender can see who holds it,
a lease carries the base commit it was taken against, and a holder that dies
does not strand the slot.  No live org document or filesystem data is read.
"""

import unittest

from orgtree import reservations


MAIN = "1" * 40          # the commit `main` was at when the lease was taken
BRANCH = "2" * 40        # the commit the holder intends to land
MOVED = "3" * 40         # `main` after somebody else landed


class EmptyStoreTests(unittest.TestCase):
    """An absent store is empty, not damaged.

    This is the regression for the bug that made the whole mechanism look
    broken: every read action reported the data as malformed when there was
    simply no data yet.
    """

    def test_list_on_a_fresh_store_returns_no_records(self):
        got = reservations.execute({}, "agent-a", {"action": "list"})
        self.assertEqual(got["reservations"], [])
        self.assertEqual(got["count"], 0)

    def test_every_read_action_tolerates_a_fresh_store(self):
        for args in ({"action": "list"},
                     {"action": "landing", "item": "an-item"},
                     {"action": "overlap", "item": "an-item", "paths": ["a"]}):
            with self.subTest(action=args["action"]):
                got = reservations.execute({}, "agent-a", args,
                                           item_reader=lambda item: True)
                self.assertEqual(got["count"], 0)

    def test_an_id_bearing_action_on_a_fresh_store_says_no_such_reservation(self):
        # Not "malformed": there is nothing wrong with the store, the caller
        # just named a record that does not exist.
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "no such reservation"):
            reservations.execute({}, "agent-a", {
                "action": "invalidate", "reservation": "res-nope",
                "candidate": BRANCH, "base": MAIN})

    def test_a_genuinely_malformed_store_still_refuses_and_says_what_it_found(self):
        with self.assertRaisesRegex(reservations.ReservationError,
                                    r"malformed.*expected a list, found dict"):
            reservations.execute({"reservations": {}}, "agent-a",
                                 {"action": "list"})

    def test_first_acquire_initializes_the_store(self):
        doc = {}
        reservations.execute(doc, "agent-a", {
            "action": "acquire", "resource": "main",
            "candidate": BRANCH, "base": MAIN}, now_ts=1000.0)
        self.assertEqual(len(doc["reservations"]), 1)


class LandingSlotContentionTests(unittest.TestCase):
    """Two agents contending for `main`, sharing no docket item.

    This is the real shape of the problem: agents queueing to land are working
    different tickets, so nothing about their work is visible to each other.
    """

    def setUp(self):
        self.doc = {}
        self.ts = 1000.0
        # Each agent can read its own ticket and nobody else's, which is the
        # normal case for two agents queueing to land different tickets.
        self.reads_nothing = self.reader_for("agent-b")
        self.live = lambda node: node in {"agent-a", "agent-b"}

    @staticmethod
    def reader_for(actor):
        return lambda item: item == f"{actor}-ticket"

    def acquire(self, actor, candidate=BRANCH, base=MAIN, at=None, **extra):
        args = {"action": "acquire", "resource": "main",
                "candidate": candidate, "base": base}
        args.update(extra)
        return reservations.execute(
            self.doc, actor, args, item_reader=self.reader_for(actor),
            node_exists=self.live, now_ts=self.ts if at is None else at)

    def test_one_holder_at_a_time_and_the_loser_is_told_who_holds_it(self):
        first = self.acquire("agent-a")
        self.assertEqual(first["reservation"]["owner"], "agent-a")

        with self.assertRaises(reservations.ReservationError) as caught:
            self.acquire("agent-b", candidate="4" * 40)
        refusal = str(caught.exception)
        # The refusal has to be actionable on its own: who holds it, since
        # when, and until when.  "Already reserved" alone sends the loser back
        # to asking around by mail, which is the cost this ticket exists to
        # remove.
        self.assertIn("agent-a", refusal)
        self.assertIn(first["reservation"]["id"], refusal)
        self.assertIn(first["reservation"]["expires_at"], refusal)
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_a_contender_can_see_the_holder_without_asking_anyone(self):
        self.acquire("agent-a", paths=["engine/backend/orgtree/ledger.py"],
                     item="agent-a-ticket")
        seen = reservations.execute(
            self.doc, "agent-b", {"action": "list", "resource": "main"},
            item_reader=self.reads_nothing, now_ts=self.ts)
        self.assertEqual(seen["count"], 1)
        row = seen["reservations"][0]
        self.assertEqual(row["owner"], "agent-a")
        self.assertEqual(row["state"], "held")
        self.assertEqual(row["base"], MAIN)
        self.assertTrue(row["created_at"])
        self.assertEqual(row["view"], "contention")
        # Seeing that the slot is taken must not disclose the holder's work.
        self.assertNotIn("paths", row)
        self.assertNotIn("item", row)

    def test_an_unfiltered_list_is_not_a_directory_of_private_reservations(self):
        self.acquire("agent-a", item="agent-a-ticket")
        seen = reservations.execute(
            self.doc, "agent-b", {"action": "list"},
            item_reader=self.reads_nothing, now_ts=self.ts)
        self.assertEqual(seen["count"], 0)

    def test_the_holder_still_sees_its_own_reservation_in_full(self):
        self.acquire("agent-a", paths=["engine/backend/orgtree/ledger.py"])
        seen = reservations.execute(
            self.doc, "agent-a", {"action": "list", "resource": "main"},
            item_reader=self.reads_nothing, now_ts=self.ts)
        self.assertEqual(seen["reservations"][0]["paths"],
                         ["engine/backend/orgtree/ledger.py"])
        self.assertNotIn("view", seen["reservations"][0])

    def test_release_then_the_next_agent_acquires(self):
        first = self.acquire("agent-a")
        released = reservations.execute(
            self.doc, "agent-a",
            {"action": "release", "reservation": first["reservation"]["id"]},
            item_reader=self.reads_nothing, node_exists=self.live,
            now_ts=self.ts + 60)
        self.assertTrue(released["released"])
        self.assertTrue(released["release_receipt"])

        second = self.acquire("agent-b", candidate="4" * 40, at=self.ts + 61)
        self.assertEqual(second["reservation"]["owner"], "agent-b")
        self.assertFalse(second["replayed"])
        self.assertEqual(self.doc["reservations"][0]["state"], "released")
        self.assertEqual(self.doc["reservations"][1]["state"], "held")

    def test_a_second_acquire_by_the_holder_is_a_replay_not_a_second_lease(self):
        first = self.acquire("agent-a")
        replay = self.acquire("agent-a")
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["reservation"]["id"], first["reservation"]["id"])
        self.assertEqual(len(self.doc["reservations"]), 1)


class StaleLeaseTests(unittest.TestCase):
    """A lease records the base commit it was taken against.

    That is what makes a stale lease detectable rather than merely old: the
    holder rebased onto a commit that is no longer the tip.
    """

    def setUp(self):
        self.doc = {}
        self.ts = 1000.0
        self.visible = lambda item: True
        self.live = lambda node: True

    def acquire(self, actor="agent-a", base=MAIN, candidate=BRANCH, **extra):
        args = {"action": "acquire", "resource": "main", "candidate": candidate,
                "base": base}
        args.update(extra)
        return reservations.execute(self.doc, actor, args,
                                    item_reader=self.visible,
                                    node_exists=self.live, now_ts=self.ts)

    def test_the_lease_carries_the_base_it_was_taken_against(self):
        got = self.acquire()
        self.assertEqual(got["reservation"]["base"], MAIN)
        self.assertEqual(got["reservation"]["candidate"], BRANCH)

    def test_a_lease_whose_base_has_moved_is_detectable(self):
        self.acquire(lease_s=1, stale_s=1)
        # `main` has moved on; the holder's lease was taken against a commit
        # that is no longer the tip, and it stopped heartbeating.
        probe = reservations.execute(self.doc, "agent-a", {
            "action": "list", "resource": "main",
            "candidate": BRANCH, "base": MOVED},
            item_reader=self.visible, now_ts=self.ts + 30)
        self.assertEqual(len(probe["stale"]), 1)
        row = self.doc["reservations"][0]
        self.assertEqual(row["state"], "stale")
        self.assertEqual(row["stale_reason"], "candidate_or_base_changed")

    def test_a_moved_base_does_not_stale_a_lease_that_is_still_working(self):
        self.acquire(lease_s=600, stale_s=600)
        probe = reservations.execute(self.doc, "agent-a", {
            "action": "list", "resource": "main",
            "candidate": BRANCH, "base": MOVED},
            item_reader=self.visible, now_ts=self.ts + 30)
        self.assertEqual(probe["stale"], [])
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_landing_against_a_moved_base_is_refused(self):
        got = self.acquire()
        with self.assertRaisesRegex(reservations.ReservationError, "stale"):
            reservations.execute(self.doc, "agent-a", {
                "action": "land", "reservation": got["reservation"]["id"],
                "candidate": BRANCH, "base": MOVED},
                item_reader=self.visible, now_ts=self.ts + 5)

    def test_landing_against_the_recorded_base_records_a_receipt(self):
        got = self.acquire()
        landed = reservations.execute(self.doc, "agent-a", {
            "action": "land", "reservation": got["reservation"]["id"]},
            item_reader=self.visible, now_ts=self.ts + 5)
        self.assertTrue(landed["landed"])
        self.assertTrue(landed["integration_receipt"])
        self.assertEqual(self.doc["reservations"][0]["state"], "landed")


class StrandedLeaseTests(unittest.TestCase):
    """A lease nobody can release is worse than no lease.

    Two independent ways for a holder to have stopped — its lease ran out, or
    it is no longer a live agent — and a quiet heartbeat required in both, so
    no live agent is ever interrupted mid-push on a judgement call.
    """

    def setUp(self):
        self.doc = {}
        self.ts = 1000.0
        self.reads_nothing = lambda item: False
        self.retired = lambda node: node != "agent-a"

    def acquire(self, actor="agent-a", live=None, **extra):
        args = {"action": "acquire", "resource": "main",
                "candidate": BRANCH, "base": MAIN, "lease_s": 900,
                "stale_s": 300}
        args.update(extra)
        # The holder can read its own ticket; the contender below cannot.
        return reservations.execute(
            self.doc, actor, args,
            item_reader=lambda item: item == f"{actor}-ticket",
            node_exists=live or (lambda node: True), now_ts=self.ts)

    def test_a_retired_holder_does_not_strand_the_slot(self):
        got = self.acquire()
        rid = got["reservation"]["id"]
        # Well inside the 900s lease, but the holder is gone and has been
        # quiet longer than its 300s heartbeat threshold.
        recovered = reservations.execute(
            self.doc, "agent-b", {"action": "recover", "reservation": rid},
            item_reader=self.reads_nothing, node_exists=self.retired,
            now_ts=self.ts + 400)
        self.assertTrue(recovered["recovered"])
        self.assertEqual(self.doc["reservations"][0]["recovered_reason"],
                         "owner_not_live")
        self.assertEqual(self.doc["reservations"][0]["recovered_by"], "agent-b")

    def test_recovering_a_stranger_reservation_discloses_no_private_work(self):
        got = self.acquire(paths=["engine/backend/orgtree/ledger.py"],
                           item="agent-a-ticket")
        recovered = reservations.execute(
            self.doc, "agent-b",
            {"action": "recover", "reservation": got["reservation"]["id"]},
            item_reader=self.reads_nothing, node_exists=self.retired,
            now_ts=self.ts + 400)
        self.assertEqual(recovered["reservation"]["view"], "contention")
        self.assertNotIn("paths", recovered["reservation"])

    def test_acquiring_over_a_retired_holder_works_in_one_step(self):
        # A contender should not have to recover and then acquire; taking the
        # slot is one call, which is what keeps this out of anyone's mailbox.
        self.acquire()
        got = reservations.execute(self.doc, "agent-b", {
            "action": "acquire", "resource": "main", "candidate": "4" * 40,
            "base": MAIN}, item_reader=self.reads_nothing,
            node_exists=self.retired, now_ts=self.ts + 400)
        self.assertEqual(got["reservation"]["owner"], "agent-b")
        # The dead row ends terminal either way.  A contender landing its own
        # branch carries a different candidate, so the grant is retired as
        # `stale` (its scope no longer matches) rather than `recovered`; what
        # matters for the slot is that it is no longer held.
        self.assertNotIn(self.doc["reservations"][0]["state"],
                         (reservations.HELD,))
        self.assertIn(self.doc["reservations"][0]["state"],
                      reservations.TERMINAL)

    def test_acquiring_over_a_retired_holder_of_the_same_scope_recovers_it(self):
        self.acquire()
        reservations.execute(self.doc, "agent-b", {
            "action": "acquire", "resource": "main", "candidate": BRANCH,
            "base": MAIN}, item_reader=self.reads_nothing,
            node_exists=self.retired, now_ts=self.ts + 400)
        self.assertEqual(self.doc["reservations"][0]["state"], "recovered")
        self.assertEqual(self.doc["reservations"][0]["recovered_reason"],
                         "owner_not_live")

    def test_a_retired_holder_that_is_still_heartbeating_is_not_taken(self):
        # Retirement interrupts a running turn, but a tool call already in
        # flight can still finish and touch disk.  A recent heartbeat means
        # something may still be pushing, so the slot holds.
        got = self.acquire()
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "heartbeat is active"):
            reservations.execute(
                self.doc, "agent-b",
                {"action": "recover", "reservation": got["reservation"]["id"]},
                item_reader=self.reads_nothing, node_exists=self.retired,
                now_ts=self.ts + 100)
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_a_live_holder_keeps_its_slot_for_the_whole_lease(self):
        # No agent may decide that a live peer looks stuck.  Quiet or not, a
        # live holder inside its lease is not recoverable.
        got = self.acquire()
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "still leased"):
            reservations.execute(
                self.doc, "agent-b",
                {"action": "recover", "reservation": got["reservation"]["id"]},
                item_reader=self.reads_nothing, node_exists=lambda n: True,
                now_ts=self.ts + 400)
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_an_expired_and_quiet_lease_is_recoverable_even_if_live(self):
        got = self.acquire(lease_s=60, stale_s=30)
        recovered = reservations.execute(
            self.doc, "agent-b",
            {"action": "recover", "reservation": got["reservation"]["id"]},
            item_reader=self.reads_nothing, node_exists=lambda n: True,
            now_ts=self.ts + 120)
        self.assertTrue(recovered["recovered"])
        self.assertEqual(self.doc["reservations"][0]["recovered_reason"],
                         "lease_expired")

    def test_renewing_holds_the_slot_across_a_long_landing(self):
        got = self.acquire(lease_s=60, stale_s=30)
        rid = got["reservation"]["id"]
        reservations.execute(self.doc, "agent-a", {
            "action": "renew", "reservation": rid, "lease_s": 60},
            item_reader=self.reads_nothing, now_ts=self.ts + 50)
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "still leased"):
            reservations.execute(
                self.doc, "agent-b", {"action": "recover", "reservation": rid},
                item_reader=self.reads_nothing, node_exists=lambda n: True,
                now_ts=self.ts + 90)

    def test_an_unknown_liveness_oracle_never_authorizes_a_takeover(self):
        # Absence of proof that a holder is gone is not proof that it is gone.
        got = self.acquire()
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "still leased"):
            reservations.execute(
                self.doc, "agent-b",
                {"action": "recover", "reservation": got["reservation"]["id"]},
                item_reader=self.reads_nothing, node_exists=None,
                now_ts=self.ts + 400)


if __name__ == "__main__":
    unittest.main()
