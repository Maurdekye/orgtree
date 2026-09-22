"""Explicit GPT-6 additions preserve 5.6 routing, prices and account identity."""
import copy
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401

_root = tempfile.TemporaryDirectory(prefix="orgtree-gpt6-additional-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import codex_route, ledger, providers, store, supervisor


def tearDownModule():
    store._POOL.close_all("gpt6-cost")
    _root.cleanup()


class AdditionalModels(unittest.TestCase):
    models = {"gpt-6-sol": 2, "gpt-6-luna": 0.1}

    def test_inventory_controls_exact_additional_rows(self):
        for known in (None, set(), {"gpt-5.6-sol", "gpt-5.6-luna"}):
            self.assertFalse(set(self.models) & {r["tier"] for r in providers.codex_tiers(known)})
        rows = {r["tier"]: r for r in providers.codex_tiers(set(self.models))}
        for model, seat in self.models.items():
            self.assertEqual((rows[model]["model"], rows[model]["seat"], rows[model]["provider"]),
                             (model, seat, "openai"))
            with patch.object(providers, "codex_model_inventory", return_value={
                    "available": True, "models": [model]}):
                self.assertTrue(providers.conditional_codex_availability(model, status={})["enabled"])
            with patch.object(providers, "codex_model_inventory", return_value={
                    "available": True, "models": ["gpt-5.6-sol"]}):
                self.assertFalse(providers.conditional_codex_availability(model, status={})["enabled"])

    def test_saved_org_adds_new_tiers_without_renaming_existing_nodes(self):
        org = ledger.Org.create("gpt6-migrate")
        for tier in ("sol", "luna"):
            org.hire(ledger.USER, None, tier, 10, tier)
            org.node(tier)["account"] = "openai-1"
        for model in self.models:
            org.d["models"].pop(model)
            org.d["tiers"].pop(model)
        before = copy.deepcopy(org.nodes)
        loaded = ledger.Org(json.loads(json.dumps(org.d)))
        self.assertEqual(loaded.nodes, before)
        self.assertEqual(loaded.model_for("sol"), "gpt-5.6-sol")
        self.assertEqual(loaded.model_for("luna"), "gpt-5.6-luna")
        for model, seat in self.models.items():
            self.assertEqual(loaded.d["models"][model], model)
            self.assertEqual(loaded.d["tiers"][model], seat)
            loaded.hire(ledger.USER, None, model, 0, model)
            loaded.node(model)["account"] = "openai-1"
            roundtrip = ledger.Org(json.loads(json.dumps(loaded.d)))
            self.assertEqual(roundtrip.model_for(model), model)
            self.assertEqual(roundtrip.node(model)["account"], "openai-1")
            self.assertEqual(providers.provider_of(model), "openai")
            route = codex_route.resolve(model, login_kind="chatgpt", board={},
                marks=None, account="openai-1", direct_model=roundtrip.model_for(model))
            self.assertEqual((route["model"], route["account"], route["route"]),
                             (model, "openai-1", "direct"))

    def test_model_specific_dollar_rates_and_unpinned_6_context(self):
        usage = {"total": {"inputTokens": 1_000_000,
                          "cachedInputTokens": 500_000, "outputTokens": 100_000}}
        self.assertAlmostEqual(providers.codex_cost("sol", usage), 4.2)
        self.assertAlmostEqual(providers.codex_cost("luna", usage), 0.23)
        self.assertEqual(providers.CODEX_MODELS["sol"], "gpt-5.6-sol")
        self.assertEqual(providers.CODEX_MODELS["luna"], "gpt-5.6-luna")
        self.assertEqual(codex_route.DIRECT_LUNA_MODEL, "gpt-5.6-luna")
        self.assertEqual(providers.CODEX_PRICES["gpt-6-sol"], (2, 0.2, 10))
        self.assertEqual(providers.CODEX_PRICES["gpt-6-luna"], (0.1, 0.01, 0.6))
        self.assertAlmostEqual(providers.codex_cost("gpt-6-sol", usage), 2.1)
        self.assertAlmostEqual(providers.codex_cost("gpt-6-luna", usage), 0.115)
        for model in self.models:
            self.assertIsNone(supervisor.tier_context(model))

    def test_model_price_persists_on_real_turn_accounting(self):
        org = store.create_org("gpt6-cost")
        org.hire(ledger.USER, None, "gpt-6-sol", 0, "agent")
        store.save_org(org)
        result = {"status": "done", "usage": {"output_tokens": 100},
                  "total_cost_usd": providers.codex_cost("gpt-6-sol",
                      {"total": {"outputTokens": 100}})}
        supervisor._after_turn("gpt6-cost", "agent", org, result, {"started_at": "2026-09-22T18:00:00Z"})
        loaded = store.load_org("gpt6-cost")
        self.assertAlmostEqual(loaded.node("agent")["cost_usd"], 0.001)
        self.assertAlmostEqual(loaded.node("agent")["turns"][-1]["cost"], 0.001)
        self.assertFalse(loaded.node("agent").get("cost_usd_unknown", False))
        self.assertIsNot(loaded.node("agent")["turns"][-1].get("cost_complete"), False)

    def test_tier_repricing_returns_credits_and_preserves_saved_models(self):
        org = ledger.Org.create("gpt6-reprice")
        org.d["tiers"].update(sol=5, luna=0.2)
        org.hire(ledger.USER, None, "haiku", 6, "parent")
        for tier in ("sol", "luna"):
            org.hire(ledger.USER, "parent", tier, 0, tier)
            org.node(tier)["account"] = "openai-1"
        before = copy.deepcopy(org.nodes)
        self.assertAlmostEqual(org.free("parent"), 0.8)
        loaded = ledger.Org(json.loads(json.dumps(org.d)))
        self.assertEqual(loaded.nodes, before)
        self.assertEqual((loaded.seat_cost("sol"), loaded.seat_cost("luna")), (2, 0.1))
        self.assertAlmostEqual(loaded.free("parent"), 3.9)
        self.assertEqual(loaded.model_for("sol"), "gpt-5.6-sol")
        self.assertEqual(loaded.model_for("luna"), "gpt-5.6-luna")
        self.assertEqual(ledger.Org(copy.deepcopy(loaded.d)).d, loaded.d)
        loaded.d["tiers"].update(sol=7, luna=0.3)
        custom = ledger.Org(copy.deepcopy(loaded.d))
        self.assertEqual((custom.seat_cost("sol"), custom.seat_cost("luna")), (7, 0.3))


if __name__ == "__main__":
    unittest.main()
