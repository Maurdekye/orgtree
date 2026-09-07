import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from engine.launch import _port, data_root_id, validate_data_root


class EngineLaunchTests(unittest.TestCase):
    def test_root_is_explicit_and_identity_is_stable(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            self.assertEqual(data_root_id(path), str(path.resolve()))
            self.assertEqual(validate_data_root(path), path.resolve())

    def test_missing_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.dict(os.environ, {"ORGTREE_V1_ROOT": root}):
                with self.assertRaises(RuntimeError):
                    validate_data_root(Path(root) / "missing")

    def test_existing_v1_overlap_is_refused_with_safe_sibling_control(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / 'home'; home.mkdir()
            live = home / 'orgtree'; live.mkdir()
            child = live / 'child'; child.mkdir()
            sibling = Path(root) / 'v2'; sibling.mkdir()
            with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {}, clear=True):
                for candidate in (live, child, home):
                    with self.subTest(candidate=candidate), self.assertRaisesRegex(RuntimeError, 'overlaps'):
                        validate_data_root(candidate)
                self.assertEqual(validate_data_root(sibling), sibling.resolve())

    def test_port_is_persisted_and_reused(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            first = _port(path)
            self.assertEqual(_port(path), first)
            self.assertEqual(json.loads((path / "engine-port.json").read_text())["port"], first)


if __name__ == "__main__":
    unittest.main()
