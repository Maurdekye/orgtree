import os
import tempfile
import unittest


class ClosedTicketArchivalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-closed-archive-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger

    def _org(self):
        org = self.ledger.Org.create("closed-archive")
        org.nodes["root"] = {"state": "live", "parent": None, "generation": 1}
        item = org.work_create("root", "Ticket", "test", owner="root")
        return org, org._work_active()[0]

    def test_superseded_strict_one_hour_boundary_and_existing_link(self):
        org, item = self._org()
        item["status"] = "superseded"
        item["superseded_by"] = "replacement"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        self.assertFalse(org._work_archived(item, False, 3600.0))
        self.assertTrue(org._work_archived(item, False, 3600.001))
        moved = org._work_sweep(now_ts=3600.001)
        self.assertEqual(moved, [item["slug"]])
        archived = org.d["work_items_archive"][0]
        self.assertEqual(archived["status"], "superseded")
        self.assertEqual(archived["superseded_by"], "replacement")

    def test_closed_attention_archives_without_erasing_attention(self):
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        item["manual_attention"] = True
        self.assertTrue(org._work_archived(item, False, 3600.001))
        org._work_sweep(now_ts=3600.001)
        archived = org.d["work_items_archive"][0]
        self.assertTrue(archived["manual_attention"])
        self.assertEqual(archived["status"], "done")

    def test_dropped_attention_is_immediate_and_open_is_not(self):
        org, dropped = self._org()
        dropped["status"] = "dropped"
        dropped["manual_attention"] = True
        self.assertTrue(org._work_archived(dropped, False, 0.0))
        org._work_sweep(now_ts=0.0)
        org2, open_item = self._org()
        open_item["docket_at"] = "1970-01-01T00:00:00Z"
        self.assertFalse(org2._work_archived(open_item, False, 100000.0))


if __name__ == "__main__":
    unittest.main()
