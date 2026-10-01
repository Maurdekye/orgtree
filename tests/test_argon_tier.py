"""Gemini 4 Argon is a CONDITIONAL Antigravity tier.

Docket `argon-model-support-gemini-ultra-via-agy-cli-1-2`. The user (2026-10-01)
wants Argon selectable as soon as the Antigravity CLI offers it, with no
Orgtree update at that point, and never offered while it cannot run. The user
ruled the model id is exactly `gemini-4-argon`; nothing else may match.

On 2026-10-01 `agy models` (agy 1.2.14) did NOT list it for the user's account,
so every door is checked both ways: with a registry that lists it (as agy
prints ids: `gemini-4-argon-high`) and with the registry measured that day.

  §1 the tier tables: seat, model id, letter, effort, price (the placeholders
     copy pro, by the coordinator's ruling)
  §2 what counts as "listed" — the id bare or with an agy effort suffix only
  §3 the offered tier rows follow the registry
  §4 availability and the hire gate (hire, switch and tier rehire all pass
     through `provider_hire_gate`): refused while unlisted, re-probed fresh
     before refusing, admitted once listed
  §5 an org saved before Argon existed gains the tier on load (add-only)
  §6 the vocabularies that copy ledger.TIERS know it
"""
import os
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="argon-tier-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="argon-tier-tests")

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
load_app()
from orgtree import api, appsettings, ledger, providers, store, turnread, turnusage

#: `agy models` for the user's account, measured 2026-10-01 06:42Z (agy 1.2.14)
MEASURED = [
    "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
    "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
    "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
    "gemini-3.1-pro-high", "gemini-3.1-pro-low", "claude-sonnet-4-6",
    "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
]
#: the same registry on the day Google turns Argon on for the account
WITH_ARGON = ["gemini-4-argon-high", "gemini-4-argon-low", *MEASURED]


def _status(models):
    return {"installed": True, "connected": True, "kind": "oauth",
            "email": "user@example.com", "path": "agy", "source": "install",
            "version": "1.2.14", "models": list(models)}


def tearDownModule():
    store._POOL.close_all("argon-tier")
    _root.cleanup()


class TierTables(unittest.TestCase):
    def test_argon_rows(self):
        self.assertEqual(ledger.MODELS["argon"], "gemini-4-argon")
        self.assertIn("argon", providers.ANTIGRAVITY_TIERS)
        self.assertIn("argon", providers.CONDITIONAL_ANTIGRAVITY_TIERS)
        self.assertEqual(providers.ANTIGRAVITY_MODELS["argon"], "gemini-4-argon")
        self.assertEqual(providers.provider_of("argon"), "google")
        self.assertTrue(providers.is_known_tier("argon"))
        self.assertNotIn("argon", providers.CLAUDE_TIERS)
        # flash and pro stay unconditional
        self.assertNotIn("flash", providers.CONDITIONAL_ANTIGRAVITY_TIERS)
        self.assertNotIn("pro", providers.CONDITIONAL_ANTIGRAVITY_TIERS)

    def test_placeholders_copy_pro(self):
        # ⚠ PLACEHOLDERS (coordinator ruling 2026-10-01): seat, effort and
        # price copy the top Gemini tier until the user sets Argon's own
        self.assertEqual(ledger.TIERS["argon"], ledger.TIERS["pro"])
        for effort in ledger.Org.EFFORTS:
            self.assertEqual(providers.antigravity_effort("argon", effort),
                             providers.antigravity_effort("pro", effort))
        self.assertEqual(providers.ANTIGRAVITY_PRICES["gemini-4-argon"],
                         providers.ANTIGRAVITY_PRICES["gemini-3.1-pro"])
        usage = {"model": "gemini-4-argon", "input": 1_000_000, "cached": 0,
                 "output": 1_000_000, "thinking": 0, "last_prompt": 1000,
                 "requests": 1}
        pro = dict(usage, model="gemini-3.1-pro")
        self.assertEqual(providers.antigravity_cost(usage),
                         providers.antigravity_cost(pro))


class Listed(unittest.TestCase):
    def test_bare_and_effort_suffixed_ids_count(self):
        for reg in (["gemini-4-argon"], ["gemini-4-argon-high"],
                    ["gemini-4-argon-low"], ["gemini-4-argon-medium"],
                    ["gemini-4-argon-max"], WITH_ARGON):
            with self.subTest(reg=reg):
                self.assertTrue(
                    providers.antigravity_model_listed("gemini-4-argon", reg))

    def test_nothing_else_counts(self):
        for reg in (MEASURED, [], None, ["gemini-4-argon-preview"],
                    ["gemini-4-argon-high-x"], ["x-gemini-4-argon"],
                    ["gemini-4-argonite"], ["Gemini 4 Argon"], ["argon"],
                    ["gemini-4-argon-"], ["GEMINI-4-ARGON"]):
            with self.subTest(reg=reg):
                self.assertFalse(
                    providers.antigravity_model_listed("gemini-4-argon", reg))
        self.assertFalse(providers.antigravity_model_listed("", WITH_ARGON))


class OfferedRows(unittest.TestCase):
    def test_rows_follow_the_registry(self):
        for why, reg in (("measured 2026-10-01", MEASURED),
                         ("empty", []), ("no read", None)):
            with self.subTest(why):
                tiers = [r["tier"] for r in providers.antigravity_tiers(reg)]
                self.assertEqual(tiers, ["flash", "pro"])
        rows = {r["tier"]: r for r in providers.antigravity_tiers(WITH_ARGON)}
        self.assertEqual(sorted(rows), ["argon", "flash", "pro"])
        self.assertEqual(rows["argon"], {
            "tier": "argon", "provider": "google", "seat": 2,
            "model": "gemini-4-argon", "letter": "A"})

    def test_providers_payload_google_rows_follow_the_probe(self):
        codex_off = {"installed": False, "connected": False}
        for reg, want in ((MEASURED, False), (WITH_ARGON, True)):
            with self.subTest(argon_listed=want), \
                    patch.object(providers, "antigravity_status",
                                 return_value=_status(reg)), \
                    patch.object(providers, "codex_status",
                                 return_value=dict(codex_off)):
                doc = providers.providers_payload({"installed": True,
                                                   "connected": True})
                google = next(p for p in doc["providers"] if p["id"] == "google")
                tiers = [t["tier"] for t in google["tiers"]]
                self.assertEqual("argon" in tiers, want, tiers)
                self.assertIn("flash", tiers)


class Availability(unittest.TestCase):
    def test_unlisted_is_refused_after_one_fresh_probe(self):
        calls = []

        def probe(force=False):
            calls.append(force)
            return _status(MEASURED)
        with patch.object(providers, "antigravity_status", side_effect=probe):
            got = providers.conditional_antigravity_availability(
                "argon", status=_status(MEASURED))
        self.assertFalse(got["enabled"])
        self.assertEqual(got["evidence"], "model-missing")
        self.assertIn("gemini-4-argon", got["reason"])
        self.assertEqual(calls, [True], "a stale list must be re-read fresh once")

    def test_a_fresh_probe_that_lists_it_admits(self):
        # Google switched it on after the cached read: not refused on the
        # stale list
        with patch.object(providers, "antigravity_status",
                          return_value=_status(WITH_ARGON)) as st:
            got = providers.conditional_antigravity_availability(
                "argon", status=_status(MEASURED))
        self.assertTrue(got["enabled"])
        st.assert_called_once_with(force=True)

    def test_listed_in_the_cached_read_needs_no_probe(self):
        with patch.object(providers, "antigravity_status") as st:
            got = providers.conditional_antigravity_availability(
                "argon", status=_status(WITH_ARGON))
        self.assertEqual(got, {"enabled": True, "reason": None,
                               "evidence": "model-present"})
        st.assert_not_called()

    def test_unconditional_tiers_never_probe(self):
        with patch.object(providers, "antigravity_status") as st:
            for tier in ("flash", "pro"):
                self.assertEqual(
                    providers.conditional_antigravity_availability(tier),
                    {"enabled": True, "reason": None,
                     "evidence": "not-conditional"})
        st.assert_not_called()

    def test_tier_availability(self):
        with patch.object(providers, "antigravity_status",
                          return_value=_status(MEASURED)):
            ok, why = providers.tier_availability("argon")
            self.assertFalse(ok)
            self.assertIn("gemini-4-argon", why or "")
            self.assertEqual(providers.tier_availability("flash"), (True, None))
        with patch.object(providers, "antigravity_status",
                          return_value=_status(WITH_ARGON)):
            self.assertEqual(providers.tier_availability("argon"), (True, None))

    def test_hire_gate(self):
        org = ledger.Org.create("argon-gate")
        with patch.object(providers, "antigravity_status",
                          return_value=_status(MEASURED)):
            with self.assertRaisesRegex(ledger.LedgerError,
                                        "conditional Antigravity tier.*gemini-4-argon"):
                api.provider_hire_gate(org, "argon")
            api.provider_hire_gate(org, "flash")          # positive control
        with patch.object(providers, "antigravity_status",
                          return_value=_status(WITH_ARGON)):
            api.provider_hire_gate(org, "argon")          # must not raise

    def test_hire_gate_keeps_the_other_refusals(self):
        org = ledger.Org.create("argon-gate-neg")
        with patch.object(providers, "antigravity_status",
                          return_value={**_status(WITH_ARGON),
                                        "installed": False}):
            with self.assertRaisesRegex(ledger.LedgerError, "not installed"):
                api.provider_hire_gate(org, "argon")
        appsettings.set_provider_enabled("google", False)
        try:
            with self.assertRaisesRegex(ledger.LedgerError, "turned off"):
                api.provider_hire_gate(org, "argon")
        finally:
            appsettings.set_provider_enabled("google", True)

    def test_plain_rehire_door_is_not_gated_on_the_registry(self):
        # D-197: a node ALREADY on argon restarts as it was; only the user's
        # durable provider switch is checked on that door
        org = ledger.Org.create("argon-rehire")
        with patch.object(providers, "antigravity_status",
                          return_value=_status(MEASURED)) as st:
            api.provider_hire_gate(org, "argon", user_choice_only=True)
        st.assert_not_called()


class ExistingOrgs(unittest.TestCase):
    def test_an_org_saved_before_argon_gains_it_on_load(self):
        doc = ledger.Org.create("argon-old").d
        doc["tiers"].pop("argon")
        doc["models"].pop("argon")
        doc["tiers"]["pro"] = 7          # an operator's own price stays
        org = ledger.Org(doc)
        self.assertEqual(org.d["tiers"]["argon"], 2)
        self.assertEqual(org.d["models"]["argon"], "gemini-4-argon")
        self.assertEqual(org.d["tiers"]["pro"], 7)

    def test_an_argon_node_runs_the_pinned_id(self):
        org = ledger.Org.create("argon-node")
        org.hire(ledger.USER, None, "argon", 0, "a1")
        nid = "a1"
        self.assertEqual(org.model_for(nid), "gemini-4-argon")
        self.assertEqual(providers.antigravity_effort("argon", org.effective_effort(nid)), "high")


class Vocabularies(unittest.TestCase):
    def test_copies_of_the_tier_vocabulary_know_argon(self):
        self.assertIn("argon", turnread.TIERS)
        self.assertIn("argon", turnusage._SAFE_MODELS)


if __name__ == "__main__":
    unittest.main()
