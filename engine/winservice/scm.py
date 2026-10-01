"""Service Control Manager plumbing: dispatcher, control handler, status.

Only the protocol lives here. What the service DOES is the ``body`` callable
that ``run`` hands a ``ServiceContext``; the body reads control requests from
``context.controls`` and reports progress through ``context.status``.

The Win32 surface is a small adapter (``_Win32``) so tests can drive the whole
protocol with a fake SCM and no service installed.
"""

from __future__ import annotations

import ctypes
import queue
import threading
from typing import Any, Callable

SERVICE_WIN32_OWN_PROCESS = 0x10

SERVICE_STOPPED = 1
SERVICE_START_PENDING = 2
SERVICE_STOP_PENDING = 3
SERVICE_RUNNING = 4

SERVICE_ACCEPT_STOP = 0x1
SERVICE_ACCEPT_PRESHUTDOWN = 0x100

SERVICE_CONTROL_STOP = 0x1
SERVICE_CONTROL_INTERROGATE = 0x4
SERVICE_CONTROL_PRESHUTDOWN = 0xF

NO_ERROR = 0
ERROR_CALL_NOT_IMPLEMENTED = 120
ERROR_SERVICE_SPECIFIC_ERROR = 1066
# StartServiceCtrlDispatcher from a process the SCM did not start.
ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063

# Controls the body receives. STOP covers both an operator stop and the
# preshutdown notification; the body treats them the same way.
STOP = "stop"
RESTART = "restart"


class ServiceStatus(ctypes.Structure):
    _fields_ = [("dwServiceType", ctypes.c_uint32),
                ("dwCurrentState", ctypes.c_uint32),
                ("dwControlsAccepted", ctypes.c_uint32),
                ("dwWin32ExitCode", ctypes.c_uint32),
                ("dwServiceSpecificExitCode", ctypes.c_uint32),
                ("dwCheckPoint", ctypes.c_uint32),
                ("dwWaitHint", ctypes.c_uint32)]


class StatusReporter:
    """Tracks the checkpoint rule: a pending state must advance dwCheckPoint on
    every report or the SCM treats the service as hung; any other state
    resets it to zero. Only RUNNING accepts controls."""

    def __init__(self, report: Callable[[ServiceStatus], None]):
        self._report = report
        self._checkpoint = 0
        self._lock = threading.Lock()
        self.last: ServiceStatus | None = None

    def _set(self, state: int, *, wait_hint_ms: int = 0, win32_exit: int = NO_ERROR,
             specific_exit: int = 0) -> ServiceStatus:
        with self._lock:
            pending = state in (SERVICE_START_PENDING, SERVICE_STOP_PENDING)
            self._checkpoint = self._checkpoint + 1 if pending else 0
            status = ServiceStatus(
                SERVICE_WIN32_OWN_PROCESS, state,
                (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_PRESHUTDOWN) if state == SERVICE_RUNNING else 0,
                win32_exit, specific_exit, self._checkpoint, wait_hint_ms if pending else 0)
            self.last = status
            self._report(status)
            return status

    def start_pending(self, wait_hint_ms: int = 10_000) -> ServiceStatus:
        return self._set(SERVICE_START_PENDING, wait_hint_ms=wait_hint_ms)

    def running(self) -> ServiceStatus:
        return self._set(SERVICE_RUNNING)

    def stop_pending(self, wait_hint_ms: int = 10_000) -> ServiceStatus:
        return self._set(SERVICE_STOP_PENDING, wait_hint_ms=wait_hint_ms)

    def stopped(self, specific_exit: int = 0) -> ServiceStatus:
        """A nonzero ``specific_exit`` is reported as a service-specific error,
        which the SCM logs and which counts as a failure for recovery."""
        if specific_exit:
            return self._set(SERVICE_STOPPED, win32_exit=ERROR_SERVICE_SPECIFIC_ERROR,
                             specific_exit=specific_exit)
        return self._set(SERVICE_STOPPED)


class ServiceContext:
    def __init__(self, status: StatusReporter):
        self.status = status
        self.controls: "queue.Queue[str]" = queue.Queue()


def handle_control(context: ServiceContext, control: int, restart_control: int) -> int:
    """The HandlerEx decision, separated from the callback so it is testable.
    It never blocks: the SCM calls it on the dispatcher thread."""
    if control in (SERVICE_CONTROL_STOP, SERVICE_CONTROL_PRESHUTDOWN):
        context.controls.put(STOP)
        return NO_ERROR
    if control == SERVICE_CONTROL_INTERROGATE:
        return NO_ERROR
    if control == restart_control:
        context.controls.put(RESTART)
        return NO_ERROR
    return ERROR_CALL_NOT_IMPLEMENTED


class _Win32:
    def __init__(self) -> None:
        from ctypes import wintypes as w
        self.w = w
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.HandlerEx = ctypes.WINFUNCTYPE(w.DWORD, w.DWORD, w.DWORD, ctypes.c_void_p, ctypes.c_void_p)
        self.ServiceMain = ctypes.WINFUNCTYPE(None, w.DWORD, ctypes.POINTER(w.LPWSTR))

        class TableEntry(ctypes.Structure):
            _fields_ = [("lpServiceName", w.LPWSTR), ("lpServiceProc", self.ServiceMain)]
        self.TableEntry = TableEntry
        advapi.StartServiceCtrlDispatcherW.argtypes = [ctypes.POINTER(TableEntry)]
        advapi.StartServiceCtrlDispatcherW.restype = w.BOOL
        advapi.RegisterServiceCtrlHandlerExW.argtypes = [w.LPCWSTR, self.HandlerEx, ctypes.c_void_p]
        advapi.RegisterServiceCtrlHandlerExW.restype = ctypes.c_void_p
        advapi.SetServiceStatus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ServiceStatus)]
        advapi.SetServiceStatus.restype = w.BOOL
        self.advapi = advapi

    def dispatch(self, name: str, service_main: Any) -> None:
        table = (self.TableEntry * 2)()
        table[0].lpServiceName = name
        table[0].lpServiceProc = service_main
        if not self.advapi.StartServiceCtrlDispatcherW(table):
            raise ctypes.WinError(ctypes.get_last_error())

    def register(self, name: str, handler: Any) -> Any:
        handle = self.advapi.RegisterServiceCtrlHandlerExW(name, handler, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def set_status(self, handle: Any, status: ServiceStatus) -> None:
        if not self.advapi.SetServiceStatus(handle, ctypes.byref(status)):
            raise ctypes.WinError(ctypes.get_last_error())


def run(name: str, body: Callable[[ServiceContext], int], *, restart_control: int,
        api: Any = None) -> None:
    """Connect to the SCM and run ``body`` as the service's ServiceMain.

    ``body`` returns the service-specific exit code (0 = clean stop) and must
    not report STOPPED itself; ``run`` does that last, after which the SCM may
    end the process. Raises OSError(1063) when not started by the SCM.
    """
    api = api or _Win32()
    kept: list[Any] = []  # the SCM holds raw pointers to both callbacks

    def service_main(_argc: int, _argv: Any) -> None:
        # The context exists before the handler is registered, so a control
        # that arrives at once always has a queue to land in.
        handle: list[Any] = []
        context = ServiceContext(StatusReporter(lambda status: api.set_status(handle[0], status)))

        def handler(control: int, _event: int, _data: Any, _context: Any) -> int:
            return handle_control(context, control, restart_control)

        handler_ref = api.HandlerEx(handler)
        kept.append(handler_ref)
        handle.append(api.register(name, handler_ref))
        reporter = context.status
        reporter.start_pending()
        code = 0
        try:
            code = int(body(context) or 0)
        except BaseException:  # the SCM must still hear STOPPED
            code = code or 0xFFFF
            raise
        finally:
            reporter.stopped(code)

    main_ref = api.ServiceMain(service_main)
    kept.append(main_ref)
    api.dispatch(name, main_ref)
