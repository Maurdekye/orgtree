"""The Rust op-receipt-codec vectors still describe the current Python source.

The committed file engine/native/op-receipt-codec/vectors/op-receipt-vectors.json
is regenerated here from `orgtree.opreceipts` itself and compared byte for
byte. The controls then change one receipt rule at a time and show the
regenerated vectors change, so the oracle really consumes the source it names.
No listener, live data, custody epoch or provider is involved.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_temp = tempfile.TemporaryDirectory(prefix="op-receipt-oracle-")
os.environ["ORGTREE_DATA"] = _temp.name

import import_provenance  # noqa: E402,F401
from orgtree import opreceipts  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    "op_receipt_oracle", ROOT / "engine/native/op-receipt-codec/oracle/generate_vectors.py")
assert _SPEC and _SPEC.loader
oracle = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(oracle)

COMMITTED = (ROOT / "engine/native/op-receipt-codec/vectors/op-receipt-vectors.json").read_text(encoding="utf-8")
ASCII_KEY_RE = re.compile(r"^([0-9]{13,14})-([0-9a-f]{24})$")


def regenerate() -> str:
    return oracle.render(oracle.build(ROOT))


def ascii_parse_key(key):
    m = ASCII_KEY_RE.match(key or "")
    return int(m.group(1)) if m else None


class OpReceiptCodecVectors(unittest.TestCase):
    def test_committed_vectors_match_current_source(self):
        self.assertEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_horizon(self):
        with patch.object(opreceipts, "HORIZON_MS", opreceipts.HORIZON_MS + 1):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_skew(self):
        with patch.object(opreceipts, "SKEW_MS", opreceipts.SKEW_MS - 1):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_canonical_separators(self):
        loose = lambda obj: json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)  # noqa: E731
        with patch.object(opreceipts, "_canonical", loose):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_ceiling(self):
        with patch.object(opreceipts, "CEILING", opreceipts.CEILING - 1):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_key_parser(self):
        with patch.object(opreceipts, "parse_key", ascii_parse_key):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_restores_the_real_fp_node(self):
        real = opreceipts.fp_node
        regenerate()
        self.assertIs(opreceipts.fp_node, real)

    def test_oracle_refuses_missing_source_anchor(self):
        with patch.dict(oracle.REQUIRED_SOURCE, {"engine/backend/orgtree/opreceipts.py": ["no such source text"]}):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)


if __name__ == "__main__":
    unittest.main()
