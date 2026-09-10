import os
import tempfile
import time
import unittest
from unittest import mock


class AbandonedDocketRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-abandoned-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger
        from engine.backend.orgtree import store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger

    def _org(self, name="test-org"):
        org = self.ledger.Org.create(name)
        org.nodes["root"] = {"state": "live", "parent": None, "generation": 1}
        org.nodes["aaa"] = {"state": "live", "parent": None, "generation": 1}
        org.nodes["old"] = {"state": "archived", "parent": "root", "generation": 1}
        return org, "root", "old"

    def _item(self, org, owner, status="open"):
        item = org.work_create("root", "Ticket", "test", owner="root")
        item = org._work_active()[0]
        item["owner"] = {"node": owner, "generation": 1}
        item["docket_at"] = "1970-01-01T00:16:40Z"
        item["updated_at"] = item["docket_at"]
        item["status"] = status
        return item
    def test_strict_boundary_and_terminal_controls(self):
        org, root, old = self._org()
        item = self._item(org, old)
        self.assertEqual(org.work_reassign_abandoned(now_ts=2800.0), [])
        moved = org.work_reassign_abandoned(now_ts=2800.001)
        self.assertEqual([row["owner"]["node"] for row in moved], ["aaa"])
        terminal, terminal_root, terminal_old = self._org()
        self._item(terminal, terminal_old, status="done")
        self.assertEqual(terminal.work_reassign_abandoned(now_ts=100000), [])

    def test_recent_update_and_missing_generation_status_controls(self):
        org, root, old = self._org()
        item = self._item(org, old)
        item["updated_at"] = "1970-01-01T00:43:20Z"
        self.assertEqual(org.work_reassign_abandoned(now_ts=3000.0), [])
        item["owner"] = {"node": "missing", "generation": 1}
        self.assertEqual(org.work_reassign_abandoned(now_ts=100000)[0]["owner"]["node"], "aaa")
        org, root, old = self._org()
        item = self._item(org, root)
        item["owner"] = {"node": root, "generation": 999}
        for status in ("blocked", "backlogged"):
            item["status"] = status
            item["updated_at"] = "1970-01-01T00:16:40Z"
            self.assertEqual(org.work_reassign_abandoned(now_ts=100000)[0]["owner"]["node"], "aaa")
            item["owner"] = {"node": root, "generation": 999}

    def test_current_owner_and_no_top_level_are_untouched(self):
        org, root, old = self._org()
        item = self._item(org, old)
        item["owner"] = {"node": root, "generation": org.nodes[root]["generation"]}
        self.assertEqual(org.work_reassign_abandoned(now_ts=100000), [])
        org.nodes["root"]["state"] = "archived"
        org.nodes["aaa"]["state"] = "archived"
        self.assertEqual(org.work_reassign_abandoned(now_ts=100000), [])

    def test_recovery_pass_is_durable_and_does_not_repeat(self):
        from engine.backend.orgtree import store, supervisor
        org, root, old = self._org()
        self._item(org, old)
        store.save_org(org)
        def compose(slug, nid, text, **kwargs):
            return supervisor._ping_drive(store.load_org(slug), nid, text,
                                          kwargs.get("ping_reason"))
        with mock.patch.object(supervisor, "mail_spark"), mock.patch.object(
                supervisor, "send_message", side_effect=compose) as wake:
            supervisor._abandoned_docket_recovery_pass(now=100000)
            supervisor._abandoned_docket_recovery_pass(now=100000)
        saved = store.load_org("test-org")
        saved_item = saved._work_active()[0]
        self.assertEqual(saved_item["owner"]["node"], "aaa")
        self.assertTrue(any(h["op"] == "assign" for h in saved_item["history"]))
        self.assertIn("aaa", str(saved.d.get("mail")))
        self.assertIn("docket.assigned", str(saved.d.get("mail")))
        wake.assert_called_once()


    def test_failed_reassignment_stage_does_not_skip_reminders(self):
        from engine.backend.orgtree import supervisor
        with mock.patch.object(supervisor, "_abandoned_docket_recovery_pass",
                               side_effect=RuntimeError("injected wake failure")), \
                mock.patch.object(supervisor, "_idle_docket_reminder_pass") as reminder, \
                mock.patch.object(supervisor, "_working_lifecycle_keeper_pass") as checkup:
            supervisor._auto_wake_keeper_pass(now=100000)
        reminder.assert_called_once_with(now=100000)
        checkup.assert_called_once_with(now=100000)

    def test_failed_reminder_stage_does_not_skip_working_checkups(self):
        from engine.backend.orgtree import supervisor
        with mock.patch.object(supervisor, "_abandoned_docket_recovery_pass"), \
                mock.patch.object(supervisor, "_idle_docket_reminder_pass",
                                  side_effect=RuntimeError("injected reminder failure")), \
                mock.patch.object(supervisor, "_working_lifecycle_keeper_pass") as checkup:
            supervisor._auto_wake_keeper_pass(now=100000)
        checkup.assert_called_once_with(now=100000)


if __name__ == "__main__":
    unittest.main()
