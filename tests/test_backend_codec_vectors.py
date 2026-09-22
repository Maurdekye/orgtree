"""The Rust backend-codec vectors still describe the current Python source.

The committed file engine/native/backend-codec/vectors/backend-codec-vectors.json
is regenerated here from the backend's own functions and compared byte for
byte. The controls then replace one backend function at a time and show the
regenerated vectors change, so the oracle really consumes the source it names.
No listener, live data or provider is involved.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_temp = tempfile.TemporaryDirectory(prefix="backend-codec-oracle-")
os.environ["ORGTREE_DATA"] = _temp.name

import import_provenance  # noqa: E402,F401
from orgtree import agentauth, ledger, openrouter  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    "backend_codec_oracle", ROOT / "engine/native/backend-codec/oracle/generate_vectors.py")
assert _SPEC and _SPEC.loader
oracle = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(oracle)

COMMITTED = (ROOT / "engine/native/backend-codec/vectors/backend-codec-vectors.json").read_text(encoding="utf-8")


def regenerate() -> str:
    return json.dumps(oracle.build(ROOT), ensure_ascii=True, indent=1) + "\n"


class BackendCodecVectors(unittest.TestCase):
    def test_committed_vectors_match_current_source(self):
        self.assertEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_rounding(self):
        with patch.object(ledger, "_q", lambda x: math.floor(x * 100 + 0.5) / 100 if math.isfinite(x) else x):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_seat_rule(self):
        with patch.object(openrouter, "seat_for", lambda p: 1.0):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_slug_rule(self):
        with patch.object(ledger, "slugify", lambda n: n.lower() or "x"):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_uses_the_real_credential_verifier(self):
        with patch.object(agentauth, "verify", lambda token: None):
            self.assertNotEqual(regenerate(), COMMITTED)

    def test_oracle_refuses_missing_source_anchor(self):
        with patch.dict(oracle.REQUIRED_SOURCE, {"engine/backend/orgtree/api.py": ["no such source text"]}):
            with self.assertRaises(SystemExit):
                oracle.build(ROOT)


if __name__ == "__main__":
    unittest.main()
