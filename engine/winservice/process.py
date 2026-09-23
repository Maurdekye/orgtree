"""Start the boot host in the operator's S4U batch logon, never as SYSTEM.

The process is suspended until it belongs to a kill-on-close job. The only
inherited handles are a stop event and an inert stdio sink. If any setup step
fails, the suspended process is terminated before its thread can run.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
from pathlib import Path
import subprocess
import sys
import time

from .s4u import S4UIdentity


CREATE_SUSPENDED = 0x4
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x400
EXTENDED_STARTUPINFO_PRESENT = 0x80000
STARTF_USESTDHANDLES = 0x100
HANDLE_LIST = 0x20002
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258


class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR),
                ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD),
                ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD),
                ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", w.HANDLE),
                ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", w.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", w.DWORD), ("Affinity", ctypes.c_size_t),
                ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64)]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


class BasicAccounting(ctypes.Structure):
    _fields_ = [("TotalUserTime", ctypes.c_int64),
                ("TotalKernelTime", ctypes.c_int64),
                ("ThisPeriodTotalUserTime", ctypes.c_int64),
                ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                ("TotalPageFaultCount", w.DWORD), ("TotalProcesses", w.DWORD),
                ("ActiveProcesses", w.DWORD), ("TotalTerminatedProcesses", w.DWORD)]


class ProfileInfo(ctypes.Structure):
    _fields_ = [("dwSize", w.DWORD), ("dwFlags", w.DWORD),
                ("lpUserName", w.LPWSTR), ("lpProfilePath", w.LPWSTR),
                ("lpDefaultPath", w.LPWSTR), ("lpServerName", w.LPWSTR),
                ("lpPolicyPath", w.LPWSTR), ("hProfile", w.HANDLE)]


def _environment_map(address: int) -> dict[str, str]:
    """Read the Windows double-NUL block, bounded before adding our values."""
    result: dict[str, str] = {}
    cursor = address
    end = address + 65536 * ctypes.sizeof(ctypes.c_wchar)
    while cursor < end:
        entry = ctypes.wstring_at(cursor)
        if not entry:
            return result
        cursor += (len(entry) + 1) * ctypes.sizeof(ctypes.c_wchar)
        key, separator, value = entry.partition("=")
        if separator and key and "\x00" not in key:
            result[key] = value
    raise OSError("Windows user environment exceeds the safe size")


def _environment_block(values: dict[str, str]) -> ctypes.Array:
    entries = []
    for key, value in sorted(values.items(), key=lambda item: item[0].upper()):
        if not key or "=" in key or "\x00" in key or "\x00" in value:
            raise ValueError("invalid Windows environment entry")
        entries.append(f"{key}={value}")
    text = "\x00".join(entries) + "\x00\x00"
    if len(text) > 32767:
        raise ValueError("Windows user environment is too large")
    return ctypes.create_unicode_buffer(text)


def no_prompt_git(env: dict[str, str]) -> None:
    """Fail promptly if this identity cannot use a Git credential.

    A genuine-session bridge can still read an existing Credential Manager
    entry, but neither service nor bridge processes may open an unseen prompt.
    """
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    env["GIT_ASKPASS"] = ""
    env["SSH_ASKPASS"] = ""
    env["SSH_ASKPASS_REQUIRE"] = "never"


class ServiceChild:
    def __init__(self, api: "WindowsProcessAPI", pid: int, process: int, job: int,
                 stop_event: int, token: int, profile: int, profile_path: Path):
        self.api = api
        self.pid = pid
        self.process = process
        self.job = job
        self.stop_event = stop_event
        self.token = token
        self.profile = profile
        self.profile_path = profile_path
        self._closed = False

    def wait(self, timeout: float) -> int | None:
        result = self.api.kernel.WaitForSingleObject(w.HANDLE(self.process),
                                                      max(0, int(timeout * 1000)))
        if result == WAIT_TIMEOUT:
            return None
        if result != WAIT_OBJECT_0:
            raise ctypes.WinError(ctypes.get_last_error())
        code = w.DWORD()
        if not self.api.kernel.GetExitCodeProcess(w.HANDLE(self.process), ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(code.value)

    def request_stop(self) -> None:
        if not self.api.kernel.SetEvent(w.HANDLE(self.stop_event)):
            raise ctypes.WinError(ctypes.get_last_error())

    def terminate(self, code: int) -> None:
        if not self.api.kernel.TerminateJobObject(w.HANDLE(self.job), code):
            raise ctypes.WinError(ctypes.get_last_error())

    def wait_empty(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            accounting = BasicAccounting()
            if not self.api.kernel.QueryInformationJobObject(
                    w.HANDLE(self.job), 1, ctypes.byref(accounting),
                    ctypes.sizeof(accounting), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if accounting.ActiveProcesses == 0:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        # Closing this job kills any last child. Confirm before unloading the
        # profile so no surviving engine uses its registry hive.
        self.api.kernel.CloseHandle(w.HANDLE(self.job))
        exited = self.api.kernel.WaitForSingleObject(w.HANDLE(self.process), 10_000)
        if exited == WAIT_OBJECT_0:
            self.api.userenv.UnloadUserProfile(w.HANDLE(self.token), w.HANDLE(self.profile))
        for handle in (self.process, self.stop_event, self.token):
            self.api.kernel.CloseHandle(w.HANDLE(handle))


class WindowsProcessAPI:
    def __init__(self) -> None:
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.userenv = ctypes.WinDLL("userenv", use_last_error=True)
        k = self.kernel
        k.CreateEventW.argtypes = [ctypes.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR]
        k.CreateEventW.restype = w.HANDLE
        k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p,
                                  w.DWORD, w.DWORD, w.HANDLE]
        k.CreateFileW.restype = w.HANDLE
        k.SetHandleInformation.argtypes = [w.HANDLE, w.DWORD, w.DWORD]
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        k.CreateJobObjectW.restype = w.HANDLE
        k.SetInformationJobObject.argtypes = [w.HANDLE, w.DWORD, ctypes.c_void_p, w.DWORD]
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        k.QueryInformationJobObject.argtypes = [w.HANDLE, w.DWORD, ctypes.c_void_p,
                                                 w.DWORD, ctypes.c_void_p]
        k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
        k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        k.WaitForSingleObject.restype = w.DWORD
        k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        k.SetEvent.argtypes = [w.HANDLE]
        k.CloseHandle.argtypes = [w.HANDLE]
        k.ResumeThread.argtypes = [w.HANDLE]
        k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD,
                                                         w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t,
                                                 ctypes.c_void_p, ctypes.c_size_t,
                                                 ctypes.c_void_p, ctypes.c_void_p]
        k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
        self.advapi.CreateProcessAsUserW.argtypes = [
            w.HANDLE, w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
            w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
            ctypes.POINTER(StartupInfoEx), ctypes.POINTER(ProcessInfo)]
        self.userenv.LoadUserProfileW.argtypes = [w.HANDLE, ctypes.POINTER(ProfileInfo)]
        self.userenv.UnloadUserProfile.argtypes = [w.HANDLE, w.HANDLE]
        self.userenv.CreateEnvironmentBlock.argtypes = [ctypes.POINTER(ctypes.c_void_p),
                                                        w.HANDLE, w.BOOL]
        self.userenv.DestroyEnvironmentBlock.argtypes = [ctypes.c_void_p]

    def _check(self, ok: object) -> None:
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    def _user_environment(self, token: int, stop_event: int,
                          bridge_secret: str) -> tuple[ctypes.Array, Path]:
        source = ctypes.c_void_p()
        self._check(self.userenv.CreateEnvironmentBlock(ctypes.byref(source),
                                                        w.HANDLE(token), False))
        try:
            env = _environment_map(source.value)
        finally:
            self.userenv.DestroyEnvironmentBlock(source)
        profile = env.get("USERPROFILE", "")
        if not profile or not Path(profile).is_absolute():
            raise OSError("operator profile path is unavailable before logon")
        env.update({"APPDATA": str(Path(profile) / "AppData" / "Roaming"),
                    "LOCALAPPDATA": str(Path(profile) / "AppData" / "Local"),
                    "HOME": profile,
                    "ORGTREE_V2_DATA": str(Path(profile) / "AppData" / "Roaming" / "Orgtree v2" / "data"),
                    "ORGTREE_V2_SERVICE_STOP_EVENT": str(stop_event),
                    "ORGTREE_V2_BRIDGE_SECRET": bridge_secret,
                    "ORGTREE_V2_SERVICE_PID": str(os.getpid())})
        no_prompt_git(env)
        for key in list(env):
            if key.upper().startswith("ORGTREE_") and key not in (
                    "ORGTREE_V2_DATA", "ORGTREE_V2_SERVICE_STOP_EVENT",
                    "ORGTREE_V2_BRIDGE_SECRET", "ORGTREE_V2_SERVICE_PID"):
                env.pop(key)
        return _environment_block(env), Path(profile).resolve()

    def spawn(self, token: int, username: str, host: Path,
              bridge_secret: str) -> ServiceChild:
        """Own ``token`` from call entry, including every failure path."""
        event = job = profile_handle = process_handle = 0
        thread_handle = 0
        attr = None
        attr_initialized = False
        try:
            profile = ProfileInfo(ctypes.sizeof(ProfileInfo), 1, username,
                                  None, None, None, None, None)
            self._check(self.userenv.LoadUserProfileW(w.HANDLE(token), ctypes.byref(profile)))
            profile_handle = int(profile.hProfile)
            event = int(self.kernel.CreateEventW(None, True, False, None) or 0)
            self._check(event)
            self._check(self.kernel.SetHandleInformation(w.HANDLE(event), 1, 1))
            env, profile_path = self._user_environment(token, event, bridge_secret)
            job = int(self.kernel.CreateJobObjectW(None, None) or 0)
            self._check(job)
            limits = ExtendedLimit()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            self._check(self.kernel.SetInformationJobObject(w.HANDLE(job), 9,
                                                            ctypes.byref(limits), ctypes.sizeof(limits)))
            # Explicit handle list: no accidental service or credential handle
            # is inherited by the batch host or its provider children.
            sink = self.kernel.CreateFileW("NUL", 0x40000000, 0x3, None, 3, 0x80, None)
            if sink in (None, w.HANDLE(-1).value):
                raise ctypes.WinError(ctypes.get_last_error())
            sink = int(sink)
            try:
                self._check(self.kernel.SetHandleInformation(w.HANDLE(sink), 1, 1))
                size = ctypes.c_size_t()
                self.kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
                attr = ctypes.create_string_buffer(size.value)
                self._check(self.kernel.InitializeProcThreadAttributeList(attr, 1, 0,
                                                                            ctypes.byref(size)))
                attr_initialized = True
                handles = (w.HANDLE * 2)(event, sink)
                self._check(self.kernel.UpdateProcThreadAttribute(
                    attr, 0, HANDLE_LIST, handles, ctypes.sizeof(handles), None, None))
                startup = StartupInfoEx()
                startup.StartupInfo.cb = ctypes.sizeof(startup)
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
                startup.StartupInfo.hStdInput = w.HANDLE(sink)
                startup.StartupInfo.hStdOutput = w.HANDLE(sink)
                startup.StartupInfo.hStdError = w.HANDLE(sink)
                startup.lpAttributeList = ctypes.cast(attr, ctypes.c_void_p)
                info = ProcessInfo()
                command = ctypes.create_unicode_buffer(subprocess.list2cmdline(
                    [sys.executable, str(host)]))
                self._check(self.advapi.CreateProcessAsUserW(
                    w.HANDLE(token), sys.executable, command, None, None, True,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                    EXTENDED_STARTUPINFO_PRESENT,
                    env, str(host.parent), ctypes.byref(startup), ctypes.byref(info)))
                process_handle = int(info.hProcess)
                thread_handle = int(info.hThread)
            finally:
                if attr_initialized:
                    self.kernel.DeleteProcThreadAttributeList(attr)
                self.kernel.CloseHandle(w.HANDLE(sink))
            self._check(self.kernel.AssignProcessToJobObject(w.HANDLE(job),
                                                              w.HANDLE(process_handle)))
            self._check(self.kernel.ResumeThread(w.HANDLE(thread_handle)) != 0xFFFFFFFF)
            self.kernel.CloseHandle(w.HANDLE(thread_handle))
            thread_handle = 0
            child = ServiceChild(self, int(info.dwProcessId), process_handle,
                                 job, event, token, profile_handle, profile_path)
            process_handle = job = event = token = profile_handle = 0
            return child
        except BaseException:
            if process_handle:
                self.kernel.TerminateProcess(w.HANDLE(process_handle), 1)
                self.kernel.WaitForSingleObject(w.HANDLE(process_handle), 10_000)
            raise
        finally:
            for handle in (thread_handle, process_handle, job, event):
                if handle:
                    self.kernel.CloseHandle(w.HANDLE(handle))
            if profile_handle:
                self.userenv.UnloadUserProfile(w.HANDLE(token), w.HANDLE(profile_handle))
            if token:
                self.kernel.CloseHandle(w.HANDLE(token))


def spawn_s4u_host(username: str, domain: str, operator_sid: str,
                   host: Path, bridge_secret: str) -> ServiceChild:
    token = S4UIdentity().logon(username, domain, operator_sid)
    return WindowsProcessAPI().spawn(token, username, host, bridge_secret)
