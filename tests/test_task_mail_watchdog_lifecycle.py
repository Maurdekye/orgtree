"""Focused lifecycle identity and explicit-wait cancellation checks."""

from pathlib import Path
import os
import tempfile
import unittest

_tmp = tempfile.TemporaryDirectory(prefix="v2-task-mail-lifecycle-")
_data = Path(_tmp.name) / "data"
_home = Path(_tmp.name) / "home"
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home))
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

from orgtree import lifecycle, store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402


class TaskMailWatchdogLifecycleTests(unittest.TestCase):
    slug = "task-mail-lifecycle"

    @classmethod
    def setUpClass(cls):
        cls.org = store.create_org(cls.slug)
        cls.org.hire(USER, None, "haiku", 0, "agent", charter="fixture")

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all(cls.slug)

    def test_mail_has_stable_identity_and_durable_acceptance(self):
        row = self.org.post_mail(USER, "agent", "hello")
        pending = self.org.d["mail"]["agent"][-1]
        self.assertEqual(pending["message_id"], row["id"])
        self.assertEqual(pending["operation_id"], row["operation_id"])
        self.assertEqual(lifecycle.latest(self.org.d, row["operation_id"])["state"],
                         "accepted")
        store.save_org(self.org)
        reopened = store.load_org(self.slug)
        self.assertEqual(lifecycle.latest(reopened.d, row["operation_id"])["message_id"],
                         row["id"])

        user_row_result = self.org.post_mail("agent", USER, "operator notice")
        user_row = self.org.d["user_inbox"][-1]
        self.assertEqual(user_row["message_id"], user_row["id"])
        self.assertEqual(user_row["operation_id"], user_row_result["operation_id"])
        self.assertEqual(user_row_result["delivered"], "user_inbox")
        self.assertEqual(
            lifecycle.latest(self.org.d, user_row_result["operation_id"])["delivery"],
            "user_inbox")

    def test_supersede_requires_reason_and_survives_as_inert_tombstone(self):
        dog = self.org.watchdog_create("agent", "obsolete", "process",
                                       "pid:999999", once=True)
        with self.assertRaisesRegex(Exception, "requires a reason"):
            self.org.watchdog_action("agent", dog["id"], "supersede")
        result = self.org.watchdog_action(
            "agent", dog["id"], "supersede", "replacement wait owns this condition")
        self.assertEqual(result["state"], "superseded")
        self.assertFalse(self.org.d["watchdogs"])
        tomb = self.org.d["watchdog_tombs"][-1]
        self.assertEqual(tomb["state"], "superseded")
        self.assertEqual(tomb["reason"], "replacement wait owns this condition")
        op = lifecycle.identity("watchdog", dog["id"])
        self.assertEqual(lifecycle.latest(self.org.d, op)["state"], "superseded")

    def test_identical_delay_states_coalesce_but_boundaries_remain_fields(self):
        doc = {}
        lifecycle.record(doc, operation_id="delivery:x", kind="delivery",
                         state="delay_reported", at="t1", waited="45s",
                         boundary_for="2s", observed=True)
        lifecycle.record(doc, operation_id="delivery:x", kind="delivery",
                         state="delay_reported", at="t2", waited="50s",
                         boundary_for="7s", observed=True)
        row = lifecycle.latest(doc, "delivery:x")
        self.assertEqual(len(doc["lifecycle"]), 1)
        self.assertEqual(row["count"], 2)
        self.assertEqual(row["last_at"], "t2")
        self.assertEqual(row["boundary_for"], "7s")


if __name__ == "__main__":
    unittest.main()
