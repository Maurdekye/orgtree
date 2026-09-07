import os
import json
from pathlib import Path
import tempfile
import unittest

from engine.launch import _port, data_root_id, validate_data_root


class EngineLaunchTests(unittest.TestCase):
    def test_root_is_explicit_and_identity_is_stable(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            self.assertEqual(data_root_id(path), str(path.resolve()))
            self.assertEqual(validate_data_root(path), path.resolve())

    def test_missing_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            os.environ["ORGTREE_V1_ROOT"] = root
            with self.assertRaises(RuntimeError):
                validate_data_root(Path(root) / "missing")

    def test_port_is_persisted_and_reused(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            first = _port(path)
            self.assertEqual(_port(path), first)
            self.assertEqual(json.loads((path / "engine-port.json").read_text())["port"], first)


if __name__ == "__main__":
    unittest.main()
