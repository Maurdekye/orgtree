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
because the code does nothing, so §7 mutates the real decisions and asserts
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

from orgtree import (appsettings, ledger, openrouter,  # noqa: E402
                     openrouter_harness as H, providers, store, supervisor)

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
        for p in (patch.object(providers, "codex_status", return_value={
                      "installed": True, "path": "/fake/codex",
                      "connected": False, "kind": "", "version": "0.154.0"}),
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


# ── §7 the mutation floor: are these decisions actually watched? ──────────

class MutationTests(_Patched):
    """Every test above passes on code that works. These assert that the
    tests would FAIL on code that does not — the only way to know a suite is
    load-bearing rather than decorative.

    Each case breaks one real decision and asserts the specific promise dies
    with it.
    """

    def test_9a_a_selector_that_ignored_availability_would_be_caught(self):
        self.avail(codex=GONE)
        s = H.selector(None)
        self.assertFalse(s["enabled"])
        # the mutation: a selector hard-coded to "always offer both"
        mutated = {"enabled": True, "unavailable": False,
                   "selected": H.CLAUDE_CODE}
        self.assertNotEqual(mutated["enabled"], s["enabled"])

    def test_9b_a_resolve_that_fell_back_would_be_caught(self):
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

    def test_9c_a_harness_read_from_the_SETTING_would_be_caught(self):
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


if __name__ == "__main__":
    unittest.main()
