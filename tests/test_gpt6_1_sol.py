"""GPT-6.1 Sol: new hires and switches run gpt-6.1-sol, every existing Sol
agent keeps the model it runs now through a one-time pin, and custom org ids
are left alone."""
import copy
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

_root = tempfile.TemporaryDirectory(prefix="orgtree-gpt61-sol-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import codexpin, ledger, providers, supervisor

SOL_6_1 = "gpt-6.1-sol"
SOL_6 = "gpt-6-sol"
SOL_5_6 = "gpt-5.6-sol"


def tearDownModule():
    _root.cleanup()


class Gpt61SolTests(unittest.TestCase):
    def org(self, slug="gpt61-sol"):
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "sol", 0, "agent")
        return org

    def old_org(self, default=SOL_6):
        """An org saved before GPT-6.1: the shipped Sol default, an unpinned
        Sol agent and its child, agents pinned to 5.6 and to 6, one still
        carrying the version it had on Opus, and agents on other tiers."""
        org = ledger.Org.create("gpt61-sol-old")
        for parent, tier, nid in ((None, "sol", "plain"), ("plain", "sol", "child"),
                                  (None, "sol", "on-56"), (None, "sol", "on-6"),
                                  (None, "sol", "was-opus"), (None, "luna", "luna"),
                                  (None, "opus", "opus")):
            org.hire(ledger.USER, parent, tier, 0, nid)
        org.set_scope(ledger.USER, "on-56", model_version="5.6")
        org.set_scope(ledger.USER, "on-6", model_version="6")
        org.set_scope(ledger.USER, "luna", model_version="5.6")
        # a version left behind by an older tier (resolves to the default)
        org.node("was-opus")["scope"]["model_version"] = "5.5"
        org.d["models"]["sol"] = default
        return org

    def reload(self, org):
        return ledger.Org(json.loads(json.dumps(org.d)))

    def test_new_hire_runs_gpt_6_1_sol_at_the_same_seat(self):
        org = self.org()
        self.assertEqual(ledger.MODELS["sol"], SOL_6_1)
        self.assertEqual(org.model_for("agent"), SOL_6_1)
        self.assertEqual(org.seat_cost("agent"), 2)
        row = next(r for r in providers.codex_tiers(set()) if r["tier"] == "sol")
        self.assertEqual((row["model"], row["provider"], row["seat"]),
                         (SOL_6_1, "openai", 2))
        self.assertEqual(org.versions_for("sol"),
                         {"6.1": SOL_6_1, "6": SOL_6, "5.6": SOL_5_6})
        # the pinned CLI is one that lists the model (measured 2026-09-29)
        self.assertEqual(codexpin.PIN, "0.159.0")

    def test_existing_sol_agents_keep_their_model(self):
        old = self.old_org()
        before = {n: old.model_for(n) for n in old.nodes}
        untouched = {n: copy.deepcopy(old.node(n)) for n in ("on-56", "on-6", "luna", "opus")}
        self.assertEqual(before["plain"], SOL_6)
        loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sol"], SOL_6_1)
        for nid, model in before.items():
            with self.subTest(nid=nid):
                self.assertEqual(loaded.model_for(nid), model)
        for nid in ("plain", "child", "was-opus"):
            with self.subTest(nid=nid):
                self.assertEqual(loaded.node(nid)["scope"]["model_version"], "6")
                self.assertEqual(loaded.seat_cost(nid), 2)
        for nid, node in untouched.items():
            with self.subTest(nid=nid):
                self.assertEqual(loaded.node(nid), node)
        self.assertEqual(loaded.d["tiers"], old.d["tiers"])
        # the trigger cannot fire twice
        self.assertEqual(self.reload(loaded).d, loaded.d)
        # a hire after the upgrade gets the new default
        loaded.hire(ledger.USER, None, "sol", 0, "fresh")
        self.assertEqual(loaded.model_for("fresh"), SOL_6_1)

    def test_an_org_still_on_the_5_6_default_takes_the_gpt_6_step_first(self):
        # the GPT-6 fold advanced unpinned agents to GPT-6; they stay there
        old = self.old_org(default=SOL_5_6)
        self.assertEqual(old.model_for("plain"), SOL_5_6)
        loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sol"], SOL_6_1)
        self.assertEqual(loaded.model_for("plain"), SOL_6)
        self.assertEqual(loaded.model_for("on-56"), SOL_5_6)
        self.assertEqual(loaded.d["models"]["luna"], ledger.MODELS["luna"])

    def test_a_lazy_node_table_never_flips_the_default_without_the_pins(self):
        old = self.old_org()
        with patch.object(ledger, "_lazy_rows", return_value=True):
            loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sol"], SOL_6)
        self.assertNotIn("model_version", loaded.node("plain")["scope"])
        self.assertEqual(loaded.model_for("plain"), SOL_6)

    def test_custom_org_id_is_preserved_and_its_agents_are_not_pinned(self):
        old = self.old_org(default="custom-sol-deployment")
        loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sol"], "custom-sol-deployment")
        self.assertNotIn("model_version", loaded.node("plain")["scope"])
        self.assertEqual(loaded.model_for("plain"), "custom-sol-deployment")

    def test_unpinning_a_migrated_agent_moves_it_to_6_1(self):
        loaded = self.reload(self.old_org())
        loaded.set_scope(ledger.USER, "plain", model_version="")
        self.assertEqual(loaded.model_for("plain"), SOL_6_1)
        loaded.set_scope(ledger.USER, "plain", model_version="6.1")
        self.assertEqual(self.reload(loaded).model_for("plain"), SOL_6_1)

    def test_switching_onto_sol_runs_6_1(self):
        org = self.org()
        org.hire(ledger.USER, None, "luna", 0, "lu")
        org.set_scope(ledger.USER, "lu", model_version="6")
        org.switch_model(ledger.USER, "lu", "sol", busy=False)
        self.assertEqual(org.model_for("lu"), SOL_6_1)
        self.assertNotIn("model_version", org.node("lu")["scope"])

    def test_turn_cost_and_context_follow_the_model(self):
        usage = {"total": {"inputTokens": 1_000_000,
                           "cachedInputTokens": 500_000,
                           "outputTokens": 100_000}}
        # $2 input, $0.10 cached, $10 output per million (OpenAI, 2026-09-29)
        self.assertAlmostEqual(providers.codex_cost("sol", usage, SOL_6_1), 2.05)
        self.assertAlmostEqual(providers.codex_cost("sol", usage), 2.05)
        self.assertAlmostEqual(providers.codex_cost("sol", usage, SOL_6), 2.1)
        self.assertEqual(supervisor.tier_context("sol", {"sol": SOL_6_1}), 1_050_000)
        # a node pinned to GPT-6 keeps the observed window, as before
        self.assertIsNone(supervisor.tier_context("sol", {"sol": SOL_6}))
        self.assertIsNone(supervisor.tier_context("sol"))


if __name__ == "__main__":
    unittest.main()
