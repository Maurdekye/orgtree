"""Fail-closed launch audit for disposable scale engines; never product code."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shlex
import threading
import time


def argv_of(value):
    if isinstance(value, (tuple, list)):
        return [os.fsdecode(x) for x in value]
    if not isinstance(value, str):
        return []
    if os.name != "nt":
        return shlex.split(value)
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    split = shell.CommandLineToArgvW
    split.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    split.restype = ctypes.POINTER(wintypes.LPWSTR)
    count = ctypes.c_int()
    result = split(value, ctypes.byref(count))
    if not result:
        return []
    try:
        return [result[i] for i in range(count.value)]
    finally:
        free = ctypes.WinDLL("kernel32").LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(ctypes.cast(result, ctypes.c_void_p))


def identity(value):
    # No PATH search, basename match, shell wrapper or command-content match.
    if value is None:
        return None
    value = os.fsdecode(value)
    return os.path.normcase(os.path.realpath(value)) if os.path.isabs(value) else None


class LaunchAudit:
    def __init__(self, root, *, git=None, providers=(), agy=None):
        self.root = Path(root)
        self.git = identity(git) if git else None
        self.providers = {identity(p) for p in providers} - {None}
        self.agy = identity(agy) if agy else None
        if self.agy:
            self.providers.add(self.agy)
        self.lock = threading.Lock()
        self.counts = {"capability_probes": 0, "unexpected": 0, "git_reads": 0}

    def classify(self, event, args):
        if event != "subprocess.Popen" or len(args) < 2:
            return "unexpected"
        words = argv_of(args[1])
        # Windows Popen normally passes applicationName=None; CreateProcess
        # then uses argv[0]. Still require its absolute, exact known identity.
        exe = identity(args[0] if args[0] is not None else (words[0] if words else None))
        if exe is None or not words or identity(words[0]) != exe:
            return "unexpected"
        tail = words[1:]
        if exe in self.providers and tail == ["--version"]:
            return "capability_probes"
        if exe == self.agy and self.agy and (tail == ["models"] or
                len(tail) == 3 and tail[0] == "--log-file" and tail[2:] == ["models"]):
            return "capability_probes"
        # Only explicit read forms, with optional repository selector. Never
        # accept -c/config injection, shell chains, diff drivers or output files.
        if exe == self.git and self.git:
            if len(tail) >= 3 and tail[0] == "-C":
                tail = tail[2:]
            allowed = (tail in (["status", "--porcelain"], ["status", "--porcelain=v1"],
                                ["status", "--short"], ["status"],
                                ["rev-parse", "HEAD"], ["rev-parse", "--show-toplevel"],
                                ["rev-parse", "--git-dir"], ["worktree", "list", "--porcelain"]))
            if allowed:
                return "git_reads"
        return "unexpected"

    def snapshot(self):
        with self.lock:
            return dict(self.counts)

    def __call__(self, event, args):
        if event not in {"subprocess.Popen", "os.system", "os.startfile", "os.posix_spawn", "os.spawn"}:
            return
        try:
            kind = self.classify(event, args)
        except Exception:
            kind = "unexpected"
        with self.lock:
            self.counts[kind] += 1
            if kind == "git_reads":
                return
            row = {"at": time.time(), "event": event, "cmd": str(args[1] if len(args) > 1 else args),
                   "executable": os.fsdecode(args[0]) if args and args[0] is not None else None,
                   "argv": argv_of(args[1]) if event == "subprocess.Popen" and len(args) > 1 else None,
                   "capability_probe": kind == "capability_probes"}
            with (self.root / "metrics" / "serve-refused.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            if kind == "unexpected":
                (self.root / "metrics" / "qualification-invalid.json").write_text(json.dumps(row), encoding="utf-8")
        raise FileNotFoundError("scale serve forbids external process")


def pin_git(popen, executable):
    """Pin the engine's literal argv-style Git calls to the trusted absolute binary.

    The audit still validates the resulting argv. Shell strings and explicit
    executable overrides are never rewritten or allowed by this adapter.
    """
    trusted = identity(executable) if executable else None
    class PinnedPopen(popen):
        def __init__(self, args, *pos, **kwargs):
            if (trusted and isinstance(args, (list, tuple)) and args
                    and args[0] in ("git", "git.exe") and len(pos) < 2
                    and not kwargs.get("shell") and not kwargs.get("executable")):
                args = [trusted, *args[1:]]
            super().__init__(args, *pos, **kwargs)
    return PinnedPopen
