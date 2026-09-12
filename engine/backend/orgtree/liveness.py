# pyright: strict
"""Process liveness as ALIVE / DEAD / UNKNOWN, with the reason that produced it.

⚠ WHY THIS IS NOT A BOOLEAN. "Could not confirm alive" and "confirmed gone"
are different facts, and every boolean probe in this codebase has had to pick
one of them to mean False. `_wd_proc_alive` picked "gone": on Windows
`OpenProcess` returns 0 for a nonexistent pid AND for one this account may not
open, and the watchdog turned both into `(pid:N is DOWN)` and a DOWN edge — an
announced death that never happened. On a remote-control session that
announcement is what authorizes tearing down a live driver (statereview-04,
2026-09-12).

So an observation carries the REASON it reached its answer, and the answer is
derived from the reason rather than asserted beside it. Uncertainty has
exactly one destination — `unknown` — and `unknown` is not `dead`, which is
the only state that may ever authorize a destructive recovery.

⚠ THE ALREADY-CORRECT GUARD IS NOT REIMPLEMENTED HERE. `supervisor.
_pid_provably_dead` already makes this distinction for the remote-control
detach, and the suggestion manifest's own note says to expose the tri-state
elsewhere rather than touch it. This module is that elsewhere. The two agree
by construction — `dead(observe(f"pid:{n}"))` and `_pid_provably_dead(n)` ask
the same question of the same API — but the guard keeps its own copy, because
a recovery path that reaches through a formatting module for permission is a
worse design than one duplicated line.

⚠ "NOTHING HAS LOOKED" AND "LOOKED AND FOUND NOTHING" ARE DIFFERENT ANSWERS,
and this codebase has collapsed them on every surface where it could. On the
usage side that is `capability.UNOBSERVED`, and its rule is that an
unobserved window never renders as a confident 0% — because a reader who
sees 0% acts on it. Here the same rule wears process clothes: a target that
could not be looked at never renders as DOWN. One discipline, two surfaces;
the vocabularies differ because the subjects do, and `observed_at`, the
closed-vocabulary normalisation and the refusal to publish a misattributed
record are all taken from `capability.py` rather than reinvented. A reader
arriving at either module should find the other.

⚠ AN OBSERVATION IS NEVER REUSED ACROSS CHECKS. A pid is a reusable handle:
the number that named a dead process is handed to an unrelated new one soon
enough that a stored record can end up describing a process that was never
observed — `capability`'s "straddled a CLI upgrade" hazard with a different
subject. So every caller re-probes, `observed_at` dates the probe rather
than the formatting, and a stored record (`high_water["observed"]`) is
PROVENANCE for a reader — what the last check saw and why — never an input
to the next decision. No record at all beats a misattributed one.
"""
from __future__ import annotations

import datetime as _dt
import os
import re
import socket
from collections.abc import Mapping
from typing import Any, Final

#: The three answers. `unknown` is a first-class result, never a failure to
#: produce one — a caller that cannot handle it is a caller that was about to
#: guess.
STATES: Final = ("alive", "dead", "unknown")

#: Why the probe answered as it did. Closed, like `capability.BASES`: an
#: unrecognised reason normalises rather than passing through, and it
#: normalises to the cautious state rather than a confident one.
#:
#:   still-active      the OS reports the process running
#:   listening         a loopback connect completed
#:   exited            the process exists as a handle and carries an exit code
#:   no-such-process   the OS gave the specific "no such pid" signal
#:   refused           the port actively refused — nothing is listening there
#:   access-denied     it EXISTS but may not be opened; alive or uncertain
#:   unreachable       a connect that neither completed nor was refused
#:   malformed-target  not a `pid:N` or `port:N` target at all
#:   probe-error       the probe raised something this module will not classify
REASONS: Final = ("still-active", "listening", "exited", "no-such-process",
                  "refused", "access-denied", "unreachable",
                  "malformed-target", "probe-error")

#: The whole judgement, in one table. Read it as the answer to "may this
#: reason authorize a recovery?" — only the three `dead` rows may.
_STATE_OF: Final[dict[str, str]] = {
    "still-active": "alive",
    "listening": "alive",
    "exited": "dead",
    "no-such-process": "dead",
    "refused": "dead",
    "access-denied": "unknown",
    "unreachable": "unknown",
    "malformed-target": "unknown",
    "probe-error": "unknown",
}

_TARGET_RE: Final = re.compile(r"(pid|port):(\d+)")

#: Windows error codes, named because the numbers are the entire distinction.
_ERROR_INVALID_PARAMETER: Final = 87     # no such pid — decisively gone
_ERROR_ACCESS_DENIED: Final = 5          # it exists; we may not look
_STILL_ACTIVE: Final = 259


def state_of(reason: object) -> str:
    """The state a reason implies. Unrecognised reasons are `unknown`."""
    return _STATE_OF.get(str(reason), "unknown")


def _iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    try:
        value = float(epoch)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    try:
        return (_dt.datetime.fromtimestamp(value, tz=_dt.timezone.utc)
                .isoformat().replace("+00:00", "Z"))
    except (OverflowError, OSError, ValueError):
        return None


def record(*, target: str, reason: object,
           observed_at: float | None = None) -> dict[str, Any]:
    """One liveness observation: `{target, state, reason, observed_at}`.

    The state is DERIVED from the reason and cannot be passed in, so no caller
    can record "dead" alongside a reason that does not support it — the defect
    this module exists to make unrepresentable.

    ⚠ `observed_at` IS THE INSTANT THE EVIDENCE WAS OBSERVED, not the instant
    this record was formatted, and it is `None` when the caller cannot say.
    Taken from `capability.observation`, for its reason: a record built from
    something another surface saw earlier is not a fresh observation, and
    stamping it `now` dates the formatting while reading as the measurement.

    ⚠ NOTHING ELSE GOES IN. A target and a closed-vocabulary reason, and no
    slot a prompt, a path or a credential could be written into — these
    records ride the same receipts as the turn record, which promises the
    same thing.
    """
    known = str(reason) if str(reason) in REASONS else "probe-error"
    return {"target": str(target or ""),
            "state": _STATE_OF[known],
            "reason": known,
            "observed_at": _iso(observed_at)}


def alive(observation: Mapping[str, Any] | None) -> bool:
    """A POSITIVE observation of life. `unknown` is not alive — but see
    `dead`: it is not dead either, and only one of those may act."""
    return isinstance(observation, Mapping) and observation.get("state") == "alive"


def dead(observation: Mapping[str, Any] | None) -> bool:
    """PROVABLY gone. The only state that may authorize a destructive
    recovery, and the reason this module is not a boolean."""
    return isinstance(observation, Mapping) and observation.get("state") == "dead"


def _observe_pid(pid: int) -> str:
    """The reason a pid probe reaches. Never raises."""
    if pid <= 0:
        return "malformed-target"
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.windll.kernel32                    # type: ignore[attr-defined]
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = k32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                err = k32.GetLastError()
                if err == _ERROR_INVALID_PARAMETER:
                    return "no-such-process"
                if err == _ERROR_ACCESS_DENIED:
                    # ⚠ IT EXISTS. This is the case the boolean probe called
                    # DOWN, and the one that detached live user sessions.
                    return "access-denied"
                return "probe-error"
            try:
                code = wintypes.DWORD()
                if k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return ("still-active" if code.value == _STILL_ACTIVE
                            else "exited")
                return "probe-error"
            finally:
                k32.CloseHandle(handle)
        except Exception:                                   # noqa: BLE001
            return "probe-error"
    try:
        os.kill(pid, 0)
        return "still-active"
    except ProcessLookupError:
        return "no-such-process"
    except PermissionError:
        return "access-denied"                              # exists, not ours
    except OSError:
        return "probe-error"
    except Exception:                                       # noqa: BLE001
        # `\d+` admits a number no pid can be, and `os.kill` answers that with
        # OverflowError rather than an OSError. Not a process fact either way.
        return "probe-error"


def _observe_port(port: int, timeout: float) -> str:
    """The reason a loopback probe reaches. Never raises.

    ⚠ REFUSED AND TIMED OUT ARE NOT THE SAME ANSWER. A refusal is the kernel
    saying nothing is listening — evidence. A timeout is a firewall, a
    saturated backlog or a host too busy to answer, and reading it as "down"
    is how a healthy service gets declared dead.
    """
    if port <= 0 or port > 65535:
        return "malformed-target"
    # ⚠ OPENING THE SOCKET IS ITSELF A PROBE THAT CAN FAIL, and its failure is
    # about THIS machine, not about the target. Descriptor exhaustion is the
    # realistic case and it arrives as an OSError indistinguishable in type
    # from a connection error — so it is caught HERE, where it can only mean
    # "the probe could not run", rather than downstream where it would be
    # read as evidence the port is unreachable. There is no socket to close
    # on this path.
    try:
        sock = socket.socket()
    except Exception:                                       # noqa: BLE001
        return "probe-error"
    try:
        sock.settimeout(timeout)                # ValueError on a bad timeout
        sock.connect(("127.0.0.1", port))
        return "listening"
    except ConnectionRefusedError:
        return "refused"
    except socket.timeout:
        return "unreachable"
    except OSError as e:
        # ECONNREFUSED can arrive as a plain OSError on some stacks; anything
        # else is a probe that did not get an answer, not an answer.
        return "refused" if e.errno == 111 else "unreachable"
    except Exception:                                       # noqa: BLE001
        return "probe-error"
    finally:
        try:
            sock.close()
        except Exception:                                   # noqa: BLE001
            pass                       # a close that fails is not an answer


def observe(target: str, *, timeout: float = 2.0,
            observed_at: float | None = None) -> dict[str, Any]:
    """Probe one `pid:N` or `port:N` target and record what it answered.

    Fail-closed toward uncertainty: every path that does not reach a definite
    signal lands on a reason whose state is `unknown`.

    ⚠ THIS NEVER RAISES, AND THAT IS STRUCTURAL RATHER THAN ENUMERATED. The
    probes below already classify what they expect, but a caller is the
    watchdog poll loop, and the moment this most wants to be robust —
    descriptor exhaustion, a machine under real stress — is exactly when an
    unforeseen exception is most likely. An escape there would stop the loop
    that exists to notice trouble, so the outer guard stands whether or not
    the inner ones are complete: an unclassifiable failure is `unknown`,
    which is the same answer this module gives every other thing it cannot
    determine (review finding, worktree-safe, 2026-09-12).
    """
    text = str(target or "")
    try:
        match = _TARGET_RE.fullmatch(text)
        if not match:
            return record(target=text, reason="malformed-target",
                          observed_at=observed_at)
        number = int(match.group(2))
        reason = (_observe_port(number, timeout) if match.group(1) == "port"
                  else _observe_pid(number))
    except Exception:                                       # noqa: BLE001
        reason = "probe-error"
    return record(target=text, reason=reason, observed_at=observed_at)
