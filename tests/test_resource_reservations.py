"""Focused W09 tests; no live org or filesystem data is read."""

import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import reservations


class ResourceReservationTests(unittest.TestCase):
    candidate = "a" * 40
    base = "b" * 40

    def setUp(self):
        self.doc = {}
        self.visible = lambda item: item == "work-item"
        self.live = lambda node: node in {"owner", "successor"}
        self.ts = 1000.0

    def acquire(self, **extra):
        args = {"action": "acquire", "resource": "main", "item": "work-item",
                "candidate": self.candidate, "base": self.base,
                "paths": ["engine/api.py"], "integration_key": "mail-1"}
        args.update(extra)
        return reservations.execute(self.doc, "owner", args,
                                    item_reader=self.visible,
                                    node_exists=self.live, now_ts=self.ts)

    def test_acquisition_is_idempotent_and_conflicting_owner_is_refused(self):
        first = self.acquire()
        replay = self.acquire()
        self.assertTrue(replay["replayed"])
        self.assertEqual(first["reservation"]["id"], replay["reservation"]["id"])
        with self.assertRaisesRegex(reservations.ReservationError, "active operation"):
            reservations.execute(self.doc, "other", {
                "action": "acquire", "resource": "main", "item": "work-item",
                "candidate": self.candidate, "base": self.base},
                item_reader=self.visible, node_exists=self.live, now_ts=self.ts)

    def test_expired_lease_with_recent_heartbeat_cannot_be_stolen(self):
        got = self.acquire(lease_s=1, stale_s=30)
        rid = got["reservation"]["id"]
        with self.assertRaisesRegex(reservations.ReservationError, "heartbeat is active"):
            reservations.execute(self.doc, "other", {"action": "recover",
                "reservation": rid}, item_reader=self.visible,
                node_exists=self.live, now_ts=self.ts + 2)
        recovered = reservations.execute(self.doc, "other", {"action": "recover",
            "reservation": rid, "stale_s": 1}, item_reader=self.visible,
            node_exists=self.live, now_ts=self.ts + 40)
        self.assertTrue(recovered["recovered"])

    def test_recovery_cannot_lower_recorded_stale_threshold(self):
        got = self.acquire(lease_s=1, stale_s=30)
        with self.assertRaisesRegex(reservations.ReservationError, "heartbeat is active"):
            reservations.execute(self.doc, "other", {
                "action": "recover", "reservation": got["reservation"]["id"],
                "stale_s": 1}, item_reader=self.visible,
                node_exists=self.live, now_ts=self.ts + 2)
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_changed_candidate_marks_old_grant_stale(self):
        self.acquire(lease_s=1, stale_s=1)
        new = "c" * 40
        got = reservations.execute(self.doc, "new-owner", {
            "action": "acquire", "resource": "main", "item": "work-item",
            "candidate": new, "base": self.base}, item_reader=self.visible,
            node_exists=self.live, now_ts=self.ts + 10)
        self.assertEqual(got["reservation"]["candidate"], new)
        self.assertEqual(self.doc["reservations"][0]["state"], "stale")

    def test_changed_candidate_cannot_steal_live_operation(self):
        self.acquire(lease_s=1, stale_s=30)
        with self.assertRaisesRegex(reservations.ReservationError, "active operation"):
            reservations.execute(self.doc, "new-owner", {
                "action": "acquire", "resource": "main", "item": "work-item",
                "candidate": "c" * 40, "base": self.base},
                item_reader=self.visible, node_exists=self.live, now_ts=self.ts + 2)
        self.assertEqual(self.doc["reservations"][0]["state"], "held")

    def test_list_scope_probe_cannot_stale_live_operation(self):
        self.acquire(lease_s=1, stale_s=30)
        got = reservations.execute(self.doc, "owner", {
            "action": "list", "resource": "main",
            "candidate": "c" * 40, "base": self.base},
            item_reader=self.visible, now_ts=self.ts + 2)
        self.assertEqual(got["stale"], [])
        self.assertEqual(got["reservations"][0]["state"], "held")

    def test_declared_paths_overlap_without_reading_files(self):
        self.acquire()
        got = reservations.execute(self.doc, "owner", {
            "action": "overlap", "item": "work-item",
            "paths": ["engine/api.py", "other.py"]},
            item_reader=self.visible, now_ts=self.ts)
        self.assertEqual(got["count"], 1)
        self.assertEqual(got["overlaps"][0]["overlap"], ["engine/api.py"])

    def test_release_records_receipt_and_one_successor(self):
        got = self.acquire()
        released = reservations.execute(self.doc, "owner", {
            "action": "release", "reservation": got["reservation"]["id"],
            "successor": "successor"}, item_reader=self.visible,
            node_exists=self.live,
            successor_allowed=lambda node, item: node == "successor" and item == "work-item",
            now_ts=self.ts + 1)
        self.assertTrue(released["release_receipt"])
        self.assertEqual(released["notified"], "successor")
        self.assertEqual(self.doc["reservations"][0]["state"], "released")

    def test_landing_is_idempotent_by_integration_key(self):
        got = self.acquire()
        land = reservations.execute(self.doc, "owner", {
            "action": "land", "reservation": got["reservation"]["id"]},
            item_reader=self.visible, now_ts=self.ts + 1)
        replay = reservations.execute(self.doc, "owner", {
            "action": "land", "reservation": got["reservation"]["id"]},
            item_reader=self.visible, now_ts=self.ts + 2)
        self.assertTrue(land["landed"])
        self.assertTrue(replay["replayed"])

    # ---- the 512 cap counts HELD reservations only (user ruling D1) and
    # list/landing answers stop at 512 rows (user ruling D2)

    CAP = reservations.MAX_RESERVATIONS

    def call(self, actor, **args):
        return reservations.execute(self.doc, actor, args,
                                    item_reader=self.visible,
                                    node_exists=self.live, now_ts=self.ts)

    def hold(self, n, prefix="r"):
        return [self.acquire(resource=f"{prefix}{i}", integration_key=None)
                ["reservation"]["id"] for i in range(n)]

    def test_more_than_512_lifetime_reservations_still_acquire(self):
        for i in range(self.CAP + 88):
            rid = self.acquire(resource=f"r{i}", integration_key=f"k{i}")
            self.assertFalse(rid["replayed"])
            self.call("owner", action="release",
                      reservation=rid["reservation"]["id"])
        got = self.acquire(resource="one-more", integration_key="k-last")
        self.assertEqual(got["reservation"]["state"], "held")
        self.assertEqual(len(self.doc["reservations"]), self.CAP + 89)

    def test_512_held_reservations_refuse_the_next_until_one_is_released(self):
        ids = self.hold(self.CAP)
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "already holds the maximum of 512 active"):
            self.acquire(resource="over", integration_key=None)
        self.assertEqual(len(self.doc["reservations"]), self.CAP)
        self.call("owner", action="release", reservation=ids[0])
        self.assertEqual(self.acquire(resource="over", integration_key=None)
                         ["reservation"]["state"], "held")

    def test_a_same_owner_replay_at_the_cap_is_still_a_replay(self):
        ids = self.hold(self.CAP)
        again = self.acquire(resource="r7", integration_key=None)
        self.assertTrue(again["replayed"])
        self.assertEqual(again["reservation"]["id"], ids[7])

    def test_recovering_a_stopped_holder_at_the_cap_frees_its_slot(self):
        self.acquire(resource="r0", integration_key=None, lease_s=1, stale_s=1)
        self.hold(self.CAP - 1, prefix="s")
        self.ts += 10
        got = reservations.execute(self.doc, "successor", {
            "action": "acquire", "resource": "r0", "item": "work-item",
            "candidate": self.candidate, "base": self.base},
            item_reader=self.visible, node_exists=self.live, now_ts=self.ts)
        self.assertEqual(got["reservation"]["owner"], "successor")
        self.assertEqual(self.doc["reservations"][0]["state"], "recovered")
        self.assertEqual(sum(r["state"] == "held"
                             for r in self.doc["reservations"]), self.CAP)

    def test_a_reused_integration_key_replays_or_refuses_as_before(self):
        first = self.acquire(resource="r0", integration_key="keep")
        self.call("owner", action="release",
                  reservation=first["reservation"]["id"])
        for i in range(self.CAP + 10):
            rid = self.acquire(resource=f"x{i}", integration_key=None)
            self.call("owner", action="release",
                      reservation=rid["reservation"]["id"])
        self.hold(self.CAP, prefix="h")
        # the key's row is finished and far behind 512 newer rows, and the
        # org is at the cap: the keyed replay still finds it
        replay = self.acquire(resource="r0", integration_key="keep")
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["reservation"]["id"], first["reservation"]["id"])
        with self.assertRaisesRegex(reservations.ReservationError,
                                    "integration_key already identifies"):
            self.acquire(resource="elsewhere", integration_key="keep")

    def test_list_below_the_cap_is_unchanged(self):
        self.hold(self.CAP)
        got = self.call("owner", action="list")
        self.assertEqual(set(got), {"reservations", "count", "stale"})
        self.assertEqual(got["count"], self.CAP)

    def test_list_drops_the_oldest_finished_rows_first(self):
        released = []
        for i in range(400):
            rid = self.acquire(resource=f"old{i}", integration_key=None)
            self.call("owner", action="release",
                      reservation=rid["reservation"]["id"])
            released.append(rid["reservation"]["id"])
        held = self.hold(200)
        rows = self.call("owner", action="list")
        self.assertEqual(rows["count"], self.CAP)
        self.assertTrue(rows["truncated"])
        self.assertEqual(rows["omitted"], 88)
        got = [r["id"] for r in rows["reservations"]]
        # every held claim, the newest history, and storage order kept
        self.assertEqual(got, released[88:] + held)

    def test_list_keeps_every_held_row_even_the_oldest(self):
        # the held claims are the OLDEST rows here, so dropping by age alone
        # would drop them first; D2 says every held row survives
        held = self.hold(200)
        released = []
        for i in range(400):
            rid = self.acquire(resource=f"new{i}", integration_key=None)
            self.call("owner", action="release",
                      reservation=rid["reservation"]["id"])
            released.append(rid["reservation"]["id"])
        rows = self.call("owner", action="list")
        self.assertEqual((rows["count"], rows["omitted"]), (self.CAP, 88))
        got = [r["id"] for r in rows["reservations"]]
        self.assertEqual(got, held + released[88:])

    def test_landing_answers_stop_at_512_newest_landings(self):
        landed = []
        for i in range(self.CAP + 5):
            rid = self.acquire(resource=f"l{i}", integration_key=None)
            self.call("owner", action="land",
                      reservation=rid["reservation"]["id"])
            landed.append(rid["reservation"]["id"])
        got = self.call("owner", action="landing", item="work-item")
        self.assertEqual(got["count"], self.CAP)
        self.assertEqual((got["truncated"], got["omitted"]), (True, 5))
        self.assertEqual([r["id"] for r in got["landed"]], landed[5:])
        # and exactly today's answer when nothing is left out
        self.doc["reservations"] = self.doc["reservations"][5:]
        got = self.call("owner", action="landing", item="work-item")
        self.assertEqual(set(got), {"landed", "count"})
        self.assertEqual(got["count"], self.CAP)


if __name__ == "__main__":
    unittest.main()
