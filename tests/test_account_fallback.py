"""Per-agent fallback inherits a live org default and preserves explicit OFF."""
import os
import tempfile
import unittest
from unittest.mock import patch


class AccountFallbackSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-account-fallback-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import api, ledger, store
        assert os.path.realpath(store.DATA_ROOT) == os.path.realpath(cls.root)
        cls.api, cls.ledger, cls.store = api, ledger, store

    def setUp(self):
        self.org = self.ledger.Org.create("fallback-settings")
        self.org.nodes["worker"] = {"state": "live", "parent": None,
            "model": "opus", "scope": {"tools": {}, "add_dirs": []},
            "grant": 10, "free": 10, "generation": 1}

    def test_absent_inherits_default_off_and_live_org_changes(self):
        self.assertFalse(self.org.account_fallback_for("worker"))
        self.org.d["account_fallback_default"] = True
        self.assertTrue(self.org.account_fallback_for("worker"))
        self.org.d["account_fallback_default"] = False
        self.assertFalse(self.org.account_fallback_for("worker"))

    def test_explicit_off_survives_enabled_default_and_clear_restores_inheritance(self):
        self.org.d["account_fallback_default"] = True
        self.org.set_scope(self.ledger.USER, "worker", account_fallback=False)
        self.assertFalse(self.org.account_fallback_for("worker"))
        self.org.set_scope(self.ledger.USER, "worker", clear_account_fallback=True)
        self.assertNotIn("account_fallback", self.org.node("worker")["scope"])
        self.assertTrue(self.org.account_fallback_for("worker"))
        self.org.d["account_fallback_default"] = False
        self.org.set_scope(self.ledger.USER, "worker", account_fallback=True)
        self.assertTrue(self.org.account_fallback_for("worker"))

    def test_self_retool_cannot_enable_or_clear_its_own_override(self):
        for body in ({"account_fallback": True}, {"clear_account_fallback": True}):
            with self.assertRaises(self.ledger.LedgerError):
                self.org.set_scope("worker", "worker", **body)
        self.assertNotIn("account_fallback", self.org.node("worker")["scope"])

    def test_settings_and_scope_http_writers_persist_false_and_clear(self):
        self.store.save_org(self.org)
        self.api.org_settings("fallback-settings", self.api.Settings(account_fallback_default=True))
        self.assertTrue(self.store.load_org("fallback-settings").account_fallback_for("worker"))
        with patch.object(self.api, "_public_slug", return_value=None):
            self.api.node_scope("fallback-settings", "worker",
                self.api.Scope(account_fallback=False), None)
            self.assertFalse(self.store.load_org("fallback-settings").account_fallback_for("worker"))
            self.api.node_scope("fallback-settings", "worker",
                self.api.Scope(clear_account_fallback=True), None)
        self.assertTrue(self.store.load_org("fallback-settings").account_fallback_for("worker"))
        self.api.org_settings("fallback-settings", self.api.Settings(account_fallback_default=False))
        self.assertFalse(self.store.load_org("fallback-settings").account_fallback_for("worker"))


    def _runtime(self, provider="claude", tier="opus", pool="haiku+sonnet+opus"):
        from engine.backend.orgtree import account_fallback as fallback, registry, supervisor
        import time
        fallback._scanned.clear()
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        source = registry.create_account(provider, "source", {"kind": "managed", "path": os.path.join(self.root, "source")})
        target = registry.create_account(provider, "target", {"kind": "managed", "path": os.path.join(self.root, "target")})
        for row in (source, target):
            registry.set_auth(row["id"], "authenticated")
        n = self.org.node("worker")
        n.update(model=tier, account=source["id"], frozen={
            "at": "2026-09-11T00:00:00Z", "limit": True,
            "until_ts": time.time() + 604800, "provider": provider,
            "account": source["id"], "resource_pool": pool,
            "resume_texts": ["finish the original task"]})
        n["scope"]["account_fallback"] = True
        self.org.d["auto_resume"] = False
        st = supervisor.state("fallback-settings", "worker")
        st.update(busy=False, responding=False, queue=[])
        return fallback, registry, supervisor, source, target

    def _board(self, provider="claude", exhausted=False, pool="plan"):
        import datetime, time
        reset = datetime.datetime.fromtimestamp(time.time()+7200, datetime.timezone.utc).isoformat()
        return {"available": True, "lane": "subscription", "limits": [
            {"kind": kind, "group": "codex" if provider == "openai" else kind,
             "percent": 100 if exhausted else 10, "resets_at": reset,
             "model": None} for kind in ("session", "weekly_all")]}

    def test_capacity_requires_complete_healthy_applicable_windows(self):
        import time
        from engine.backend.orgtree import account_fallback as fallback
        b = self._board()
        self.assertTrue(fallback.available(b, "claude", "opus", "opus", time.time()))
        self.assertFalse(fallback.available(b, "claude", "fable", "fable", time.time()))
        self.assertFalse(fallback.available(self._board(exhausted=True), "claude", "opus", "opus", time.time()))
        b["limits"].pop()
        self.assertFalse(fallback.available(b, "claude", "opus", "opus", time.time()))
        for bad in (None, float("nan"), -1, 100, True):
            b = self._board(); b["limits"][0]["percent"] = bad
            self.assertFalse(fallback.available(b, "claude", "opus", "opus", time.time()))
        b = self._board("openai")
        self.assertTrue(fallback.available(b, "openai", "astra", "plan", time.time()))
        self.assertFalse(fallback.available(b, "openai", "luna", "reserve", time.time()))
        self.assertFalse(fallback.available({**b, "error": "stale"}, "openai", "astra", "plan", time.time()))

    def test_default_off_and_busy_do_not_even_fetch_with_a_valid_sibling_present(self):
        fallback, registry, supervisor, source, target = self._runtime()
        with patch.object(fallback, "read_board", return_value=self._board()) as read:
            self.org.node("worker")["scope"]["account_fallback"] = False
            self.assertEqual(fallback.candidates(self.org), {})
            read.assert_not_called()
            self.org.node("worker")["scope"]["account_fallback"] = True
            supervisor.state("fallback-settings", "worker")["busy"] = True
            self.assertEqual(fallback.candidates(self.org), {})
            read.assert_not_called()
            supervisor.state("fallback-settings", "worker")["busy"] = False
            self.assertIn("worker", fallback.candidates(self.org))
            read.assert_called_once()

    def test_scheduler_switches_and_replays_once_with_auto_resume_off(self):
        fallback, registry, supervisor, source, target = self._runtime()
        self.store.save_org(self.org)
        with patch.object(fallback, "read_board", return_value=self._board()), \
             patch.object(supervisor, "_native_context_hold", return_value=False), \
             patch.object(supervisor.warmpool, "identity_snapshot", return_value=("hash", {})), \
             patch.object(supervisor.threading, "Thread") as thread:
            supervisor._auto_resume_org("fallback-settings")
            fresh = self.store.load_org("fallback-settings")
            self.assertEqual(fresh.node("worker")["account"], target["id"])
            self.assertNotIn("frozen", fresh.node("worker"))
            self.assertFalse(fresh.d["auto_resume"])
            self.assertEqual(thread.call_count, 1)
            carrier = thread.call_args.kwargs["args"][2]
            self.assertIn("finish the original task", carrier["text"])
            events = [e for e in fresh.d["events"] if e["op"] == "account_assign"]
            self.assertEqual(events[-1]["detail"]["via"], "limit_fallback")
            supervisor._auto_resume_org("fallback-settings")
            self.assertEqual(thread.call_count, 1)
            self.assertEqual(self.store.load_org("fallback-settings").node("worker")["account"], target["id"])

    def test_apply_refuses_settings_binding_freeze_and_mark_races(self):
        import copy, time
        fallback, registry, supervisor, source, target = self._runtime()
        with patch.object(fallback, "read_board", return_value=self._board()):
            plan = fallback.candidates(self.org)["worker"]
        original = copy.deepcopy(self.org.node("worker"))
        for change in ({"account": "someone-else"}, {"generation": 2},
                       {"frozen": {"limit": True, "at": "changed"}},
                       {"scope": {"account_fallback": False}}):
            self.org.nodes["worker"] = {**copy.deepcopy(original), **change}
            self.assertFalse(fallback.apply(self.org, "worker", plan))
        self.org.nodes["worker"] = original
        registry.record_mark(target["id"], "opus", time.time()+3600)
        self.assertFalse(fallback.apply(self.org, "worker", plan))
        self.assertEqual(self.org.node("worker")["account"], source["id"])

    def test_codex_marks_are_pool_specific_durable_and_own_account_only(self):
        import time
        fallback, registry, supervisor, source, target = self._runtime("openai", "luna", "reserve+plan")
        with patch.object(fallback.codex_limits, "_account_namespace", return_value=("own-digest", "subscription")):
            fallback.record_limit(self.org.node("worker"), "wrong-digest", "reserve", time.time()+3600, True)
            self.assertIsNone(registry.active_mark(source["id"], "openai:reserve"))
            fallback.record_limit(self.org.node("worker"), "own-digest", "reserve", time.time()+3600, True)
        self.assertIsNotNone(registry.active_mark(source["id"], "openai:reserve"))
        self.assertIsNone(registry.active_mark(source["id"], "openai:plan"))
        self.assertIsNone(registry.active_mark(target["id"], "openai:reserve"))
        self.assertTrue(fallback.marked(registry.get_account(source["id"]), "luna", "reserve"))

    def test_unsupported_profile_binding_fails_at_validator(self):
        from engine.backend.orgtree import registry
        row = registry.create_account("google", "unsupported", {"kind": "managed", "path": os.path.join(self.root, "google")})
        with self.assertRaisesRegex(registry.BindingRefused, "does not support"):
            registry.validate_binding("fallback-settings", "pro", row["id"])


    def test_failed_or_stale_freshness_check_never_counts_old_healthy_bars(self):
        fallback, registry, supervisor, source, target = self._runtime()
        with patch.object(fallback.subproxy, "profile_access_token", return_value="fixture"), \
             patch.object(fallback.limits, "fetch_for_token", return_value=self._board()) as fetch, \
             patch.object(fallback.limits, "account_readout", return_value=(self._board(), 120)):
            self.assertEqual(fallback.read_board(target), {})
            self.assertEqual(fetch.call_args.kwargs, {"force": True})
        with patch.object(fallback.subproxy, "profile_access_token", return_value="fixture"), \
             patch.object(fallback.limits, "fetch_for_token", return_value=self._board()), \
             patch.object(fallback.limits, "account_readout", return_value=(self._board(), 0)):
            self.assertTrue(fallback.read_board(target)["available"])

    def test_codex_combined_pool_can_use_unmarked_plan_but_not_marked_reserve(self):
        import time
        fallback, registry, supervisor, source, target = self._runtime("openai", "luna", "reserve+plan")
        registry.record_mark(target["id"], "openai:reserve", time.time()+3600)
        b = self._board("openai")
        self.assertTrue(fallback.capacity(target, b, "luna", "reserve+plan"))
        self.assertFalse(fallback.capacity(target, b, "luna", "reserve"))
        registry.record_mark(target["id"], "openai:plan", time.time()+3600)
        self.assertFalse(fallback.capacity(target, b, "luna", "reserve+plan"))

    def test_refreeze_records_actual_codex_pool_before_next_fallback_scan(self):
        import time
        fallback, registry, supervisor, source, target = self._runtime("openai", "luna", "reserve+plan")
        self.store.save_org(self.org)
        with patch.object(fallback.codex_limits, "_account_namespace", return_value=("own-digest", "subscription")), \
             patch.object(supervisor, "_limit_announce"):
            self.assertTrue(supervisor.freeze_provider_limit("fallback-settings", "worker", "usage limit",
                reset_ts=time.time()+3600, provider="openai", account="own-digest", resource_pool="reserve+plan"))
        self.assertIsNotNone(registry.active_mark(source["id"], "openai:reserve"))
        self.assertIsNotNone(registry.active_mark(source["id"], "openai:plan"))
        self.assertIsNone(registry.active_mark(target["id"], "openai:plan"))

    def test_auth_unknown_requires_real_capacity_and_foreign_freeze_is_rejected(self):
        fallback, registry, supervisor, source, target = self._runtime()
        registry.set_auth(target["id"], "unobserved")
        with patch.object(fallback, "read_board", return_value={"available": False}):
            self.assertEqual(fallback.candidates(self.org), {})
        fallback._scanned.clear()
        with patch.object(fallback, "read_board", return_value=self._board()):
            self.assertIn("worker", fallback.candidates(self.org))
        self.org.node("worker")["account"] = target["id"]
        self.assertFalse(fallback.eligible(self.org, "worker"))
        self.org.node("worker")["account"] = source["id"]
        self.org.node("worker")["frozen"]["error"] = "tokens per minute limit exceeded"
        self.assertFalse(fallback.eligible(self.org, "worker"))

    def test_codex_read_and_apply_reject_login_changed_during_or_after_fetch(self):
        fallback, registry, supervisor, source, target = self._runtime("openai", "astra", "plan")
        board = {**self._board("openai"), "account": "target-digest"}
        with patch.object(fallback.codex_limits, "fetch_for_home", return_value=board), \
             patch.object(fallback.codex_limits, "_account_namespace", side_effect=[("target-digest", "subscription"), ("changed", "subscription")]):
            self.assertEqual(fallback.read_board(target), {})
        with patch.object(fallback.codex_limits, "fetch_for_home", return_value=board), \
             patch.object(fallback.codex_limits, "_account_namespace", return_value=("target-digest", "subscription")):
            self.assertEqual(fallback.read_board(target), board)
        with patch.object(fallback, "read_board", return_value=board):
            plan = fallback.candidates(self.org)["worker"]
        with patch.object(fallback.codex_limits, "_account_namespace", return_value=("changed", "subscription")):
            self.assertFalse(fallback.apply(self.org, "worker", plan))
        self.assertEqual(self.org.node("worker")["account"], source["id"])
        self.store.save_org(self.org)
        fallback._scanned.clear()
        with patch.object(fallback, "read_board", return_value=board), \
             patch.object(fallback.codex_limits, "_account_namespace", return_value=("target-digest", "subscription")), \
             patch.object(supervisor, "_native_context_hold", return_value=False), \
             patch.object(supervisor.warmpool, "identity_snapshot", return_value=("hash", {})), \
             patch.object(supervisor.threading, "Thread") as thread:
            supervisor._auto_resume_org("fallback-settings")
        fresh = self.store.load_org("fallback-settings")
        self.assertEqual(fresh.node("worker")["account"], target["id"])
        self.assertNotIn("frozen", fresh.node("worker"))
        self.assertEqual(thread.call_count, 1)

    def test_key_billing_is_not_a_subscription_capacity_switch(self):
        # a freeze earned on a metered API-key ACCOUNT row (user redesign
        # 2026-09-12; formerly the V1 `bills_the_key` org-key guard) is the
        # API's own wall — switching login profiles cannot clear it
        fallback, registry, supervisor, source, target = self._runtime()
        key_row = registry.create_account(
            "claude", "meter", {"kind": "apikey", "token_ref": "tok-kb"},
            mode="apikey")
        self.org.node("worker")["frozen"]["account"] = key_row["id"]
        with patch.object(fallback, "read_board") as read:
            self.assertFalse(fallback.eligible(self.org, "worker"))
            self.assertEqual(fallback.candidates(self.org), {})
            read.assert_not_called()
        self.org.node("worker")["frozen"]["account"] = source["id"]
        with patch.object(fallback, "read_board", return_value=self._board()):
            self.assertIn("worker", fallback.candidates(self.org))

    def test_codex_uses_router_classification_from_real_normalized_payload(self):
        import time
        fallback, registry, supervisor, source, target = self._runtime("openai", "luna", "reserve+plan")
        window = {"usedPercent": 10, "windowDurationMins": 10080, "resetsAt": time.time()+7200}
        raw = {"rateLimitsByLimitId": {"unusual_plan_id": {"primary": window},
               "internal_model_id": {"limitName": "gpt-reserve", "primary": window}}}
        b = fallback.codex_limits._normalize(raw, None)
        b["lane"] = "subscription"
        self.assertTrue(fallback.available(b, "openai", "astra", "plan", time.time()))
        self.assertTrue(fallback.available(b, "openai", "luna", "reserve", time.time()))
        raw["rateLimitsByLimitId"]["internal_model_id"]["limitName"] = "GPT-Reserve"
        b = fallback.codex_limits._normalize(raw, None); b["lane"] = "subscription"
        self.assertFalse(fallback.available(b, "openai", "luna", "reserve", time.time()))

    def test_boards_are_read_once_per_account_for_multiple_frozen_agents(self):
        import copy
        fallback, registry, supervisor, source, target = self._runtime()
        self.org.nodes["second"] = copy.deepcopy(self.org.node("worker"))
        with patch.object(fallback, "read_board", return_value=self._board()) as read:
            self.assertEqual(set(fallback.candidates(self.org)), {"worker", "second"})
            read.assert_called_once()

    def test_failed_fallback_preserves_normal_resume_and_off_costs_one_load(self):
        fallback, registry, supervisor, source, target = self._runtime()
        self.org.d["auto_resume"] = True
        self.store.save_org(self.org)
        with patch.object(fallback, "candidates", side_effect=RuntimeError("fixture refusal")), \
             patch.object(supervisor, "auto_resume_ready", return_value={"worker"}), \
             patch.object(supervisor, "resume_frozen", return_value=["worker"]) as resume:
            supervisor._auto_resume_org("fallback-settings")
            resume.assert_called_once_with("fallback-settings", only={"worker"}, cheap_first=False)
        self.org.d["auto_resume"] = False
        self.org.node("worker")["scope"]["account_fallback"] = False
        self.store.save_org(self.org)
        with patch.object(self.store, "load_org", wraps=self.store.load_org) as load, \
             patch.object(fallback, "read_board") as read:
            supervisor._auto_resume_org("fallback-settings")
            self.assertEqual(load.call_count, 1)
            read.assert_not_called()

    def test_resume_loop_continues_after_one_org_failure(self):
        from engine.backend.orgtree import supervisor
        def step(slug):
            if slug == "broken": raise RuntimeError("fixture failure")
        with patch.object(supervisor, "_auto_resume_started", False), \
             patch.object(supervisor.threading, "Thread") as thread, \
             patch.object(supervisor.time, "sleep", side_effect=[None, StopIteration]), \
             patch.object(self.store, "list_orgs", return_value=[{"slug": "broken"}, {"slug": "healthy"}]), \
             patch.object(supervisor, "_auto_resume_org", side_effect=step) as tick:
            supervisor.start_auto_resume_loop()
            with self.assertRaises(StopIteration):
                thread.call_args.kwargs["target"]()
            self.assertEqual([c.args[0] for c in tick.call_args_list], ["broken", "healthy"])

    def test_active_claude_window_and_pending_manual_switch_prevent_fallback(self):
        fallback, registry, supervisor, source, target = self._runtime()
        b = self._board(); b["limits"][0]["is_active"] = True
        self.assertFalse(fallback.capacity(target, b, "opus", "opus"))
        b["limits"][0]["is_active"] = False
        self.assertTrue(fallback.capacity(target, b, "opus", "opus"))
        self.org.node("worker")["pending_switch"] = {"model": "astra"}
        self.assertFalse(fallback.eligible(self.org, "worker"))
        self.org.node("worker").pop("pending_switch")
        self.assertTrue(fallback.eligible(self.org, "worker"))

    def test_agent_tool_retool_and_composite_seat_fields_carry_the_override(self):
        import copy
        from starlette.requests import Request
        from engine.backend.orgtree import mcptool
        parent = copy.deepcopy(self.org.node("worker"))
        parent["scope"]["permission_mode"] = "bypassPermissions"
        self.org.nodes["manager"] = parent
        self.org.node("worker")["parent"] = "manager"
        self.store.save_org(self.org)
        req = Request({"type": "http", "headers": []})
        self.api.agent_call(self.api.AgentCall(org="fallback-settings", node="manager", tool="orgtree_retool",
            args={"node": "worker", "account_fallback": True}), req)
        self.assertTrue(self.store.load_org("fallback-settings").account_fallback_for("worker"))
        self.api.agent_call(self.api.AgentCall(org="fallback-settings", node="manager", tool="orgtree_retool",
            args={"node": "worker", "clear_account_fallback": True}), req)
        self.assertNotIn("account_fallback", self.store.load_org("fallback-settings").node("worker")["scope"])
        self.assertIn("account_fallback", self.api._SEAT_SCOPE_HIRE)
        self.api._seat_finish(self.org, "fallback-settings", "manager", "worker",
            {"account_fallback": True}, {}, [])
        self.assertTrue(self.org.account_fallback_for("worker"))
        for name in ("orgtree_hire", "orgtree_rehire", "orgtree_retool", "orgtree_staff"):
            schema = next(t for t in mcptool.TOOLS if t["name"] == name)["inputSchema"]["properties"]
            self.assertIn("account_fallback", schema)
            self.assertIn("clear_account_fallback", schema)

    def test_both_ready_paths_still_replay_only_once(self):
        import time
        fallback, registry, supervisor, source, target = self._runtime()
        self.org.d["auto_resume"] = True
        self.org.node("worker")["frozen"]["until_ts"] = time.time()-120
        self.store.save_org(self.org)
        with patch.object(fallback, "read_board", return_value=self._board()), \
             patch.object(supervisor, "_native_context_hold", return_value=False), \
             patch.object(supervisor.warmpool, "identity_snapshot", return_value=("hash", {})), \
             patch.object(supervisor.threading, "Thread") as thread:
            supervisor._auto_resume_org("fallback-settings")
            self.assertEqual(thread.call_count, 1)
            self.assertEqual(self.store.load_org("fallback-settings").node("worker")["account"], target["id"])

    def test_assignment_exception_discards_partial_binding_before_any_save(self):
        fallback, registry, supervisor, source, target = self._runtime()
        self.store.save_org(self.org)
        def broken_assign(slug, nid, account, **kw):
            kw["org"].node(nid)["account"] = account
            raise RuntimeError("fixture failure after in-memory mutation")
        with patch.object(fallback, "read_board", return_value=self._board()), \
             patch.object(supervisor, "_native_context_hold", return_value=False), \
             patch.object(supervisor, "assign_account", side_effect=broken_assign):
            supervisor._auto_resume_org("fallback-settings")
        n = self.store.load_org("fallback-settings").node("worker")
        self.assertEqual(n["account"], source["id"])
        self.assertIn("frozen", n)
