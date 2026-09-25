"""The fault kit: named faults a schedule can inject, built on the protocol's actions.

Executor-side faults are protocol HOLDS with a non-hold action (``protocol.ACTIONS``),
put in an ``Order``'s ``faults`` list; each names ONE (op_tag, point, attempt):

- ``sqlstate(tag, point, code)``: the next statement fails with ``code`` as if the
  server raised it (``fail_next``). ``SQLSTATES`` lists the codes the qualification
  schedules use and what the design says the executor must do with each;
- ``drop_conn(tag, point)``: the executor's socket is closed without COMMIT or
  ROLLBACK (``drop_conn``). At ``before_commit`` the server rolls back; the
  "connection dies DURING commit" case needs the commit to REACH the server, which
  a pause point cannot give, so it is ``kill`` after ``before_commit`` is released
  (see below) or WS2's own proxy test;
- ``sleep(tag, point, ms)``: a slow step (slow IO, PROFILING test 4).

Harness-side (M1 §3): ``kill_backend`` is never an executor action. A schedule's
script step ``("kill", tag)`` terminates the backend the tag's most recent
``arrived`` frame reported (``pg_terminate_backend``), so it always follows a
hold. The hold is in the executor, not the backend, so the script must still
RELEASE the operation: it then finds its connection gone (57P01, or a closed
socket) and the executor resolves or retries the attempt.

A fault never passes by being planned: the schedule's ``intended`` order must
still name what the fault is expected to CAUSE (``("sqlstate", tag, code)``, an
outcome, a retry arrival ``@2``), and the run is judged on what was observed.
"""
from __future__ import annotations

from typing import Any

from .protocol import SQLSTATE_RE

#: code -> (condition name, what the executor must do with it, per S3 §4/E4 and WS2's Outcome)
SQLSTATES: dict[str, tuple[str, str]] = {
    "40001": ("serialization_failure", "retry the whole attempt with the same key"),
    "40P01": ("deadlock_detected", "retry the whole attempt with the same key"),
    "23505": ("unique_violation", "retry only if the family allowlists the constraint, else error"),
    "55P03": ("lock_not_available", "lock_timeout: retry with backoff, bounded"),
    "57014": ("query_canceled", "statement_timeout: the attempt fails, no silent retry"),
    # a lost connection reaches the trace WITHOUT a SQLSTATE (measured live, fcb83e9:
    # tx_end rollback + retry "connection_lost", sqlstate "unknown"); schedules assert
    # the retry cause, not the code
    "57P01": ("admin_shutdown", "the connection is gone: resolve the attempt by its receipt"),
    "08006": ("connection_failure", "the connection is gone: resolve the attempt by its receipt"),
    "53300": ("too_many_connections", "admission failure before any statement: bounded retry"),
}


def _hold(tag: str, point: str, attempt: "int | None") -> dict[str, Any]:
    # "attempt": None is kept: ``schedule._plan_for`` reads it as EVERY attempt and
    # drops the key; a missing key would default to attempt 1
    return {"op_tag": tag, "point": point, "attempt": attempt}


def sqlstate(tag: str, point: str, code: str, attempt: "int | None" = 1) -> dict[str, Any]:
    """``fail_next`` with a known code. ``attempt=None`` fails EVERY attempt."""
    if not SQLSTATE_RE.match(code) or code not in SQLSTATES:
        raise ValueError(f"not a SQLSTATE this kit knows: {code!r} (see faults.SQLSTATES)")
    return {**_hold(tag, point, attempt), "action": "fail_next", "sqlstate": code}


def drop_conn(tag: str, point: str, attempt: "int | None" = 1) -> dict[str, Any]:
    return {**_hold(tag, point, attempt), "action": "drop_conn"}


def sleep(tag: str, point: str, ms: int, attempt: "int | None" = 1) -> dict[str, Any]:
    if not isinstance(ms, int) or ms <= 0:
        raise ValueError("sleep needs a positive integer ms")
    return {**_hold(tag, point, attempt), "action": "sleep", "ms": ms}


def expected(code: str) -> str:
    """What the design says the executor does with ``code`` (for reports)."""
    name, reaction = SQLSTATES[code]
    return f"{code} {name}: {reaction}"
