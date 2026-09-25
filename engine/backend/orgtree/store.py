# pyright: strict
"""Multi-org persistence (№36). One document per org under the DATA root — a JSON
file (`ORGTREE_STORE=json`, the historical format) or a SQLite database
(`ORGTREE_STORE=sqlite`, SQLITE-SPEC Phase 1, 2026-09-03).

Data root is ~/orgtree (NOT ~/.claude — spike finding 4, and node scratch dirs live
beside the ledger data).

⚠ SPIKE FINDING 4, RESTATED 2026-08-07 (six measurements against the pinned CLI, after
it misled a diagnosis): the file tools do not "refuse" a ~/.claude path — they raise a
PERMISSION REQUEST ("… which is a sensitive file"). An interactive seat can answer it;
a HEADLESS turn has no approver, so it surfaces as a refusal. The distinction matters
because the gate is not a classifier you can satisfy: an Edit(//path/**) allow rule, an
explicit --add-dir on the path, --permission-mode dontAsk, and a PreToolUse hook
returning permissionDecision=allow were each measured and each still refused. The gate
sits ABOVE the allow-rule, add-dir and hook layers. Only --permission-mode
bypassPermissions clears it, and that bypasses every other check too (user ruling
2026-08-07: agents that want to write the global skills run bypassPermissions; nothing
is plumbed over the file tools to fake it).

Layout:

    ~/orgtree/
      orgs/<slug>.json                the ledger documents      (ORGTREE_STORE=json)
      orgs/<slug>.db                  the ledger databases      (ORGTREE_STORE=sqlite)
      orgs/<slug>.json.premigration   the JSON doc as it was the moment it was
                                      migrated — NEVER deleted by code (§6.1/§6.4)
      scratch/<slug>/<node>/          node working dirs (flat per §7.6; made by the
                                      supervisor)

JSON writes are atomic (tmp + os.replace). SQLite writes are one transaction per
`save_org` (`BEGIN IMMEDIATE` … `COMMIT`, WAL, `synchronous=FULL`).

THE SEAM (SQLITE-SPEC §4). `ledger.Org` is 8,000+ lines operating on `Org.d` as a
plain dict, so the whole storage change lives behind `load_org` / `save_org`:

  * `load_org` returns an `Org` whose `.d` is a `LazyDoc` — a real `dict` holding
    every small section and `nodes` eagerly; the heavy append-only logs
    (`mail_log`, `steered_log`, `turn_error_log`, `events`, `org_inbox`,
    `notice_log`, `user_mail_log`, `user_outbox`) are ABSENT until first touched
    and then materialise from their row tables. 75 % of reads never touch one.
  * `save_org` is compare-on-save: every small section and every node is
    re-serialised and written only if it differs from what was loaded. Loaded
    log rows keep their SQLite `seq` identity, so append/update/delete writes
    only the proven rows; an unprovable reorder or replacement falls back to
    replacing that owner/section. Dict logs are lazy per owner.
  * Nothing outside this module changed for it. `Org.d` still behaves as a dict
    (see `LazyDoc` for the four `dict`-subclass hazards and how they are met).

MIGRATION IS AN OPERATOR ACTION, NEVER AN INFERENCE (2026-09-03). Converting a
root's `<slug>.json` files to `<slug>.db` rewrites the data root, so no process
does it on its own authority. Under `ORGTREE_STORE=sqlite`:

  * `claim_data_root()` (the backend's first act) looks for unmigrated JSON
    BEFORE it touches anything. Found some and `ORGTREE_MIGRATE=1` is not in
    the environment → `MigrationRefused`, the process does not start, and the
    message says exactly why and what to set. Nothing is written — not even
    the `.owner` claim. This is the loudest thing in the file, deliberately:
    a quiet fallback here would look exactly like an empty org.
  * With `ORGTREE_MIGRATE=1` the migration runs after the claim and before the
    API binds (§6.2's ordering is kept; only the trigger changed).
  * A `.json` that appears LATER under a backend that already owns the root
    (a hand restore from a `.premigration` copy) is still migrated on demand —
    that process passed the gate at startup. A process that never claimed the
    root (a script, a test) gets the same refusal from `load_org`.

Why: the evening the default flipped, a test runner that strips `ORGTREE_*`
from its children ran a sqlite build against `~/orgtree` — the live root — and
`claim_data_root()` migrated production as a side effect. The verifier and the
`.premigration` files made it a five-minute rollback; the trigger was the bug.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Generator, Iterable, Iterator
from typing import Any, cast

from . import census_contacts
from . import devguard
from . import profiling
from . import stateprobe
from .stateprobe import SaveChanges

# Fail before importing ledger or creating/opening any storage.
devguard.validate_root(os.environ.get("ORGTREE_DATA", os.path.expanduser("~/orgtree")))

from .ledger import LedgerError, Org, slugify
from .ledger import now as _ledger_now
from .schema import OrgDoc

DATA_ROOT: str = os.environ.get("ORGTREE_DATA", os.path.expanduser("~/orgtree"))

# Which on-disk format this process reads and writes. `json` is the historical
# one-file-per-org document; `sqlite` is SQLITE-SPEC §3. Resolved ONCE at import
# like DATA_ROOT (tests set the environment before importing).
#
# The default was `json` until the migration had been verified against a copy of
# the live data root (§6.1 steps 4–5). It has been: every org on a copy of the
# real root migrated, exported and re-imported, with each `.json.premigration`
# byte-identical to its source by sha256 — including the 12.7 MB, 205-node
# document this install actually runs on. See docs/sqlite-cutover.md for the
# numbers, the operator procedure, and the rollback.
#
# ⚠ FLIPPING THIS LITERAL DOES NOT MIGRATE ANYTHING. A root still holding
# `.json` documents will REFUSE to start (`MigrationRefused`) until an operator
# migrates it offline, and a JSON build pointed at a migrated root will refuse
# too (`BackendMismatch`). One active format per root, enforced both ways.
STORE_BACKEND: str = os.environ.get("ORGTREE_STORE", "sqlite").strip().lower() or "sqlite"
if STORE_BACKEND not in ("json", "sqlite", "postgres"):
    raise ValueError(f"ORGTREE_STORE must be 'json', 'sqlite' or 'postgres', "
                     f"not {STORE_BACKEND!r}")
# PG-0: `postgres` is the SQLite row backend (the same lazy load, differ and
# compare-on-save) run through `pgstore.PgConn` against PostgreSQL. row_store()
# names the code paths the two share; a site that still tests `== "sqlite"`
# is a SQLite-only fast path whose fallback serves postgres.
#
# Both are FUNCTIONS, read at call time, because tests patch STORE_BACKEND
# on the module at runtime (e.g. test_write_route_timing pins 'json').
def row_store() -> bool:
    return STORE_BACKEND in ("sqlite", "postgres")


def db_ext() -> str:
    """The per-org file under orgs/: the SQLite database, or PostgreSQL's
    marker."""
    return ".pg" if STORE_BACKEND == "postgres" else ".db"
# The census's contact evidence says which store an attempt ran against, so
# that zero SQLite contacts under the JSON backend cannot read as "touched
# nothing" (`census_contacts.Tally`).
census_contacts.set_primary_store(STORE_BACKEND)

# The operator's opt-in for JSON→SQLite migration of THIS process's data root.
# Read at call time, not import time, on purpose: the value is checked at the
# moments a migration could start, and a test can set it for one call. Exactly
# "1" — the refusal message names that value, and "true"/"yes" being silently
# ignored is worse than being asked to type the one string that works.
MIGRATE_ENV = "ORGTREE_MIGRATE"

# Set once `claim_data_root()` has claimed DATA_ROOT under the sqlite backend.
# From then on this process OWNS the root and a `.json` that appears under it
# later (a hand restore) may be migrated on demand without the opt-in — see
# `_migration_allowed`.
_gate_passed: bool = False


def migration_authorised() -> bool:
    """`ORGTREE_MIGRATE=1` in this process's environment right now."""
    return os.environ.get(MIGRATE_ENV, "").strip() == "1"


def _migration_allowed() -> bool:
    """May THIS process convert a `.json` it finds? Yes if the operator opted
    in, or if it is the backend that claimed this root at startup (so the
    file is a later arrival under a root it legitimately owns). A process
    that merely happens to be pointed at a root — a script, a test — is
    neither."""
    return migration_authorised() or _gate_passed

# Coarse per-process guard around load-modify-save cycles: API ops and the
# supervisor's notice drain both rewrite org docs; without this a stale copy
# could resurrect just-delivered notices (double delivery).
#
# Since Phase 0 of the state-access rearchitecture this is an instrumented
# wrapper around the same RLock semantics: wait-for and held durations are
# recorded per operation label (stateprobe), because the wait behind this one
# global lock is the single number that decides where parallelization
# matters — and per REQUEST it keeps `profiling.TimedRLock`'s reporting
# (lock_wait_ms / mutate_ms), composed at the end of this branch. Semantics
# are unchanged — reentrant, and `threading.Condition` interoperates
# (halt.py builds one on it): the Condition protocol methods delegate to the
# inner RLock, and a `Condition.wait` correctly SUSPENDS the held-time clock
# across the release/re-acquire so a worker parked on the condition does not
# read as a multi-second lock hold.
class _InstrumentedDocLock(profiling.TimedRLock):
    """`profiling.TimedRLock` (per-REQUEST lock_wait_ms / mutate_ms, the
    Condition protocol, the substitutability contract its own docstring
    pins) composed with the rearchitecture's additions: FIFO admission,
    per-OPERATION wait/held aggregates (stateprobe), and the resident
    release hook that enforces the discard property for every write cycle
    at the one place all of them pass through. Subclassed rather than
    re-implemented so test_write_route_timing's pins hold for the object
    actually installed.

    ⚠ FIFO IS A CORRECTNESS PROPERTY HERE, measured the hard way (incident
    2026-09-19: a single message send waited 28 s while seventeen
    tight-loop writers each re-acquired the lock the instant they released
    it — a bare RLock hands the lock back to the releasing thread before a
    sleeping waiter can wake, so a NEW arrival starves exactly when the
    system is busiest, which the user experiences as "one message will not
    send"). The admission gate below grants strictly in arrival order: the
    inner RLock is only ever acquired by the thread the gate has admitted,
    so it never contends and inherits the gate's fairness.

    Held-time accounting across `Condition.wait` follows the parent's rule:
    the wait ends the hold window for both reporters (asleep is not held),
    and the restore opens a fresh one — and re-queues at the TAIL, fairly."""

    __slots__ = ("_tls", "_gate", "_queue", "_owner", "_seq")

    def __init__(self) -> None:
        super().__init__()
        self._tls = threading.local()
        self._gate = threading.Condition(threading.Lock())
        self._queue: list[int] = []
        self._owner: int | None = None
        self._seq = 0

    # --------------------------------------------------- FIFO admission
    def _admit(self, blocking: bool, timeout: float) -> "tuple[bool, int]":
        """Admit this thread, and report HOW MANY WERE IN FRONT of it.

        ⚠ THE GATE IS THE ONLY PLACE THAT CAN TELL CONTENTION FROM OVERHEAD.
        It admits in strict arrival order and the inner RLock is only ever
        taken by the thread the gate already admitted, so the inner lock never
        contends — which means the wall time the parent class measures around
        an acquire includes the uncontended cost of taking a free lock. A
        positive `lock_wait_ms` is therefore NOT evidence that anyone waited
        behind anyone, and no reader downstream can recover the difference.
        Here it is exact: the count below is the owner (if any) plus everyone
        already queued, sampled the instant this thread arrived.

        Returned rather than recorded in place, deliberately. Recording means
        `profiling`'s mutex, and taking it inside `self._gate` would lengthen
        the admission critical section every other arrival waits behind — the
        measurement would alter the thing measured. The caller records it one
        statement later, outside the gate.

        `-1` means "no observation": the reentrant path, where this thread is
        already the owner and nothing was ever in front of it.
        """
        me = threading.get_ident()
        # PG-0b (plan decision 26 D1): with the org_tx test hooks on, taking
        # DOC_LOCK for the FIRST time while this thread holds org_tx row
        # locks is the door deadlock's shape (row locks -> DOC_LOCK against
        # the fence's DOC_LOCK -> row locks). A re-entrant acquire is fine.
        if (self._owner != me and getattr(_orgtx_local, "rowlock_depth", 0)
                and os.environ.get("ORGTREE_ORGTX_TEST_HOOKS", "") == "1"):
            raise AssertionError("DOC_LOCK first acquired while holding org_tx row "
                                 "locks: lock-order inversion (take DOC_LOCK before "
                                 "the org_tx, or keep the transition fence on)")
        with self._gate:
            if self._owner == me:
                return True, -1                  # reentrant: already admitted
            ahead = (1 if self._owner is not None else 0) + len(self._queue)
            if not blocking:
                if not ahead:
                    self._owner = me
                    return True, 0
                return False, ahead
            self._seq += 1
            ticket = self._seq
            self._queue.append(ticket)
            deadline = (time.monotonic() + timeout) if timeout and timeout > 0 else None
            while self._owner is not None or self._queue[0] != ticket:
                rest = None if deadline is None else deadline - time.monotonic()
                if rest is not None and rest <= 0:
                    self._queue.remove(ticket)
                    self._gate.notify_all()
                    return False, ahead
                self._gate.wait(rest)
            self._queue.pop(0)
            self._owner = me
            return True, ahead

    def _yield_gate(self) -> None:
        with self._gate:
            self._owner = None
            self._gate.notify_all()

    def _note_arrival(self, ahead: int) -> None:
        """Record what `_admit` saw, now that the gate is released.

        `ahead` is holders-plus-waiters in front of this arrival, or -1 for a
        reentrant acquire that never queued. Zero is the interesting negative
        case and is recorded as nothing: a collision counter that ticked on an
        idle lock would be the very error this pair exists to prevent, so
        `lock_contended` counts arrivals that genuinely found somebody there,
        and `lock_queue_ahead_max` says how deep the queue in front was — one
        rival and the seventeen tight-loop writers of the 2026-09-19 starvation
        incident are both "contended" and are not the same event.
        """
        if ahead > 0:
            profiling.add("lock_contended", 1.0)
            profiling.high_water("lock_queue_ahead_max", float(ahead))

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        outer = getattr(self._held, "depth", 0) == 0
        t0 = time.perf_counter() if outer else 0.0
        admitted, ahead = self._admit(blocking, timeout)
        if outer:
            self._note_arrival(ahead)
        if not admitted:
            if outer:
                waited = (time.perf_counter() - t0) * 1000.0
                # a failed wait is still a wait — both reporters see it,
                # exactly as the parent records a failed timed acquire
                stateprobe.record("doc_lock_wait", ms=waited)
                profiling.add("lock_wait_ms", waited)
                # ⚠ COUNTED HERE, NOT BY THE PARENT. A refused non-blocking
                # acquire and an expired timeout both end at this return, so
                # `super().acquire` never runs and never sees the failure. A
                # `lock_failed` recorded only upstairs would silently miss
                # every failure this gate is responsible for — which is all of
                # them, since the inner lock cannot contend.
                profiling.add("lock_failed", 1.0)
            return False
        if outer:
            # the QUEUE is where waiting happens now (the gate admits in
            # arrival order and the inner lock never contends), so the gate
            # wait is what lock_wait_ms means — billed here because the
            # parent can only see its own, uncontended, acquire
            profiling.add("lock_wait_ms", (time.perf_counter() - t0) * 1000.0)
        ok = super().acquire(blocking, timeout)   # uncontended by admission
        if not ok:
            if outer:
                self._yield_gate()
            return False
        if ok and outer:
            now = time.perf_counter()
            self._tls.wait_ms = (now - t0) * 1000.0
            self._tls.held_at = now
        return ok

    def release(self) -> None:
        outermost = getattr(self._held, "depth", 0) == 1
        if outermost:
            # still owning the lock: run the resident release check first
            # (it must see a world no other writer can be mutating), then
            # record the hold
            try:
                _on_doc_lock_release()
            except Exception:
                pass
            held_at = getattr(self._tls, "held_at", None)
            if held_at is not None:
                stateprobe.record("doc_lock_wait",
                                  ms=getattr(self._tls, "wait_ms", 0.0))
                stateprobe.record("doc_lock_held",
                                  ms=(time.perf_counter() - held_at) * 1000.0)
                self._tls.held_at = None
        super().release()
        if outermost:
            self._yield_gate()

    # ------------------------------------------------ threading.Condition
    def _release_save(self) -> Any:
        # a Condition.wait ends the hold for BOTH reporters — asleep is not
        # held, and the parent closes its own window the same way. The gate
        # is surrendered too; the restore re-queues at the tail.
        self._tls.held_at = None
        state = super()._release_save()
        self._yield_gate()
        return state

    def _acquire_restore(self, state: Any) -> None:
        # A `Condition.wait` that wakes re-queues at the tail like any other
        # arrival, so it can genuinely find a queue in front of it and that is
        # real contention, counted like any other. The parent's
        # `_acquire_restore` sets depth to 1 directly and never runs its own
        # acquire bookkeeping, which is why this is recorded here.
        _admitted, ahead = self._admit(True, -1)
        self._note_arrival(ahead)
        super()._acquire_restore(state)
        self._tls.held_at = time.perf_counter()
        self._tls.wait_ms = 0.0


DOC_LOCK = _InstrumentedDocLock()


# ---------------------------------------------------------------- the latch
# (JSON backend only. SQLite/WAL makes readers and the writer non-blocking by
# construction, so none of this machinery is on that path — §4.6. It stays in
# the module because the JSON backend must remain live and green for at least
# one release as the rollback target, §6.4.)
#
# Windows: `os.replace` over the live doc fails with WinError 5 while ANY
# handle on the destination is open — and MoveFileEx opens the target
# EXCLUSIVELY itself, so no share-mode trick on the reader's side helps
# (measured: a reader holding a FILE_SHARE_DELETE handle blocks the replace
# exactly as a plain `open()` does). The retry-with-backoff below was written
# believing this was a brief collision. It is not: with 8 reader threads
# looping on `open()`, `os.replace` succeeded 0 times in 1,659 attempts
# (0.00%), and at 4R/4W 18 of 8,467 (0.2%). The writer does not lose a race,
# it never gets to run — the 1.9 s backoff budget just delays the raise.
#
# So readers and the replace are made not to OVERLAP, by the cheapest thing
# that achieves it: readers take this latch SHARED for the microseconds of
# the byte read only (they never block each other, and they still never take
# DOC_LOCK — №22's read-outside-the-lock property is untouched), and
# `save_org` takes it EXCLUSIVE across the single `os.replace`. JSON parsing
# happens after the handle is closed and the latch is dropped, so a slow
# parse costs a writer nothing.
#
# ⚠ Nothing that can call back into load_org/save_org may run while this is
# held — the held regions are one `read()` and one `os.replace()`, keep them
# that way. It is per-process only, like DOC_LOCK; the retry loops stay as
# the residual defence against another process (a backup agent, an on-access
# virus scanner) holding the doc open.
class _IOLatch:
    """Writer-preferring shared/exclusive latch. Writer preference is the
    point: without it the reader storm above is exactly what starves the
    replace."""

    def __init__(self) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._readers = 0
        self._writer = False
        self._waiting = 0

    @contextlib.contextmanager
    def shared(self) -> Generator[None]:
        with self._cond:
            while self._writer or self._waiting:
                self._cond.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._cond:
                self._readers -= 1
                if not self._readers:
                    self._cond.notify_all()

    @contextlib.contextmanager
    def exclusive(self) -> Generator[None]:
        with self._cond:
            self._waiting += 1
            while self._writer or self._readers:
                self._cond.wait()
            self._waiting -= 1
            self._writer = True
        try:
            yield
        finally:
            with self._cond:
                self._writer = False
                self._cond.notify_all()


_IO = _IOLatch()


# ------------------------------------------------- one backend per data root
# MEASURED, 2026-08-04 (test_compaction.py "xproc"): two OS processes running
# the canonical `with DOC_LOCK: load_org → mutate → save_org` cycle against one
# org doc lose **32–74 % of their completed writes**, with **zero exceptions,
# zero torn reads and zero orphaned temp files**. Both guards above are
# per-process: `DOC_LOCK` is a `threading.RLock` and `_IOLatch` a `Condition`,
# and `os.replace` is atomic — which is exactly why the failure is invisible.
# Every writer is told it succeeded; the loser's changes are simply not there.
#
# Note what this does NOT justify: a cross-process lock around `save_org`
# alone would not help at all. The race is the read-modify-write CYCLE, so a
# correct lock would have to span `load_org … save_org`, i.e. replace
# `DOC_LOCK` in every caller — regions that spawn CLI children and can be held
# for the length of a 600 s compaction fork. That is a deadlock surface, not a
# fix.
#
# So the rule the architecture already states — ONE BACKEND PER DATA ROOT — is
# enforced at the one moment it is cheap and safe to enforce: process start.
# The claim is an OS-level file lock, not a PID file with a staleness
# heuristic. That distinction is load-bearing: a stale-lock STEAL based on
# mtime is independently broken against a merely-slow (not dead) holder —
# reproduced 2026-08-04, four processes' critical sections overlapping by up
# to 2.0 s because `release()` deleted whatever file was at the path. A kernel
# lock has no stale state at all: when the holder dies, however it dies, the
# handle closes and the lock is gone.
#
# Wired at the top of `api.main()` (`store.claim_data_root()`), which refuses
# startup with a wall when another process holds the root. The mechanism is
# tested end to end in real subprocesses by `test_compaction.py` (section
# "xproc · the owner claim"). ⚠ Tests and drills that spawn their own backend
# must use an isolated ORGTREE_DATA — they already do, and now it is enforced.
#
# SQLITE-SPEC §5.1: the claim STAYS with the SQLite backend. The save became
# atomic; the load→mutate→save cycle did not, and `.owner` also guards
# `accounts.json`, `journals/` and the process table.
_owner_fd: int | None = None


class DataRootBusy(RuntimeError):
    """Another live process already owns this ORGTREE_DATA."""


class DataRootDesync(RuntimeError):
    """Raised when `os.environ['ORGTREE_DATA']` disagrees with `store.DATA_ROOT`.

    `store.DATA_ROOT` binds once at module import. If `ORGTREE_DATA` is set
    afterwards to a different path (e.g. from an import-order inversion in tests),
    operations fail immediately rather than silently reading or writing against
    the wrong root (often production).
    """


#: The exact input strings of the last PASSING `_assert_synced_data_root`.
#: The check's verdict is a deterministic function of these four strings
#: (`devguard.validate_root` reads LIVE/ORGTREE_DATA/LEGACY; the desync half
#: canonicalizes ORGTREE_DATA against DATA_ROOT), so an identical tuple may
#: skip re-validation. A failing check caches nothing.
_ROOT_SYNC_OK: tuple[str, str, str, str] | None = None


def _assert_synced_data_root() -> None:
    """Refuse operations when os.environ['ORGTREE_DATA'] disagrees with DATA_ROOT.

    DATA_ROOT binds once at module import time. If ORGTREE_DATA is set in the
    environment after store was imported (common in tests or scripts with import-
    order inversions), the environment promises isolation while store writes to
    whatever root was bound at import (often the production root).

    If ORGTREE_DATA is unset or empty in the environment, this passes (the standard
    production case defaulting to ~/orgtree).

    ⚠ Memoized on the exact input strings, and that memo is load-bearing for
    latency: the two `os.path.realpath` calls are native calls INSIDE every
    write hold, and under interpreter contention each native return re-enters
    the GIL convoy — a line trace of a 5.12 s stretched write (2026-09-19,
    beta.1 interference control) put 3.56 s in this guard alone. The strings
    never change in a healthy process; any change re-runs the full check, so
    the test-isolation semantics are exactly preserved.
    """
    global _ROOT_SYNC_OK
    env = os.environ.get("ORGTREE_DATA")
    key = (env or "", DATA_ROOT, os.environ.get(devguard.LIVE) or "",
           os.environ.get(devguard.LEGACY) or "")
    if _ROOT_SYNC_OK == key:
        return
    devguard.validate_root(DATA_ROOT)
    if env and env.strip():
        if os.path.normcase(os.path.realpath(env.strip())) != os.path.normcase(os.path.realpath(DATA_ROOT)):
            raise DataRootDesync(
                f"store.DATA_ROOT ({DATA_ROOT!r}) is desynchronized from "
                f"os.environ['ORGTREE_DATA'] ({env!r})! store was imported before "
                f"ORGTREE_DATA was set in the environment."
            )
    _ROOT_SYNC_OK = key


def owner_file(root: str | None = None) -> str:
    return os.path.join(root or DATA_ROOT, ".owner")


def _try_lock(fd: int) -> bool:
    """Exclusive, non-blocking, on BYTE 0. False = someone else holds it.

    ⚠ `msvcrt.locking` locks a range starting at the file's CURRENT position,
    so the seek is part of the contract, not tidiness: locking at EOF would
    give two processes two different byte ranges and mutual exclusion would
    silently not hold. Hence a raw fd (position 0 after `os.open`) rather than
    a text handle opened `"a+"` (position EOF)."""
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def claim_data_root(root: str | None = None) -> None:
    """Claim exclusive ownership of the data root for THIS process.

    Raises `DataRootBusy` if a live process already holds it. Idempotent
    within a process. Released by the OS when the process exits, however it
    exits — there is no cleanup to forget and no stale file to reason about.

    SQLite backend, on DATA_ROOT: unmigrated JSON is looked for FIRST. If any
    is found and `ORGTREE_MIGRATE=1` is not set this raises `MigrationRefused`
    before anything — the claim included — is written: migration is an
    operator action, never a side effect of where a process is pointed. With
    the opt-in, once the root is ours (and only then, because a migration
    needs exactly the exclusivity this claim provides) every `<slug>.json`
    with no `<slug>.db` is migrated (§6.2) BEFORE the API binds. A migration
    whose verifier fails raises `MigrationError` out of here, which refuses
    startup. Never silently, in either direction.

    A `root` other than DATA_ROOT is claimed only — never migrated, never
    refused for JSON (drills claim throwaway roots).
    """
    global _owner_fd, _gate_passed
    if _owner_fd is not None:
        return
    base = root or DATA_ROOT
    on_data_root = os.path.abspath(base) == os.path.abspath(DATA_ROOT)
    if on_data_root:
        _assert_synced_data_root()
    # ⚠⚠ ONE ACTIVE FORMAT PER ROOT, stated once per direction. Both arms
    # run BEFORE the claim and BEFORE the makedirs, so a refused start leaves
    # the root byte-for-byte as it found it.
    if STORE_BACKEND == "sqlite" and on_data_root:
        # the same check runs again inside `migrate_pending` under DOC_LOCK,
        # so a `.json` that lands in the gap between here and there is
        # refused too, not migrated.
        pending = pending_migrations(base)
        if pending and not migration_authorised():
            raise MigrationRefused(_refusal_text(base, pending))
    elif STORE_BACKEND == "json" and on_data_root:
        # The reverse, which had no rule at all and therefore FAILED OPEN.
        # ANY active database refuses — not merely one without a `.json`
        # beside it. The DB+JSON case is the worse of the two: it looks
        # entirely normal, and choosing the `.json` silently discards every
        # write SQLite accepted after the migration. An empty root has
        # neither and starts, so "genuinely empty" and "all orgs invisible"
        # cannot be confused (№80 taught this codebase that lesson once).
        dbs = active_databases(base)
        if dbs:
            names = set(os.listdir(os.path.join(base, "orgs")))
            shadowed = [s for s in dbs if f"{s}.json" in names]
            raise BackendMismatch(_mismatch_text(base, dbs, shadowed))
    elif STORE_BACKEND == "postgres" and on_data_root:
        # PG-0: an org still in a `.json` or `.db` is not on PostgreSQL yet.
        # Importing it is PG-2's operator step; starting would show it as
        # missing, so refuse, exactly like the two arms above.
        stray = sorted(set(pending_migrations(base)) | set(active_databases(base)))
        if stray:
            raise BackendMismatch(
                f"ORGTREE_STORE=postgres, but {base!r} still holds SQLite/JSON "
                f"orgs not imported to PostgreSQL: {', '.join(stray)}. Import "
                "them (PG-2), or run with ORGTREE_STORE=sqlite.")
        from . import pgstore
        _c = pgstore.connect()
        try:
            pgstore.migrate(_c)
        finally:
            _c.close()
        # an orgs row with no marker is not an org anyone can see: retire it
        # (rows kept) so nothing half-made stays live (lead decision 20.2)
        for _s in pgstore.retire_unmarked(os.path.join(base, "orgs")):
            _log(f"postgres org {_s!r} has no marker in orgs/; retired (rows kept)")
        pgstore.backfill_always_rows(ALWAYS_ROWS)
    os.makedirs(base, exist_ok=True)
    fd = os.open(owner_file(base), os.O_RDWR | os.O_CREAT, 0o644)
    if not _try_lock(fd):
        held = ""
        try:
            os.lseek(fd, 1, os.SEEK_SET)
            held = os.read(fd, 200).decode("utf-8", "replace").strip()
        except OSError:
            pass
        os.close(fd)
        raise DataRootBusy(
            f"{base!r} is already in use by another orgtree process"
            + (f" ({held})" if held else "")
            + " — one backend per data root. Concurrent writers silently lose "
              "32-74% of their completed writes (measured; see the comment "
              "above this in store.py). Stop the other process, or point "
              "ORGTREE_DATA somewhere else.")
    # byte 0 is the lock byte and stays a filler; the identity lives after it
    # so a process that LOST the race can still read who holds the root
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, (f"-pid={os.getpid()} "
                      f"since={time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
                 .encode("utf-8"))
        os.ftruncate(fd, 64)
    except OSError:
        pass
    _owner_fd = fd              # held for the process lifetime, deliberately
    if STORE_BACKEND == "sqlite" and on_data_root:
        try:
            migrate_pending()
        except MigrationError:
            # a refused or failed start must not leave the claim behind for
            # the rest of THIS process (a test, a drill) to mistake for its own
            release_data_root()
            raise
        _gate_passed = True


def release_data_root() -> None:
    """Drop the claim early (tests, a graceful shutdown). Normally unnecessary
    — process exit does it."""
    global _owner_fd, _gate_passed
    fd, _owner_fd = _owner_fd, None
    # the claim is what authorised on-demand migration (`_migration_allowed`);
    # giving the claim back gives that back too. Found by sqlite-review: with
    # this line missing, claim → release → drop the flag → load_org still
    # converted a hand-restored .json with neither claim nor flag.
    _gate_passed = False
    if fd is None:
        return
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def _orgs_dir() -> str:
    _assert_synced_data_root()
    d = os.path.join(DATA_ROOT, "orgs")
    os.makedirs(d, exist_ok=True)
    return d


#: Slugs whose containment check already passed, keyed with the orgs dir
#: they passed against. Containment is pure path arithmetic on the two
#: strings, so a verdict never changes for the same key — but the arithmetic
#: runs `os.path.abspath` natively inside hot write paths, and each native
#: return under interpreter contention re-enters the GIL convoy (1.55 s of a
#: 5.12 s stretched write in the 2026-09-19 line trace). Rejections are NOT
#: cached: they raise, and the shape check still runs on every call.
_SAFE_SLUG_OK: dict[tuple[str, str], bool] = {}


def _safe_slug(slug: str) -> str:
    """A slug is a FILE NAME, and every public entry point takes it straight
    off the wire (`/api/orgs/{slug}`). Starlette's path converter is `[^/]+`,
    which on Windows still admits a backslash — so before this check
    `DELETE /api/orgs/..%5Cdefaults` returned 200 and renamed `<data>/
    defaults.json` (the global org defaults) into the trash. Any relative
    `.json` reachable from `<data>/orgs/` was a moveable target.
    Reject by SHAPE, then confirm the resolved path really lands in orgs/ —
    the second check is what keeps this correct if the slug charset ever
    widens."""
    _slug_shape(slug)
    orgs_dir = _orgs_dir()
    if not _SAFE_SLUG_OK.get((slug, orgs_dir)):
        if not _slug_contained(slug, orgs_dir):
            raise LedgerError(f"invalid org slug: {slug!r}")
        if len(_SAFE_SLUG_OK) > 512:
            _SAFE_SLUG_OK.clear()
        _SAFE_SLUG_OK[(slug, orgs_dir)] = True
    return slug


def _slug_contained(slug: str, orgs_dir: str) -> bool:
    """Does `<orgs_dir>/<slug>.json` resolve to a direct child of `orgs_dir`?
    Pure path arithmetic — touches nothing."""
    p = os.path.join(orgs_dir, slug + ".json")
    return os.path.dirname(os.path.abspath(p)) == os.path.abspath(orgs_dir)


def _slug_shape(slug: str) -> None:
    """The SHAPE half of `_safe_slug`: raises `LedgerError` for anything
    that is not a plain file-name-safe slug. No filesystem, no DATA_ROOT."""
    if not isinstance(slug, str) or not slug or len(slug) > 128:  # pyright: ignore[reportUnnecessaryIsInstance]
        raise LedgerError(f"invalid org slug: {slug!r}")
    if (slug in (".", "..") or slug.startswith((".", "-"))
            or any(c in slug for c in '/\\:*?"<>|\0')
            or slug != slug.strip()
            # control characters resolve INSIDE orgs/ so the containment check
            # below passes them, but they make a file nothing can address by
            # name. Caught by an independent replay of this guard 2026-08-04:
            # "a\bx" was accepted.
            # ⚠ Windows RESERVED DEVICE NAMES are deliberately NOT rejected.
            # The folklore is that `con`/`nul`/`com1` are unusable with any
            # extension; MEASURED on Windows 11 2026-08-04, `con.json`,
            # `nul.json`, `com1.json` and `aux.json` all write and read back
            # correctly — the reservation binds the BARE name. A guard here
            # would refuse a legitimate org called "con" or "aux" for nothing,
            # and test_persistence.py asserts they round-trip.
            or any(ord(c) < 0x20 or ord(c) == 0x7f for c in slug)):
        raise LedgerError(f"invalid org slug: {slug!r}")


def _json_path(slug: str) -> str:
    return os.path.join(_orgs_dir(), _safe_slug(slug) + ".json")


def _db_path(slug: str) -> str:
    return os.path.join(_orgs_dir(), _safe_slug(slug) + db_ext())


def _premigration_path(slug: str) -> str:
    return _json_path(slug) + ".premigration"


def org_path(slug: str) -> str:
    """The org's document on disk under the ACTIVE backend — `<slug>.json` or
    `<slug>.db`. Putting a file at this path IS the restore (delete_org)."""
    return _db_path(slug) if row_store() else _json_path(slug)


def scratch_root(slug: str) -> str:
    _assert_synced_data_root()
    return os.path.join(DATA_ROOT, "scratch", slug)


_TMP_GRACE = 300.0     # seconds; a live save's tmp lives for milliseconds


def _sweep_tmp() -> None:
    """(JSON backend.) A save that dies between mkstemp and os.replace — the
    process killed, a non-serialisable value, the replace retry giving up —
    leaves its temp file behind forever. Measured: 12 kills mid-save left 9
    orphans holding 11.9 MB beside a 1.8 MB live doc. `save_org` now cleans up
    its own failures; this catches the ones no `finally` can (SIGKILL, power
    loss). Age-gated so it can never touch a save in flight."""
    cutoff = time.time() - _TMP_GRACE
    try:
        names = os.listdir(_orgs_dir())
    except OSError:
        return
    for f in names:
        if not f.endswith(".tmp"):
            continue
        p = os.path.join(_orgs_dir(), f)
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


def _read_bytes(p: str) -> bytes:
    """The ONE JSON read path. Under the shared latch (so a concurrent
    os.replace is not starved), slurped in one go (so the handle is not held
    across the parse), with the retry left as the residual cross-process
    defence."""
    for i in range(20):
        try:
            with _IO.shared():
                with open(p, "rb") as f:
                    return f.read()
        except PermissionError:
            if i == 19:
                raise
            time.sleep(0.01 * (i + 1))
    raise OSError(f"could not read {p!r}")   # unreachable


# =========================================================================
#                          SQLite backend (SQLITE-SPEC §3–§6)
# =========================================================================

# §3.2 — section classification. EXACT; do not re-derive. `turn_error_log`
# is a dict-of-lists like `mail_log` (the design's own first pass misfiled it
# as a flat list and the round-trip verifier caught it). `notices`, `mail`,
# `delivering`, `net_spool` are dict-of-list shaped too but are MUTABLE
# QUEUES, not append-only logs: they stay `doc` blobs.
ROWED: tuple[str, ...] = ("nodes",)
DICT_LOGS: tuple[str, ...] = ("mail_log", "steered_log", "turn_error_log",
                              # the steering attempt journal (perf-redesign
                              # 2026-09-12, coordinator ruling 11:28Z): a
                              # KEYED dict log — see KEYED_DICT_LOGS. 1.28 MB
                              # of it rode the eager document; stripping the
                              # consumed projections cut 94% of the bytes and
                              # this takes the rest off the hot path.
                              "steer_attempts")
#: dict logs whose per-owner value is KEYED — {id: entry} — rather than an
#: ordered list. Stored as the SAME log_d rows with val = [id, entry] pairs
#: (one row per entry, identity preserved by the ordinary row differ), and
#: presented to consumers as an `AttemptMap`: a dict view over the backing
#: AppendLog whose entry objects are SHARED with the pairs, so the in-place
#: mutation the steering call sites live by (`att["resolved"] = …`) reaches
#: the rows through the same re-serialize-and-compare the other dict logs
#: rely on for nested edits.
KEYED_DICT_LOGS: frozenset[str] = frozenset({"steer_attempts"})
LIST_LOGS: tuple[str, ...] = ("events", "org_inbox", "notice_log",
                              "user_mail_log", "user_outbox",
                              "documents", "watchdog_history",
                              # operation receipts (opreceipts.py): append-only
                              # and capped, and LAZY is the point — a call
                              # that carries no `op_key` never touches it, so
                              # it costs the hot path nothing (measured:
                              # untouched 2.5 ms, materialise+append 5.9 ms at
                              # 300 rows — evidence/receipt-cost.json)
                              "op_receipts",
                              # the closed docket (perf-redesign 2026-09-12,
                              # REPORT.md #8): 1.89 MB on the live org and
                              # append-mostly — it rode the EAGER document,
                              # so every load parsed it and every
                              # compare-on-save re-serialized it. Reads are
                              # rare (the archived toggle, repair ops) and
                              # materialize transparently; appends take
                              # `log_append`'s pure-INSERT path. An existing
                              # doc-blob copy loads eagerly once and
                              # `_write_lazy` converts it to rows on the
                              # next save — no operator migration.
                              "work_items_archive")
LAZY_SECTIONS: frozenset[str] = frozenset(DICT_LOGS) | frozenset(LIST_LOGS)

_SCHEMA_VERSION = "1"

#: Rearchitecture Phase B — the ACCESS-SCOPED SAVE. When on (the default),
#: a save of a LazyDoc re-serializes only the top-level keys and node rows
#: exposed mutably since the last adopt (the read barrier on LazyDoc and
#: NodesMap) and carries the stored baseline for everything else, making
#: save cost proportional to what the operation touched instead of to org
#: size. `ORGTREE_SCOPED_SAVE=0` restores the full re-serialize-and-compare
#: everywhere — the operational escape hatch while the beta soaks.
_SCOPED_SAVE = os.environ.get("ORGTREE_SCOPED_SAVE", "1").strip() != "0"
#: Test-mode control: after every scoped save, re-serialize EVERYTHING and
#: compare against the adopted baselines — any mismatch is a mutation the
#: read barrier missed, and it raises rather than letting a silent stale
#: write survive. The concurrency suite runs with this on; production does
#: not pay for it.
_SCOPED_VERIFY = os.environ.get("ORGTREE_SCOPED_SAVE_VERIFY", "").strip() == "1"

# §3.1 — the DDL. Nothing inside a NodeDoc or an entry is a column (§3.3): a
# field earns a column by appearing in a WHERE or an ORDER BY, nothing else.
_DDL = """
CREATE TABLE IF NOT EXISTS doc (
  key  TEXT PRIMARY KEY,
  val  TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS nodes (
  id   TEXT PRIMARY KEY,
  ord  INTEGER NOT NULL,
  val  TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS log_d (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  sect  TEXT NOT NULL,
  owner TEXT NOT NULL,
  at    TEXT,
  val   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_log_d ON log_d(sect, owner, seq);
CREATE TABLE IF NOT EXISTS log_l (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  sect  TEXT NOT NULL,
  at    TEXT,
  val   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_log_l ON log_l(sect, seq);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val TEXT NOT NULL);
"""

# `meta` rows beyond the spec's four bookkeeping ones (schema_version,
# migrated_at, source_json_sha256, source_json_bytes) — both exist so the
# reconstruction is FAITHFUL rather than merely equal-under-sort_keys:
#   key_order      JSON list of the document's top-level keys in insertion
#                  order. This is also what records that an EMPTY lazy
#                  section (`"turn_error_log": {}`) exists at all — zero rows
#                  cannot say so, and the verifier's canonical compare would
#                  fail on the missing key.
#   owners:<sect>  JSON list of a dict-log's owners in insertion order, for
#                  the same two reasons one level down: an owner whose list
#                  is empty (`setdefault(nid, [])` on a read path leaves one)
#                  has no rows, and owner order is otherwise lost.
_META_KEY_ORDER = "key_order"
_META_OWNERS = "owners:"


class MigrationError(RuntimeError):
    """The JSON→SQLite migration of one org did not verify. The `.json` is
    untouched, the candidate database was deleted, and the backend must not
    start on this data root (§6.2)."""


class MigrationRefused(MigrationError):
    """Unmigrated JSON was found under the SQLite backend and nobody opted in
    (`ORGTREE_MIGRATE=1`). Nothing was written. A subclass of `MigrationError`
    so every place that already refuses on a failed migration refuses on a
    withheld one the same way — never a fallback to reading nothing."""


class BackendMismatch(MigrationError):
    """A JSON process was pointed at a root whose orgs are SQLite databases.

    The mirror of `MigrationRefused`, and deliberately the same family so
    every place that already refuses on a withheld migration refuses on a
    backend mismatch identically — never a fallback to reading nothing.

    This is the direction that FAILED OPEN. SQLite meeting JSON refused; JSON
    meeting SQLite started, claimed the root and reported `list_orgs() == []`
    (phase1-audit, 2026-09-04). Which is the shape of a real incident: the
    flip goes out, something unrelated looks wrong, someone reverts the CODE
    without restoring the DATA, and the org appears to have vanished while
    `update.ps1`'s health check — which only wants HTTP 200 from /api/orgs —
    reports the rollback a success."""


def active_databases(root: str | None = None) -> list[str]:
    """Slugs with an `orgs/<slug>.db` under `root` (DATA_ROOT by default).

    The exact mirror of `pending_migrations`: one `listdir`, nothing opened,
    nothing created, the same slug-shape and containment checks against
    `root`'s own orgs dir. Sorted.

    ⚠ EXISTENCE, not validity. A `.db` is not opened to see whether it is a
    real orgtree database, and that is the safe direction: this check exists
    to prevent a JSON process from silently becoming the authority for a root
    that SQLite owns, so anything shaped like an org database must stop it. A
    corrupt or foreign `.db` is MORE reason to refuse, not less — and the
    remedy (move it out of `orgs/`) is the same either way.

    Trash and exports live outside `orgs/` and are invisible here, which is
    why parking a database IS the way out of the refusal."""
    d = os.path.join(root or DATA_ROOT, "orgs")
    try:
        names = set(os.listdir(d))
    except OSError:
        return []
    out: list[str] = []
    for f in sorted(names):
        if not f.endswith(".db"):
            continue
        slug = f[:-3]
        try:
            _slug_shape(slug)
        except LedgerError:
            continue
        if not _slug_contained(slug, d):
            continue
        out.append(slug)
    return out


def pending_migrations(root: str | None = None) -> list[str]:
    """Slugs with an `orgs/<slug>.json` and no `orgs/<slug>.db` under `root`
    (DATA_ROOT by default). A pure read: one `listdir`, no directory made,
    nothing opened, and the slug check is against `root`'s own orgs dir —
    not `_safe_slug`, which resolves through DATA_ROOT. Sorted."""
    d = os.path.join(root or DATA_ROOT, "orgs")
    try:
        names = set(os.listdir(d))
    except OSError:
        return []
    out: list[str] = []
    for f in sorted(names):
        if not f.endswith(".json"):
            continue
        slug = f[:-5]
        try:
            _slug_shape(slug)
        except LedgerError:
            continue
        if not _slug_contained(slug, d):
            continue
        if f"{slug}.db" not in names:
            out.append(slug)
    return out


def _refusal_text(root: str, pending: list[str]) -> str:
    bar = "!" * 74
    return (
        f"\n{bar}\n"
        f"  MIGRATION REFUSED — {len(pending)} unmigrated JSON org(s) under a SQLite backend\n"
        f"\n"
        f"  data root : {root}\n"
        f"  pending   : {', '.join(pending)}\n"
        f"\n"
        f"  This process runs ORGTREE_STORE=sqlite, but orgs/ still holds .json\n"
        f"  documents with no .db beside them. Converting them REWRITES the data\n"
        f"  root (<slug>.json becomes <slug>.json.premigration + <slug>.db), so it\n"
        f"  is an OPERATOR action — never something a process infers from where it\n"
        f"  happens to be pointed. On 2026-09-03 a test runner did exactly that to\n"
        f"  the live root.\n"
        f"\n"
        f"\n"
        f"  YOU ALMOST CERTAINLY WANT YOUR NORMAL DEPLOY, WHICH DOES THIS FOR YOU:\n"
        f"      Windows   powershell -ExecutionPolicy Bypass -File update.ps1\n"
        f"      POSIX     ./update.sh\n"
        f"  Since 2026-09-04 those detect this exact situation before they stop\n"
        f"  anything and run the migration as part of the deploy -- stop, migrate,\n"
        f"  export-verify, start -- keeping a validated export you can roll back to.\n"
        f"  Reaching THIS message means the backend was started some other way.\n"
        f"\n"
        f"  To migrate THIS root by hand:  set {MIGRATE_ENV}=1 and start again.\n"
        f"      (no export is taken on that path, so there is no rollback route;\n"
        f"       tools/cutover.py migrate + export-verify is the supported one)\n"
        f"  To keep it as JSON:            set ORGTREE_STORE=json.\n"
        f"      ⚠ JSON is DEPRECATED and past LTS as of 2026-09-04. It still reads,\n"
        f"        writes and rolls back, but it is not a supported ongoing state.\n"
        f"  Wrong root?                    set ORGTREE_DATA to the one you meant.\n"
        f"\n"
        f"  NOTHING HAS BEEN WRITTEN.\n"
        f"{bar}")


def _mismatch_text(root: str, dbs: list[str], shadowed: list[str]) -> str:
    """The refusal an operator reads at the moment of a code/data asymmetry.

    ⚠ IT ROUTES TO THE TOOL AND DOES NOT RESTATE THE PROCEDURE, deliberately.
    This message used to carry its own five-step rollback, and when the
    ordering was corrected — install the exports while the databases are still
    authoritative, park them only after — the runbook and the tool were fixed
    and THIS WAS NOT. It went on telling operators to park first, which
    `cutover_tool_partial.py` proved can leave SQLite starting with an org
    silently missing. (phase1-audit, 2026-09-04.)
    
    A procedure written in two places drifts, and the copy that drifts is the
    one nobody re-reads. This is the copy an operator actually sees, at the
    worst possible moment, so it names the audited command and the invariant
    behind it and nothing else. `test_migration_gate` pins that it stays a
    pointer: no numbered sequence, and no park-before-install ordering."""
    bar = "!" * 74
    both = (
        f"\n"
        f"  ⚠ {len(shadowed)} of them ALSO have a .json beside the database:\n"
        f"      {', '.join(shadowed)}\n"
        f"  Do not trust those .json files because they are there and look\n"
        f"  fine. The database is the authority on this root, and a .json\n"
        f"  sitting next to one is STALE by definition — it predates every\n"
        f"  write SQLite has accepted since the migration. Starting JSON here\n"
        f"  would silently make the older document the truth again.\n"
    ) if shadowed else ""
    return (
        f"\n{bar}\n"
        f"  BACKEND MISMATCH — {len(dbs)} SQLite org(s) under a JSON backend\n"
        f"\n"
        f"  data root : {root}\n"
        f"  databases : {', '.join(dbs)}\n"
        f"{both}"
        f"\n"
        f"  This process runs ORGTREE_STORE=json, but orgs/ holds .db documents.\n"
        f"  A JSON process cannot read them, and starting anyway would present\n"
        f"  these orgs as GONE while every health check passed — /api/orgs would\n"
        f"  answer 200 with an empty list. One root, one format: if the data is\n"
        f"  SQLite, the code must be too.\n"
        f"\n"
        f"  If you meant to run SQLite:   set ORGTREE_STORE=sqlite.\n"
        f"  Wrong root?                   set ORGTREE_DATA to the one you meant.\n"
        f"\n"
        f"  If you are ROLLING BACK to JSON, do NOT hand-roll it. With the\n"
        f"  backend stopped:\n"
        f"\n"
        f"      python tools/cutover.py rollback <root>\n"
        f"\n"
        f"  It exports and validates EVERY org before anything moves, installs\n"
        f"  the exports while the databases are still authoritative, and only\n"
        f"  then parks them — so an interruption at any point leaves a root\n"
        f"  that refuses to start rather than one that starts with an org\n"
        f"  missing. It also recognises a half-finished rollback and prints\n"
        f"  the exact command to finish it. docs/sqlite-cutover.md has the\n"
        f"  reasoning.\n"
        f"\n"
        f"  ⚠ DO NOT roll back by restoring <slug>.json.premigration. That file\n"
        f"  is the document as it stood BEFORE the migration and contains none\n"
        f"  of the writes SQLite has accepted since. Restoring it is not a\n"
        f"  rollback, it is a discard.\n"
        f"\n"
        f"  NOTHING HAS BEEN WRITTEN.\n"
        f"{bar}")


def _dumps(v: Any) -> str:
    """The ONE serialisation for every stored value. Compact separators, and
    NOTHING else varies — compare-on-save compares these strings."""
    return json.dumps(v, separators=(",", ":"))


def canon(x: Any) -> str:
    """§6.3 — canonical JSON: `sort_keys` normalises dict order (which JSON
    does not preserve semantically), compact separators normalise whitespace.
    Everything else — every value, list order, nesting, float — must match."""
    return json.dumps(x, sort_keys=True, separators=(",", ":"))


def _at_of(entry: Any) -> str | None:
    """`entry["at"]` for the index column when it is a string; NULL otherwise.
    Only ever used for range filters — `val` holds the truth."""
    if isinstance(entry, dict):
        at = cast("dict[str, Any]", entry).get("at")
        if isinstance(at, str):
            return at
    return None


def _open_conn(path: str, *, create: bool = False) -> sqlite3.Connection:
    """One connection, pragmas applied (§3.1), schema ensured.

    ⚠ `create` is the whole safety of this function, not a convenience.
    `sqlite3.connect(path)` CREATES an empty database when the path is
    missing, and an existence check before it is a TOCTOU window that
    `delete_org` — which renames the file out from under readers by design
    (№22 reads outside DOC_LOCK) — walks straight through. Measured on this
    branch before the flag existed: delete an org, then touch a still-lazy
    section of a document loaded a moment earlier, and the materialisation
    silently returned an EMPTY section, re-created `orgs/<slug>.db` (plus
    `-wal`, `-shm`), and a subsequent `save_org` wrote that mutilated
    document to disk — losing every log section, with no error anywhere.
    `create_org` then refused the slug as "already exists". The JSON backend
    cannot do this: a missing file raises there.

    So a read path opens `?mode=rw`, which refuses a missing file INSIDE
    sqlite (no window at all), and only the two paths that legitimately mint
    a database — the migration candidate and `save_org` — pass `create=True`.

    `isolation_level=None`: the sqlite3 module's implicit-BEGIN machinery is
    off; every transaction here is an explicit `BEGIN IMMEDIATE` … `COMMIT`.
    `check_same_thread=False`: connections live in `_Pool`, which hands each
    one to exactly one thread at a time — see the pool for why that, and not
    `threading.local()`, is the shape.

    `factory=census_contacts.ObservedConnection` makes this the census's
    actual contact boundary for the primary store (P02-A3). It behaves as a
    plain `sqlite3.Connection` and observes nothing while census capture is
    off, which is the default; see `census_contacts` for what it records and
    for every connection path it does not."""
    target = path
    if not create:
        # as_uri() percent-encodes a data root containing a space, '#' or '%';
        # hand-built "file:" + path does not, and silently opens the wrong file
        target = pathlib.Path(os.path.abspath(path)).as_uri() + "?mode=rw"
    conn = sqlite3.connect(target, timeout=10.0, isolation_level=None,
                           check_same_thread=False, uri=not create,
                           factory=census_contacts.ObservedConnection)
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("PRAGMA busy_timeout=10000")
    if create:
        # Schema and journal mode are properties the MINTING paths establish
        # (`save_org` via create=True, the migration candidate); WAL persists
        # in the file and `synchronous` only matters where commits happen.
        #
        # ⚠ A READ CONNECTION MUST NOT RUN THIS. `executescript(_DDL)` is a
        # WRITE (even all-IF-NOT-EXISTS no-ops take the writer lock), and it
        # turned every pool-churned read open into a queue behind
        # `BEGIN IMMEDIATE` writers — measured 2026-09-19 as the second half
        # of a lock-order inversion: a snapshot assembly holding the snap
        # gate waited up to busy_timeout for the db write lock, while the
        # save holding the db write lock waited for the snap gate. Ten
        # seconds of stall per cycle, from schema DDL that had nothing to
        # create.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.executescript(_DDL)
    return conn


class _Pool:
    """Connections per slug, each used by ONE thread at a time.

    `sqlite3.threadsafety == 1` on this build: connections must not be used
    by two threads at once. §5.2 suggests `threading.local()`; a pool gives
    the same guarantee (a connection is checked out, used, checked in — never
    shared) and fixes the one thing a thread-local cache cannot do: `delete_org`
    has to CLOSE every connection to a database before it can rename the file
    (Windows refuses `os.replace` on an open file; a `-wal` with frames the
    renamed file would lose), and a connection cached in another thread's
    local storage is unreachable. Here the idle ones are closed on the spot
    and the checked-out ones are closed on check-in instead of returned
    (`_epoch`), and the rename retries until the last reader has let go.

    Cap: `_CAP` idle connections per slug; beyond it a checked-in connection
    is closed. Pool size tracks peak concurrency, not thread count."""

    _CAP = 8

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._idle: dict[str, list[sqlite3.Connection]] = {}
        self._epoch: dict[str, int] = {}
        self._busy: dict[str, int] = {}

    @contextlib.contextmanager
    def acquire(self, slug: str, *, create: bool = False
                ) -> Generator[sqlite3.Connection]:
        """`create=True` only where minting a database is the intent — see
        `_open_conn`. Every read path leaves it False so that a database
        deleted under us raises instead of coming back empty."""
        pinned = getattr(_orgtx_local, "pinned", None)
        pc = pinned.get(slug) if pinned else None
        if pc is not None:
            # PG-0: inside an org_tx on postgres, the load and the save run
            # on the transaction's own connection (pgstore module docstring);
            # a multi-org org_tx pins one entry per org, all on one connection
            yield pc
            return
        with self._lock:
            epoch = self._epoch.get(slug, 0)
            idle = self._idle.get(slug)
            conn = idle.pop() if idle else None
            self._busy[slug] = self._busy.get(slug, 0) + 1
        keep = False
        try:
            if conn is None:
                if STORE_BACKEND == "postgres":
                    from . import pgstore
                    conn = cast("sqlite3.Connection",
                                pgstore.open_conn(slug, _db_path(slug), create=create))
                else:
                    conn = _open_conn(_db_path(slug), create=create)
            census_contacts.note_checkout()
            yield conn
            # a transaction still open on check-in is a bug in the caller;
            # never pool it — roll back and drop the connection
            # postgres: never idle per slug — PgConn.close() hands the server
            # connection to pgstore's one process-wide pool instead
            keep = not conn.in_transaction and STORE_BACKEND != "postgres"
        finally:
            with self._lock:
                self._busy[slug] = self._busy.get(slug, 1) - 1
                if conn is not None and keep and self._epoch.get(slug, 0) == epoch:
                    lst = self._idle.setdefault(slug, [])
                    if len(lst) < self._CAP:
                        lst.append(conn)
                        conn = None
            if conn is not None:
                with contextlib.suppress(Exception):
                    if conn.in_transaction:
                        conn.execute("ROLLBACK")
                with contextlib.suppress(Exception):
                    conn.close()

    def close_all(self, slug: str) -> int:
        """Close every idle connection to `slug` and mark the checked-out ones
        to be closed on check-in. Returns how many are still checked out."""
        with self._lock:
            self._epoch[slug] = self._epoch.get(slug, 0) + 1
            conns = self._idle.pop(slug, [])
            busy = self._busy.get(slug, 0)
        for c in conns:
            with contextlib.suppress(Exception):
                c.close()
        return busy


_POOL = _Pool()


# ------------------------------------------------------------ the proxies
class AppendLog(list[Any]):
    """A row-backed log that remains an ordinary mutable ``list``.

    ``_rows`` is the committed baseline in list order: ``(seq, JSON)``.
    Save compares current serialized values to it, so nested entry edits are
    visible even though no list method saw them. ``full_rewrite`` is only a
    conservative signal for operations whose row identity cannot be safely
    retained (middle insert, reorder, or a variable-size slice assignment).
    """

    full_rewrite: bool = False
    _rows: list[tuple[int, str]] = []
    _row_ids: list[int | None] = []

    def __new__(cls, *a: Any, **kw: Any) -> "AppendLog":
        obj = cast("AppendLog", super().__new__(cls))
        obj.full_rewrite = False
        obj._rows = []
        obj._row_ids = []
        return obj

    def __init__(self, values: Iterable[Any] = (), *,
                 rows: list[tuple[int, str]] | None = None) -> None:
        super().__init__(values)
        self.full_rewrite = False
        self._rows = list(rows) if rows is not None else []
        self._row_ids = ([seq for seq, _ in self._rows] if rows is not None
                         else [None] * len(self))

    def _touch(self) -> None:
        self.full_rewrite = True

    def _adopt(self, rows: list[tuple[int, str]]) -> None:
        self._rows = rows
        self._row_ids = [seq for seq, _ in rows]
        self.full_rewrite = False

    def __copy__(self) -> "AppendLog":
        other = AppendLog(self, rows=self._rows)
        other._row_ids = list(self._row_ids)
        other.full_rewrite = self.full_rewrite
        return other

    def __deepcopy__(self, memo: dict[int, Any]) -> "AppendLog":
        other = AppendLog()
        memo[id(self)] = other
        list.extend(other, copy.deepcopy(list(self), memo))
        other._rows = copy.deepcopy(self._rows, memo)
        other._row_ids = copy.deepcopy(self._row_ids, memo)
        other.full_rewrite = self.full_rewrite
        return other

    def append(self, x: Any) -> None:
        super().append(x)
        self._row_ids.append(None)

    def extend(self, xs: Iterable[Any]) -> None:
        values = list(xs)
        super().extend(values)
        self._row_ids.extend([None] * len(values))

    def insert(self, i: Any, x: Any) -> None:
        if i != len(self):
            self._touch()
        super().insert(i, x)
        self._row_ids.insert(i, None)

    def pop(self, *a: Any) -> Any:
        if len(a) > 1:
            return super().pop(*a)
        i = a[0] if a else -1
        self._row_ids.pop(i)
        return super().pop(i)

    def remove(self, x: Any) -> None:
        i = self.index(x)
        self._row_ids.pop(i)
        super().__delitem__(i)

    def clear(self) -> None:
        super().clear()
        self._row_ids.clear()

    def sort(self, *a: Any, **kw: Any) -> None:
        self._touch()
        super().sort(*a, **kw)
        self._row_ids = [None] * len(self)

    def reverse(self) -> None:
        self._touch()
        super().reverse()
        self._row_ids = [None] * len(self)

    def __setitem__(self, i: Any, v: Any) -> None:
        if isinstance(i, slice):
            values = list(v)
            old_n = len(range(*i.indices(len(self))))
            if old_n != len(values):
                self._touch()
            super().__setitem__(i, values)
            if self.full_rewrite:
                self._row_ids = [None] * len(self)
            return
        super().__setitem__(i, v)

    def __delitem__(self, i: Any) -> None:
        if isinstance(i, slice):
            del self._row_ids[i]
        else:
            self._row_ids.pop(i)
        super().__delitem__(i)

    def __iadd__(self, xs: Any) -> Any:
        values = list(xs)
        super().__iadd__(values)
        self._row_ids.extend([None] * len(values))
        return self

    def __imul__(self, n: Any) -> Any:
        self._touch()
        super().__imul__(n)
        self._row_ids = [None] * len(self)
        return self


def appended_since_load(value: Any) -> int | None:
    """How many rows a log section has GAINED since it was loaded — without
    materialising anything.

    An operation receipt brackets the document `events` one call produced,
    and the obvious way to get that bracket (read `len(d["events"])` before
    the dispatch) would materialise the whole unbounded events log on every
    keyed call — the S1 cost this design is otherwise careful to avoid. An
    `AppendLog` already knows its committed baseline, so if the dispatch
    touched the section the count is free, and if it did not, nothing is
    loaded. `None` means "not an AppendLog": a JSON document holds a plain
    list, and its caller has the pre-dispatch length for free anyway because
    JSON loads the whole document.
    """
    if isinstance(value, AppendLog):
        return max(0, len(value) - len(value._rows))
    return None


class AttemptMap(dict[str, Any]):
    """{id: entry} view over an AppendLog of ``[id, entry]`` pairs — the
    consumer face of a KEYED_DICT_LOGS owner (steer_attempts).

    The entry objects in the view ARE the entry halves of the pairs, so the
    steering code's in-place mutations flow into the backing log with no
    bookkeeping here; `_write_log_rows` re-serializes every entry of a
    loaded owner and catches nested edits exactly as it does for mail_log.
    Structural ops (add / replace / delete an id) are mirrored onto the log,
    where AppendLog's row-identity tracking turns them into the minimal
    insert/update/delete. A malformed pair (not ``[str, entry]``) stays in
    the log untouched — bytes preserved — and simply never shows in the
    view."""

    __slots__ = ("_log",)

    def __init__(self, log: "AppendLog | None" = None) -> None:
        super().__init__()
        self._log: AppendLog = AppendLog() if log is None else log
        for pair in self._log:
            if (isinstance(pair, list) and len(pair) == 2
                    and isinstance(pair[0], str)):
                dict.__setitem__(self, pair[0], pair[1])

    def _pair_index(self, key: str) -> int:
        for i, pair in enumerate(self._log):
            if isinstance(pair, list) and len(pair) == 2 and pair[0] == key:
                return i
        return -1

    def __setitem__(self, key: str, value: Any) -> None:
        i = self._pair_index(key) if dict.__contains__(self, key) else -1
        if i >= 0:
            # replace INSIDE the existing pair: the row keeps its seq and
            # the differ writes one UPDATE
            cast("list[Any]", self._log[i])[1] = value
        else:
            self._log.append([key, value])
        dict.__setitem__(self, key, value)

    def __delitem__(self, key: str) -> None:
        if not dict.__contains__(self, key):
            raise KeyError(key)
        i = self._pair_index(key)
        if i >= 0:
            self._log.pop(i)
        dict.__delitem__(self, key)

    def pop(self, key: str, *default: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        if len(default) > 1:
            raise TypeError(
                f"pop expected at most 2 arguments, got {len(default) + 1}")
        if dict.__contains__(self, key):
            value = dict.__getitem__(self, key)
            del self[key]
            return value
        if default:
            return default[0]
        raise KeyError(key)

    def popitem(self) -> tuple[str, Any]:
        if not dict.__len__(self):
            raise KeyError("popitem(): dictionary is empty")
        key = next(reversed(dict.keys(self)))
        return key, self.pop(key)

    def setdefault(self, key: str, default: Any = None) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        self[key] = default
        return default

    def clear(self) -> None:
        self._log.clear()
        dict.clear(self)

    def update(self, *a: Any, **kw: Any) -> None:  # pyright: ignore[reportIncompatibleMethodOverride]
        for k, v in dict(*a, **kw).items():
            self[k] = v

    def __ior__(self, other: Any) -> Any:
        self.update(other)
        return self

    def __copy__(self) -> "AttemptMap":
        return AttemptMap(copy.copy(self._log))

    def __deepcopy__(self, memo: dict[int, Any]) -> "AttemptMap":
        new = AttemptMap(copy.deepcopy(self._log, memo))
        memo[id(self)] = new
        return new

    def __reduce_ex__(self, protocol: int) -> Any:
        # a pickled copy loses row identity on purpose: it rebuilds from a
        # fresh log, whose next save takes the safe full-rewrite path
        return (AttemptMap, (AppendLog(list(self._log)),))


class SectionMap(dict[str, Any]):
    """A dict-log map that loads row values only for the requested owner.

    Owner presence/order is metadata, distinct from ``_snaps`` which holds
    row baselines only for owners actually loaded. Full-dict operations first
    materialize the remaining owners so dict-subclass fast paths never omit a
    virtual owner or expose placeholders. Already-returned mutable lists keep
    their identity during later bulk materialization.

    This is not a coherent-document snapshot: an owner first touched after a
    commit can be newer than eager ``LazyDoc`` fields. S2 owns that policy;
    this proxy does not keep a long read transaction open.

    CPython's C JSON encoder short-circuits an empty dict subclass before its
    overridden ``items()`` runs. A private backing seed prevents that shortcut;
    every observable mapping path removes it before returning real values.
    """

    _SEED = object()

    _STATE_DEFAULTS: dict[str, Callable[[], Any]] = {
        "_slug": str, "_sect": str, "_order": list, "_present": set,
        "_dropped": set, "_added": set, "_replaced": set, "_snaps": dict,
    }

    def __getattr__(self, name: str) -> Any:
        factory = SectionMap._STATE_DEFAULTS.get(name)
        if factory is None:
            raise AttributeError(name)
        value = factory()
        object.__setattr__(self, name, value)
        return value

    def __init__(self, slug: str = "", sect: str = "",
                 owners: Iterable[str] = ()) -> None:
        super().__init__()
        self._slug = slug
        self._sect = sect
        self._order = list(owners)
        self._present = set(self._order)
        self._dropped: set[str] = set()
        self._added: set[str] = set()
        self._replaced: set[str] = set()
        self._snaps: dict[str, list[tuple[int, str]]] = {}
        # Never observable: it exists only to make CPython's C JSON encoder
        # call our items() instead of short-circuiting an empty backing dict.
        dict.__setitem__(self, cast(str, self._SEED), None)

    def _load_owner(self, owner: str) -> Any:
        t0 = time.perf_counter()
        with _POOL.acquire(self._slug) as conn:
            rows = [(cast(int, seq), cast(str, val)) for seq, val in conn.execute(
                "SELECT seq, val FROM log_d WHERE sect=? AND owner=? ORDER BY seq",
                (self._sect, owner)).fetchall()]
        log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
        stateprobe.record("lazy_owner", ms=(time.perf_counter() - t0) * 1000.0,
                          nbytes=sum(len(v) for _, v in rows),
                          section=f"{self._sect}[owner]")
        self._snaps[owner] = log._rows
        value: Any = (AttemptMap(log) if self._sect in KEYED_DICT_LOGS
                      else log)
        dict.__setitem__(self, owner, value)
        return value

    def __missing__(self, owner: str) -> Any:
        if owner in self._present and owner not in self._dropped:
            return self._load_owner(owner)
        raise KeyError(owner)

    def materialize_all(self) -> None:
        missing = [o for o in self._order
                   if o in self._present and not dict.__contains__(self, o)]
        if missing:
            t0 = time.perf_counter()
            nbytes = 0
            wanted = set(missing)
            grouped: dict[str, list[tuple[int, str]]] = {o: [] for o in missing}
            with _POOL.acquire(self._slug) as conn:
                conn.execute("BEGIN")
                try:
                    for owner, seq, val in conn.execute(
                            "SELECT owner, seq, val FROM log_d "
                            "WHERE sect=? ORDER BY seq", (self._sect,)):
                        owner = cast(str, owner)
                        if owner in wanted:
                            grouped[owner].append((cast(int, seq), cast(str, val)))
                            nbytes += len(cast(str, val))
                finally:
                    conn.execute("COMMIT")
            stateprobe.record("lazy_section",
                              ms=(time.perf_counter() - t0) * 1000.0,
                              nbytes=nbytes, section=f"{self._sect}[all]")
            for owner in missing:
                rows = grouped[owner]
                log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
                self._snaps[owner] = log._rows
                dict.__setitem__(self, owner,
                                 AttemptMap(log) if self._sect in KEYED_DICT_LOGS
                                 else log)
        expected = [o for o in self._order if o in self._present]
        if list(dict.keys(self)) != expected:
            values = {o: dict.__getitem__(self, o) for o in expected}
            dict.clear(self)
            for owner in expected:
                dict.__setitem__(self, owner, values[owner])

    def _unmaterialized(self) -> set[str]:
        return {o for o in self._present if not dict.__contains__(self, o)}

    def __contains__(self, owner: object) -> bool:
        return (dict.__contains__(self, owner)
                or (isinstance(owner, str) and owner in self._present
                    and owner not in self._dropped))

    def get(self, owner: str, default: Any = None) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        try:
            return self[owner]
        except KeyError:
            return default

    def __setitem__(self, owner: str, value: Any) -> None:
        if (self._sect in KEYED_DICT_LOGS and isinstance(value, dict)
                and not isinstance(value, AttemptMap)):
            # normalize a plain assignment ({} from setdefault, a fixture's
            # literal) so every later mutation is incremental and the save
            # adoption below has one shape to reason about
            value = AttemptMap(AppendLog([[k, v] for k, v in
                                          cast("dict[str, Any]", value).items()]))
        if owner not in self._present:
            self._order.append(owner)
            self._added.add(owner)
        self._present.add(owner)
        self._dropped.discard(owner)
        self._replaced.add(owner)
        dict.__setitem__(self, owner, value)

    def __delitem__(self, owner: str) -> None:
        if owner not in self:
            raise KeyError(owner)
        if dict.__contains__(self, owner):
            dict.__delitem__(self, owner)
        self._present.discard(owner)
        self._dropped.add(owner)
        self._replaced.discard(owner)
        self._order = [o for o in self._order if o != owner]

    def pop(self, owner: str, *default: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        if len(default) > 1:
            raise TypeError(
                f"pop expected at most 2 arguments, got {len(default) + 1}")
        if owner in self:
            value = self[owner]
            del self[owner]
            return value
        if default:
            return default[0]
        raise KeyError(owner)

    def popitem(self) -> tuple[str, Any]:
        if not self._order:
            raise KeyError("popitem(): dictionary is empty")
        owner = self._order[-1]
        return owner, self.pop(owner)

    def clear(self) -> None:
        self._dropped |= self._present
        self._present.clear()
        self._added.clear()
        self._replaced.clear()
        self._order.clear()
        dict.clear(self)

    def setdefault(self, owner: str, default: Any = None) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        if owner in self:
            return self[owner]
        self[owner] = default
        # hand back what `__setitem__` actually STORED, never `default`
        # itself: in a keyed section a plain dict is normalized to a fresh
        # AttemptMap, and a caller mutating the detached original ({} from
        # `supervisor._steer_attempts`) wrote rows no save could see
        # (perf-review round 3, first attempt for a new owner lost)
        return self[owner]

    def update(self, *a: Any, **kw: Any) -> None:  # pyright: ignore[reportIncompatibleMethodOverride]
        for owner, value in dict(*a, **kw).items():
            self[owner] = value

    def __ior__(self, other: Any) -> Any:
        self.update(other)
        return self

    def keys(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.keys(self)

    def items(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.items(self)

    def values(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.values(self)

    def __iter__(self) -> Iterator[str]:
        self.materialize_all()
        return dict.__iter__(self)

    def __reversed__(self) -> Iterator[str]:
        # Owner order is complete metadata; values need not be read merely to
        # enumerate keys backwards. Never expose the private backing seed.
        return reversed([owner for owner in self._order
                         if owner in self._present])

    def __bool__(self) -> bool:
        # Production uses `(org.d.get("mail_log") or {}).get(owner)`. Dict's
        # default truth test calls __len__, which is a whole-map operation for
        # this proxy. Presence metadata is sufficient and keeps that real
        # caller idiom owner-selective.
        return bool(self._present)

    def __len__(self) -> int:
        self.materialize_all()
        return dict.__len__(self)

    def __eq__(self, other: object) -> bool:
        self.materialize_all()
        return dict.__eq__(self, other)

    def __ne__(self, other: object) -> Any:
        result = self.__eq__(other)
        return result if result is NotImplemented else not result

    __hash__ = None  # type: ignore[assignment]

    def __repr__(self) -> str:
        self.materialize_all()
        return dict.__repr__(self)

    def copy(self) -> dict[str, Any]:  # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict(dict.items(self))

    def __deepcopy__(self, memo: dict[int, Any]) -> "SectionMap":
        self.materialize_all()
        other = SectionMap(self._slug, self._sect)
        memo[id(self)] = other
        other._order = copy.deepcopy(self._order, memo)
        other._present = copy.deepcopy(self._present, memo)
        other._dropped = copy.deepcopy(self._dropped, memo)
        other._added = copy.deepcopy(self._added, memo)
        other._replaced = copy.deepcopy(self._replaced, memo)
        for owner in self._order:
            if dict.__contains__(self, owner):
                dict.__setitem__(other, owner,
                                 copy.deepcopy(dict.__getitem__(self, owner), memo))
        other._snaps = copy.deepcopy(self._snaps, memo)
        return other

    def __reduce_ex__(self, protocol: int) -> Any:
        self.materialize_all()
        return super().__reduce_ex__(protocol)


class NodesMap(dict[str, Any]):
    """The `nodes` section with PER-NODE read barriers (rearchitecture
    Phase B). A real dict of node id → node doc; the only addition is
    bookkeeping of which node values have been EXPOSED MUTABLY since the
    marks were last cleared — obtaining a node dict is the ability to mutate
    it, so exposure is the conservative super-set of mutation. The
    access-scoped save re-serializes exactly the exposed nodes and carries
    the stored baseline for the rest, which is what turns the 81 ms
    all-nodes dump of every save into a per-change cost.

    Key reads (`in`, `keys()`, iteration, `len`) expose no value and mark
    nothing. Whole-dict value walks (`values`, `items`, `copy`) mark
    everything — a chart walk inside a write cycle costs that write a full
    node dump, which is still never WRONG, only conservative. Instance
    state is plain data so `copy.deepcopy` (the ledger's rollback snapshot)
    keeps working."""

    _STATE_DEFAULTS: dict[str, Callable[[], Any]] = {
        "_touched": set, "_touched_all": bool,
    }

    def __getattr__(self, name: str) -> Any:
        factory = NodesMap._STATE_DEFAULTS.get(name)
        if factory is None:
            raise AttributeError(name)
        v = factory()
        object.__setattr__(self, name, v)
        return v

    def __init__(self, src: dict[str, Any] | None = None) -> None:
        super().__init__(src or {})
        self._touched: set[str] = set()
        self._touched_all: bool = False

    def _mark_clear(self) -> None:
        self._touched = set()
        self._touched_all = False

    def __getitem__(self, nid: str) -> Any:
        v = dict.__getitem__(self, nid)
        self._touched.add(nid)
        return v

    def get(self, nid: str, default: Any = None) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        try:
            return self[nid]
        except KeyError:
            return default

    def setdefault(self, nid: str, default: Any = None) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        self._touched.add(nid)
        return dict.setdefault(self, nid, default)

    def __setitem__(self, nid: str, v: Any) -> None:
        self._touched.add(nid)
        dict.__setitem__(self, nid, v)

    def __delitem__(self, nid: str) -> None:
        self._touched.add(nid)
        dict.__delitem__(self, nid)

    def pop(self, nid: str, *default: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        self._touched.add(nid)
        return dict.pop(self, nid, *default)

    def popitem(self) -> tuple[str, Any]:
        self._touched_all = True
        return dict.popitem(self)

    def update(self, *a: Any, **kw: Any) -> None:  # pyright: ignore[reportIncompatibleMethodOverride]
        # route through __setitem__ so every written key is marked
        for m in a:
            for k, v in (m.items() if isinstance(m, dict)
                         else cast("Iterable[tuple[str, Any]]", m)):
                self[k] = v
        for k, v in kw.items():
            self[k] = v

    def clear(self) -> None:
        self._touched_all = True
        dict.clear(self)

    def values(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        self._touched_all = True
        return dict.values(self)

    def items(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        self._touched_all = True
        return dict.items(self)

    def copy(self) -> dict[str, Any]:  # pyright: ignore[reportIncompatibleMethodOverride]
        self._touched_all = True
        return dict(dict.items(self))


class LazyDoc(dict[str, Any]):
    """The org document as `save_org`/`load_org` hand it to `ledger.Org` under
    the SQLite backend (§4.2). A real `dict` — `ledger.py` never learns the
    difference — holding every small section and `nodes` eagerly; the heavy
    log sections are ABSENT from the underlying storage until first touched
    and then load from their row tables (`__missing__`).

    Everything `dict` will not route through `__missing__` is overridden:

      get          `.get()` never calls `__missing__` — the #1 way to read
                   None for a 4 MB section
      __contains__ `"mail_log" in d` is True before materialisation (iff the
                   section exists in the database — a fresh org has none,
                   exactly as its JSON would not)
      setdefault   the dominant ledger idiom
      pop / del    `d.pop("account_token_uuid", None)`; a popped lazy section
                   is remembered (`_dropped`) so the save deletes its rows
      keys/items/values/__iter__/__len__/__eq__/__repr__/copy
                   whole-doc walks materialise everything first
      update / |=  `dict.update` writes straight into storage, bypassing
                   `__setitem__` — routed through it instead

    Verified hazards (§4.2): `json.dumps(d)` and `copy.deepcopy(d)` both go
    through `items()` and are safe. `{**d}` and `dict(d)` DO NOT — they read
    the storage directly and silently drop every unmaterialised section. The
    pre-flight grep for those over `backend/orgtree/` returned zero hits at
    `ec74e2f`; `materialize_all()` exists for any site that ever needs it.

    Instance state is plain data only (strings, lists, sets) so that
    `copy.deepcopy(org.d)` (ledger batch_move's rollback snapshot) produces a
    complete, independently saveable `LazyDoc`. Never hang a connection or a
    callable off this object."""

    # `pickle` restores a dict subclass in the order NEWOBJ → dictitems →
    # BUILD, i.e. it calls `__setitem__` BEFORE `__dict__` exists (the
    # opposite of `copy._reconstruct`, which applies state first — which is
    # why deepcopy works and pickle raised `AttributeError: _dropped`).
    # Rather than special-case pickle, every piece of instance state has a
    # lazily-minted per-instance default, so no method can meet a
    # half-built LazyDoc. Class-level MUTABLE defaults would be shared
    # across instances and are exactly the bug this avoids.
    _STATE_DEFAULTS: dict[str, Callable[[], Any]] = {
        "_slug": str, "_snap_doc": dict, "_snap_nodes": dict,
        "_snap_logs": dict, "_key_order": list, "_present": set,
        "_dropped": set, "_pending": dict, "_touched": set,
        "_lazy_exposed": set,
    }

    def __getattr__(self, name: str) -> Any:
        factory = LazyDoc._STATE_DEFAULTS.get(name)
        if factory is None:
            raise AttributeError(name)
        v = factory()
        object.__setattr__(self, name, v)
        return v

    def __init__(self, slug: str) -> None:
        super().__init__()
        self._slug: str = slug
        # what the database held when this doc was loaded — the other half of
        # compare-on-save. Strings are `_dumps()` output.
        self._snap_doc: dict[str, str] = {}            # small key → val
        self._snap_nodes: dict[str, str] = {}          # node id → val
        self._snap_logs: dict[str, Any] = {}           # sect → list[str] | dict[owner, list[str]]
        self._key_order: list[str] = []                # top-level keys as loaded
        self._present: set[str] = set()                # lazy sections that exist in the db
        self._dropped: set[str] = set()                # lazy sections popped since load
        # §4.7 append-only fast path: rows destined for a list-log section
        # that NOBODY HAS READ. See `log_append`.
        self._pending: dict[str, list[Any]] = {}
        # narrow reads of a list-log section that was never materialised, keyed
        # by (section, fields). See `project`. Per-document, so the docket's two
        # counting loops and the tree badge share one read; dropped with the
        # document, and invalidated by `__setitem__`/`pop` like anything else
        # derived from a section.
        self._proj: dict[tuple[str, tuple[str, ...]], list[dict[str, Any]]] = {}

    # -- materialisation --------------------------------------------------
    def log_append(self, k: str, row: Any) -> None:
        """Append one row to a list-log section WITHOUT materialising it.

        The append-only sections (`events`, `notice_log`, …) are the ones a
        lifecycle op writes and never reads, and they grow without bound —
        measured 2026-09-11 on the operator's org: 19,049 `events` rows
        (4.19 MB) and 1,815 `notice_log` rows (1.07 MB). Reaching them
        through `d[k].append(...)` costs a `json.loads` of every existing row
        on the way in and a `_dumps` of every existing row on the way out,
        for one new row — about 170 ms of the ~220 ms an idle hire, retire or
        move spends in the ledger and the save.

        ⚠ THE SAFETY ARGUMENT IS THE WHOLE DESIGN. `_write_log_rows`
        re-serialises every entry precisely so that a NESTED edit
        (`d["events"][5]["detail"] = …`, which no list method observes) still
        reaches the database. A buffered row cannot weaken that: this path is
        taken only while the section is unmaterialised, and a caller that has
        never obtained an entry cannot have edited one. The moment anything
        reads the section, `__missing__` loads it, folds the buffer in, and
        every later save is byte-for-byte the old behaviour.

        Falls back to the ordinary materialising append whenever the fast
        path's premise does not hold: a dict-log, a section already read, one
        deleted since load, or one stored as a wrong-shape `doc` blob (which
        `_write_lazy` has to rewrite whole anyway)."""
        self._drop_proj(k)
        if (k not in LAZY_SECTIONS or k in DICT_LOGS or k in self._dropped
                or k in self._snap_doc or dict.__contains__(self, k)):
            self.setdefault(k, []).append(row)
            return
        self._pending.setdefault(k, []).append(row)

    def __missing__(self, k: str) -> Any:
        self._drop_proj(k)
        pending = self._pending.pop(k, None)
        if k in LAZY_SECTIONS and k in self._present and k not in self._dropped:
            v = _load_section(self._slug, k, self._snap_logs)
            if pending:
                v.extend(pending)
            dict.__setitem__(self, k, v)
            return v
        if pending:
            # a section with no rows on disk yet: the buffer IS the section
            v = AppendLog(pending)
            dict.__setitem__(self, k, v)
            return v
        raise KeyError(k)

    def resident(self, k: str) -> bool:
        """Is section `k` ALREADY materialised in this document?

        Callers ask so they can stop narrowing something they are already
        holding whole. `project` on a resident section is correct but pure
        waste — MEASURED at 17 ms building a second, smaller copy of 509
        archived rows that were already in memory, on a call that had just spent
        48 ms materialising them. A caller with a cheap path over the real list
        should take it."""
        return dict.__contains__(self, k)

    def project(self, k: str, fields: tuple[str, ...]) -> list[dict[str, Any]]:
        """`fields` of every row of list-log section `k`, WITHOUT materialising
        it — SQLite extracts them in C and only the named values cross into
        Python.

        THE PROBLEM THIS SOLVES. `work_items_archive` is 508 rows and 10.17 MB
        on the operator's org, and the docket's two counting loops walked all of
        it to produce four integers — so a cold `orgtree_work list`, and every
        cold `Ledger.tree()` behind the UI poll, paid a 10.4 MB parse for a
        count. MEASURED on that org with a pooled connection: materialising is
        51.4 ms and 10,445,177 B of Python objects; this is 22.8 ms and
        196,892 B. SQLite still scans the rows — the win is that 98% of them
        never become Python objects — so this is a narrower read, not a free
        one.

        ⚠ A MISSING KEY COMES BACK AS `None`, which is exactly what
        `it.get(field)` already yields on the full item. That is what lets the
        CALLER run its existing predicates unchanged on the projected mapping
        instead of growing a second classifier that can disagree with the first
        one. Callers must therefore project every field their predicates read;
        `ledger._WORK_PROJ` is the docket's list.

        ⚠ THE DATABASE IS NOT ALWAYS THE TRUTH, and each of these falls back to
        the ordinary materialising read rather than answering from stale rows:
        a section already resident (somebody has it, and may have EDITED an
        entry in place); one with buffered appends (`log_append`, rows not in
        the db yet); one popped since load; one stored as a wrong-shape `doc`
        blob; and a dict-log, which has no `log_l` rows at all. In every one of
        those the projection is taken from the in-memory list, so there is one
        answer, never two.
        """
        if k in DICT_LOGS or k not in LAZY_SECTIONS:
            raise ValueError(f"not a projectable list-log section: {k!r}")
        if len(fields) < 2:
            # ⚠ REFUSED, NOT HANDLED. `json_extract` with ONE path returns the
            # value itself — TEXT for a JSON string, the JSON text for an
            # object — and those two are indistinguishable afterwards, so a
            # one-field projection would silently parse `"done"` as JSON and
            # either raise or, worse, succeed on a value that happens to look
            # like JSON. Several paths return a JSON array, which is
            # unambiguous. Ask for two fields.
            raise ValueError(
                "project() needs at least 2 fields: json_extract with a single "
                "path returns a bare value that cannot be told apart from JSON "
                f"text (asked for {fields!r} on {k!r})")
        key = (k, fields)
        cached = self._proj.get(key)
        if cached is not None:
            return cached
        rows: list[dict[str, Any]]
        if (dict.__contains__(self, k) or k in self._dropped
                or k in self._pending or k in self._snap_doc
                or k not in self._present):
            # resident, edited, buffered, dropped, blobbed or absent — read it
            # the ordinary way and project in Python. Same answer, no shortcut.
            rows = [{f: it.get(f) for f in fields}
                    for it in (self.get(k) or [])
                    if isinstance(it, dict)]
        else:
            paths = ",".join("'$." + f + "'" for f in fields)
            with _POOL.acquire(self._slug) as conn:
                raw = [r[0] for r in conn.execute(
                    f"SELECT json_extract(val,{paths}) FROM log_l "
                    f"WHERE sect=? ORDER BY seq", (k,))]
            rows = [dict(zip(fields, json.loads(v))) for v in raw]
        self._proj[key] = rows
        return rows

    def materialize_all(self) -> None:
        for k in (*LAZY_SECTIONS, *list(self._pending)):
            if not dict.__contains__(self, k):
                with contextlib.suppress(KeyError):
                    self[k]
            if dict.__contains__(self, k):
                value = dict.__getitem__(self, k)
                if isinstance(value, SectionMap):
                    value.materialize_all()

    def _unmaterialized(self) -> set[str]:
        return {k for k in (self._present | set(self._pending))
                if not dict.__contains__(self, k) and k not in self._dropped}

    # -- the read barrier (rearchitecture Phase B) ------------------------
    # Which top-level EAGER keys have been exposed mutably since the marks
    # were last cleared. Obtaining a mutable value is the ability to edit it,
    # so exposure is the conservative super-set of mutation; the
    # access-scoped save re-serializes exactly these and carries the stored
    # baseline for the rest. Lazy sections are deliberately never marked —
    # their row-level diff is already proportional to what changed. Scalars
    # are never marked — a returned str/int/bool cannot edit the document.
    def _mark(self, k: str, v: Any) -> None:
        if k in LAZY_SECTIONS:
            # lazy sections diff by row and cannot be cheaply re-verified at
            # a write_org release, so exposure is recorded and an exposure
            # left standing after the last save costs residency (see
            # write_org) rather than risking an unsaved row edit riding a
            # later caller's save
            if isinstance(v, (dict, list)):
                self._lazy_exposed.add(k)
        elif isinstance(v, (dict, list)):
            self._touched.add(k)

    def _mark_clear(self) -> None:
        self._touched = set()
        self._lazy_exposed = set()
        nodes = dict.get(self, "nodes")
        if isinstance(nodes, NodesMap):
            nodes._mark_clear()

    def __getitem__(self, k: str) -> Any:
        v = dict.__getitem__(self, k)   # __missing__ handles the lazy load
        self._mark(k, v)
        return v

    # -- the overrides ----------------------------------------------------
    def __contains__(self, k: object) -> bool:
        return (dict.__contains__(self, k)
                or (isinstance(k, str) and k in self._pending)
                or (isinstance(k, str) and k in LAZY_SECTIONS
                    and k in self._present and k not in self._dropped))

    def get(self, k: str, default: Any = None) -> Any:   # pyright: ignore[reportIncompatibleMethodOverride]
        try:
            return self[k]
        except KeyError:
            return default

    def setdefault(self, k: str, default: Any = None) -> Any:   # pyright: ignore[reportIncompatibleMethodOverride]
        if k in self:
            return self[k]
        if k in LIST_LOGS and isinstance(default, list) and not default \
                and k not in self._dropped and k not in self._snap_doc:
            # PG-3d: a list log with NO rows when this document loaded. Give
            # it the empty baseline it really had, row-tracked, so its save
            # INSERTS its rows. Without one the save took the "unprovable
            # journal" path — replace the whole section — and deleted rows
            # another writer appended meanwhile (measured: two org_tx each
            # recording a lifecycle row, the second commit erased the first).
            v = AppendLog((), rows=[])
            self._snap_logs[k] = []
            self[k] = v
            return v
        self[k] = default
        return default

    def _drop_proj(self, k: str | None = None) -> None:
        """Discard cached `project()` reads of `k` (all of them when `k` is
        None).

        ⚠ THE MATERIALISATION IS THE GATE, and that is what makes the cache
        safe rather than merely fast. An entry of a lazy section cannot be
        edited in place by a caller that has not first OBTAINED it, and
        obtaining it goes through `__missing__`. So dropping the projection
        there means a cached one can never outlive the last moment the rows
        were the whole truth: afterwards `project()` finds the section resident
        and re-projects from memory, which sees the edit. Every other route
        that can change a section's content — replace, delete, buffered append,
        clear — drops it too."""
        if k is None:
            self._proj.clear()
        elif self._proj:
            for key in [key for key in self._proj if key[0] == k]:
                del self._proj[key]

    def __setitem__(self, k: str, v: Any) -> None:
        self._drop_proj(k)
        self._dropped.discard(k)
        if k not in LAZY_SECTIONS:
            self._touched.add(k)
        # §4.7: REPLACING a section discards anything buffered for it. Without
        # this, `_write_doc` would write the new value through `_write_lazy`
        # AND still insert the buffered rows beside it — the one way the fast
        # path could duplicate a write. (`__missing__` sets the key with
        # `dict.__setitem__`, deliberately bypassing this, because it has
        # already folded the buffer into the value it is storing.)
        self._pending.pop(k, None)
        dict.__setitem__(self, k, v)

    def __delitem__(self, k: str) -> None:
        self._drop_proj(k)
        if k in self and not dict.__contains__(self, k):
            self[k]                         # materialise so the semantics match a dict
        dict.__delitem__(self, k)
        self._pending.pop(k, None)
        if k in LAZY_SECTIONS:
            self._dropped.add(k)
        else:
            self._touched.add(k)

    def pop(self, k: str, *default: Any) -> Any:   # pyright: ignore[reportIncompatibleMethodOverride]
        if k in self:
            v = self[k]
            del self[k]
            return v
        if default:
            return default[0]
        raise KeyError(k)

    def popitem(self) -> tuple[str, Any]:
        self._drop_proj()
        self.materialize_all()
        k, v = dict.popitem(self)
        if k in LAZY_SECTIONS:
            self._dropped.add(k)
        else:
            self._touched.add(k)
        return k, v

    def update(self, *a: Any, **kw: Any) -> None:   # pyright: ignore[reportIncompatibleMethodOverride]
        for k, v in dict(*a, **kw).items():
            self[k] = v

    def __ior__(self, other: Any) -> Any:   # pyright: ignore[reportIncompatibleMethodOverride]
        self.update(other)
        return self

    def clear(self) -> None:
        # ⚠ every lazy section the DATABASE holds has to be marked dropped,
        # not just the ones stored as rows. A section whose value had the
        # wrong shape lives in `doc` as a blob (`_write_lazy`) and is NOT in
        # `_present`, and `_write_doc`'s doc-row delete sweep deliberately
        # skips LAZY_SECTIONS — so before this line a blobbed section
        # survived `clear()` and came back on the next load. Measured.
        self._dropped |= self._present
        self._dropped |= {k for k in LAZY_SECTIONS if dict.__contains__(self, k)}
        self._dropped |= {k for k in self._pending if k in LAZY_SECTIONS}
        self._touched |= {k for k in dict.keys(self) if k not in LAZY_SECTIONS}
        self._pending.clear()
        self._drop_proj()
        dict.clear(self)

    def _mark_all(self) -> None:
        """A whole-document VALUE walk exposes every eager section mutably."""
        self._touched |= {k for k in dict.keys(self) if k not in LAZY_SECTIONS}

    def keys(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.keys(self)

    def items(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        self._mark_all()
        return dict.items(self)

    def values(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        self._mark_all()
        return dict.values(self)

    def __iter__(self) -> Iterator[str]:
        self.materialize_all()
        return dict.__iter__(self)

    def __bool__(self) -> bool:
        # Same trap `SectionMap.__bool__` above already documents: without
        # this, `bool(doc)` / `(doc or default)` falls back to `__len__`,
        # materialising every lazy section (every node's mail_log, turns,
        # etc.) just to answer a truthiness check. A loaded org document
        # always has a raw key (`slug`) or a lazy section on record —
        # `local_net_slugs`' `(loaded or {})` hit this materialising the
        # whole doc for one already-loaded org, measured costing the
        # majority of an `org_tree` render.
        #
        # ⚠ `_present` alone overcounts: `clear()` and deleting/popping a
        # section both leave it in `_present` while adding it to `_dropped`
        # (see both methods below) — a cleared or fully-emptied doc must
        # not read as truthy. Same exclusion `__contains__` already applies.
        return (dict.__len__(self) > 0 or bool(self._present - self._dropped)
                or bool(self._pending))

    def __len__(self) -> int:
        self.materialize_all()
        return dict.__len__(self)

    def __eq__(self, other: object) -> bool:
        self.materialize_all()
        return dict.__eq__(self, other)

    def __ne__(self, other: object) -> Any:
        # `dict.__eq__` returns NotImplemented against a non-dict, and
        # `not NotImplemented` is False with a DeprecationWarning — so the
        # obvious spelling made `doc != 5` answer False. Hand NotImplemented
        # back and let Python decide (which gives True), as dict does.
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    __hash__ = None  # type: ignore[assignment]  # dicts are unhashable; keep it so

    def __repr__(self) -> str:
        self.materialize_all()
        return dict.__repr__(self)

    def copy(self) -> dict[str, Any]:   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict(dict.items(self))


# -------------------------------------------------------------- readers
def _meta_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT val FROM meta WHERE key=?", (key,)).fetchone()
    return None if row is None else cast(str, row[0])


def _meta_set(conn: sqlite3.Connection, key: str, val: str) -> None:
    conn.execute("INSERT INTO meta(key,val) VALUES(?,?) "
                 "ON CONFLICT(key) DO UPDATE SET val=excluded.val", (key, val))


def _owners_of(conn: sqlite3.Connection, sect: str, *,
               include_orphans: bool = True) -> list[str]:
    """Owner order for a dict log.

    Canonical databases record it in metadata. Hot lazy loads trust that
    transactionally-maintained row and do not scan other owners merely to
    enumerate them. Eager export/migration reconstruction also appends any
    orphaned owner rows defensively.
    """
    raw = _meta_get(conn, _META_OWNERS + sect)
    owners: list[str] = cast("list[str]", json.loads(raw)) if raw else []
    if raw is not None and not include_orphans:
        return owners
    seen = set(owners)
    for (o,) in conn.execute(
            "SELECT owner FROM log_d WHERE sect=? GROUP BY owner ORDER BY MIN(seq)",
            (sect,)):
        if o not in seen:
            owners.append(cast(str, o))
            seen.add(o)
    return owners


def _read_dict_log(conn: sqlite3.Connection, sect: str, slug: str = ""
                   ) -> tuple[dict[str, list[tuple[int, str]]], SectionMap]:
    """Fully reconstruct one dict log on ``conn``.

    Hot LazyDoc reads do not call this: they create a metadata-only
    ``SectionMap`` in ``_load_section`` and select one owner on demand.
    Migration verification/export need the complete value and use this path.
    """
    owners = _owners_of(conn, sect)
    snaps: dict[str, list[tuple[int, str]]] = {o: [] for o in owners}
    for owner, seq, val in conn.execute(
            "SELECT owner, seq, val FROM log_d WHERE sect=? ORDER BY seq",
            (sect,)).fetchall():
        snaps.setdefault(cast(str, owner), []).append(
            (cast(int, seq), cast(str, val)))
    out = SectionMap(slug, sect, owners)
    for owner in owners:
        rows = snaps[owner]
        log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
        out._snaps[owner] = log._rows
        dict.__setitem__(out, owner,
                         AttemptMap(log) if sect in KEYED_DICT_LOGS else log)
    # This is the eager reconstruction path used by export/migration.  Drop
    # SectionMap's private JSON-encoder seed before returning a plain-looking
    # fully materialized mapping.
    out.materialize_all()
    return snaps, out


def _read_list_log(conn: sqlite3.Connection, sect: str
                   ) -> tuple[list[tuple[int, str]], AppendLog]:
    rows = [(cast(int, seq), cast(str, val)) for seq, val in conn.execute(
        "SELECT seq, val FROM log_l WHERE sect=? ORDER BY seq",
        (sect,)).fetchall()]
    return rows, AppendLog((json.loads(val) for _, val in rows), rows=rows)


def _load_section(slug: str, sect: str, snap_logs: dict[str, Any]) -> Any:
    """`LazyDoc.__missing__`: one lazy section from its rows, recording the
    row strings in the doc's snapshot for compare-on-save. A section stored as
    a `doc` blob (a value of the wrong shape — see `_write_lazy`) comes back
    from there instead."""
    t0 = time.perf_counter()
    with _POOL.acquire(slug) as conn:
        row = conn.execute("SELECT val FROM doc WHERE key=?", (sect,)).fetchone()
        if row is not None:
            snap_logs[sect] = cast(str, row[0])
            value = json.loads(cast(str, row[0]))
            stateprobe.record("lazy_section",
                              ms=(time.perf_counter() - t0) * 1000.0,
                              nbytes=len(cast(str, row[0])), section=sect)
            return value
        if sect in DICT_LOGS:
            # Owner names/order are cheap metadata. Row baselines remain
            # empty until SectionMap loads a particular owner.
            sm = SectionMap(
                slug, sect, _owners_of(conn, sect, include_orphans=False))
            snap_logs[sect] = sm._snaps
            stateprobe.record("lazy_section",
                              ms=(time.perf_counter() - t0) * 1000.0,
                              nbytes=0, section=f"{sect}[meta]")
            return sm
        rows_l, al = _read_list_log(conn, sect)
        snap_logs[sect] = rows_l
        stateprobe.record("lazy_section", ms=(time.perf_counter() - t0) * 1000.0,
                          nbytes=sum(len(v) for _, v in rows_l), section=sect)
        return al


def _load_lazy(conn: sqlite3.Connection, slug: str,
               preload: Iterable[str] = (), *, txn_open: bool = False) -> LazyDoc:
    """Load eager rows plus an optional coherent set of lazy sections.

    Ordinary loads pass no ``preload`` and retain S1's owner-selective lazy
    reads. A snapshot load names the lazy sections its projection combines
    with eager fields; those sections are fully read on this same connection
    and inside this same short transaction. The transaction ends before the
    returned ``Org`` can do arbitrary work.

    The guarantee is bounded: eager fields and named sections share one
    SQLite snapshot. An unnamed lazy section may load from a newer revision.
    """
    selected = frozenset(preload)
    unknown = selected - LAZY_SECTIONS
    if unknown:
        raise ValueError(f"not lazy sections: {sorted(unknown)!r}")
    d = LazyDoc(slug)
    preloaded: dict[str, Any] = {}
    preload_snaps: dict[str, Any] = {}
    if not txn_open:
        conn.execute("BEGIN")
    try:
        raw_order = _meta_get(conn, _META_KEY_ORDER)
        key_order: list[str] = cast("list[str]", json.loads(raw_order)) if raw_order else []
        schema_version = _meta_get(conn, "schema_version")
        # ⚠ fetchall() FIRST, comprehension SECOND — one C call per result
        # set. Iterating a live cursor from Python yields the GIL at every
        # row, and under concurrent Python-busy threads each yield costs a
        # full switch interval: 709 rows × ~5 ms stolen slices turned this
        # 100 ms load into 18-20 s (measured, 2026-09-19 incident).
        doc_rows: dict[str, str] = {cast(str, k): cast(str, v) for k, v in
                                    conn.execute("SELECT key, val FROM doc").fetchall()}
        node_rows = [(cast(str, i), cast(str, v)) for i, v in
                     conn.execute("SELECT id, val FROM nodes ORDER BY ord").fetchall()]
        d._eager_bytes = (sum(len(v) for v in doc_rows.values())
                          + sum(len(v) for _, v in node_rows))
        present: set[str] = set()
        for sect in DICT_LOGS:
            if conn.execute("SELECT 1 FROM log_d WHERE sect=? LIMIT 1", (sect,)).fetchone() \
                    or _meta_get(conn, _META_OWNERS + sect) is not None:
                present.add(sect)
        for sect in LIST_LOGS:
            if conn.execute("SELECT 1 FROM log_l WHERE sect=? LIMIT 1", (sect,)).fetchone():
                present.add(sect)
        # A recorded key is present even when it has zero rows. Resolve this
        # before preloading so an empty selected section is frozen as empty,
        # rather than left for __missing__ to discover after another commit.
        for k in key_order:
            if k in LAZY_SECTIONS and k not in doc_rows:
                present.add(k)

        effective = set(selected)
        if selected:
            # Org.__init__ performs a marker-keyed legacy mail-id backfill.
            # On an unmarked document it reads mail_log even when the route
            # did not name that section, so bind that exceptional read to the
            # same snapshot as construction's eager fields.
            raw_migrations = doc_rows.get("_migrations")
            migrations = json.loads(raw_migrations) if raw_migrations else {}
            if not isinstance(migrations, dict) \
                    or Org.MAIL_LOG_ID_MIGRATION not in migrations:
                effective.add("mail_log")

        for sect in LAZY_SECTIONS:
            if sect not in effective or sect in doc_rows or sect not in present:
                continue
            if sect in DICT_LOGS:
                snaps, value = _read_dict_log(conn, sect, slug)
            else:
                snaps, value = _read_list_log(conn, sect)
            preload_snaps[sect] = snaps
            preloaded[sect] = value
    except BaseException:
        # Never return a connection to the pool with a live read transaction,
        # including on JSON decoding or row construction failure.
        if conn.in_transaction:
            with contextlib.suppress(Exception):
                conn.execute("ROLLBACK")
        raise
    else:
        try:
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                with contextlib.suppress(Exception):
                    conn.execute("ROLLBACK")
            raise
    if schema_version is None:
        # ⚠ THE DURABILITY CHECK THE JSON BACKEND GOT FOR FREE. A JSON doc
        # that is zero-length or truncated raises `JSONDecodeError`, and
        # `_scan_orgs` skips it; SQLite is far more forgiving — a ZERO-LENGTH
        # file is a perfectly valid EMPTY database, and a file truncated past
        # page 1 often reads as one too. Measured on this branch before this
        # check existed: `open(db,"wb").close()` made `load_org` hand back a
        # document with no nodes and no history (it died later, incidentally,
        # on `KeyError('nodes')` inside `Org.__init__`) and made `list_orgs`
        # render the org as REAL AND EMPTY — 182 archived seats presented as
        # "this org has nothing in it" rather than as an error.
        # Every database this module writes carries `schema_version` from its
        # first committed transaction (`migrate_org`, and `_write_doc` for a
        # `create_org`), so its absence means the file is not one of ours or
        # is no longer intact. Fail LOUDLY, exactly as the JSON path does.
        raise LedgerError(
            f"{_db_path(slug) if slug else 'database'!r} is not an intact "
            "orgtree database (no schema_version row) — it may be truncated "
            "or zero-length; restore it from deleted/ or from its "
            ".json.premigration")
    # anything on disk but missing from the recorded order goes at the end
    order = list(key_order)
    known = set(order)
    for k in doc_rows:
        if k not in known:
            order.append(k)
            known.add(k)
    if node_rows and "nodes" not in known:
        order.append("nodes")
        known.add("nodes")
    for k in sorted(present):
        if k not in known:
            order.append(k)
            known.add(k)
    for k in order:
        if k == "nodes" and "nodes" not in doc_rows:
            nodes: NodesMap = NodesMap()
            for nid, v in node_rows:
                dict.__setitem__(nodes, nid, json.loads(v))
                d._snap_nodes[nid] = v
            dict.__setitem__(d, "nodes", nodes)
        elif k in doc_rows:
            # includes a lazy-named key (or `nodes`) stored as a blob because
            # its value had the wrong shape
            d._snap_doc[k] = doc_rows[k]
            dict.__setitem__(d, k, json.loads(doc_rows[k]))
        elif k in LAZY_SECTIONS:
            if k in preloaded:
                d._snap_logs[k] = preload_snaps[k]
                dict.__setitem__(d, k, preloaded[k])
            # otherwise stays lazy
        # else: a key recorded in the order with nothing behind it — dropped
    # ⚠ `nodes` is kept UNCONDITIONALLY, not `and node_rows`. An org with no
    # hires yet has `nodes: {}` — a real, empty section, not a missing one —
    # and zero rows cannot tell the two apart on their own. `order` already
    # does: it contains "nodes" only when the recorded key order had it (i.e.
    # the document HAD the key when it was written) or when there are rows,
    # and the loop above materialises `{}` for every such key. Gating this
    # filter on `node_rows` as well dropped `nodes` from the key order of
    # every empty org, and `reconstruct_full` walks the key order — so the
    # section came back ABSENT rather than EMPTY. Two consequences, both
    # measured (probes/p13): `migrate_org` failed its own verifier with
    # "round-trip mismatch in sections: ['nodes']", leaving the org pending
    # and the backend refusing to start; and `export_json` — the documented
    # rollback path — wrote a document with no `nodes` key at all, which
    # `Org.__init__` cannot read back (`KeyError: 'nodes'`). The first is
    # fail-safe. The second is not. (phase1-audit, 2026-09-04.)
    d._key_order = [k for k in order if k in doc_rows
                    or k == "nodes"
                    or (k in LAZY_SECTIONS and k in present)]
    d._present = {k for k in present if k not in doc_rows}
    return d


def reconstruct_full(conn: sqlite3.Connection) -> dict[str, Any]:
    """The WHOLE document from rows, as a plain dict, in recorded key order.
    Used by the migration verifier and `export_json` — never on a hot path
    (§2.1)."""
    d = _load_lazy(conn, "")
    out: dict[str, Any] = {}
    for k in d._key_order:
        if dict.__contains__(d, k):
            out[k] = dict.__getitem__(d, k)
        elif k in DICT_LOGS:
            sm = _read_dict_log(conn, k)[1]
            # a keyed owner's value is an AttemptMap ({id: entry}); rebuild
            # the DOCUMENT shape — list() on it would enumerate its keys
            out[k] = {o: (dict(cast("dict[str, Any]", v))
                          if isinstance(v, AttemptMap)
                          else list(cast("list[Any]", v)))
                      for o, v in dict.items(sm)}
        elif k in LIST_LOGS:
            out[k] = list(_read_list_log(conn, k)[1])
    return out


# -------------------------------------------------------------- writers
_UPSERT_DOC = ("INSERT INTO doc(key,val) VALUES(?,?) "
               "ON CONFLICT(key) DO UPDATE SET val=excluded.val")


def _delete_log_seqs(conn: sqlite3.Connection, table: str,
                     seqs: Iterable[int]) -> None:
    ids = list(seqs)
    if not ids:
        return
    marks = ",".join("?" for _ in ids)
    conn.execute(f"DELETE FROM {table} WHERE seq IN ({marks})", ids)


def _write_log_rows(conn: sqlite3.Connection, table: str,
                    scope_sql: str, scope_args: tuple[Any, ...],
                    insert_sql: str, insert_prefix: tuple[Any, ...],
                    cur: list[Any], snap: list[tuple[int, str]] | None,
                    *, incremental: AppendLog | None = None,
                    cas_old: list[tuple[int, str]] | None = None
                    ) -> list[tuple[int, str]]:
    """Reconcile a single ordered log while retaining proven row identities.

    ``AppendLog._row_ids`` follows list mutations, including deletion among
    duplicated equal values. Existing ids must stay increasing and any new
    ``None`` ids must be a suffix; otherwise order cannot be represented by
    AUTOINCREMENT seq and this owner/section takes the safe full-rewrite path.
    Returned baselines are adopted only after the surrounding transaction
    commits, never while rollback is still possible.
    """
    strs = [_dumps(entry) for entry in cur]
    old = list(snap or [])
    old_by_id = {seq: val for seq, val in old}
    # PG-0 compare-and-set (see _ROW_CAS): the rows this save loaded for the
    # scope; a delete or update of one applies only if it still holds them
    cas = old if snap is not None else cas_old
    cas = cas if _ROW_CAS else None

    ids: list[int | None] | None = None
    if incremental is not None and not incremental.full_rewrite \
            and len(incremental._row_ids) == len(cur):
        candidate = list(incremental._row_ids)
        kept = [seq for seq in candidate if seq is not None]
        first_new = next((i for i, seq in enumerate(candidate) if seq is None), len(candidate))
        if (kept == sorted(kept) and len(kept) == len(set(kept))
                and all(seq in old_by_id for seq in kept)
                and all(seq is None for seq in candidate[first_new:])):
            ids = candidate

    if snap is not None and ids is not None:
        kept_ids = {cast(int, seq) for seq in ids if seq is not None}
        if cas is not None:
            for seq, oval in old:
                if seq not in kept_ids:
                    _cas(conn, f"DELETE FROM {table} WHERE seq=? AND val=?",
                         (seq, oval), f"{table} row {seq} ({scope_args[0]!r})")
        else:
            _delete_log_seqs(conn, table, (seq for seq, _ in old if seq not in kept_ids))
        result: list[tuple[int, str]] = []
        for entry, val, seq in zip(cur, strs, ids):
            if seq is None:
                cursor = conn.execute(insert_sql, (*insert_prefix, _at_of(entry), val))
                result.append((cast(int, cursor.lastrowid), val))
            else:
                if old_by_id[seq] != val:
                    if cas is not None:
                        _cas(conn, f"UPDATE {table} SET at=?, val=? WHERE seq=? AND val=?",
                             (_at_of(entry), val, seq, old_by_id[seq]),
                             f"{table} row {seq} ({scope_args[0]!r})")
                    else:
                        conn.execute(f"UPDATE {table} SET at=?, val=? WHERE seq=?",
                                     (_at_of(entry), val, seq))
                result.append((seq, val))
        return result

    # A plain list replacement, migration, reordering, or unprovable journal
    # falls back to an exact replacement of this bounded scope.
    if snap is not None and [val for _, val in old] == strs:
        return old
    if cas is not None:
        # replace only what this save loaded, row by row, and refuse if the
        # scope holds anything else (a row another writer committed since)
        for seq, oval in cas:
            _cas(conn, f"DELETE FROM {table} WHERE seq=? AND val=?", (seq, oval),
                 f"{table} row {seq} ({scope_args[0]!r})")
        row = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {scope_sql}",
                           scope_args).fetchone()
        if row is not None and int(row[0]) != 0:
            raise StaleWrite(f"{table} scope {scope_args!r} gained rows since this "
                             "save loaded it (another writer committed them); "
                             "nothing was written")
    else:
        conn.execute(f"DELETE FROM {table} WHERE {scope_sql}", scope_args)
    result = []
    for entry, val in zip(cur, strs):
        cursor = conn.execute(insert_sql, (*insert_prefix, _at_of(entry), val))
        result.append((cast(int, cursor.lastrowid), val))
    return result


def _write_dict_log(conn: sqlite3.Connection, sect: str, cur: dict[str, Any],
                    snap: dict[str, list[tuple[int, str]]] | None
                    ) -> dict[str, list[tuple[int, str]]]:
    """Reconcile loaded owners without touching unloaded owners."""
    keyed = sect in KEYED_DICT_LOGS

    def owner_entries(owner: str, value: Any) -> "list[Any]":
        """The row-shaped view of one owner's value. Ordered logs pass
        through; a keyed owner's dict becomes its [id, entry] pairs — via
        the backing log when it has one (row identity preserved), or by
        derivation for a plain dict (a fixture, a blob conversion)."""
        if isinstance(value, AttemptMap):
            return value._log                    # the backing log itself
        if keyed and isinstance(value, dict):
            return [[k, v] for k, v in cast("dict[str, Any]", value).items()]
        if not isinstance(value, list):
            raise LedgerError(
                f"{sect}[{owner!r}] must be a "
                f"{'dict' if keyed else 'list'}, not {type(value).__name__}")
        return cast("list[Any]", value)

    if not isinstance(cur, SectionMap) or snap is None:
        # Plain-dict save/migration/full section replacement: exact whole
        # section reconciliation, as before.
        conn.execute("DELETE FROM log_d WHERE sect=?", (sect,))
        new_snap: dict[str, list[tuple[int, str]]] = {}
        for owner, value in cur.items():
            entries = owner_entries(owner, value)
            new_snap[owner] = _write_log_rows(
                conn, "log_d", "sect=? AND owner=?", (sect, owner),
                "INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)",
                (sect, owner), entries, None)
        _meta_set(conn, _META_OWNERS + sect, _dumps(list(cur.keys())))
        return new_snap

    new_snap = {owner: list(rows) for owner, rows in snap.items()
                if owner in cur._present}
    for owner in cur._dropped:
        base = snap.get(owner)
        if _ROW_CAS and base is not None:
            for seq, oval in base:
                _cas(conn, "DELETE FROM log_d WHERE seq=? AND val=?", (seq, oval),
                     f"log_d row {seq} ({sect!r}, {owner!r})")
            row = conn.execute("SELECT COUNT(*) FROM log_d WHERE sect=? AND owner=?",
                               (sect, owner)).fetchone()
            if row is not None and int(row[0]) != 0:
                raise StaleWrite(f"{sect}[{owner!r}] gained rows since this save "
                                 "loaded it (another writer committed them); "
                                 "nothing was written")
        else:
            conn.execute("DELETE FROM log_d WHERE sect=? AND owner=?", (sect, owner))
        new_snap.pop(owner, None)
    # Walk loaded/new real owners in document order.  Raw dict iteration would
    # also see SectionMap's private JSON-encoder seed until a whole-map
    # operation has materialized the section.  Unloaded owner metadata is
    # deliberately not a row baseline and must remain untouched.
    for owner in cur._order:
        if not dict.__contains__(cur, owner):
            continue
        value = dict.__getitem__(cur, owner)
        entries = owner_entries(owner, value)
        if owner in cur._replaced:
            baseline = None
        else:
            baseline = snap.get(owner)
        row_log = value._log if isinstance(value, AttemptMap) else value
        new_snap[owner] = _write_log_rows(
            conn, "log_d", "sect=? AND owner=?", (sect, owner),
            "INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)",
            (sect, owner), entries, baseline,
            incremental=row_log if isinstance(row_log, AppendLog)
            and owner not in cur._replaced else None,
            cas_old=snap.get(owner))
    raw_old_owners = _meta_get(conn, _META_OWNERS + sect)
    # Owner names are a separate journal from loaded row snapshots. Merge
    # only this proxy's structural changes into the currently committed
    # order, so a stale document cannot erase a concurrently added owner or
    # resurrect one concurrently deleted but never touched here.
    if cur._dropped or cur._added:
        committed_order = cast(
            "list[str]", json.loads(raw_old_owners)) if raw_old_owners else []
        merged_order = [owner for owner in committed_order
                        if owner not in cur._dropped and owner not in cur._added]
        merged_order.extend(owner for owner in cur._order
                            if owner in cur._added and owner in cur._present)
        owners = _dumps(merged_order)
        if raw_old_owners != owners:
            _meta_set(conn, _META_OWNERS + sect, owners)
    return new_snap


def _write_list_log(conn: sqlite3.Connection, sect: str, cur: list[Any],
                    snap: list[tuple[int, str]] | None
                    ) -> list[tuple[int, str]]:
    return _write_log_rows(
        conn, "log_l", "sect=?", (sect,),
        "INSERT INTO log_l(sect, at, val) VALUES(?,?,?)", (sect,), cur, snap,
        incremental=cur if isinstance(cur, AppendLog) else None)


def _drop_lazy_rows(conn: sqlite3.Connection, sect: str) -> None:
    if sect in DICT_LOGS:
        conn.execute("DELETE FROM log_d WHERE sect=?", (sect,))
        conn.execute("DELETE FROM meta WHERE key=?", (_META_OWNERS + sect,))
    else:
        conn.execute("DELETE FROM log_l WHERE sect=?", (sect,))


def _write_lazy(conn: sqlite3.Connection, sect: str, value: Any,
                snap: Any, snap_doc: dict[str, str] | None,
                new_snap_doc: dict[str, str]) -> Any:
    """One lazy section: rows when it has the expected shape; a `doc` blob
    when it does not (a `None`, a string — anything JSON can hold and rows
    cannot). The format stores ANY document; the verifier decides whether it
    stored it right. Returns the new log snapshot (None when blobbed)."""
    expect_dict = sect in DICT_LOGS
    if (expect_dict and isinstance(value, dict)) or (not expect_dict and isinstance(value, list)):
        if snap_doc is None or sect in snap_doc:
            conn.execute("DELETE FROM doc WHERE key=?", (sect,))
        if isinstance(snap, str):
            snap = None
        if expect_dict:
            return _write_dict_log(conn, sect, cast("dict[str, Any]", value),
                                   cast("dict[str, list[tuple[int, str]]] | None", snap))
        return _write_list_log(conn, sect, cast("list[Any]", value),
                               cast("list[tuple[int, str]] | None", snap))
    # wrong shape → blob; make sure no rows linger
    _drop_lazy_rows(conn, sect)
    s = _dumps(value)
    new_snap_doc[sect] = s
    if snap_doc is None or snap_doc.get(sect) != s:
        conn.execute(_UPSERT_DOC, (sect, s))
    return None


#: PG-0: COMPARE-AND-SET row writes. While DOC_LOCK and `org_tx` coexist
#: (PYPG §3 step 6), a legacy save can hold a baseline for a row that an
#: org_tx has since changed; a plain `UPDATE … WHERE id=?` would silently
#: overwrite that commit. With this on, an UPDATE or DELETE of an existing doc
#: section or node row applies only if the row still holds the baseline this
#: save loaded, and otherwise the whole save rolls back with `StaleWrite`. On
#: for postgres; `ORGTREE_ROW_CAS=1/0` overrides (the SQLite fake tests use it).
_ROW_CAS = os.environ.get("ORGTREE_ROW_CAS",
                          "1" if STORE_BACKEND == "postgres" else "0").strip() == "1"


#: THE DECLARED ORG SINGLETON ROWS (plan decisions 26/33/34): doc rows that
#: always exist, with their cleared value as JSON text. Created by the save
#: that first lacks them (create_org included) and backfilled at claim on
#: postgres; a popped one is reset to its cleared value, never deleted.
#: Families EXTEND THIS LIST — nobody inserts an absent singleton ad hoc.
#:   killswitch        admissions take it FOR SHARE, the latch FOR UPDATE
#:   deleted_cost_usd  the tombstone burn accumulator (WS3b's user delete
#:                     adds to it inside org_tx); readers use `or 0.0`
ALWAYS_ROWS: dict[str, str] = {"killswitch": "null", "deleted_cost_usd": "0"}


class StaleWrite(LedgerError):
    """A save's row changed under it since it was loaded (another writer —
    an org_tx — committed it). Nothing was written; reload and retry."""


def _cas(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...], what: str) -> None:
    if conn.execute(sql, params).rowcount != 1:
        raise StaleWrite(f"{what} changed since this save loaded it "
                         "(another writer committed it); nothing was written")


def _write_doc(conn: sqlite3.Connection, d: dict[str, Any], lazy: LazyDoc | None,
               changes: SaveChanges | None = None
               ) -> tuple[dict[str, str], dict[str, str], dict[str, Any], list[str]]:
    """The body of a save transaction (§4.5), for both shapes of `Org.d`:

      lazy is a LazyDoc  compare-on-save against its snapshots; unmaterialised
                         sections are not touched at all
      lazy is None       `d` is a plain dict (Org.create, a test fixture, a
                         `json.loads` copy): reconcile everything against what
                         is in the database — every key upserted, every node
                         written, every log section rewritten, and whatever
                         the database holds that `d` does not is deleted

    `changes`, when given, is filled at the write statements themselves —
    exactly which doc keys, node ids and log sections this save touched
    (stateprobe.SaveChanges). The differ is the one place that knows this,
    and both the instrumentation and the section-granular read cache
    (rearchitecture Phases 0/A) consume it.

    Returns (snap_doc, snap_nodes, snap_logs, key_order) describing the
    database as it is after the commit, for the LazyDoc to adopt."""
    snap_doc = lazy._snap_doc if lazy is not None else None
    snap_nodes = lazy._snap_nodes if lazy is not None else None
    # storage view: for a LazyDoc, the raw dict contents (no materialisation —
    # that is the whole point); for a plain dict, the dict
    items = list(dict.items(d))
    new_doc: dict[str, str] = {}
    new_nodes: dict[str, str] = {}
    new_logs: dict[str, Any] = {}

    # -- small sections (`doc`) ------------------------------------------
    db_doc_keys: set[str] = set()
    if snap_doc is None:
        db_doc_keys = {cast(str, k) for (k,) in conn.execute("SELECT key FROM doc")}
    # the access-scoped save: a key never exposed mutably since the last
    # adopt cannot have changed, so its stored baseline stands without a
    # re-serialize. Anything without a baseline (a brand-new key is always
    # marked by __setitem__ anyway) falls through to the full path.
    touched = (lazy._touched
               if _SCOPED_SAVE and lazy is not None and snap_doc is not None
               else None)
    for k, v in items:
        if k in ROWED or k in LAZY_SECTIONS:
            continue
        if touched is not None and k not in touched \
                and snap_doc is not None and k in snap_doc:
            new_doc[k] = snap_doc[k]
            continue
        s = _dumps(v)
        new_doc[k] = s
        if changes is not None:
            changes.dumped_bytes += len(s)
        if snap_doc is None or snap_doc.get(k) != s:
            if _ROW_CAS and snap_doc is not None and k in snap_doc:
                _cas(conn, "UPDATE doc SET val=? WHERE key=? AND val=?",
                     (s, k, snap_doc[k]), f"section {k!r}")
            else:
                conn.execute(_UPSERT_DOC, (k, s))
            if changes is not None:
                changes.doc_upserts.append(k)
    known_doc = set(snap_doc) if snap_doc is not None else db_doc_keys
    # PG-0b (plan decisions 26 D2 / 33): an ALWAYS-PRESENT row is never
    # deleted — a save that lacks the key (popped, or never set) writes its
    # cleared value and puts it back into the document, so the row exists for
    # every FOR SHARE reader. SQLite plain-dict saves (create, the JSON
    # migration and its verifier) are left exactly as they were.
    if STORE_BACKEND == "postgres" or lazy is not None:
        for k, default in ALWAYS_ROWS.items():
            if dict.__contains__(d, k):
                continue
            if k in known_doc:
                old_v = snap_doc.get(k) if snap_doc is not None else None
                if _ROW_CAS and old_v is not None:
                    _cas(conn, "UPDATE doc SET val=? WHERE key=? AND val=?",
                         (default, k, old_v), f"section {k!r}")
                else:
                    conn.execute(_UPSERT_DOC, (k, default))
                if changes is not None:
                    changes.doc_upserts.append(k)
            else:
                cur = conn.execute("INSERT INTO doc(key,val) VALUES(?,?) "
                                   "ON CONFLICT(key) DO NOTHING", (k, default))
                # recorded, so readers' snapshots learn the key exists (an
                # org_tx's guard exempts exactly this insert; see orgtx)
                if changes is not None and getattr(cur, "rowcount", 0) != 0:
                    changes.doc_upserts.append(k)
            dict.__setitem__(d, k, json.loads(default))
            new_doc[k] = default
    for k in known_doc - set(new_doc) - LAZY_SECTIONS - set(ROWED):
        if _ROW_CAS and snap_doc is not None and k in snap_doc:
            _cas(conn, "DELETE FROM doc WHERE key=? AND val=?",
                 (k, snap_doc[k]), f"section {k!r}")
        else:
            conn.execute("DELETE FROM doc WHERE key=?", (k,))
        if changes is not None:
            changes.doc_deletes.append(k)

    # -- nodes (rows) ----------------------------------------------------
    has_nodes_key = dict.__contains__(d, "nodes")
    nodes_v = dict.get(d, "nodes")
    if has_nodes_key and not isinstance(nodes_v, dict):
        # `"nodes": null` (or anything else that is not a dict) — storable
        # only as a blob; the rows are emptied so nothing lingers
        conn.execute("DELETE FROM nodes")
        s = _dumps(nodes_v)
        new_doc["nodes"] = s
        if snap_doc is None or snap_doc.get("nodes") != s:
            conn.execute(_UPSERT_DOC, ("nodes", s))
    else:
        if "nodes" in known_doc:
            conn.execute("DELETE FROM doc WHERE key=?", ("nodes",))
        nodes: dict[str, Any] = cast("dict[str, Any]", nodes_v) if has_nodes_key else {}
        db_ids: set[str] | None = None
        if snap_nodes is None or "nodes" in known_doc:
            db_ids = {cast(str, i) for (i,) in conn.execute("SELECT id FROM nodes")}
        known_ids = db_ids if db_ids is not None else set(cast("dict[str, str]", snap_nodes))
        row = conn.execute("SELECT COALESCE(MAX(ord), -1) FROM nodes").fetchone()
        next_ord = cast(int, row[0]) + 1 if row is not None else 0
        # per-node scoping, same rule as the doc keys: a node row never
        # exposed mutably keeps its stored baseline. Disabled whenever the
        # baselines themselves are in doubt (plain dict, nodes-was-blob).
        node_touched: set[str] | None = None
        if touched is not None and isinstance(nodes, NodesMap) \
                and not nodes._touched_all and db_ids is None \
                and snap_nodes is not None:
            node_touched = nodes._touched
        # ⚠ dict.items, NOT nodes.items(): the differ itself must not trip
        # the read barrier it consumes
        for nid, nv in dict.items(nodes):
            if node_touched is not None and nid not in node_touched:
                sn = cast("dict[str, str]", snap_nodes).get(nid)
                if sn is not None:
                    new_nodes[nid] = sn
                    continue
            s = _dumps(nv)
            new_nodes[nid] = s
            if changes is not None:
                changes.dumped_bytes += len(s)
            if nid in known_ids:
                if snap_nodes is None or db_ids is not None or snap_nodes.get(nid) != s:
                    if _ROW_CAS and snap_nodes is not None and db_ids is None \
                            and nid in snap_nodes:
                        _cas(conn, "UPDATE nodes SET val=? WHERE id=? AND val=?",
                             (s, nid, snap_nodes[nid]), f"node {nid!r}")
                    else:
                        conn.execute("UPDATE nodes SET val=? WHERE id=?", (s, nid))
                    if changes is not None:
                        changes.node_updates.append(nid)
            else:
                conn.execute("INSERT INTO nodes(id, ord, val) VALUES(?,?,?)",
                             (nid, next_ord, s))
                next_ord += 1
                if changes is not None:
                    changes.node_inserts.append(nid)
        for nid in known_ids - set(new_nodes):
            if _ROW_CAS and snap_nodes is not None and db_ids is None \
                    and nid in snap_nodes:
                _cas(conn, "DELETE FROM nodes WHERE id=? AND val=?",
                     (nid, snap_nodes[nid]), f"node {nid!r}")
            else:
                conn.execute("DELETE FROM nodes WHERE id=?", (nid,))
            if changes is not None:
                changes.node_deletes.append(nid)
        if not has_nodes_key:
            new_nodes = {}

    # -- lazy sections ---------------------------------------------------
    if lazy is not None:
        for sect in LAZY_SECTIONS:
            if dict.__contains__(d, sect):
                before = conn.total_changes
                new_logs[sect] = _write_lazy(conn, sect, dict.__getitem__(d, sect),
                                             lazy._snap_logs.get(sect), snap_doc, new_doc)
                if changes is not None and conn.total_changes != before:
                    changes.log_sections.add(sect)
                    changes.log_rows += conn.total_changes - before
            elif sect in lazy._dropped:
                _drop_lazy_rows(conn, sect)
                if snap_doc is not None and sect in snap_doc:
                    conn.execute("DELETE FROM doc WHERE key=?", (sect,))
                if changes is not None:
                    changes.log_sections.add(sect)
        # §4.7: sections nobody read, only appended to (`LazyDoc.log_append`).
        # Pure INSERTs — the existing rows are not read, compared or rewritten,
        # and `log_l.seq` is AUTOINCREMENT so the appends land in order under
        # the reader's `ORDER BY seq`. A section that reached here has no
        # entry in `d`, so the loop above skipped it and cannot double-write.
        for sect, rows in lazy._pending.items():
            if not rows:
                continue
            for entry in rows:
                s = _dumps(entry)
                conn.execute("INSERT INTO log_l(sect, at, val) VALUES(?,?,?)",
                             (sect, _at_of(entry), s))
                if changes is not None:
                    changes.log_rows += 1
                    changes.dumped_bytes += len(s)
            if changes is not None:
                changes.log_sections.add(sect)
    else:
        for sect in LAZY_SECTIONS:
            if sect in d:
                before = conn.total_changes
                new_logs[sect] = _write_lazy(conn, sect, d[sect], None, None, new_doc)
                if changes is not None and conn.total_changes != before:
                    changes.log_sections.add(sect)
                    changes.log_rows += conn.total_changes - before
            else:
                _drop_lazy_rows(conn, sect)
                if sect in db_doc_keys:
                    conn.execute("DELETE FROM doc WHERE key=?", (sect,))

    # -- key order -------------------------------------------------------
    if lazy is not None:
        cur_keys = [k for k, _ in items]
        cur_set = set(cur_keys) | lazy._unmaterialized()
        order = [k for k in lazy._key_order if k in cur_set]
        seen = set(order)
        for k in cur_keys:
            if k not in seen:
                order.append(k)
                seen.add(k)
        # a lazy section present in the db but absent from the recorded order
        for k in sorted(lazy._unmaterialized()):
            if k not in seen:
                order.append(k)
                seen.add(k)
        if order != lazy._key_order:
            _meta_set(conn, _META_KEY_ORDER, _dumps(order))
    else:
        order = [k for k, _ in items]
        _meta_set(conn, _META_KEY_ORDER, _dumps(order))
    if _meta_get(conn, "schema_version") is None:
        _meta_set(conn, "schema_version", _SCHEMA_VERSION)
    return new_doc, new_nodes, new_logs, order


#: the per-org RESIDENT write document (rearchitecture Phase B): one
#: long-lived Org per slug, reused by every `write_org` cycle so the 11 MB
#: parse and the whole-tree Org construction are paid once per process
#: instead of once per write. Guarded by DOC_LOCK — only writers touch it.
_resident: dict[str, Org] = {}

#: PG-0 (`orgtx.py`): per-thread hooks an `org_tx` commit installs around its
#: one `save_org` — `guard(changes)` before COMMIT (raising rolls back) and
#: `on_commit(changes)` inside the snapshot gate right after it. Unset
#: everywhere else, so every other save is unchanged.
_orgtx_local = threading.local()


def _verify_scoped_save(d: dict[str, Any], lazy: LazyDoc) -> None:
    """Test-mode negative control for the read barrier: after a scoped save,
    every eager value must serialize to exactly its adopted baseline — any
    difference is a mutation the barrier missed, which the scoped save would
    have silently failed to write. Raises rather than logs: a missed write
    is corruption, not a warning."""
    for k in list(dict.keys(d)):
        if k in ROWED or k in LAZY_SECTIONS:
            continue
        s = _dumps(dict.__getitem__(d, k))
        if lazy._snap_doc.get(k) != s:
            raise RuntimeError(
                f"scoped save verification failed: doc key {k!r} differs "
                "from its adopted baseline — a mutation escaped the read "
                "barrier")
    nodes = dict.get(d, "nodes")
    if isinstance(nodes, dict):
        for nid in list(dict.keys(nodes)):
            s = _dumps(dict.__getitem__(nodes, nid))
            if lazy._snap_nodes.get(nid) != s:
                raise RuntimeError(
                    f"scoped save verification failed: node {nid!r} differs "
                    "from its adopted baseline — a mutation escaped the "
                    "read barrier")


def _save_sqlite(org: Org) -> None:
    slug = _safe_slug(org.d["slug"])
    d = cast("dict[str, Any]", org.d)
    lazy = d if isinstance(d, LazyDoc) and d._slug == slug else None
    _ensure_migrated(slug)
    changes = SaveChanges()
    t0 = time.perf_counter()
    # the one write path that may legitimately mint a database (`create_org`)
    with _POOL.acquire(slug, create=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            new_doc, new_nodes, new_logs, order = _write_doc(conn, d, lazy, changes)
            # PG-0: an `orgtx` transaction checks what it wrote against the
            # rows it locked; raising here rolls the whole save back.
            _txg = getattr(_orgtx_local, "guard", None)
            if _txg is not None:
                _txg(changes)
            if STORE_BACKEND == "postgres":
                # revision bump + NOTIFY org_rev, in this same transaction
                from . import pgstore
                pgstore.on_save_commit(cast("pgstore.PgConn", conn),
                                       not changes.is_empty())
            # {COMMIT, publish, seq bump} are one atom with respect to
            # snapshot rebuilds — see the invariant note on `_changed_lock`.
            # A commit outside the gate opens the exact window this closes: a
            # rebuild pins its read view after the commit but drains the
            # accumulator before the publish, and serves that save's other
            # sections stale forever.
            _gt0 = time.perf_counter()
            with _snap_gate(slug):
                _gw = time.perf_counter()
                conn.execute("COMMIT")
                if lazy is not None:
                    _publish_changes(slug, changes)
                else:
                    # a plain-dict save reconciles the whole database; the
                    # change record is not a trustworthy delta of it
                    _publish_changes_unknown(slug)
                _bump_org_seq(slug)
                _txc = getattr(_orgtx_local, "on_commit", None)
                if _txc is not None:
                    _txc(changes)
                stateprobe.record("gate_commit", ms=(time.perf_counter() - _gw) * 1000.0)
                stateprobe.record("gate_wait_commit", ms=(_gw - _gt0) * 1000.0)
        except BaseException:
            with contextlib.suppress(Exception):
                conn.execute("ROLLBACK")
            raise
    # a save through anything but the resident instance leaves the resident's
    # baselines stale — drop it; the next write_org reloads fresh. This is
    # what keeps the ~200 not-yet-converted legacy write cycles correct
    # beside residency during the incremental conversion.
    res = _resident.get(slug)
    # a save that wrote nothing (an org_tx whose body only read) cannot have
    # made the resident's baselines any staler than they were: keep it
    if res is not None and cast("dict[str, Any]", res.d) is not d \
            and not changes.is_empty():
        _resident.pop(slug, None)
    # dumped_bytes was counted at each real _dumps in the differ, so under
    # the scoped save the carried baselines cost — and report — nothing
    stateprobe.record("save_doc", ms=(time.perf_counter() - t0) * 1000.0,
                      nbytes=changes.dumped_bytes,
                      detail={"changed": changes.as_dict()}
                      if not changes.is_empty() else None)
    if lazy is not None:
        # the database now IS this document: adopt the new snapshot so a
        # second save of the same object compares against the right thing
        unmat = lazy._unmaterialized()
        # §4.7: a section whose pending rows were just inserted now has rows on
        # disk that no baseline of ours describes. Forget the stale baseline
        # rather than carrying it forward — `_load_section` re-reads it whole
        # on the next materialisation, and until then nothing may write it.
        flushed = {k for k, rows in lazy._pending.items() if rows}
        lazy._pending = {}
        for k in unmat:
            if k in lazy._snap_logs and k not in flushed:
                new_logs[k] = lazy._snap_logs[k]
        for k in LAZY_SECTIONS:
            if not dict.__contains__(d, k):
                continue
            value = dict.__getitem__(d, k)
            committed = new_logs.get(k)
            if isinstance(value, SectionMap) and isinstance(committed, dict):
                value._snaps = committed
                for owner in value._order:
                    if not dict.__contains__(value, owner):
                        continue
                    log = dict.__getitem__(value, owner)
                    if isinstance(log, AttemptMap):
                        log = log._log          # adopt into the backing log
                    owner_rows = committed.get(owner)
                    if isinstance(log, AppendLog) and owner_rows is not None:
                        log._adopt(owner_rows)
                value._dropped.clear()
                value._added.clear()
                value._replaced.clear()
            elif isinstance(value, AppendLog) and isinstance(committed, list):
                value._adopt(committed)
        lazy._snap_doc = new_doc
        lazy._snap_nodes = new_nodes
        lazy._snap_logs = {k: v for k, v in new_logs.items() if v is not None}
        # Preserve the shared snapshot identity between each SectionMap and
        # its LazyDoc. deepcopy relies on this remaining one graph.
        for k in DICT_LOGS:
            if dict.__contains__(d, k):
                value = dict.__getitem__(d, k)
                if isinstance(value, SectionMap):
                    lazy._snap_logs[k] = value._snaps
        lazy._key_order = order
        lazy._present = ({k for k in LAZY_SECTIONS
                          if dict.__contains__(d, k) and k not in new_doc}
                         | unmat | flushed)
        lazy._dropped = set()
        # everything materialized was just adopted: memory and disk agree,
        # so standing exposures are settled (a NEW exposure after this save
        # re-records itself and is what the write_org release judges)
        lazy._lazy_exposed = set()
        if _SCOPED_VERIFY:
            # AFTER the adopt, so memory is compared against what this save
            # just made authoritative — before it, every legitimately-saved
            # entry reads as a false mismatch
            _verify_scoped_save(d, lazy)
        for k in LAZY_SECTIONS:
            v = dict.get(d, k)
            if isinstance(v, AppendLog):
                v.full_rewrite = False
            elif isinstance(v, SectionMap):
                for owner in v._order:
                    if dict.__contains__(v, owner):
                        lst = dict.__getitem__(v, owner)
                        if isinstance(lst, AttemptMap):
                            lst = lst._log
                        if isinstance(lst, AppendLog):
                            lst.full_rewrite = False


# ------------------------------------------------------------ migration
#: every suffix an org can occupy under one trash stem. The free-stem search
#: must clear ALL of them: the artefacts travel together, so a stem is only
#: free when nothing of a previous org is sitting under any of it.
_TRASH_SUFFIXES: tuple[str, ...] = (".db", ".db-wal", ".db-shm",
                                    ".json", ".json.premigration")


def _rename_retry(src: str, dst: str, *, on_retry: Any = None,
                  tries: int = 40) -> None:
    """`os.replace`, retried while Windows says the source is still open.

    POSIX renames a file out from under an open handle without complaint.
    Windows raises `PermissionError` until the last handle closes, and the
    holder may be this process (a reader outside DOC_LOCK, №22) or something
    else entirely (a backup tool, a sync client, an editor). Retry with an
    escalating pause — and then let it RAISE. A rename that cannot happen is
    the caller's decision to make, never something to swallow: swallowing one
    is what turned a delete into an unbootable data root.

    Only `PermissionError` is retried. Any other `OSError` — a missing
    directory, a cross-device link — will not improve with waiting."""
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            if on_retry is not None:
                on_retry()
            time.sleep(0.01 * (i + 1))


def _sidecars(db: str) -> tuple[str, str]:
    return db + "-wal", db + "-shm"


def _remove_db_files(db: str) -> None:
    # `-journal` as well as the WAL pair: `journal_mode=WAL` is set AFTER the
    # connection opens, so the first moments of a candidate database use the
    # default rollback journal, and a SIGKILL landing there leaves a
    # `<slug>.db.migrating-journal` behind (seen in probes/p7_migfail.py).
    # ⚠ BELT AND BRACES, NOT A FIX: SQLite reclaims a stale journal itself on
    # the next open — measured, so do not read this line as load-bearing. It
    # is here so the candidate's cleanup owns every file the candidate can
    # create, rather than relying on a side effect of opening it again.
    for p in (db, *_sidecars(db), db + "-journal"):
        with contextlib.suppress(OSError):
            os.remove(p)


def _log(msg: str) -> None:
    print(f"[store] {msg}", file=sys.stderr, flush=True)


def verify_migration(conn: sqlite3.Connection, original: dict[str, Any]) -> dict[str, Any]:
    """§6.3 — 'not one byte of history lost'. Canonical-JSON equality of the
    full reconstruction against the source, PLUS the four assertions that a
    compensating error could otherwise hide behind. Raises `MigrationError`
    with the first failure; returns a small report on success."""
    rec = reconstruct_full(conn)
    report: dict[str, Any] = {}
    # 1. the general check — load-bearing, not ceremonial
    if canon(rec) != canon(original):
        diff = [k for k in sorted(set(original) | set(rec))
                if canon(original.get(k)) != canon(rec.get(k))]
        raise MigrationError(f"round-trip mismatch in sections: {diff}")
    # 2. nodes order (ui_order for pre-field nodes IS dict position, §3.4)
    on = cast("dict[str, Any]", original.get("nodes") or {})
    rn = cast("dict[str, Any]", rec.get("nodes") or {})
    if list(on.keys()) != list(rn.keys()):
        raise MigrationError("nodes order changed")
    # 3. every archived seat, individually (and every live one — cheaper to
    #    check all than to explain why not)
    archived = 0
    for nid, nv in on.items():
        if canon(nv) != canon(rn.get(nid)):
            raise MigrationError(f"node {nid!r} does not round-trip")
        if isinstance(nv, dict) and cast("dict[str, Any]", nv).get("state") == "archived":
            archived += 1
    report["nodes"] = len(on)
    report["archived"] = archived
    # 4. log cardinality, per section and per owner, from the DATABASE side
    counts: dict[str, int] = {}
    for sect in DICT_LOGS:
        src = original.get(sect)
        if not isinstance(src, dict):
            continue
        src_d = cast("dict[str, list[Any]]", src)
        got = {cast(str, o): cast(int, n) for o, n in conn.execute(
            "SELECT owner, COUNT(*) FROM log_d WHERE sect=? GROUP BY owner", (sect,))}
        for owner, lst in src_d.items():
            if got.get(owner, 0) != len(lst):
                raise MigrationError(f"{sect}[{owner!r}]: {got.get(owner, 0)} rows, "
                                     f"source has {len(lst)}")
        if set(got) - set(src_d):
            raise MigrationError(f"{sect}: rows for owners not in source: "
                                 f"{sorted(set(got) - set(src_d))}")
        counts[sect] = sum(got.values())
        counts[sect + ".owners"] = len(src_d)
    for sect in LIST_LOGS:
        src = original.get(sect)
        if not isinstance(src, list):
            continue
        src_l = cast("list[Any]", src)
        (n,) = conn.execute("SELECT COUNT(*) FROM log_l WHERE sect=?", (sect,)).fetchone()
        if cast(int, n) != len(src_l):
            raise MigrationError(f"{sect}: {n} rows, source has {len(src_l)}")
        counts[sect] = cast(int, n)
    report["counts"] = counts
    # 5. the largest single entry survives byte-identically (the value most
    #    likely to hit a limit nobody knew about — 1,080 KB in the live org)
    best: tuple[int, str, str | None, int] | None = None
    for sect in DICT_LOGS:
        src = original.get(sect)
        if isinstance(src, dict):
            for owner, lst in cast("dict[str, Any]", src).items():
                # a KEYED owner's value is {id: entry}; its rows hold
                # [id, entry] pairs, so the pair is the byte-identity unit
                # (iterating the dict itself would measure its KEYS)
                entries = ([[k, v] for k, v in cast("dict[str, Any]", lst).items()]
                           if sect in KEYED_DICT_LOGS and isinstance(lst, dict)
                           else cast("list[Any]", lst))
                for i, e in enumerate(entries):
                    n = len(_dumps(e))
                    if best is None or n > best[0]:
                        best = (n, sect, owner, i)
    for sect in LIST_LOGS:
        src = original.get(sect)
        if isinstance(src, list):
            for i, e in enumerate(cast("list[Any]", src)):
                n = len(_dumps(e))
                if best is None or n > best[0]:
                    best = (n, sect, None, i)
    if best is not None:
        n, sect, owner, i = best
        if owner is not None:
            src_v = cast("dict[str, Any]", original[sect])[owner]
            if sect in KEYED_DICT_LOGS and isinstance(src_v, dict):
                key = list(src_v)[i]
                src_e: Any = [key, src_v[key]]
            else:
                src_e = cast("list[Any]", src_v)[i]
            row = conn.execute("SELECT val FROM log_d WHERE sect=? AND owner=? "
                               "ORDER BY seq LIMIT 1 OFFSET ?", (sect, owner, i)).fetchone()
        else:
            src_e = cast("list[Any]", original[sect])[i]
            row = conn.execute("SELECT val FROM log_l WHERE sect=? "
                               "ORDER BY seq LIMIT 1 OFFSET ?", (sect, i)).fetchone()
        if row is None or cast(str, row[0]) != _dumps(src_e):
            where = f"{sect}[{owner!r}][{i}]" if owner is not None else f"{sect}[{i}]"
            raise MigrationError(f"largest entry ({n} bytes, {where}) did not "
                                 "round-trip byte-identically")
        report["largest_entry_bytes"] = n
    return report


def migrate_org(slug: str) -> dict[str, Any]:
    """§6.2 — `orgs/<slug>.json` → `orgs/<slug>.db`, verified, or nothing.

    The candidate is built as `<slug>.db.migrating`, verified (§6.3), and only
    then does the `.json` become `.json.premigration` and the candidate take
    the final name. On ANY failure the candidate is deleted, the `.json` is
    untouched, and `MigrationError` is raised — never a silent fallback. The
    `.premigration` file is never removed by code (§6.1 step 6).

    Deliberately UNGATED: this is the mechanism, and it migrates on the
    CALLER's authority — naming a slug and calling this is the explicit act
    the gate exists to require. The gate (`ORGTREE_MIGRATE=1`) lives at
    `claim_data_root` / `migrate_pending` / `_ensure_migrated`, the places
    that would otherwise INFER a migration from where a process is pointed.
    Not an oversight; do not add a flag here (coordinator decision 2026-09-04)."""
    slug = _safe_slug(slug)
    jp, db = _json_path(slug), _db_path(slug)
    tmpdb = db + ".migrating"
    if os.path.exists(db):
        raise MigrationError(f"{db!r} already exists; refusing to migrate over it")
    raw = _read_bytes(jp)
    sha = hashlib.sha256(raw).hexdigest()
    try:
        parsed: Any = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise MigrationError(f"{jp!r} is not valid JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise MigrationError(f"{jp!r} is not a JSON object")
    doc = cast("dict[str, Any]", parsed)
    _remove_db_files(tmpdb)
    t0 = time.perf_counter()
    conn: sqlite3.Connection | None = None
    try:
        conn = _open_conn(tmpdb, create=True)
        conn.execute("BEGIN IMMEDIATE")
        try:
            _write_doc(conn, doc, None)
            _meta_set(conn, "schema_version", _SCHEMA_VERSION)
            _meta_set(conn, "migrated_at", _ledger_now())
            _meta_set(conn, "source_json_sha256", sha)
            _meta_set(conn, "source_json_bytes", str(len(raw)))
            conn.execute("COMMIT")
        except BaseException:
            with contextlib.suppress(Exception):
                conn.execute("ROLLBACK")
            raise
        report = verify_migration(conn, doc)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
        conn = None
    except BaseException as e:
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
        _remove_db_files(tmpdb)
        if isinstance(e, MigrationError):
            _log(f"MIGRATION FAILED for {slug!r}: {e} — {jp!r} untouched, "
                 f"candidate database deleted")
            raise
        raise MigrationError(f"migration of {slug!r} failed: "
                             f"{type(e).__name__}: {e}") from e
    prem = _premigration_path(slug)
    if os.path.exists(prem):
        # ⚠ NEVER overwrite one. It is the only pre-migration copy of that
        # org's history, §6.1 step 6 says code does not remove it, and an
        # unconditional `os.replace` removed it anyway on the one path that
        # reaches here twice: delete the org (its `.db` goes to the trash),
        # restore an old `.json` by hand — the case `_ensure_migrated` exists
        # for — and the second migration lands on top of the first copy.
        # Same rule as the delete trash: find a free name, then rename. The
        # canonical name stays with the FIRST migration, which is the one the
        # §6.1 rollback renames back.
        # ...but a REPEAT of the same migration is not new history. If the
        # existing copy already holds these exact bytes there is nothing to
        # preserve, and minting a stamped duplicate would grow `orgs/` by a
        # whole document every time — measured: a loop that restored the
        # `.json` and re-migrated left 90 copies of it. Identical content is
        # the common case here (restore the same file, migrate it again), so
        # keep the one copy and let the redundant source go.
        if hashlib.sha256(open(prem, "rb").read()).hexdigest() == sha:
            os.remove(jp)
            os.replace(tmpdb, db)
            report["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            report["bytes"] = len(raw)
            _log(f"re-migrated {slug!r}: {len(raw)} bytes → "
                 f"{os.path.basename(db)}; the existing "
                 f"{os.path.basename(prem)} already holds these exact bytes")
            return report
        stamp = time.strftime("%Y%m%dT%H%M%S")
        alt, k = f"{prem}.{stamp}", 0
        while os.path.exists(alt):
            k += 1
            alt = f"{prem}.{stamp}-{k}"
        prem = alt
    os.replace(jp, prem)
    os.replace(tmpdb, db)
    report["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    report["bytes"] = len(raw)
    _log(f"migrated {slug!r}: {len(raw)} bytes → {os.path.basename(db)} in "
         f"{report['ms']} ms; nodes={report.get('nodes')} archived={report.get('archived')} "
         f"counts={report.get('counts')}; source kept as "
         f"{os.path.basename(prem)}")
    return report


def _finish_interrupted_migration(slug: str) -> bool:
    """A crash between the two renames at the end of `migrate_org` leaves a
    VERIFIED `<slug>.db.migrating` beside a `.json.premigration`, with neither
    `.json` nor `.db` — the org would be invisible. That exact constellation
    cannot arise any other way (an unverified candidate is deleted before the
    first rename; a crash before it leaves the `.json` in place and the
    candidate is rebuilt), so finishing the rename is the correct recovery."""
    db = _db_path(slug)
    tmpdb = db + ".migrating"
    if (os.path.exists(tmpdb) and os.path.exists(_premigration_path(slug))
            and not os.path.exists(db) and not os.path.exists(_json_path(slug))):
        os.replace(tmpdb, db)
        _log(f"completed an interrupted migration for {slug!r} "
             f"(verified candidate renamed into place)")
        return True
    return False


def migrate_pending() -> list[str]:
    """Every `orgs/<slug>.json` with no `orgs/<slug>.db`, migrated (§6.1 step
    5) — IF this process may (`_migration_allowed`): otherwise, when there is
    anything to migrate, `MigrationRefused` with nothing written. Raises
    `MigrationError` on the first org that does not verify; the ones before
    it are done, the ones after it are not, and none of them has lost
    anything. Returns the slugs migrated.

    An interrupted migration (a verified `.db.migrating` beside its
    `.premigration`, no `.json`, no `.db`) is finished regardless of the
    gate: the operator authorised THAT migration when it started, and the
    only alternative is an org that exists on disk and is invisible —
    precisely the silent state the gate exists to prevent."""
    if STORE_BACKEND != "sqlite":
        return []
    done: list[str] = []
    with DOC_LOCK:
        for f in sorted(os.listdir(_orgs_dir())):
            if f.endswith(".db.migrating"):
                with contextlib.suppress(LedgerError):
                    _finish_interrupted_migration(f[:-len(".db.migrating")])
        pending = pending_migrations()
        if pending and not _migration_allowed():
            raise MigrationRefused(_refusal_text(DATA_ROOT, pending))
        for slug in pending:
            migrate_org(slug)
            done.append(slug)
    return done


def _ensure_migrated(slug: str) -> None:
    """SQLite backend, on demand: a `<slug>.json` with no `<slug>.db` (an org
    restored from a pre-migration trash copy, a file dropped in by hand) is
    migrated before it is used — by a process that may (`_migration_allowed`:
    the backend that owns this root, or anyone under `ORGTREE_MIGRATE=1`).
    Any other process raises `MigrationRefused` here rather than migrate a
    root it was merely pointed at, and rather than answer "no such org" for
    a file that is plainly there. Startup does this for everything (§6.1
    step 5, via `claim_data_root`); this is the same operation, same gate,
    for a file that appears later."""
    if STORE_BACKEND != "sqlite":
        return
    db = _db_path(slug)
    if os.path.exists(db):
        return
    with DOC_LOCK:
        if os.path.exists(db):
            return
        if _finish_interrupted_migration(slug):
            return
        if os.path.exists(_json_path(slug)):
            if not _migration_allowed():
                raise MigrationRefused(_refusal_text(DATA_ROOT, [slug]))
            migrate_org(slug)


def export_json(slug: str, dest: str | None = None) -> str:
    """§6.4 — the full document reconstructed from rows, written in the old
    JSON format (indent=2). Default destination `<data>/exports/<slug>-<stamp>
    .json` — deliberately NOT under `orgs/`, where the JSON backend would list
    it as an org. Returns the path written."""
    _assert_synced_data_root()
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    if not os.path.exists(_db_path(slug)):
        raise LedgerError(f"no such org: {slug!r}")
    with _POOL.acquire(slug) as conn:
        doc = reconstruct_full(conn)
    # ⚠ NOTHING IS STAMPED INTO THE EXPORT, and that is deliberate. A stamp
    # lived here until 2026-09-05, so that a document restored from this file
    # could be recognised as a world that stopped. It could not do the job:
    # three of the four documented restore routes never pass through here (a
    # `.json` dropped in by hand, a database out of `deleted/`, a parked
    # database moved back), and two of them restore a DATABASE no export-time
    # stamp can reach. Custody is established by the backend's own epoch
    # instead (`opreceipts.custody`), which a restore cannot carry — so this
    # export is byte-for-byte the live document again.
    if dest is None:
        d = os.path.join(DATA_ROOT, "exports")
        os.makedirs(d, exist_ok=True)
        dest = os.path.join(d, f"{slug}-{time.strftime('%Y%m%dT%H%M%S')}.json")
    blob = json.dumps(doc, indent=2).encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest) or ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)
        tmp = ""
    finally:
        if tmp:
            with contextlib.suppress(OSError):
                os.remove(tmp)
    return dest


# =========================================================================
#                              the public seam
# =========================================================================

def _scan_orgs(skip: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    """(slug, doc) for every org, ONE read+parse each.

    `skip` is a slug the caller ALREADY holds parsed — its file is not
    read at all. The filter has to be here rather than at the caller
    because the expensive step is the parse this generator performs, so
    a caller that discards the row afterwards has already paid for it.

    Split out of `list_orgs` so that a caller which needs the whole document
    as well as the summary row can have both from the same parse — see
    `list_orgs_with_docs`. Under SQLite the doc is a `LazyDoc`: the heavy
    logs are not read for a listing."""
    if row_store():
        for f in sorted(os.listdir(_orgs_dir())):
            # an org that arrived as JSON (restored from a pre-migration
            # trash copy, say) is migrated before it is listed
            if f.endswith(".json"):
                slug = f[:-5]
                try:
                    _safe_slug(slug)
                    if not os.path.exists(_db_path(slug)):
                        _ensure_migrated(slug)
                except LedgerError:
                    continue
                except MigrationError as e:
                    _log(f"{slug!r} not listed: {e}")
                    continue
        for f in sorted(os.listdir(_orgs_dir())):
            if not f.endswith(db_ext()):
                continue
            slug = f[:-len(db_ext())]
            if skip and slug == skip:
                # ⚠ the sqlite arm honours `skip` for the same reason the JSON
                # arm does, even though its parse is cheaper: `_load_lazy`
                # still reads every `doc` row AND every node row, which is the
                # bulk of a listing's cost here. A caller that already holds
                # the document must not pay for it twice on either backend.
                continue
            try:
                _safe_slug(slug)
                with _POOL.acquire(slug) as conn:
                    doc = _load_lazy(conn, slug)
            except (LedgerError, sqlite3.Error, ValueError, OSError):
                continue
            yield slug, doc
        return
    _sweep_tmp()
    for f in sorted(os.listdir(_orgs_dir())):
        if not f.endswith(".json") or (skip and f[:-5] == skip):
            continue
        try:
            # ⚠ the `except: continue` below means a TRANSIENT read failure
            # silently DROPS an org from the listing — the org list flickers
            # rather than erroring. Hence the latched, retrying read: by the
            # time this raises, the file really is unreadable.
            doc = json.loads(_read_bytes(os.path.join(_orgs_dir(), f))
                             .decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            continue
        yield f[:-5], doc


def _summary_row(stem: str, doc: dict[str, Any]) -> dict[str, Any]:
    """The listing row. Reads only keys `Org.__init__` does not rewrite, so it
    is the same whether the doc has been through `Org()` or not. Reads no
    lazy section."""
    live = sum(1 for n in doc.get("nodes", {}).values() if n.get("state") == "live")
    return {"slug": doc.get("slug", stem), "name": doc.get("name", stem),
            "nodes": len(doc.get("nodes", {})), "live": live,
            "kiosk": doc.get("kiosk") is not None,
            # the PUBLIC half of the org's hub identity (never the
            # secret) — lets listings mark a local org as also
            # hub-reachable (transport sets, user spec 2026-08-05)
            "net_slug": cast("dict[str, Any]",
                             doc.get("net_identity") or {}).get("slug"),
            "created": doc.get("created")}


def list_orgs() -> list[dict[str, Any]]:
    return [_summary_row(f, doc) for f, doc in _scan_orgs()]


def local_net_slugs(loaded: dict[str, Any] | None = None) -> set[str]:
    """Every non-kiosk org's `net_slug` on this instance.

    ⚠ WHY THIS IS NOT `list_orgs()`. `org_tree` needs this set to mark which
    hub-roster peers are also local orgs, and it used to get it by calling
    `list_orgs()` — which full-parses EVERY org document to read at most a few
    short strings. MEASURED 2026-09-03 on the live install: 80.3 ms per call,
    reading 18.7 MB (`orgtree.json` 11.2 MB + `resonite.json` 7.4 MB +
    `unity.json`), against a 233 ms floor for the whole endpoint. One of those
    parses was a straight duplicate: the handler had already parsed the org it
    was rendering, twenty lines earlier.

    So `loaded` is that document, passed back in. Its file is not re-read, and
    `_scan_orgs` skips it before the parse rather than after — filtering the
    row afterwards would already have paid for it.

    ⚠ ONE DEFINITION OF THE ROW. Both branches go through `_summary_row`, so
    the already-parsed org is filtered by exactly the rule the scanned ones
    are. Reading `net_identity` and `kiosk` directly here would be a second
    expression of it, and it would drift the moment either key moves.

    Portability note (agreed with `sqlite-review`, 2026-09-03): kept as its own
    small function rather than reshaping `_scan_orgs`'s contract, because under
    the SQLite backend this becomes a `doc`-row read per org with no node load
    at all — cheaper again, and a local change there rather than a merge.

    That note is now cashed in: the sqlite branch below reads ONE `doc` row
    per database and loads no nodes and no logs, where `_scan_orgs` would
    read every node row of every org to build a row this function throws all
    but two fields of away.
    """
    out: set[str] = set()

    def take(f: str, doc: dict[str, Any]) -> None:
        row = _summary_row(f, doc)
        if row["net_slug"] and not row["kiosk"]:
            out.add(str(row["net_slug"]))

    if row_store():
        skip_slug = str((loaded or {}).get("slug") or "")
        if loaded is not None:
            take(skip_slug, loaded)
        for f in sorted(os.listdir(_orgs_dir())):
            if not f.endswith(db_ext()):
                continue
            slug = f[:-len(db_ext())]
            if slug == skip_slug:
                continue
            try:
                _safe_slug(slug)
                with _POOL.acquire(slug) as conn:
                    rows = {cast(str, k): cast(str, v) for k, v in conn.execute(
                        "SELECT key, val FROM doc WHERE key IN "
                        "('slug','net_identity','kiosk')")}
            except (LedgerError, sqlite3.Error, OSError):
                continue
            # ⚠ still ONE definition of the row: hand `_summary_row` the three
            # keys it reads rather than re-deriving "non-kiosk with a net_slug"
            # here. `nodes` is deliberately absent — the row's node counts are
            # not read by `take`, and loading them is the cost this exists to
            # avoid.
            take(slug, {k: json.loads(v) for k, v in rows.items()})
        return out

    skip = ""
    if loaded is not None:
        skip = str(loaded.get("slug") or "")
        # ⚠ a SLUG, not `slug + ".json"`. `_scan_orgs` yields slugs on this
        # branch (a sqlite org has no filename to yield) and `_summary_row`
        # takes the stem, so passing a filename here would make the
        # already-parsed org's fallback read "orgtree.json" while every
        # scanned org's read "orgtree" — one definition of the row, expressed
        # two ways, which is exactly what that function's docstring forbids.
        take(skip, loaded)
    for f, doc in _scan_orgs(skip=skip):
        take(f, doc)
    return out


def list_orgs_with_docs() -> list[tuple[dict[str, Any], Org]]:
    """`list_orgs()`, plus each org's `Org` — from the SAME parse.

    `GET /api/orgs` needs both halves, and building them separately meant
    `list_orgs()` parsed every org document and then `load_org()` parsed every
    one of them AGAIN. Measured 2026-09-03 on this machine's data root (18.53
    MB across three orgs): 84 ms per pass, so 168 ms per request — on a route
    the desk polls every 3 s, i.e. ~56 ms of every second spent parsing JSON
    that was already in memory, from an idle browser tab.

    ⚠ ORDER MATTERS: the row is built BEFORE `Org()`, which migrates the doc
    in place. `_summary_row` deliberately reads only fields that migration
    leaves alone, so the two orders agree — but building it first means that
    stays true without anyone having to re-check it.

    Unlike the two-pass version this cannot observe an org that disappears
    between the listing and the load, so there is no half-populated row: the
    document is already in hand. (The `LedgerError` branch that handled that
    window in `orgs_list` is gone with it.)"""
    out: list[tuple[dict[str, Any], Org]] = []
    for f, doc in _scan_orgs():
        row = _summary_row(f, doc)
        # same cast `load_org` gets for free from `json.loads` returning Any:
        # nothing validates the doc's shape at either entry point (see the
        # module docstring — the store loads whatever JSON is on disk)
        out.append((row, Org(cast("OrgDoc", doc))))
    return out


def _load_sqlite_org(slug: str, preload: Iterable[str] = ()) -> Org:
    """Shared SQLite half for ordinary and bounded-snapshot loads."""
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    db = _db_path(slug)
    if not os.path.exists(db):
        raise LedgerError(f"no such org: {slug!r}")
    try:
        t0 = time.perf_counter()
        with _POOL.acquire(slug) as conn:
            doc = _load_lazy(conn, slug, preload)
        t1 = time.perf_counter()
        # Keep Org construction inside this error boundary. On an unmarked
        # document its mail-id backfill can read mail_log; snapshot loads add
        # that section to their bounded transaction in _load_lazy.
        org = Org(cast("OrgDoc", doc))
        t2 = time.perf_counter()
        stateprobe.record("load_doc", ms=(t1 - t0) * 1000.0,
                          nbytes=getattr(doc, "_eager_bytes", 0))
        stateprobe.record("org_init", ms=(t2 - t1) * 1000.0)
        return org
    except sqlite3.OperationalError as e:
        if not os.path.exists(db):
            raise LedgerError(f"no such org: {slug!r}") from None
        raise LedgerError(f"cannot open org {slug!r}: {e}") from e


def read_document_gallery(slug: str) -> list[dict[str, Any]]:
    """Project metadata in SQLite; never transfer document bodies or all events.

    Node labels, existing cards and legacy eviction stubs share one snapshot.
    Row positions preserve the original equal-timestamp tie ordering.
    """
    if STORE_BACKEND != "sqlite":
        return load_org(slug).document_gallery()
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    db = _db_path(slug)
    if not os.path.exists(db):
        raise LedgerError(f"no such org: {slug!r}")
    try:
        with _POOL.acquire(slug) as conn:
            conn.execute("BEGIN")
            try:
                if _meta_get(conn, "schema_version") is None:
                    raise LedgerError(f"{db!r} is not an intact orgtree database (no schema_version row)")
                nodes = {nid: {"state": state, "model": model} for nid, state, model in
                         conn.execute("SELECT id,json_extract(val,'$.state'),json_extract(val,'$.model') FROM nodes")}
                # A pre-row-storage document can still hold these sections as
                # blobs; project those in SQL too instead of loading their bodies.
                blob_keys = {row[0] for row in conn.execute("SELECT key FROM doc WHERE key IN ('documents','events','nodes')")}
                if 'nodes' in blob_keys:
                    nodes = {nid: {"state": state, "model": model} for nid, state, model in
                             conn.execute("SELECT key,json_extract(value,'$.state'),json_extract(value,'$.model') "
                                          "FROM json_each((SELECT val FROM doc WHERE key='nodes'))")}
                fields = ('id', 'node', 'title', 'at', 'format', 'bytes')
                value = 'value' if 'documents' in blob_keys else 'val'
                expression = "json_object(" + ','.join("'" + key + "',json_extract(" + value + ",'$." + key + "')" for key in fields) + ")"
                source = ("json_each((SELECT val FROM doc WHERE key='documents')) ORDER BY key"
                          if 'documents' in blob_keys else "log_l WHERE sect='documents' ORDER BY seq")
                documents = [json.loads(row[0]) for row in conn.execute("SELECT " + expression + " FROM " + source)]
                if 'events' in blob_keys:
                    query = "SELECT key,value FROM json_each((SELECT val FROM doc WHERE key='events')) WHERE json_extract(value,'$.op')='present_evicted' ORDER BY key"
                else:
                    query = ("SELECT position,val FROM (SELECT row_number() OVER (ORDER BY seq)-1 AS position,val FROM log_l WHERE sect='events') "
                             "WHERE json_extract(val,'$.op')='present_evicted' ORDER BY position")
                evictions = [(int(index), json.loads(raw)) for index, raw in conn.execute(query)]
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
        return Org.gallery_metadata(documents, evictions, nodes)
    except sqlite3.OperationalError as e:
        if not os.path.exists(db):
            raise LedgerError(f"no such org: {slug!r}") from None
        raise LedgerError(f"cannot open org {slug!r}: {e}") from e


def read_user_inbox(slug: str) -> dict[str, Any]:
    """Read the pending box and two 50-row tails in one SQLite snapshot.

    This is a read projection, never an Org that could be saved. It avoids
    loading the roster, unrelated pending notices and entire mail histories.
    JSON remains the rollback reader. Pending mail is intentionally complete.
    """
    if STORE_BACKEND != "sqlite":
        d = load_org(slug).d
        return {"pending": d.get("user_inbox", []),
                "delivered": d.get("user_mail_log", [])[-50:],
                "sent": d.get("user_outbox", [])[-50:]}
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    db = _db_path(slug)
    if not os.path.exists(db):
        raise LedgerError(f"no such org: {slug!r}")
    try:
        with _POOL.acquire(slug) as conn:
            conn.execute("BEGIN")
            try:
                if _meta_get(conn, "schema_version") is None:
                    raise LedgerError(f"{db!r} is not an intact orgtree database (no schema_version row)")
                blobs = dict(conn.execute("SELECT key,val FROM doc WHERE key IN "
                                          "('user_inbox','user_mail_log','user_outbox')"))
                result = {"pending": json.loads(blobs.get("user_inbox", "[]"))}
                for name, section in (("delivered", "user_mail_log"), ("sent", "user_outbox")):
                    if section in blobs:
                        # Historical non-rowed storage keeps exactly its old semantics.
                        result[name] = json.loads(blobs[section])[-50:]
                    else:
                        rows = conn.execute("SELECT val FROM log_l WHERE sect=? "
                                            "ORDER BY seq DESC LIMIT 50", (section,)).fetchall()
                        result[name] = [json.loads(row[0]) for row in reversed(rows)]
                conn.execute("COMMIT")
                return result
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
    except sqlite3.OperationalError as e:
        if not os.path.exists(db):
            raise LedgerError(f"no such org: {slug!r}") from None
        raise LedgerError(f"cannot open org {slug!r}: {e}") from e


# ------------------------------------------------- bounded log tail readers
# (perf-redesign 2026-09-12, REPORT.md #4/#5/#6.) Three polled endpoints used
# to MATERIALIZE entire unbounded logs per request — the whole 19k-row events
# section (357 ms measured), every owner's mail archive (9.9 MB), the full
# notice log — to serve a bounded slice. These readers answer the same
# questions straight from the row tables, in the read_user_inbox mold: a
# short read transaction, no Org, no lazy materialization. Every one of them
# returns None when the cheap path does not apply (JSON backend, or a legacy
# section stored as a doc blob) and the CALLER falls back to the load path —
# behavior first, speed second.


def _bounded_read(slug: str, body: Callable[[sqlite3.Connection], Any]) -> Any:
    """One short read transaction against the org's database, or None when
    this root is not on the SQLite backend (caller falls back to load_org)."""
    if STORE_BACKEND != "sqlite":
        return None
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    if not os.path.exists(_db_path(slug)):
        raise LedgerError(f"no such org: {slug!r}")
    with _POOL.acquire(slug) as conn:
        conn.execute("BEGIN")
        try:
            if _meta_get(conn, "schema_version") is None:
                raise LedgerError(
                    f"{_db_path(slug)!r} is not an intact orgtree database "
                    "(no schema_version row)")
            return body(conn)
        finally:
            with contextlib.suppress(Exception):
                conn.execute("COMMIT")


def node_row_exists(slug: str, nid: str) -> bool | None:
    """Does this node id (lineage ids included — they are real rows) exist?
    None = no cheap answer on this backend; caller loads instead."""
    def body(conn: sqlite3.Connection) -> bool | None:
        if conn.execute("SELECT 1 FROM doc WHERE key='nodes'").fetchone():
            # `nodes` stored as a blob empties the row table (see _write_doc)
            # — the rows cannot answer; let the caller load instead
            return None
        return bool(conn.execute("SELECT 1 FROM nodes WHERE id=?",
                                 (nid,)).fetchone())
    return _bounded_read(slug, body)


def read_node(slug: str, nid: str) -> dict[str, Any] | None:
    """One node as STORED — a single primary-key row, parsed alone
    (rearchitecture Phase A: reading one node must not materialize the node
    table). None = the node does not exist, or this backend/document shape
    has no cheap row answer and the caller must load instead.

    ⚠ Storage truth, not a constructed `Org` view: the in-place
    normalizations `Org.__init__` applies (scope tool/dir shapes, inherited
    permission_mode, charter fold) are NOT applied here. Every document
    saved by this codebase persists nodes post-normalization, so the
    difference is visible only on documents that predate a migration and
    have never been saved since — callers needing the constructed view use
    `cached_org(slug).node(nid)`, which after Phase A refreshes by exactly
    what changed rather than re-parsing the org."""
    def body(conn: sqlite3.Connection) -> Any:
        if conn.execute("SELECT 1 FROM doc WHERE key='nodes'").fetchone():
            return None
        row = conn.execute("SELECT val FROM nodes WHERE id=?",
                           (nid,)).fetchone()
        return json.loads(cast(str, row[0])) if row is not None else None
    return cast("dict[str, Any] | None", _bounded_read(slug, body))


def read_events_page(slug: str, since: int = 0, last: int | None = None
                     ) -> tuple[int, list[Any]] | None:
    """(total, rows) for the events endpoint: `events[since:]`, or the newest
    `last` rows when given. None = fall back to materializing (JSON backend
    or an `events` doc blob)."""
    def body(conn: sqlite3.Connection) -> tuple[int, list[Any]] | None:
        if conn.execute("SELECT 1 FROM doc WHERE key='events'").fetchone():
            return None                      # legacy blob shape — let load win
        total = cast(int, conn.execute(
            "SELECT COUNT(*) FROM log_l WHERE sect='events'").fetchone()[0])
        if last is not None:
            rows = conn.execute(
                "SELECT val FROM log_l WHERE sect='events' "
                "ORDER BY seq DESC LIMIT ?", (max(0, last),)).fetchall()
            return total, [json.loads(cast(str, r[0])) for r in reversed(rows)]
        # `events[since:]`, EXACTLY — including Python's negative-index
        # meaning (perf-review reproduction #1: since=-2 must be the last
        # two rows, not the whole log)
        offset = since if since >= 0 else max(0, total + since)
        rows = conn.execute(
            "SELECT val FROM log_l WHERE sect='events' "
            "ORDER BY seq LIMIT -1 OFFSET ?", (offset,)).fetchall()
        return total, [json.loads(cast(str, r[0])) for r in rows]
    return _bounded_read(slug, body)


def read_node_history_rows(slug: str, nid: str, cap: int
                           ) -> tuple[list[Any], list[Any]] | None:
    """The newest `cap` event rows touching one node, plus its newest `cap`
    notice rows, both oldest-first — the exact inputs /nodes/{nid}/history
    projects. The five-field OR mirrors the handler's `touches` test; JSON1
    runs it inside SQLite instead of parsing 19k rows in Python. Tails are
    by `at` (then seq for ties) because that is the key the handler sorts
    and slices by — a seq tail keeps the newest-by-insertion instead of the
    newest-by-timestamp and diverges the moment the two orders disagree
    (perf-review reproduction #2, reverse-timestamp fixture).

    ⚠ LIMIT bounds the RETURNED rows and the Python-side decode, not the
    scan: with no expression index the filter still visits every `events`
    row inside SQLite (~18 VM ops per unrelated row, perf-review round-3
    scaling probe). Database work stays linear in the section; what this
    reader removes is the full-log JSON parse and transfer.
    None = fall back (JSON backend or blob-shaped section)."""
    def body(conn: sqlite3.Connection) -> tuple[list[Any], list[Any]] | None:
        if conn.execute("SELECT 1 FROM doc WHERE key IN "
                        "('events','notice_log') LIMIT 1").fetchone():
            return None
        ev = conn.execute(
            "SELECT val FROM log_l WHERE sect='events' AND ("
            "json_extract(val,'$.detail.node')=? OR "
            "json_extract(val,'$.detail.to')=? OR "
            "json_extract(val,'$.actor')=? OR "
            "json_extract(val,'$.detail.grantee')=? OR "
            "json_extract(val,'$.detail.from')=?) "
            "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC "
            "LIMIT ?",
            (nid, nid, nid, nid, nid, cap)).fetchall()
        nl = conn.execute(
            "SELECT val FROM log_l WHERE sect='notice_log' AND "
            "json_extract(val,'$.node')=? "
            "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC "
            "LIMIT ?",
            (nid, cap)).fetchall()
        return ([json.loads(cast(str, r[0])) for r in reversed(ev)],
                [json.loads(cast(str, r[0])) for r in reversed(nl)])
    return _bounded_read(slug, body)


def read_mail_tails(slug: str, nid: str, keep: int, slack: int = 40
                    ) -> tuple[list[Any], list[Any], list[Any], list[Any]] | None:
    """(box, delivering, delivered_tail, sent_tail) for one node's inbox
    view, ALL FROM ONE READ TRANSACTION, without materializing any owner's
    archive.

    One transaction is the contract, not a nicety (perf-review round 2,
    probe-reproduced): reading the pending box in an earlier snapshot than
    the archive tail let a post_mail that landed between them show its mail
    as DELIVERED while the pending list said empty — a state the original
    single-snapshot load could never produce. The waiting side (`box` +
    `delivering`, both eager doc keys) therefore rides the same BEGIN as
    the tails, and the handler overlays them onto its Org before deriving
    anything.

    `delivered` is the node's OWN mail_log tail, sized past every possible
    still-pending duplicate: keep + slack + the box/journal rows counted
    INSIDE this same transaction. `sent` mirrors the newest rows FROM this
    node across every recipient's archive plus the user logs — per-source
    tails by `$.at` (the merged sort key; a seq tail keeps the wrong end
    when insertion and timestamp order disagree — same round-2 finding as
    history), with equal-`at` ties kept in the legacy (owner position,
    list position) order, never global seq (round-3 finding).

    ⚠ The same work-bound caveat as `read_node_history_rows`: the sent
    filter scans the whole `mail_log` section inside SQLite; LIMIT bounds
    output and decode, not the scan. None = fall back."""
    def body(conn: sqlite3.Connection
             ) -> tuple[list[Any], list[Any], list[Any], list[Any]] | None:
        if conn.execute("SELECT 1 FROM doc WHERE key IN "
                        "('mail_log','user_mail_log') LIMIT 1").fetchone():
            return None
        def doc_map(key: str) -> dict[str, Any]:
            row = conn.execute("SELECT val FROM doc WHERE key=?",
                               (key,)).fetchone()
            v = json.loads(cast(str, row[0])) if row is not None else {}
            return v if isinstance(v, dict) else {}
        box = list(doc_map("mail").get(nid) or [])
        delivering = list(doc_map("delivering").get(nid) or [])
        pending_est = len(box) + sum(len(b.get("mail") or [])
                                     for b in delivering if isinstance(b, dict))
        cap = keep + slack + pending_est
        delivered = [json.loads(cast(str, r[0])) for r in reversed(conn.execute(
            "SELECT val FROM log_d WHERE sect='mail_log' AND owner=? "
            "ORDER BY seq DESC LIMIT ?", (nid, cap)).fetchall())]
        sent: list[Any] = []
        # tie order is part of the contract: the legacy path walks owners in
        # DICT ORDER (== MIN(seq) per owner, see `_load_sect_owners`) and each
        # owner's list in order, then stable-sorts by `at` — so equal-`at`
        # rows keep (owner position, list position), NOT global insertion seq
        # (perf-review round 3, equal-time fixture: the wrong last-50). The
        # join reproduces that composite key inside the capped query.
        for owner, raw in reversed(conn.execute(
                "SELECT l.owner, l.val FROM log_d l JOIN "
                "(SELECT owner, MIN(seq) AS pos FROM log_d "
                " WHERE sect='mail_log' GROUP BY owner) o ON o.owner=l.owner "
                "WHERE l.sect='mail_log' AND json_extract(l.val,'$.from')=? "
                "ORDER BY COALESCE(json_extract(l.val,'$.at'),'') DESC, "
                "o.pos DESC, l.seq DESC "
                "LIMIT ?", (nid, cap)).fetchall()):
            sent.append({**json.loads(cast(str, raw)), "to": cast(str, owner)})
        row = conn.execute("SELECT val FROM doc WHERE key='user_inbox'"
                           ).fetchone()
        if row is not None:
            for m in json.loads(cast(str, row[0])) or []:
                if isinstance(m, dict) and m.get("from") == nid:
                    sent.append({**m, "to": "@user"})   # ledger.USER
        for raw, in reversed(conn.execute(
                "SELECT val FROM log_l WHERE sect='user_mail_log' AND "
                "json_extract(val,'$.from')=? "
                "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC "
                "LIMIT ?", (nid, cap)).fetchall()):
            sent.append({**json.loads(cast(str, raw)), "to": "@user"})
        sent.sort(key=lambda m: m.get("at") or "")
        return box, delivering, delivered, sent[-cap:]
    return _bounded_read(slug, body)


def eager_sections(d: dict[str, Any]) -> dict[str, Any]:
    """Every section of an org document EXCEPT the append-only logs, read
    without materialising a single one of them.

    ⚠ `dict.keys` / `dict.__getitem__` ARE THE POINT, and calling `d.keys()`
    here would defeat the whole function: `LazyDoc` overrides the whole-document
    walks (`keys`, `items`, `values`, `__iter__`) to materialise everything
    first, which is exactly the cost this exists to avoid. Reaching past the
    override reads what is actually resident, and the filter then drops any log
    section that happened to be resident already.

    The values are the LIVE objects, not copies — this is a view for a caller
    that is about to serialise it, never one that is about to mutate it.
    """
    return {k: dict.__getitem__(d, k) for k in dict.keys(d)
            if k not in LAZY_SECTIONS}


def log_append(d: dict[str, Any], sect: str, row: Any) -> None:
    """Append one row to an append-only log section of an org document.

    The ledger's `d[sect].append(row)` idiom is correct but, against SQLite's
    lazy sections, pays the whole section's JSON round trip for one row (see
    `LazyDoc.log_append`). This is the same statement written so the storage
    layer can take the cheap path when it is available; on a plain dict (the
    JSON backend, `Org.create`, a test fixture) it IS `setdefault().append()`.
    """
    appender = getattr(d, "log_append", None)
    if appender is None:
        d.setdefault(sect, []).append(row)
        return
    appender(sect, row)


def load_org_snapshot(slug: str, sections: Iterable[str]) -> Org:
    """Load one coherent projection without retaining a read transaction.

    Under SQLite, eager fields and every named lazy section are captured in
    one short read transaction on one physical connection. The returned
    mutable proxies keep their normal save baselines. Unnamed lazy sections
    retain ordinary S1 behavior and may observe a later commit.

    JSON already parses the entire document atomically, so its behavior and
    rollback compatibility remain exactly ``load_org``.
    """
    if isinstance(sections, str):
        raise TypeError("sections must be an iterable of section names")
    selected = tuple(sections)
    unknown = set(selected) - LAZY_SECTIONS
    if unknown:
        raise ValueError(f"not lazy sections: {sorted(unknown)!r}")
    if row_store():
        return _load_sqlite_org(slug, selected)
    # `detached()`, because on this backend the delegation below IS the
    # snapshot: `_org_view` already brackets this very call as
    # `load_snapshot_ms`, and letting `load_org` also bill it to `org_load_ms`
    # would report one parse twice under two names — an operator adding the
    # stages up would see double the IO the route actually did.
    with profiling.detached():
        return load_org(slug)


def load_org(slug: str) -> Org:
    with profiling.stage("org_load_ms"):
        return _load_org(slug)


def _load_org(slug: str) -> Org:
    if row_store():
        # THE RESIDENT FAST PATH (rearchitecture Phase B). A load performed
        # while this thread holds the document lock is the front half of a
        # write cycle — the classic idiom at ~300 sites. It is served the
        # per-org resident document instead of a fresh 11 MB parse; the
        # release hook on the lock (`_on_doc_lock_release`) enforces the
        # discard property for every one of those sites uniformly. A REPEAT
        # load in the same hold re-checks cleanliness first, so the old
        # "reload to discard my half-applied mutations" pattern still gets
        # the fresh copy it is asking for. Reads outside the lock are
        # untouched: fresh private load, exactly as before (№22).
        if getattr(DOC_LOCK, "_is_owned", lambda: False)() \
                and not getattr(_hold_track, "suppress_resident", False):
            org = _resident.get(slug)
            slugs: set[str] = getattr(_hold_track, "slugs", None) or set()
            if org is not None:
                d = cast("dict[str, Any]", org.d)
                fresh_needed = False
                if isinstance(d, LazyDoc):
                    if slug in slugs:
                        # repeat hand-out within one hold: honor the
                        # discard-by-reload contract if anything is dirty
                        try:
                            fresh_needed = bool(
                                _resident_dirty(d)
                                or any(r for r in d._pending.values())
                                or d._lazy_exposed)
                        except Exception:
                            fresh_needed = True
                else:
                    fresh_needed = True
                if fresh_needed:
                    _resident.pop(slug, None)
                else:
                    slugs.add(slug)
                    _hold_track.slugs = slugs
                    return org
            org = _load_sqlite_org(slug)
            if isinstance(org.d, LazyDoc):
                _settle_marks(org.d)
                _resident[slug] = org
                slugs.add(slug)
                _hold_track.slugs = slugs
            return org
        return _load_sqlite_org(slug)
    p = _json_path(slug)
    if not os.path.exists(p):
        raise LedgerError(f"no such org: {slug!r}")
    # The read side of the same collision. Read-only endpoints deliberately
    # read OUTSIDE DOC_LOCK (№22), so under agent load this races every save:
    # on Windows, opening the doc while a replace is in flight raises
    # PermissionError [Errno 13] (~9.5% of reads at 1 reader / 1 writer,
    # measured). Live evidence: 3 of 123 turns on the message-visibility rig
    # had a `GET …/chat` poll come back HTTP 500 — the desk's own refresh
    # failing at random while an agent worked.
    #
    # `_read_bytes` handles both halves: the shared latch (so this read does
    # not starve a concurrent replace) and the retry (for a collision from
    # outside this process). It also SLURPS and parses afterwards — the open
    # handle is what blocks os.replace, and parsing a multi-MB doc inside it
    # held it open ~100× longer than the read, while the old code's comment
    # promised a "deterministic close".
    try:
        t0 = time.perf_counter()
        raw = _read_bytes(p)
    except FileNotFoundError:
        # deleted (or replaced) between the exists() check above and the
        # open — delete_org renames the doc out from under readers by design
        raise LedgerError(f"no such org: {slug!r}") from None
    org = Org(json.loads(raw.decode("utf-8")))
    stateprobe.record("load_doc", ms=(time.perf_counter() - t0) * 1000.0,
                      nbytes=len(raw))
    return org


REVISION: int = 0   # bumped on every save — cheap change detection for pollers
               # (the extern long-poll gates its full-doc rescans on this)

# G2 — "the doc changed" fanout, wired to the websocket hub at startup.
#
# It lives HERE, on the write itself, rather than at the endpoints, because the
# endpoint-side version was unenforceable: an audit of every route that calls
# save_org found 14 of 30 with no broadcast, so a second viewer never learned
# about a scope edit, an audience grant, a mail retraction or an inbox read.
# That was invisible in testing because the acting client refetches in its own
# callback — only a SECOND view (another tab, the kiosk, the switchboard beside
# a desk) ever saw the stale copy.
#
# Fixing the 14 by hand would have recreated the very shape this refactor is
# about: N writers each responsible for remembering the same side effect. A
# save IS the change, so the save announces it and a new endpoint cannot forget.
on_save: Callable[[str], None] = lambda slug: None   # no-op until wired
# additional per-save listeners a MODULE registers at import time (on_save is
# a single slot the API claims at startup; these compose instead of racing
# for it). First user: the supervisor's FR-01 remote-control reaper — any doc
# mutation that removes a controlled seat must take its server with it.
save_hooks: list[Callable[[str], None]] = []
#: …and the same idea one step EARLIER: listeners that may still touch the
#: document, run just before it is written. `save_hooks` fire after the bytes
#: are on disk and so cannot affect them.
#:
#: ⚠ A PRE-SAVE HOOK MUST NOT SAVE — it is already inside the write. It takes
#: the `Org` and mutates in place; anything it changes rides the save that
#: invoked it. Registered at import time by the module that owns the rule.
#: First user: the supervisor stamping a frozen node's promised wake, so the
#: deadline a badge will publish is on the record BEFORE any reader — the
#: badge renders from a read-only snapshot and cannot record what it shows.
pre_save_hooks: list[Callable[[Org], None]] = []

# ------------------------------------------------- per-org change sequence
# A PROCESS-LOCAL monotonic counter per org, bumped by every committed save
# (and by delete). One backend per data root is already enforced by the
# `.owner` claim, so "no save bumped it" really does mean "the document did
# not change" — which makes this the one cheap validity test every derived
# cache in the process can share: the reply-identity cache, the org_tree
# ETag, and the background loops' shared snapshot all compare a remembered
# seq against `org_seq(slug)` instead of re-reading megabytes to discover
# nothing moved (perf-redesign 2026-09-12; REPORT.md #1/#3/#7).
#
# Deliberately NOT persisted: a fresh process starts every org at 0, which
# just means every cache's first read is a miss and every client's first
# conditional fetch rebuilds once. Persisting it would buy nothing but a
# schema row and a migration.
_org_seq_lock = threading.Lock()
_org_seq: dict[str, int] = {}

# ------------------------------------------------- accumulated save changes
# What the differ actually wrote since each org's shared snapshot was last
# rebuilt (stateprobe.SaveChanges → top-level keys + node ids). The
# section-granular snapshot refresh (rearchitecture Phase A) re-reads ONLY
# these instead of re-parsing 11 MB because one mailbox moved.
#
# ⚠ THE INVARIANT THE WHOLE SCHEME RESTS ON: every commit that changes an
# org is either published here BEFORE any snapshot rebuild can observe its
# data, or marks the org unknown (`_changed_all`). Under-reporting serves
# READERS STALE STATE; over-reporting merely costs a wasted small read. The
# per-slug `_snap_gate` is what makes "before" true: a save holds it across
# {COMMIT, publish, seq bump}, a rebuild holds it across {drain, read
# transaction}, so a rebuild can never see a commit whose keys it has not
# drained. Writes from another process cannot exist (`.owner` claim).
_changed_lock = threading.Lock()
_changed_keys: dict[str, set[str]] = {}
_changed_nodes: dict[str, set[str]] = {}
#: node INSERTS/DELETES only — the structural delta. While it is empty the
#: node id ORDER cannot have changed, so a snapshot refresh can keep the
#: previous order and skip the 709-row id scan whose per-row GIL bounces
#: cost ~5 ms each beside one Python-busy dispatch thread (measured: the
#: scan alone was seconds under swarm; single-row fetches are not).
_changed_node_struct: dict[str, set[str]] = {}
#: saves whose change set could not be trusted (a plain-dict doc, a JSON
#: backend save, a failure mid-collection) force the next snapshot rebuild
#: to be a full reload.
_changed_all: set[str] = set()
_snap_gates: dict[str, threading.Lock] = {}
#: per-slug snapshot REBUILD mutex — herd suppression, not coherence. Under
#: sustained writes every request used to find the cache stale and re-parse
#: the document in parallel; N concurrent 11 MB parses dilute each other
#: under the GIL into tens of seconds apiece (measured: 25 concurrent loads
#: at ~20 s each where one alone costs ~100 ms). One rebuilder works, the
#: rest wait and are served its result.
_rebuild_locks: dict[str, threading.Lock] = {}


def _snap_gate(slug: str) -> threading.Lock:
    with _changed_lock:
        gate = _snap_gates.get(slug)
        if gate is None:
            gate = _snap_gates[slug] = threading.Lock()
        return gate


def _rebuild_mutex(slug: str) -> threading.Lock:
    with _changed_lock:
        m = _rebuild_locks.get(slug)
        if m is None:
            m = _rebuild_locks[slug] = threading.Lock()
        return m


def _publish_changes(slug: str, changes: SaveChanges) -> None:
    try:
        with _changed_lock:
            _changed_keys.setdefault(slug, set()).update(changes.changed_keys())
            _changed_nodes.setdefault(slug, set()).update(
                changes.node_updates, changes.node_inserts, changes.node_deletes)
            if changes.node_inserts or changes.node_deletes:
                _changed_node_struct.setdefault(slug, set()).update(
                    changes.node_inserts, changes.node_deletes)
    except Exception:
        with _changed_lock:
            _changed_all.add(slug)


def _publish_changes_unknown(slug: str) -> None:
    """A save whose exact change set is unknown (JSON backend, failure mid
    collection): the next reader rebuild must not trust the accumulation."""
    with _changed_lock:
        _changed_all.add(slug)


def _invalidate_snapshot(slug: str) -> None:
    """Delete/rename/migration/backend surprises: drop everything derived."""
    _resident.pop(slug, None)
    with _doc_cache_lock:
        _doc_cache.pop(slug, None)
    with _changed_lock:
        _changed_all.discard(slug)
        _changed_keys.pop(slug, None)
        _changed_nodes.pop(slug, None)
        _changed_node_struct.pop(slug, None)


def org_seq(slug: str) -> int:
    """The org's current change sequence (0 until its first save here)."""
    with _org_seq_lock:
        return _org_seq.get(slug, 0)


def _bump_org_seq(slug: str) -> None:
    """Advance the change sequence. The cached snapshot is deliberately NOT
    dropped any more: a stale entry is the seed the section-granular refresh
    rebuilds from (`_assemble_snapshot`), and seq mismatch is what marks it
    stale. Paths that cannot describe their change publish `unknown`, which
    forces the next rebuild to be a full reload instead."""
    with _org_seq_lock:
        _org_seq[slug] = _org_seq.get(slug, 0) + 1


# --------------------------------------------- shared read-only snapshots
# (perf-redesign 2026-09-12, REPORT.md #7.) Six background loops — the
# watchdog tick (5 s), the Electron status poll (5 s), transcript capture
# (1 s), the storage watchdog (20 s), the working-cache keeper's stages
# (20 s) and auto-resume (30 s) — each re-listed and re-parsed the whole
# data root on their own clocks, idle or not: about one full-root parse per
# second at 449 nodes, linear in fleet size, all to re-derive facts that
# had not changed. `org_seq` already knows whether they changed.
#
# ⚠ READ-ONLY BY CONTRACT. The returned Org is SHARED across every loop in
# the process: never mutate it, never save it, never hand it to anything
# that will. Write passes keep their own fresh `load_org` under DOC_LOCK —
# the cycle rule (№22 / the DOC_LOCK comment above) is untouched. Lazy
# sections materialize onto the shared instance if touched; the loops this
# exists for read only eager fields (nodes, watchdogs, kiosk, workspace).
_doc_cache_lock = threading.Lock()
_doc_cache: dict[str, tuple[int, "Org"]] = {}


def _load_pinned(slug: str) -> tuple[Org, int]:
    """A full snapshot load whose view PROVABLY equals its recorded seq.

    The old rule — cache a full load only if `org_seq` did not move across
    it — starves the cache under sustained writes: the first snapshot can
    never form, every gate read re-parses the document, and concurrent
    parses dilate each other under the GIL (the 2026-09-19 message-send
    incident's mechanism). Pinning closes it: the seq is read and the read
    transaction's WAL view is pinned INSIDE the per-slug snapshot gate, so
    no save can commit between the two — the loaded document is exactly the
    state at `seq_pin` and is always cacheable. The gate is held only for
    the pin (microseconds), not the parse; accumulated change sets die here
    too, superseded by the full view."""
    slug = _safe_slug(slug)
    _ensure_migrated(slug)
    if not os.path.exists(_db_path(slug)):
        raise LedgerError(f"no such org: {slug!r}")
    t0 = time.perf_counter()
    with _POOL.acquire(slug) as conn:
        with _snap_gate(slug):
            with _changed_lock:
                _changed_all.discard(slug)
                _changed_keys.pop(slug, None)
                _changed_nodes.pop(slug, None)
                _changed_node_struct.pop(slug, None)
            seq_pin = org_seq(slug)
            conn.execute("BEGIN")
            _meta_get(conn, "schema_version")     # first read pins the view
        doc = _load_lazy(conn, slug, txn_open=True)
    t1 = time.perf_counter()
    org = Org(cast("OrgDoc", doc))
    stateprobe.record("load_doc", ms=(t1 - t0) * 1000.0,
                      nbytes=getattr(doc, "_eager_bytes", 0))
    stateprobe.record("org_init", ms=(time.perf_counter() - t1) * 1000.0)
    return org, seq_pin


def _assemble_snapshot(slug: str, prev: Org) -> tuple[Org, int] | None:
    """Rebuild the shared snapshot from `prev` plus exactly what saves
    changed since it was built (rearchitecture Phase A).

    Returns (org, seq) — a NEW read-only Org sharing every unchanged parsed
    object with `prev`, with only the changed doc keys and node rows re-read
    and re-parsed in one gated transaction — or None, meaning the caller
    must full-load (first build, unknown change set, or any structural
    surprise; every surprise bails rather than guessing, because an
    over-refresh costs a small read and an under-refresh serves stale
    state).

    The GATE covers only {accumulator drain, seq read, transaction pin} —
    microseconds — so no save can commit between the drain and the read
    view (the invariant note on `_changed_lock` is load-bearing here); the
    row reads and the build then run on the pinned WAL view WITHOUT the
    gate, so a slow read can never make a committing save wait. (Its first
    shape gated the whole body, and under a 17-writer swarm that composed
    with the connection-open DDL into a seconds-long inversion.)
    """
    prev_d = cast("dict[str, Any]", prev.d)
    if not isinstance(prev_d, LazyDoc) or prev_d._slug != slug:
        return None
    prev_nodes = cast("dict[str, Any]", dict.get(prev_d, "nodes") or {})
    t0 = time.perf_counter()
    with _POOL.acquire(slug) as conn:
        with _snap_gate(slug):
            _gw = time.perf_counter()
            stateprobe.record("gate_wait_assemble", ms=(_gw - t0) * 1000.0)
            with _changed_lock:
                if slug in _changed_all:
                    return None
                keys = _changed_keys.pop(slug, set())
                nids = _changed_nodes.pop(slug, set())
                structural = bool(_changed_node_struct.pop(slug, None))
            seq = org_seq(slug)
            try:
                conn.execute("BEGIN")
                raw_order = _meta_get(conn, _META_KEY_ORDER)   # pins the view
            except BaseException:
                _publish_changes_unknown(slug)
                if conn.in_transaction:
                    with contextlib.suppress(Exception):
                        conn.execute("ROLLBACK")
                raise
            stateprobe.record("gate_hold_assemble",
                              ms=(time.perf_counter() - _gw) * 1000.0)
        try:
            fresh_doc: dict[str, str] = {}
            fresh_present: set[str] = set()
            if True:
                try:
                    order: list[str] = (cast("list[str]", json.loads(raw_order))
                                        if raw_order else [])
                    for k in keys:
                        if k == "nodes":
                            continue
                        row = conn.execute("SELECT val FROM doc WHERE key=?",
                                           (k,)).fetchone()
                        if row is not None:
                            fresh_doc[k] = cast(str, row[0])
                        elif k in LAZY_SECTIONS:
                            if k in DICT_LOGS:
                                if conn.execute("SELECT 1 FROM log_d WHERE sect=? "
                                                "LIMIT 1", (k,)).fetchone() \
                                        or _meta_get(conn, _META_OWNERS + k) is not None:
                                    fresh_present.add(k)
                            elif conn.execute("SELECT 1 FROM log_l WHERE sect=? "
                                              "LIMIT 1", (k,)).fetchone():
                                fresh_present.add(k)
                    _ta = time.perf_counter()
                    if structural:
                        id_order = [cast(str, r[0]) for r in
                                    conn.execute("SELECT id FROM nodes "
                                                 "ORDER BY ord").fetchall()]
                    else:
                        # no insert or delete since the last snapshot: the
                        # previous order IS the order, and skipping the scan
                        # keeps refresh cost strictly proportional to the
                        # delta even under GIL contention
                        id_order = list(dict.keys(prev_nodes))
                    _tb = time.perf_counter()
                    fresh_nodes: dict[str, str] = {}
                    for nid in nids:
                        row = conn.execute("SELECT val FROM nodes WHERE id=?",
                                           (nid,)).fetchone()
                        if row is not None:
                            fresh_nodes[nid] = cast(str, row[0])
                    _tc = time.perf_counter()
                    conn.execute("COMMIT")
                    stateprobe.record("asm_keys", ms=(_ta - _gw) * 1000.0)
                    stateprobe.record("asm_idscan", ms=(_tb - _ta) * 1000.0)
                    stateprobe.record("asm_nids", ms=(_tc - _tb) * 1000.0)
                    stateprobe.record("asm_commit", ms=(time.perf_counter() - _tc) * 1000.0)
                except BaseException:
                    if conn.in_transaction:
                        with contextlib.suppress(Exception):
                            conn.execute("ROLLBACK")
                    raise
            _t_rows = time.perf_counter()
            if "nodes" in fresh_doc:
                raise _AssembleBail("nodes stored as a blob")
            # ---- assemble, sharing unchanged objects with prev ----------
            prev_known = set(prev_d._key_order)
            d2 = LazyDoc(slug)
            nodes2: NodesMap = NodesMap()
            carried: set[str] = set()
            for nid in id_order:
                if nid in nids:
                    raw = fresh_nodes.get(nid)
                    if raw is None:
                        raise _AssembleBail(f"changed node {nid!r} vanished mid-read")
                    dict.__setitem__(nodes2, nid, json.loads(raw))
                    d2._snap_nodes[nid] = raw
                else:
                    if not dict.__contains__(prev_nodes, nid) \
                            or nid not in prev_d._snap_nodes:
                        # a node this process never published a change for is
                        # on disk — the accumulator missed something
                        raise _AssembleBail(f"unpublished node {nid!r}")
                    dict.__setitem__(nodes2, nid, dict.__getitem__(prev_nodes, nid))
                    d2._snap_nodes[nid] = prev_d._snap_nodes[nid]
                    carried.add(nid)
            present2: set[str] = set(fresh_present)
            # an always-present row inserted by a save is not in the recorded
            # key_order (writing it there would cost every first save a meta
            # write); take it from the change set or the previous snapshot
            order = [*order, *(k for k in ALWAYS_ROWS if k not in order
                               and (k in keys or k in prev_d._snap_doc))]
            for k in order:
                if k == "nodes":
                    dict.__setitem__(d2, "nodes", nodes2)
                    continue
                if k in keys:
                    if k in fresh_doc:
                        d2._snap_doc[k] = fresh_doc[k]
                        dict.__setitem__(d2, k, json.loads(fresh_doc[k]))
                    # else: a deleted key, or a lazy section that stays
                    # unmaterialized (presence already in fresh_present)
                    continue
                if k in prev_d._snap_doc:
                    if not dict.__contains__(prev_d, k):
                        raise _AssembleBail(f"snap without value for {k!r}")
                    d2._snap_doc[k] = prev_d._snap_doc[k]
                    dict.__setitem__(d2, k, dict.__getitem__(prev_d, k))
                elif k in LAZY_SECTIONS:
                    if k in prev_d._present or dict.__contains__(prev_d, k):
                        present2.add(k)
                elif k not in prev_known:
                    # a key on disk this process never published — the
                    # accumulator missed something
                    raise _AssembleBail(f"unpublished key {k!r}")
            if "nodes" not in order and id_order:
                dict.__setitem__(d2, "nodes", nodes2)
                order = [*order, "nodes"]
            docish = set(d2._snap_doc)
            d2._key_order = [k for k in order
                             if k in docish or k == "nodes"
                             or (k in LAZY_SECTIONS and k in present2)]
            d2._present = {k for k in present2 if k not in docish}
            d2._normalized_nodes = carried  # type: ignore[attr-defined]  # Org.__init__ honors it
            d2._eager_bytes = (sum(len(v) for v in d2._snap_doc.values())
                               + sum(len(v) for v in d2._snap_nodes.values()))
            _t_build = time.perf_counter()
            org2 = Org(cast("OrgDoc", d2))
            stateprobe.record("asm_rows", ms=(_t_rows - t0) * 1000.0)
            stateprobe.record("asm_share", ms=(_t_build - _t_rows) * 1000.0)
            stateprobe.record("asm_orginit", ms=(time.perf_counter() - _t_build) * 1000.0)
            fresh_bytes = (sum(len(v) for v in fresh_doc.values())
                           + sum(len(v) for v in fresh_nodes.values()))
            stateprobe.record("snapshot_refresh",
                              ms=(time.perf_counter() - t0) * 1000.0,
                              nbytes=fresh_bytes,
                              detail={"keys": sorted(keys),
                                      "nodes": len(nids)})
            return org2, seq
        except BaseException as e:
            # whatever was drained can no longer be trusted to be complete
            _publish_changes_unknown(slug)
            # the bail REASON is operational gold: two bails per swarm run
            # were invisible until this row existed, and each one costs the
            # next reader a full parse — a reason that recurs is a bug to fix
            stateprobe.record("snapshot_bail",
                              detail={"reason": f"{type(e).__name__}: {e}"[:200]})
            if not isinstance(e, (_AssembleBail, LedgerError, sqlite3.Error,
                                  KeyError, ValueError, TypeError, OSError)):
                raise
            return None


class _AssembleBail(Exception):
    """A snapshot rebuild met something it cannot account for — full-load."""


def cached_org(slug: str) -> Org:
    """The org as of its last save, shared and read-only. A dict lookup
    while `org_seq` is unchanged; a section-granular refresh — re-reading
    only what saves actually changed — when it moved; one gate-pinned full
    load on first build or when a change set is unknown. Rebuilds of either
    kind run under a per-slug mutex: concurrent readers wait for one
    rebuilder's result instead of parsing in parallel (the herd is the
    2026-09-19 incident's amplifier), and every waiter is served a snapshot
    at least as fresh as its own arrival."""
    arrival = org_seq(slug)
    with _doc_cache_lock:
        hit = _doc_cache.get(slug)
    if hit is not None and hit[0] == arrival:
        return hit[1]
    if not row_store():
        # the JSON backend keeps the historical semantics: fresh load,
        # cache only when the seq held still across it
        try:
            org = load_org(slug)
        except Exception:
            with _doc_cache_lock:
                _doc_cache.pop(slug, None)
            raise
        org._shared_snapshot = True   # type: ignore[attr-defined]
        if org_seq(slug) == arrival:
            with _doc_cache_lock:
                _doc_cache[slug] = (arrival, org)
        return org
    with _rebuild_mutex(slug):
        # the rebuilder ahead of us may already have served our need
        with _doc_cache_lock:
            hit = _doc_cache.get(slug)
        if hit is not None and hit[0] >= arrival:
            return hit[1]
        if hit is not None:
            assembled = _assemble_snapshot(slug, hit[1])
            if assembled is not None:
                org2, seq2 = assembled
                # the mark first-use helpers honor (perf-review round 2):
                # a marked org is never stamped by the incarnation minters —
                # the mint's own save bumps the seq and the next refresh
                # carries the minted value instead
                org2._shared_snapshot = True   # type: ignore[attr-defined]
                with _doc_cache_lock:
                    cur = _doc_cache.get(slug)
                    if cur is None or cur[0] <= seq2:
                        _doc_cache[slug] = (seq2, org2)
                return org2
        try:
            org, seq_pin = _load_pinned(slug)
        except LedgerError:
            # No database on disk. `load_org` is the historical door here and
            # stays one so tests that inject a fixture document by patching
            # it keep working; production reaches this only to raise the same
            # "no such org" the pinned load just did. Residency suppressed:
            # the shared snapshot must never be the mutable write document.
            _hold_track.suppress_resident = True
            try:
                org = load_org(slug)
            except Exception:
                with _doc_cache_lock:
                    _doc_cache.pop(slug, None)
                raise
            finally:
                _hold_track.suppress_resident = False
            org._shared_snapshot = True   # type: ignore[attr-defined]
            if org_seq(slug) == arrival:
                with _doc_cache_lock:
                    _doc_cache[slug] = (arrival, org)
            return org
        except Exception:
            with _doc_cache_lock:
                _doc_cache.pop(slug, None)
            raise
        org._shared_snapshot = True   # type: ignore[attr-defined]
        with _doc_cache_lock:
            cur = _doc_cache.get(slug)
            if cur is None or cur[0] <= seq_pin:
                _doc_cache[slug] = (seq_pin, org)
        return org


#: slugs handed a resident during the CURRENT thread's lock hold — what the
#: release hook checks. Thread-local because holds are per-thread.
_hold_track = threading.local()

#: a freshly parsed, settled document waiting to become the resident —
#: produced under the rebuild mutex (never under DOC_LOCK), consumed and
#: advanced to currency under DOC_LOCK. See write_org's cold path.
_warm_pending: dict[str, Org] = {}


def _advance_resident(slug: str, d: LazyDoc) -> bool:
    """Bring a gate-pinned document up to the present, under DOC_LOCK.

    The pin guarantees `d` equals the state at its pin seq; every commit
    since then published its change set to the accumulator (the gate
    invariant), and no further save can land while DOC_LOCK is held — so
    re-reading exactly the accumulated rows makes `d` exactly current.
    Returns False when the delta cannot be trusted (an unknown change set):
    the caller falls back to the in-lock load rather than guessing."""
    with _changed_lock:
        if slug in _changed_all:
            _changed_all.discard(slug)
            _changed_keys.pop(slug, None)
            _changed_nodes.pop(slug, None)
            return False
        keys = _changed_keys.pop(slug, set())
        nids = _changed_nodes.pop(slug, set())
        _changed_node_struct.pop(slug, None)
    if not keys and not nids:
        return True
    try:
        with _POOL.acquire(slug) as conn:
            conn.execute("BEGIN")
            try:
                for k in keys:
                    if k == "nodes":
                        continue
                    row = conn.execute("SELECT val FROM doc WHERE key=?",
                                       (k,)).fetchone()
                    if k in LAZY_SECTIONS:
                        # stay lazy: drop any materialized copy and let the
                        # next touch read fresh rows; presence re-derived
                        if dict.__contains__(d, k):
                            dict.__delitem__(d, k)
                        d._snap_logs.pop(k, None)
                        if row is not None:
                            d._snap_doc[k] = cast(str, row[0])
                            dict.__setitem__(d, k, json.loads(cast(str, row[0])))
                            d._present.discard(k)
                        else:
                            d._snap_doc.pop(k, None)
                            if k in DICT_LOGS:
                                present = bool(conn.execute(
                                    "SELECT 1 FROM log_d WHERE sect=? LIMIT 1",
                                    (k,)).fetchone()) or _meta_get(
                                        conn, _META_OWNERS + k) is not None
                            else:
                                present = bool(conn.execute(
                                    "SELECT 1 FROM log_l WHERE sect=? LIMIT 1",
                                    (k,)).fetchone())
                            if present:
                                d._present.add(k)
                            else:
                                d._present.discard(k)
                        continue
                    if row is not None:
                        d._snap_doc[k] = cast(str, row[0])
                        dict.__setitem__(d, k, json.loads(cast(str, row[0])))
                    else:
                        d._snap_doc.pop(k, None)
                        if dict.__contains__(d, k):
                            dict.__delitem__(d, k)
                if nids:
                    nodes = dict.get(d, "nodes")
                    if not isinstance(nodes, dict):
                        raise _AssembleBail("nodes not a dict during advance")
                    for nid in nids:
                        row = conn.execute("SELECT val FROM nodes WHERE id=?",
                                           (nid,)).fetchone()
                        if row is not None:
                            dict.__setitem__(nodes, nid,
                                             json.loads(cast(str, row[0])))
                            d._snap_nodes[nid] = cast(str, row[0])
                        else:
                            if dict.__contains__(nodes, nid):
                                dict.__delitem__(nodes, nid)
                            d._snap_nodes.pop(nid, None)
                raw_order = _meta_get(conn, _META_KEY_ORDER)
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    with contextlib.suppress(Exception):
                        conn.execute("ROLLBACK")
                raise
        if raw_order:
            order = cast("list[str]", json.loads(raw_order))
            docish = set(d._snap_doc)
            d._key_order = [k for k in order
                            if k in docish or k == "nodes"
                            or (k in LAZY_SECTIONS and k in d._present)]
        stateprobe.record("resident_advance", nbytes=len(keys) + len(nids),
                          detail={"keys": sorted(keys)[:8], "nodes": len(nids)})
        return True
    except Exception as e:
        stateprobe.record("snapshot_bail",
                          detail={"reason": f"advance {type(e).__name__}: {e}"[:200]})
        _publish_changes_unknown(slug)
        return False


def _settle_marks(d: LazyDoc) -> None:
    """Resolve construction-time marks into truth, once, at resident
    registration.

    `Org.__init__` walks the whole document applying idempotent migrations —
    `values()`/`items()` walks that the read barrier must conservatively
    record (it cannot know a walker won't mutate). Left standing, those
    construction marks would put every node back into every save's dump set
    and the access-scoped save would be a no-op. Settling compares each
    marked entry against its loaded baseline exactly once: an entry the
    constructor did NOT change is unmarked (nothing to persist), an entry it
    DID change keeps its mark so the migration delta reaches disk on the
    next save — the same outcome the full differ produced, at one
    registration-time pass instead of every save."""
    for k in list(d._touched):
        if k in ROWED or k in LAZY_SECTIONS:
            continue
        if dict.__contains__(d, k) and k in d._snap_doc \
                and d._snap_doc[k] == _dumps(dict.__getitem__(d, k)):
            d._touched.discard(k)
    nodes = dict.get(d, "nodes")
    if isinstance(nodes, NodesMap):
        nids = (set(dict.keys(nodes)) if nodes._touched_all
                else set(nodes._touched))
        real: set[str] = set()
        for nid in nids:
            if not dict.__contains__(nodes, nid):
                real.add(nid)
                continue
            sn = d._snap_nodes.get(nid)
            if sn is None or sn != _dumps(dict.__getitem__(nodes, nid)):
                real.add(nid)
        nodes._touched = real
        nodes._touched_all = False


def _on_doc_lock_release() -> None:
    """Runs at every outermost DOC_LOCK release, still owning the lock: the
    uniform discard-property enforcement for EVERY write cycle, converted or
    classic. For each org handed a resident in this hold — an entry whose
    serialization no longer matches its adopted baseline, a buffered append
    never saved, or a lazy section exposed after the last save, drops the
    resident (loudly for real dirt): the abandoned state is discarded
    exactly as the old fresh-copy semantics discarded it, and the next
    cycle reloads clean. A hold that only read, or that saved what it
    changed, keeps residency at the cost of re-checking what it touched."""
    slugs = getattr(_hold_track, "slugs", None)
    if not slugs:
        return
    _hold_track.slugs = set()
    for slug in slugs:
        org = _resident.get(slug)
        if org is None:
            continue
        d = cast("dict[str, Any]", org.d)
        if not isinstance(d, LazyDoc):
            _resident.pop(slug, None)
            continue
        try:
            dirty = _resident_dirty(d)
            if any(rows for rows in d._pending.values()):
                dirty.append("(pending log appends)")
        except Exception:
            _resident.pop(slug, None)
            continue
        if dirty:
            _resident.pop(slug, None)
            stateprobe.record("resident_abandoned", detail={"keys": dirty[:8]})
            print(f"[orgtree.store] write cycle for {slug!r} mutated without "
                  f"saving ({', '.join(dirty[:5])}) — resident dropped",
                  flush=True)
        elif d._lazy_exposed:
            # a materialized log section was exposed after the last save;
            # rows cannot be cheaply re-verified, so residency is the price
            # of certainty rather than the risk of an unsaved edit riding a
            # later caller's save
            _resident.pop(slug, None)
            stateprobe.record("resident_lazy_exposed",
                              detail={"sections": sorted(d._lazy_exposed)[:8]})


@contextlib.contextmanager
def write_org(slug: str) -> Generator[Org]:
    """The write cycle (rearchitecture Phase B): DOC_LOCK plus the per-org
    RESIDENT document.

    `with write_org(slug) as org: … ; save_org(org)` replaces the classic
    `with DOC_LOCK: org = load_org(slug); … ; save_org(org)` — and since
    `load_org` itself serves the resident under a held lock, the two
    spellings are exactly equivalent now; this one just names the intent.
    Semantics against the classic cycle are unchanged: same lock, same save
    fanout, and the discard property (a cycle that raises or abandons its
    mutations leaves no trace in anyone's later save) is enforced for both
    spellings by the lock's release hook (`_on_doc_lock_release`). The cost
    is what changed: after the first cycle the 11 MB parse and the
    whole-tree Org construction are gone, and the access-scoped save dumps
    only what the cycle exposed.

    Known narrow limit, accepted and documented: read barriers are sticky
    per document, so a mutation through a handle retained across saves and
    Condition-waits is still caught — but an UNSAVED row edit in a lazy
    section can escape the release check if a concurrent hold's save
    settles the exposure flag first (Condition-wait interleavings only;
    eager state is never subject to this). The row differ still writes such
    an edit on the next save, so the exposure is to the discard property in
    that corner, not to durability.

    The JSON backend keeps the exact historical behavior: lock + fresh
    load, no residency."""
    if not row_store():
        with DOC_LOCK:
            yield load_org(slug)
        return
    # COLD-START WITHOUT THE WORLD STOPPED (incident 2026-09-19): when the
    # resident is absent, the 11 MB parse used to run inside the lock — one
    # such load under swarm contention measured as a 20-second global stall
    # that queued every write behind it, which is exactly the shape of "a
    # message would not send for minutes"; and a naive load-then-install
    # retry can never install under sustained writes (the seq always moves),
    # so seventeen threads spin full parses that dilate each other under
    # the GIL. The bounded construction: one thread (rebuild mutex) parses
    # a gate-PINNED document lock-free, then takes the lock and ADVANCES it
    # to currency by re-reading exactly the rows the accumulator says were
    # committed after the pin — few rows, milliseconds, and complete by the
    # gate invariant — and yields inside that same hold.
    if _resident.get(slug) is None:
        # Lock ORDER: DOC_LOCK may be held while touching the rebuild mutex
        # (a legacy reader calling cached_org under its own lock), so the
        # mutex must NEVER be held while waiting on DOC_LOCK — the parse
        # runs under the mutex alone and hands its result to the locked
        # section through a pending slot.
        with _rebuild_mutex(slug):
            if _resident.get(slug) is None and slug not in _warm_pending:
                warm, _seq_pin = _load_pinned(slug)
                if isinstance(warm.d, LazyDoc):
                    _settle_marks(warm.d)
                    _warm_pending[slug] = warm
    with DOC_LOCK:
        if _resident.get(slug) is None:
            warm2 = _warm_pending.pop(slug, None)
            if warm2 is not None \
                    and _advance_resident(slug, cast(LazyDoc, warm2.d)):
                _resident[slug] = warm2
        else:
            _warm_pending.pop(slug, None)
        yield load_org(slug)


def _resident_dirty(d: LazyDoc) -> list[str]:
    """Touched entries whose serialization no longer matches the adopted
    baseline — i.e. mutations that were never saved. Cost is proportional
    to what the cycle touched; an untouched document costs nothing."""
    dirty: list[str] = []
    for k in list(d._touched):
        if k in ROWED or k in LAZY_SECTIONS:
            continue
        if dict.__contains__(d, k):
            if d._snap_doc.get(k) != _dumps(dict.__getitem__(d, k)):
                dirty.append(k)
        elif k in d._snap_doc:
            dirty.append(k)                     # deleted but never saved
    nodes = dict.get(d, "nodes")
    if isinstance(nodes, NodesMap):
        nids = (set(dict.keys(nodes)) | set(d._snap_nodes)
                if nodes._touched_all else set(nodes._touched))
        for nid in nids:
            if dict.__contains__(nodes, nid):
                if d._snap_nodes.get(nid) != _dumps(dict.__getitem__(nodes, nid)):
                    dirty.append(f"nodes[{nid}]")
            elif nid in d._snap_nodes:
                dirty.append(f"nodes[{nid}]")
    return dirty


def cached_list() -> list[dict[str, Any]]:
    """`list_orgs()` for the background loops: same summary rows, answered
    from the shared snapshots. The dir listing itself is the only per-call
    filesystem work; nothing is parsed unless its org actually changed.
    Unlike `_scan_orgs` this never migrates stray JSON documents inline —
    the loops have no business migrating; the API listing still does."""
    if not row_store():
        return list_orgs()
    out: list[dict[str, Any]] = []
    for f in sorted(os.listdir(_orgs_dir())):
        if not f.endswith(db_ext()):
            continue
        slug = f[:-len(db_ext())]
        try:
            _safe_slug(slug)
            out.append(_summary_row(slug, cached_org(slug).d))
        except (LedgerError, sqlite3.Error, ValueError, OSError):
            continue
    return out


def _save_json(org: Org) -> None:
    p = _json_path(org.d["slug"])
    # serialise BEFORE creating the temp file: a doc carrying a
    # non-serialisable value used to raise halfway through json.dump and
    # strand a half-written .tmp in orgs/ for good.
    blob = json.dumps(org.d, indent=2).encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
            # os.replace is atomic against a CRASH, but only against a crash
            # of the process: NTFS may make the rename durable before the
            # data, so a power loss can leave a correctly-named doc full of
            # zeros. Costs 2.9 ms vs 0.9 ms on a 1.8 MB doc — nothing beside
            # an agent turn, and this file is the org.
            f.flush()
            os.fsync(f.fileno())
        # The latch (see _IOLatch) is what actually makes this land; the
        # retry stays for collisions no in-process latch can see — another
        # process, a scanner, a backup agent holding the doc open.
        for i in range(20):
            try:
                with _IO.exclusive():
                    os.replace(tmp, p)
                tmp = ""
                break
            except PermissionError:
                if i == 19:
                    raise
                time.sleep(0.01 * (i + 1))
    finally:
        if tmp:                       # every failure path cleans up after itself
            try:
                os.remove(tmp)
            except OSError:
                pass


def save_org(org: Org) -> None:
    """Persist the org. JSON: atomic whole-document rewrite. SQLite: one
    `BEGIN IMMEDIATE` transaction writing only what changed (§4.5). Either
    way the save IS the change: `REVISION`, `on_save` and `save_hooks` fire
    exactly as they always have."""
    with profiling.stage("org_save_ms"):
        _save_org(org)


def _save_org(org: Org) -> None:
    _assert_synced_data_root()
    from .notification_state import reconcile_attention
    _t0 = time.perf_counter()
    # reconcile reads only work_items and asks, and rewrites only work_items
    # fields derived from them — with the read barrier in place (Phase B) it
    # runs exactly when either input could have moved. Unconditionally it
    # would MARK both sections on every save and cost every one-field write
    # a 700 KB re-serialize; skipping it when neither input was exposed is
    # semantically the identity (unchanged inputs ⇒ unchanged outputs).
    _ld = org.d if isinstance(org.d, LazyDoc) else None
    if _ld is None or "work_items" in _ld._touched or "asks" in _ld._touched:
        reconcile_attention(org.d)
    stateprobe.record("save_reconcile",
                      ms=(time.perf_counter() - _t0) * 1000.0)
    for _h in list(pre_save_hooks):
        # never let a listener fail the write — the caller's change matters
        # more than the derived field a hook wanted to add.
        try:
            _h(org)
        except Exception:                                    # noqa: BLE001
            pass
    global REVISION
    if row_store():
        # seq bump + change publication happen INSIDE _save_sqlite, under the
        # per-org snapshot gate, atomically with the commit
        _save_sqlite(org)
    else:
        _t1 = time.perf_counter()
        _save_json(org)
        stateprobe.record("save_doc", ms=(time.perf_counter() - _t1) * 1000.0)
        # the JSON backend has no change record: readers full-reload
        _publish_changes_unknown(org.d["slug"])
        _bump_org_seq(org.d["slug"])
    REVISION += 1  # pyright: ignore[reportConstantRedefinition]  # uppercase mutable counter is the public API; renaming is forbidden this wave
    # PG-0: inside an org_tx the hooks are deferred; org_tx fires them after
    # COMMIT with its row locks released (plan decision 14)
    deferred = getattr(_orgtx_local, "defer_hooks", None)
    if deferred is not None:
        deferred.append(org.d["slug"])
        return
    fire_save_hooks(org.d["slug"])


def fire_save_hooks(slug: str) -> None:
    """`on_save` then every `save_hooks` entry, each failure swallowed: the
    doc is already committed, and a fanout failure must not fail the write."""
    try:
        on_save(slug)
    except Exception:
        pass
    for h in list(save_hooks):
        try:
            h(slug)
        except Exception:
            pass


def workspace_dir(slug: str) -> str:
    _assert_synced_data_root()
    return os.path.join(DATA_ROOT, "workspaces", slug)


def create_org(name: str, extra_dirs: list[str] | None = None,
               permission_mode: str = "acceptEdits") -> Org:
    """Every org gets its own fresh workspace dir, minted here. Pre-existing
    directories are an ADVANCED grant (`extra_dirs`) — appended after the workspace
    in the org's default capability set."""
    _assert_synced_data_root()
    slug = slugify(name)
    _ensure_migrated(slug)
    if os.path.exists(org_path(slug)):
        raise LedgerError(f"org {slug!r} already exists")
    ws = os.path.normpath(workspace_dir(slug))
    os.makedirs(ws, exist_ok=True)
    dirs = [ws] + [os.path.normpath(d) for d in (extra_dirs or []) if d.strip()]
    org = Org.create(name, dirs, permission_mode, workspace=ws)
    save_org(org)
    return org


def delete_org(slug: str) -> None:
    _assert_synced_data_root()
    """Gap audit №16: one confirmed hover-click used to `os.remove` the whole
    org — structure, charters, mailboxes, event history. The motto reserves
    hard stops for protecting the user's data, so delete is now a RENAME into
    <data>/deleted/; putting the file back in orgs/ IS the restore.

    SQLite (§5.3): the WAL is checkpointed and truncated and every pooled
    connection closed BEFORE the rename, so no committed frame is left behind
    in a `-wal` the renamed file no longer owns; any sidecar that still exists
    afterwards travels with the database under the same trash stem."""
    p = org_path(slug)                      # validates the slug (see _safe_slug)
    trash = os.path.join(DATA_ROOT, "deleted")
    ext = db_ext() if row_store() else ".json"
    # Under DOC_LOCK like every other write: without it a load-modify-save
    # cycle already in flight re-creates the doc AFTER the rename and the org
    # comes back from the dead, half-populated and with no trash copy of the
    # final state.
    with DOC_LOCK:
        _ensure_migrated(slug)
        if not os.path.exists(p):
            raise LedgerError(f"no such org: {slug!r}")
        os.makedirs(trash, exist_ok=True)
        # ⚠ The stamp is SECOND-granular, and `os.replace` overwrites. Delete
        # → recreate → delete inside one second silently destroyed the first
        # backup — the exact loss №16 made delete-as-rename to prevent, just
        # moved one step along. Never overwrite anything in the trash: find a
        # free name, and only then rename.
        #
        # ⚠⚠ FREE MEANS FREE FOR EVERY ARTEFACT UNDER THE STEM, not just the
        # database. This search used to test `<stem>.db` alone — from when the
        # database WAS the org. It is not: `<stem>.json` and
        # `<stem>.json.premigration` travel under the same stem now. Restore
        # the `.db` out of the trash (which this module's own docstrings call
        # the restore), leave its premigration behind, and delete again in
        # the same second: the `.db` slot is free, the stem is reused, and
        # `os.replace` overwrites a premigration holding the whole
        # pre-migration history of the earlier org. Measured by phase1-audit
        # on 2026-09-04 — `old_history_survived=false`.
        stamp = time.strftime("%Y%m%dT%H%M%S")

        def _stem(k: int) -> str:
            return os.path.join(trash, f"{slug}-{stamp}" + (f"-{k}" if k else ""))

        n = 0
        while any(os.path.exists(_stem(n) + suf) for suf in _TRASH_SUFFIXES):
            n += 1
        stem = _stem(n)
        dest = stem + ext
        # every artefact of this org that is NOT the document itself. Under
        # JSON the document IS `<slug>.json`, so only the premigration is an
        # extra; under SQLite the database is the document and both JSON
        # shapes are extras.
        jp = _json_path(slug)
        extras = [(jp + ".premigration", ".json.premigration")]
        if row_store():
            extras.insert(0, (jp, ".json"))

        # ⚠⚠ THE EXTRAS MOVE FIRST, AND A FAILURE HERE ABORTS THE DELETE.
        #
        # They used to move LAST, each wrapped in `suppress(OSError)`, after
        # the database was already in the trash. On Windows an ordinary open
        # read handle — a backup tool, a sync client, an operator's editor —
        # makes `os.replace` raise, and that raise was swallowed. Measured:
        # `delete_org` returned SUCCESS having moved the database out and
        # left a bare `<slug>.json` in `orgs/`, which is precisely
        # `pending_migrations`' definition of an unmigrated org. The next
        # start REFUSED, naming a slug that no longer existed, and following
        # the wall's own `ORGTREE_MIGRATE=1` remedy rebuilt the database from
        # that stale file — the deleted org back, with its history. That is
        # Finding 9 again, reached through the failure path instead of the
        # intended one. (phase1-audit, 2026-09-04.)
        #
        # Dropping the suppression alone would not fix it: the destructive
        # half has already happened by then. THE ORDER IS THE FIX. While the
        # database is still in `orgs/`, a bare `<slug>.json` beside it is
        # INERT — `_ensure_migrated` short-circuits on the `.db`, and
        # `pending_migrations` requires a `.json` with NO `.db` — so the
        # dangerous window only opens once the database leaves. Move the
        # artefacts that can block a boot while that window is still shut and
        # a locked file costs a failed delete instead of an unbootable root.
        #
        # Either the whole org moves, or the org is left whole.
        moved: list[tuple[str, str]] = []

        def _put_back() -> None:
            for src, dst in reversed(moved):
                with contextlib.suppress(OSError):
                    os.replace(dst, src)

        def _remove_reply_snapshots() -> None:
            from . import reply_events
            try:
                reply_events.clear_org(slug)
            except Exception:
                _rename_retry(dest, p)
                _put_back()
                raise

        try:
            for src, suffix in extras:
                if os.path.exists(src):
                    # a shorter budget than the database gets, deliberately:
                    # DOC_LOCK is held throughout, the holder of a `.json` is
                    # by definition NOT this process (nothing here opens one
                    # under SQLite), and the point is to fail EARLY and
                    # cleanly — a delete that refuses is safe to retry from
                    # the UI, a delete that wedges the lock for half a minute
                    # is not.
                    _rename_retry(src, stem + suffix, tries=20)
                    moved.append((src, stem + suffix))
        except OSError:
            _put_back()
            raise
        if not row_store():
            try:
                _rename_retry(p, dest)
            except OSError:
                _put_back()
                raise
            _remove_reply_snapshots()
            _invalidate_snapshot(slug)
            _bump_org_seq(slug)
            return
        with _POOL.acquire(slug) as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        _POOL.close_all(slug)
        # a reader outside DOC_LOCK (№22) may still hold a connection for a
        # few milliseconds; on Windows the rename fails until it lets go
        try:
            _rename_retry(p, dest, on_retry=lambda: _POOL.close_all(slug))
        except OSError:
            _put_back()        # the extras go home; the org is left whole
            raise
        # The sidecars are the one thing still moved best-effort, and that is
        # a decision rather than an oversight. `wal_checkpoint(TRUNCATE)` and
        # `close_all` above left them EMPTY, so they carry no committed
        # frame; and unlike a `.json` a stray `-wal`/`-shm` cannot make an org
        # pending, cannot be resurrected by the migration wall, and is
        # rejected by SQLite as invalid if a later database of the same name
        # ever meets it. Nothing here can lose data, so nothing here should
        # abort a delete that has otherwise done its job.
        for side, dside in zip(_sidecars(p), _sidecars(dest)):
            if os.path.exists(side):
                with contextlib.suppress(OSError):
                    os.replace(side, dside)
        _remove_reply_snapshots()
        # deletion is a change too: derived caches validated by the seq
        # (reply identity, tree ETag, loop snapshots) must not survive it —
        # and the section-granular snapshot must not either
        _invalidate_snapshot(slug)
        _bump_org_seq(slug)
