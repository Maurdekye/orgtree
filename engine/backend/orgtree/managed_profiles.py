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


def create_profile_at(path: str) -> str:
    """Create ONE private directory at an EXACT path, same ACL as
    `create_profile`, and return it.

    `create_profile` mints a random name, which is right for a login home
    nothing else must guess. A DERIVED home — one whose name is a function
    of the row it belongs to — needs the path to be stable instead, so the
    same row lands in the same directory on every spawn without the path
    being stored anywhere. Existing directories are left as they are.
    """
    if os.path.isdir(path):
        return path
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    if os.name != "nt":
        os.makedirs(path, mode=0o700, exist_ok=True)
        return path
    # ⚠ THE PRIVATE ACL IS BEST-EFFORT HERE, AND ONLY HERE. `create_profile`
    # mints LOGIN homes, where the ACL is the whole point and failing loudly
    # is right. A derived home holds no credential — the key it belongs to
    # lives in the machine token store — so refusing to create it would turn
    # a cosmetic hardening failure into "this account cannot run a turn".
    # Identifying the token user shells out to `whoami`, which is not always
    # the Windows one on a PATH a developer shell has rearranged.
    try:
        _create_windows_directory(path, _token_user_sid())
    except (OSError, subprocess.SubprocessError):
        os.makedirs(path, exist_ok=True)
    return path


def _token_user_sid() -> str:
    """The SID of the Windows identity this process runs as — named
    explicitly rather than defaulted, for the reason create_profile gives."""
    result = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"], check=True,
        capture_output=True, text=True, timeout=10,
        creationflags=subprocess.CREATE_NO_WINDOW)
    match = re.search(r"S-1-(?:\d+-)+\d+", result.stdout)
    if not match:
        raise OSError("Cannot identify the Windows user for the managed profile")
    return match.group()


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
