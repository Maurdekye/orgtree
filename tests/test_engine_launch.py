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


# The floor of the Windows dynamic range, where the Hyper-V/WinNAT
# reservations that broke startup live. It is written out as a literal on
# purpose: comparing a chosen port against _FRESH_PORT_RANGE itself passes for
# every possible range, including the one that caused the fault.
WINDOWS_DYNAMIC_FLOOR = 49152


class EngineLaunchTests(unittest.TestCase):
    def setUp(self):
        # A developer's ORGTREE_V2_PORT would otherwise short-circuit _port and
        # make the port tests below assert nothing.
        patcher = patch.dict(os.environ, {"ORGTREE_V2_PORT": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)

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
        self.assertLess(_FRESH_PORT_RANGE[1], WINDOWS_DYNAMIC_FLOOR, _FRESH_PORT_RANGE)
        self.assertGreater(_FRESH_PORT_RANGE[0], 1024, _FRESH_PORT_RANGE)
        with tempfile.TemporaryDirectory() as root:
            port = _port(Path(root))
            self.assertLess(port, WINDOWS_DYNAMIC_FLOOR, port)
            self.assertGreater(port, 1024, port)

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

    def test_unrecognised_bind_failure_keeps_the_origin(self):
        # Moving the origin throws away the drafts and layout stored under the
        # old one, so a bind failure that is neither a listener nor a reserved
        # range refuses startup rather than guessing that the port is dead.
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / "engine-port.json").write_text(json.dumps({"port": 31337}))
            def bind_error(port):
                return OSError(errno.ENOBUFS, "no buffer space available")
            with patch.object(launch, "_bind_error", bind_error):
                with self.assertRaisesRegex(RuntimeError, "cannot be bound"):
                    _port(path)
            self.assertEqual(json.loads((path / "engine-port.json").read_text())["port"], 31337)


if __name__ == "__main__":
    unittest.main()
