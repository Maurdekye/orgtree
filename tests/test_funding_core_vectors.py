"""The Rust funding-core vectors still describe the current Python ledger.

The committed file engine/native/funding-core/vectors/funding-vectors.json is
regenerated here from `orgtree.ledger.Org` itself, on synthetic organizations
under a temporary ORGTREE_DATA, and compared byte for byte. The controls then
change one funding rule at a time and show the regenerated vectors change, so
the oracle really consumes the source it names rather than a copy of it. No
live data, listener, provider or database is involved.
"""
from __future__ import annotations

import builtins
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_temp = tempfile.TemporaryDirectory(prefix="funding-core-oracle-")
os.environ["ORGTREE_DATA"] = _temp.name

import import_provenance  # noqa: E402,F401
from orgtree import ledger  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    "funding_core_oracle", ROOT / "engine/native/funding-core/oracle/generate_vectors.py")
assert _SPEC and _SPEC.loader
oracle = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(oracle)

COMMITTED = (ROOT / "engine/native/funding-core/vectors/funding-vectors.json").read_text(encoding="utf-8")


def regenerate() -> str:
    return oracle.render(oracle.build(ROOT))


def _unsorted_children(self, nid, live_only=True, index=None):
    return [k for k, v in self.nodes.items() if v["parent"] == nid
            and (self.nodes[k]["state"] != "archived" or not live_only)]


def _plain_sum(items, start=0):
    total = start
    for x in items:
        total = total + x
    return total


class FundingCoreVectors(unittest.TestCase):
    def test_committed_vectors_match_current_source(self):
        self.assertEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_quantiser(self):
        with patch.object(ledger, "_q", lambda x: round(x, 3)):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_children_order(self):
        with patch.object(ledger.Org, "children", _unsorted_children):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_top_grant_cap(self):
        with patch.object(ledger.Org, "_check_top_grant", lambda self, g, ctx: None):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_stranding_rule(self):
        with patch.object(ledger.Org, "_stranding_warnings", lambda self, *a, **k: []):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_runtime_sum(self):
        # committed() calls the builtin sum(); a plain left-to-right sum
        # changes the summation-sensitive rows
        with patch.object(builtins, "sum", _plain_sum):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_refuses_unknown_refusal_patterns(self):
        with patch.object(oracle, "KNOWN_PREFIXES", ()), patch.object(oracle, "KNOWN_INFIXES", ()):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_oracle_refuses_moved_ledger_constants(self):
        with patch.object(ledger, "CREDIT_PLACES", 3):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_accounting_names_an_unreported_funding_key(self):
        got = oracle.unaccounted({"d:cascade_hire", "t:haiku", "f:mid:scope", "d:max_depth", "n:newhire"},
                                 {"t:haiku"}, set(), {"newhire"})
        self.assertEqual(got, {"d:cascade_hire"})

    def test_hire_rehire_keys_cannot_vanish(self):
        # a helper whose reads are dropped instead of set aside is exactly
        # the silent omission the accounting exists to catch
        def dropping(fn):
            def wrapper(*a, **k):
                prev = oracle.REC["sink"]
                oracle.REC["sink"] = set()
                try:
                    return fn(*a, **k)
                finally:
                    oracle.REC["sink"] = prev
            return wrapper
        with patch.object(oracle, "aside", dropping):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)

    def test_hire_rehire_report_funding_inputs_outside_the_acquisition(self):
        import json
        doc = json.loads(COMMITTED)
        hire_reads = set().union(*(r["reads"] for r in doc["hire"]))
        rehire_reads = set().union(*(r["reads"] for r in doc["rehire"]))
        rehire_writes = set().union(*(r["writes"] for r in doc["rehire"]))
        self.assertIn("d:cascade_hire", hire_reads)
        self.assertIn("d:cascade_hire", rehire_reads)
        self.assertTrue(any(k.startswith("f:") and k.endswith(":successor") for k in rehire_reads))
        self.assertTrue(any(k.endswith(":state") for k in rehire_writes))
        for r in doc["hire"] + doc["rehire"]:
            for k in r["reads"] + r["writes"]:
                self.assertFalse(k.endswith((":scope", ":archived_at")), k)

    def test_vectors_anchor_the_ledger_source(self):
        import hashlib
        import json
        anchors = json.loads(COMMITTED)["oracle"]["anchors"]
        src = (ROOT / "engine/backend/orgtree/ledger.py").read_bytes()
        self.assertEqual(anchors["engine/backend/orgtree/ledger.py"], hashlib.sha256(src).hexdigest())


if __name__ == "__main__":
    unittest.main()
