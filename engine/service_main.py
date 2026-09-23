"""SCM entrypoint for the private v3 boot engine.

The service itself remains LocalSystem only long enough to acquire a
passwordless operator batch token, launch the operator's boot host, and
supervise it. It never runs the engine or a provider CLI as LocalSystem.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import os
from pathlib import Path
import secrets
import sys
import winreg

if __package__ in (None, ""):
    package_root = str(Path(__file__).resolve().parent.parent)
    if package_root not in sys.path:
        sys.path.insert(0, package_root)

from engine.winservice import CONTROL_RESTART_ENGINE, SERVICE_NAME
from engine.winservice import lifecycle, scm
from engine.winservice.bridge_monitor import BridgeMonitor, WindowsWtsSource
from engine.winservice.bridge_server import BridgeServer
from engine.winservice.bridge_state import BridgeState
from engine.winservice.process import spawn_s4u_host


BOOT_KEY = r"SOFTWARE\Orgtree\BootEngine"
EXIT_CONFIG = 4


def _installed_root() -> Path:
    source = Path(__file__).resolve()
    engine = source.parent
    if engine.name.lower() != "engine":
        raise RuntimeError("service entrypoint is outside the engine folder")
    return engine.parent.parent if engine.parent.name.lower() == "resources" else engine.parent


def read_boot_record() -> tuple[str, Path, str]:
    """Require an explicit, admin-owned service record for this install."""
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, BOOT_KEY, 0, winreg.KEY_READ) as key:
        mode = winreg.QueryValueEx(key, "Mode")[0]
        sid = winreg.QueryValueEx(key, "OperatorSid")[0]
        install = winreg.QueryValueEx(key, "InstallDir")[0]
        payload_id = winreg.QueryValueEx(key, "PayloadId")[0]
    if mode != "service" or not isinstance(sid, str) or not sid.startswith("S-1-5-21-"):
        raise RuntimeError("boot service record has no valid operator identity")
    if not isinstance(install, str) or Path(install).resolve() != _installed_root():
        raise RuntimeError("boot service record belongs to another installation")
    if (not isinstance(payload_id, str) or len(payload_id) != 64
            or any(ch not in "0123456789abcdef" for ch in payload_id)):
        raise RuntimeError("boot service record has no valid payload identity")
    return sid, Path(install).resolve(), payload_id


def account_for_sid(sid: str) -> tuple[str, str]:
    """Resolve the pinned SID at each start; never trust a stored account name."""
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
    advapi.ConvertStringSidToSidW.restype = w.BOOL
    advapi.LookupAccountSidW.argtypes = [w.LPCWSTR, ctypes.c_void_p, w.LPWSTR,
                                         ctypes.POINTER(w.DWORD), w.LPWSTR,
                                         ctypes.POINTER(w.DWORD), ctypes.POINTER(w.DWORD)]
    advapi.LookupAccountSidW.restype = w.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    pointer = ctypes.c_void_p()
    if not advapi.ConvertStringSidToSidW(sid, ctypes.byref(pointer)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        name_len = w.DWORD()
        domain_len = w.DWORD()
        kind = w.DWORD()
        advapi.LookupAccountSidW(None, pointer, None, ctypes.byref(name_len),
                                  None, ctypes.byref(domain_len), ctypes.byref(kind))
        if not 0 < name_len.value <= 256 or domain_len.value > 256:
            raise OSError("configured operator SID did not resolve to an account")
        name = ctypes.create_unicode_buffer(name_len.value)
        domain = ctypes.create_unicode_buffer(max(1, domain_len.value))
        if not advapi.LookupAccountSidW(None, pointer, name, ctypes.byref(name_len),
                                         domain, ctypes.byref(domain_len), ctypes.byref(kind)):
            raise ctypes.WinError(ctypes.get_last_error())
        if kind.value != 1 or not name.value:  # SidTypeUser
            raise RuntimeError("configured operator SID is not a user account")
        return name.value, domain.value
    finally:
        kernel.LocalFree(pointer)


def service_body(context: scm.ServiceContext) -> int:
    try:
        operator_sid, install, payload_id = read_boot_record()
        # The protected SCM ImagePath/runtime is the pre-execution trust
        # anchor. This read-back guard is additional fail-closed validation.
        from engine.winservice import payload_guard
        report = payload_guard.check_installed_payload(install, payload_id)
        if not report.ok:
            for problem in report.problems:
                print(f"service payload: {problem}", file=sys.stderr, flush=True)
            return EXIT_CONFIG
        username, domain = account_for_sid(operator_sid)
        host = Path(__file__).resolve().parent / "service_host.py"
        if not host.is_file():
            raise FileNotFoundError("boot host is absent from this installation")
    except (OSError, RuntimeError) as exc:
        print(f"service configuration: {exc}", file=sys.stderr, flush=True)
        return EXIT_CONFIG
    bridge = BridgeState[int]()
    monitor = BridgeMonitor(operator_sid, context, bridge, WindowsWtsSource())
    monitor.start()

    class HostWithBridge:
        def __init__(self, child, server):
            self.child = child
            self.server = server
            self.pid = child.pid

        def wait(self, timeout):
            return self.child.wait(timeout)

        def request_stop(self):
            return self.child.request_stop()

        def terminate(self, code):
            return self.child.terminate(code)

        def wait_empty(self, timeout):
            return self.child.wait_empty(timeout)

        def close(self):
            self.server.stop()
            self.child.close()

    def spawn():
        secret = secrets.token_hex(32)
        child = spawn_s4u_host(username, domain, operator_sid, host, secret)
        server = BridgeServer(operator_sid, child.job, secret, bridge,
                              host_pid=child.pid, profile_path=child.profile_path)
        try:
            server.start()
        except BaseException:
            child.terminate(1)
            child.wait_empty(10)
            child.close()
            raise
        return HostWithBridge(child, server)

    try:
        return lifecycle.supervise(
            context, spawn,
            log=lambda message: print(message, file=sys.stderr, flush=True))
    finally:
        monitor.stop()


def main() -> None:
    if os.name != "nt":
        raise RuntimeError("OrgtreeEngine service is Windows-only")
    scm.run(SERVICE_NAME, service_body, restart_control=CONTROL_RESTART_ENGINE)


if __name__ == "__main__":
    main()
