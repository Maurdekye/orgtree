"""Quick staff uses the real staffing transaction against isolated storage."""
import copy
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="quick-staff-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="quick-staff-tests")
from engine.launch import load_app
app, *_ = load_app()
from fastapi.testclient import TestClient
from orgtree import api, appsettings, ledger, quickstaff, store

HEADERS = {"X-Orgtree-Desktop-Token": "quick-staff-tests"}


class QuickStaffTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.org = ledger.Org.create("quick-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"] = {"haiku": 1, "luna": .2}
        self.owner = self.org.hire(ledger.USER, None, "haiku", 2, "manager",
            add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                               "subagents": False, "mcp": []}, org_visibility="self")["node"]
        self.item = self.org.work_create(self.owner, "Repair the widget", "The widget is broken. Repair it.",
            status="backlogged", done_so_far=["Described the defect."], working_on_next=["Implement it."])["slug"]
        store.save_org(self.org)
        self.path = f"/api/orgs/{self.org.d['slug']}/work-items/{self.item}/quick-staff"
        for target, kwargs in [
            ("provider_hire_gate", {"return_value": None}),
            ("hub_changed", {"return_value": None}),
            ("mail_notify", {"return_value": None}),
        ]:
            p = patch.object(api, target, **kwargs); p.start(); self.addCleanup(p.stop)
        p = patch.object(api.supervisor, "send_message", return_value={})
        self.drive = p.start(); self.addCleanup(p.stop)
        for target, value in [("account_reason", None), ("supported_efforts", ["low", "high"])]:
            p = patch.object(quickstaff, target, return_value=value); p.start(); self.addCleanup(p.stop)
        appsettings.set_quick_staff_behavior("request")

    def preview(self):
        r = self.client.get(self.path, headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def selection(self, tier=None, effort=None):
        p = self.preview()
        return {k: p[k] for k in ("mode", "configured_mode", "owner")} | {
            "request_id": str(uuid.uuid4()), **({"tier": tier} if tier else {}),
            **({"effort": effort} if effort else {})}

    def send(self, body):
        return self.client.post(self.path, headers=HEADERS, json=body)

    def loaded(self):
        return store.load_org(self.org.d["slug"])

    def test_request_selection_depths_and_atomic_open(self):
        for tier, effort in [(None, None), ("haiku", None), ("haiku", "high")]:
            with self.subTest(tier=tier, effort=effort):
                store.save_org(self.org)
                r = self.send(self.selection(tier, effort))
                self.assertEqual(r.status_code, 200, r.text)
                current = self.loaded()
                self.assertEqual(len(current.nodes), 1)
                item = current._work_find(self.item)[0]
                self.assertEqual(item["status"], "open")
                self.assertEqual(item["owner"]["node"], self.owner)
                receipt = next(iter(item["quick_staff_receipts"].values()))
                # Check the actual authored mail, not only the response.
                all_text = str(current.d)
                self.assertEqual("Suggested model:" in all_text, tier is not None)
                self.assertEqual("Suggested effort:" in all_text, effort is not None)
                self.assertEqual(receipt["result"]["requested_from"], self.owner)

    def test_immediate_modes_and_effort_omission(self):
        for mode in ("under_assignee", "top_level"):
            for effort in (None, "high"):
                with self.subTest(mode=mode, effort=effort):
                    store.save_org(self.org); appsettings.set_quick_staff_behavior(mode)
                    r = self.send(self.selection("haiku", effort))
                    self.assertEqual(r.status_code, 200, r.text)
                    current = self.loaded(); node = current.node(r.json()["node"])
                    self.assertEqual(node["parent"], self.owner if mode == "under_assignee" else None)
                    self.assertEqual(r.json()["node"], "repair-the-widget")
                    self.assertEqual(node["scope"]["tools"], current.node(self.owner)["scope"]["tools"])
                    self.assertEqual(node["scope"].get("effort") or None, effort)
                    item = current._work_find(self.item)[0]
                    self.assertEqual(item["owner"]["node"], r.json()["node"])
                    self.assertEqual(item["status"], "open")

    def test_missing_and_retired_fallback_disclosed_before_selection(self):
        for mode in ("request", "under_assignee"):
            for missing in (False, True):
                with self.subTest(mode=mode, missing=missing):
                    org = ledger.Org(copy.deepcopy(self.org.d))
                    if missing: del org.nodes[self.owner]
                    else: org.nodes[self.owner]["state"] = "archived"
                    store.save_org(org); appsettings.set_quick_staff_behavior(mode)
                    preview = self.preview()
                    self.assertTrue(preview["fallback"])
                    self.assertIn("Assignee unavailable", preview["disclosure"])
                    self.assertIn("immediately at top level", preview["disclosure"])
                    self.assertEqual(self.send(self.selection()).status_code, 422)
                    r = self.send(self.selection("haiku"))
                    self.assertEqual(r.status_code, 200, r.text)
                    self.assertIsNone(self.loaded().node(r.json()["node"])["parent"])

    def test_model_required_and_unsupported_effort_refused_without_changes(self):
        for mode in ("under_assignee", "top_level"):
            appsettings.set_quick_staff_behavior(mode)
            self.assertEqual(self.send(self.selection()).status_code, 422)
        self.assertEqual(self.send(self.selection("haiku", "bogus")).status_code, 422)
        self.assertEqual(len(self.loaded().nodes), 1)
        self.assertEqual(self.loaded()._work_find(self.item)[0]["status"], "backlogged")

    def test_retry_receipt_survives_reload_and_only_one_drive(self):
        appsettings.set_quick_staff_behavior("top_level")
        body = self.selection("haiku")
        first = self.send(body); second = self.send(body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["node"], second.json()["node"])
        self.assertTrue(second.json()["replayed"])
        self.assertEqual(len(self.loaded().nodes), 2)
        self.assertEqual(self.drive.call_count, 1)
        self.assertEqual(self.send(body | {"tier": "luna"}).status_code, 422)

    def test_assignee_or_setting_change_requires_a_new_visible_preview(self):
        body = self.selection("haiku")
        appsettings.set_quick_staff_behavior("top_level")
        self.assertEqual(self.send(body).status_code, 422)
        appsettings.set_quick_staff_behavior("request")
        self.org.nodes[self.owner]["state"] = "archived"; store.save_org(self.org)
        self.assertEqual(self.send(body).status_code, 422)
        self.assertEqual(len(self.loaded().nodes), 1)

    def test_failure_does_not_save_agent_status_or_receipt(self):
        appsettings.set_quick_staff_behavior("top_level")
        body = self.selection("haiku")
        with patch.object(api, "_staff_call", side_effect=ledger.LedgerError("Not enough credits")):
            r = self.send(body)
        self.assertEqual(r.status_code, 422)
        self.assertIn("credits", r.text)
        self.assertEqual(len(self.loaded().nodes), 1)
        self.assertNotIn("quick_staff_receipts", self.loaded()._work_find(self.item)[0])
        self.assertEqual(self.send(body).status_code, 200)

    def test_provider_failure_is_visible_and_revalidated(self):
        with patch.object(api, "provider_hire_gate", side_effect=ledger.LedgerError("Sign in to the provider")):
            p = self.preview()
            self.assertIn("Sign in", p["models"][0]["reason"])
            self.assertEqual(self.send(self.selection("haiku")).status_code, 422)

    def test_credit_and_permission_failures_are_visible_in_the_preview(self):
        appsettings.set_quick_staff_behavior("top_level")
        self.org.d["max_top_grant"] = 1
        store.save_org(self.org)
        p = self.preview()
        self.assertTrue(all(m["reason"] for m in p["models"]))
        self.assertEqual(self.send(self.selection("haiku")).status_code, 422)
        self.org.d["max_top_grant"] = 1000
        self.org.d["max_depth"] = 1
        store.save_org(self.org); appsettings.set_quick_staff_behavior("under_assignee")
        p = self.preview()
        self.assertIn("depth", p["models"][0]["reason"])
        self.assertEqual(len(self.loaded().nodes), 1)

    def test_late_assignment_or_mail_failure_rolls_back_every_change(self):
        appsettings.set_quick_staff_behavior("top_level")
        body = self.selection("haiku")
        with patch.object(ledger.Org, "work_update", side_effect=ledger.LedgerError("assignment failed")):
            self.assertEqual(self.send(body).status_code, 422)
        appsettings.set_quick_staff_behavior("request"); body = self.selection()
        original = ledger.Org.post_mail
        def fail_request(org, sender, to, text, *args, **kwargs):
            if kwargs.get("typed"): raise ledger.LedgerError("mail failed")
            return original(org, sender, to, text, *args, **kwargs)
        with patch.object(ledger.Org, "post_mail", fail_request):
            self.assertEqual(self.send(body).status_code, 422)
        current = self.loaded()
        self.assertEqual(len(current.nodes), 1)
        self.assertEqual(current._work_find(self.item)[0]["status"], "backlogged")
        self.assertNotIn("quick_staff_receipts", current._work_find(self.item)[0])

    def test_distinct_retries_cannot_staff_a_ticket_twice(self):
        appsettings.set_quick_staff_behavior("top_level")
        a = self.selection("haiku"); b = self.selection("luna")
        self.assertEqual(self.send(a).status_code, 200)
        self.assertEqual(self.send(b).status_code, 422)
        self.assertEqual(len(self.loaded().nodes), 2)

    def test_unknown_model_and_non_backlogged_items_are_refused(self):
        self.assertEqual(self.send(self.selection("not-in-this-org")).status_code, 422)
        self.org.work_update(self.owner, self.item, ["Started"], ["Finish"], status="open")
        store.save_org(self.org)
        self.assertEqual(self.client.get(self.path, headers=HEADERS).status_code, 422)

    def test_persisted_setting_default_and_each_mode(self):
        settings = self.client.get("/api/app-settings/runtime", headers=HEADERS).json()
        self.assertEqual(settings["quick_staff_behavior"], "request")
        for mode in appsettings.QUICK_STAFF_MODES:
            r = self.client.put("/api/app-settings/runtime", headers=HEADERS, json={"quick_staff_behavior": mode})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(appsettings.quick_staff_behavior(), mode)
        r = self.client.put("/api/app-settings/runtime", headers=HEADERS, json={"quick_staff_behavior": "bad"})
        self.assertEqual(r.status_code, 422)


class QuickStaffEligibilityTests(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create("eligibility")
        self.org.d["default_account"] = None

    def test_claude_scoped_limit_only_blocks_fable_but_all_limit_blocks_both(self):
        board = {"available": True, "limits": [
            {"kind": "weekly_all", "percent": 50},
            {"kind": "weekly_scoped", "percent": 100, "model": "fable"}]}
        with patch.object(quickstaff.limits, "snapshot", return_value=board):
            self.assertIsNone(quickstaff.account_reason(self.org, "haiku"))
            self.assertIn("100%", quickstaff.account_reason(self.org, "fable"))
            board["limits"][0]["percent"] = 100
            self.assertIn("100%", quickstaff.account_reason(self.org, "haiku"))

    def test_luna_checks_reserve_or_plan_according_to_the_persisted_preference(self):
        board = {"available": True, "limits": [
            {"kind": "weekly_all", "percent": 100},
            {"kind": "weekly_scoped", "percent": 0, "model": quickstaff.codex_route.RESERVE_MODEL}]}
        with patch.object(quickstaff.codex_limits, "snapshot", return_value=board):
            with patch.object(quickstaff, "app_prefer_reserve_default", return_value=True):
                self.assertIsNone(quickstaff.account_reason(self.org, "luna"))
                self.assertIn("100%", quickstaff.account_reason(self.org, "astra"))
                board["limits"][1]["percent"] = 100
                self.assertIn("100%", quickstaff.account_reason(self.org, "luna"))
            board["limits"][1]["percent"] = 0
            with patch.object(quickstaff, "app_prefer_reserve_default", return_value=False):
                self.assertIn("100%", quickstaff.account_reason(self.org, "luna"))

    def test_bound_account_eligibility_uses_its_own_telemetry(self):
        self.org.d["default_account"] = "specific-account"
        row = {"id": "specific-account", "provider": "claude", "auth": "authenticated",
               "credential": {"kind": "managed", "path": "unused"}}
        with patch.object(quickstaff.registry, "validate_selection", return_value=row), \
             patch.object(quickstaff.registry, "active_mark", return_value=None), \
             patch.object(quickstaff.accountusage, "view", return_value={"available": True,
                 "limits": [{"kind": "weekly_all", "percent": 100}]}):
            self.assertIn("100%", quickstaff.account_reason(self.org, "haiku"))

    def test_supported_efforts_follow_model_inventory_and_provider_mapping(self):
        model = quickstaff.providers.CODEX_MODELS["luna"]
        with patch.object(quickstaff.providers, "codex_model_inventory", return_value={"efforts": {model: ["low", "high"]}}):
            self.assertEqual(quickstaff.supported_efforts("luna"), ["low", "high"])
        with patch.object(quickstaff.providers, "codex_model_inventory", return_value={"efforts": {model: ["medium"]}}):
            self.assertEqual(quickstaff.supported_efforts("luna"), ["medium"])
        self.assertNotIn("xhigh", quickstaff.supported_efforts("flash"))


if __name__ == "__main__":
    unittest.main()
