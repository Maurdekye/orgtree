"""Focused W09 tests; no live org or filesystem data is read."""

import unittest

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


if __name__ == "__main__":
    unittest.main()
