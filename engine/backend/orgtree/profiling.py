"""Where a request's time actually went, collected from where it is spent.

`AccessRecord` (api.py) already builds one profile dict per request and
`_access_emit` already publishes the allowlisted numbers from it. The read
routes fill that dict by hand: `_org_view` brackets its own three stages with
`time.perf_counter()` pairs, and `history_page` does the same for its lock
wait and document load. That pattern works and it is exact, but it only ever
covers the handler somebody remembered to bracket — which is why, a year after
the instrument was added, `/api/orgs/{slug}`, its node-detail sibling and the
history page were the only routes it could say anything about, and every write
the user actually complains about (answering a question, mail, hire, retire,
move, saving agent details) was invisible.

There are ~230 `with store.DOC_LOCK:` sites across eighteen modules and 96
write routes. Bracketing them one at a time is four `perf_counter` pairs per
handler, each of which is a place to be wrong, and none of which the NEXT
write route inherits. So the four stages a write is made of are measured once,
where they happen, instead:

    lock_wait_ms  `store.DOC_LOCK` (a `TimedRLock`), waiting to get in
    org_load_ms   `store.load_org`, parsing the document
    org_save_ms   `store.save_org`, writing it back
    mutate_ms     held the lock and was doing neither of those

`mutate_ms` is a subtraction, not a fifth measurement: time inside the lock
minus the load and save that happened inside it. That is exactly the number
the ticket asks for — an operator looking at a 4.9 s write can now see whether
it waited, parsed, worked or wrote, which are four different bugs with four
different fixes.

⚠ THIS MODULE IMPORTS NOTHING FROM orgtree. `store` imports it, and `store` is
imported by everything; an edge back into the package here is an import cycle
in the one module that cannot afford one.

CONTEXT PROPAGATION. The dict is reached through a `ContextVar`, bound by the
middleware, because `store.load_org` has no request to ask. Handlers are plain
`def` and run in the threadpool, and both starlette's `run_in_threadpool` and
anyio's `to_thread.run_sync` beneath it run the callable in a COPY of the
calling context — so the worker thread reads the same dict object the event
loop bound. Every writer here MUTATES that dict and never re-binds the var, so
nothing depends on the copy propagating changes back. A plain
`threading.Thread` (the supervisor's own workers) starts with an empty context
and therefore contributes nothing, which is correct: it is not serving a
request.

OFF IS THE NORMAL CASE. Capture is opt-in and off by default, exactly as it
was; with it off the var holds `None` and every entry point here is one
`ContextVar.get()` and a branch.
"""
from __future__ import annotations

import contextlib
import threading
import time
from contextvars import ContextVar, Token
from typing import Any, Generator

#: The profile dict `AccessRecord` made for the request being served on this
#: context — or None, which is both "capture is off" and "no request here".
_CURRENT: ContextVar["dict[str, Any] | None"] = ContextVar(
    "orgtree_profile_timing", default=None)

#: Stages whose accumulated total `TimedRLock` subtracts from its held time to
#: get `mutate_ms`. Named here, beside the two functions that write them, so
#: adding a third document-IO stage later cannot silently start counting as
#: mutation time.
_IO_FIELDS = ("org_load_ms", "org_save_ms")

#: One profile dict CAN have two writers. A managed tool call (`orgtree_hire`,
#: `orgtree_retire` — see `toolwait.invoke`) runs on its own thread and may
#: still be running when its request gives up waiting and answers
#: `state: running`. `_access_emit` then reads the dict while that worker is
#: still adding to it, and a NEW key arriving mid-iteration raises
#: `RuntimeError: dictionary changed size during iteration` — inside the one
#: `except Exception: pass` that exists so a log line can never fail a
#: request. The record would vanish without a trace, which is precisely the
#: failure this instrument was built to stop being possible. So every write
#: goes through `add` and every read through `snapshot`, both under this.
_MUTEX = threading.Lock()


def bind(profile: "dict[str, Any] | None") -> Token:
    """Attach `profile` to this context. Returns a token for `unbind`."""
    return _CURRENT.set(profile)


def unbind(token: Token) -> None:
    _CURRENT.reset(token)


def current() -> "dict[str, Any] | None":
    return _CURRENT.get()


def add(field: str, ms: float) -> None:
    """ACCUMULATE, never assign: a handler that loads twice under one lock has
    spent both loads, and a stage that overwrote itself would report the
    cheaper half of a double load as the whole cost."""
    profile = _CURRENT.get()
    if profile is None:
        return
    with _MUTEX:
        try:
            profile[field] = float(profile.get(field, 0.0)) + ms
        except (TypeError, ValueError):
            # A handler that already put something non-numeric under this name
            # keeps it, and `_access_emit`'s allowlist drops it. A timing
            # helper may never be the reason a request fails.
            pass


def label(field: str, value: str) -> None:
    """Record a NON-NUMERIC fact about this request. ASSIGNS, unlike `add`.

    The one caller is `/api/agent`, which is a single route serving every
    agent verb: without the verb, a hire, a retire and a watchdog are three
    identical `route: "/api/agent"` records and an operator who can see that
    something waited 4.9 s on the document lock cannot see WHICH tool did.

    ⚠ NOTHING IS VALIDATED HERE, and that is deliberate — this module knows
    nothing about tools and must keep importing nothing from `orgtree`. The
    value is checked against the tool catalogue in `api._access_emit`, at the
    boundary where it would be published, so a future caller writing
    arbitrary text under this field cannot leak it by going around a check
    that lived at the writing end instead of the reading end.

    Same mutex as `add`, for the same reason: a managed tool's worker thread
    can be writing this dict while `_access_emit` iterates it.
    """
    profile = _CURRENT.get()
    if profile is None:
        return
    with _MUTEX:
        profile[field] = value


def snapshot(profile: "dict[str, Any] | None") -> "dict[str, Any]":
    """A stable copy of `profile`, safe to iterate while a worker writes."""
    if not profile:
        return {}
    with _MUTEX:
        return dict(profile)


@contextlib.contextmanager
def stage(field: str) -> Generator[None]:
    """Time this block into `field`. A no-op when capture is off."""
    if _CURRENT.get() is None:
        yield
        return
    started = time.perf_counter()
    try:
        yield
    finally:
        add(field, (time.perf_counter() - started) * 1000.0)


@contextlib.contextmanager
def detached() -> Generator[None]:
    """Run without contributing to the current request's profile.

    For the one case where an OUTER caller already brackets this work under a
    different name: on the JSON backend `store.load_org_snapshot` delegates
    straight to `store.load_org`, and `_org_view` already reports that call as
    `load_snapshot_ms`. Without this, the same milliseconds would appear a
    second time as `org_load_ms` and an operator adding the stages up would
    conclude the route spent twice the IO it did.
    """
    token = _CURRENT.set(None)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def _io_total(profile: "dict[str, Any]") -> float:
    total = 0.0
    for field in _IO_FIELDS:
        try:
            total += float(profile.get(field, 0.0))
        except (TypeError, ValueError):
            pass
    return total


class TimedRLock:
    """A reentrant lock that reports its own wait and its own held time.

    Wraps rather than subclasses because `threading.RLock` is a factory for a
    C type, not a base class.

    ⚠ IT MUST STAY SUBSTITUTABLE FOR THE RLock IT REPLACES, and that is more
    than `acquire`/`release`/`with`:

      * `halt.py` builds `threading.Condition(store.DOC_LOCK)`. `Condition`
        borrows `_is_owned`, `_release_save` and `_acquire_restore` from the
        lock when it has them and falls back to LOCK-shaped defaults when it
        does not — and those defaults are wrong for a reentrant lock
        (`_is_owned` would answer False for a lock this very thread holds, so
        `wait()` would raise "cannot wait on un-acquired lock"). All three are
        forwarded.
      * tests call `DOC_LOCK._is_owned()` and `DOC_LOCK.acquire(blocking=False)`
        directly.

    DEPTH IS TRACKED UNCONDITIONALLY — not only while capture is on. The
    bookkeeping has to balance across an acquire and a release that might see
    different answers from `current()` (the live toggle flips a module flag,
    and a background thread shares this object with request threads). A depth
    counter that could be incremented but not decremented would stick above
    zero on a pooled worker thread and silently stop timing every later
    request it served — a green instrument reporting nothing, which is the one
    failure mode worth paying a branch to avoid.
    """

    __slots__ = ("_lock", "_held")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._held = threading.local()

    # ---------------------------------------------------------- acquisition
    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        profile = _CURRENT.get()
        started = time.perf_counter() if profile is not None else 0.0
        got = self._lock.acquire(blocking, timeout)
        if profile is not None:
            # Recorded on a FAILED acquire too: a `blocking=True, timeout=5`
            # that gives up waited five seconds, and a wait that ends in
            # nothing is the most interesting wait there is.
            waited = (time.perf_counter() - started) * 1000.0
            if getattr(self._held, "depth", 0) == 0:
                add("lock_wait_ms", waited)
        if not got:
            return False
        held = self._held
        depth = getattr(held, "depth", 0)
        held.depth = depth + 1
        if depth == 0:
            # Outermost entry opens the window `release` closes. A nested
            # acquire is free and holds no window of its own, or the same
            # milliseconds would be counted once per level.
            if profile is not None:
                held.since = time.perf_counter()
                held.io = _io_total(profile)
            else:
                held.since = None
        return True

    def release(self) -> None:
        held = self._held
        depth = getattr(held, "depth", 0) - 1
        held.depth = depth if depth > 0 else 0
        if depth <= 0 and getattr(held, "since", None) is not None:
            profile = _CURRENT.get()
            if profile is not None:
                inside = (time.perf_counter() - held.since) * 1000.0
                io = _io_total(profile) - float(getattr(held, "io", 0.0))
                # max(0.0, …): the two halves are measured by different
                # clocks-of-record (this one spans the lock, the IO stages sum
                # their own spans), so rounding can cross zero on a write
                # whose mutation is genuinely nothing. A negative millisecond
                # count would be a worse answer than zero.
                add("mutate_ms", max(0.0, inside - io))
            held.since = None
        self._lock.release()

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, *_exc: Any) -> bool:
        self.release()
        return False

    # ------------------------------------------------ threading.Condition
    # Forwarded to the real lock so `Condition` behaves exactly as it did.
    # `wait()` drops the lock ENTIRELY (every recursion level) and re-takes it
    # later, so the held window this object was tracking is over: it is closed
    # here and NOT reopened on restore. A condition wait therefore goes
    # untimed rather than reporting the time it spent asleep as mutation —
    # unmeasured is a correct answer, "your save took 20 seconds" is not.
    def _is_owned(self) -> bool:
        return self._lock._is_owned()            # type: ignore[attr-defined]

    def _release_save(self) -> Any:
        held = self._held
        held.depth = 0
        held.since = None
        return self._lock._release_save()        # type: ignore[attr-defined]

    def _acquire_restore(self, state: Any) -> None:
        self._lock._acquire_restore(state)       # type: ignore[attr-defined]
        held = self._held
        held.depth = 1
        held.since = None
