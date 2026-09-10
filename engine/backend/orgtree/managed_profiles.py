"""Private login directories usable by both the boot engine and desktop user."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import uuid


def create_profile(base: str, provider: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_-]*", provider):
        raise ValueError("invalid profile provider")
    if os.name != "nt":
        return tempfile.mkdtemp(prefix=f"{provider}-", dir=base)
    # Python's Windows mkdir(mode=0700), used by mkdtemp, grants OWNER
    # RIGHTS. An elevated/S4U token can default the owner to Administrators:
    # the same user's unelevated login CLI then cannot write credentials.
    # Name the TOKEN USER explicitly, not its default owner. The boot host
    # runs as the desktop operator, so these are the same Windows identity.
    result = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"], check=True,
        capture_output=True, text=True, timeout=10,
        creationflags=subprocess.CREATE_NO_WINDOW)
    match = re.search(r"\bS-1-(?:\d+-)+\d+\b", result.stdout)
    if not match:
        raise OSError("Cannot identify the Windows user for the managed profile")
    path = os.path.join(base, f"{provider}-{uuid.uuid4().hex}")
    _create_windows_directory(path, match.group())
    return path


def _create_windows_directory(path: str, sid: str) -> None:
    """Attach the private ACL at creation, without an inherited-access gap."""
    import ctypes
    from ctypes import wintypes as w

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(w.ULONG)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL
    kernel.CreateDirectoryW.argtypes = [w.LPCWSTR, ctypes.c_void_p]
    kernel.CreateDirectoryW.restype = w.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                    ("bInheritHandle", w.BOOL)]

    descriptor = ctypes.c_void_p()
    sddl = f"O:{sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})"
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
    try:
        if not kernel.CreateDirectoryW(path, ctypes.byref(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)
