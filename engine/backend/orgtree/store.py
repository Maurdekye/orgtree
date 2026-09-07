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

from datetime import datetime, timezone
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
if STORE_BACKEND not in ("json", "sqlite"):
    raise ValueError(f"ORGTREE_STORE must be 'json' or 'sqlite', not {STORE_BACKEND!r}")

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
DOC_LOCK = threading.RLock()


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
# `accounts.json`, `extern-peers.json`, `journals/` and the process table.
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


def _assert_synced_data_root() -> None:
    """Refuse operations when os.environ['ORGTREE_DATA'] disagrees with DATA_ROOT.

    DATA_ROOT binds once at module import time. If ORGTREE_DATA is set in the
    environment after store was imported (common in tests or scripts with import-
    order inversions), the environment promises isolation while store writes to
    whatever root was bound at import (often the production root).

    If ORGTREE_DATA is unset or empty in the environment, this passes (the standard
    production case defaulting to ~/orgtree).
    """
    env = os.environ.get("ORGTREE_DATA")
    if env and env.strip():
        if os.path.normcase(os.path.realpath(env.strip())) != os.path.normcase(os.path.realpath(DATA_ROOT)):
            raise DataRootDesync(
                f"store.DATA_ROOT ({DATA_ROOT!r}) is desynchronized from "
                f"os.environ['ORGTREE_DATA'] ({env!r})! store was imported before "
                f"ORGTREE_DATA was set in the environment."
            )


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
    if not _slug_contained(slug, _orgs_dir()):
        raise LedgerError(f"invalid org slug: {slug!r}")
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
    return os.path.join(_orgs_dir(), _safe_slug(slug) + ".db")


def _premigration_path(slug: str) -> str:
    return _json_path(slug) + ".premigration"


def org_path(slug: str) -> str:
    """The org's document on disk under the ACTIVE backend — `<slug>.json` or
    `<slug>.db`. Putting a file at this path IS the restore (delete_org)."""
    return _db_path(slug) if STORE_BACKEND == "sqlite" else _json_path(slug)


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
DICT_LOGS: tuple[str, ...] = ("mail_log", "steered_log", "turn_error_log")
LIST_LOGS: tuple[str, ...] = ("events", "org_inbox", "notice_log",
                              "user_mail_log", "user_outbox",
                              # operation receipts (opreceipts.py): append-only
                              # and capped, and LAZY is the point — a call
                              # that carries no `op_key` never touches it, so
                              # it costs the hot path nothing (measured:
                              # untouched 2.5 ms, materialise+append 5.9 ms at
                              # 300 rows — evidence/receipt-cost.json)
                              "op_receipts")
LAZY_SECTIONS: frozenset[str] = frozenset(DICT_LOGS) | frozenset(LIST_LOGS)

_SCHEMA_VERSION = "1"

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
    `threading.local()`, is the shape."""
    target = path
    if not create:
        # as_uri() percent-encodes a data root containing a space, '#' or '%';
        # hand-built "file:" + path does not, and silently opens the wrong file
        target = pathlib.Path(os.path.abspath(path)).as_uri() + "?mode=rw"
    conn = sqlite3.connect(target, timeout=10.0, isolation_level=None,
                           check_same_thread=False, uri=not create)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("PRAGMA busy_timeout=10000")
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
        with self._lock:
            epoch = self._epoch.get(slug, 0)
            idle = self._idle.get(slug)
            conn = idle.pop() if idle else None
            self._busy[slug] = self._busy.get(slug, 0) + 1
        keep = False
        try:
            if conn is None:
                conn = _open_conn(_db_path(slug), create=create)
            yield conn
            # a transaction still open on check-in is a bug in the caller;
            # never pool it — roll back and drop the connection
            keep = not conn.in_transaction
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

    def _load_owner(self, owner: str) -> AppendLog:
        with _POOL.acquire(self._slug) as conn:
            rows = [(cast(int, seq), cast(str, val)) for seq, val in conn.execute(
                "SELECT seq, val FROM log_d WHERE sect=? AND owner=? ORDER BY seq",
                (self._sect, owner))]
        log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
        self._snaps[owner] = log._rows
        dict.__setitem__(self, owner, log)
        return log

    def __missing__(self, owner: str) -> Any:
        if owner in self._present and owner not in self._dropped:
            return self._load_owner(owner)
        raise KeyError(owner)

    def materialize_all(self) -> None:
        missing = [o for o in self._order
                   if o in self._present and not dict.__contains__(self, o)]
        if missing:
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
                finally:
                    conn.execute("COMMIT")
            for owner in missing:
                rows = grouped[owner]
                log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
                self._snaps[owner] = log._rows
                dict.__setitem__(self, owner, log)
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
        return default

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
        "_dropped": set,
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

    # -- materialisation --------------------------------------------------
    def __missing__(self, k: str) -> Any:
        if k in LAZY_SECTIONS and k in self._present and k not in self._dropped:
            v = _load_section(self._slug, k, self._snap_logs)
            dict.__setitem__(self, k, v)
            return v
        raise KeyError(k)

    def materialize_all(self) -> None:
        for k in LAZY_SECTIONS:
            if not dict.__contains__(self, k):
                with contextlib.suppress(KeyError):
                    self[k]
            if dict.__contains__(self, k):
                value = dict.__getitem__(self, k)
                if isinstance(value, SectionMap):
                    value.materialize_all()

    def _unmaterialized(self) -> set[str]:
        return {k for k in self._present
                if not dict.__contains__(self, k) and k not in self._dropped}

    # -- the overrides ----------------------------------------------------
    def __contains__(self, k: object) -> bool:
        return (dict.__contains__(self, k)
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
        self[k] = default
        return default

    def __setitem__(self, k: str, v: Any) -> None:
        self._dropped.discard(k)
        dict.__setitem__(self, k, v)

    def __delitem__(self, k: str) -> None:
        if k in self and not dict.__contains__(self, k):
            self[k]                         # materialise so the semantics match a dict
        dict.__delitem__(self, k)
        if k in LAZY_SECTIONS:
            self._dropped.add(k)

    def pop(self, k: str, *default: Any) -> Any:   # pyright: ignore[reportIncompatibleMethodOverride]
        if k in self:
            v = self[k]
            del self[k]
            return v
        if default:
            return default[0]
        raise KeyError(k)

    def popitem(self) -> tuple[str, Any]:
        self.materialize_all()
        k, v = dict.popitem(self)
        if k in LAZY_SECTIONS:
            self._dropped.add(k)
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
        dict.clear(self)

    def keys(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.keys(self)

    def items(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.items(self)

    def values(self):   # pyright: ignore[reportIncompatibleMethodOverride]
        self.materialize_all()
        return dict.values(self)

    def __iter__(self) -> Iterator[str]:
        self.materialize_all()
        return dict.__iter__(self)

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
            "SELECT owner, seq, val FROM log_d WHERE sect=? ORDER BY seq", (sect,)):
        snaps.setdefault(cast(str, owner), []).append(
            (cast(int, seq), cast(str, val)))
    out = SectionMap(slug, sect, owners)
    for owner in owners:
        rows = snaps[owner]
        log = AppendLog((json.loads(val) for _, val in rows), rows=rows)
        out._snaps[owner] = log._rows
        dict.__setitem__(out, owner, log)
    # This is the eager reconstruction path used by export/migration.  Drop
    # SectionMap's private JSON-encoder seed before returning a plain-looking
    # fully materialized mapping.
    out.materialize_all()
    return snaps, out


def _read_list_log(conn: sqlite3.Connection, sect: str
                   ) -> tuple[list[tuple[int, str]], AppendLog]:
    rows = [(cast(int, seq), cast(str, val)) for seq, val in conn.execute(
        "SELECT seq, val FROM log_l WHERE sect=? ORDER BY seq", (sect,))]
    return rows, AppendLog((json.loads(val) for _, val in rows), rows=rows)


def _load_section(slug: str, sect: str, snap_logs: dict[str, Any]) -> Any:
    """`LazyDoc.__missing__`: one lazy section from its rows, recording the
    row strings in the doc's snapshot for compare-on-save. A section stored as
    a `doc` blob (a value of the wrong shape — see `_write_lazy`) comes back
    from there instead."""
    with _POOL.acquire(slug) as conn:
        row = conn.execute("SELECT val FROM doc WHERE key=?", (sect,)).fetchone()
        if row is not None:
            snap_logs[sect] = cast(str, row[0])
            return json.loads(cast(str, row[0]))
        if sect in DICT_LOGS:
            # Owner names/order are cheap metadata. Row baselines remain
            # empty until SectionMap loads a particular owner.
            sm = SectionMap(
                slug, sect, _owners_of(conn, sect, include_orphans=False))
            snap_logs[sect] = sm._snaps
            return sm
        rows_l, al = _read_list_log(conn, sect)
        snap_logs[sect] = rows_l
        return al


def _load_lazy(conn: sqlite3.Connection, slug: str,
               preload: Iterable[str] = ()) -> LazyDoc:
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
    conn.execute("BEGIN")
    try:
        raw_order = _meta_get(conn, _META_KEY_ORDER)
        key_order: list[str] = cast("list[str]", json.loads(raw_order)) if raw_order else []
        schema_version = _meta_get(conn, "schema_version")
        doc_rows: dict[str, str] = {cast(str, k): cast(str, v) for k, v in
                                    conn.execute("SELECT key, val FROM doc")}
        node_rows = [(cast(str, i), cast(str, v)) for i, v in
                     conn.execute("SELECT id, val FROM nodes ORDER BY ord")]
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
            nodes: dict[str, Any] = {}
            for nid, v in node_rows:
                nodes[nid] = json.loads(v)
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
            out[k] = {o: list(cast("list[Any]", lst)) for o, lst in dict.items(sm)}
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
                    *, incremental: AppendLog | None = None
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
        _delete_log_seqs(conn, table, (seq for seq, _ in old if seq not in kept_ids))
        result: list[tuple[int, str]] = []
        for entry, val, seq in zip(cur, strs, ids):
            if seq is None:
                cursor = conn.execute(insert_sql, (*insert_prefix, _at_of(entry), val))
                result.append((cast(int, cursor.lastrowid), val))
            else:
                if old_by_id[seq] != val:
                    conn.execute(f"UPDATE {table} SET at=?, val=? WHERE seq=?",
                                 (_at_of(entry), val, seq))
                result.append((seq, val))
        return result

    # A plain list replacement, migration, reordering, or unprovable journal
    # falls back to an exact replacement of this bounded scope.
    if snap is not None and [val for _, val in old] == strs:
        return old
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
    if not isinstance(cur, SectionMap) or snap is None:
        # Plain-dict save/migration/full section replacement: exact whole
        # section reconciliation, as before.
        conn.execute("DELETE FROM log_d WHERE sect=?", (sect,))
        new_snap: dict[str, list[tuple[int, str]]] = {}
        for owner, value in cur.items():
            if not isinstance(value, list):
                raise LedgerError(
                    f"{sect}[{owner!r}] must be a list, not {type(value).__name__}")
            entries = cast("list[Any]", value)
            new_snap[owner] = _write_log_rows(
                conn, "log_d", "sect=? AND owner=?", (sect, owner),
                "INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)",
                (sect, owner), entries, None)
        _meta_set(conn, _META_OWNERS + sect, _dumps(list(cur.keys())))
        return new_snap

    new_snap = {owner: list(rows) for owner, rows in snap.items()
                if owner in cur._present}
    for owner in cur._dropped:
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
        if not isinstance(value, list):
            raise LedgerError(
                f"{sect}[{owner!r}] must be a list, not {type(value).__name__}")
        entries = cast("list[Any]", value)
        if owner in cur._replaced:
            baseline = None
        else:
            baseline = snap.get(owner)
        new_snap[owner] = _write_log_rows(
            conn, "log_d", "sect=? AND owner=?", (sect, owner),
            "INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)",
            (sect, owner), entries, baseline,
            incremental=value if isinstance(value, AppendLog)
            and owner not in cur._replaced else None)
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


def _write_doc(conn: sqlite3.Connection, d: dict[str, Any], lazy: LazyDoc | None
               ) -> tuple[dict[str, str], dict[str, str], dict[str, Any], list[str]]:
    """The body of a save transaction (§4.5), for both shapes of `Org.d`:

      lazy is a LazyDoc  compare-on-save against its snapshots; unmaterialised
                         sections are not touched at all
      lazy is None       `d` is a plain dict (Org.create, a test fixture, a
                         `json.loads` copy): reconcile everything against what
                         is in the database — every key upserted, every node
                         written, every log section rewritten, and whatever
                         the database holds that `d` does not is deleted

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
    for k, v in items:
        if k in ROWED or k in LAZY_SECTIONS:
            continue
        s = _dumps(v)
        new_doc[k] = s
        if snap_doc is None or snap_doc.get(k) != s:
            conn.execute(_UPSERT_DOC, (k, s))
    known_doc = set(snap_doc) if snap_doc is not None else db_doc_keys
    for k in known_doc - set(new_doc) - LAZY_SECTIONS - set(ROWED):
        conn.execute("DELETE FROM doc WHERE key=?", (k,))

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
        for nid, nv in nodes.items():
            s = _dumps(nv)
            new_nodes[nid] = s
            if nid in known_ids:
                if snap_nodes is None or db_ids is not None or snap_nodes.get(nid) != s:
                    conn.execute("UPDATE nodes SET val=? WHERE id=?", (s, nid))
            else:
                conn.execute("INSERT INTO nodes(id, ord, val) VALUES(?,?,?)",
                             (nid, next_ord, s))
                next_ord += 1
        for nid in known_ids - set(new_nodes):
            conn.execute("DELETE FROM nodes WHERE id=?", (nid,))
        if not has_nodes_key:
            new_nodes = {}

    # -- lazy sections ---------------------------------------------------
    if lazy is not None:
        for sect in LAZY_SECTIONS:
            if dict.__contains__(d, sect):
                new_logs[sect] = _write_lazy(conn, sect, dict.__getitem__(d, sect),
                                             lazy._snap_logs.get(sect), snap_doc, new_doc)
            elif sect in lazy._dropped:
                _drop_lazy_rows(conn, sect)
                if snap_doc is not None and sect in snap_doc:
                    conn.execute("DELETE FROM doc WHERE key=?", (sect,))
    else:
        for sect in LAZY_SECTIONS:
            if sect in d:
                new_logs[sect] = _write_lazy(conn, sect, d[sect], None, None, new_doc)
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


def _save_sqlite(org: Org) -> None:
    slug = _safe_slug(org.d["slug"])
    d = cast("dict[str, Any]", org.d)
    lazy = d if isinstance(d, LazyDoc) and d._slug == slug else None
    _ensure_migrated(slug)
    # the one write path that may legitimately mint a database (`create_org`)
    with _POOL.acquire(slug, create=True) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            new_doc, new_nodes, new_logs, order = _write_doc(conn, d, lazy)
            conn.execute("COMMIT")
        except BaseException:
            with contextlib.suppress(Exception):
                conn.execute("ROLLBACK")
            raise
    if lazy is not None:
        # the database now IS this document: adopt the new snapshot so a
        # second save of the same object compares against the right thing
        unmat = lazy._unmaterialized()
        for k in unmat:
            if k in lazy._snap_logs:
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
                          if dict.__contains__(d, k) and k not in new_doc} | unmat)
        lazy._dropped = set()
        for k in LAZY_SECTIONS:
            v = dict.get(d, k)
            if isinstance(v, AppendLog):
                v.full_rewrite = False
            elif isinstance(v, SectionMap):
                for owner in v._order:
                    if dict.__contains__(v, owner):
                        lst = dict.__getitem__(v, owner)
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
            for owner, lst in cast("dict[str, list[Any]]", src).items():
                for i, e in enumerate(lst):
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
            src_e = cast("dict[str, list[Any]]", original[sect])[owner][i]
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
    if STORE_BACKEND == "sqlite":
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
            if not f.endswith(".db"):
                continue
            slug = f[:-3]
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

    if STORE_BACKEND == "sqlite":
        skip_slug = str((loaded or {}).get("slug") or "")
        if loaded is not None:
            take(skip_slug, loaded)
        for f in sorted(os.listdir(_orgs_dir())):
            if not f.endswith(".db"):
                continue
            slug = f[:-3]
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
        with _POOL.acquire(slug) as conn:
            doc = _load_lazy(conn, slug, preload)
        # Keep Org construction inside this error boundary. On an unmarked
        # document its mail-id backfill can read mail_log; snapshot loads add
        # that section to their bounded transaction in _load_lazy.
        return Org(cast("OrgDoc", doc))
    except sqlite3.OperationalError as e:
        if not os.path.exists(db):
            raise LedgerError(f"no such org: {slug!r}") from None
        raise LedgerError(f"cannot open org {slug!r}: {e}") from e


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
    if STORE_BACKEND == "sqlite":
        return _load_sqlite_org(slug, selected)
    return load_org(slug)


def load_org(slug: str) -> Org:
    if STORE_BACKEND == "sqlite":
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
        raw = _read_bytes(p)
    except FileNotFoundError:
        # deleted (or replaced) between the exists() check above and the
        # open — delete_org renames the doc out from under readers by design
        raise LedgerError(f"no such org: {slug!r}") from None
    return Org(json.loads(raw.decode("utf-8")))


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
    _assert_synced_data_root()
    global REVISION
    if STORE_BACKEND == "sqlite":
        _save_sqlite(org)
    else:
        _save_json(org)
    REVISION += 1  # pyright: ignore[reportConstantRedefinition]  # uppercase mutable counter is the public API; renaming is forbidden this wave
    # never let a fanout failure fail the write — the doc is already on disk
    try:
        on_save(org.d["slug"])
    except Exception:
        pass
    for h in list(save_hooks):
        try:
            h(org.d["slug"])
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
    ext = ".db" if STORE_BACKEND == "sqlite" else ".json"
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
        if STORE_BACKEND == "sqlite":
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
        if STORE_BACKEND != "sqlite":
            try:
                _rename_retry(p, dest)
            except OSError:
                _put_back()
                raise
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


# ---------------------------------------------------- external peer sightings
# D-166. `@mcp:` is a PULL transport: a peer is visible ONLY when it reaches
# in — a poll, a wait, or a send. Nothing else on this machine knows whether
# one is alive, which is why a response handle attached for a peer that later
# died used to sit in an agent's system prompt for good, with the prompt still
# telling the agent to answer there. This file IS that missing signal; it
# exists for no other purpose.
#
# MACHINE-GLOBAL, not per-org, for three reasons: peer identity is
# machine-level (`~/.orgtree/extern-id`), one peer talks to several orgs at
# once, and `_extern_scan` already sweeps every org for it. Per-org would also
# mean taking DOC_LOCK on every 25-second poll of every listener.
#
# This file holds EVIDENCE ONLY — one `last_seen` per peer, meaning "it
# reached in at this time". It deliberately does NOT hold when a handle was
# attached: that is a fact about a NODE, it lives on the node
# (`external_handles_at`), and keeping it here could not distinguish a handle
# that had sat unused for a week from one re-attached a second ago.
_PEERS_FILE = "extern-peers.json"
_peers_lock = threading.Lock()
# a peer nobody has bound a handle to and nobody has heard from in this long
# is just clutter; pruned on write so the file cannot grow without bound
_PEER_FORGET_S = 90 * 86400


def _peers_path(root: str | None = None) -> str:
    return os.path.join(root or DATA_ROOT, _PEERS_FILE)


def _peers_read() -> dict[str, dict[str, Any]]:
    """Never raises: a corrupt or absent file reads as 'no sightings', which
    fails SAFE — every clock restarts, so the worst case is a detach delayed
    by one TTL, never a live handle dropped early."""
    try:
        with open(_peers_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _peers_write(d: dict[str, dict[str, Any]]) -> None:
    _assert_synced_data_root()
    p = _peers_path()
    cut = time.time() - _PEER_FORGET_S
    keep = {k: v for k, v in d.items()
            if max(_epoch(v.get("last_seen")), _epoch(v.get("first_observed"))) > cut}
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p) or ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(keep, f, indent=1)
        os.replace(tmp, p)
        tmp = ""
    finally:
        if tmp:
            with contextlib.suppress(OSError):
                os.remove(tmp)


def _epoch(iso: Any) -> float:
    """`ledger.now()` ISO-8601 → epoch seconds. That format is ALWAYS UTC with
    a trailing Z, so it is parsed as UTC explicitly rather than through
    `strptime`'s naive-local default — which would shift every reading by the
    machine's offset and, east of UTC, make a fresh sighting look hours old.
    0.0 for anything unparseable: reads as 'infinitely long ago', which is
    safe for the forget-prune and is never on its own enough to detach."""
    if not isinstance(iso, str) or not iso:
        return 0.0
    try:
        return datetime.strptime(iso.replace("Z", ""), "%Y-%m-%dT%H:%M:%S.%f")             .replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, OverflowError):
        return 0.0


def extern_seen(addr: str) -> None:
    """The peer reached in. Called from every inbound extern route — send,
    read and wait alike, because all three prove the same thing."""
    with _peers_lock:
        d = _peers_read()
        rec = d.setdefault(addr, {})
        rec["last_seen"] = _now_iso()
        _peers_write(d)


def extern_last_seen(addr: str) -> str | None:
    """The peer's last real sighting, or None if it has never reached in."""
    return _peers_read().get(addr, {}).get("last_seen")


def _now_iso() -> str:
    """One timestamp shape across the whole system — reuse the ledger's, so a
    sighting and a mail entry can never disagree about what time it is."""
    return _ledger_now()
