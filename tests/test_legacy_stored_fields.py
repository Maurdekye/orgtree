"""An organization stored by an earlier version still carries the fields of a
feature that has since been removed (ledger.IGNORED_LEGACY_KEYS and
ledger.IGNORED_LEGACY_FREEZE_FLAGS). It must load, render and save without
error, keep those stored fields byte for byte, and gain no behaviour from
them: a legacy freeze flag never blocks ▶ resume, and a stale storage block
on a host-folder org clears itself.

Synthetic data only, under a fresh temporary ORGTREE_DATA.
Run:  python tools/run-python-verification.py tests/test_legacy_stored_fields.py
"""
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

_root = tempfile.mkdtemp(prefix="legacy-fields-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, sandbox, store, supervisor  # noqa: E402

# the exact shape an earlier version stored for this feature
LEGACY = {
    ledger.IGNORED_LEGACY_KEYS[0]: {
        "enabled": True, "token": "legacy-token", "credits": 5,
        "spend_limit": 1.5, "storage_limit_mb": 10, "sandbox": False,
        "max_scope": {"tools": {"bash": True, "mcp": ["*"]}, "add_dirs": [],
                      "org_visibility": "team", "max_tier": "haiku"},
    },
    ledger.IGNORED_LEGACY_KEYS[1]: True,
}


class LegacyFields(unittest.TestCase):
    def test_the_constants_name_the_removed_fields(self):
        self.assertEqual(len(ledger.IGNORED_LEGACY_KEYS), 2)
        self.assertIn("spend_frozen", ledger.IGNORED_LEGACY_KEYS)
        self.assertEqual(ledger.IGNORED_LEGACY_FREEZE_FLAGS, ("spend",))

    def test_an_org_with_legacy_fields_loads_renders_and_keeps_them(self):
        org = store.create_org("legacy fields")
        slug = org.d["slug"]
        org.d.update(copy.deepcopy(LEGACY))
        store.save_org(org)
        loaded = store.load_org(slug)
        for key, value in LEGACY.items():
            self.assertEqual(loaded.d.get(key), value, key)
        tree = loaded.tree()                 # renders without the old block
        for key in LEGACY:
            self.assertNotIn(key, tree)
        self.assertNotIn("public", tree)
        # a later save (any ordinary write) keeps the stored fields as they were
        store.save_org(loaded)
        again = store.load_org(slug)
        for key, value in LEGACY.items():
            self.assertEqual(again.d.get(key), value, key)

    def test_a_legacy_spend_freeze_is_resumable(self):
        node = {"state": "live", "frozen": {"spend": True,
                                            "spend_error": "old spend limit",
                                            "at": "2026-01-01T00:00:00Z"}}
        self.assertIsNotNone(supervisor._resumable(node))
        # CONTROL: a freeze kind that still owns the node keeps ▶ away
        owned = {"state": "live", "frozen": {"unknown_kind": True,
                                             "at": "2026-01-01T00:00:00Z"}}
        self.assertIsNone(supervisor._resumable(owned))

    def test_a_stale_storage_block_on_a_host_folder_org_clears(self):
        org = store.create_org("legacy storage")
        slug = org.d["slug"]
        self.assertFalse(sandbox.is_sandboxed(org))
        org.d["storage_blocked"] = True
        org.d["storage_warned"] = True
        store.save_org(org)
        self.assertEqual(supervisor.storage_check(slug), "cleared")
        after = store.load_org(slug)
        self.assertNotIn("storage_blocked", after.d)
        self.assertNotIn("storage_warned", after.d)
        # nothing left to clear: a second check is a no-op
        self.assertIsNone(supervisor.storage_check(slug))


if __name__ == "__main__":
    unittest.main()
