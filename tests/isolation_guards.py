"""Process, network, filesystem, registry and wake containment for a rig that
runs the engine on a COPY of real data (P02 isolated-copy census plan, r3).

THE PROBLEM THIS CLOSES. ``tools/p02_copy_replay.py`` runs private v3 with
``load_app()`` + ``TestClient`` (no lifespan, so the warm pool, net client,
mail hub and watchdogs never start) against a disposable copy of the user's
Orgtree data. Not starting those loops is necessary but it is not proof: a
replayed request can still reach a code path that spawns a provider CLI,
kills a PID the copied document names, opens a socket, writes outside the
copy, reads the live root through an absolute path the document stored, edits
the registry, or wakes an agent. The existing ``hub_isolation`` guard covers
only sync ``httpx.Client.send`` and urllib to the two live hub ports.

THE MECHANISM. ``install_audit_guards`` adds ONE ``sys.addaudithook`` that
refuses (raises :class:`GuardRefused`, a ``PermissionError`` and therefore an
``OSError``, so a product fallback behaves as if the resource were simply
unavailable) and COUNTS every attempt in these classes:

- ``process``: ``subprocess.Popen``, ``_winapi.CreateProcess``, ``os.system``,
  ``os.startfile``, ``os.spawn``, ``os.exec``, ``os.posix_spawn``, fork,
  ``webbrowser.open``;
- ``kill``: ``os.kill`` / ``killpg`` / ``signal.pthread_kill``,
  ``_winapi.OpenProcess`` / ``TerminateProcess``, and a
  ``ctypes`` lookup of a process-control or loader symbol (``OpenProcess``,
  ``GetProcAddress``, ``LoadLibrary`` …), ANY ordinal lookup, or a load of a
  library the policy does not allow;
- ``egress``: ``socket.connect`` / ``sendto`` / ``sendmsg``, name resolution,
  a non-loopback ``bind``, the stdlib protocol clients, a named-pipe server,
  and ANY path event (open, list, sqlite, CreateFile, dlopen) naming a UNC
  share or a ``\\\\.\\`` device such as a pipe — checked on the raw text,
  because resolving such a path already connects. The ONE allowed
  connect is the loopback self-connect inside ``socket.socketpair`` (Windows
  builds socketpair from a listener and a connect; the selector event loop's
  self-pipe needs it);
- ``write``: ``open`` in any write/append/create/truncate mode, ``os.open``
  with write flags, every ``os`` and ``shutil`` mutator, ``tempfile``
  creation, ``_winapi.CreateFile`` with write access or a creating
  disposition, ``_winapi.CreateJunction`` and ``sqlite3.connect`` OUTSIDE
  the policy's write roots;
- ``read``: ``open``, ``os.listdir`` / ``scandir``, ``glob`` and
  ``sqlite3.connect`` UNDER a protected root (live data, legacy data, the
  Orgtree v2 folder, the installed app, real credential folders), except for
  the exact files a policy lists (the copy step's source files);
- ``registry``: every ``winreg`` mutation, and ``OpenKey`` with write access.

``force_selector_loop`` + ``block_proactor_connect`` close the async gap: the
Windows Proactor loop connects through ``_overlapped.ConnectEx``, which
raises no ``socket.connect`` audit event. ``install_wake_guard`` wraps the
supervisor's turn-starting entry points (review A1): ``send_message`` passes
only with ``wake=False`` (the notice path), the rest are refused.

⚠ LIMITS, stated where a reader will look. An audit hook sees what goes
through Python-level ``socket``, ``subprocess``, ``os``, ``shutil``,
``ctypes``, ``winreg``, ``glob`` and ``open``. Native code that calls the OS
directly is NOT seen — including SQLite's own file I/O after
``sqlite3.connect``, which is why ``sqlite3.connect`` itself is checked (the
product has no SQL ``ATTACH``). A C extension opening its own sockets would
not be seen either; the rig records every extension module it loaded so a
reviewer can check. The one such module the product imports, ``psutil``, is
made unimportable by ``block_native_process_modules``. A LOCAL path that is
a junction or symlink to a share is resolved (and so connected) by
``realpath`` before the resolved form can be refused; only the raw text is
checked first. Likewise ``os.stat`` / ``os.path.exists`` / ``isfile`` /
``getsize`` raise NO audit event at all, so product code that merely stats a
UNC path from a copied document makes an SMB connection (and may offer NTLM
credentials) with nothing here to refuse it; only the subsequent open, list
or connect is refused (review R1). Hooks cannot be removed, so a process that installs them is
dedicated to one guarded run.

⚠ MUTATION TESTING. Weakening a rule here weakens it in EVERY process that
loads this file, including a replay arm running real product code, where the
guard is the only barrier. Guard-weakening mutants therefore target
``tests/test_isolation_guards.py`` ONLY (decisions, controls, copy step: no
product import), never ``tests/test_p02_replay_gate.py``. The controls are
built so that a guard which fails cannot reach the host (see
``tools/p02_copy_replay.py`` controls section).

Standard library only: it must load BEFORE any product module, and
``assert_no_product_imports`` refuses a process in which one already did.
"""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Callable

PRODUCT_PACKAGES = ("orgtree", "engine")

PROCESS_EVENTS = frozenset({
    "subprocess.Popen", "_winapi.CreateProcess", "os.system", "os.startfile",
    "os.spawn", "os.exec", "os.posix_spawn", "os.fork", "os.forkpty",
    "pty.spawn", "webbrowser.open",
})
#: ``_winapi.OpenProcess`` / ``TerminateProcess`` are what ``Popen.kill`` and
#: ``terminate`` reach on Windows. The product has no direct call and cannot
#: hold a Popen object under the guard (spawns are refused), so these are
#: defence in depth. NOTE: on Windows ``os.kill(pid, 0)`` TERMINATES the
#: process; there is no harmless "probe" signal, hence every os.kill refused.
KILL_EVENTS = frozenset({"os.kill", "os.killpg", "signal.pthread_kill",
                         "_winapi.OpenProcess", "_winapi.TerminateProcess"})
#: Native modules that act on other processes without any audit event.
#: ``psutil`` (warmpool.py, frozen_install.py; both handle ImportError) reads
#: memory, argv and listener tables of arbitrary PIDs — in a copy of real
#: data, REAL PIDs. ``block_native_process_modules`` makes it unimportable.
NATIVE_PROCESS_MODULES = ("psutil",)
#: ``ctypes`` symbol lookups refused by name PREFIX (so the A/W/Ex variants
#: are all covered), with the guard each one counts under. A native call
#: raises no audit event of its own, so refusing the LOOKUP is the only point
#: at which a Python rig can stop it.
SYMBOL_PREFIXES: tuple[tuple[str, str], ...] = (
    # act on, or start, another process
    ("kill", "OpenProcess"), ("kill", "TerminateProcess"), ("kill", "CreateProcess"),
    ("kill", "ShellExecute"), ("kill", "WinExec"), ("kill", "CreateToolhelp32Snapshot"),
    ("kill", "OpenThread"), ("kill", "DebugActiveProcess"), ("kill", "CreateRemoteThread"),
    ("kill", "NtTerminateProcess"), ("kill", "NtOpenProcess"),
    ("kill", "GenerateConsoleCtrlEvent"), ("kill", "NtCreateUserProcess"),
    # the loader itself: a raw function pointer obtained this way would get
    # around every symbol and library check here (review N2)
    ("kill", "LoadLibrary"), ("kill", "LoadPackagedLibrary"), ("kill", "GetProcAddress"),
    ("kill", "LdrLoadDll"), ("kill", "LdrGetProcedureAddress"),
    # registry mutations (the winreg module is audited; advapi32 is not)
    ("registry", "RegSetValue"), ("registry", "RegSetKeyValue"), ("registry", "RegCreateKey"),
    ("registry", "RegDelete"), ("registry", "RegSaveKey"), ("registry", "RegRestoreKey"),
    ("registry", "RegLoadKey"), ("registry", "RegReplaceKey"), ("registry", "RegRenameKey"),
    ("registry", "RegConnectRegistry"), ("registry", "RegCopyTree"),
    # file creation and mutation that would bypass the `open` audit event
    ("write", "CreateFile"), ("write", "NtCreateFile"), ("write", "MoveFile"),
    ("write", "DeleteFile"), ("write", "CopyFile"), ("write", "ReplaceFile"),
    ("write", "CreateDirectory"), ("write", "RemoveDirectory"),
    ("write", "CreateHardLink"), ("write", "CreateSymbolicLink"),
)
#: Libraries ``ctypes`` may LOAD (basename, no suffix). Deliberately absent:
#: every networking library (ws2_32, winhttp, wininet, urlmon, dnsapi,
#: iphlpapi, mswsock), because a raw native connect raises no audit event.
SYSTEM_LIBRARIES = frozenset({
    "kernel32", "kernelbase", "shell32", "user32", "advapi32", "ntdll", "ole32",
    "oleaut32", "msvcrt", "ucrtbase", "psapi", "version", "shlwapi", "gdi32",
    "comctl32", "shcore",
})
CONNECT_EVENTS = frozenset({"socket.connect", "socket.sendto", "socket.sendmsg"})
RESOLVE_EVENTS = frozenset({
    "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex",
    "socket.gethostbyaddr", "socket.getnameinfo",
})
CLIENT_EVENTS = frozenset({
    "http.client.connect", "ftplib.connect", "smtplib.connect", "imaplib.open",
    "poplib.connect", "nntplib.connect", "telnetlib.Telnet.open",
    "urllib.Request",
})
REGISTRY_WRITE_EVENTS = frozenset({
    "winreg.CreateKey", "winreg.SetValue", "winreg.DeleteKey",
    "winreg.DeleteValue", "winreg.SaveKey", "winreg.LoadKey",
    "winreg.ConnectRegistry", "winreg.DisableReflectionKey",
    "winreg.EnableReflectionKey",
})
#: KEY_SET_VALUE | KEY_CREATE_SUB_KEY | KEY_CREATE_LINK | DELETE | WRITE_DAC | WRITE_OWNER
REGISTRY_WRITE_ACCESS = 0x0002 | 0x0004 | 0x0020 | 0x10000 | 0x40000 | 0x80000
#: ⚠ AUDIT NAMES, NOT FUNCTION NAMES (review A5): ``os.replace`` raises
#: ``os.rename`` and ``os.unlink`` raises ``os.remove``. Value = the argument
#: positions that are paths being CHANGED.
WRITE_PATH_EVENTS: Mapping[str, tuple[int, ...]] = {
    "os.rename": (0, 1), "os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,),
    "os.chmod": (0,), "os.chown": (0,), "os.chflags": (0,), "os.utime": (0,),
    "os.truncate": (0,), "os.symlink": (1,), "os.link": (1,), "os.mkfifo": (0,),
    "os.mknod": (0,), "os.setxattr": (0,), "os.removexattr": (0,),
    "shutil.rmtree": (0,), "shutil.copyfile": (1,), "shutil.copymode": (1,),
    "shutil.copystat": (1,), "shutil.copytree": (1,), "shutil.move": (0, 1),
    "shutil.chown": (0,), "shutil.make_archive": (0,),
    "shutil.unpack_archive": (1,), "tempfile.mkstemp": (0,),
    "tempfile.mkdtemp": (0,), "_winapi.CreateJunction": (0, 1),
}
#: ``_winapi.CreateFile`` (file_name, desired_access, share_mode,
#: creation_disposition, flags): write-checked when any of these hold, else
#: read-checked. GENERIC_WRITE|GENERIC_ALL|FILE_WRITE_DATA|FILE_APPEND_DATA|
#: FILE_WRITE_EA|FILE_WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER|
#: MAXIMUM_ALLOWED (whatever the caller may get, which can include write);
#: CREATE_NEW, CREATE_ALWAYS, OPEN_ALWAYS, TRUNCATE_EXISTING;
#: FILE_FLAG_DELETE_ON_CLOSE.
CREATEFILE_WRITE_ACCESS = (0x40000000 | 0x10000000 | 0x2 | 0x4 | 0x10 | 0x100 | 0x10000
                           | 0x40000 | 0x80000 | 0x02000000)
CREATEFILE_WRITE_DISPOSITIONS = frozenset({1, 2, 4, 5})
CREATEFILE_DELETE_ON_CLOSE = 0x04000000
#: Paths READ by an event whose target is otherwise a write (copy sources).
READ_SIDE_OF_WRITE: Mapping[str, tuple[int, ...]] = {
    "shutil.copyfile": (0,), "shutil.copymode": (0,), "shutil.copystat": (0,),
    "shutil.copytree": (0,), "os.symlink": (0,), "os.link": (0,),
    "shutil.unpack_archive": (0,),
}
READ_PATH_EVENTS: Mapping[str, tuple[int, ...]] = {
    "os.listdir": (0,), "os.scandir": (0,), "glob.glob": (0,),
    "glob.glob/2": (0,), "os.chdir": (0,),
}
_WRITE_FLAGS = (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
                | getattr(os, "O_TEMPORARY", 0))
_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})

#: The supervisor functions that start, resume, signal or wake an agent turn
#: (plan §4, review A1). ``send_message`` is special-cased: ``wake=False`` is
#: the passive notice path and passes; ``drive_unfrozen_by_switch`` passes
#: with an EMPTY target list, which every gateway call makes.
WAKE_ENTRY_POINTS = (
    "send_message", "drive_unfrozen_by_switch", "drive_account_unpark",
    "drive_auth_thaw", "resume_frozen", "deliver_org_inbox", "remote_reap",
    "interrupt_turn", "interrupt_before_archive", "remote_control_start",
    "remote_control_stop", "launch_self_restart", "arm_prime_restart",
    "force_quiesce_for_restart", "reconcile", "manual_compact",
    "interorg_send", "immediate_command", "recover_lost_generation",
    "start_watchdog_engine", "start_auto_resume_loop", "start_usage_warm_loop",
    "start_storage_watchdog", "start_steer_late_watchdog",
    "start_prime_restart_engine", "start_extern_sweeper", "start_cred_watcher",
    "start_working_cache_keeper",
)


class GuardRefused(PermissionError):
    """A guarded rig refused an effect before it happened."""


class RefuseToRun(RuntimeError):
    """The rig cannot establish the containment it needs, so it does not start."""


def normal(path: Any) -> str:
    """Absolute, symlink-resolved, case-folded — the form every check compares."""
    text = os.fsdecode(os.fspath(path))
    return os.path.normcase(os.path.realpath(os.path.abspath(text)))


def within(candidate: str, root: str) -> bool:
    """Both already ``normal``. Equal counts as within."""
    root = root.rstrip("\\/") or root
    return candidate == root or candidate.startswith(root + os.sep)


def overlaps(a: str, b: str) -> bool:
    return within(a, b) or within(b, a)


# ---------------------------------------------------------------------------
# Protected roots
# ---------------------------------------------------------------------------

def pinned_protected_roots(env: Mapping[str, str]) -> dict[str, Any]:
    """The locations a rig must never read or write, from the environment
    AS IT WAS BEFORE any scrub or HOME redirect (plan §2, review F1/A3).

    ``live`` comes from ``ORGTREE_AGENT_PARENT_DATA`` when set, and ALWAYS
    also from ``%APPDATA%\\Orgtree v2\\data`` — so removing the variable
    cannot remove the protection. ``legacy`` likewise from
    ``ORGTREE_AGENT_LEGACY_DATA`` and ``%USERPROFILE%\\orgtree``. Raises
    :class:`RefuseToRun` when no absolute live root can be established."""
    def absolute(value: str | None) -> str | None:
        value = (value or "").strip()
        return value if value and os.path.isabs(value) else None

    appdata = absolute(env.get("APPDATA"))
    profile = absolute(env.get("USERPROFILE")) or absolute(env.get("HOME"))
    live: list[str] = []
    for value in (absolute(env.get("ORGTREE_AGENT_PARENT_DATA")),
                  os.path.join(appdata, "Orgtree v2", "data") if appdata else None):
        if value and normal(value) not in {normal(x) for x in live}:
            live.append(value)
    if not live:
        raise RefuseToRun(
            "cannot establish the live Orgtree data root: neither "
            "ORGTREE_AGENT_PARENT_DATA nor an absolute APPDATA is set")
    legacy: list[str] = []
    for value in (absolute(env.get("ORGTREE_AGENT_LEGACY_DATA")),
                  os.path.join(profile, "orgtree") if profile else None):
        if value and normal(value) not in {normal(x) for x in legacy}:
            legacy.append(value)
    other: list[str] = []
    if appdata:
        other.append(os.path.join(appdata, "Orgtree v2"))
    for base in (absolute(env.get("ProgramFiles")), absolute(env.get("ProgramW6432"))):
        if base:
            other.append(os.path.join(base, "Orgtree"))
    local = absolute(env.get("LOCALAPPDATA"))
    if local:
        other.append(os.path.join(local, "Programs", "Orgtree"))
    if profile:
        # real credential folders; HOME is redirected, but a copied document
        # can still name an absolute path into them
        for name in (".claude", ".codex", ".gemini"):
            other.append(os.path.join(profile, name))
    return {"live": live, "legacy": legacy, "other": other}


def all_protected(pinned: Mapping[str, Any], extra: Iterable[str] = ()) -> list[str]:
    roots = list(pinned.get("live") or []) + list(pinned.get("legacy") or [])
    roots += list(pinned.get("other") or []) + list(extra)
    out: list[str] = []
    for root in roots:
        n = normal(root)
        if n not in out:
            out.append(n)
    return out


def refuse_overlap(label: str, path: str, protected: Iterable[str]) -> None:
    """The harness's own root check (F1): independent of devguard and of
    ``launch.validate_data_root``, which never forbids the V2 root."""
    candidate = normal(path)
    for root in protected:
        if overlaps(candidate, root):
            raise RefuseToRun(f"{label} overlaps a protected location")


# ---------------------------------------------------------------------------
# The audit hook
# ---------------------------------------------------------------------------

@dataclass
class Policy:
    write_roots: list[str]
    protected_roots: list[str]
    #: exact files a copy step may read under a protected root
    read_exceptions: set[str] = field(default_factory=set)
    #: exact directories a copy step may list under a protected root
    list_exceptions: set[str] = field(default_factory=set)
    #: lower-case library names ``ctypes`` may load (basename, no suffix)
    ctypes_libraries: set[str] = field(default_factory=lambda: set(SYSTEM_LIBRARIES))
    #: refused symbols a step may still look up (the copy step's
    #: FILE_SHARE_DELETE ``CreateFileW``, which it read-checks itself)
    ctypes_symbols: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.write_roots = [normal(p) for p in self.write_roots]
        self.protected_roots = [normal(p) for p in self.protected_roots]
        self.read_exceptions = {normal(p) for p in self.read_exceptions}
        self.list_exceptions = {normal(p) for p in self.list_exceptions}
        for w in self.write_roots:
            for p in self.protected_roots:
                if overlaps(w, p):
                    raise RefuseToRun("a write root overlaps a protected location")


class Report:
    """Thread-safe counters. ``refused`` is keyed by (guard, event, route);
    ``allowed`` counts checks that passed, per guard — proof the hook ran."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.refused: dict[tuple[str, str, str], int] = {}
        self.allowed: dict[str, int] = {}
        self.details: list[dict[str, str]] = []
        self.route = "-"

    def refuse(self, guard: str, event: str, detail: str) -> None:
        where = _product_caller()
        with self._lock:
            key = (guard, event, self.route)
            self.refused[key] = self.refused.get(key, 0) + 1
            if len(self.details) < 500:
                self.details.append({"guard": guard, "event": event, "route": self.route,
                                     "detail": detail, "where": where})

    def allow(self, guard: str) -> None:
        with self._lock:
            self.allowed[guard] = self.allowed.get(guard, 0) + 1

    def total(self, guard: str | None = None) -> int:
        with self._lock:
            return sum(n for (g, _e, _r), n in self.refused.items()
                       if guard is None or g == guard)

    def as_json(self) -> dict[str, Any]:
        with self._lock:
            return {
                "refused": [{"guard": g, "event": e, "route": r, "count": n}
                            for (g, e, r), n in sorted(self.refused.items())],
                "refused_total": sum(self.refused.values()),
                "allowed": dict(sorted(self.allowed.items())),
                "details": list(self.details),
            }


_TLS = threading.local()
_INSTALLED: dict[str, Any] = {}


def _product_caller() -> str:
    """``module.py:function`` of the innermost PRODUCT frame that caused a
    refusal — a file name and a function name, never a path or a value, so a
    refusal can be explained without leaving the copy's data in the record."""
    frame = sys._getframe(1)
    while frame is not None:
        name = frame.f_code.co_filename.replace("\\", "/")
        if "/backend/orgtree/" in name or ("/engine/" in name and "/runtime/" not in name
                                            and "/backend/" not in name):
            return f"{name.rsplit('/', 1)[-1]}:{frame.f_code.co_name}"
        frame = frame.f_back
    return "-"


def _in_socketpair() -> bool:
    frame = sys._getframe(3)
    while frame is not None:
        code = frame.f_code
        if (code.co_name in ("socketpair", "_fallback_socketpair")
                and os.path.basename(code.co_filename) == "socket.py"):
            return True
        frame = frame.f_back
    return False


def _host_of(address: Any) -> str:
    if isinstance(address, tuple) and address:
        return str(address[0]).lower()
    return str(address).lower()


def _db_path(database: Any) -> str | None:
    """The file ``sqlite3.connect`` would open, or None for in-memory."""
    try:
        text = os.fsdecode(os.fspath(database))
    except TypeError:
        return None
    if text in ("", ":memory:"):
        return None
    if text.startswith("file:"):
        from urllib.parse import unquote
        body, _sep, query = text[5:].partition("?")
        if "mode=memory" in query or body in ("", ":memory:"):
            return None
        body = unquote(body)
        if body.startswith("///"):
            body = body[3:]
        elif body.startswith("//localhost/"):
            body = body[len("//localhost/"):]
        return body
    return text


def _remote_or_device(text: str) -> bool:
    """A UNC share (``\\\\host\\share``: an SMB connection, i.e. network
    egress) or a device-namespace path (``\\\\.\\pipe\\x``: a connection to
    another process). The long-path form ``\\\\?\\C:\\...`` is a local file."""
    t = text.replace("/", "\\")
    if not t.startswith("\\\\"):
        return False
    return not (t.startswith("\\\\?\\") and len(t) > 5 and t[4].isalpha() and t[5] == ":")


def _is_write_open(mode: Any, flags: Any) -> bool:
    if isinstance(mode, str) and any(c in mode for c in "wax+"):
        return True
    return isinstance(flags, int) and bool(flags & _WRITE_FLAGS)


class _Hook:
    def __init__(self, policy: Policy, report: Report) -> None:
        self.policy = policy
        self.report = report
        self._cache: dict[str, str] = {}

    def _norm(self, path: Any) -> str | None:
        if isinstance(path, int) or path is None:
            return None
        try:
            key = os.fsdecode(os.fspath(path))
        except TypeError:
            return None
        found = self._cache.get(key)
        if found is None:
            found = normal(key)
            if len(self._cache) < 100_000:
                self._cache[key] = found
        return found

    def _protected(self, p: str) -> bool:
        return any(within(p, root) for root in self.policy.protected_roots)

    def _writable(self, p: str) -> bool:
        return any(within(p, root) for root in self.policy.write_roots)

    def _refuse(self, guard: str, event: str, detail: str) -> None:
        self.report.refuse(guard, event, detail)
        raise GuardRefused(f"isolation guard refused {event} ({guard}: {detail})")

    def _refuse_remote(self, event: str, path: Any) -> None:
        # on the RAW text, before _norm: normal() calls realpath, which OPENS
        # the path on Windows — for a share or a pipe, that is the connection
        if isinstance(path, int) or path is None:
            return
        try:
            text = os.fsdecode(os.fspath(path))
        except TypeError:
            return
        if _remote_or_device(text):
            self._refuse("egress", event, "unc-or-device")

    def _check_read(self, event: str, path: Any, listing: bool = False) -> None:
        self._refuse_remote(event, path)
        p = self._norm(path)
        if p is None:
            return
        self._refuse_remote(event, p)  # a junction or symlink resolved to a share
        if self._protected(p):
            allowed = (self.policy.list_exceptions if listing
                       else self.policy.read_exceptions)
            if p not in allowed:
                self._refuse("read", event, "protected")
        self.report.allow("read")

    def _check_write(self, event: str, path: Any) -> None:
        self._refuse_remote(event, path)
        p = self._norm(path)
        if p is None:
            return
        self._refuse_remote(event, p)  # a junction or symlink resolved to a share
        if self._protected(p):
            self._refuse("write", event, "protected")
        if not self._writable(p):
            self._refuse("write", event, "outside-allowlist")
        self.report.allow("write")

    def __call__(self, event: str, args: tuple[Any, ...]) -> None:
        if getattr(_TLS, "busy", False):
            return
        _TLS.busy = True
        try:
            self._dispatch(event, args)
        finally:
            _TLS.busy = False

    def _dispatch(self, event: str, args: tuple[Any, ...]) -> None:
        if event == "open":
            path, mode, flags = (tuple(args) + (None, None, None))[:3]
            if _is_write_open(mode, flags):
                self._check_write(event, path)
            else:
                self._check_read(event, path)
        elif event in WRITE_PATH_EVENTS:
            for i in READ_SIDE_OF_WRITE.get(event, ()):
                if i < len(args):
                    self._check_read(event, args[i])
            for i in WRITE_PATH_EVENTS[event]:
                if i < len(args):
                    self._check_write(event, args[i])
        elif event in READ_PATH_EVENTS:
            if args:
                self._check_read(event, args[0] if args[0] is not None else ".",
                                 listing=event in ("os.listdir", "os.scandir"))
        elif event == "sqlite3.connect":
            target = _db_path(args[0]) if args else None
            if target is not None:
                self._refuse_remote(event, target)
                p = self._norm(target)
                if p is not None and self._protected(p):
                    self._refuse("read", event, "protected")
                if p is not None and not self._writable(p):
                    self._refuse("write", event, "outside-allowlist")
            self.report.allow("sqlite")
        elif event in PROCESS_EVENTS:
            argv = args[1] if event == "subprocess.Popen" and len(args) > 1 else None
            exe = args[0] if args else ""
            if isinstance(argv, (list, tuple)) and argv:
                exe = argv[0]
            elif isinstance(argv, (str, bytes)) and argv:
                exe = os.fsdecode(argv).split()[0].strip('"')
            name = os.path.basename(str(exe or "")).lower()[:40]
            self._refuse("process", event, name or "?")
        elif event in KILL_EVENTS:
            self._refuse("kill", event, "pid")
        elif event == "_winapi.CreateFile":
            name = args[0] if args else None
            access = args[1] if len(args) > 1 and isinstance(args[1], int) else 0
            disposition = args[3] if len(args) > 3 and isinstance(args[3], int) else 3
            flags = args[4] if len(args) > 4 and isinstance(args[4], int) else 0
            if (access & CREATEFILE_WRITE_ACCESS
                    or disposition in CREATEFILE_WRITE_DISPOSITIONS
                    or flags & CREATEFILE_DELETE_ON_CLOSE):
                self._check_write(event, name)
            else:
                self._check_read(event, name)
        elif event == "_winapi.CreateNamedPipe":
            # a pipe SERVER: another process could connect in
            self._refuse("egress", event, "named-pipe")
        elif event in ("ctypes.dlsym", "ctypes.dlsym/handle"):
            name = args[1] if len(args) > 1 else ""
            if isinstance(name, bytes):
                name = name.decode("ascii", "replace")
            if not isinstance(name, str):
                # an ORDINAL lookup names no symbol, so no prefix rule could
                # match it: refused outright (review N2)
                self._refuse("kill", event, "ordinal")
            if name not in self.policy.ctypes_symbols:
                for guard, prefix in SYMBOL_PREFIXES:
                    if name.startswith(prefix):
                        self._refuse(guard, event, name[:40])
            self.report.allow("ctypes")
        elif event == "ctypes.dlopen":
            if args and isinstance(args[0], str):
                self._refuse_remote(event, args[0])  # a DLL from a share is SMB egress
            lib = os.path.basename(str(args[0] if args else "")).lower()
            stem = lib.rsplit(".", 1)[0] if lib.endswith(".dll") else lib
            if stem not in self.policy.ctypes_libraries:
                self._refuse("kill", event, stem[:40] or "?")
            self.report.allow("ctypes")
        elif event in CONNECT_EVENTS:
            address = args[1] if len(args) > 1 else None
            if (event == "socket.connect" and _host_of(address) in _LOOPBACK
                    and _in_socketpair()):
                self.report.allow("egress")
                return
            host = _host_of(address)
            self._refuse("egress", event,
                         "loopback" if host in _LOOPBACK else "remote")
        elif event in RESOLVE_EVENTS or event in CLIENT_EVENTS:
            self._refuse("egress", event, "resolve" if event in RESOLVE_EVENTS else "client")
        elif event == "socket.bind":
            address = args[1] if len(args) > 1 else None
            if _host_of(address) not in _LOOPBACK:
                self._refuse("egress", event, "non-loopback")
            self.report.allow("egress")
        elif event in REGISTRY_WRITE_EVENTS:
            self._refuse("registry", event, "write")
        elif event in ("winreg.OpenKey", "winreg.OpenKey/result"):
            access = args[2] if event == "winreg.OpenKey" and len(args) > 2 else 0
            if isinstance(access, int) and access & REGISTRY_WRITE_ACCESS:
                self._refuse("registry", event, "write-access")
            self.report.allow("registry")


def assert_no_product_imports() -> None:
    """Review A5: hooks installed after a product import would have missed
    that import's side effects and every ctypes symbol it resolved."""
    loaded = sorted(name for name in sys.modules
                    if name.split(".", 1)[0] in PRODUCT_PACKAGES)
    if loaded:
        raise RefuseToRun(f"product modules already imported before the guards: {loaded[:5]}")


def install_audit_guards(policy: Policy, report: Report) -> _Hook:
    """Install once per process; a second call refuses (hooks cannot be removed)."""
    if _INSTALLED:
        raise RefuseToRun("isolation guards are already installed in this process")
    assert_no_product_imports()
    hook = _Hook(policy, report)
    sys.addaudithook(hook)
    _INSTALLED["hook"] = hook
    return hook


def block_native_process_modules() -> list[str]:
    """Make each NATIVE_PROCESS_MODULES entry unimportable (``import`` then
    raises ImportError, which every product site handles). Refuses when one
    is already imported: its native calls would already be out of reach."""
    loaded = [name for name in NATIVE_PROCESS_MODULES if sys.modules.get(name) is not None]
    if loaded:
        raise RefuseToRun(f"native process modules already imported: {loaded}")
    for name in NATIVE_PROCESS_MODULES:
        sys.modules[name] = None  # type: ignore[assignment]
    return list(NATIVE_PROCESS_MODULES)


def force_selector_loop() -> None:
    """Async connects then go through ``socket.connect``, which is audited."""
    if sys.platform == "win32":
        import asyncio
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def block_proactor_connect(report: Report) -> None:
    """Backstop: a Proactor loop created anyway cannot connect unseen."""
    if sys.platform != "win32":
        return
    from asyncio import windows_events

    def refused(name: str) -> Callable[..., Any]:
        def method(self: Any, *args: Any, **kwargs: Any) -> Any:
            report.refuse("egress", f"IocpProactor.{name}", "proactor")
            raise GuardRefused(f"isolation guard refused IocpProactor.{name}")
        method._isolation_guard = True  # type: ignore[attr-defined]
        return method

    for name in ("connect", "connect_pipe"):
        if not getattr(getattr(windows_events.IocpProactor, name), "_isolation_guard", False):
            setattr(windows_events.IocpProactor, name, refused(name))


def install_wake_guard(supervisor: Any, report: Report) -> list[str]:
    """Wrap every wake entry point present on ``supervisor`` (module
    attribute patch: api.py calls them as ``supervisor.<name>``, and
    supervisor-internal calls look the name up in the same module dict).
    Returns the names wrapped; a name absent from this build is skipped and
    NOT reported as wrapped."""
    wrapped: list[str] = []
    for name in WAKE_ENTRY_POINTS:
        original = getattr(supervisor, name, None)
        if original is None or getattr(original, "_isolation_guard", False):
            continue

        def guard(*args: Any, _name: str = name, _original: Any = original,
                  **kwargs: Any) -> Any:
            if _name == "send_message" and kwargs.get("wake") is False:
                report.allow("wake")
                return _original(*args, **kwargs)
            if _name == "drive_unfrozen_by_switch":
                targets = kwargs.get("nids", args[1] if len(args) > 1 else ())
                if not list(targets or ()):
                    report.allow("wake")
                    return None
            report.refuse("wake", f"supervisor.{_name}", "turn")
            raise GuardRefused(f"isolation guard refused supervisor.{_name}")

        guard._isolation_guard = True  # type: ignore[attr-defined]
        setattr(supervisor, name, guard)
        wrapped.append(name)
    return wrapped
