"""Boot host: descriptor only after readiness, identity-gated attachment.

The integration test runs the REAL chain — service_host -> launch.py ->
guardian/uvicorn — under a throwaway data root, then proves the token gate
with a positive AND a negative request before asking for shutdown. It needs
the engine's own dependencies (fastapi/uvicorn); when they are missing it
declares itself UNEXECUTED via SkipTest rather than passing vacuously.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from engine import service_host
from engine.service_host import (DESCRIPTOR, clear_stale_descriptor, parse_ready,
                                 pin_profile_environment, remove_descriptor,
                                 resolve_data_root, resolve_ui_dir, write_descriptor)

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

    def test_descriptor_acl_restriction_leaves_owner_system_admins_only(self):
        if os.name != "nt":
            raise unittest.SkipTest("NTFS ACLs are Windows-only")
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / DESCRIPTOR
            target.write_text("{}", encoding="utf-8")
            self.assertTrue(service_host.restrict_descriptor_acl(target))
            script = ("$acl=Get-Acl -LiteralPath '" + str(target).replace("'", "''") + "';"
                      "$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);"
                      "$sids=@($rules | ForEach-Object { $_.IdentityReference.Value });"
                      "$inherited=@($rules | Where-Object { $_.IsInherited });"
                      "Write-Output (($sids -join ',')+'|'+$inherited.Count)")
            output = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                    capture_output=True, text=True, timeout=30, check=True).stdout.strip()
            sids, inherited = output.rsplit("|", 1)
            me = service_host._current_user_sid()
            self.assertEqual(sorted(set(sids.split(","))), sorted({me, "S-1-5-18", "S-1-5-32-544"}), output)
            self.assertEqual(inherited, "0", "inheritance must be stripped so profile-wide read grants do not apply")

    def test_published_descriptor_carries_the_restricted_acl(self):
        if os.name != "nt":
            raise unittest.SkipTest("NTFS ACLs are Windows-only")
        with tempfile.TemporaryDirectory() as root:
            published = write_descriptor(Path(root), 23456, 77, "ab" * 32)
            script = ("$acl=Get-Acl -LiteralPath '" + str(published).replace("'", "''") + "';"
                      "$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);"
                      "Write-Output ((@($rules | ForEach-Object { $_.IdentityReference.Value }) -join ',')+'|'+@($rules | Where-Object { $_.IsInherited }).Count)")
            output = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                    capture_output=True, text=True, timeout=30, check=True).stdout.strip()
            sids, inherited = output.rsplit("|", 1)
            self.assertEqual(sorted(set(sids.split(","))),
                             sorted({service_host._current_user_sid(), "S-1-5-18", "S-1-5-32-544"}), output)
            self.assertEqual(inherited, "0", "the token must never sit under inherited ACLs")

    def test_write_descriptor_fails_closed_when_protection_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(service_host, "_current_user_sid", return_value=None):
                with self.assertRaisesRegex(OSError, "refusing to publish"):
                    write_descriptor(Path(root), 23456, 77, "ab" * 32)
            self.assertEqual(list(Path(root).iterdir()), [], "neither token nor temp file may survive")

    def test_write_descriptor_fails_closed_when_verification_fails(self):
        # icacls exiting 0 is a receipt, not proof: an unverifiable DACL must
        # also refuse publication and leave nothing behind.
        with tempfile.TemporaryDirectory() as root:
            with patch.object(service_host, "restrict_descriptor_acl", return_value=True), \
                 patch.object(service_host, "verify_restricted_acl", return_value=False):
                with self.assertRaisesRegex(OSError, "refusing to publish"):
                    write_descriptor(Path(root), 23456, 77, "ab" * 32)
            self.assertEqual(list(Path(root).iterdir()), [], "neither token nor temp file may survive")

    def test_preexisting_temp_path_is_never_truncated_or_adopted(self):
        # O_EXCL control (root ruling): pin the random name, pre-create that
        # exact path with foreign content — publication must refuse and the
        # preexisting file must survive byte-for-byte, never truncated,
        # followed or deleted (cleanup owns only temps IT created).
        with tempfile.TemporaryDirectory() as root:
            with patch.object(service_host.secrets, "token_hex", return_value="feedfeedfeedfeed"):
                planted = Path(root) / f".engine-attach-{os.getpid()}-feedfeedfeedfeed.tmp"
                planted.write_bytes(b"foreign-bytes")
                with self.assertRaises(OSError):
                    write_descriptor(Path(root), 23456, 77, "ab" * 32)
                self.assertEqual(planted.read_bytes(), b"foreign-bytes",
                                 "a preexisting path must never be truncated or adopted")
                self.assertFalse((Path(root) / DESCRIPTOR).exists())

    def test_confirmed_exit_confirms_or_reports_honestly(self):
        # Positive: a real child is killed AND its exit is confirmed.
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"])
        self.assertTrue(service_host.confirmed_exit(child, timeout=15))
        self.assertIsNotNone(child.poll())
        # Negative control: a child whose wait never completes reports False
        # instead of pretending the kill worked.
        class Stubborn:
            def poll(self):
                return None
            def kill(self):
                pass
            def wait(self, timeout=None):
                raise subprocess.TimeoutExpired(cmd="stub", timeout=timeout)
        self.assertFalse(service_host.confirmed_exit(Stubborn(), timeout=0.1))  # type: ignore[arg-type]

    def test_protected_birth_denies_every_second_handle_and_survives_close(self):
        # The measured hole (Opus): a handle opened before a later restriction
        # retains read on bytes written afterwards. Here that handle can never
        # exist: while ours lives, ANY second open by path is denied
        # (share=0), and the DACL attached at birth denies... nothing to us
        # (we are the granted SID) but leaves zero inherited rules.
        if os.name != "nt":
            raise unittest.SkipTest("Windows-only")
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "probe.tmp"
            fd = service_host.create_protected_exclusive(target, service_host._current_user_sid())
            try:
                with self.assertRaises(OSError, msg="no second handle may exist while the token handle lives"):
                    open(target, "rb").close()
                os.write(fd, b"SECRET")
            finally:
                os.close(fd)
            self.assertEqual(target.read_bytes(), b"SECRET")  # our own SID reads post-close
            self.assertTrue(service_host.verify_restricted_acl(target),
                            "DACL at birth: exactly operator+SYSTEM+Administrators, nothing inherited")
            with self.assertRaises(OSError):
                service_host.create_protected_exclusive(target, service_host._current_user_sid())
            self.assertEqual(target.read_bytes(), b"SECRET", "CREATE_NEW must never adopt or truncate")

    def test_published_descriptor_is_protected_and_leaves_no_residue(self):
        if os.name != "nt":
            raise unittest.SkipTest("Windows-only")
        with tempfile.TemporaryDirectory() as root:
            published = write_descriptor(Path(root), 23456, 77, "ab" * 32)
            self.assertIn("ab" * 32, published.read_text(encoding="utf-8"))
            self.assertTrue(service_host.verify_restricted_acl(published))
            leftovers = [p.name for p in Path(root).iterdir() if p.name != DESCRIPTOR]
            self.assertEqual(leftovers, [], "no temporary residue after publication")

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


class StaleDescriptorTests(unittest.TestCase):
    TOKEN = "cd" * 32

    def _serve_identity(self, root: Path):
        token = self.TOKEN
        class Identity(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/api/desktop/identity" or self.headers.get("X-Orgtree-Desktop-Token") != token:
                    self.send_response(401); self.end_headers(); return
                body = json.dumps({"protocol": 1, "pid": 123, "dataRootId": str(root.resolve())}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Identity)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port

    def _descriptor(self, root: Path, port: int, token: str) -> Path:
        path = root / DESCRIPTOR
        path.write_text(json.dumps({"type": "attach", "protocol": 1, "port": port,
                                    "enginePid": 123, "hostPid": 99999,
                                    "dataRootId": str(root.resolve()), "token": token}),
                        encoding="utf-8")
        return path

    def test_absent_descriptor_is_a_noop(self):
        with tempfile.TemporaryDirectory() as temp:
            clear_stale_descriptor(Path(temp))

    def test_dead_port_and_garbage_descriptors_are_cleared(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            import socket
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0)); dead = probe.getsockname()[1]
            path = self._descriptor(root, dead, self.TOKEN)
            clear_stale_descriptor(root)
            self.assertFalse(path.exists())
            path.write_text("not json", encoding="utf-8")
            clear_stale_descriptor(root)
            self.assertFalse(path.exists())

    def test_live_verified_host_is_refused_and_its_file_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            port = self._serve_identity(root)
            path = self._descriptor(root, port, self.TOKEN)
            with self.assertRaisesRegex(RuntimeError, "already serves"):
                clear_stale_descriptor(root)
            self.assertTrue(path.exists(), "a live host's descriptor must never be deleted")

    def test_wrong_token_or_foreign_root_descriptor_is_stale(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            port = self._serve_identity(root)
            path = self._descriptor(root, port, "00" * 32)  # engine 401s it
            clear_stale_descriptor(root)
            self.assertFalse(path.exists())
            foreign = root / "foreign"; foreign.mkdir()
            port2 = self._serve_identity(root)  # identity reports ROOT, not foreign
            path2 = self._descriptor(foreign, port2, self.TOKEN)
            clear_stale_descriptor(foreign)
            self.assertFalse(path2.exists())


class LaunchRefusalTests(unittest.TestCase):
    """The engine tells its parent WHY it refused, so a lost boot race is
    distinguishable from a broken engine (redteam-opus F4)."""

    def test_locked_root_produces_structured_refusal(self):
        if os.name != "nt":
            raise unittest.SkipTest("guardian requires Windows")
        from engine.process_lifetime import RootLock
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = RootLock(root)
            try:
                env = {**os.environ, "ORGTREE_DATA": str(root), "ORGTREE_V2_TOKEN": "ee" * 32,
                       "ORGTREE_V2_UI_DIR": str(root)}
                result = subprocess.run([sys.executable, str(repo / "engine" / "launch.py")],
                                        cwd=str(repo / "engine"), env=env, capture_output=True,
                                        timeout=60)
                self.assertNotEqual(result.returncode, 0)
                lines = [json.loads(l) for l in result.stdout.decode("utf-8", "replace").splitlines()
                         if l.strip().startswith("{")]
                refusals = [l for l in lines if l.get("type") == "refused"]
                self.assertEqual(len(refusals), 1, result.stdout[-500:])
                self.assertEqual(refusals[0]["code"], "root-owned",
                                 "the desktop retries on the machine code, not prose")
                self.assertIn("owns this data root", refusals[0]["reason"])
            finally:
                lock.close()

    def test_other_lifetime_failures_do_not_masquerade_as_refusals(self):
        # NARROW refusal (root ruling): a broken parent PID is a real fault
        # and must fail fast without the structured line that triggers the
        # desktop's attach-retry loop.
        if os.name != "nt":
            raise unittest.SkipTest("guardian requires Windows")
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            env = {**os.environ, "ORGTREE_DATA": str(root), "ORGTREE_V2_TOKEN": "ee" * 32,
                   "ORGTREE_V2_UI_DIR": str(root), "ORGTREE_V2_PARENT_PID": "-5"}
            result = subprocess.run([sys.executable, str(repo / "engine" / "launch.py")],
                                    cwd=str(repo / "engine"), env=env, capture_output=True,
                                    timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'"type":"refused"', result.stdout,
                             "only the root-ownership refusal may emit the structured line")


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
