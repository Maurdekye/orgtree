"""Sonnet 5.5 (2.1.13): new hires and switches run Sonnet 5.5, every existing
Sonnet agent keeps Sonnet 5 through a one-time pin, and the CLI argv carries
the exact id."""
import copy
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401

_root = tempfile.TemporaryDirectory(prefix="orgtree-sonnet55-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import clipin, ledger, providers, supervisor

SONNET_5_5 = "claude-sonnet-5-5"
SONNET_5 = "claude-sonnet-5"


def tearDownModule():
    _root.cleanup()


class Sonnet55Tests(unittest.TestCase):
    def org(self, slug="sonnet55"):
        org = ledger.Org.create(slug)
        org.hire(ledger.USER, None, "sonnet", 10, "agent")
        return org

    def old_org(self):
        """An org saved by 2.1.12: the shipped Sonnet 5 default, no Sonnet
        versions, a mix of tiers, and two Sonnet agents still carrying the
        version they had on Opus (2.1.12 never cleared it on a switch)."""
        org = ledger.Org.create("sonnet55-old")
        org.hire(ledger.USER, None, "sonnet", 10, "plain")
        org.hire(ledger.USER, None, "opus", 10, "was-opus-55")
        org.hire(ledger.USER, None, "opus", 10, "was-opus-48")
        org.hire(ledger.USER, None, "opus", 10, "opus")
        org.hire(ledger.USER, "plain", "sonnet", 0, "child")
        org.d["models"]["sonnet"] = SONNET_5
        for nid, ver in (("was-opus-55", "5.5"), ("was-opus-48", "4.8")):
            org.set_scope(ledger.USER, nid, model_version=ver)
            org.switch_model(ledger.USER, nid, "sonnet")
            # what 2.1.12 left behind: the switch kept the Opus version
            org.node(nid)["scope"]["model_version"] = ver
        return org

    def reload(self, org):
        return ledger.Org(json.loads(json.dumps(org.d)))

    def test_new_hire_runs_sonnet_5_5_at_the_same_seat(self):
        org = self.org()
        self.assertEqual(ledger.MODELS["sonnet"], SONNET_5_5)
        self.assertEqual(org.model_for("agent"), SONNET_5_5)
        self.assertEqual(org.seat_cost("agent"), 2)
        row = next(r for r in providers.claude_tiers() if r["tier"] == "sonnet")
        self.assertEqual((row["model"], row["provider"], row["seat"]),
                         (SONNET_5_5, "claude", 2))
        self.assertEqual(list(org.versions_for("sonnet")), ["5.5", "5"])
        self.assertEqual(clipin.PIN, "2.1.284")

    def test_existing_sonnet_agents_are_pinned_to_5_once(self):
        old = self.old_org()
        before = {n: copy.deepcopy(old.node(n)) for n in ("plain", "child", "opus")}
        loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sonnet"], SONNET_5_5)
        for nid in ("plain", "child", "was-opus-55", "was-opus-48"):
            with self.subTest(nid=nid):
                self.assertEqual(loaded.node(nid)["scope"]["model_version"], "5")
                self.assertEqual(loaded.model_for(nid), SONNET_5)
                self.assertEqual(loaded.seat_cost(nid), 2)
        for nid in ("plain", "child"):
            with self.subTest(nid=nid):
                # nothing but the pin moved
                want = copy.deepcopy(before[nid])
                want["scope"]["model_version"] = "5"
                self.assertEqual(loaded.node(nid), want)
        # other tiers are untouched
        self.assertEqual(loaded.node("opus"), before["opus"])
        self.assertEqual(loaded.d["tiers"], old.d["tiers"])
        # the trigger cannot fire twice
        self.assertEqual(self.reload(loaded).d, loaded.d)
        # a hire after the upgrade gets the new default
        loaded.hire(ledger.USER, None, "sonnet", 10, "fresh")
        self.assertEqual(loaded.model_for("fresh"), SONNET_5_5)

    def test_a_lazy_node_table_never_flips_the_default_without_the_pins(self):
        # v3 on-demand rows: undecoded agents would miss the pin, so a lazy
        # load leaves both halves for the next whole load
        old = self.old_org()
        with patch.object(ledger, "_lazy_rows", return_value=True):
            loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sonnet"], SONNET_5)
        self.assertNotIn("model_version", loaded.node("plain")["scope"])
        self.assertEqual(loaded.model_for("plain"), SONNET_5)

    def test_unpinning_a_migrated_agent_moves_it_to_5_5(self):
        loaded = self.reload(self.old_org())
        loaded.set_scope(ledger.USER, "plain", model_version="")
        self.assertEqual(loaded.model_for("plain"), SONNET_5_5)
        loaded.set_scope(ledger.USER, "plain", model_version="5")
        self.assertEqual(self.reload(loaded).model_for("plain"), SONNET_5)

    def test_custom_org_id_is_preserved_and_its_agents_are_not_pinned(self):
        old = self.old_org()
        old.d["models"]["sonnet"] = "custom-sonnet-deployment"
        loaded = self.reload(old)
        self.assertEqual(loaded.d["models"]["sonnet"], "custom-sonnet-deployment")
        self.assertNotIn("model_version", loaded.node("plain")["scope"])
        self.assertEqual(loaded.model_for("plain"), "custom-sonnet-deployment")

    def test_version_choice_validates(self):
        org = self.org()
        before = copy.deepcopy(org.d)
        with self.assertRaises(ledger.LedgerError):
            org.set_scope(ledger.USER, "agent", model_version="4.6")
        self.assertEqual(org.d, before)

    def test_switching_tier_resets_the_version_to_the_new_tiers_default(self):
        org = self.org()
        org.hire(ledger.USER, None, "opus", 10, "op")
        # an Opus agent pinned to 5 must not become Sonnet 5 by key collision
        org.set_scope(ledger.USER, "op", model_version="5")
        self.assertEqual(org.model_for("op"), "claude-opus-5")
        org.switch_model(ledger.USER, "op", "sonnet", busy=False)
        self.assertEqual(org.model_for("op"), SONNET_5_5)
        self.assertNotIn("model_version", org.node("op")["scope"])
        # and a Sonnet agent pinned to 5 (the migration's pin) must not
        # become Opus 5
        org.set_scope(ledger.USER, "agent", model_version="5")
        org.switch_model(ledger.USER, "agent", "opus", busy=False)
        self.assertEqual(org.model_for("agent"), ledger.MODELS["opus"])
        # asking for the current tier changes nothing, including the pin
        org.set_scope(ledger.USER, "op", model_version="5")
        org.switch_model(ledger.USER, "op", "sonnet", busy=False)
        self.assertEqual(org.model_for("op"), SONNET_5)

    def test_rehire_onto_another_tier_resets_the_version(self):
        org = self.org()
        org.hire(ledger.USER, None, "opus", 10, "op")
        org.set_scope(ledger.USER, "op", model_version="5")
        org.retire(ledger.USER, "op")
        org.rehire(ledger.USER, "op", tier="sonnet")
        self.assertEqual(org.model_for("op"), SONNET_5_5)
        # a rehire on the same tier keeps the pin
        org.set_scope(ledger.USER, "op", model_version="5")
        org.retire(ledger.USER, "op")
        org.rehire(ledger.USER, "op", tier="sonnet")
        self.assertEqual(org.model_for("op"), SONNET_5)

    def test_argv_carries_the_exact_id_on_any_cli(self):
        org = self.org()
        org.hire(ledger.USER, None, "sonnet", 10, "old")
        org.set_scope(ledger.USER, "old", model_version="5")
        with patch.object(supervisor, "cli_version", return_value=clipin.PIN), \
             patch.object(supervisor, "transcript_path", return_value=None):
            for nid, want in (("agent", SONNET_5_5), ("old", SONNET_5)):
                argv = supervisor._build_cmd(org, nid, write_ident=False)
                self.assertEqual(argv[argv.index("--model") + 1], want, nid)
        # never substituted with Sonnet 5 on an older or unknown CLI
        for cli in ("2.1.280", "2.1.241", "unknown"):
            with patch.object(supervisor, "cli_version", return_value=cli):
                self.assertEqual(supervisor.claude_model_for(org, "agent"), SONNET_5_5)


if __name__ == "__main__":
    unittest.main()
