"""GPT-6 defaults are versions of the existing Sol/Luna price bands."""
import copy
import json
import os
import tempfile
import unittest

import import_provenance  # noqa: F401

_root = tempfile.TemporaryDirectory(prefix="orgtree-gpt6-version-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import codex_route, ledger, providers, store, supervisor


def tearDownModule():
    store._POOL.close_all("gpt6-version")
    _root.cleanup()


class ModelVersions(unittest.TestCase):
    def test_one_tier_per_price_band_and_default_first(self):
        rows = {r["tier"]: r for r in providers.codex_tiers(set())}
        self.assertFalse({"gpt-6-sol", "gpt-6-luna"} & rows.keys())
        for tier, seat in (("sol", 2), ("luna", 0.1)):
            self.assertEqual(rows[tier]["model"], f"gpt-6-{tier}")
            self.assertEqual(rows[tier]["seat"], seat)
            self.assertEqual(list(ledger.MODEL_VERSIONS[tier]), ["6", "5.6"])

    def test_saved_tiers_fold_and_versions_survive(self):
        org = ledger.Org.create("gpt6-migrate")
        org.d["tiers"].update({"gpt-6-sol": 2, "gpt-6-luna": 0.1})
        org.d["models"].update({"gpt-6-sol": "gpt-6-sol",
                                "gpt-6-luna": "gpt-6-luna",
                                "sol": "gpt-5.6-sol", "luna": "gpt-5.6-luna"})
        for tier in ("sol", "luna", "gpt-6-sol", "gpt-6-luna"):
            org.hire(ledger.USER, None, tier, 0, tier)
            org.node(tier)["account"] = "openai-1"
        org.node("luna")["scope"]["model_version"] = "5.6"
        loaded = ledger.Org(json.loads(json.dumps(org.d)))
        self.assertEqual(loaded.model_for("sol"), "gpt-6-sol")
        self.assertEqual(loaded.model_for("luna"), "gpt-5.6-luna")
        for old in ("gpt-6-sol", "gpt-6-luna"):
            self.assertEqual(loaded.node(old)["model"], old.removeprefix("gpt-6-"))
            self.assertEqual(loaded.node(old)["scope"]["model_version"], "6")
            self.assertEqual(loaded.model_for(old), old)
            self.assertEqual(loaded.node(old)["account"], "openai-1")
            self.assertNotIn(old, loaded.d["tiers"])
            self.assertNotIn(old, loaded.d["models"])
        self.assertEqual(ledger.Org(copy.deepcopy(loaded.d)).d, loaded.d)

    def test_model_specific_prices_and_context(self):
        usage = {"total": {"inputTokens": 1_000_000,
                           "cachedInputTokens": 500_000,
                           "outputTokens": 100_000}}
        self.assertAlmostEqual(providers.codex_cost("sol", usage), 2.1)
        self.assertAlmostEqual(providers.codex_cost("luna", usage), 0.115)
        self.assertAlmostEqual(providers.codex_cost("sol", usage, "gpt-5.6-sol"), 4.2)
        self.assertAlmostEqual(providers.codex_cost("luna", usage, "gpt-5.6-luna"), 0.23)
        self.assertIsNone(supervisor.tier_context("sol"))
        self.assertEqual(supervisor.tier_context("sol", {"sol": "gpt-5.6-sol"}),
                         providers.CODEX_CONTEXT)

    def test_luna_six_does_not_borrow_five_six_reserve(self):
        for prefer in (True, False):
            six = codex_route.resolve("luna", login_kind="chatgpt", board={},
                marks=None, account="openai-1", direct_model="gpt-6-luna",
                prefer_reserve=prefer)
            self.assertEqual((six["route"], six["model"]), ("direct", "gpt-6-luna"))
            self.assertIsNone(codex_route.other_route(six))
        old = codex_route.resolve("luna", login_kind="chatgpt", board={},
            marks=None, account="openai-1", direct_model="gpt-5.6-luna")
        self.assertEqual(old["route"], "reserve")
        retry = codex_route.other_route(old)
        self.assertIsNotNone(retry)
        self.assertEqual(retry["model"], "gpt-5.6-luna")

    def test_old_default_prices_migrate_without_custom_price_loss(self):
        org = ledger.Org.create("gpt6-reprice")
        org.d["tiers"].update(sol=5, luna=0.2)
        loaded = ledger.Org(json.loads(json.dumps(org.d)))
        self.assertEqual((loaded.d["tiers"]["sol"], loaded.d["tiers"]["luna"]),
                         (2, 0.1))
        loaded.d["tiers"].update(sol=7, luna=0.3)
        custom = ledger.Org(copy.deepcopy(loaded.d))
        self.assertEqual((custom.d["tiers"]["sol"], custom.d["tiers"]["luna"]),
                         (7, 0.3))


if __name__ == "__main__":
    unittest.main()
