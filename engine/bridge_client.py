"""Engine-side client for session-bound provider processes on Windows.

The service-only authority is removed from os.environ by launch.load_app
before provider imports. This module keeps it in process memory. A provider
child receives only its own argv/environment and duplicated stdio handles.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import io
import msvcrt
import os
import subprocess
import threading
from typing import Any

from .winservice.bridge_transport import WindowsPipeAPI, read_frame, write_frame


_secret: str | None = None
_secret_lock = threading.Lock()
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258


class BridgeUnavailable(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def configure(secret: str) -> None:
    if len(secret) != 64 or any(ch not in "0123456789abcdef" for ch in secret):
        raise ValueError("invalid service bridge authority")
    global _secret
    with _secret_lock:
        if _secret is not None and _secret != secret:
            raise RuntimeError("service bridge authority changed inside a running engine")
        _secret = secret


def available() -> bool:
    return _secret is not None


def _request(body: dict[str, Any]) -> dict[str, Any]:
    with _secret_lock:
        secret = _secret
    if secret is None:
        raise BridgeUnavailable("not-service-mode")
    request = {"secret": secret, **body}
    try:
        with WindowsPipeAPI("").open_client() as stream:
            write_frame(stream, request)
            response = read_frame(stream)
    except (OSError, EOFError, ValueError) as exc:
        raise BridgeUnavailable("bridge-unavailable") from exc
    if response.get("ok") is not True:
        raise BridgeUnavailable(str(response.get("code") or "bridge-refused"))
    return response


def state() -> dict[str, Any]:
    return _request({"op": "state"})


class BridgedPopen:
    """The subset of subprocess.Popen used by the provider supervisor."""

    def __init__(self, values: dict[str, Any], args: list[str]):
        self.pid = int(values["pid"])
        self.args = args
        self._handle = int(values["process"])
        self.returncode: int | None = None
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        self.kernel.WaitForSingleObject.restype = w.DWORD
        self.kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        self.kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        stdin_fd = msvcrt.open_osfhandle(int(values["stdin"]), os.O_BINARY | os.O_WRONLY)
        stdout_fd = msvcrt.open_osfhandle(int(values["stdout"]), os.O_BINARY | os.O_RDONLY)
        stderr_fd = msvcrt.open_osfhandle(int(values["stderr"]), os.O_BINARY | os.O_RDONLY)
        self.stdin = io.TextIOWrapper(os.fdopen(stdin_fd, "wb", buffering=0),
                                      encoding="utf-8", errors="replace", line_buffering=True)
        self.stdout = io.TextIOWrapper(os.fdopen(stdout_fd, "rb", buffering=0),
                                       encoding="utf-8", errors="replace")
        self.stderr = io.TextIOWrapper(os.fdopen(stderr_fd, "rb", buffering=0),
                                       encoding="utf-8", errors="replace")

    def poll(self) -> int | None:
        if self.returncode is not None:
            return self.returncode
        result = self.kernel.WaitForSingleObject(w.HANDLE(self._handle), 0)
        if result == WAIT_TIMEOUT:
            return None
        if result != WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        code = w.DWORD()
        if not self.kernel.GetExitCodeProcess(w.HANDLE(self._handle), ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.returncode = int(code.value)
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        millis = 0xFFFFFFFF if timeout is None else max(0, int(timeout * 1000))
        result = self.kernel.WaitForSingleObject(w.HANDLE(self._handle), millis)
        if result == WAIT_TIMEOUT:
            raise subprocess.TimeoutExpired(self.args, timeout)
        if result != WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        return int(self.poll())

    def kill(self) -> None:
        if self.poll() is None:
            if not self.kernel.TerminateProcess(w.HANDLE(self._handle), 1):
                raise ctypes.WinError(ctypes.get_last_error())

    terminate = kill

    def communicate(self, input: str | None = None,
                    timeout: float | None = None) -> tuple[str, str]:
        output: list[str] = ["", ""]
        threads = [threading.Thread(target=lambda index, stream: output.__setitem__(index, stream.read()),
                                    args=(index, stream), daemon=True)
                   for index, stream in enumerate((self.stdout, self.stderr))]
        for thread in threads:
            thread.start()
        if self.stdin and not self.stdin.closed:
            try:
                if input is not None:
                    self.stdin.write(input)
            finally:
                self.stdin.close()
        self.wait(timeout)
        for thread in threads:
            thread.join()
        return output[0], output[1]

    def close(self) -> None:
        for stream in (self.stdin, self.stdout, self.stderr):
            if not stream.closed:
                stream.close()
        if self._handle:
            self.kernel.CloseHandle(w.HANDLE(self._handle))
            self._handle = 0


def spawn(turn_id: str, argv: list[str], cwd: str,
          env: dict[str, str]) -> BridgedPopen:
    response = _request({"op": "spawn", "turnId": turn_id,
                         "argv": argv, "cwd": cwd, "env": env})
    try:
        return BridgedPopen(response, argv)
    except BaseException:
        try:
            _request({"op": "terminate", "turnId": turn_id})
        except BridgeUnavailable:
            pass
        raise
