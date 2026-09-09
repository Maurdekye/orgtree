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
attachment. The descriptor carries the per-boot token; its protection IS the
data root's ACL, which is why the desktop verifies the file's NTFS OWNER
before trusting it (the identity round-trip that follows is a staleness
check, not authentication). Run this host as the operator, unelevated — an
Administrators-owned descriptor is refused by the desktop — and never point
ORGTREE_V2_DATA at a directory other accounts can write.
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


def _current_user_sid() -> str | None:
    try:
        output = subprocess.run(["whoami", "/user", "/fo", "csv"], capture_output=True,
                                text=True, timeout=10, check=True).stdout
        for token in output.replace('"', ",").split(","):
            if token.strip().startswith("S-1-"):
                return token.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def restrict_descriptor_acl(descriptor: Path) -> bool:
    """Owner-only DACL on OUR OWN new file (never anyone else's ACLs).

    The descriptor carries the desktop token; inherited profile ACLs can
    grant other accounts READ (measured on this machine: a sandbox account
    holds inherited read on the data root). Stripping inheritance down to
    the operator + SYSTEM + Administrators removes that token exposure.
    Best-effort: the desktop's own trust check still gates attachment.
    """
    sid = _current_user_sid()
    if os.name != "nt" or not sid:
        return False
    try:
        subprocess.run(["icacls", str(descriptor), "/inheritance:r",
                        "/grant:r", f"*{sid}:F", "/grant", "*S-1-5-18:F", "/grant", "*S-1-5-32-544:F"],
                       capture_output=True, timeout=15, check=True)
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"service host: descriptor ACL restriction failed ({exc}); "
              "inherited directory ACLs continue to apply", file=sys.stderr, flush=True)
        return False


def write_descriptor(root: Path, port: int, engine_pid: int, token: str) -> Path:
    descriptor = root / DESCRIPTOR
    payload = {"type": "attach", "protocol": 1, "port": port, "enginePid": engine_pid,
               "hostPid": os.getpid(), "dataRootId": str(root.resolve()), "token": token,
               "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    temporary = descriptor.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, descriptor)
    restrict_descriptor_acl(descriptor)
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


def _canon(p: str | Path) -> str:
    resolved = str(Path(p).resolve())
    return resolved.lower() if os.name == "nt" else resolved


def clear_stale_descriptor(root: Path) -> None:
    """A leftover descriptor is stale by definition — this host is about to
    own the root — EXCEPT when its endpoint still answers with a verified
    identity for this root, which means another live host owns it and this
    one must neither start nor touch that host's file (raises).

    Without this, a host killed without cleanup followed by a failed startup
    would leave the previous boot's descriptor for the desktop to act on.
    """
    descriptor = root / DESCRIPTOR
    try:
        raw = descriptor.read_text(encoding="utf-8")
    except OSError:
        return  # absent (the common case) or unreadable: nothing to clear
    live = False
    try:
        value = json.loads(raw)
        port, token = value.get("port"), value.get("token")
        if isinstance(port, int) and 1 <= port <= 65535 and isinstance(token, str):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/desktop/identity",
                headers={"X-Orgtree-Desktop-Token": token})
            with urllib.request.urlopen(request, timeout=3) as response:
                identity = json.loads(response.read().decode("utf-8"))
            live = (identity.get("protocol") == 1
                    and isinstance(identity.get("dataRootId"), str)
                    and _canon(identity["dataRootId"]) == _canon(root))
    except (urllib.error.URLError, OSError, ValueError):
        live = False  # dead port, refused token or garbage content: stale
    if live:
        raise RuntimeError("another boot host already serves this data root")
    try:
        descriptor.unlink()
    except OSError:
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
    try:
        clear_stale_descriptor(root)
    except RuntimeError as exc:
        print(f"service host: {exc}", file=sys.stderr, flush=True)
        return 1
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
    # Every path from here runs the cleanup: remove_descriptor() only removes
    # a file carrying OUR pid, so pre-write failures are a safe no-op and a
    # newer host's file can never be taken down by a dying older one.
    try:
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
        try:
            write_descriptor(root, port, child.pid, token)
        except OSError as exc:
            # Fail through the same clean path as every other startup error;
            # a crash here would loop a restart-on-failure task setting on a
            # traceback instead of a reason.
            print(f"service host: could not write attach descriptor: {exc}", file=sys.stderr, flush=True)
            child.kill()
            return 1
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

        while child.poll() is None:
            if stopping["value"]:
                try:
                    child.wait(timeout=SHUTDOWN_WAIT)
                except subprocess.TimeoutExpired:
                    child.kill()
                break
            time.sleep(0.2)
        if stopping["value"]:
            # A requested stop exits 0 so a restart-on-failure task setting
            # does not resurrect an engine that was deliberately stopped.
            return 0
        code = child.returncode
        return code if isinstance(code, int) and code != 0 else (0 if code == 0 else 1)
    finally:
        remove_descriptor(root)


if __name__ == "__main__":
    raise SystemExit(main())
