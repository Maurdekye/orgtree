"""Former sandbox orgs get the credential conversion the cutovers skipped.

Both one-time cutovers (S2 registry migration, V2 API-key cutover) used to
skip a sandboxed org whole and still set their completion markers. With the
sandbox removed those orgs run on the host, so run_former_sandbox_catchup
gives exactly them what each finished cutover gave every other org:
  · both markers set: the stored key moves store-first into an org-scoped
    apikey row, the org's unbound claude nodes bind to it, the V1 fields go,
    and an unrelated bound control org (and an already-bound node) is left
    exactly as it was
  · a held api_fallback key binds nobody; nodes take the existing machine
    login row and the org is reported as fallback_was_on
  · only the registry cutover done: an S2 token row is minted and bound, and
    the later API-key cutover converts that row in place (same id)
  · no cutover done: nothing happens (the cutovers themselves cover it)
  · the pass is idempotent (marker short-circuits the second run)
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

_root = tempfile.mkdtemp(prefix="former-sandbox-catchup-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import (  # noqa: E402
    apikey_accounts, ledger, registry, registry_migration, store, tokens)

CLAUDE_DIR = str(Path(_root) / "claude-login")
Path(CLAUDE_DIR).mkdir()
AMBIENT = {"claude": CLAUDE_DIR, "openai": None, "google": None}


def _key(tag):
    return "sk-ant-api03-" + tag * 40


def _org(slug, nodes, **d):
    org = ledger.Org.create(slug)
    for nid, node in nodes.items():
        org.nodes[nid] = {"state": "live", "parent": None if nid == "root"
                          else "root", "generation": 1, **node}
    org.d.update(d)
    store.save_org(org)
    return org


def _markers(**fields):
    d = registry.load(strict=True)
    d.update(fields)
    registry.save(d)


class CatchupTests(unittest.TestCase):
    def setUp(self):
        try:
            os.remove(registry.registry_path())
        except FileNotFoundError:
            pass
        self.ambient = registry.create_account(
            "claude", "claude (machine login)",
            {"kind": "imported", "path": CLAUDE_DIR})["id"]
        self.other = registry.create_account(
            "claude", "someone else's login",
            {"kind": "imported", "path": str(Path(_root) / "elsewhere")})["id"]

    def test_both_markers_set_moves_the_key_and_binds_only_unbound_nodes(self):
        key = _key("a")
        _org("fs-a", {"root": {"model": "opus"},
                      "pinned": {"model": "opus", "account": self.other}},
             sandbox={"enabled": True}, api_key=key, api_fallback_until=5.0)
        _org("fs-ctl", {"root": {"model": "opus", "account": self.other}})
        _markers(migrated_at=1.0, apikey_cutover_at=2.0)

        report = registry_migration.run_former_sandbox_catchup(AMBIENT)

        rid = report["org_key_rows"]["fs-a"]
        row = registry.get_account(rid)
        kid = apikey_accounts._key_row_id(key)
        self.assertEqual(row["credential"], {"kind": "apikey", "token_ref": kid})
        self.assertEqual(registry.account_mode(row), "apikey")
        self.assertEqual(row.get("origin_org"), "fs-a")
        self.assertEqual(tokens.get(kid), key)
        fresh = store.load_org("fs-a")
        self.assertEqual(fresh.node("root")["account"], rid)
        self.assertEqual(fresh.node("pinned")["account"], self.other)
        for field in ("api_key", "api_fallback_until"):
            self.assertNotIn(field, fresh.d)
        self.assertEqual(fresh.d.get("sandbox"), {"enabled": True})
        self.assertEqual(report["orgs"], ["fs-a"])
        # the control org is neither touched nor re-saved
        self.assertNotIn("fs-ctl", report["cleaned_orgs"])
        self.assertEqual(store.load_org("fs-ctl").node("root")["account"],
                         self.other)
        self.assertTrue(registry.load().get(
            registry_migration.FORMER_SANDBOX_MARKER))
        rows_after = len(registry.load()["accounts"])
        self.assertIsNone(registry_migration.run_former_sandbox_catchup(AMBIENT))
        self.assertEqual(len(registry.load()["accounts"]), rows_after)

    def test_held_fallback_key_binds_nobody_to_it(self):
        key = _key("b")
        _org("fs-b", {"root": {"model": "opus"}},
             sandbox={"enabled": True}, api_key=key, api_fallback=True,
             fable_api_fallback=True)
        _markers(migrated_at=1.0, apikey_cutover_at=2.0)

        report = registry_migration.run_former_sandbox_catchup(AMBIENT)

        rid = report["org_key_rows"]["fs-b"]
        self.assertEqual(registry.account_mode(registry.get_account(rid)),
                         "apikey")
        self.assertIn("fs-b", report["fallback_was_on"])
        fresh = store.load_org("fs-b")
        self.assertEqual(fresh.node("root")["account"], self.ambient)
        for field in ("api_key", "api_fallback", "fable_api_fallback"):
            self.assertNotIn(field, fresh.d)

    def test_registry_cutover_only_then_apikey_cutover_converts_in_place(self):
        key = _key("c")
        _org("fs-c", {"root": {"model": "opus"}},
             sandbox={"enabled": True}, api_key=key)
        _markers(migrated_at=1.0)

        report = registry_migration.run_former_sandbox_catchup(AMBIENT)

        rid = report["org_key_rows"]["fs-c"]
        self.assertEqual(registry.get_account(rid)["credential"],
                         {"kind": "token", "token_ref": "org-api-key:fs-c"})
        fresh = store.load_org("fs-c")
        self.assertEqual(fresh.node("root")["account"], rid)
        self.assertEqual(fresh.d.get("api_key"), key)   # the cutover's job
        registry_migration.run_apikey_cutover()
        self.assertEqual(registry.get_account(rid)["credential"]["kind"],
                         "apikey")
        after = store.load_org("fs-c")
        self.assertEqual(after.node("root")["account"], rid)
        self.assertNotIn("api_key", after.d)

    def test_no_cutover_done_is_left_to_the_cutovers(self):
        key = _key("d")
        _org("fs-d", {"root": {"model": "opus"}},
             sandbox={"enabled": True}, api_key=key)
        self.assertIsNone(registry_migration.run_former_sandbox_catchup(AMBIENT))
        fresh = store.load_org("fs-d")
        self.assertEqual(fresh.d.get("api_key"), key)
        self.assertNotIn("account", fresh.node("root"))
        self.assertFalse(registry.load().get(
            registry_migration.FORMER_SANDBOX_MARKER))


if __name__ == "__main__":
    unittest.main()
