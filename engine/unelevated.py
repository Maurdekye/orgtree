"""Start a child process WITHOUT administrator rights from an elevated host.

WHY THIS EXISTS. The boot host (service_host.py) is started by the Scheduled
Task "Orgtree Background Engine", registered as the operator's own account
with an S4U logon and RunLevel Limited. Measured 2026-09-30 on the user's
machine: that combination still hands an administrator account its FULL,
unfiltered token, so the host, launch.py, PostgreSQL's parent and every agent
CLI the engine spawns ran at High integrity with BUILTIN\\Administrators
enabled. PostgreSQL refuses to run under such a token, and no agent should
hold admin rights by default. The desktop app itself was Medium; only the
task-started tree was elevated.

WHAT IT DOES. When the calling process's token is elevated, the child gets a
restricted copy of that same token:

- BUILTIN\\Administrators and BUILTIN\\Power Users become deny-only
  (CreateRestrictedToken with DISABLE_MAX_PRIVILEGE, exactly the token
  pg-custodian's win.rs gives `postgres --single`, and what PostgreSQL's own
  pg_ctl/initdb use);
- the mandatory label drops to Medium, the level of a normal desktop program;
- the default DACL grants the user, SYSTEM and Administrators, so the child can
  still open its own process and token (an elevated token's default DACL
  names only Administrators and SYSTEM, and Administrators is now deny-only).

It is the same account, so the profile, the data root and every credential
stay reachable. A restricted copy of the caller's own primary token needs no
SeAssignPrimaryTokenPrivilege for CreateProcessAsUserW.

HOW IT PLUGS IN. subprocess.Popen does all the pipe, handle-list and
environment work and then calls ``_winapi.CreateProcess``. popen_unelevated
swaps that single call for CreateProcessAsUserW with the restricted token,
for the duration of one Popen construction and under a lock, so the caller
keeps a real Popen (poll, wait, kill, pid, stdout) and nothing else in the
host changes. Only the handles Popen names in its handle list are inherited.

When the caller is NOT elevated there is nothing to drop, and a plain
subprocess.Popen is used.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from typing import Any

IS_WINDOWS = os.name == "nt"

# The mandatory label of a normal desktop program (S-1-16-8192).
MEDIUM_RID = 0x2000
HIGH_RID = 0x3000

_swap_lock = threading.Lock()

if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _adv = ctypes.WinDLL("advapi32", use_last_error=True)

    TOKEN_ALL_ACCESS = 0xF01FF
    TOKEN_QUERY = 0x0008
    DISABLE_MAX_PRIVILEGE = 0x1
    TokenUser = 1
    TokenDefaultDacl = 6
    TokenIntegrityLevel = 25
    SE_GROUP_INTEGRITY = 0x20
    SDDL_REVISION_1 = 1
    CREATE_UNICODE_ENVIRONMENT = 0x00000400
    EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002

    class SID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    class TOKEN_MANDATORY_LABEL(ctypes.Structure):
        _fields_ = [("Label", SID_AND_ATTRIBUTES)]

    class TOKEN_DEFAULT_DACL(ctypes.Structure):
        _fields_ = [("DefaultDacl", ctypes.c_void_p)]

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE),
            ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE),
        ]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                    ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

    def _fn(dll: Any, name: str, restype: Any, *argtypes: Any) -> Any:
        f = getattr(dll, name)
        f.restype = restype
        f.argtypes = list(argtypes)
        return f

    _GetCurrentProcess = _fn(_k32, "GetCurrentProcess", wintypes.HANDLE)
    _CloseHandle = _fn(_k32, "CloseHandle", wintypes.BOOL, wintypes.HANDLE)
    _LocalFree = _fn(_k32, "LocalFree", ctypes.c_void_p, ctypes.c_void_p)
    _OpenProcessToken = _fn(_adv, "OpenProcessToken", wintypes.BOOL,
                            wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
    _GetTokenInformation = _fn(_adv, "GetTokenInformation", wintypes.BOOL, wintypes.HANDLE,
                               ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD))
    _SetTokenInformation = _fn(_adv, "SetTokenInformation", wintypes.BOOL, wintypes.HANDLE,
                               ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    _CreateRestrictedToken = _fn(_adv, "CreateRestrictedToken", wintypes.BOOL, wintypes.HANDLE,
                                 wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SID_AND_ATTRIBUTES),
                                 wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                                 ctypes.POINTER(wintypes.HANDLE))
    _CheckTokenMembership = _fn(_adv, "CheckTokenMembership", wintypes.BOOL, wintypes.HANDLE,
                                ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL))
    _ConvertStringSidToSidW = _fn(_adv, "ConvertStringSidToSidW", wintypes.BOOL,
                                  wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p))
    _ConvertSidToStringSidW = _fn(_adv, "ConvertSidToStringSidW", wintypes.BOOL,
                                  ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR))
    _ConvertSDDL = _fn(_adv, "ConvertStringSecurityDescriptorToSecurityDescriptorW", wintypes.BOOL,
                       wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
                       ctypes.POINTER(wintypes.DWORD))
    _GetSecurityDescriptorDacl = _fn(_adv, "GetSecurityDescriptorDacl", wintypes.BOOL, ctypes.c_void_p,
                                     ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p),
                                     ctypes.POINTER(wintypes.BOOL))
    _GetSidSubAuthorityCount = _fn(_adv, "GetSidSubAuthorityCount", ctypes.POINTER(ctypes.c_ubyte),
                                   ctypes.c_void_p)
    _GetSidSubAuthority = _fn(_adv, "GetSidSubAuthority", ctypes.POINTER(wintypes.DWORD),
                              ctypes.c_void_p, wintypes.DWORD)
    _InitializeProcThreadAttributeList = _fn(_k32, "InitializeProcThreadAttributeList", wintypes.BOOL,
                                             ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                             ctypes.POINTER(ctypes.c_size_t))
    _UpdateProcThreadAttribute = _fn(_k32, "UpdateProcThreadAttribute", wintypes.BOOL, ctypes.c_void_p,
                                     wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
                                     ctypes.c_void_p, ctypes.c_void_p)
    _DeleteProcThreadAttributeList = _fn(_k32, "DeleteProcThreadAttributeList", None, ctypes.c_void_p)
    _CreateProcessAsUserW = _fn(_adv, "CreateProcessAsUserW", wintypes.BOOL, wintypes.HANDLE,
                                wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION))


class UnelevatedSpawnError(OSError):
    """The restricted token or the process could not be created."""


def _raise(what: str, code: "int | None" = None) -> None:
    code = ctypes.get_last_error() if code is None else code
    raise UnelevatedSpawnError(code, f"{what}: {ctypes.FormatError(code).strip()} (Windows error {code})")


def _token_info(token: Any, cls: int) -> "ctypes.Array[ctypes.c_char]":
    size = wintypes.DWORD(0)
    _GetTokenInformation(token, cls, None, 0, ctypes.byref(size))
    buf = ctypes.create_string_buffer(max(size.value, 1))
    if not _GetTokenInformation(token, cls, buf, size, ctypes.byref(size)):
        _raise("could not read the process token")
    return buf


def _open_own_token(access: int) -> Any:
    token = wintypes.HANDLE()
    if not _OpenProcessToken(_GetCurrentProcess(), access, ctypes.byref(token)):
        _raise("could not open this process's token")
    return token


def process_is_elevated() -> bool:
    """True when this process holds administrator rights.

    That is: BUILTIN\\Administrators is an ENABLED group of its token, or its
    mandatory label is High or above. TokenElevation alone is not the test —
    measured 2026-09-30, it still answers 1 for the restricted token this
    module hands a child (Administrators deny-only, Medium label).
    """
    if not IS_WINDOWS:
        return False
    admins = _string_sid("S-1-5-32-544")
    try:
        member = wintypes.BOOL(0)
        if not _CheckTokenMembership(None, admins, ctypes.byref(member)):
            _raise("could not check Administrators membership")
    finally:
        _LocalFree(admins)
    return bool(member.value) or process_integrity_rid() >= HIGH_RID


def _label_rid(token: Any) -> int:
    buf = _token_info(token, TokenIntegrityLevel)
    sid = ctypes.cast(buf, ctypes.POINTER(TOKEN_MANDATORY_LABEL))[0].Label.Sid
    count = _GetSidSubAuthorityCount(sid)[0]
    return int(_GetSidSubAuthority(sid, count - 1)[0])


def process_integrity_rid() -> int:
    """This process's mandatory-label RID (0x2000 Medium, 0x3000 High)."""
    token = _open_own_token(TOKEN_QUERY)
    try:
        return _label_rid(token)
    finally:
        _CloseHandle(token)


def _user_sid_string(token: Any) -> str:
    buf = _token_info(token, TokenUser)
    sid = ctypes.cast(buf, ctypes.POINTER(SID_AND_ATTRIBUTES))[0].Sid
    text = wintypes.LPWSTR()
    if not _ConvertSidToStringSidW(sid, ctypes.byref(text)):
        _raise("could not read the token's user")
    try:
        return str(text.value)
    finally:
        _LocalFree(text)


def _string_sid(text: str) -> ctypes.c_void_p:
    sid = ctypes.c_void_p()
    if not _ConvertStringSidToSidW(text, ctypes.byref(sid)):
        _raise(f"could not build SID {text}")
    return sid


def restricted_medium_token() -> Any:
    """A primary token for a normal-user child of this (elevated) process.

    The caller owns the returned handle and must CloseHandle it.
    """
    own = _open_own_token(TOKEN_ALL_ACCESS)
    sids: list[ctypes.c_void_p] = []
    new = wintypes.HANDLE()
    try:
        # Read before the restricted token exists, so a failure here has no
        # new handle to leak.
        user = _user_sid_string(own)
        # BUILTIN\Administrators and BUILTIN\Power Users, made deny-only.
        sids = [_string_sid("S-1-5-32-544"), _string_sid("S-1-5-32-547")]
        deny = (SID_AND_ATTRIBUTES * len(sids))(*[SID_AND_ATTRIBUTES(s.value, 0) for s in sids])
        if not _CreateRestrictedToken(own, DISABLE_MAX_PRIVILEGE, len(sids), deny,
                                      0, None, 0, None, ctypes.byref(new)):
            _raise("could not create a restricted token")
    finally:
        for s in sids:
            _LocalFree(s)
        _CloseHandle(own)
    try:
        medium = _string_sid("S-1-16-8192")
        try:
            label = TOKEN_MANDATORY_LABEL(SID_AND_ATTRIBUTES(medium.value, SE_GROUP_INTEGRITY))
            if not _SetTokenInformation(new, TokenIntegrityLevel, ctypes.byref(label),
                                        ctypes.sizeof(label)):
                _raise("could not lower the token to Medium integrity")
        finally:
            _LocalFree(medium)
        sd = ctypes.c_void_p()
        if not _ConvertSDDL(f"D:(A;;GA;;;{user})(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1,
                            ctypes.byref(sd), None):
            _raise("could not build the default DACL")
        try:
            present, defaulted = wintypes.BOOL(), wintypes.BOOL()
            dacl = ctypes.c_void_p()
            if not _GetSecurityDescriptorDacl(sd, ctypes.byref(present), ctypes.byref(dacl),
                                              ctypes.byref(defaulted)):
                _raise("could not read the default DACL")
            dd = TOKEN_DEFAULT_DACL(dacl.value)
            if not _SetTokenInformation(new, TokenDefaultDacl, ctypes.byref(dd), ctypes.sizeof(dd)):
                _raise("could not set the default DACL")
        finally:
            _LocalFree(sd)
    except BaseException:
        _CloseHandle(new)
        raise
    return new


def _environment_block(env: Any) -> "ctypes.Array[ctypes.c_wchar] | None":
    if env is None:
        return None
    # Sorted case-insensitively, as CreateProcess expects and _winapi does.
    items = sorted(((str(k), str(v)) for k, v in env.items()), key=lambda kv: kv[0].upper())
    for key, value in items:
        # The same refusals as _winapi.CreateProcess: a name may start with
        # "=" (drive-letter entries) but not contain one, and nothing may
        # carry a NUL, which would end the block early.
        if not key or "=" in key[1:]:
            raise ValueError(f"illegal environment variable name: {key!r}")
        if "\0" in key or "\0" in value:
            raise ValueError("embedded null character in the environment")
    text = "".join(f"{k}={v}\0" for k, v in items) + "\0"
    return ctypes.create_unicode_buffer(text, len(text))


def _create_process_as_user(token: Any):  # noqa: ANN202 - mirrors _winapi.CreateProcess
    def create(application_name: Any, command_line: Any, _proc_attrs: Any, _thread_attrs: Any,
               inherit_handles: Any, creation_flags: int, env_mapping: Any,
               current_directory: Any, startup_info: Any) -> tuple[int, int, int, int]:
        si = STARTUPINFOEXW()
        si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
        flags = int(creation_flags) | CREATE_UNICODE_ENVIRONMENT
        attr_buf = None
        handles = None
        if startup_info is not None:
            si.StartupInfo.dwFlags = int(startup_info.dwFlags)
            si.StartupInfo.wShowWindow = int(startup_info.wShowWindow)
            si.StartupInfo.hStdInput = int(startup_info.hStdInput or 0) or None
            si.StartupInfo.hStdOutput = int(startup_info.hStdOutput or 0) or None
            si.StartupInfo.hStdError = int(startup_info.hStdError or 0) or None
            wanted = list((startup_info.lpAttributeList or {}).get("handle_list") or [])
            if wanted:
                handles = (wintypes.HANDLE * len(wanted))(*[int(h) for h in wanted])
                size = ctypes.c_size_t(0)
                _InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
                attr_buf = ctypes.create_string_buffer(size.value)
                if not _InitializeProcThreadAttributeList(attr_buf, 1, 0, ctypes.byref(size)):
                    _raise("could not build the inherited-handle list")
                if not _UpdateProcThreadAttribute(attr_buf, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                                  handles, ctypes.sizeof(handles), None, None):
                    code = ctypes.get_last_error()
                    _DeleteProcThreadAttributeList(attr_buf)
                    _raise("could not set the inherited-handle list", code)
                si.lpAttributeList = ctypes.cast(attr_buf, ctypes.c_void_p)
                flags |= EXTENDED_STARTUPINFO_PRESENT
        block = _environment_block(env_mapping)
        cmd = ctypes.create_unicode_buffer(str(command_line)) if command_line is not None else None
        pi = PROCESS_INFORMATION()
        try:
            ok = _CreateProcessAsUserW(token, application_name, cmd, None, None, bool(inherit_handles),
                                       flags, block, current_directory, ctypes.byref(si),
                                       ctypes.byref(pi))
            if not ok:
                _raise("could not start the process without administrator rights")
        finally:
            if attr_buf is not None:
                _DeleteProcThreadAttributeList(attr_buf)
        return int(pi.hProcess), int(pi.hThread), int(pi.dwProcessId), int(pi.dwThreadId)
    return create


# Run by the elevated host, once per start, BEFORE it drops its rights. Reads
# a JSON list of folders on stdin; for each folder whose DACL is PROTECTED
# (inherits nothing) and gives the token user no way in — no entry naming the
# user, and not owned by the user under an OWNER RIGHTS entry — it adds one
# inheritable FullControl entry for the user. Only the DACL is written, so the
# owner is left as it is. Prints the repaired folders as a JSON list.
_REPAIR_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$repaired = @()
# Assigned first: Windows PowerShell's ConvertFrom-Json passes a JSON array
# down the pipeline as ONE object, so @(... | ConvertFrom-Json) would loop
# once over the whole list.
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($path in $paths) {
  try {
    $dir = Get-Item -LiteralPath $path -Force
    $acl = $dir.GetAccessControl('Access')
    if (-not $acl.AreAccessRulesProtected) { continue }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      Where-Object { $_.AccessControlType -eq 'Allow' })
    if ($rules | Where-Object { $_.IdentityReference.Value -eq $user.Value }) { continue }
    $owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -eq $user.Value -and ($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-3-4' })) { continue }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    $dir.SetAccessControl($acl)
    $repaired += $path
  } catch {
    [Console]::Error.WriteLine("could not repair ${path}: $($_.Exception.Message)")
  }
}
ConvertTo-Json -InputObject @($repaired) -Compress
"""


def user_access_candidates(root: "os.PathLike[str] | str") -> list[str]:
    """The folders an earlier ELEVATED engine may have left unreadable.

    Python's Windows mkdir(mode=0o700) — mkdtemp, and managed profiles before
    they named the user explicitly — gives a folder a protected DACL of
    SYSTEM, Administrators and OWNER RIGHTS. Created under an elevated token
    whose default owner is Administrators, that folder has no entry the
    normal-user engine matches (measured 2026-09-30 on a live data root: one
    profile folder, from 2026-09-10). Those folders live at the top of the
    data root and under profiles/, so this is the root, its direct folders and
    the profile folders — never a walk of the whole tree. Links and junctions
    are not followed.
    """
    base = os.fspath(root)
    found = [base]
    for parent in (base, os.path.join(base, "profiles")):
        try:
            entries = list(os.scandir(parent))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False) and not os.path.isjunction(entry.path):
                    found.append(entry.path)
            except OSError:
                continue
    return list(dict.fromkeys(found))


def repair_user_access(root: "os.PathLike[str] | str") -> list[str]:
    """Give the token user back its access to user_access_candidates(root).

    For an elevated host only, before it starts the engine without its rights.
    Returns the folders it changed. A folder it cannot repair is reported on
    stderr and skipped; the engine then reports that folder itself.
    """
    if not IS_WINDOWS:
        return []
    candidates = user_access_candidates(root)
    powershell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                              "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    result = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _REPAIR_SCRIPT],
        input=json.dumps(candidates), capture_output=True, text=True, timeout=120,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.stderr.strip():
        print(f"service host: {result.stderr.strip()}", file=sys.stderr, flush=True)
    if result.returncode != 0:
        raise OSError(f"the access repair failed (exit code {result.returncode})")
    repaired = json.loads(result.stdout or "[]")
    return [str(p) for p in (repaired if isinstance(repaired, list) else [repaired])]

# The "Run Orgtree as administrator" app setting. It lives in HKLM, under a key
# only SYSTEM and Administrators can write (the desktop creates it with that
# ACL, through a UAC prompt), and NOT in the data folder: every agent runs as
# the normal user and can write the data folder, so a setting there would let
# any agent grant itself administrator rights at the next engine start.
RUN_AS_ADMIN_KEY = r"SOFTWARE\Orgtree\Runtime"
RUN_AS_ADMIN_VALUE = "RunAsAdministrator"


def run_as_administrator_enabled() -> bool:
    """True only when the setting is present and exactly DWORD 1.

    Missing, unreadable or any other value means OFF: the safe side of this
    setting is the normal-user engine.
    """
    if not IS_WINDOWS:
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, RUN_AS_ADMIN_KEY, 0,
                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            value, kind = winreg.QueryValueEx(key, RUN_AS_ADMIN_VALUE)
    except OSError:
        return False
    return kind == winreg.REG_DWORD and value == 1


def popen_unelevated(args: Any, **kwargs: Any) -> "subprocess.Popen[Any]":
    """subprocess.Popen, but the child never holds administrator rights.

    Elevated caller: the child runs under restricted_medium_token(). Otherwise
    this is exactly subprocess.Popen(args, **kwargs).
    """
    if not process_is_elevated():
        return subprocess.Popen(args, **kwargs)
    winapi = subprocess._winapi  # type: ignore[attr-defined]
    token = restricted_medium_token()
    try:
        with _swap_lock:
            original = winapi.CreateProcess
            winapi.CreateProcess = _create_process_as_user(token)
            try:
                return subprocess.Popen(args, **kwargs)
            finally:
                winapi.CreateProcess = original
    finally:
        _CloseHandle(token)


if __name__ == "__main__":  # manual probe: print this process's level
    if IS_WINDOWS:
        print(f"elevated={process_is_elevated()} integrity=0x{process_integrity_rid():X}")
    sys.exit(0)
