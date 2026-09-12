"""API-key accounts, stage (e1) — the V2 org-key cutover (ticket
redesign-api-key-inference-accounts; user decisions 2026-09-12).

Covers run_apikey_cutover:
  · an S2 org-key row is rewritten IN PLACE (same id — bindings survive)
    with the secret moved store-first into the machine token store, and the
    org drops every V1 field
  · the S2 "held" api_fallback case mints a fresh org-scoped apikey row,
    reports fallback_was_on, binds nobody
  · an orphaned org-key row is marked unauthenticated and reported
  · sandboxed orgs are skipped whole
  · the pass is idempotent (registry marker short-circuits the second run)
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="apikey-cutover-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

from engine.backend.orgtree import (  # noqa: E402
    ledger, registry, registry_migration, store, tokens)

KEY = "sk-ant-api03-" + "m" * 40


def _fresh_registry():
    try:
        os.remove(registry.registry_path())
    except FileNotFoundError:
        pass


def _org(slug, **d):
    org = ledger.Org.create(slug)
    org.nodes["root"] = {"state": "live", "parent": None, "generation": 1,
                         "model": "opus"}
    org.d.update(d)
    store.save_org(org)
    return org


class CutoverTests(unittest.TestCase):
    def setUp(self):
        _fresh_registry()

    def test_converts_existing_org_key_row_in_place(self):
        row = registry.create_account(
            "claude", "org key (cv-a)",
            {"kind": "token", "token_ref": "org-api-key:cv-a"},
            origin_org="cv-a")
        org = _org("cv-a", api_key=KEY, api_fallback_until=123.0)
        org.nodes["root"]["account"] = row["id"]
        store.save_org(org)
        report = registry_migration.run_apikey_cutover()
        fresh = registry.get_account(row["id"])
        self.assertEqual(fresh["credential"]["kind"], "apikey")
        self.assertEqual(registry.account_mode(fresh), "apikey")
        self.assertTrue(registry.is_enabled(fresh))
        self.assertEqual(fresh.get("origin_org"), "cv-a")
        self.assertEqual(tokens.get(fresh["credential"]["token_ref"]), KEY)
        reloaded = store.load_org("cv-a")
        self.assertNotIn("api_key", reloaded.d)
        self.assertNotIn("api_fallback_until", reloaded.d)
        self.assertEqual(reloaded.node("root")["account"], row["id"])
        self.assertEqual(report["converted_rows"]["cv-a"], row["id"])
        self.assertTrue(registry_migration.apikey_cutover_done())
        self.assertIsNone(registry_migration.run_apikey_cutover())

    def test_held_fallback_org_mints_a_scoped_row(self):
        _org("cv-b", api_key=KEY[:-1] + "b", api_fallback=True,
             fable_api_fallback=True, api_fallback_since=1.0)
        report = registry_migration.run_apikey_cutover()
        rid = report["minted_rows"]["cv-b"]
        row = registry.get_account(rid)
        self.assertEqual(registry.account_mode(row), "apikey")
        self.assertEqual(row.get("origin_org"), "cv-b")
        self.assertIn("cv-b", report["fallback_was_on"])
        reloaded = store.load_org("cv-b")
        for field in ("api_key", "api_fallback", "fable_api_fallback",
                      "api_fallback_since"):
            self.assertNotIn(field, reloaded.d)
        # the spare never was the lane: nobody got bound to it
        self.assertNotIn("account", reloaded.node("root"))

    def test_orphaned_row_marked_unauthenticated(self):
        row = registry.create_account(
            "claude", "org key (ghost)",
            {"kind": "token", "token_ref": "org-api-key:ghost"},
            origin_org="ghost")
        report = registry_migration.run_apikey_cutover()
        self.assertIn(row["id"], report["orphaned_rows"])
        self.assertEqual(registry.get_account(row["id"])["auth"],
                         "unauthenticated")
        self.assertTrue(registry_migration.apikey_cutover_done())

    def test_sandboxed_org_skipped_whole(self):
        _org("cv-sbx", api_key=KEY[:-1] + "s", sandbox={"image": "x"})
        report = registry_migration.run_apikey_cutover()
        self.assertIn("cv-sbx", report["skipped_sandboxed"])
        reloaded = store.load_org("cv-sbx")
        self.assertEqual(reloaded.d.get("api_key"), KEY[:-1] + "s")
        self.assertNotIn("cv-sbx", report["cleaned_orgs"])


if __name__ == "__main__":
    unittest.main()
