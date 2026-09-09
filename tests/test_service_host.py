"""Boot host: descriptor only after readiness, identity-gated attachment.

The integration test runs the REAL chain — service_host -> launch.py ->
guardian/uvicorn — under a throwaway data root, then proves the token gate
with a positive AND a negative request before asking for shutdown. It needs
the engine's own dependencies (fastapi/uvicorn); when they are missing it
declares itself UNEXECUTED via SkipTest rather than passing vacuously.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from engine import service_host
from engine.service_host import (DESCRIPTOR, parse_ready, pin_profile_environment,
                                 remove_descriptor, resolve_data_root, resolve_ui_dir,
                                 write_descriptor)

READY = {"type": "ready", "protocol": 1, "port": 12345, "pid": 77, "dataRootId": ""}


class ServiceHostUnitTests(unittest.TestCase):
    def test_data_root_prefers_explicit_override(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.dict(os.environ, {"ORGTREE_V2_DATA": root}):
                self.assertEqual(resolve_data_root(), Path(root).resolve())

    def test_data_root_derives_appdata_from_userprofile(self):
        with tempfile.TemporaryDirectory() as profile:
            env = {"USERPROFILE": profile}
            with patch.dict(os.environ, env, clear=True):
                expected = (Path(profile) / "AppData" / "Roaming" / "Orgtree v2" / "data").resolve()
                self.assertEqual(resolve_data_root(), expected)
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError):
                    resolve_data_root()

    def test_profile_pinning_fills_only_missing(self):
        env = pin_profile_environment({"USERPROFILE": r"C:\Users\someone", "APPDATA": r"D:\kept"})
        self.assertEqual(env["APPDATA"], r"D:\kept")
        self.assertEqual(env["LOCALAPPDATA"], str(Path(r"C:\Users\someone") / "AppData" / "Local"))
        self.assertEqual(env["HOME"], r"C:\Users\someone")
        self.assertEqual(pin_profile_environment({"A": "b"}), {"A": "b"})

    def test_ui_dir_requires_index(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {"ORGTREE_V2_UI_DIR": folder}):
                with self.assertRaisesRegex(RuntimeError, "index.html"):
                    resolve_ui_dir()
                (Path(folder) / "index.html").write_text("<!doctype html>", encoding="utf-8")
                self.assertEqual(resolve_ui_dir(), Path(folder).resolve())

    def test_ready_parsing_rejects_the_wrong_engine(self):
        with tempfile.TemporaryDirectory() as root:
            good = dict(READY, dataRootId=str(Path(root).resolve()))
            self.assertIsNone(parse_ready("not json", 77, Path(root)))
            self.assertIsNone(parse_ready(json.dumps({"type": "log"}), 77, Path(root)))
            self.assertEqual(parse_ready(json.dumps(good), 77, Path(root)), good)
            for delta, pid in ((dict(protocol=2), 77), (dict(port=0), 77), (dict(port="80"), 77),
                               (dict(pid=78), 77), (dict(dataRootId="relative"), 77),
                               ({}, 78)):
                with self.subTest(delta=delta, pid=pid), self.assertRaises(RuntimeError):
                    parse_ready(json.dumps(dict(good, **delta)), pid, Path(root))
            with self.assertRaisesRegex(RuntimeError, "root mismatch"):
                parse_ready(json.dumps(dict(good, dataRootId=str(Path(root).resolve() / "other"))), 77, Path(root))

    def test_descriptor_lifecycle_never_deletes_a_newer_hosts_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            token = "ab" * 32
            write_descriptor(path, 23456, 77, token)
            value = json.loads((path / DESCRIPTOR).read_text(encoding="utf-8"))
            self.assertEqual(value, {"type": "attach", "protocol": 1, "port": 23456,
                                     "enginePid": 77, "hostPid": os.getpid(),
                                     "dataRootId": str(path.resolve()), "token": token,
                                     "startedAt": value["startedAt"]})
            remove_descriptor(path)
            self.assertFalse((path / DESCRIPTOR).exists())
            foreign = dict(value, hostPid=os.getpid() + 1)
            (path / DESCRIPTOR).write_text(json.dumps(foreign), encoding="utf-8")
            remove_descriptor(path)
            self.assertTrue((path / DESCRIPTOR).exists(), "a newer host's descriptor must survive")


def _request(url: str, token: str | None, method: str = "GET") -> tuple[int, dict]:
    headers = {"X-Orgtree-Desktop-Token": token} if token else {}
    request = urllib.request.Request(url, method=method, headers=headers,
                                     data=b"" if method == "POST" else None)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, {}


class ServiceHostIntegrationTests(unittest.TestCase):
    """Real host + real engine under a throwaway root; no provider contact."""

    @classmethod
    def setUpClass(cls):
        try:
            import fastapi, uvicorn  # noqa: F401
        except ImportError as exc:  # declare UNEXECUTED, never a silent pass
            raise unittest.SkipTest(f"engine dependencies unavailable: {exc}")
        if os.name != "nt":
            raise unittest.SkipTest("guardian requires Windows")

    def test_descriptor_identity_and_graceful_stop(self):
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / "data"; data.mkdir()
            ui = Path(temp) / "ui"; (ui / "assets").mkdir(parents=True)
            (ui / "index.html").write_text("<!doctype html>", encoding="utf-8")
            env = {**os.environ, "ORGTREE_V2_DATA": str(data), "ORGTREE_V2_UI_DIR": str(ui)}
            for key in ("ORGTREE_DATA", "ORGTREE_PORT", "ORGTREE_BASE", "ORGTREE_V2_PORT", "ORGTREE_V2_TOKEN"):
                env.pop(key, None)
            host = subprocess.Popen([sys.executable, str(repo / "engine" / "service_host.py")],
                                    cwd=str(repo), env=env, stderr=subprocess.PIPE)
            try:
                descriptor = data / DESCRIPTOR
                deadline = time.monotonic() + 90
                while not descriptor.exists() and host.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.2)
                if host.poll() is not None:
                    self.fail(f"host exited early: {host.stderr.read().decode('utf-8', 'replace')[-2000:]}")
                self.assertTrue(descriptor.exists(), "descriptor was not written after readiness")
                value = json.loads(descriptor.read_text(encoding="utf-8"))
                self.assertEqual(value["protocol"], 1)
                self.assertEqual(value["hostPid"], host.pid)
                self.assertEqual(Path(value["dataRootId"]).resolve(), data.resolve())
                port, token = value["port"], value["token"]

                base = f"http://127.0.0.1:{port}"
                status, identity = _request(base + "/api/desktop/identity", token)
                self.assertEqual(status, 200)
                self.assertEqual(identity["protocol"], 1)
                self.assertEqual(identity["pid"], value["enginePid"])
                self.assertEqual(Path(identity["dataRootId"]).resolve(), data.resolve())
                # Negative control: the identity route is token-gated.
                status, _ = _request(base + "/api/desktop/identity", None)
                self.assertEqual(status, 401)
                status, _ = _request(base + "/api/desktop/identity", "0" * 64)
                self.assertEqual(status, 401)

                status, body = _request(base + "/api/desktop/shutdown", token, method="POST")
                self.assertEqual(status, 200)
                self.assertEqual(body, {"accepted": True})
                host.wait(timeout=45)
                self.assertEqual(host.returncode, 0, "engine's own shutdown is a clean host exit")
                self.assertFalse(descriptor.exists(), "descriptor must be removed on stop")
            finally:
                if host.poll() is None:
                    host.kill()
                    host.wait(timeout=15)
                if host.stderr:
                    host.stderr.close()


if __name__ == "__main__":
    unittest.main()
