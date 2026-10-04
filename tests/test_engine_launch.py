import errno
import os
import json
import socket
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import hub_isolation

import engine.launch as launch  # pure module; the child enforces isolation before boot
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

    @unittest.skipUnless(os.name == "nt", "Windows process priority")
    def test_launch_raises_actual_priority_before_starting_workers(self):
        # Exercise main in a private child initially at BelowNormal, as an old
        # task starts it. Stop at the database boundary: no engine or PG starts.
        # GetPriorityClass reads the real process, not a mocked Windows API.
        repo = Path(__file__).resolve().parent.parent
        code = r'''
import sys, os, ctypes, subprocess
from pathlib import Path
repo = Path(sys.argv[1])
sys.path.insert(0, str(repo / "tools"))
from assert_repo_import import assert_repo_import
assert_repo_import(repo)
sys.path.insert(0, str(repo / "tests"))
import hub_isolation
os.environ["ORGTREE_DATA"] = sys.argv[2]
hub_isolation.enforce_isolated_root(Path(sys.argv[2]))
from engine import launch
from unittest.mock import patch
from ctypes import wintypes
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.GetCurrentProcess.restype = wintypes.HANDLE
k.GetPriorityClass.argtypes = [wintypes.HANDLE]
k.GetPriorityClass.restype = wintypes.DWORD
k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
handle = k.GetCurrentProcess()
assert k.SetPriorityClass(handle, 0x4000)
assert k.GetPriorityClass(handle) == 0x4000
class Finished(Exception): pass
def database(*args):
    assert k.GetPriorityClass(handle) == 0x80, "engine did not run at High"
    # A default worker from High starts at Normal, keeping PG unchanged.
    worker = subprocess.check_output([sys.executable, "-I", "-c",
        "import ctypes; from ctypes import wintypes; k=ctypes.WinDLL('kernel32'); "
        "k.GetCurrentProcess.restype=wintypes.HANDLE; "
        "k.GetPriorityClass.argtypes=[wintypes.HANDLE]; "
        "print(k.GetPriorityClass(k.GetCurrentProcess()))"],
        creationflags=subprocess.CREATE_NO_WINDOW, text=True)
    assert int(worker.strip()) == 0x20, "worker inherited High"
    print("measured engine=High worker=Normal", flush=True)
    raise Finished()
os.environ["ORGTREE_DATA"] = sys.argv[2]
with patch("engine.enginelog.install"), patch("engine.startup_progress.StartupProgress"), \
     patch("engine.process_lifetime.arm_process_lifetime", return_value=0), \
     patch.object(launch, "_own_database", database):
    try: launch.main()
    except Finished: pass
'''
        with tempfile.TemporaryDirectory() as root:
            hub_isolation.isolate_data_root(root)
            env = dict(os.environ)
            hub_isolation.scrub_inherited_hub(env)
            result = subprocess.run([sys.executable, "-I", "-c", code, str(repo), root],
                                    capture_output=True, text=True, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW, env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("measured engine=High worker=Normal", result.stdout)

    def test_priority_failure_stops_before_database_or_provider_start(self):
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"ORGTREE_DATA": root}), \
                patch.object(launch, "_set_engine_priority", side_effect=OSError("priority refused")), \
                patch("engine.enginelog.install"), \
                patch("engine.startup_progress.StartupProgress"), \
                patch("engine.process_lifetime.arm_process_lifetime", return_value=0), \
                patch.object(launch, "_own_database") as database, \
                patch.object(launch, "load_app") as app:
            with self.assertRaisesRegex(OSError, "priority refused"):
                launch.main()
            database.assert_not_called()
            app.assert_not_called()

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
        # WSAEACCES although nothing listens there. Nothing this process can
        # do makes that port serve the UI on this boot, so startup moves the
        # origin instead of refusing. The reservation may well be gone after
        # the next reboot; the point is only that waiting does not help now.
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
        # Moving the origin makes whatever the browser stored under the old
        # one unreachable (storage is per origin; it is not deleted), so a
        # bind failure that is neither a listener nor a reserved range
        # refuses startup rather than guessing about the port.
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
