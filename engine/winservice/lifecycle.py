"""Supervise the boot host under the service: restart, crash budget, stop.

Identity-free on purpose: how the host process is created (which account,
which token, which job) is the ``spawn`` callable's business. This module
only decides WHEN to start, restart and stop it, and it guarantees one rule
the whole service rests on: a new host is never started until the previous
host's entire process tree is confirmed gone, so there are never two engines.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import queue
import time
from typing import Callable, Protocol

from . import EXIT_CRASH_BUDGET, EXIT_SPAWN
from .scm import RESTART, STOP, ServiceContext

# service_host.py's exit code when another engine owns the data root (for
# example the desktop's own engine during a handover). It is retried, but it
# is not a crash and never spends the crash budget.
EXIT_ROOT_OWNED = 75


class Child(Protocol):
    pid: int

    def wait(self, timeout: float) -> int | None:
        """Exit code once the host process has exited, else None."""

    def request_stop(self) -> None:
        """Ask the host for an orderly engine shutdown (its stop event)."""

    def terminate(self, code: int) -> None:
        """Kill everything still in the host's job."""

    def wait_empty(self, timeout: float) -> bool:
        """True once no process remains in the host's job."""

    def close(self) -> None:
        ...


@dataclass(frozen=True)
class Policy:
    backoff: tuple[float, ...] = (1.0, 5.0, 30.0)
    budget: int = 5             # failures allowed inside `window` ...
    window: float = 600.0       # ... before the service stops with an error
    healthy_after: float = 60.0  # a run this long resets the backoff ladder
    stop_grace: float = 25.0    # orderly shutdown before the job is killed
    empty_timeout: float = 10.0  # Windows finishing a job termination
    status_every: float = 2.0   # STOP_PENDING checkpoint cadence
    poll: float = 0.25


class TreeNotReleased(RuntimeError):
    """The previous host's job still has processes; starting another host
    could make two engines, so the service stops instead."""


def _retire(child: Child, policy: Policy, code: int) -> None:
    """Kill what is left of a host tree and PROVE it is gone."""
    try:
        child.terminate(code)
        if not child.wait_empty(policy.empty_timeout):
            raise TreeNotReleased(f"host {child.pid} tree did not empty after termination")
    finally:
        child.close()


def _stop(context: ServiceContext, child: Child, policy: Policy, *, report: bool,
          clock: Callable[[], float]) -> None:
    hint = int((policy.stop_grace + policy.empty_timeout) * 1000)
    if report:
        context.status.stop_pending(hint)
    child.request_stop()
    deadline = clock() + policy.stop_grace
    next_report = clock() + policy.status_every
    while child.wait(policy.poll) is None and clock() < deadline:
        if report and clock() >= next_report:
            context.status.stop_pending(hint)
            next_report = clock() + policy.status_every
    if report:
        context.status.stop_pending(hint)
    # An orderly exit still leaves the job to be confirmed empty, and a host
    # that ignored the request is killed here with its whole tree.
    _retire(child, policy, 0)


def _take_control(controls: "queue.Queue[str]", timeout: float) -> str | None:
    try:
        return controls.get(timeout=timeout) if timeout > 0 else controls.get_nowait()
    except queue.Empty:
        return None


def supervise(context: ServiceContext, spawn: Callable[[], Child], policy: Policy = Policy(), *,
              clock: Callable[[], float] = time.monotonic,
              log: Callable[[str], None] = lambda _message: None) -> int:
    """Run until STOP or an unrecoverable fault; return the service-specific
    exit code (0 for an orderly stop). Reports RUNNING after the first host
    starts. STOP is honoured during every wait, including restart delays."""
    failures: deque[float] = deque()
    ladder = 0
    running_reported = False
    while True:
        try:
            child = spawn()
        except OSError as exc:
            log(f"service: could not start the boot host: {exc}")
            return EXIT_SPAWN
        started = clock()
        log(f"service: boot host started (pid {child.pid})")
        if not running_reported:
            context.status.running()
            running_reported = True

        code: int | None = None
        while code is None:
            control = _take_control(context.controls, 0)
            if control == STOP:
                try:
                    _stop(context, child, policy, report=True, clock=clock)
                except TreeNotReleased as exc:
                    log(f"service: {exc}")
                    return EXIT_SPAWN
                log("service: stopped on request")
                return 0
            if control == RESTART:
                log("service: engine restart requested")
                try:
                    _stop(context, child, policy, report=False, clock=clock)
                except TreeNotReleased as exc:
                    log(f"service: {exc}")
                    return EXIT_SPAWN
                ladder = 0
                break
            code = child.wait(policy.poll)
        if code is None:
            continue  # restarted on request: no delay, no failure counted

        # The host exited on its own. Its tree must be gone before anything
        # else starts, whatever the reason.
        try:
            _retire(child, policy, 1)
        except TreeNotReleased as exc:
            log(f"service: {exc}")
            return EXIT_SPAWN
        now = clock()
        if now - started >= policy.healthy_after:
            ladder = 0
        if code == EXIT_ROOT_OWNED:
            log("service: another engine owns the data root; retrying")
        elif code == 0:
            log("service: engine shut itself down; restarting")
        else:
            failures.append(now)
            while failures and now - failures[0] > policy.window:
                failures.popleft()
            log(f"service: boot host exited with {code} ({len(failures)} failure(s) in the window)")
            if len(failures) >= policy.budget:
                return EXIT_CRASH_BUDGET
        delay = policy.backoff[min(ladder, len(policy.backoff) - 1)]
        ladder += 1
        if _take_control(context.controls, delay) == STOP:
            log("service: stopped on request")
            return 0
