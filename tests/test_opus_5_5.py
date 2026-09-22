"""Stable Opus upgrade: saved choices, provider identity and actual CLI argv."""
import copy
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401

_root = tempfile.TemporaryDirectory(prefix="orgtree-opus55-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import clipin, ledger, providers, supervisor


def tearDownModule():
    _root.cleanup()


class Opus55Tests(unittest.TestCase):
    def org(self):
        org = ledger.Org.create("opus55")
        org.hire(ledger.USER, None, "opus", 10, "agent")
        org.node("agent")["account"] = "claude-4"
        return org

    def test_default_and_provider_roster_use_four_credit_opus(self):
        org = self.org()
        self.assertEqual(org.model_for("agent"), "claude-opus-5-5")
        row = next(r for r in providers.claude_tiers() if r["tier"] == "opus")
        self.assertEqual((row["model"], row["provider"], row["seat"]),
                         ("claude-opus-5-5", "claude", 4))
        self.assertEqual(org.seat_cost("agent"), 4)
        self.assertEqual(clipin.PIN, "2.1.280")

    def test_saved_default_migrates_without_changing_account_or_grant(self):
        original = self.org()
        original.d["models"]["opus"] = "claude-opus-5"
        original.d["tiers"]["opus"] = 5
        node_before = copy.deepcopy(original.node("agent"))
        migrated = ledger.Org(json.loads(json.dumps(original.d)))
        self.assertEqual(migrated.model_for("agent"), "claude-opus-5-5")
        self.assertEqual(migrated.node("agent"), node_before)
        self.assertEqual(migrated.seat_cost("agent"), 4)
        expected = dict(original.d["tiers"], opus=4)
        self.assertEqual(migrated.d["tiers"], expected)
        self.assertEqual(ledger.Org(copy.deepcopy(migrated.d)).d, migrated.d)

    def test_custom_org_id_is_preserved(self):
        org = self.org()
        org.d["models"]["opus"] = "custom-opus-deployment"
        org.d["tiers"]["opus"] = 7
        loaded = ledger.Org(copy.deepcopy(org.d))
        self.assertEqual(loaded.model_for("agent"), "custom-opus-deployment")
        self.assertEqual(loaded.seat_cost("agent"), 7)

    def test_migration_returns_one_credit_per_child_without_changing_grants(self):
        org = self.org()
        org.d["tiers"]["opus"] = 5
        org.hire(ledger.USER, "agent", "opus", 0, "child")
        org.hire(ledger.USER, "agent", "opus", 0, "second")
        self.assertEqual(org.free("agent"), 0)
        loaded = ledger.Org(copy.deepcopy(org.d))
        self.assertEqual(loaded.committed("agent"), 8)
        self.assertEqual(loaded.free("agent"), 2)
        self.assertEqual(loaded.node("agent")["grant"], 10)

    def test_version_choice_validates_persists_and_clears(self):
        org = self.org()
        self.assertEqual(list(org.versions_for("opus")), ["5.5", "5", "4.8"])
        for version, model in (("5.5", "claude-opus-5-5"),
                               ("5", "claude-opus-5"),
                               ("4.8", "claude-opus-4-8")):
            with self.subTest(version=version):
                org.set_scope(ledger.USER, "agent", model_version=version)
                loaded = ledger.Org(json.loads(json.dumps(org.d)))
                self.assertEqual(loaded.model_for("agent"), model)
                self.assertEqual(loaded.seat_cost("agent"), 4)
                self.assertEqual(loaded.node("agent")["account"], "claude-4")
        before = copy.deepcopy(org.d)
        with self.assertRaises(ledger.LedgerError):
            org.set_scope(ledger.USER, "agent", model_version="5.6")
        self.assertEqual(org.d, before)
        org.set_scope(ledger.USER, "agent", model_version="")
        self.assertEqual(org.model_for("agent"), "claude-opus-5-5")

    def test_old_saved_version_overrides_migrated_default(self):
        org = self.org()
        org.d["models"]["opus"] = "claude-opus-5"
        org.set_scope(ledger.USER, "agent", model_version="5")
        loaded = ledger.Org(copy.deepcopy(org.d))
        self.assertEqual(loaded.d["models"]["opus"], "claude-opus-5-5")
        self.assertEqual(loaded.model_for("agent"), "claude-opus-5")

    def test_dispatch_never_substitutes_opus_5_and_keeps_effort(self):
        org = self.org()
        org.set_scope(ledger.USER, "agent", effort="medium")
        with patch.object(supervisor, "cli_version", return_value="2.1.280"), \
             patch.object(supervisor, "transcript_path", return_value=None):
            argv = supervisor._build_cmd(org, "agent", write_ident=False)
        self.assertEqual(argv[argv.index("--model") + 1], "claude-opus-5-5")
        self.assertEqual(argv[argv.index("--effort") + 1], "medium")
        for cli in ("2.1.241", "unknown"):
            with patch.object(supervisor, "cli_version", return_value=cli):
                self.assertEqual(supervisor.claude_model_for(org, "agent"),
                                 "claude-opus-5-5")

    def test_other_claude_models_and_fable_compatibility_remain(self):
        org = self.org()
        for tier in ("haiku", "sonnet", "fable"):
            org.hire(ledger.USER, None, tier, 0, tier)
            with patch.object(supervisor, "cli_version", return_value="2.1.280"):
                self.assertEqual(supervisor.claude_model_for(org, tier),
                                 ledger.MODELS[tier])
        with patch.object(supervisor, "cli_version", return_value="2.1.241"):
            self.assertEqual(supervisor.claude_model_for(org, "fable"),
                             clipin.FABLE_5)


if __name__ == "__main__":
    unittest.main()
