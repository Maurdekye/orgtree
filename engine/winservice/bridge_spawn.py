"""Create one signed-in-user process for one bridge-dependent agent turn.

The process starts suspended, enters its own kill-on-close job, and is
resumed only by BridgeState.commit_turn. Its stdio and limited process handle
are duplicated into the authenticated engine process; no token handle is.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import os
from pathlib import Path
import subprocess
import time
from typing import Any

from .process import (CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
                      EXTENDED_STARTUPINFO_PRESENT, HANDLE_LIST,
                      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, STARTF_USESTDHANDLES,
                      WAIT_OBJECT_0, WAIT_TIMEOUT, ExtendedLimit, ProcessInfo,
                      StartupInfoEx, WindowsProcessAPI, _environment_block,
                      no_prompt_git)
from .bridge_transport import SecurityAttributes


DUPLICATE_SAME_ACCESS = 0x2
DUPLICATE_CLOSE_SOURCE = 0x1
LIMITED_PROCESS_RIGHTS = 0x00100000 | 0x1000 | 0x0001


class BridgedChild:
    def __init__(self, api: "BridgeSpawnAPI", info: ProcessInfo, job: int,
                 parent_handles: tuple[int, int, int]):
        self.api = api
        self.pid = int(info.dwProcessId)
        self.process = int(info.hProcess)
        self.thread = int(info.hThread)
        self.job = job
        self.parent_handles = parent_handles
        self._closed = False

    def resume(self) -> None:
        if self.api.kernel.ResumeThread(w.HANDLE(self.thread)) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        self.api.kernel.CloseHandle(w.HANDLE(self.thread))
        self.thread = 0

    def wait(self, timeout: float | None = None) -> int | None:
        millis = 0xFFFFFFFF if timeout is None else max(0, int(timeout * 1000))
        result = self.api.kernel.WaitForSingleObject(w.HANDLE(self.process), millis)
        if result == WAIT_TIMEOUT:
            return None
        if result != WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        code = w.DWORD()
        if not self.api.kernel.GetExitCodeProcess(w.HANDLE(self.process), ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(code.value)

    def terminate(self) -> None:
        if not self.api.kernel.TerminateJobObject(w.HANDLE(self.job), 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def publish(self, client_process: int) -> dict[str, int]:
        """Return handle VALUES valid only in the authenticated engine."""
        source = self.api.kernel.GetCurrentProcess()
        remote: list[int] = []
        try:
            for handle in self.parent_handles:
                target = w.HANDLE()
                self.api._check(self.api.kernel.DuplicateHandle(
                    source, w.HANDLE(handle), w.HANDLE(client_process),
                    ctypes.byref(target), 0, False, DUPLICATE_SAME_ACCESS))
                remote.append(int(target.value))
            target = w.HANDLE()
            self.api._check(self.api.kernel.DuplicateHandle(
                source, w.HANDLE(self.process), w.HANDLE(client_process),
                ctypes.byref(target), LIMITED_PROCESS_RIGHTS, False, 0))
            remote.append(int(target.value))
            for handle in self.parent_handles:
                self.api.kernel.CloseHandle(w.HANDLE(handle))
            self.parent_handles = ()
            return {"pid": self.pid, "stdin": remote[0], "stdout": remote[1],
                    "stderr": remote[2], "process": remote[3]}
        except BaseException:
            for handle in remote:
                retrieved = w.HANDLE()
                if self.api.kernel.DuplicateHandle(w.HANDLE(client_process), w.HANDLE(handle),
                                                   source, ctypes.byref(retrieved), 0, False,
                                                   DUPLICATE_CLOSE_SOURCE):
                    self.api.kernel.CloseHandle(retrieved)
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.api.kernel.CloseHandle(w.HANDLE(self.job))  # kills any survivor
        self.api.kernel.WaitForSingleObject(w.HANDLE(self.process), 10_000)
        for handle in (self.process, self.thread, *self.parent_handles):
            if handle:
                self.api.kernel.CloseHandle(w.HANDLE(handle))


class BridgeSpawnAPI(WindowsProcessAPI):
    def __init__(self) -> None:
        super().__init__()
        self.kernel.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE),
                                           ctypes.POINTER(w.HANDLE),
                                           ctypes.POINTER(SecurityAttributes), w.DWORD]
        self.kernel.DuplicateHandle.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE,
                                                 ctypes.POINTER(w.HANDLE), w.DWORD,
                                                 w.BOOL, w.DWORD]
        self.kernel.GetCurrentProcess.restype = w.HANDLE

    def _pipe(self) -> tuple[int, int]:
        read = w.HANDLE()
        write = w.HANDLE()
        attrs = SecurityAttributes(ctypes.sizeof(SecurityAttributes), None, True)
        self._check(self.kernel.CreatePipe(ctypes.byref(read), ctypes.byref(write),
                                           ctypes.byref(attrs), 0))
        return int(read.value), int(write.value)

    def create_suspended(self, token: int, argv: list[str], cwd: str,
                         env: dict[str, str]) -> BridgedChild:
        if (not argv or len(argv) > 128 or not all(isinstance(value, str) for value in argv)
                or not Path(argv[0]).is_absolute() or not Path(argv[0]).is_file()
                or not Path(cwd).is_absolute() or not Path(cwd).is_dir()):
            raise ValueError("bridge spawn requires an absolute program and work directory")
        if not isinstance(env, dict) or len(env) > 512 or not all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in env.items()):
            raise ValueError("bridge spawn environment is invalid")
        # Never pass the service's local IPC authority to the provider child.
        env = {key: value for key, value in env.items()
               if key.upper() not in {"ORGTREE_V2_BRIDGE_SECRET", "ORGTREE_V2_SERVICE_STOP_EVENT"}}
        no_prompt_git(env)
        block = _environment_block(env)
        job = process = thread = 0
        all_pipes: list[int] = []
        attr = None
        attr_initialized = False
        try:
            stdin_read, stdin_write = self._pipe()
            all_pipes += [stdin_read, stdin_write]
            stdout_read, stdout_write = self._pipe()
            all_pipes += [stdout_read, stdout_write]
            stderr_read, stderr_write = self._pipe()
            all_pipes += [stderr_read, stderr_write]
            for parent in (stdin_write, stdout_read, stderr_read):
                self._check(self.kernel.SetHandleInformation(w.HANDLE(parent), 1, 0))
            job = int(self.kernel.CreateJobObjectW(None, None) or 0)
            self._check(job)
            limits = ExtendedLimit()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            self._check(self.kernel.SetInformationJobObject(w.HANDLE(job), 9,
                                                            ctypes.byref(limits), ctypes.sizeof(limits)))
            size = ctypes.c_size_t()
            self.kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
            attr = ctypes.create_string_buffer(size.value)
            self._check(self.kernel.InitializeProcThreadAttributeList(attr, 1, 0,
                                                                        ctypes.byref(size)))
            attr_initialized = True
            handles = (w.HANDLE * 3)(stdin_read, stdout_write, stderr_write)
            self._check(self.kernel.UpdateProcThreadAttribute(
                attr, 0, HANDLE_LIST, handles, ctypes.sizeof(handles), None, None))
            startup = StartupInfoEx()
            startup.StartupInfo.cb = ctypes.sizeof(startup)
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = w.HANDLE(stdin_read)
            startup.StartupInfo.hStdOutput = w.HANDLE(stdout_write)
            startup.StartupInfo.hStdError = w.HANDLE(stderr_write)
            startup.lpAttributeList = ctypes.cast(attr, ctypes.c_void_p)
            info = ProcessInfo()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
            self._check(self.advapi.CreateProcessAsUserW(
                w.HANDLE(token), argv[0], command, None, None, True,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                EXTENDED_STARTUPINFO_PRESENT,
                block, cwd, ctypes.byref(startup), ctypes.byref(info)))
            process, thread = int(info.hProcess), int(info.hThread)
            self._check(self.kernel.AssignProcessToJobObject(w.HANDLE(job), w.HANDLE(process)))
            for child_end in (stdin_read, stdout_write, stderr_write):
                self.kernel.CloseHandle(w.HANDLE(child_end))
                all_pipes.remove(child_end)
            result = BridgedChild(self, info, job, (stdin_write, stdout_read, stderr_read))
            all_pipes = []
            job = process = thread = 0
            return result
        except BaseException:
            if process:
                self.kernel.TerminateProcess(w.HANDLE(process), 1)
                self.kernel.WaitForSingleObject(w.HANDLE(process), 10_000)
            raise
        finally:
            if attr_initialized:
                self.kernel.DeleteProcThreadAttributeList(attr)
            for handle in (thread, process, job, *all_pipes):
                if handle:
                    self.kernel.CloseHandle(w.HANDLE(handle))
