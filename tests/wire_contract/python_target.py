"""Python-only provisioning. Scenarios import no product implementation."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import tempfile
import threading

from .transport import LoopbackTransport, Stdio

ROOT = Path(__file__).resolve().parents[2]


def isolated_env(root: Path):
    # Start empty, not with the parent agent's provider credentials/settings.
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT",
                            "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS"}}
    home = root / "home"
    home.mkdir(exist_ok=True)
    temp = root / "temp"
    temp.mkdir(exist_ok=True)
    (root / "data").mkdir(exist_ok=True)
    (root / "ui").mkdir(exist_ok=True)
    (root / "ui" / "assets").mkdir(exist_ok=True)
    (root / "ui" / "index.html").write_text("<!doctype html><title>Wire fixture</title>", encoding="utf-8")
    env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "roaming"),
               LOCALAPPDATA=str(home / "local"), XDG_CONFIG_HOME=str(home / "config"),
               TEMP=str(temp), TMP=str(temp), TMPDIR=str(temp),
               ORGTREE_DATA=str(root / "data"), PYTHONUTF8="1",
               PYTHONIOENCODING="utf-8", ORGTREE_DESKTOP_MANAGED="1")
    return env


def python_command(script):
    # Embedded runtimes ignore cwd/PYTHONPATH. Pin this checkout explicitly.
    prelude = "import sys; sys.path[:0] = " + repr(
        [str(ROOT / "engine" / "backend"), str(ROOT), str(ROOT / "tests")]) + "; "
    return [sys.executable, "-I", "-B", "-c", prelude + script]


CONTROLS = {"live_identity_bypass", "receipt_admission_bypass", "reversed_gallery",
            "constant_stream_revision", "stale_snapshot_revision", "mcp_wrong_id"}


class PythonTarget(LoopbackTransport):
    def __init__(self, root, *, control=None):
        if control is not None and control not in CONTROLS:
            raise ValueError("Unknown wire negative control")
        self.control = control
        self.env = isolated_env(root)
        if control:
            self.env["ORGTREE_WIRE_UNSAFE_CONTROL"] = control
        self.token = secrets.token_urlsafe(32)
        self.env["ORGTREE_V2_TOKEN"] = self.token
        self.env["ORGTREE_V2_UI_DIR"] = str(root / "ui")
        self.log = (root / "server.log").open("w+", encoding="utf-8")
        try:
            self.process = subprocess.Popen(
                python_command("from tests.wire_contract.python_server import main; main()"),
                cwd=ROOT, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.log, text=True, encoding="utf-8")
        except BaseException:
            self.log.close()
            raise
        lines = queue.Queue()

        def read():
            for line in self.process.stdout:
                lines.put(line)
            lines.put(None)

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            # Credentials exist only in this private pipe, never the receipt.
            line = lines.get(timeout=30)
            if line is None:
                self.log.seek(0)
                diagnostic = self.log.read().replace(self.token, "<fixture-token>")
                raise AssertionError("Python fixture exited before readiness: " + diagnostic)
            ready = json.loads(line)
            if ready.get("schema") != "orgtree.wire-ready/v1":
                raise AssertionError("Unexpected fixture readiness frame")
            self.url = f"http://127.0.0.1:{ready['port']}"
            self.tokens = ready["agents"]
        except BaseException:
            self.close()
            raise

    def auth_headers(self, auth, org):
        if auth == "operator":
            return {"X-Orgtree-Desktop-Token": self.token}
        if auth == "bad-operator":
            return {"X-Orgtree-Desktop-Token": "synthetic-invalid"}
        if auth == "bad-agent":
            return {"X-Orgtree-Agent-Token": "synthetic-invalid"}
        if auth == "none":
            return {}
        return {"X-Orgtree-Agent-Token": self.tokens[org][auth]}

    def mcp(self, *, auth="caller", org="wire-actions", node="caller"):
        env = dict(self.env)
        env.pop("ORGTREE_V2_TOKEN", None)
        env.update(ORGTREE_PORT=self.url.rsplit(":", 1)[1], ORGTREE_ORG=org, ORGTREE_NODE=node)
        if auth != "none":
            env["ORGTREE_AGENT_TOKEN"] = self.auth_headers(auth, org)["X-Orgtree-Agent-Token"]
        command = "import runpy; runpy.run_module('orgtree.mcptool', run_name='__main__')"
        if self.control == "mcp_wrong_id":
            command = ("from orgtree import mcptool as m; original = m.reply; "
                       "m.reply = lambda id_, result=None, error=None: original('wrong-id', result, error); m.main()")
        return Stdio(python_command(command),
                     env=env, cwd=ROOT)

    def close(self):
        # EOF requests only this owned test server to stop, no product shutdown.
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdout.close()
        self.log.close()


@contextmanager
def create_target():
    with tempfile.TemporaryDirectory(prefix="orgtree-wire-") as directory:
        target = PythonTarget(Path(directory))
        try:
            yield target
        finally:
            target.close()


@contextmanager
def create_unsafe_target():
    """Explicit, separate test-only factory. The ordinary factory ignores controls."""
    control = os.environ["ORGTREE_WIRE_UNSAFE_CONTROL"]
    with tempfile.TemporaryDirectory(prefix="orgtree-wire-control-") as directory:
        target = PythonTarget(Path(directory), control=control)
        try:
            yield target
        finally:
            target.close()
