"""Behavioral tests proving cross-account Codex resume failure (-32600)
reproduced before fix, and clean fresh thread start + driver preservation
and positive-control same-account resume after fix.
"""
import os
import tempfile
import unittest
from unittest.mock import patch


class FakeClient:
    """Fake Codex AppServerClient simulating Account A and Account B rollouts."""
    instances = []

    def __init__(self, argv_head, codex_home=None, on_event=None, **kw):
        self.argv_head = argv_head
        self.codex_home = codex_home
        self.on_event = on_event
        self.closed = False
        self.requests = []
        self.proc = self
        self.pid = 99999
        self.stderr_tail = []
        FakeClient.instances.append(self)

    def poll(self):
        return None

    def initialize(self, timeout=None):
        return {"capabilities": {}}

    def drain_tools(self, timeout):
        return 0

    def close(self):
        self.closed = True

    def bind(self, **kw):
        if "on_event" in kw and kw["on_event"]:
            self.on_event = kw["on_event"]

    def unbind(self):
        pass

    def request(self, method, params, timeout=None, **kw):
        self.requests.append((method, dict(params)))
        if method == "thread/resume":
            tid = params.get("threadId")
            if "acct-b" in str(self.codex_home) and "tid-a" in str(tid).lower():
                from engine.backend.orgtree.codexrun import CodexRequestError
                raise CodexRequestError("thread/resume", -32600,
                                        f"no rollout found for thread id {tid}")
            return {"thread": {"id": tid}}
        elif method == "thread/start":
            acct = "b" if "acct-b" in str(self.codex_home) else "a"
            seq = len([r for r in self.requests if r[0] == "thread/start"])
            tid = f"tid-{acct}-{seq}"
            return {"thread": {"id": tid}}
        elif method == "turn/start":
            tid = params.get("threadId")
            turn_id = f"turn-{tid}-1"
            if self.on_event:
                self.on_event({
                    "method": "turn/completed",
                    "params": {"turn": {"id": turn_id, "status": "completed"}}
                })
            return {"turn": {"id": turn_id}}
        elif method == "mcpServerStatus/list":
            return {"servers": []}
        return {}


class CodexAccountSwitchResumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-cxres-")
        os.environ["ORGTREE_DATA"] = cls.root
        import sys
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="replace")
        from engine.backend.orgtree import ledger, registry, store, supervisor, codexrun, providers
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor
        cls.codexrun = codexrun
        cls.providers = providers

    def setUp(self):
        FakeClient.instances.clear()
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _row(self, name):
        CodexAccountSwitchResumeTests._seq += 1
        home = os.path.join(self.root, f"home-acct-{name}-{self._seq}")
        os.makedirs(home, exist_ok=True)
        return self.registry.create_account(
            "openai", f"acct-{name}",
            {"kind": "managed", "path": home})

    def _org(self, slug, account, model="astra"):
        org = self.ledger.Org.create(slug)
        org.nodes["worker"] = {
            "state": "live", "parent": None, "generation": 1,
            "model": model, "grant": 10, "free": 10,
            "session_id": "minted-uuid-1", "session_unrun": True,
            "account": account, "scope": {"dirs": {}, "tools": {}, "audiences": {}, "permission_mode": "default", "add_dirs": [], "visibility": "full"}
        }
        self.store.save_org(org)
        return org

    def test_reproduce_cross_account_resume_failure_before_fix(self):
        """Negative control / reproduction:
        If an agent account moves to Account B while retaining Account A thread ID
        in codex_thread, attempting thread/resume against Account B server fails
        with exact JSON-RPC -32600: no rollout found for thread id.
        """
        row_a = self._row("a")
        row_b = self._row("b")
        org = self._org("org-repro", account=row_b["id"])

        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node.pop("session_unrun", None)
        node["account"] = row_b["id"]
        self.store.save_org(org)

        from engine.backend.orgtree.codexrun import CodexTurn, CodexRequestError
        home_b = self.registry.get_account(row_b["id"])["credential"]["path"]
        turn = CodexTurn(
            ["fake-codex"], cwd=self.root, model="astra", effort=None,
            thread_id=node["session_id"], codex_home=home_b,
            client=FakeClient([], codex_home=home_b)
        )
        with self.assertRaises(CodexRequestError) as ctx:
            turn.start("Driver text that should have run")

        self.assertEqual(ctx.exception.code, -32600)
        self.assertIn("no rollout found for thread id tid-a-1", ctx.exception.message)

    def test_same_account_restart_resumes_existing_thread(self):
        """Positive control:
        When an agent runs subsequent turns or restarts on the SAME account,
        _codex_leg correctly issues thread/resume with the existing thread ID
        and does NOT start a fresh thread.
        """
        row_a = self._row("a")
        slug = "org-same-acct"
        org = self._org(slug, account=row_a["id"])

        # Agent previously harvested thread on Account A:
        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node["codex_account"] = row_a["id"]
        node.pop("session_unrun", None)
        self.store.save_org(org)

        cstat = {"installed": True, "path": "fake-codex", "connected": True, "kind": "managed"}
        st = self.supervisor.state(slug, "worker")
        with patch.object(self.providers, "codex_status", return_value=cstat), \
             patch.object(self.codexrun, "AppServerClient", FakeClient), \
             patch.object(self.supervisor, "_cache_codex_account_namespace",
                          side_effect=lambda home=None: (f"ns-{os.path.basename(str(home or ''))}", "subscription")):
            res, _ = self.supervisor._codex_leg(slug, "worker", org, st, "Followup turn on same account", [])

        # Verify client calls on turn client:
        client = next(c for c in FakeClient.instances if any(m in ("thread/start", "thread/resume") for m, _ in c.requests))
        methods = [req[0] for req in client.requests]
        self.assertIn("thread/resume", methods)
        self.assertNotIn("thread/start", methods)

        # thread/resume sent the existing thread ID:
        resume_req = next(r for r in client.requests if r[0] == "thread/resume")
        self.assertEqual(resume_req[1]["threadId"], "tid-a-1")

        # turn/start used the resumed thread:
        turn_req = next(r for r in client.requests if r[0] == "turn/start")
        self.assertEqual(turn_req[1]["threadId"], "tid-a-1")
        self.assertEqual(turn_req[1]["input"][0]["text"], "Followup turn on same account")

        # Node retains thread and account:
        loaded = self.store.load_org(slug)
        self.assertEqual(loaded.node("worker")["codex_thread"], "tid-a-1")
        self.assertEqual(loaded.node("worker")["codex_account"], row_a["id"])

    def test_cross_account_switch_starts_fresh_thread_and_preserves_driver(self):
        """End-to-end account switch:
        1. Agent has active thread on Account A.
        2. Account is switched to Account B via assign_account.
        3. Session lineage is reset.
        4. Next turn runs cleanly on Account B with thread/start, preserves driver text,
           and harvests new thread ID bound to Account B.
        """
        row_a = self._row("a")
        row_b = self._row("b")
        slug = "org-switch-e2e"
        org = self._org(slug, account=row_a["id"])

        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node["codex_account"] = row_a["id"]
        node.pop("session_unrun", None)
        self.store.save_org(org)

        # Switch account via supervisor.assign_account:
        self.supervisor.assign_account(slug, "worker", row_b["id"], actor="test-actor")

        # Check lineage reset in store:
        reloaded = self.store.load_org(slug)
        switched_node = reloaded.node("worker")
        self.assertEqual(switched_node["account"], row_b["id"])
        self.assertIsNone(switched_node.get("codex_thread"))
        self.assertIsNone(switched_node.get("codex_account"))
        self.assertTrue(switched_node.get("session_unrun"))
        self.assertNotEqual(switched_node["session_id"], "tid-a-1")

        # Run next turn on Account B with pending driver text:
        driver_text = "Pending driver text delivered after account switch"
        cstat = {"installed": True, "path": "fake-codex", "connected": True, "kind": "managed"}
        st = self.supervisor.state(slug, "worker")
        with patch.object(self.providers, "codex_status", return_value=cstat), \
             patch.object(self.codexrun, "AppServerClient", FakeClient), \
             patch.object(self.supervisor, "_cache_codex_account_namespace",
                          side_effect=lambda home=None: (f"ns-{os.path.basename(str(home or ''))}", "subscription")):
            res, _ = self.supervisor._codex_leg(slug, "worker", reloaded, st, driver_text, [])

        client = next(c for c in FakeClient.instances if any(m in ("thread/start", "thread/resume") for m, _ in c.requests))
        methods = [req[0] for req in client.requests]

        # No thread/resume on Account B:
        self.assertNotIn("thread/resume", methods)
        # Fresh thread/start on Account B:
        self.assertIn("thread/start", methods)

        # turn/start executed with pending driver text:
        turn_req = next(r for r in client.requests if r[0] == "turn/start")
        self.assertEqual(turn_req[1]["threadId"], "tid-b-1")
        self.assertEqual(turn_req[1]["input"][0]["text"], driver_text)

        # Node now persisted with Account B thread and account:
        final_org = self.store.load_org(slug)
        self.assertEqual(final_org.node("worker")["codex_thread"], "tid-b-1")
        self.assertEqual(final_org.node("worker")["codex_account"], row_b["id"])
        self.assertEqual(final_org.node("worker")["session_id"], "tid-b-1")
        self.assertFalse(final_org.node("worker").get("session_unrun"))

    def test_defense_in_depth_stale_thread_starts_fresh_compatible_thread(self):
        """Defense-in-depth:
        If a node somehow has stale doc state where codex_thread is tid-a-1 and
        codex_account is row_a, but node['account'] is row_b (e.g. legacy doc state
        or external change), _codex_leg detects the account mismatch, refuses to resume,
        starts a fresh thread on Account B, and delivers the pending prompt.
        """
        row_a = self._row("a")
        row_b = self._row("b")
        slug = "org-defense-in-depth"
        org = self._org(slug, account=row_b["id"])

        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node["codex_account"] = row_a["id"]  # Mismatch with row_b
        node.pop("session_unrun", None)
        self.store.save_org(org)

        driver_text = "Pending driver text delivered despite stale lineage"
        cstat = {"installed": True, "path": "fake-codex", "connected": True, "kind": "managed"}
        st = self.supervisor.state(slug, "worker")
        with patch.object(self.providers, "codex_status", return_value=cstat), \
             patch.object(self.codexrun, "AppServerClient", FakeClient), \
             patch.object(self.supervisor, "_cache_codex_account_namespace",
                          side_effect=lambda home=None: (f"ns-{os.path.basename(str(home or ''))}", "subscription")):
            res, _ = self.supervisor._codex_leg(slug, "worker", org, st, driver_text, [])

        client = next(c for c in FakeClient.instances if any(m in ("thread/start", "thread/resume") for m, _ in c.requests))
        methods = [req[0] for req in client.requests]

        # Crucial: did NOT call thread/resume for the incompatible thread:
        self.assertNotIn("thread/resume", methods)
        self.assertIn("thread/start", methods)

        # Pending driver text was delivered to the new thread:
        turn_req = next(r for r in client.requests if r[0] == "turn/start")
        self.assertEqual(turn_req[1]["threadId"], "tid-b-1")
        self.assertEqual(turn_req[1]["input"][0]["text"], driver_text)

        # Lineage repaired to Account B:
        final_org = self.store.load_org(slug)
        self.assertEqual(final_org.node("worker")["codex_thread"], "tid-b-1")
        self.assertEqual(final_org.node("worker")["codex_account"], row_b["id"])

    def test_assign_account_lineage_reset_behavior(self):
        """assign_account resets lineage on account change for openai/codex nodes,
        and preserves lineage when re-assigning the same account.
        """
        row_a = self._row("a")
        row_b = self._row("b")
        slug = "org-assign-unit"
        org = self._org(slug, account=row_a["id"])

        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node["codex_account"] = row_a["id"]
        node["codex_usage_total"] = {"totalTokens": 100}
        node["cache_continuity"] = {"cached": True}
        node.pop("session_unrun", None)
        self.store.save_org(org)

        # Re-assign same account: no reset
        self.supervisor.assign_account(slug, "worker", row_a["id"], actor="test-actor")
        n1 = self.store.load_org(slug).node("worker")
        self.assertEqual(n1["session_id"], "tid-a-1")
        self.assertEqual(n1["codex_thread"], "tid-a-1")
        self.assertEqual(n1["codex_account"], row_a["id"])
        self.assertIn("codex_usage_total", n1)
        self.assertIn("cache_continuity", n1)

        # Assign different account: lineage reset
        self.supervisor.assign_account(slug, "worker", row_b["id"], actor="test-actor")
        n2 = self.store.load_org(slug).node("worker")
        self.assertEqual(n2["account"], row_b["id"])
        self.assertNotEqual(n2["session_id"], "tid-a-1")
        self.assertTrue(n2["session_unrun"])
        self.assertNotIn("codex_thread", n2)
        self.assertNotIn("codex_account", n2)
        self.assertNotIn("codex_usage_total", n2)
        self.assertNotIn("cache_continuity", n2)

    def test_finish_switch_binding_lineage_reset_behavior(self):
        """finish_switch_binding resets lineage on account change for openai/codex nodes,
        and preserves lineage when account is unchanged.
        """
        row_a = self._row("a")
        row_b = self._row("b")
        slug = "org-switch-unit"
        org = self._org(slug, account=row_a["id"])

        node = org.node("worker")
        node["session_id"] = "tid-a-1"
        node["codex_thread"] = "tid-a-1"
        node["codex_account"] = row_a["id"]
        node["codex_usage_total"] = {"totalTokens": 100}
        node["cache_continuity"] = {"cached": True}
        node.pop("session_unrun", None)
        self.store.save_org(org)

        # Same account: no reset
        self.supervisor.finish_switch_binding(org, slug, "worker", row_a["id"], "test-actor")
        self.assertEqual(node["session_id"], "tid-a-1")
        self.assertEqual(node["codex_thread"], "tid-a-1")
        self.assertEqual(node["codex_account"], row_a["id"])

        # Different account: lineage reset
        self.supervisor.finish_switch_binding(org, slug, "worker", row_b["id"], "test-actor")
        self.assertEqual(node["account"], row_b["id"])
        self.assertNotEqual(node["session_id"], "tid-a-1")
        self.assertTrue(node["session_unrun"])
        self.assertNotIn("codex_thread", node)
        self.assertNotIn("codex_account", node)
        self.assertNotIn("codex_usage_total", node)
        self.assertNotIn("cache_continuity", node)


if __name__ == "__main__":
    unittest.main()
