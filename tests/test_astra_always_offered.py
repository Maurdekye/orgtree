"""Astra is an ALWAYS-offered Codex tier, not one that waits for the inventory.

User, 2026-09-24 17:11Z: "can you make astra a given? not only conditionally
present". Until then `gpt-6-astra` was offered only when the account's live
Codex `model/list` named it, and a stale CLI pin hid it that way on
2026-09-04. These tests pin the new rule at every door that used to consult
the inventory — the tier rows, the availability check and the hire gate —
with an EMPTY inventory, an inventory that lacks `gpt-6-astra`, and no
inventory at all. Nothing else changes: the usage-window rule for Astra is
still covered by test_quick_staff (`account_reason` answers 100% for astra).
"""
import os
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="astra-always-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
load_app()
from orgtree import api, appsettings, ledger, providers, store

CONNECTED = {"installed": True, "connected": True, "path": "codex",
             "source": "path", "version": "0.155.1", "codex_home": ""}
OTHER_MODELS = ["gpt-6-sol", "gpt-6-luna", "gpt-6-terra", "gpt-5.6-sol"]
INVENTORIES = {
    "empty": {"available": True, "models": [], "error": None},
    "lacks astra": {"available": True, "models": OTHER_MODELS, "error": None},
    "unavailable": {"available": False, "models": [],
                    "error": "Codex model inventory refresh failed: boom"},
}


def tearDownModule():
    store._POOL.close_all("astra-always")
    _root.cleanup()


class AstraAlwaysOffered(unittest.TestCase):
    def test_astra_is_an_always_tier_and_nothing_is_conditional(self):
        self.assertIn("astra", providers._CODEX_ALWAYS_TIER_NAMES)
        self.assertNotIn("astra", providers.CONDITIONAL_CODEX_TIERS)
        self.assertEqual(providers.CODEX_MODELS["astra"], "gpt-6-astra")

    def test_tier_rows_offer_astra_whatever_the_inventory(self):
        for why, models in (("empty", set()),
                            ("lacks astra", set(OTHER_MODELS)),
                            ("no inventory read", None)):
            with self.subTest(why):
                rows = {r["tier"]: r for r in providers.codex_tiers(models)}
                self.assertIn("astra", rows)
                self.assertEqual(rows["astra"]["model"], "gpt-6-astra")
                self.assertEqual(rows["astra"]["letter"], "A")
                self.assertEqual(rows["astra"]["seat"],
                                 providers.CODEX_TIERS["astra"])
                # the legacy token stays out, as before
                self.assertNotIn("gpt-reserve", rows)

    def test_availability_never_consults_the_inventory_for_astra(self):
        for why, inventory in INVENTORIES.items():
            with self.subTest(why), \
                    patch.object(providers, "codex_status",
                                 return_value=dict(CONNECTED)), \
                    patch.object(providers, "codex_model_inventory",
                                 return_value=dict(inventory)) as inv:
                got = providers.conditional_codex_availability(
                    "astra", force=True, status=dict(CONNECTED))
                self.assertEqual(got, {"enabled": True, "reason": None,
                                       "evidence": "not-conditional"})
                self.assertEqual(providers.tier_availability("astra"),
                                 (True, None))
                inv.assert_not_called()

    def test_hire_gate_admits_astra_whatever_the_inventory(self):
        org = ledger.Org.create("astra-gate")
        for why, inventory in INVENTORIES.items():
            with self.subTest(why), \
                    patch.object(providers, "codex_status",
                                 return_value=dict(CONNECTED)), \
                    patch.object(providers, "codex_model_inventory",
                                 return_value=dict(inventory)) as inv:
                api.provider_hire_gate(org, "astra")     # must not raise
                inv.assert_not_called()

    def test_hire_gate_still_refuses_what_it_refused_before(self):
        # removing the inventory condition must not remove the other gates
        org = ledger.Org.create("astra-gate-neg")
        with patch.object(providers, "codex_status",
                          return_value={**CONNECTED, "connected": False}):
            with self.assertRaisesRegex(ledger.LedgerError, "not signed in"):
                api.provider_hire_gate(org, "astra")
        with patch.object(providers, "codex_status",
                          return_value={**CONNECTED, "installed": False}):
            with self.assertRaisesRegex(ledger.LedgerError, "not"):
                api.provider_hire_gate(org, "astra")
        appsettings.set_provider_enabled("openai", False)
        try:
            with self.assertRaisesRegex(ledger.LedgerError, "turned off"):
                api.provider_hire_gate(org, "astra")
        finally:
            appsettings.set_provider_enabled("openai", True)


if __name__ == "__main__":
    unittest.main()
