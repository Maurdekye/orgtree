"""Focused coverage for release routing, handoff requests, and reassignment."""

import os
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="orgtree-next-action-routing-")
os.environ["ORGTREE_DATA"] = _data.name

from engine.backend.orgtree import ledger, supervisor  # noqa: E402


class NextActionRoutingTests(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create("next-action-routing")
        self.manager = self.org.hire(ledger.USER, None, "haiku", 0,
                                     "manager")["node"]
        self.worker = self.org.hire(ledger.USER, self.manager, "haiku", 0,
                                    "worker")["node"]
        self.item = self.org.work_create(
            self.worker, "Release", "implementation is complete",
            owner=self.worker)
        self.org.work_update(self.worker, self.item["slug"], ["built"],
                             ["publish"], status="deploy_ready")

    def test_deploy_ready_routes_next_action_without_transferring_owner(self):
        self.assertEqual(
            self.org._work_next_recipient(self.org._work_active()[0]),
            (self.manager, "deployer"))
        served = self.org.work_get(self.worker, self.item["slug"])
        self.assertEqual(served["owner"]["node"], self.worker)
        self.assertEqual(served["next_action"],
                         {"node": self.manager, "role": "deployer"})
        self.assertEqual(self.org.work_idle_reminder_items(self.worker), [])
        self.assertEqual(self.org.work_idle_reminder_items(self.manager)[0]["role"],
                         "deployer")

    def test_owner_handoff_is_a_request_and_only_targets_immediate_superior(self):
        result = self.org.work_request_handoff(self.worker, self.item["slug"],
                                               reason="cannot publish here")
        self.assertEqual(result["target"], self.manager)
        self.assertEqual(self.org._work_active()[0]["owner"]["node"], self.worker)
        with self.assertRaises(ledger.LedgerError):
            self.org.work_request_handoff(self.worker, self.item["slug"],
                                          target=ledger.USER)
        with self.assertRaises(ledger.LedgerError):
            self.org.work_request_handoff(self.manager, self.item["slug"])

    def test_reassignment_notifies_reachable_former_owner(self):
        other = self.org.hire(ledger.USER, None, "haiku", 0, "other")["node"]
        result = self.org.work_assign(ledger.USER, self.item["slug"], other)
        self.assertEqual(result["previous_owner_notified"], self.worker)
        notices = self.org.d.get("mail", {}).get(self.worker, [])
        self.assertTrue(any(m.get("kind") == "notice" and
                            "DOCKET REASSIGNMENT" in m.get("body", "")
                            for m in notices))

    def test_account_park_is_durable_gate_and_unpark_restores_admission(self):
        node = self.org.node(self.worker)
        self.assertTrue(supervisor._auto_wake_gates_clear(self.org, self.worker))
        node["frozen"] = {"cause": "account", "limit": True,
                           "account": "missing:claude"}
        self.assertFalse(supervisor._auto_wake_gates_clear(self.org, self.worker))
        node.pop("frozen")
        self.assertTrue(supervisor._auto_wake_gates_clear(self.org, self.worker))


if __name__ == "__main__":
    unittest.main()
