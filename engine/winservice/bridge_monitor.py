"""Track the operator's real Windows logon for the credential bridge.

SCM logoff closes admission synchronously in its HandlerEx callback. This
worker retries genuine WTS token acquisition after logon and reconciles
missed notifications after service restart or a disconnected session.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import queue
import threading
from typing import Protocol

from .bridge_state import BridgeState
from .scm import ServiceContext, WTS_SESSION_LOGOFF, WTS_SESSION_LOGON
from .session_token import WindowsSessionTokens


class WtsSessionInfo(ctypes.Structure):
    _fields_ = [("SessionId", w.DWORD), ("pWinStationName", w.LPWSTR),
                ("State", ctypes.c_int)]


WTS_ACTIVE = 0
WTS_DISCONNECTED = 4


def signed_in_sessions(rows: list[WtsSessionInfo]) -> list[int]:
    """Prefer attached logons, then real disconnected logons awaiting return."""
    candidates = [row for row in rows if row.SessionId != 0 and
                  row.State in (WTS_ACTIVE, WTS_DISCONNECTED)]
    candidates.sort(key=lambda row: row.State != WTS_ACTIVE)
    return [int(row.SessionId) for row in candidates]


class SessionSource(Protocol):
    def active_sessions(self) -> list[int]: ...
    def query_verified(self, session_id: int, sid: str) -> int: ...
    def close(self, token: int) -> None: ...


class WindowsWtsSource(WindowsSessionTokens):
    def __init__(self) -> None:
        super().__init__()
        self.wts.WTSEnumerateSessionsW.argtypes = [w.HANDLE, w.DWORD, w.DWORD,
                                                    ctypes.POINTER(ctypes.POINTER(WtsSessionInfo)),
                                                    ctypes.POINTER(w.DWORD)]
        self.wts.WTSEnumerateSessionsW.restype = w.BOOL
        self.wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]

    def active_sessions(self) -> list[int]:
        rows = ctypes.POINTER(WtsSessionInfo)()
        count = w.DWORD()
        if not self.wts.WTSEnumerateSessionsW(None, 0, 1, ctypes.byref(rows),
                                               ctypes.byref(count)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return signed_in_sessions([rows[index] for index in range(count.value)])
        finally:
            if rows:
                self.wts.WTSFreeMemory(rows)


class BridgeMonitor:
    def __init__(self, sid: str, context: ServiceContext, state: BridgeState[int],
                 source: SessionSource, interval: float = 2.0):
        self.sid = sid
        self.context = context
        self.state = state
        self.source = source
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._revoked: set[int] = set()
        self.context.on_session_logoff = self._on_logoff

    def _on_logoff(self, session_id: int) -> None:
        # WTS enumeration can lag the SCM notification. Remember this session
        # as revoked until it disappears or a NEW logon notice supersedes it.
        with self._lock:
            self._revoked.add(session_id)
            self.state.signed_out(session_id)

    def reconcile(self) -> None:
        """Keep one currently active, verified operator session, or none."""
        sessions = self.source.active_sessions()
        with self._lock:
            self._revoked.intersection_update(sessions)
            sessions = [session for session in sessions if session not in self._revoked]
        current = self.state.status()["sessionId"]
        if sessions and current == sessions[0]:
            return
        if isinstance(current, int):
            self.state.signed_out(current)
        for session_id in sessions:
            try:
                token = self.source.query_verified(session_id, self.sid)
            except (OSError, PermissionError):
                continue  # foreign session or not yet ready; retry next scan
            self.state.signed_in(session_id, token, self.source.close)
            return

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                event, session_id = self.context.session_changes.get(timeout=self.interval)
            except queue.Empty:
                event = session_id = 0
            if event == WTS_SESSION_LOGOFF:
                self._on_logoff(session_id)
            elif event == WTS_SESSION_LOGON:
                with self._lock:
                    self._revoked.discard(session_id)
            # LOGON or a periodic scan: WTS can lag its notification, so a
            # failed query is revisited without inventing a synthetic logon.
            try:
                self.reconcile()
            except OSError:
                self.state.stop_admitting()

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("bridge monitor already started")
        self._thread = threading.Thread(target=self._run, name="orgtree-bridge-monitor",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.state.stop_admitting()
        if self._thread is not None:
            self._thread.join(timeout=self.interval + 5)
        self.context.on_session_logoff = None
