"""The Rust scope-clamp vectors still describe the current Python ledger.

The committed engine/native/scope-clamp/vectors/scope-clamp-vectors.json and
the generated engine/native/scope-clamp/src/tables.rs are regenerated here
from `orgtree.ledger` and the runtime's own `ntpath`, on synthetic inputs
under a temporary ORGTREE_DATA, and compared byte for byte. The controls then
change one input of the oracle at a time and show the regenerated output
changes (or the oracle refuses), so it really consumes the source it names.
No live data, listener, provider or database is involved.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_temp = tempfile.TemporaryDirectory(prefix="scope-clamp-oracle-")
os.environ["ORGTREE_DATA"] = _temp.name

import import_provenance  # noqa: E402,F401
from orgtree import ledger  # noqa: E402

CRATE = ROOT / "engine/native/scope-clamp"
_SPEC = importlib.util.spec_from_file_location("scope_clamp_oracle", CRATE / "oracle/generate_vectors.py")
assert _SPEC and _SPEC.loader
oracle = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(oracle)

COMMITTED = (CRATE / "vectors/scope-clamp-vectors.json").read_text(encoding="utf-8")
TABLES = (CRATE / "src/tables.rs").read_text(encoding="utf-8")


def regenerate() -> tuple[str, str]:
    doc, tables = oracle.build(ROOT)
    return oracle.render(doc), tables


def _keep_all_dirs(requested, parent_map, strict, who="the parent"):
    return list(requested), []


def _keep_all_tools(requested, parent_tools, strict, who="parent"):
    return ledger.norm_tools(requested), []


class ScopeClampVectors(unittest.TestCase):
    def test_committed_vectors_and_tables_match_current_source(self):
        text, tables = regenerate()
        self.assertEqual(text, COMMITTED)
        self.assertEqual(tables, TABLES)

    def test_oracle_uses_the_real_folder_clamp(self):
        with patch.object(ledger.Org, "_clamp_dirs", staticmethod(_keep_all_dirs)):
            self.assertNotEqual(regenerate()[0], COMMITTED)

    def test_oracle_uses_the_real_tool_clamp(self):
        with patch.object(ledger.Org, "_clamp_tools", staticmethod(_keep_all_tools)):
            self.assertNotEqual(regenerate()[0], COMMITTED)

    def test_oracle_uses_the_real_tier_table(self):
        with patch.dict(ledger.TIERS, {"haiku": 3}):
            text, tables = regenerate()
        self.assertNotEqual(text, COMMITTED)
        self.assertNotEqual(tables, TABLES)

    def test_oracle_refuses_a_normcase_that_is_not_the_windows_table(self):
        with patch.object(ntpath, "normcase", lambda s: s.lower()):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_oracle_refuses_unknown_refusal_patterns(self):
        with patch.object(oracle, "KNOWN_PREFIXES", ()), patch.object(oracle, "KNOWN_INFIXES", ()):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_oracle_refuses_moved_level_constants(self):
        with patch.object(ledger, "VIS_LEVELS", ("self", "subtree", "full")):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_vectors_anchor_the_ledger_source(self):
        anchors = json.loads(COMMITTED)["oracle"]["anchors"]
        src = (ROOT / "engine/backend/orgtree/ledger.py").read_bytes()
        self.assertEqual(anchors["engine/backend/orgtree/ledger.py"], hashlib.sha256(src).hexdigest())


if __name__ == "__main__":
    unittest.main()
