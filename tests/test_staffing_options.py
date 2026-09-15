"""The warm staffing cache: preload, sharing, deduplication, invalidation.

⚠ WHAT THIS MEASURES AND WHY IT IS SEPARATE. `tests/test_quick_staff.py`
deliberately neutralises the cache so it can keep asserting what the RULES
decide; this file is the other half — it runs the real module and asserts on
the caching itself. The two together are the claim: the answers are unchanged,
and nobody waits for them any more.

Every section carries a control, because each of these assertions is the kind
that reads green for the wrong reason: a "no second request" that passes
because the first one never happened, an invalidation that looks effective
because the value was empty anyway, a "does not block" measured on a cache that
was already warm from the test before it.
"""
import os
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="staff-opts-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="staff-opts-tests")
from engine.launch import load_app
app, *_ = load_app()
from fastapi.testclient import TestClient
from orgtree import api, appsettings, ledger, quickstaff, registry, staffcache, store

HEADERS = {"X-Orgtree-Desktop-Token": "staff-opts-tests"}
OFFERED = {"providers": [
    {"id": "claude", "hire_enabled": True, "tiers": [{"tier": "haiku", "seat": 1}]},
    {"id": "openai", "hire_enabled": True, "tiers": [{"tier": "luna", "seat": .2}]}]}


class WarmCacheTests(unittest.TestCase):
    """§1-§4 — the cache mechanics, against the real module."""

    def setUp(self):
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        self.calls = []
        p = patch.object(api, "_providers_payload",
                         side_effect=lambda *a, **k: (self.calls.append("providers"), OFFERED)[1])
        p.start(); self.addCleanup(p.stop)
        p = patch.object(staffcache, "_supported_efforts", return_value=["low", "high"])
        p.start(); self.addCleanup(p.stop)

    # ------------------------------------------------------------------ §1
    def test_a_warm_read_costs_nothing_and_a_cold_one_costs_exactly_one(self):
        self.assertEqual(staffcache.state()["warm"], False)
        staffcache.read()
        self.assertEqual(self.calls, ["providers"])
        for _ in range(5):
            staffcache.read()
        self.assertEqual(self.calls, ["providers"], "a warm read must do no I/O")
        self.assertTrue(staffcache.state()["warm"])

    def test_warm_loads_once_before_anything_asks(self):
        staffcache.warm("test")
        deadline = time.time() + 5
        while not staffcache.state()["warm"] and time.time() < deadline:
            time.sleep(0.01)
        self.assertTrue(staffcache.state()["warm"], "warm() never produced a snapshot")
        self.assertEqual(self.calls, ["providers"])
        staffcache.read()
        self.assertEqual(self.calls, ["providers"],
                         "the first read after a warm must not load again")

    def test_warm_is_a_no_op_when_the_snapshot_is_already_fresh(self):
        staffcache.read()
        for _ in range(3):
            staffcache.warm("test")
        time.sleep(0.05)
        self.assertEqual(self.calls, ["providers"])

    # ------------------------------------------------------------------ §2
    def test_concurrent_cold_readers_share_one_computation(self):
        """SINGLE FLIGHT. Ten surfaces opening at once is the case that makes a
        naive cache WORSE than none — every one of them racing to fill it."""
        gate = threading.Event()
        def slow(*a, **k):
            self.calls.append("providers")
            gate.wait(timeout=5)
            return OFFERED
        with patch.object(api, "_providers_payload", side_effect=slow):
            done, threads = [], []
            for _ in range(10):
                t = threading.Thread(target=lambda: done.append(staffcache.read()))
                t.start(); threads.append(t)
            time.sleep(0.15)
            gate.set()
            for t in threads:
                t.join(timeout=10)
        self.assertEqual(len(done), 10)
        self.assertEqual(self.calls.count("providers"), 1,
                         "ten concurrent readers must cause one computation")
        self.assertTrue(all(d is done[0] for d in done), "and share the one answer")

    def test_control_ten_sequential_cold_reads_really_would_cost_ten(self):
        """CONTROL for single flight: without the shared snapshot the same ten
        reads are ten computations, so the 1 above is the mechanism and not a
        provider that happens to be called once."""
        for _ in range(10):
            staffcache.reset_for_tests()
            staffcache.read()
        self.assertEqual(self.calls.count("providers"), 10)

    # ------------------------------------------------------------------ §3
    def test_an_invalidation_refreshes_without_ever_blocking_a_reader(self):
        first = staffcache.read()
        staffcache.invalidate("account changed")
        # the menu's read: instant, and explicitly marked as the older answer
        served = staffcache.read()
        self.assertIs(served, first, "a reader must not wait for the refresh")
        self.assertTrue(staffcache.state()["stale"] or staffcache.state()["warm"])
        deadline = time.time() + 5
        while self.calls.count("providers") < 2 and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(self.calls.count("providers"), 2,
                                "the invalidation must actually refresh behind it")

    def test_the_commit_read_refuses_the_stale_answer_a_menu_may_use(self):
        """STALE IS FOR READING, NEVER FOR COMMITTING. This is what stops a menu
        rendered a moment before an account was disabled from actually hiring
        onto it."""
        first = staffcache.read()
        with staffcache._lock:
            staffcache._snapshot["stale"] = True
        # the MENU's read is handed the stale object itself, at once — that it
        # is the same object is the measurement: it did not wait for anything
        self.assertIs(staffcache.read(), first)
        # the COMMIT's read will not take it, and comes back not stale
        fresh = staffcache.read(max_age=staffcache.COMMIT_MAX_AGE, allow_stale=False)
        self.assertIsNot(fresh, first)
        self.assertFalse(fresh.get("stale"))

    def test_a_registry_write_is_what_invalidates_and_it_is_hooked_once(self):
        """The hook lives at `registry.save`, so every registry mutation — add,
        remove, a sign-in landing, a limit mark, the fallback order — reaches it
        without a per-route hook anybody can forget."""
        staffcache.read()
        self.assertFalse(staffcache.state()["stale"])
        registry.save(registry.load())
        self.assertTrue(staffcache.state()["stale"],
                        "a registry write must mark the snapshot stale")

    def test_control_an_unrelated_write_does_not_invalidate(self):
        """CONTROL: the invalidation above is the registry hook and not a cache
        that expires on any activity at all."""
        staffcache.read()
        appsettings.quick_staff_behavior()
        self.assertFalse(staffcache.state()["stale"])

    # ------------------------------------------------------------------ §4
    def test_discovery_failure_is_reported_as_unknown_not_as_emptiness(self):
        staffcache.reset_for_tests()
        with patch.object(api, "_providers_payload", side_effect=RuntimeError("offline")):
            snap = staffcache.read()
        self.assertTrue(snap["errors"], "a failure has to be reported")
        self.assertTrue(any("offline" in e for e in snap["errors"]))
        # and a failed load does not poison the next one
        staffcache.reset_for_tests()
        self.assertEqual(staffcache.read()["errors"], [])


class StaffingOptionsRouteTests(unittest.TestCase):
    """§5-§7 — the document every chooser reads, and the menu that reads it."""

    def setUp(self):
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        self.client = TestClient(app)
        self.org = ledger.Org.create("opt-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"] = {"haiku": 1, "luna": .2}
        self.owner = self.org.hire(ledger.USER, None, "haiku", 2, "manager",
            add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                "subagents": False, "mcp": []},
            org_visibility="self")["node"]
        self.item = self.org.work_create(self.owner, "Repair the widget",
            "The widget is broken. Repair it.", status="backlogged")["slug"]
        store.save_org(self.org)
        self.slug = self.org.d["slug"]
        self.calls = []
        p = patch.object(api, "_providers_payload",
                         side_effect=lambda *a, **k: (self.calls.append("providers"), OFFERED)[1])
        p.start(); self.addCleanup(p.stop)
        p = patch.object(staffcache, "_supported_efforts", return_value=["low", "high"])
        p.start(); self.addCleanup(p.stop)
        for target in ("provider_hire_gate", "hub_changed", "mail_notify"):
            p = patch.object(api, target, return_value=None)
            p.start(); self.addCleanup(p.stop)
        appsettings.set_quick_staff_behavior("under_assignee")
        self.addCleanup(appsettings.set_quick_staff_behavior, "request")

    def options(self):
        r = self.client.get(f"/api/orgs/{self.slug}/staffing-options", headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def preview(self):
        r = self.client.get(
            f"/api/orgs/{self.slug}/work-items/{self.item}/quick-staff", headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ------------------------------------------------------------------ §5
    def test_the_prefetch_route_is_what_loads_and_the_menu_then_loads_nothing(self):
        """THE WHOLE REQUIREMENT, end to end: the availability request happens
        before anything is opened, and opening a menu afterwards starts no
        second one."""
        self.options()
        self.assertEqual(self.calls, ["providers"])
        for _ in range(3):
            self.preview()
        self.assertEqual(self.calls, ["providers"],
                         "opening the ticket menu must not re-run discovery")

    def test_control_the_menu_alone_on_a_cold_cache_does_load(self):
        """CONTROL for the section above: the preview IS a consumer of the same
        discovery, so "it did not load" means the prefetch had already done it —
        not that the preview never needed it."""
        self.preview()
        self.assertEqual(self.calls, ["providers"])

    def test_every_chooser_reads_one_document_with_the_same_tiers(self):
        options = self.options()
        menu = self.preview()
        self.assertEqual([t["tier"] for t in options["tiers"]],
                         [m["tier"] for m in menu["models"]])
        self.assertEqual(self.calls, ["providers"], "…and it is loaded once")

    # ------------------------------------------------------------------ §6
    def test_only_staffable_tiers_are_listed_and_none_is_merely_disabled(self):
        listed = self.options()["tiers"]
        self.assertTrue(listed)
        for tier in listed:
            self.assertNotIn("reason", tier)
            self.assertTrue(tier["accounts"] or not _needs_account(tier["tier"]))
        # a tier whose provider gate closes is absent rather than refused-looking
        with patch.object(api, "provider_hire_gate",
                          side_effect=ledger.LedgerError("sign in")):
            staffcache.reset_for_tests()
            self.assertEqual(self.options()["tiers"], [])

    def test_a_tier_with_no_eligible_account_is_omitted_entirely(self):
        with patch.object(staffcache, "tier_accounts", return_value=[]):
            self.assertEqual(self.options()["tiers"], [])
            self.assertEqual(self.preview()["models"], [])
        # CONTROL: with accounts back, the same fixture lists them again, so the
        # empty lists above are the eligibility rule and not an empty org
        self.assertTrue(self.options()["tiers"])

    def test_an_ineligible_account_is_absent_from_the_tier_it_cannot_run(self):
        choices = [{"value": "claude/primary", "id": "default", "provider": "claude",
                    "ambient": True, "email": None},
                   {"value": "claude-4", "id": "claude-4", "provider": "claude",
                    "ambient": False, "email": "a@b.c"}]
        with patch.object(staffcache, "tier_accounts",
                          side_effect=lambda snap, org, tier:
                              choices if tier == "haiku" else choices[:1]):
            tiers = {t["tier"]: t for t in self.options()["tiers"]}
            self.assertEqual([a["value"] for a in tiers["haiku"]["accounts"]],
                             ["claude/primary", "claude-4"])
            self.assertEqual([a["value"] for a in tiers["luna"]["accounts"]],
                             ["claude/primary"])

    # ------------------------------------------------------------------ §7
    def test_a_named_account_reaches_the_hire_and_an_ineligible_one_is_refused(self):
        """The account the user picks has to actually bind, and one the menu
        would not have offered has to be refused at the door rather than
        silently ignored — the second is what makes a stale menu safe."""
        seen = {}
        real = api._staff_call
        def spy(org, slug, actor, args, drive, renamed, warnings):
            seen.update(args)
            return real(org, slug, actor, args, drive, renamed, warnings)
        choice = {"value": "claude/primary", "id": "default", "provider": "claude",
                  "ambient": True, "email": None}
        with patch.object(staffcache, "tier_accounts", return_value=[choice]), \
             patch.object(api, "_staff_call", side_effect=spy):
            body = {"mode": "under_assignee", "configured_mode": "under_assignee",
                    "owner": self.preview()["owner"], "tier": "haiku",
                    "account": "claude/primary", "request_id": str(uuid.uuid4())}
            r = self.client.post(
                f"/api/orgs/{self.slug}/work-items/{self.item}/quick-staff",
                headers=HEADERS, json=body)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(seen.get("account"), "claude/primary")
            self.assertIn("claude/primary", r.json()["message"])
            refused = {**body, "account": "claude-9", "request_id": str(uuid.uuid4())}
            self.assertEqual(self.client.post(
                f"/api/orgs/{self.slug}/work-items/{self.item}/quick-staff",
                headers=HEADERS, json=refused).status_code, 422)

    def test_the_retry_route_marks_stale_and_answers_without_blocking(self):
        self.options()
        before = self.calls.count("providers")
        r = self.client.post(f"/api/orgs/{self.slug}/staffing-options/refresh",
                             headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        deadline = time.time() + 5
        while self.calls.count("providers") <= before and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreater(self.calls.count("providers"), before)


def _needs_account(tier: str) -> bool:
    return staffcache.tier_needs_account(tier)


if __name__ == "__main__":
    unittest.main()
