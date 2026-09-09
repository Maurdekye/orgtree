"""Headless boot host: run the engine before any interactive logon.

A boot-triggered Scheduled Task (registered by the operator, running as the
operator's own Windows account) starts this host with the packaged runtime.
It owns exactly what the desktop main process owns today — a fresh per-launch
credential and the readiness handshake — and nothing else: launch.py keeps the
guardian, the root lock, port persistence and every route.

The one new artifact is the attach descriptor, engine-attach.json under the
data root. It is written ONLY AFTER the ready handshake, because a persisted
port can move during startup (an OS reservation makes the engine choose a
fresh port); engine-port.json is therefore never authoritative for
attachment. The descriptor carries the per-boot token, so it inherits the
data root's profile ACL exactly like the provider credential files it is
equivalent to. A desktop that finds it must still prove identity over
/api/desktop/identity before trusting the endpoint.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
from typing import Any
import urllib.error
import urllib.request

READY_TIMEOUT = 120.0  # boot is contended; the desktop's 60s is too tight
SHUTDOWN_WAIT = 10.0
DESCRIPTOR = "engine-attach.json"


def resolve_data_root() -> Path:
    """The same default the desktop resolves, without Electron present."""
    explicit = os.environ.get("ORGTREE_V2_DATA", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    appdata = os.environ.get("APPDATA", "").strip()
    if not appdata:
        # An S4U logon may start without profile variables; USERPROFILE is
        # the documented anchor the CLIs also resolve from.
        profile = os.environ.get("USERPROFILE", "").strip()
        if not profile:
            raise RuntimeError("neither ORGTREE_V2_DATA, APPDATA nor USERPROFILE is set")
        appdata = str(Path(profile) / "AppData" / "Roaming")
    return (Path(appdata) / "Orgtree v2" / "data").resolve()


def resolve_ui_dir() -> Path:
    explicit = os.environ.get("ORGTREE_V2_UI_DIR", "").strip()
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
    else:
        # Packaged layout: resources/engine/service_host.py beside resources/ui.
        candidate = (Path(__file__).resolve().parent.parent / "ui").resolve()
    if not (candidate / "index.html").is_file():
        raise RuntimeError(f"UI directory has no index.html: {candidate}")
    return candidate


def pin_profile_environment(env: dict[str, str]) -> dict[str, str]:
    """Fill profile variables an S4U logon can leave unset.

    Provider CLIs resolve their auth stores from these; children must see the
    account's real profile, not an empty environment. Existing values win.
    """
    profile = env.get("USERPROFILE", "").strip()
    if profile:
        env.setdefault("APPDATA", str(Path(profile) / "AppData" / "Roaming"))
        env.setdefault("LOCALAPPDATA", str(Path(profile) / "AppData" / "Local"))
        env.setdefault("HOME", profile)
    return env


def parse_ready(line: str, child_pid: int, root: Path) -> dict[str, Any] | None:
    """The desktop's parseReady checks, transposed; raise on a wrong engine."""
    try:
        value = json.loads(line)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("type") != "ready":
        return None
    port = value.get("port")
    if value.get("protocol") != 1 or not isinstance(port, int) or not 1 <= port <= 65535:
        raise RuntimeError("invalid engine readiness")
    if value.get("pid") != child_pid:
        raise RuntimeError("engine readiness PID mismatch")
    reported = value.get("dataRootId")
    if not isinstance(reported, str) or not Path(reported).is_absolute():
        raise RuntimeError("invalid engine readiness root")
    canon = (lambda p: str(Path(p).resolve()).lower()) if os.name == "nt" else (lambda p: str(Path(p).resolve()))
    if canon(reported) != canon(str(root)):
        raise RuntimeError("engine data root mismatch")
    return value


def write_descriptor(root: Path, port: int, engine_pid: int, token: str) -> Path:
    descriptor = root / DESCRIPTOR
    payload = {"type": "attach", "protocol": 1, "port": port, "enginePid": engine_pid,
               "hostPid": os.getpid(), "dataRootId": str(root.resolve()), "token": token,
               "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    temporary = descriptor.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, descriptor)
    return descriptor


def remove_descriptor(root: Path) -> None:
    """Remove only OUR descriptor; a newer host's file must survive us."""
    descriptor = root / DESCRIPTOR
    try:
        value = json.loads(descriptor.read_text(encoding="utf-8"))
        if value.get("hostPid") == os.getpid():
            descriptor.unlink()
    except (OSError, ValueError):
        pass


def request_shutdown(port: int, token: str) -> bool:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/desktop/shutdown",
                                     method="POST", data=b"",
                                     headers={"X-Orgtree-Desktop-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def main() -> int:
    root = resolve_data_root()
    ui = resolve_ui_dir()
    root.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    env = pin_profile_environment({**os.environ})
    env.update({"ORGTREE_DATA": str(root), "ORGTREE_V2_TOKEN": token,
                "ORGTREE_V2_UI_DIR": str(ui), "PYTHONUNBUFFERED": "1",
                # Pin THIS host as the guardian-watched parent: if the host is
                # killed (Stop-ScheduledTask terminates, never signals), the
                # guardian terminates the engine tree instead of orphaning it
                # behind a stale descriptor.
                "ORGTREE_V2_PARENT_PID": str(os.getpid())})
    for key in ("ORGTREE_PORT", "ORGTREE_BASE"):
        env.pop(key, None)
    launcher = Path(__file__).resolve().parent / "launch.py"
    child = subprocess.Popen([sys.executable, str(launcher)], cwd=str(launcher.parent),
                             env=env, stdout=subprocess.PIPE, stderr=sys.stderr,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    ready: dict[str, Any] = {}
    failure: list[str] = []
    def read_stdout() -> None:
        assert child.stdout is not None
        buffered = 0
        for raw in child.stdout:
            buffered += len(raw)
            if buffered > 65536:
                failure.append("engine readiness exceeded size limit")
                return
            try:
                value = parse_ready(raw.decode("utf-8", "replace").strip(), child.pid, root)
            except RuntimeError as exc:
                failure.append(str(exc))
                return
            if value:
                ready.update(value)
                break
        # Keep draining so the engine never blocks on a full stdout pipe.
        for _ in child.stdout:
            pass

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()
    deadline = time.monotonic() + READY_TIMEOUT
    while not ready and not failure and child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if not ready:
        reason = failure[0] if failure else (
            "engine exited before readiness" if child.poll() is not None
            else "engine did not become ready in time")
        if child.poll() is None:
            child.kill()
        print(f"service host: {reason}", file=sys.stderr, flush=True)
        return 1

    port = int(ready["port"])
    write_descriptor(root, port, child.pid, token)
    print(f"service host: engine ready on 127.0.0.1:{port} (pid {child.pid})", file=sys.stderr, flush=True)

    stopping = {"value": False}
    def stop(*_args: Any) -> None:
        if stopping["value"]:
            return
        stopping["value"] = True
        request_shutdown(port, token)
    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)

    try:
        while child.poll() is None:
            if stopping["value"]:
                try:
                    child.wait(timeout=SHUTDOWN_WAIT)
                except subprocess.TimeoutExpired:
                    child.kill()
                break
            time.sleep(0.2)
    finally:
        remove_descriptor(root)
    if stopping["value"]:
        # A requested stop exits 0 so a restart-on-failure task setting does
        # not resurrect an engine that was deliberately stopped.
        return 0
    code = child.returncode
    return code if isinstance(code, int) and code != 0 else (0 if code == 0 else 1)


if __name__ == "__main__":
    raise SystemExit(main())
