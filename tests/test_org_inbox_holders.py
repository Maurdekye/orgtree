import os
import json
import tempfile
import threading
import unittest
from typing import cast
import sys
from pathlib import Path

# Setup paths for tests
root = tempfile.TemporaryDirectory(prefix="orgtree-inbox-holders-")
os.environ["ORGTREE_DATA"] = root.name
# PYPG: org_tx (PG-0) refuses the JSON store, and POST /settings now runs
# in one — so this file runs on the SQLite seam like the rest of the suite
os.environ["ORGTREE_STORE"] = "sqlite"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, api
from orgtree.ledger import EXTERN, SYSTEM, USER

class InboxHoldersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = root.name
        os.environ["ORGTREE_DATA"] = cls.root
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.store = store
        cls.api = api

    def test_default_single_holder_enforcement(self):
        org = self.ledger.Org.create("single-holder")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus", "created": 0}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}

        # Grant to alice
        org.audience_grant(USER, "alice", EXTERN)
        holders = [a["grantee"] for a in org.d["audiences"] if a["grantor"] == EXTERN]
        self.assertEqual(holders, ["alice"])

        # Grant to bob (this should move the grant from alice to bob)
        org.audience_grant(USER, "bob", EXTERN)
        holders = [a["grantee"] for a in org.d["audiences"] if a["grantor"] == EXTERN]
        self.assertEqual(holders, ["bob"])

        # Alice should have lost the audience (rescinded)
        events = org.d.get("events", [])
        rescinded = [e for e in events if e.get("op") == "audience_revoke" and e.get("detail", {}).get("grantee") == "alice"]
        self.assertTrue(len(rescinded) > 0)

    def test_multi_holder_opt_in(self):
        org = self.ledger.Org.create("multi-holder")
        org.d["external_inbox_multi_holder"] = True
        org.d["org_inbox_multi_holder"] = True
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}

        # Grant to alice
        org.audience_grant(USER, "alice", EXTERN)
        # Grant to bob
        org.audience_grant(USER, "bob", EXTERN)

        holders = [a["grantee"] for a in org.d["audiences"] if a["grantor"] == EXTERN]
        self.assertIn("alice", holders)
        self.assertIn("bob", holders)

        # Repeating a grant is idempotent and inbound delivery is a set.
        org.audience_grant(USER, "alice", EXTERN)
        self.assertEqual(
            len([a for a in org.d["audiences"] if a["grantor"] == EXTERN]), 2)
        self.assertEqual(org.post_external_mail("@org:peer", "hello"),
                         ["alice", "bob"])
        self.assertEqual(len(org.d["mail"]["alice"]), 1)
        self.assertEqual(len(org.d["mail"]["bob"]), 1)

    def test_single_holder_duplicate_grant_cleans_duplicate_records(self):
        org = self.ledger.Org.create("single-duplicate")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.d["audiences"].extend([
            {"grantee": "alice", "grantor": EXTERN, "granted_at": 0, "reason": ""},
            {"grantee": "alice", "grantor": EXTERN, "granted_at": 1, "reason": ""},
        ])
        org.audience_grant(USER, "alice", EXTERN)
        self.assertEqual(
            [a["grantee"] for a in org.d["audiences"] if a["grantor"] == EXTERN],
            ["alice"])
        self.assertEqual(org.post_external_mail("@org:peer", "hello"), ["alice"])
        self.assertEqual(len(org.d["mail"]["alice"]), 1)

    def test_migration_grandfathering(self):
        org = self.ledger.Org.create("migrating")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.d["audiences"].append({"grantee": "alice", "grantor": EXTERN, "granted_at": 0, "reason": ""})
        org.d["audiences"].append({"grantee": "bob", "grantor": EXTERN, "granted_at": 0, "reason": ""})
        org.d.pop("org_inbox_multi_holder", None)
        org.d.pop("external_inbox_multi_holder", None)
        org.d.get("_migrations", {}).pop(self.ledger.Org.EXTERN_MULTI_HOLDER_MIGRATION, None)
        self.store.save_org(org)

        # Re-load org to trigger __init__ migrations
        org = self.store.load_org("migrating")
        self.assertTrue(org.d.get("org_inbox_multi_holder"))
        self.assertTrue(org.d.get("external_inbox_multi_holder"))

        # Idempotent re-run
        self.store.save_org(org)
        org = self.store.load_org("migrating")
        self.assertTrue(org.d.get("org_inbox_multi_holder"))
        self.assertTrue(org.d.get("external_inbox_multi_holder"))

    def test_migration_grandfathers_holders_with_legacy_false_flag(self):
        org = self.ledger.Org.create("migrating-legacy-false")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.d["audiences"].extend([
            {"grantee": "alice", "grantor": EXTERN, "granted_at": 0, "reason": ""},
            {"grantee": "bob", "grantor": EXTERN, "granted_at": 0, "reason": ""},
        ])
        org.d["org_inbox_multi_holder"] = False
        org.d["external_inbox_multi_holder"] = False
        org.d.get("_migrations", {}).pop(self.ledger.Org.EXTERN_MULTI_HOLDER_MIGRATION, None)
        org._migrate_extern_multi_holder()
        self.assertTrue(org.multi_holder_enabled)
        self.assertEqual(org.extern_holders(), ["alice", "bob"])

    def test_migration_preserves_more_than_two_live_holders(self):
        org = self.ledger.Org.create("migrating-many")
        for holder in ("alice", "bob", "carol"):
            org.nodes[holder] = {"state": "live", "parent": None,
                                 "generation": 1, "model": "opus"}
            org.d["audiences"].append({"grantee": holder,
                                       "grantor": EXTERN,
                                       "granted_at": 0, "reason": ""})
        org.d.pop("org_inbox_multi_holder", None)
        org.d.pop("external_inbox_multi_holder", None)
        org.d.get("_migrations", {}).pop(self.ledger.Org.EXTERN_MULTI_HOLDER_MIGRATION, None)
        self.store.save_org(org)

        migrated = self.store.load_org("migrating-many")
        self.assertTrue(migrated.multi_holder_enabled)
        self.assertEqual(migrated.extern_holders(), ["alice", "bob", "carol"])
        self.assertEqual(
            [a["grantee"] for a in migrated.d["audiences"]
             if a["grantor"] == EXTERN], ["alice", "bob", "carol"])
        self.store.save_org(migrated)
        reloaded = self.store.load_org("migrating-many")
        self.assertEqual(reloaded.extern_holders(), ["alice", "bob", "carol"])

    def test_migration_zero_or_one_holder(self):
        org = self.ledger.Org.create("migrating-one")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.d["audiences"].append({"grantee": "alice", "grantor": EXTERN, "granted_at": 0, "reason": ""})
        org.d.pop("org_inbox_multi_holder", None)
        org.d.pop("external_inbox_multi_holder", None)
        org.d.get("_migrations", {}).pop(self.ledger.Org.EXTERN_MULTI_HOLDER_MIGRATION, None)
        self.store.save_org(org)

        org = self.store.load_org("migrating-one")
        self.assertFalse(org.d.get("org_inbox_multi_holder"))

        org2 = self.ledger.Org.create("migrating-zero")
        org2.d.pop("org_inbox_multi_holder", None)
        org2.d.pop("external_inbox_multi_holder", None)
        org2.d.get("_migrations", {}).pop(self.ledger.Org.EXTERN_MULTI_HOLDER_MIGRATION, None)
        self.store.save_org(org2)
        org2 = self.store.load_org("migrating-zero")
        self.assertFalse(org2.d.get("org_inbox_multi_holder"))

    def test_settings_change_to_single_requires_revocation(self):
        org = self.ledger.Org.create("settings-change")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.d["external_inbox_multi_holder"] = True
        org.d["org_inbox_multi_holder"] = True
        org.d["audiences"].append({"grantee": "alice", "grantor": EXTERN, "granted_at": 0, "reason": ""})
        org.d["audiences"].append({"grantee": "bob", "grantor": EXTERN, "granted_at": 0, "reason": ""})
        self.store.save_org(org)
        # the fixture writes raw node rows; a load normalizes them, so save once
        # more to reach the fixed point stored orgs sit at (an org_tx locks only
        # the rows its operation names)
        self.store.save_org(self.store.load_org("settings-change"))

        body = self.api.Settings(org_inbox_multi_holder=False)
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            self.api._org_settings_locked("settings-change", body)

        # After revoking down to 1 holder, it should succeed
        org = self.store.load_org("settings-change")
        org.audience_revoke(USER, "bob", EXTERN)
        self.store.save_org(org)
        self.api._org_settings_locked("settings-change", body)

        org = self.store.load_org("settings-change")
        self.assertFalse(org.d["org_inbox_multi_holder"])

    def test_rejected_replacement_keeps_existing_holder(self):
        org = self.ledger.Org.create("rejected-replacement")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["charlie"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.audience_grant(USER, "alice", EXTERN)
        with self.assertRaises(self.ledger.LedgerError):
            # Alice is a top-level holder, but Charlie is outside her purview.
            org.audience_grant("alice", "charlie", EXTERN)
        self.assertEqual(org.extern_holders(), ["alice"])
        self.assertEqual(
            [a["grantee"] for a in org.d["audiences"]
             if a["grantor"] == EXTERN], ["alice"])

    def test_legacy_global_holder_setting_is_not_reused(self):
        with open(os.path.join(self.store.DATA_ROOT, "defaults.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"org_inbox_multi_holder": True,
                       "external_inbox_multi_holder": True}, f)
        defaults = self.api.load_org_defaults()
        self.assertNotIn("org_inbox_multi_holder", defaults)
        self.assertNotIn("external_inbox_multi_holder", defaults)

    def test_revoke_leaves_no_holder_and_tree_exposes_policy(self):
        org = self.ledger.Org.create("revoke-holder")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus", "created": 0}
        org.audience_grant(USER, "alice", EXTERN)
        org.audience_revoke(USER, "alice", EXTERN)
        self.assertEqual(org.extern_holders(), [])
        tree_org = self.ledger.Org.create("tree-policy")
        self.assertFalse(tree_org.tree()["org_inbox"]["multi_holder_enabled"])

    def test_permission_and_kiosk_boundaries_remain_enforced(self):
        org = self.ledger.Org.create("permission-holder")
        org.nodes["top"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["child"] = {"state": "live", "parent": "top", "generation": 1, "model": "opus"}
        org.nodes["other"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        with self.assertRaises(self.ledger.LedgerError):
            org.audience_grant("child", "other", EXTERN)
        org.audience_grant(USER, "top", EXTERN)
        org.audience_grant("top", "child", EXTERN)
        self.assertEqual(org.extern_holders(), ["child"])

        kiosk = self.ledger.Org.create("kiosk-holder")
        kiosk.d["kiosk"] = {"enabled": True}
        kiosk.nodes["top"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        with self.assertRaises(self.ledger.LedgerError):
            kiosk.audience_grant(USER, "top", EXTERN)

    def test_competing_grants_are_serialized_to_one_persisted_holder(self):
        org = self.ledger.Org.create("concurrent-holder")
        org.nodes["alice"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        org.nodes["bob"] = {"state": "live", "parent": None, "generation": 1, "model": "opus"}
        self.store.save_org(org)
        start = threading.Barrier(2)
        errors: list[BaseException] = []

        def grant(holder: str) -> None:
            try:
                start.wait(timeout=5)
                with self.store.DOC_LOCK:
                    current = self.store.load_org("concurrent-holder")
                    current.audience_grant(USER, holder, EXTERN)
                    self.store.save_org(current)
            except BaseException as exc:  # report both worker failures
                errors.append(exc)

        workers = [threading.Thread(target=grant, args=(holder,))
                   for holder in ("alice", "bob")]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)
        self.assertEqual(errors, [])
        current = self.store.load_org("concurrent-holder")
        self.assertEqual(len(current.extern_holders()), 1)
        self.assertEqual(len([a for a in current.d["audiences"]
                              if a["grantor"] == EXTERN]), 1)

if __name__ == '__main__':
    unittest.main()
