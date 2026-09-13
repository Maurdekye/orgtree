"""Real child-process checks for persistent turns, steering and key isolation."""
import json
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

_root = tempfile.TemporaryDirectory(prefix="agy-parity-tests-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import antigravityrun as agy, antigravity_session as session
from orgtree import ledger, supervisor as sup
from orgtree import apikey_accounts, appsettings, providers, registry, store, tokens, warmpool


FAKE = r'''
import json, os, pathlib, subprocess, sys, time
def out(e): print(json.dumps(e),flush=True)
out({'event':'init','conversation_id':'test-conversation','init':{'model':sys.argv[sys.argv.index('--model')+1]}})
n=0; step=0
for line in sys.stdin:
 text=json.loads(line)['message']['content']; n+=1
 out({'event':'step_update','step_update':{'step_type':'user_input','state':'DONE','step_index':step}}); step+=1
 if text=='steer':
  out({'event':'step_update','step_update':{'step_type':'agent_response','state':'ACTIVE','step_index':step,'text_delta':'working'}})
  pending=pathlib.Path(os.environ['ORGTREE_AGY_STEER_DIR'])/'pending.json'
  end=time.monotonic()+5
  while not pending.exists() and time.monotonic()<end: time.sleep(.01)
  if pending.exists():
   r=subprocess.run([sys.executable,os.environ['HOOK'],'post'],input='{}',capture_output=True,text=True)
   msg=json.loads(r.stdout)['injectSteps'][0]['userMessage']
   out({'event':'step_update','step_update':{'step_type':'user_input','state':'DONE','step_index':step}}); step+=1
   text=msg
 if text=='hang': time.sleep(60)
 out({'event':'step_update','step_update':{'step_type':'agent_response','state':'DONE','step_index':step,'text_delta':text,'usage':{'input_tokens':10,'output_tokens':2,'cache_read_tokens':3}}});step+=1
 out({'event':'result','result':{'status':'SUCCESS','response':text,'num_turns':n,'usage':{'input_tokens':10*n,'output_tokens':2*n,'cache_read_tokens':3*n,'total_tokens':12*n}}})
'''


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.script = Path(self.folder.name) / "fake.py"
        self.script.write_text(FAKE)
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        self.folder.cleanup()

    def client(self):
        c = agy.AntigravityTurn([sys.executable, str(self.script)], cwd=self.folder.name,
            model="gemini-test", effort=None, persistent=True,
            env_extra={"HOOK": str(Path(agy.__file__).with_name("antigravity_hook.py"))})
        self.clients.append(c)
        return c

    def test_two_turns_keep_process_and_reset_usage_and_output(self):
        c = self.client()
        c.launch()
        pid = c.pid
        self.assertFalse(c._ever_started)
        for prompt in ("one", "two"):
            c.start(prompt)
            result = c.wait(5)
            self.assertEqual(result["status"], agy.STATUS_COMPLETED)
            self.assertEqual(result["agent_text"], prompt)
            self.assertEqual(result["token_usage"]["input"], 10)
            self.assertEqual(result["token_usage"]["output"], 2)
            self.assertEqual(c.pid, pid)
            self.assertIsNone(c.poll())
        self.assertFalse(c.steer("too late"))

    def test_hook_delivery_confirmed_during_same_run(self):
        c = self.client()
        c.start("steer")
        end = time.monotonic() + 3
        while not c._turn_user_steps and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue(c.steer("correction"), (c.stderr_tail, c.events))
        r = c.wait(5)
        self.assertEqual(r["status"], agy.STATUS_COMPLETED)
        self.assertIn("correction", r["agent_text"])
        self.assertEqual(sum(e["event"] == "result" for e in c.events), 1)

    def test_result_only_counters_are_not_billed_twice(self):
        self.script.write_text(FAKE.replace("'usage':{'input_tokens':10,'output_tokens':2,'cache_read_tokens':3}", "'usage':{}"))
        c = self.client()
        for prompt in ("one", "two"):
            c.start(prompt)
            r = c.wait(5)
            self.assertEqual(r["token_usage"]["input"], 10)
            self.assertEqual(r["token_usage"]["output"], 2)

    def test_receipt_is_committed_before_corrected_output(self):
        c = self.client()
        trace = []
        c._caller_on_event = lambda e: trace.append(e.get("event"))
        c.start("steer")
        end = time.monotonic() + 3
        while not c._turn_user_steps and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue(c.steer("correction", on_accepted=lambda: trace.append("receipt")))
        c.wait(5)
        self.assertLess(trace.index("receipt"), trace.index("result"))

    def test_interrupt_unblocks_steering_without_receipting_it(self):
        c = self.client()
        c.start("hang")
        end = time.monotonic() + 3
        while not c._turn_user_steps and time.monotonic() < end:
            time.sleep(.01)
        received = []
        t = threading.Thread(target=lambda: received.append(c.steer("unseen")))
        t.start()
        c.interrupt()
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertEqual(received, [False])
        self.assertEqual(c.wait(3)["status"], agy.STATUS_INTERRUPTED)


class AccountTests(unittest.TestCase):
    def test_google_key_is_token_reference_and_settings_contain_no_key(self):
        row, _ = apikey_accounts.register("google", "fake-key-for-tests")
        home = session.key_home(row)
        settings = Path(home) / ".gemini/antigravity-cli/settings.json"
        self.assertEqual(json.loads(settings.read_text()), {"modelProvider": "gemini"})
        self.assertNotIn("fake-key-for-tests", Path(registry.registry_path()).read_text())
        env = {}
        registry.inject_binding(env, row, secret_resolver=tokens.get)
        self.assertEqual(env["GEMINI_API_KEY"], "fake-key-for-tests")
        self.assertIsNone(registry.identity_mismatch(env))

    def test_ambient_keys_and_endpoints_do_not_change_subscription_billing(self):
        raw = {"GEMINI_API_KEY": "ambient", "GOOGLE_API_KEY": "other",
               "AGY_ADC_AUTH": "true", "GOOGLE_GEMINI_BASE_URL": "https://example.invalid"}
        self.assertNotIn("GEMINI_API_KEY", providers.antigravity_env(raw))
        key = providers.antigravity_env(raw, allow_gemini_key=True)
        self.assertEqual(key["GEMINI_API_KEY"], "ambient")
        self.assertNotIn("AGY_ADC_AUTH", key)
        self.assertNotIn("GOOGLE_GEMINI_BASE_URL", key)

    def test_mcp_children_do_not_inherit_model_key(self):
        cfg = agy.mcp_config({"example": {"command": "python"}})
        self.assertEqual(cfg["mcpServers"]["example"]["env"]["GEMINI_API_KEY"], "")

    def test_api_fallback_is_opt_in(self):
        appsettings.set_apikey_fallback_enabled("google", False)
        self.assertFalse(appsettings.apikey_fallback_enabled("google"))


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        import uuid
        self.folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.addCleanup(self.folder.cleanup)
        self.script = Path(self.folder.name) / "cli.py"
        self.script.write_text(FAKE)
        self.org = store.create_org("agy-" + uuid.uuid4().hex[:8])
        self.org.hire(ledger.USER, None, "flash", 0, "worker")
        store.save_org(self.org)
        self.slug = self.org.d["slug"]
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for target, name, value in (
            (providers, "antigravity_status", {"installed":True,"connected":True,"path":sys.executable}),
            (providers, "antigravity_argv", [sys.executable, str(self.script)]),
            (sup, "identity_prompt", "Test identity"),
            (sup, "antigravity_mcp_grant", ({}, [])),
            (sup, "_mcp_wait_for_surface", "unsupported"),
            (sup, "_leash", None),
            (warmpool, "warm_decision", (True, True)),
            (warmpool, "warm_enabled", True)):
            self.stack.enter_context(mock.patch.object(target, name, return_value=value))
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.addCleanup(lambda: warmpool.kill_node(self.slug, "worker", "disabled"))
        appsettings.set_subscription_inference_enabled("google", True)
        appsettings.set_apikey_fallback_enabled("google", False)

    def run_leg(self, prompt):
        org = store.load_org(self.slug)
        return sup._antigravity_leg(self.slug, "worker", org,
            sup.state(self.slug, "worker"), prompt, [])[0]

    def test_real_turn_seam_parks_claims_and_accounts_to_selected_key(self):
        row, _ = apikey_accounts.register("google", "supervisor-test-key")
        self.org.node("worker")["account"] = row["id"]
        store.save_org(self.org)
        for prompt in ("one", "two"):
            r = self.run_leg(prompt)
            self.assertEqual(r["status"], agy.STATUS_COMPLETED)
            self.assertEqual(r["result"], prompt)
            self.assertTrue(r["_antigravity_metered"])
            wp = warmpool._pool.get((self.slug, "worker"))
            self.assertIsNotNone(wp, "successful turn must park")
            if prompt == "one":
                pid = wp.proc.pid
            else:
                self.assertEqual(wp.proc.pid, pid)
            self.assertEqual(sup.state(self.slug, "worker")["ran_as"], row["id"])
        before = store.load_org(self.slug).node("worker")["session_id"]
        out = sup.assign_account(self.slug, "worker", "google/primary", actor=ledger.USER)
        self.assertTrue(out["session_boundary"])
        latest = store.load_org(self.slug)
        self.assertNotEqual(latest.node("worker")["session_id"], before)
        self.assertEqual(latest.node(out["bearer"])["session_id"], before)

    def test_failed_key_turn_books_observed_tokens_and_marks_its_account(self):
        row, _ = apikey_accounts.register("google", "failed-key-test")
        self.org.node("worker")["account"] = row["id"]
        store.save_org(self.org)
        self.script.write_text(FAKE.replace("'status':'SUCCESS'", "'status':'ERROR','error':'quota exceeded'"))
        with self.assertRaises(sup._ProviderTurnFailed) as caught:
            self.run_leg("one")
        error = caught.exception
        self.assertEqual(error.account, row["id"])
        spent = registry.get_account(row["id"])["spend"]["usd_total"]
        self.assertGreater(spent, 0)
        with mock.patch.object(sup, "_limit_announce"):
            sup.freeze_provider_limit(self.slug, "worker", error.blob, error.reset_ts,
                provider=error.provider, account=error.account, resource_pool=error.resource_pool)
        self.assertIsNotNone(registry.active_mark(row["id"], "flash"))
        self.assertEqual(registry.get_account(row["id"])["spend"]["usd_total"], spent)

    def test_prewarm_is_claimed_without_submitting_a_prompt(self):
        wp = warmpool._spawn_for(store.load_org(self.slug), "worker", "no-process")
        self.assertIsInstance(wp, warmpool.AntigravityWarmProc)
        self.assertFalse(wp.client._ever_started)
        pid = wp.proc.pid
        warmpool.park_back(wp, 0)
        self.run_leg("one")
        self.assertEqual(warmpool._pool[(self.slug, "worker")].proc.pid, pid)

    def test_changed_rights_replace_warm_process(self):
        self.run_leg("one")
        old = warmpool._pool[(self.slug, "worker")]
        org = store.load_org(self.slug)
        org.node("worker")["scope"]["tools"]["web"] = False
        store.save_org(org)
        self.run_leg("two")
        self.assertIsNot(warmpool._pool[(self.slug, "worker")], old)
        self.assertIsNotNone(old.proc.poll())

    def test_api_key_turn_needs_no_subscription_login(self):
        row, _ = apikey_accounts.register("google", "key-only-test")
        self.org.node("worker")["account"] = row["id"]
        store.save_org(self.org)
        with mock.patch.object(providers, "antigravity_status", return_value={
                "installed": True, "connected": False, "path": sys.executable}):
            r = self.run_leg("one")
        self.assertTrue(r["_antigravity_metered"])

    def test_google_fallback_requires_consent_and_fresh_gemini_wall(self):
        apikey_accounts.register("google", "fallback-test")
        wall = {"available": True, "stale": False,
                "limits": [{"model": "Gemini", "is_active": True}]}
        with mock.patch.object(sup.antigravity_limits, "snapshot", return_value=wall):
            self.assertIsNone(sup.apikey_route_for("flash"))
            appsettings.set_apikey_fallback_enabled("google", True)
            self.assertIsNotNone(sup.apikey_route_for("flash"))
            wall["stale"] = True
            self.assertIsNone(sup.apikey_route_for("flash"))
            wall["stale"] = False
            wall["limits"][0]["model"] = "Third-party"
            self.assertIsNone(sup.apikey_route_for("flash"))

    def test_automatic_api_route_preserves_prior_subscription_conversation(self):
        self.run_leg("one")
        prior = store.load_org(self.slug).node("worker")["session_id"]
        apikey_accounts.register("google", "automatic-route-key")
        appsettings.set_subscription_inference_enabled("google", False)
        r = self.run_leg("two")
        self.assertTrue(r["_antigravity_lineage_changed"])
        latest = store.load_org(self.slug)
        predecessor = latest.node("worker")["predecessor"]
        self.assertEqual(latest.node(predecessor)["session_id"], prior)
        self.assertTrue(r["_antigravity_metered"])


if __name__ == "__main__":
    unittest.main()
