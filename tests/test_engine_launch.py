import errno
import os
import json
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from engine import launch
from engine.launch import _FRESH_PORT_RANGE, _port, data_root_id, validate_data_root


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

    def test_fresh_port_avoids_windows_dynamic_range(self):
        with tempfile.TemporaryDirectory() as root:
            port = _port(Path(root))
            self.assertTrue(_FRESH_PORT_RANGE[0] <= port <= _FRESH_PORT_RANGE[1], port)

    def test_occupied_persisted_port_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind(("127.0.0.1", 0)); listener.listen(1)
                held = listener.getsockname()[1]
                (path / "engine-port.json").write_text(json.dumps({"port": held}))
                with self.assertRaisesRegex(RuntimeError, "occupied"):
                    _port(path)
                self.assertEqual(json.loads((path / "engine-port.json").read_text())["port"], held)

    def test_unbindable_persisted_port_is_replaced_and_persisted(self):
        # Windows answers a bind inside a Hyper-V/WinNAT reserved range with
        # WSAEACCES although nothing listens there. That port can never serve
        # the UI again, so startup must move the origin instead of refusing.
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            reserved = 49928
            (path / "engine-port.json").write_text(json.dumps({"port": reserved}))
            real = launch._bind_error
            def bind_error(port):
                if port == reserved:
                    return PermissionError(errno.EACCES, "An attempt was made to access a socket in a way forbidden by its access permissions")
                return real(port)
            with patch.object(launch, "_bind_error", bind_error):
                port = _port(path)
            self.assertNotEqual(port, reserved)
            self.assertEqual(json.loads((path / "engine-port.json").read_text())["port"], port)
            self.assertEqual(_port(path), port)


if __name__ == "__main__":
    unittest.main()
