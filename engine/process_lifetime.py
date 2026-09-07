"""Own one engine tree and data-root lock independently of engine shutdown.

Call arm_process_lifetime before domain imports. The small guardian intentionally
outlives a dying engine: it terminates remaining descendants before releasing the
root lock. It never imports the API, reads credentials, or dispatches a provider.
"""
from __future__ import annotations
import ctypes
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

_guardian: subprocess.Popen | None = None


def arm_process_lifetime(root: str | Path, parent_pid: int | None = None, *, timeout: float = 15) -> int:
    """Return guardian PID after exclusive root and process ownership is proven.

    No explicit close is needed: normal engine exit and parent death both trigger
    cleanup. Do not kill the guardian to detach it; doing so kills its owned tree.
    """
    global _guardian
    if os.name != "nt":
        raise RuntimeError("process ownership is currently supported on Windows only; a native platform adapter is required")
    if timeout <= 0:
        raise ValueError("guardian timeout must be positive")
    if _guardian is not None:
        raise RuntimeError("engine lifetime is already armed")
    candidate = Path(root)
    if not candidate.is_absolute() or not candidate.is_dir():
        raise RuntimeError("lifetime requires an existing absolute data root")
    candidate = candidate.resolve(strict=True)
    if parent_pid is not None and (not isinstance(parent_pid, int) or parent_pid <= 0):
        raise RuntimeError("invalid desktop parent PID")
    # Only platform plumbing is inherited, never the desktop/provider credentials.
    allowed = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "SYSTEMDRIVE", "COMSPEC"}
    env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    env["ORGTREE_DATA"] = str(candidate)
    args = [sys.executable, str(Path(__file__).resolve()), "--watch", str(candidate), str(os.getpid()), str(parent_pid or 0)]
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=env,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                               start_new_session=os.name != "nt")
    result: queue.Queue = queue.Queue()
    def receive():
        assert process.stdout is not None
        while True:
            line = process.stdout.readline(8192)
            result.put(line)
            if not line:
                return
    threading.Thread(target=receive, daemon=True).start()
    def response(phase):
        deadline = time.monotonic() + timeout
        seen = 0
        while True:
            try:
                line = result.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as exc:
                raise RuntimeError(f"guardian {phase} timed out after {timeout:g}s") from exc
            if not line:
                raise RuntimeError("guardian closed its startup channel")
            seen += len(line)
            if seen > 65536:
                raise RuntimeError("guardian startup channel exceeded size limit")
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(value, dict) and (value.get("guardian") == process.pid or "error" in value):
                return value
    committed = False
    try:
        reply = response("preparation")
        if reply.get("prepared") is not True or reply.get("guardian") != process.pid:
            raise RuntimeError(reply.get("error", "lifetime guardian refused preparation"))
        # Until this acknowledgment the Job does not contain the engine, so a
        # slow preparation can be cancelled without killing its caller.
        committed = True
        _guardian = process
        assert process.stdin is not None
        process.stdin.write(b"arm\n")
        process.stdin.flush()
        process.stdin.close()
        reply = response("assignment acknowledgment")
        if reply.get("ready") is not True or reply.get("guardian") != process.pid:
            raise RuntimeError(reply.get("error", "lifetime guardian refused startup"))
    except Exception as exc:
        if not committed:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        # After acknowledgment, never kill the guardian to report a timeout:
        # its Job may already own us. The launcher receives this startup error
        # and exits nonzero, while the guardian retains tree/root ownership.
        raise RuntimeError(f"engine lifetime unavailable: {exc}") from exc
    finally:
        if not committed:
            for pipe in (process.stdin, process.stdout):
                if pipe is not None:
                    pipe.close()
    _guardian = process
    return process.pid


class RootLock:
    def __init__(self, root: Path):
        lock = root / ".desktop-engine.lock"
        if lock.is_symlink():
            raise RuntimeError("engine lock cannot be a symlink")
        self.file = open(lock, "a+b")
        try:
            if self.file.tell() == 0:
                self.file.write(b"0")
                self.file.flush()
            self.file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.file.close()
            raise RuntimeError("another engine owns this data root; inspect .desktop-engine-status.json for pending cleanup") from exc

    def close(self):
        self.file.close()


class WindowsTree:
    """Guardian owns the only Job handle; engine and future children join it."""
    def __init__(self, engine_pid: int, parent_pid: int):
        from ctypes import wintypes as w
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        k = self.k
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        k.CreateJobObjectW.restype = w.HANDLE
        k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        k.SetInformationJobObject.restype = w.BOOL
        k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        k.QueryInformationJobObject.restype = w.BOOL
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        k.OpenProcess.restype = w.HANDLE
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        k.AssignProcessToJobObject.restype = w.BOOL
        k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        k.TerminateJobObject.restype = w.BOOL
        k.WaitForMultipleObjects.argtypes = [w.DWORD, ctypes.POINTER(w.HANDLE), w.BOOL, w.DWORD]
        k.WaitForMultipleObjects.restype = w.DWORD
        k.CloseHandle.argtypes = [w.HANDLE]
        k.CloseHandle.restype = w.BOOL
        class Limits(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", w.DWORD), ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t),
                        ("active_limit", w.DWORD), ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(f"value{i}", ctypes.c_uint64) for i in range(6)]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Limits), ("io", IO), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
        class Accounting(ctypes.Structure):
            _fields_ = [("user", ctypes.c_int64), ("kernel", ctypes.c_int64), ("period_user", ctypes.c_int64),
                        ("period_kernel", ctypes.c_int64), ("faults", w.DWORD), ("total", w.DWORD),
                        ("active", w.DWORD), ("terminated", w.DWORD)]
        self.Accounting = Accounting
        self.job = None
        self.handles = []
        self.armed = False
        try:
            # Open process handles first, pinning identities rather than polling reusable PIDs.
            engine = k.OpenProcess(0x00100000 | 0x0100 | 0x0001, False, engine_pid)
            if not engine:
                raise ctypes.WinError(ctypes.get_last_error())
            self.handles.append(engine)
            if parent_pid:
                parent = k.OpenProcess(0x00100000, False, parent_pid)
                if not parent:
                    raise ctypes.WinError(ctypes.get_last_error())
                self.handles.append(parent)
            self.job = k.CreateJobObjectW(None, None)
            if not self.job:
                raise ctypes.WinError(ctypes.get_last_error())
            info = Extended()
            info.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k.SetInformationJobObject(self.job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
        except Exception:
            self.close()
            raise

    def arm(self):
        if not self.k.AssignProcessToJobObject(self.job, self.handles[0]):
            raise ctypes.WinError(ctypes.get_last_error())
        self.armed = True

    def wait(self):
        from ctypes import wintypes as w
        handles = (w.HANDLE * len(self.handles))(*self.handles)
        result = self.k.WaitForMultipleObjects(len(self.handles), handles, False, 0xFFFFFFFF)
        if result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())

    def terminate(self, code=0, stalled=None):
        if not self.k.TerminateJobObject(self.job, code):
            raise ctypes.WinError(ctypes.get_last_error())
        # Keep root ownership while Windows is completing descendant termination.
        deadline = time.monotonic() + 10
        while True:
            info = self.Accounting()
            if not self.k.QueryInformationJobObject(self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not info.active:
                return
            if time.monotonic() >= deadline:
                if stalled:
                    stalled(info.active)
                deadline = time.monotonic() + 10
            time.sleep(0.02)

    def close(self):
        if self.job:
            self.k.CloseHandle(self.job)
            self.job = None
        for handle in self.handles:
            self.k.CloseHandle(handle)
        self.handles = []


def watch(root: Path, engine: int, parent: int):
    lock = tree = None
    ready = False
    try:
        lock = RootLock(root)
        diagnostic = root / ".desktop-engine-status.json"
        diagnostic.unlink(missing_ok=True)
        if os.name != "nt":
            raise RuntimeError("no native process ownership adapter for this platform")
        tree = WindowsTree(engine, parent)
        print(json.dumps({"prepared": True, "guardian": os.getpid()}), flush=True)
        if sys.stdin.readline(16).strip() != "arm":
            raise RuntimeError("engine did not acknowledge guardian preparation")
        tree.arm()
        print(json.dumps({"ready": True, "guardian": os.getpid()}), flush=True)
        ready = True
        tree.wait()
        tree.terminate(stalled=lambda active: (root / ".desktop-engine-status.json").write_text(
            json.dumps({"state": "termination_pending", "active": active, "guardian": os.getpid(),
                        "message": "Windows has not completed process termination; root lock remains held", "at": time.time()}), encoding="utf-8"))
        diagnostic.unlink(missing_ok=True)
    except Exception as exc:
        if tree and tree.armed:
            tree.terminate(70)
        if not ready:
            print(json.dumps({"error": str(exc)}), flush=True)
        raise
    finally:
        if tree:
            tree.close()
        if lock:
            lock.close()


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "--watch":
        raise SystemExit("private guardian entrypoint")
    watch(Path(sys.argv[2]).resolve(strict=True), int(sys.argv[3]), int(sys.argv[4]))
