"""THE OPENROUTER HARNESS AXIS — which CLI drives an OpenRouter agent.

One module per acceptance condition group, in the ticket's own order. The
sections are numbered so a failure names the promise it broke rather than a
function.

⚠ WHAT THIS MODULE REFUSES TO DO. It never spawns a CLI and never reaches
openrouter.ai. The live end-to-end fact — that codex-cli 0.154.0 really does
complete a turn against the gateway through `codexrun.AppServerClient` — was
measured once, by hand, with a real key, and is recorded in the ticket; it is
not something a unit suite can assert without spending money on every run. So
availability here is INJECTED, and what is tested is the machinery that hangs
off it: the four states, the three selector shapes, the refusal, the stamp
that does not migrate, and the exact process inputs a launch would carry.

The one thing that would make all of this worthless is a test that passes
because the code does nothing, so §13 mutates the real decisions and asserts
that each one is actually watched.
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="or-harness-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="or-harness-tests")

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import (appsettings, desktop_native, ledger,  # noqa: E402
                     openrouter, openrouter_harness as H, providers, store,
                     supervisor, warmpool)

#: the favorite the fixtures hire on. The tier SLUG sanitizes the dot out of
#: the model id, and that divergence is the point — see §5.
MODEL_ID = "vendor/model-v4.1-flash"
TIER = openrouter.tier_id(MODEL_ID) if hasattr(openrouter, "tier_id") else \
    "or-vendor-model-v4-1-flash"

_HIRE = dict(add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                "subagents": False, "mcp": []},
             org_visibility="self", charter="worker")


def _state(name, available=True, why="installed and ready"):
    return {"state": name, "available": available, "why": why,
            "version": "0.0.0", "path": f"/fake/{name}"}


OK = _state(H.AVAILABLE)
GONE = _state(H.MISSING, False, "the Codex CLI was not found on this machine")
NO_CLAUDE = _state(H.MISSING, False, "the Claude Code CLI was not found")


def _avail(claude=OK, codex=OK):
    """Patch BOTH per-harness readers. Everything else — `availability`,
    `usable`, `selector`, `resolve` — is derived from them, so the whole axis
    is driven from one fixture and no test can accidentally assert against a
    real machine's installs."""
    return (patch.object(H, "claude_state", return_value=claude),
            patch.object(H, "codex_state", return_value=codex))


class _Patched(unittest.TestCase):
    def avail(self, claude=OK, codex=OK):
        for p in _avail(claude, codex):
            p.start()
            self.addCleanup(p.stop)


# ── §1 the selector's three shapes (acceptance 1, 2, 3) ───────────────────

class SelectorTests(_Patched):
    def test_1a_both_available_offers_both_and_defaults_to_claude_code(self):
        self.avail()
        s = H.selector(None)
        self.assertTrue(s["enabled"])
        self.assertFalse(s["unavailable"])
        self.assertEqual(s["selected"], H.CLAUDE_CODE)
        self.assertEqual([o["id"] for o in s["harnesses"]],
                         [H.CLAUDE_CODE, H.CODEX_CLI])
        self.assertTrue(all(o["available"] for o in s["harnesses"]))

    def test_1b_both_available_honours_an_explicit_codex_choice(self):
        self.avail()
        self.assertEqual(H.selector(H.CODEX_CLI)["selected"], H.CODEX_CLI)

    def test_2a_only_claude_shows_it_selected_and_greys_the_control(self):
        self.avail(codex=GONE)
        s = H.selector(None)
        self.assertFalse(s["enabled"], "a one-horse race is not a choice")
        self.assertFalse(s["unavailable"])
        self.assertEqual(s["selected"], H.CLAUDE_CODE)
        # a greyed control with no reason is the state people file bugs about
        self.assertIn("Codex CLI is not", s["explain"])
        self.assertIn(GONE["why"], s["explain"])

    def test_2b_only_codex_shows_CODEX_selected_even_though_claude_is_default(self):
        """The singular-harness rule outranks the default. A machine with only
        Codex must not show Claude Code sitting there selected and unusable."""
        self.avail(claude=NO_CLAUDE)
        s = H.selector(None)
        self.assertFalse(s["enabled"])
        self.assertEqual(s["selected"], H.CODEX_CLI)
        self.assertNotEqual(s["selected"], s["default"])

    def test_3_neither_available_offers_no_choice_and_explains_both(self):
        self.avail(claude=NO_CLAUDE, codex=GONE)
        s = H.selector(None)
        self.assertTrue(s["unavailable"])
        self.assertFalse(s["enabled"])
        self.assertIsNone(s["selected"], "no false choice")
        for why in (NO_CLAUDE["why"], GONE["why"]):
            self.assertIn(why, s["explain"])

    def test_3b_every_state_the_ticket_names_is_reachable_and_distinct(self):
        """missing / unavailable / unauthenticated / unsupported are FOUR
        answers because they need four different next actions from the
        person reading them. Collapsing any two is the defect."""
        self.assertEqual(
            len({H.AVAILABLE, H.MISSING, H.UNAVAILABLE,
                 H.UNAUTHENTICATED, H.UNSUPPORTED}), 5)


# ── §2 no silent fallback (acceptance 4, 5) ───────────────────────────────

class NoFallbackTests(_Patched):
    def test_4_a_codex_choice_resolves_to_codex(self):
        self.avail()
        self.assertEqual(H.resolve(H.CODEX_CLI), H.CODEX_CLI)

    def test_5a_losing_codex_refuses_instead_of_starting_on_claude(self):
        """THE CENTRAL PROMISE. Claude Code is available and would work; the
        agent still must not be started on it."""
        self.avail(codex=GONE)
        with self.assertRaises(H.HarnessUnavailable) as caught:
            H.resolve(H.CODEX_CLI)
        msg = str(caught.exception)
        self.assertIn(GONE["why"], msg, "the refusal carries the ACTUAL condition")
        self.assertIn("not moved automatically", msg)

    def test_5b_the_refusal_is_symmetric(self):
        self.avail(claude=NO_CLAUDE)
        with self.assertRaises(H.HarnessUnavailable):
            H.resolve(H.CLAUDE_CODE)

    def test_5c_resolve_NEVER_answers_with_a_harness_it_was_not_asked_about(self):
        """Stated as a property rather than a case: across every availability
        combination, `resolve` either returns exactly what it was asked for or
        raises. There is no input that makes it substitute."""
        for claude in (OK, NO_CLAUDE):
            for codex in (OK, GONE):
                for want in H.HARNESSES:
                    with self.subTest(claude=claude["state"],
                                      codex=codex["state"], want=want):
                        with patch.object(H, "claude_state", return_value=claude), \
                             patch.object(H, "codex_state", return_value=codex):
                            try:
                                self.assertEqual(H.resolve(want), want)
                            except H.HarnessUnavailable:
                                pass

    def test_5d_an_unknown_stored_value_reads_as_the_default_not_as_a_crash(self):
        self.avail()
        self.assertEqual(H.canonical("harness-from-the-future"), H.DEFAULT)
        self.assertEqual(H.canonical(None), H.DEFAULT)
        self.assertEqual(H.canonical(""), H.DEFAULT)


# ── §3 the stamp, and that it does not migrate (acceptance 7) ─────────────

class StampTests(_Patched):
    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("orh-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.org.d["tiers"]["haiku"] = 1.0

    def _hire(self, tier=TIER, **kw):
        return self.org.hire(ledger.USER, None, tier, 1,
                             "n" + uuid.uuid4().hex[:6], **_HIRE, **kw)["node"]

    def test_7a_a_new_hire_takes_the_machine_default(self):
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            nid = self._hire()
        self.assertEqual(self.org.node(nid)["or_harness"], H.CODEX_CLI)
        self.assertEqual(self.org.harness_for(nid), H.CODEX_CLI)

    def test_7b_CHANGING_THE_SETTING_MOVES_NOBODY(self):
        """The user's ruling, as a test. An existing agent keeps the harness
        it was hired on when the machine-wide default changes underneath it,
        and only the NEXT hire sees the new value."""
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CLAUDE_CODE):
            old = self._hire()
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            new = self._hire()
            self.assertEqual(self.org.harness_for(old), H.CLAUDE_CODE,
                             "the existing agent was migrated — it must not be")
            self.assertEqual(self.org.harness_for(new), H.CODEX_CLI)

    def test_7c_an_agent_hired_before_this_existed_reads_as_claude_code(self):
        """No stamp at all — every OpenRouter agent in every org that predates
        this feature. It must read as the harness those agents are really
        running, not as an error and not as the current setting."""
        nid = self._hire()
        self.org.node(nid).pop("or_harness", None)
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            self.assertEqual(self.org.harness_for(nid), H.CLAUDE_CODE)

    def test_7d_an_explicit_choice_beats_the_machine_default(self):
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CLAUDE_CODE):
            nid = self._hire(harness=H.CODEX_CLI)
        self.assertEqual(self.org.harness_for(nid), H.CODEX_CLI)

    def test_7e_a_non_openrouter_tier_is_not_stamped_at_all(self):
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            nid = self._hire(tier="haiku")
        self.assertNotIn("or_harness", self.org.node(nid),
                         "a tier with one possible CLI has nothing to record")

    def test_7f_naming_a_harness_for_a_tier_that_has_none_is_refused(self):
        with self.assertRaises(ledger.LedgerError):
            self._hire(tier="haiku", harness=H.CODEX_CLI)

    def test_7g_an_unknown_harness_is_refused_on_the_WRITE_path(self):
        """Tolerant on read (7c), strict on write. Old data must keep working;
        new data must not be allowed to become old bad data."""
        with self.assertRaises(ledger.LedgerError):
            self._hire(harness="not-a-harness")


# ── §4 which leg a turn takes (acceptance 4) ──────────────────────────────

class DispatchTests(_Patched):
    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("ord-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.org.d["tiers"]["haiku"] = 1.0
        self.org.d["tiers"]["luna"] = 0.2

    def _hire(self, tier, harness=None):
        kw = {"harness": harness} if harness else {}
        return self.org.hire(ledger.USER, None, tier, 1,
                             "n" + uuid.uuid4().hex[:6], **_HIRE, **kw)["node"]

    def test_4a_an_openrouter_agent_set_to_codex_takes_the_codex_leg(self):
        nid = self._hire(TIER, H.CODEX_CLI)
        self.assertTrue(supervisor.codex_harness_turn(self.org, nid, TIER))

    def test_4b_an_openrouter_agent_on_claude_code_does_NOT(self):
        nid = self._hire(TIER, H.CLAUDE_CODE)
        self.assertFalse(supervisor.codex_harness_turn(self.org, nid, TIER))

    def test_4c_a_real_codex_tier_takes_the_codex_leg_whatever_else_is_true(self):
        nid = self._hire("luna")
        self.assertTrue(supervisor.codex_harness_turn(self.org, nid, "luna"))

    def test_4d_a_claude_tier_never_does(self):
        nid = self._hire("haiku")
        self.assertFalse(supervisor.codex_harness_turn(self.org, nid, "haiku"))


# ── §5 the exact launch inputs (acceptance 6, and the measured traps) ─────

class ProcessSpecTests(_Patched):
    """What a Codex-harness OpenRouter launch would actually carry.

    Three of these assertions exist because the obvious value was measured to
    be WRONG against the real CLI and the real gateway. They are not style
    checks — each one cost a probe cycle to find.
    """

    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("orp-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.nid = self.org.hire(ledger.USER, None, TIER, 1, "spec",
                                 harness=H.CODEX_CLI, **_HIRE)["node"]
        store.save_org(self.org)
        # ⚠ `kind` IS DELIBERATELY NON-EMPTY, and `connected` deliberately
        # False. Both are fixture choices with a job. An earlier cut used
        # kind="" and test_6h passed against code that copied the ambient
        # login straight through — the mutation harness caught it, because
        # "" == "" tells you nothing. A machine that IS signed in to ChatGPT
        # is the only fixture where "this OpenRouter turn must not claim that
        # login" is a falsifiable statement.
        for p in (patch.object(providers, "codex_status", return_value={
                      "installed": True, "path": "/fake/codex",
                      "connected": False, "kind": "chatgpt",
                      "version": "0.154.0"}),
                  patch.object(openrouter, "_key", return_value="sk-or-test"),
                  patch.object(supervisor, "identity_prompt",
                               return_value="IDENT")):
            p.start()
            self.addCleanup(p.stop)

    def spec(self):
        return supervisor._codex_process_spec(self.org, self.nid,
                                              write_ident=False)

    def overrides(self):
        return " ".join(self.spec()["config_overrides"])

    def test_6a_the_launch_is_pointed_at_openrouter(self):
        self.assertIn('base_url="https://openrouter.ai/api/v1"', self.overrides())
        self.assertIn('model_provider="orgtree_openrouter"', self.overrides())

    def test_6b_wire_api_is_responses_NOT_chat(self):
        """MEASURED: codex-cli 0.154.0 refuses `wire_api = "chat"` at config
        load ("no longer supported"), and OpenRouter is described everywhere
        as Chat-Completions-compatible, so `chat` is the guess a reasonable
        person makes. It kills the process before any network call."""
        self.assertIn('wire_api="responses"', self.overrides())
        self.assertNotIn('wire_api="chat"', self.overrides())

    def test_6c_the_provider_block_has_a_name(self):
        """MEASURED: omitting it dies with `provider name must not be empty`.
        It is not an optional label."""
        self.assertIn('orgtree_openrouter.name=', self.overrides())

    def test_6d_the_model_is_the_FAVORITES_id_not_a_de_slugged_tier(self):
        """MEASURED: the tier slug flattens the dot, and OpenRouter answers
        400 `not a valid model ID` for the flattened form. The dot must
        survive all the way to the wire."""
        self.assertIn(f'model="{MODEL_ID}"', self.overrides())
        self.assertIn(".", MODEL_ID.rsplit("/", 1)[-1])
        self.assertNotIn(TIER, self.overrides())

    def test_6e_the_gateway_key_is_injected_under_its_own_variable(self):
        spec = self.spec()
        self.assertEqual(spec["env_extra"][H.KEY_ENV], "sk-or-test")
        self.assertNotIn("OPENAI_API_KEY", spec["env_extra"],
                         "a stray OpenAI key would flip the billing lane")

    def test_6f_it_runs_under_its_OWN_codex_home_never_the_users(self):
        """The user's ~/.codex holds their ChatGPT auth.json, their rollouts
        and their config.toml. None of the three belongs to a launch that
        authenticates with a gateway key."""
        home = self.spec()["codex_home"]
        self.assertNotEqual(os.path.normcase(os.path.abspath(home)),
                            os.path.normcase(os.path.expanduser("~/.codex")))
        self.assertIn("codex-openrouter", home)

    def test_6g_the_turn_is_attributed_to_the_GATEWAY_not_to_a_chatgpt_plan(self):
        """`ran_as` decides which account the usage panel bills this turn to.
        Without the harness branch it falls to the machine's primary ChatGPT
        login — a turn paid for with the OpenRouter key, reported against a
        subscription it never touched."""
        self.assertEqual(supervisor.identity_in_spec(self.spec()),
                         supervisor.OPENROUTER_IDENTITY)

    def test_6h_it_does_NOT_demand_codex_login(self):
        """`connected: False` above is the point: this lane never reads
        auth.json, so requiring a ChatGPT session would refuse a launch that
        demonstrably works."""
        self.assertTrue(self.spec()["argv_head"])
        self.assertEqual(self.spec()["login_kind"], "",
                         "an OpenRouter turn must not claim an OpenAI login")

    def test_6i_a_missing_gateway_key_fails_loudly_and_locally(self):
        with patch.object(openrouter, "_key", return_value=""):
            with self.assertRaises(RuntimeError) as caught:
                self.spec()
        self.assertIn("OpenRouter API key", str(caught.exception))

    def test_5e_availability_lost_before_the_spawn_REFUSES(self):
        """Acceptance 5, at the last moment it can still be caught: the CLI
        is gone by the time the process would be created."""
        with patch.object(H, "codex_state", return_value=GONE):
            with self.assertRaises(H.HarnessUnavailable):
                self.spec()

    def test_6j_the_route_is_the_gateways_and_names_no_openai_pool(self):
        """The codex route resolver exists to choose between two OpenAI
        billing pools. An OpenRouter turn can reach neither, and stamping one
        would freeze this agent when a plan it does not use runs out."""
        route = supervisor._codex_resolve_route(self.org, self.nid, TIER)
        self.assertEqual(route["model"], MODEL_ID)
        self.assertEqual(route["pool"], openrouter.PROVIDER_ID)
        self.assertEqual(route["account"], supervisor.OPENROUTER_IDENTITY)
        self.assertIsNone(route["reset_ts"])

    def test_6k_its_standing_notes_are_mirrored_into_the_prompt(self):
        """A codex-harness agent reads AGENTS.md and never CLAUDE.md, so the
        notes it is told to keep must be delivered in the prompt — otherwise
        it keeps a compaction-survival file that nothing reads, and finds out
        at the compaction."""
        cwd = supervisor.scratch_dir(self.org.d["slug"], self.nid)
        os.makedirs(cwd, exist_ok=True)
        with open(os.path.join(cwd, "CLAUDE.md"), "w", encoding="utf-8") as f:
            f.write("REMEMBER-THE-THING")
        self.assertIn("REMEMBER-THE-THING",
                      supervisor._standing_notes_block(self.org, self.nid))


# ── §6 the capability probe (the `unsupported` state) ─────────────────────

class CapabilityTests(unittest.TestCase):
    def setUp(self):
        H.forget_probe()
        self.addCleanup(H.forget_probe)
        p = patch.object(providers, "codex_status", return_value={
            "installed": True, "path": "/fake/codex", "connected": True,
            "kind": "chatgpt", "version": "0.100.0"})
        p.start()
        self.addCleanup(p.stop)
        p2 = patch.object(openrouter, "key_set", return_value=True)
        p2.start()
        self.addCleanup(p2.stop)

    def test_8a_a_build_that_refuses_the_config_reports_UNSUPPORTED(self):
        with patch.object(H, "_codex_config_accepted",
                          return_value=(False, '`wire_api = "chat"` is no '
                                               'longer supported')):
            st = H.codex_state()
        self.assertEqual(st["state"], H.UNSUPPORTED)
        self.assertFalse(st["available"])
        # the CLI's own sentence reaches the person, including its fix
        self.assertIn("no longer supported", st["why"])

    def test_8b_a_build_that_accepts_it_is_available(self):
        with patch.object(H, "_codex_config_accepted",
                          return_value=(True, "config accepted")):
            self.assertEqual(H.codex_state()["state"], H.AVAILABLE)

    def test_8c_an_absent_CLI_is_MISSING_and_says_how_to_install_it(self):
        with patch.object(providers, "codex_status", return_value={
                "installed": False, "path": "", "connected": False}):
            st = H.codex_state()
        self.assertEqual(st["state"], H.MISSING)
        self.assertTrue(st["why"])

    def test_8d_no_gateway_key_is_UNAUTHENTICATED_on_BOTH_harnesses(self):
        """On this lane the credential is the gateway key, not a CLI login:
        neither harness signs in to its own vendor. So a missing key makes
        both unusable at once, and the sentence says `set a key` rather than
        sending anyone to a `codex login` that would change nothing."""
        with patch.object(openrouter, "key_set", return_value=False), \
             patch.object(H, "_codex_config_accepted",
                          return_value=(True, "ok")):
            self.assertEqual(H.codex_state()["state"], H.UNAUTHENTICATED)
            self.assertEqual(H.claude_state()["state"], H.UNAUTHENTICATED)

    def test_8e_the_probe_is_cached_per_binary_not_re_run_per_question(self):
        calls = []

        def counting(exe):
            calls.append(exe)
            return True, "ok"

        with patch.object(H, "_codex_config_accepted", side_effect=counting):
            H.codex_state()
            H.codex_state()
        self.assertEqual(len(calls), 2, "the module-level cache lives inside "
                                        "_codex_config_accepted, which this "
                                        "test replaces — see 8f")

    def test_8f_the_real_probe_caches_on_the_binarys_identity(self):
        seen = []

        class FakeProc:
            def communicate(self, _input, timeout=None):
                seen.append(1)
                return b"", b""

            def kill(self):
                pass

        with patch.object(H.subprocess, "Popen", return_value=FakeProc()):
            H._codex_config_accepted(__file__)
            H._codex_config_accepted(__file__)
        self.assertEqual(len(seen), 1, "one spawn per binary, not per ask")


# ── §9 the warm pool: the keeper must park the harness the turn will use ──

class WarmPoolTests(_Patched):
    """Reviewer finding f1, as the tests that would have caught it.

    The defect was not a wrong ANSWER — the turn never ran on the wrong
    harness, because the codex leg's `isinstance(candidate, CodexWarmProc)`
    guard discarded the Claude process. It was a wrong PROCESS, parked
    forever and thrown away forever: a real `claude` CLI and its MCP tree
    spawned on every keeper pass for an agent the user had put on Codex CLI,
    discarded by every turn, so the lane was permanently cold while the pool
    still counted it as a seat that ought to be warm.

    §9d is the one that proves the fix rather than the intent: it parks what
    the keeper actually builds and then makes the turn's own claim call
    against it.
    """

    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("orw-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.nid = self.org.hire(ledger.USER, None, TIER, 1, "warm",
                                 harness=H.CODEX_CLI, **_HIRE)["node"]
        self.org.node(self.nid)["state"] = "live"
        store.save_org(self.org)
        for p in (patch.object(providers, "codex_status", return_value={
                      "installed": True, "path": "/fake/codex",
                      "connected": False, "kind": "chatgpt",
                      "version": "0.154.0"}),
                  patch.object(openrouter, "_key", return_value="sk-or-test"),
                  patch.object(supervisor, "identity_prompt",
                               return_value="IDENT")):
            p.start()
            self.addCleanup(p.stop)

    def _hire_claude_harness(self):
        nid = self.org.hire(ledger.USER, None, TIER, 1,
                            "c" + uuid.uuid4().hex[:6],
                            harness=H.CLAUDE_CODE, **_HIRE)["node"]
        self.org.node(nid)["state"] = "live"
        store.save_org(self.org)
        return nid

    # ── the premise the finding rests on ──────────────────────────────────
    def test_9a_an_openrouter_node_IS_warm_pool_eligible(self):
        """If it were excluded there would be no defect to fix — `eligible`
        is what makes the keeper reach these two functions at all."""
        ok, why = warmpool.eligible(self.org, self.nid)
        self.assertTrue(ok, f"not eligible: {why}")
        self.assertNotIn(TIER, providers.CODEX_TIERS,
                         "the tier is not a codex tier; only the HARNESS is")

    # ── the parked process's IDENTITY ─────────────────────────────────────
    def test_9b_the_parked_identity_is_the_CODEX_manifest_not_the_claude_argv(self):
        real = supervisor._codex_startup_manifest
        seen = []

        def spy(*a, **k):
            seen.append("codex")
            return real(*a, **k)

        with patch.object(supervisor, "_codex_startup_manifest", spy), \
                patch.object(supervisor, "_build_cmd",
                             side_effect=AssertionError(
                                 "the keeper hashed the CLAUDE command line")):
            digest, parts = warmpool.identity_snapshot(self.org, self.nid)
        self.assertEqual(seen, ["codex"])
        self.assertTrue(digest)
        self.assertEqual(set(parts), set(warmpool.IDENTITY_COMPONENTS))

    def test_9c_an_openrouter_node_on_CLAUDE_CODE_still_hashes_the_claude_argv(self):
        """The control. The fix must follow the HARNESS, not turn every
        OpenRouter node into a codex one — a mutation that simply replaced
        the branch with `is_tier(...)` would pass §9b and die here."""
        nid = self._hire_claude_harness()
        seen = []

        def fake_build_cmd(*a, **k):
            seen.append("claude")
            return ["claude", "--print"]

        with patch.object(supervisor, "_build_cmd", fake_build_cmd), \
                patch.object(supervisor, "_codex_startup_manifest",
                             side_effect=AssertionError(
                                 "a claude-harness node took the codex branch")), \
                patch.object(supervisor, "env_overrides", return_value={}), \
                patch.object(supervisor, "spawn_env", return_value={}):
            warmpool.identity_snapshot(self.org, nid)
        self.assertEqual(seen, ["claude"])

    # ── the parked process ITSELF ─────────────────────────────────────────
    def _fake_app_server(self, built):
        class FakeProc:
            pid = 4242

            def poll(self):
                return None

            def kill(self):
                pass

        class FakeClient:
            def __init__(self, argv, **kw):
                built.append({"argv": list(argv), **kw})
                self.proc = FakeProc()
                self.on_exit = None
                self.on_event = None

            def close(self):
                pass

        return FakeClient

    def _spawn(self, nid, built, popen_calls):
        from orgtree import codexrun

        def fake_popen(argv, **kw):
            popen_calls.append(list(argv)[:1])
            raise OSError("a claude process must not be spawned for this node")

        with patch.object(codexrun, "AppServerClient",
                          self._fake_app_server(built)), \
                patch.object(warmpool, "_POPEN", fake_popen), \
                patch.object(warmpool, "_journal_proc",
                             lambda *a, **k: None), \
                patch.object(supervisor, "_leash", lambda *a, **k: None), \
                patch.object(supervisor, "_mcp_tool_count_begin",
                             lambda *a, **k: None):
            return warmpool._spawn_for(self.org, nid, "test")

    def test_9d_the_keeper_parks_an_APP_SERVER_and_the_turn_CLAIMS_it(self):
        """THE ROUND TRIP, and the assertion the finding actually turns on.

        `_spawn_for` builds the seat; the second half is the codex leg's own
        two lines (`identity_snapshot(codex_manifest=...)` then
        `claim_snapshot`, supervisor.py ~16029-16037) run against it. Before
        the fix the pool held a `WarmProc` wrapping a real `claude`, so this
        claim returned a process the leg then threw away as `provider-lane`.
        """
        built, popen_calls = [], []
        wp = self._spawn(self.nid, built, popen_calls)

        self.assertEqual(popen_calls, [],
                         "a Claude CLI was spawned for a Codex-harness agent")
        self.assertEqual(len(built), 1, "no app-server was launched")
        self.assertIsInstance(wp, warmpool.CodexWarmProc)
        # the launch really is the OpenRouter one, not the user's own codex
        joined = " ".join(built[0].get("config_overrides") or [])
        self.assertIn('base_url="https://openrouter.ai/api/v1"', joined)
        self.assertNotEqual(built[0].get("codex_home"),
                            os.path.expanduser("~/.codex"))

        slug = self.org.d["slug"]
        with warmpool._pool_lock:
            warmpool._pool[(slug, self.nid)] = wp
        self.addCleanup(lambda: warmpool._pool.pop((slug, self.nid), None))
        self.addCleanup(lambda: warmpool._serving.pop((slug, self.nid), None))

        manifest = supervisor._codex_startup_manifest(
            self.org, self.nid, write_ident=False)
        turn_hash, parts = warmpool.identity_snapshot(
            self.org, self.nid, codex_manifest=manifest)
        candidate, why = warmpool.claim_snapshot(
            slug, self.nid, turn_hash, parts)
        self.assertEqual(why, "warm-hit",
                         f"the turn could not claim its own parked process ({why})")
        self.assertIsInstance(candidate, warmpool.CodexWarmProc,
                              "the codex leg would discard this as provider-lane")

    def test_9e_a_claude_harness_openrouter_node_is_still_parked_by_POPEN(self):
        """The other half of the control: the fix must not move the agents
        that were already warming correctly."""
        nid = self._hire_claude_harness()
        built, popen_calls = [], []
        with patch.object(supervisor, "spawn_argv",
                          return_value=["claude", "--print"]), \
                patch.object(supervisor, "_build_cmd",
                             return_value=["claude", "--print"]), \
                patch.object(supervisor, "spawn_env", return_value={}), \
                patch.object(supervisor, "env_overrides", return_value={}):
            self._spawn(nid, built, popen_calls)
        self.assertEqual(built, [], "a claude-harness node launched an app-server")
        self.assertEqual(popen_calls, [["claude"]])


# ── §10 cancellation and error reporting on this lane (acceptance 7) ──────

class CancellationTests(_Patched):
    """Reviewer finding f3. The CLAIM was that cancellation and exit
    reporting are inherited from the codex lane rather than re-implemented —
    the reviewer attacked it and it held. What was missing was any test at
    all: acceptance condition 7 names cancellation by word, and the word did
    not appear in the suite. These assert the structural reason it is
    inherited, so the day somebody re-tiers that dispatch this fails.
    """

    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("orc-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.nid = self.org.hire(ledger.USER, None, TIER, 1, "cancel",
                                 harness=H.CODEX_CLI, **_HIRE)["node"]
        store.save_org(self.org)

    def test_10a_cancelling_reaches_the_CODEX_interrupt_not_a_claude_signal(self):
        """Written by the reviewer, kept verbatim in substance.

        `interrupt_turn` dispatches on the live handle the leg parked in
        state, never on the tier, the provider or the harness — so a
        Codex-harness OpenRouter turn is stopped by `turn/interrupt` on its
        own app-server for the same structural reason any codex turn is.
        """
        calls = []

        class FakeCodexTurn:
            def interrupt(self):
                calls.append("turn/interrupt")
                return True

        st = supervisor.state(self.org.d["slug"], self.nid)
        st["responding"] = True
        st["codex_turn"] = FakeCodexTurn()
        try:
            out = supervisor.interrupt_turn(self.org.d["slug"], self.nid)
        finally:
            for k in ("codex_turn", "responding", "interrupted"):
                st.pop(k, None)
        self.assertTrue(out["interrupted"])
        self.assertEqual(calls, ["turn/interrupt"])

    def test_10b_exit_status_mapping_has_no_tier_or_harness_input(self):
        """Why exit and error reporting are inherited rather than
        re-implemented: `codexrun`'s status vocabulary is a property of the
        app-server protocol, and nothing in this branch gives it a lane to
        branch on. If that ever stops being true, this lane needs its own
        error-propagation tests and this is the failure that says so."""
        import inspect

        from orgtree import codexrun
        src = inspect.getsource(codexrun)
        for word in ("CODEX_TIERS", "openrouter_harness", "harness_for"):
            self.assertNotIn(word, src,
                             f"codexrun now branches on {word}; exit and "
                             f"error reporting is no longer lane-agnostic "
                             f"and this suite must start asserting it "
                             f"directly")

    def test_10c_the_interrupt_dispatch_reads_no_tier_provider_or_harness(self):
        """The structural claim itself, asserted rather than argued."""
        import inspect
        src = inspect.getsource(supervisor.interrupt_turn)
        for word in ("CODEX_TIERS", "codex_harness_turn", "harness_for",
                     "provider_of", "is_tier"):
            self.assertNotIn(word, src,
                             f"interrupt_turn now branches on {word}; "
                             f"cancellation is no longer inherited by "
                             f"construction on this lane")


# ── §11 native desktop import is OUT OF SCOPE for this lane ───────────────

class NativeImportTests(_Patched):
    """Reviewer finding f4. `desktop_native.provider_for` bucketed every
    `or-` tier as claude-shaped, and its consumers read that bucket as "has a
    ~/.claude transcript jsonl". A Codex-harness OpenRouter agent has no such
    file — its rollout lives under the lane's own private CODEX_HOME, which
    is not the user's ~/.codex either, so neither existing branch is right.

    Native import of such an agent is NOT implemented here. What these assert
    is that it is now REFUSED by name instead of being answered wrongly.
    """

    def setUp(self):
        self.avail()
        self.org = ledger.Org.create("orn-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID
        self.org.d["tiers"]["haiku"] = 1.0

    def _node(self, harness=None):
        kw = {"harness": harness} if harness else {}
        nid = self.org.hire(ledger.USER, None, TIER, 1,
                            "n" + uuid.uuid4().hex[:6], **_HIRE, **kw)["node"]
        return self.org.node(nid)

    def test_11a_a_codex_harness_openrouter_node_is_its_OWN_native_bucket(self):
        self.assertEqual(desktop_native.provider_for(self._node(H.CODEX_CLI)),
                         desktop_native.OPENROUTER_CODEX)

    def test_11b_a_claude_harness_openrouter_node_is_UNCHANGED(self):
        self.assertEqual(desktop_native.provider_for(self._node(H.CLAUDE_CODE)),
                         "openrouter")

    def test_11c_an_agent_that_predates_the_harness_axis_is_UNCHANGED(self):
        """Every OpenRouter node in every already-imported org. This fix must
        not re-bucket a single one of them."""
        node = self._node()
        node.pop("or_harness", None)
        self.assertEqual(desktop_native.provider_for(node), "openrouter")

    def test_11d_a_real_codex_tier_and_a_claude_tier_are_UNCHANGED(self):
        self.org.d["tiers"]["luna"] = 0.2
        luna = self.org.hire(ledger.USER, None, "luna", 1, "lu", **_HIRE)["node"]
        hk = self.org.hire(ledger.USER, None, "haiku", 1, "hk", **_HIRE)["node"]
        self.assertEqual(desktop_native.provider_for(self.org.node(luna)), "codex")
        self.assertEqual(desktop_native.provider_for(self.org.node(hk)), "claude")

    def test_11e_locating_its_native_conversation_is_REFUSED_by_name(self):
        """The wrong answer this replaces: a search of ~/.claude/projects for
        a jsonl that cannot exist, ending in "Native Claude transcript
        missing" — a sentence that sends the user looking for a file nothing
        ever wrote."""
        import pathlib
        node = self._node(H.CODEX_CLI)
        node["session_id"] = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
        with self.assertRaises(desktop_native.NativeHeld) as caught:
            desktop_native.locate(pathlib.Path("."), self.org.d["slug"],
                                  "n", node, {})
        self.assertIn("not yet verified for this provider", str(caught.exception))

    def test_11f_every_native_site_ends_in_an_EXPLICIT_refusal(self):
        """Why one bucket was enough: this module already refuses by name for
        a provider it does not recognise, at every site that would otherwise
        have produced a claude artefact. If somebody removes one of those
        else-branches, an unrecognised bucket starts falling through silently
        and this is the failure that says so."""
        import inspect
        for fn, sentence in (
                (desktop_native.retire_native_binding,
                 "Native successor validation is not yet supported"),
                (desktop_native.locate,
                 "Native conversation cloning is not yet verified"),
                (ledger.Org._native_bearer_binding,
                 "Native bearer validation is unavailable")):
            self.assertIn(sentence, inspect.getsource(fn),
                          f"{fn.__name__} lost its explicit refusal")


# ── §12 hiring while the chosen harness is unusable (finding f2) ──────────

class HireWhenUnavailableTests(_Patched):
    """Reviewer finding f2. The stored preference may name a CLI that has
    since gone away. Stamping it onto a BRAND NEW agent produced one that
    was dead on arrival — refusing on every turn it ever took — hired from a
    panel that had just said the other harness was the only one available.

    A new hire is not an existing agent, so the no-migration rule has nothing
    to say about it: nobody is being moved, because nobody has been anywhere.
    """

    def setUp(self):
        self.org = ledger.Org.create("oru-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID

    def _hire(self, **kw):
        return self.org.hire(ledger.USER, None, TIER, 1,
                             "n" + uuid.uuid4().hex[:6], **_HIRE, **kw)["node"]

    def test_12a_a_new_hire_gets_the_harness_that_actually_WORKS(self):
        self.avail(codex=GONE)
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            nid = self._hire()
        self.assertEqual(self.org.harness_for(nid), H.CLAUDE_CODE)
        # and the whole point: it can actually start
        self.assertEqual(H.resolve(self.org.harness_for(nid)), H.CLAUDE_CODE)

    def test_12b_the_STORED_preference_is_not_rewritten(self):
        """Substituting for one hire must not quietly change the machine
        setting — the moment Codex comes back, hires go back to it."""
        self.avail(codex=GONE)
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI) as read:
            self._hire()
        self.assertGreater(read.call_count, 0)
        self.avail()            # codex is back
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            back = self._hire()
        self.assertEqual(self.org.harness_for(back), H.CODEX_CLI,
                         "the substitution was written back to the setting")

    def test_12c_an_EXPLICIT_choice_is_still_honoured_and_still_refuses(self):
        """Naming a harness is a deliberate act, and a deliberate act is
        allowed to fail loudly at launch. The substitution is only ever for
        the machine default."""
        self.avail(codex=GONE)
        nid = self._hire(harness=H.CODEX_CLI)
        self.assertEqual(self.org.harness_for(nid), H.CODEX_CLI)
        with self.assertRaises(H.HarnessUnavailable):
            H.resolve(self.org.harness_for(nid))

    def test_12d_with_NEITHER_usable_the_stored_value_is_kept(self):
        """There is no honest substitution to make, so nothing is invented:
        the agent refuses with the real condition, which is the only true
        thing left to say."""
        self.avail(claude=NO_CLAUDE, codex=GONE)
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            nid = self._hire()
        self.assertEqual(self.org.harness_for(nid), H.CODEX_CLI)
        with self.assertRaises(H.HarnessUnavailable):
            H.resolve(self.org.harness_for(nid))

    def test_12e_EXISTING_agents_are_still_never_moved(self):
        """The user's ruling, re-asserted against the new substitution: it
        applies at the moment of hire and never afterwards."""
        self.avail()
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            old = self._hire()
        self.assertEqual(self.org.harness_for(old), H.CODEX_CLI)
        self.avail(codex=GONE)          # codex disappears underneath it
        self.assertEqual(self.org.harness_for(old), H.CODEX_CLI,
                         "an existing agent was migrated by the substitution")

    def test_12f_both_available_changes_nothing_at_all(self):
        self.avail()
        self.assertEqual(H.for_new_hire(H.CODEX_CLI), H.CODEX_CLI)
        self.assertEqual(H.for_new_hire(H.CLAUDE_CODE), H.CLAUDE_CODE)
        self.assertEqual(H.for_new_hire(None), H.CLAUDE_CODE)


# ── §13 the mutation floor: are these decisions actually watched? ──────────

class MutationTests(_Patched):
    """Every test above passes on code that works. These assert that the
    tests would FAIL on code that does not — the only way to know a suite is
    load-bearing rather than decorative.

    Each case breaks one real decision and asserts the specific promise dies
    with it.
    """

    def test_13a_a_selector_that_ignored_availability_would_be_caught(self):
        self.avail(codex=GONE)
        s = H.selector(None)
        self.assertFalse(s["enabled"])
        # the mutation: a selector hard-coded to "always offer both"
        mutated = {"enabled": True, "unavailable": False,
                   "selected": H.CLAUDE_CODE}
        self.assertNotEqual(mutated["enabled"], s["enabled"])

    def test_13b_a_resolve_that_fell_back_would_be_caught(self):
        """The fallback this ticket forbids, written out: if `resolve`
        answered with the available harness instead of raising, THIS is the
        assertion that fires."""
        self.avail(codex=GONE)
        fell_back = None
        try:
            fell_back = H.resolve(H.CODEX_CLI)
        except H.HarnessUnavailable:
            pass
        self.assertIsNone(fell_back,
                          f"resolve silently returned {fell_back!r} for a "
                          f"harness that is not available")

    def test_13c_a_harness_read_from_the_SETTING_would_be_caught(self):
        """The migration the user ruled against, written out: `harness_for`
        reading the live machine setting instead of the node's stamp."""
        org = ledger.Org.create("orm-" + uuid.uuid4().hex[:8])
        org.d["tiers"][TIER] = 1.0
        org.d["models"][TIER] = MODEL_ID
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CLAUDE_CODE):
            nid = org.hire(ledger.USER, None, TIER, 1, "m", **_HIRE)["node"]
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI) as setting:
            got = org.harness_for(nid)
        self.assertEqual(got, H.CLAUDE_CODE)
        self.assertEqual(setting.call_count, 0,
                         "harness_for consulted the machine setting; it must "
                         "read the node's own stamp and nothing else")

    def test_13d_a_warm_pool_that_branched_on_the_TIER_would_be_caught(self):
        """Reviewer finding f1, written out as its own mutation. The whole
        defect is one expression: ask `model in providers.CODEX_TIERS` and an
        `or-` node on Codex CLI takes the Claude branch in both warm-pool
        functions. This asserts the two sites do NOT ask that question."""
        import inspect
        for fn in (warmpool.identity_snapshot, warmpool._spawn_for):
            # CODE ONLY. Both functions carry a comment naming the expression
            # they used to ask, and a scan that counted that would pass on
            # code that had quietly gone back to it.
            src = "\n".join(
                line for line in inspect.getsource(fn).splitlines()
                if not line.lstrip().startswith("#"))
            self.assertNotIn("providers.CODEX_TIERS", src,
                             f"{fn.__name__} decides the harness from the "
                             f"TIER again; a Codex-harness OpenRouter agent "
                             f"is parked as a claude process")
            self.assertIn("codex_harness_turn", src,
                          f"{fn.__name__} no longer asks the one predicate")

    def test_13e_a_hire_that_blindly_stamped_the_SETTING_would_be_caught(self):
        """Reviewer finding f2. The mutation is `chosen = stored` — which is
        what the code used to be — and this is the assertion that dies with
        it."""
        self.avail(codex=GONE)
        org = ledger.Org.create("orx-" + uuid.uuid4().hex[:8])
        org.d["tiers"][TIER] = 1.0
        org.d["models"][TIER] = MODEL_ID
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI) as stored:
            nid = org.hire(ledger.USER, None, TIER, 1, "x", **_HIRE)["node"]
        stamped = org.harness_for(nid)
        self.assertNotEqual(stamped, stored.return_value,
                            "hire stamped the stored value while it was "
                            "unusable; the agent is dead on arrival")
        self.assertEqual(H.resolve(stamped), stamped)

    def test_13f_a_native_bucket_that_still_read_claude_shaped_would_be_caught(self):
        """Reviewer finding f4. The mutation is dropping the harness read in
        `provider_for`, which puts a Codex-harness OpenRouter agent back in
        the set that means "has a ~/.claude transcript"."""
        org = ledger.Org.create("orz-" + uuid.uuid4().hex[:8])
        org.d["tiers"][TIER] = 1.0
        org.d["models"][TIER] = MODEL_ID
        nid = org.hire(ledger.USER, None, TIER, 1, "z",
                       harness=H.CODEX_CLI, **_HIRE)["node"]
        got = desktop_native.provider_for(org.node(nid))
        self.assertNotIn(got, {"claude", "openrouter"},
                         "a Codex-harness agent is claude-shaped again; the "
                         "native paths will look for a transcript that "
                         "cannot exist")


# ── §14 no CLI spawn under the document lock (finding f5) ─────────────────

def _harness_calls(fn):
    """Every `new_hire_harness(...)` call in `fn`, split into the ones that
    sit inside a block holding the document lock and the ones that do not.

    ⚠ AST, NOT TEXT. A `grep` for the call and a `grep` for the lock can only
    compare line numbers, and these doors take the lock more than once — the
    hoisted-out halt / unhalt / continue_on branches each take their own,
    earlier in the same function. Line order would therefore report a
    correctly hoisted call as being inside a lock it has nothing to do with.
    Walking the tree asks the question that is actually meant: is the call a
    DESCENDANT of a lock-holding `with`?
    """
    import ast
    import inspect
    import textwrap
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    locked = [n for n in ast.walk(tree)
              if isinstance(n, ast.With)
              and any(("DOC_LOCK" in ast.unparse(i.context_expr)
                       or "write_org" in ast.unparse(i.context_expr))
                      for i in n.items)]
    held = {id(x) for w in locked for x in ast.walk(w)}
    calls = [n for n in ast.walk(tree)
             if isinstance(n, ast.Call)
             and getattr(n.func, "id", None) == "new_hire_harness"]
    return calls, [c for c in calls if id(c) in held]


class DocLockTests(_Patched):
    """Reviewer finding f5 — and it was introduced by the f2 fix above, which
    is why it is a section of its own rather than a line in §12.

    Choosing a NEW hire's harness asks whether the Codex CLI can run, and
    `openrouter_harness.codex_state` answers that by SPAWNING one. Every door
    that hires calls `ledger.hire` while holding `store.DOC_LOCK`, and that
    lock is process-global: a subprocess spawn under it stalls every other org
    operation in the process, not just the request that asked for it.
    account_fallback's standing rule — written out at the
    `orgtree_continue_on` branch of the agent door — is that provider reads
    never happen under DOC_LOCK, and this was one.

    The fix is that every door answers the question BEFORE taking the lock and
    hands the answer to `hire` as its explicit choice.

    ⚠ WHAT EACH HALF PROVES, because they are not the same kind of evidence.
    §14a-§14d are EXECUTED: they run the code and watch it. §14e and §14f are
    STRUCTURAL — they read the doors' syntax trees. No unit test can observe a
    lock that a real HTTP request holds without standing up the whole app, so
    the structural half is what stops the hoist from being quietly undone, and
    it is labelled as structure rather than dressed up as behaviour.
    """

    def setUp(self):
        from orgtree import api
        self.api = api
        self.org = ledger.Org.create("orl-" + uuid.uuid4().hex[:8])
        self.org.d["tiers"][TIER] = 1.0
        self.org.d["models"][TIER] = MODEL_ID

    def _detonate(self):
        """Replace every path to a CLI with a detonator. If anything under
        test asks a provider question, the test dies at the question."""
        boom = AssertionError("a provider was read where none may be")
        for name in ("claude_state", "codex_state", "for_new_hire"):
            p = patch.object(H, name, side_effect=boom)
            p.start()
            self.addCleanup(p.stop)

    def test_14a_an_explicit_harness_makes_hire_read_NO_provider_at_all(self):
        """THE PROPERTY EVERY DOOR DEPENDS ON. Handing `hire` the answer has
        to actually stop it asking — if it asked anyway, hoisting the call
        would have bought nothing but a second spawn."""
        self._detonate()
        nid = self.org.hire(ledger.USER, None, TIER, 1, "a",
                            harness=H.CODEX_CLI, **_HIRE)["node"]
        self.assertEqual(self.org.harness_for(nid), H.CODEX_CLI)

    def test_14b_a_tier_with_no_harness_to_choose_is_answered_without_asking(self):
        """A claude or codex tier has exactly one CLI by construction. The
        door must not probe anything to work that out."""
        self._detonate()
        self.assertIsNone(self.api.new_hire_harness("opus"))
        self.assertIsNone(self.api.new_hire_harness(""))
        self.assertIsNone(self.api.new_hire_harness(None))

    def test_14c_an_explicit_choice_comes_back_untouched_and_unprobed(self):
        """Naming a harness is a deliberate act (§12c). The door may not
        substitute for it, and it has nothing to ask in order to pass it on."""
        self._detonate()
        self.assertEqual(
            self.api.new_hire_harness(TIER, H.CODEX_CLI), H.CODEX_CLI)

    def test_14d_the_door_answers_exactly_what_hire_would_have(self):
        """The hoist must not change the ANSWER, only where it is computed.
        Stored codex, codex gone: both routes say claude-code."""
        self.avail(codex=GONE)
        with patch.object(appsettings, "openrouter_harness",
                          return_value=H.CODEX_CLI):
            self.assertEqual(self.api.new_hire_harness(TIER), H.CLAUDE_CODE)
            self.assertEqual(self.api.new_hire_harness(TIER),
                             H.for_new_hire(H.CODEX_CLI))

    def test_14e_every_door_resolves_the_harness_OUTSIDE_the_lock(self):
        """STRUCTURAL. The three doors that create a seat: the operator ops
        endpoint, the agent tool dispatch (`orgtree_hire` and `orgtree_staff`)
        and the quick-staff commit. Each must ask before it takes the lock."""
        for door in (self.api.org_op, self.api.agent_call,
                     self.api.quick_staff_select):
            with self.subTest(door=door.__name__):
                calls, inside = _harness_calls(door)
                self.assertTrue(calls,
                                f"{door.__name__} no longer resolves the "
                                f"new-hire harness at all; `hire` will ask "
                                f"under the document lock instead")
                self.assertEqual(
                    inside, [],
                    f"{door.__name__} resolves the harness INSIDE the "
                    f"document lock — that is a subprocess spawn holding a "
                    f"process-global lock (finding f5)")

    def test_14f_the_answer_is_carried_all_the_way_to_the_stamp(self):
        """STRUCTURAL. A door that resolves the harness and then drops it on
        the floor would pass §14e and still spawn under the lock, because
        `hire` would fall back to asking. Every function between the door and
        `hire` must take it and forward it."""
        import ast
        import inspect
        import textwrap
        for fn in (self.api._hire_seat, self.api._staff_call,
                   self.api._org_op_locked):
            with self.subTest(fn=fn.__name__):
                self.assertIn("harness", inspect.signature(fn).parameters,
                              f"{fn.__name__} cannot accept the door's answer")
        # …and the two that actually hire pass it on
        for fn in (self.api._hire_seat, self.api._org_op_locked):
            tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
            hires = [n for n in ast.walk(tree)
                     if isinstance(n, ast.Call)
                     and getattr(n.func, "attr", None) == "hire"]
            self.assertTrue(hires, f"{fn.__name__} no longer hires")
            for call in hires:
                self.assertIn(
                    "harness", [k.arg for k in call.keywords],
                    f"{fn.__name__} hires without passing the harness the "
                    f"door resolved; `hire` will probe under the lock")

    def test_14h_the_agent_door_hires_without_reading_a_provider(self):
        """EXECUTED, and it is the case §14f cannot see: a door that kept the
        keyword but handed it `None` would satisfy every structural check
        above and still make `hire` probe under the lock. So this drives the
        real `_hire_seat` — the same function `orgtree_hire` and
        `orgtree_staff` both run — with every provider reader replaced by a
        detonator, and asserts a seat comes out stamped."""
        self._detonate()
        p = patch.object(self.api, "provider_hire_gate", lambda *a, **k: None)
        p.start()
        self.addCleanup(p.stop)
        args = dict(_HIRE, tier=TIER, grant=1, name="h" + uuid.uuid4().hex[:6])
        out = self.api._hire_seat(self.org, self.org.d["slug"], ledger.USER,
                                  args, [], H.CODEX_CLI)
        self.assertEqual(self.org.harness_for(str(out["node"])), H.CODEX_CLI)

    def test_14g_the_staff_MENU_probe_never_asks_either(self):
        """`quickstaff.check_choice` runs a throwaway hire ONCE PER TIER to
        find out whether that tier could be staffed, and the menu is the thing
        the HireProbe exists to keep fast. It names a harness so that loop
        cannot turn into one CLI spawn per OpenRouter model."""
        import ast
        import inspect
        import textwrap
        from orgtree import quickstaff
        tree = ast.parse(textwrap.dedent(
            inspect.getsource(quickstaff.tier_block)))
        hires = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call)
                 and getattr(n.func, "attr", None) == "hire"]
        self.assertTrue(hires, "the trial hire is gone")
        for call in hires:
            self.assertIn("harness", [k.arg for k in call.keywords],
                          "the Staff… menu's trial hire asks for a harness "
                          "again — one CLI spawn per OpenRouter tier")


if __name__ == "__main__":
    unittest.main()
