"""Admission and token lifetime for a genuine signed-in-user bridge.

The Windows adapter validates a real interactive logon before calling
``signed_in``. This module owns the race between sign-out and turn admission:
sign-out closes admission under the same lock used by ``begin_turn``. A token
already leased to a running turn stays open until that turn has stopped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import threading
from typing import Callable, Generic, TypeVar


Token = TypeVar("Token")


@dataclass(eq=False)
class _Session(Generic[Token]):
    session_id: int
    token: Token
    close: Callable[[Token], None]
    active: bool = True
    turns: set[str] = field(default_factory=set)
    closed: bool = False

    def release_if_idle(self) -> None:
        if not self.active and not self.turns and not self.closed:
            self.closed = True
            self.close(self.token)


class BridgeState(Generic[Token]):
    """Thread-safe, fail-closed admission for session-dependent turns.

    ``finish_turn`` must be called only after the corresponding process has
    exited or been terminated and reaped. The service holds the original
    session token while any admitted turn remains active, including after
    sign-out. The API deliberately does not expose an unleased token.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._current: _Session[Token] | None = None
        self._turns: dict[str, _Session[Token]] = {}

    def signed_in(self, session_id: int, token: Token,
                  close: Callable[[Token], None]) -> None:
        """Install a token validated by the Windows logon adapter.

        A replacement or reconnect retires the former token. Its existing
        turns continue to own it, but only the newly validated session can
        admit work. Every supplied token is either installed or closed.
        """
        if session_id <= 0:
            close(token)
            raise ValueError("a user bridge requires a nonzero session ID")
        with self._lock:
            previous = self._current
            self._current = _Session(session_id, token, close)
            if previous is not None:
                previous.active = False
                previous.release_if_idle()

    def signed_out(self, session_id: int) -> bool:
        """Stop new admissions for this session; retain active-turn leases."""
        with self._lock:
            current = self._current
            if current is None or current.session_id != session_id:
                return False
            self._current = None
            current.active = False
            current.release_if_idle()
            return True

    def begin_turn(self, turn_id: str) -> Token | None:
        """Reserve a token for a suspended candidate, or return None."""
        if not turn_id:
            raise ValueError("turn ID is required")
        with self._lock:
            if turn_id in self._turns:
                raise ValueError("turn already has a bridge lease")
            session = self._current
            if session is None or not session.active:
                return None
            session.turns.add(turn_id)
            self._turns[turn_id] = session
            return session.token

    def commit_turn(self, turn_id: str, resume: Callable[[], None]) -> bool:
        """Resume only if sign-out has not closed admission in the meantime.

        The callback must perform only the short ResumeThread operation. Its
        call is serialized with the SCM logoff callback. If this returns
        False, the caller must terminate/reap its suspended candidate and
        call ``finish_turn`` before returning to the engine.
        """
        with self._lock:
            session = self._turns.get(turn_id)
            if session is None or session is not self._current or not session.active:
                return False
            resume()
            return True

    def finish_turn(self, turn_id: str) -> bool:
        """Release after confirmed process exit; close an idle retired token."""
        with self._lock:
            session = self._turns.pop(turn_id, None)
            if session is None:
                return False
            session.turns.remove(turn_id)
            session.release_if_idle()
            return True

    def stop_admitting(self) -> None:
        """Service shutdown or bridge fault: no new turns may begin."""
        with self._lock:
            current = self._current
            self._current = None
            if current is not None:
                current.active = False
                current.release_if_idle()

    def status(self) -> dict[str, object]:
        with self._lock:
            current = self._current
            return {"bridge": "on" if current is not None else "off",
                    "sessionId": current.session_id if current is not None else None,
                    "activeTurns": len(self._turns)}
