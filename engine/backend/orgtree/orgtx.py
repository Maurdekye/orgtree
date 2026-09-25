# pyright: strict
"""PG-0: row transactions for org state — `org_tx`, `org_tx_call`, `org_read`.

THE PROBLEM. Every org write takes `store.DOC_LOCK`, one process-wide lock,
around load → change → save. PYPG (PYPG-PLAN.md §2-§3) replaces it family by
family with a short transaction that locks ONLY the rows the operation reads
for decision or writes.

THE INTERFACE (stable; this is what the PG-3x family packages code against):

    with orgtx.org_tx(slug, nodes=[nid], sections=["killswitch"],
                      share_sections=["settings"], logs=["events"],
                      op_key=key, fingerprint=fp) as tx:
        if tx.replayed:                 # a receipt for op_key already exists
            return tx.result
        org = tx.org                    # a ledger.Org; tx.d is org.d
        ... change the named rows ...
        tx.result = {...}               # JSON-able; stored in the receipt
    tx.revision                         # the org revision this commit made

  * `nodes` / `sections` — node ids and top-level doc sections locked
    FOR UPDATE. Only these may be written.
  * `share_nodes` / `share_sections` — locked FOR SHARE: read for a decision,
    never written. Conflicts with a FOR UPDATE of the same row, not with
    other sharers (the killswitch latch vs admissions case).
  * `logs` — the append-only log sections (store.LAZY_SECTIONS) this
    transaction may change: a bare section name, or `(section, owner)` for a
    dict log. Appends take no row lock. Editing an existing log row is
    allowed in a named log; PG-0's PostgreSQL backend locks the named
    `(section, owner)` rows FOR UPDATE for that.
  * Every other row is READABLE through `tx.d`, unlocked. It is not a
    decision input you are protected on: if your decision depends on it,
    name it (share or update).
  * A write to any row not locked FOR UPDATE (or to a log not named) raises
    `UnlockedWrite` at commit and NOTHING is written.
  * Locks are taken in one fixed order (sections, then nodes, then logs;
    each sorted), all before the body runs.
  * An exception in the body rolls everything back.
  * `op_key` (+ `fingerprint`): the receipt is written in the same commit.
    A later `org_tx` with the same key finds it: `tx.replayed` is True,
    `tx.result` holds the stored result, and the body's changes are
    DISCARDED (never written twice). Same key with a different fingerprint
    raises `ReceiptConflict`. This is RT6's mechanism (retry after a lost
    commit).
  * `tx.revision` is the per-org revision after the commit; every commit
    that wrote something bumps it by exactly one. `commit_listeners` receive
    a `Committed` record in-process after every commit (PG-4's Q2).
  * Retries: `org_tx` retries a serialization failure (40001) or deadlock
    (40P01) raised while TAKING THE LOCKS, before the body runs. One raised
    after the body has run surfaces as `Retryable`; `org_tx_call(slug, fn,
    ...)` re-runs the whole body for you, so prefer it when the body is
    pure (no side effects outside the transaction).
  * Nesting: an `org_tx` on the same org inside another on the same thread
    raises `NestedTx` (it would wait on its own locks).
  * DOC_LOCK: `org_tx` never takes or waits on DOC_LOCK. Unconverted code may
    hold DOC_LOCK and then call `org_tx`; the reverse order is forbidden.
  * Reads: `org_read(slug, sections=[...])` returns an Org whose named lazy
    sections were captured coherently (REPEATABLE READ on PostgreSQL). It
    holds no lock and nothing written to it is ever saved.

TEST HOOKS (PG-5): `set_pause_hook(fn)` installs `fn(point, tx)` called at
`before_lock`, `after_lock` and `before_commit`. Refused unless
`ORGTREE_ORGTX_TEST_HOOKS=1` is in the environment.

BACKENDS. `SeamBackend` (the default until `ORGTREE_STORE=postgres` lands) is
the FAKE: in-process row locks (`RowLocks`, with deadlock detection and a
lock timeout) over the existing SQLite seam — a fresh private load, then one
`save_org`, whose compare-on-save writes only the changed rows. Its limits:
  * the locks are per PROCESS (enough for threads in tests; not for two
    engines on one root);
  * receipts are kept in memory, not durably;
  * the JSON backend is refused (it has no change set to check);
  * unconverted DOC_LOCK code takes no row locks, so it can still overwrite
    a row an org_tx wrote (the same limit the PostgreSQL backend closes with
    a per-row version check on the legacy `save_org` path).
The PostgreSQL backend (`pgstore.py`) implements the same contract with
`SELECT … FOR UPDATE / FOR SHARE`, `UPDATE orgs SET revision = revision + 1`
and `NOTIFY org_rev, '<slug>:<revision>'` in the same transaction.
"""

from __future__ import annotations

import contextlib
import os
import random
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar, cast

from . import store
from .ledger import Org
from .stateprobe import SaveChanges

T = TypeVar("T")

#: A log name: a list/dict log section, or (dict-log section, owner).
LogName = str | tuple[str, str]

PAUSE_POINTS: tuple[str, ...] = ("before_lock", "after_lock", "before_commit")

DEFAULT_LOCK_TIMEOUT_S = float(os.environ.get("ORGTREE_ORGTX_LOCK_TIMEOUT_S", "10") or 10)
DEFAULT_RETRIES = 5


# ----------------------------------------------------------------- errors

class OrgTxError(RuntimeError):
    """Base of every org_tx failure. Nothing was committed."""


class UnlockedWrite(OrgTxError):
    """The body changed a row it did not lock FOR UPDATE (or a log it did
    not name). The whole transaction was rolled back."""


class NestedTx(OrgTxError):
    """org_tx on an org this thread already has an open org_tx on."""


class ReceiptConflict(OrgTxError):
    """The op_key already has a receipt with a different fingerprint."""


class LockTimeout(OrgTxError):
    """A row lock was not granted within the lock timeout."""


class Retryable(OrgTxError):
    """Serialization failure or deadlock; the transaction was rolled back and
    may be re-run from the start (`org_tx_call` does this)."""


class SerializationFailure(Retryable):
    """SQLSTATE 40001."""


class DeadlockDetected(Retryable):
    """SQLSTATE 40P01."""


# ----------------------------------------------------------------- records

@dataclass(frozen=True)
class Committed:
    """One committed org_tx, as published to `commit_listeners`."""
    slug: str
    revision: int
    changes: SaveChanges
    op_key: str | None


@dataclass
class OrgTx:
    """The handle a transaction body works through."""
    slug: str
    org: Org
    replayed: bool = False
    result: Any = None
    revision: int | None = None
    lock_nodes: frozenset[str] = frozenset()
    lock_sections: frozenset[str] = frozenset()
    share_nodes: frozenset[str] = frozenset()
    share_sections: frozenset[str] = frozenset()
    logs: frozenset[LogName] = frozenset()
    op_key: str | None = None
    fingerprint: str | None = None
    committed: Committed | None = field(default=None)

    @property
    def d(self) -> dict[str, Any]:
        return cast("dict[str, Any]", self.org.d)

    def append(self, sect: str, row: Any) -> None:
        """Append one row to a named list log (the cheap INSERT path)."""
        store.log_append(self.d, sect, row)


commit_listeners: list[Callable[[Committed], None]] = []


# ----------------------------------------------------------------- test hooks

_pause_hook: Callable[[str, OrgTx], None] | None = None


def set_pause_hook(fn: Callable[[str, OrgTx], None] | None) -> None:
    """Install (or clear, with None) the test-only pause hook."""
    global _pause_hook
    if fn is not None and os.environ.get("ORGTREE_ORGTX_TEST_HOOKS", "") != "1":
        raise RuntimeError("org_tx pause hooks need ORGTREE_ORGTX_TEST_HOOKS=1")
    _pause_hook = fn


def _pause(point: str, tx: OrgTx) -> None:
    h = _pause_hook
    if h is not None:
        h(point, tx)


# ----------------------------------------------------------------- row locks

RowKey = tuple[str, str, str]           # (slug, kind, name)


class RowLocks:
    """In-process shared/exclusive row locks with deadlock detection.

    One owner token per transaction. A request that would complete a cycle
    in the wait-for graph raises `DeadlockDetected` in the requester (the
    victim), like PostgreSQL's detector; a wait past the timeout raises
    `LockTimeout`. A shared holder may upgrade to exclusive."""

    def __init__(self) -> None:
        self._cv = threading.Condition(threading.Lock())
        self._x: dict[RowKey, object] = {}
        self._s: dict[RowKey, set[object]] = {}
        self._held: dict[object, set[RowKey]] = {}
        self._waits: dict[object, set[object]] = {}

    def _blockers(self, owner: object, key: RowKey, exclusive: bool) -> set[object]:
        out: set[object] = set()
        x = self._x.get(key)
        if x is not None and x is not owner:
            out.add(x)
        if exclusive:
            out |= {o for o in self._s.get(key, set()) if o is not owner}
        return out

    def _cycle(self, start: object) -> bool:
        seen: set[int] = set()
        stack = list(self._waits.get(start, ()))
        while stack:
            o = stack.pop()
            if o is start:
                return True
            if id(o) in seen:
                continue
            seen.add(id(o))
            stack.extend(self._waits.get(o, ()))
        return False

    def acquire(self, owner: object, key: RowKey, exclusive: bool,
                timeout: float) -> None:
        deadline = time.monotonic() + timeout
        with self._cv:
            while True:
                blockers = self._blockers(owner, key, exclusive)
                if not blockers:
                    self._waits.pop(owner, None)
                    if exclusive:
                        self._x[key] = owner
                    elif self._x.get(key) is not owner:
                        self._s.setdefault(key, set()).add(owner)
                    self._held.setdefault(owner, set()).add(key)
                    return
                self._waits[owner] = blockers
                if self._cycle(owner):
                    self._waits.pop(owner, None)
                    raise DeadlockDetected(f"deadlock on {key!r}")
                left = deadline - time.monotonic()
                if left <= 0:
                    self._waits.pop(owner, None)
                    raise LockTimeout(f"lock on {key!r} not granted in {timeout}s")
                self._cv.wait(left)

    def release_all(self, owner: object) -> None:
        with self._cv:
            for key in self._held.pop(owner, set()):
                if self._x.get(key) is owner:
                    del self._x[key]
                s = self._s.get(key)
                if s is not None:
                    s.discard(owner)
                    if not s:
                        del self._s[key]
            self._waits.pop(owner, None)
            self._cv.notify_all()

    def holders(self, key: RowKey) -> tuple[object | None, frozenset[object]]:
        """(exclusive holder, shared holders) — for tests."""
        with self._cv:
            return self._x.get(key), frozenset(self._s.get(key, set()))


# ----------------------------------------------------------------- backends

class Backend(Protocol):
    def transaction(self, tx: OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]: ...
    def read(self, slug: str, sections: tuple[str, ...]) -> Org: ...


def _allowed(tx: OrgTx, changes: SaveChanges) -> list[str]:
    """Rows the save wrote that the transaction did not lock for update."""
    bad: list[str] = []
    for k in (*changes.doc_upserts, *changes.doc_deletes):
        if k not in tx.lock_sections:
            bad.append(f"section {k!r}")
    for n in (*changes.node_updates, *changes.node_inserts, *changes.node_deletes):
        if n not in tx.lock_nodes:
            bad.append(f"node {n!r}")
    named_logs = {x if isinstance(x, str) else x[0] for x in tx.logs}
    for s in changes.log_sections:
        if s not in named_logs:
            bad.append(f"log {s!r}")
    return bad


class SeamBackend:
    """The fake: in-process row locks over the existing SQLite seam."""

    def __init__(self) -> None:
        self.locks = RowLocks()
        self.receipts: dict[tuple[str, str], tuple[str | None, Any]] = {}
        self._rev_lock = threading.Lock()
        self.revisions: dict[str, int] = {}

    def revision(self, slug: str) -> int:
        with self._rev_lock:
            return self.revisions.get(slug, 0)

    @contextlib.contextmanager
    def transaction(self, tx: OrgTx, lock_timeout: float) -> Iterator[None]:
        if store.STORE_BACKEND != "sqlite":
            raise OrgTxError(f"org_tx needs ORGTREE_STORE=sqlite or postgres, "
                             f"not {store.STORE_BACKEND!r}")
        owner = object()
        try:
            _pause("before_lock", tx)
            # one fixed order over every key: sections, nodes, logs; sorted
            order: list[tuple[RowKey, bool]] = []
            for name in sorted(tx.lock_sections | tx.share_sections):
                order.append(((tx.slug, "section", name), name in tx.lock_sections))
            for name in sorted(tx.lock_nodes | tx.share_nodes):
                order.append(((tx.slug, "node", name), name in tx.lock_nodes))
            for lg in sorted(tx.logs, key=lambda x: x if isinstance(x, str) else "\0".join(x)):
                if not isinstance(lg, str):
                    order.append(((tx.slug, "log", "\0".join(lg)), True))
            for key, exclusive in order:
                self.locks.acquire(owner, key, exclusive, lock_timeout)
            _pause("after_lock", tx)
            if tx.op_key is not None:
                hit = self.receipts.get((tx.slug, tx.op_key))
                if hit is not None:
                    if hit[0] != tx.fingerprint:
                        raise ReceiptConflict(
                            f"op_key {tx.op_key!r} was used with another fingerprint")
                    tx.replayed = True
                    tx.result = hit[1]
            tx.org = store._load_sqlite_org(tx.slug)   # pyright: ignore[reportPrivateUsage]
            yield
            if tx.replayed:
                tx.revision = self.revision(tx.slug)
                return
            _pause("before_commit", tx)
            got: list[SaveChanges] = []

            def guard(changes: SaveChanges) -> None:
                bad = _allowed(tx, changes)
                if bad:
                    raise UnlockedWrite(
                        f"org_tx on {tx.slug!r} wrote rows it did not lock: "
                        f"{', '.join(bad)} (name them in nodes=/sections=/logs=; "
                        "a save that touches asks or work_items also rewrites "
                        "work_items)")

            def on_commit(changes: SaveChanges) -> None:
                got.append(changes)
                if not changes.is_empty() or tx.op_key is not None:
                    with self._rev_lock:
                        self.revisions[tx.slug] = self.revisions.get(tx.slug, 0) + 1
                if tx.op_key is not None:
                    self.receipts[(tx.slug, tx.op_key)] = (tx.fingerprint, tx.result)

            loc = store._orgtx_local                   # pyright: ignore[reportPrivateUsage]
            loc.guard, loc.on_commit = guard, on_commit
            try:
                store.save_org(tx.org)
            finally:
                loc.guard = loc.on_commit = None
            changes = got[0] if got else SaveChanges()
            tx.revision = self.revision(tx.slug)
            tx.committed = Committed(tx.slug, tx.revision, changes, tx.op_key)
        finally:
            self.locks.release_all(owner)

    def read(self, slug: str, sections: tuple[str, ...]) -> Org:
        return store.load_org_snapshot(slug, sections)


_backend: Backend | None = None
_backend_lock = threading.Lock()


def backend() -> Backend:
    global _backend
    with _backend_lock:
        if _backend is None:
            _backend = SeamBackend()
        return _backend


def use_backend(b: Backend | None) -> Backend | None:
    """Replace the backend (tests; pgstore at boot). Returns the old one."""
    global _backend
    with _backend_lock:
        old, _backend = _backend, b
        return old


# ----------------------------------------------------------------- the API

_open = threading.local()


def _names(x: Iterable[str] | None, what: str) -> frozenset[str]:
    if x is None:
        return frozenset()
    if isinstance(x, str):
        raise TypeError(f"{what} must be a list of names, not a string")
    return frozenset(x)


def _check_sections(names: frozenset[str], what: str) -> None:
    bad = sorted(n for n in names if n == "nodes" or n in store.LAZY_SECTIONS)
    if bad:
        raise ValueError(f"{what}: {bad!r} are not doc sections "
                         "(use nodes= for nodes and logs= for log sections)")


def _check_logs(logs: Iterable[LogName] | None) -> frozenset[LogName]:
    if logs is None:
        return frozenset()
    if isinstance(logs, str):
        raise TypeError("logs must be a list, not a string")
    out: set[LogName] = set()
    for lg in logs:
        sect = lg if isinstance(lg, str) else lg[0]
        if sect not in store.LAZY_SECTIONS:
            raise ValueError(f"logs: {sect!r} is not a log section")
        if not isinstance(lg, str):
            if sect not in store.DICT_LOGS or len(lg) != 2:
                raise ValueError(f"logs: {lg!r} must be (dict-log section, owner)")
            lg = (lg[0], lg[1])
        out.add(lg)
    return frozenset(out)


@contextlib.contextmanager
def org_tx(slug: str, *, nodes: Iterable[str] | None = None,
           sections: Iterable[str] | None = None,
           logs: Iterable[LogName] | None = None,
           share_nodes: Iterable[str] | None = None,
           share_sections: Iterable[str] | None = None,
           op_key: str | None = None, fingerprint: str | None = None,
           lock_timeout: float | None = None,
           retries: int = DEFAULT_RETRIES) -> Iterator[OrgTx]:
    """One row transaction on one org. See the module docstring."""
    lock_nodes = _names(nodes, "nodes")
    lock_sections = _names(sections, "sections")
    sh_nodes = _names(share_nodes, "share_nodes") - lock_nodes
    sh_sections = _names(share_sections, "share_sections") - lock_sections
    _check_sections(lock_sections | sh_sections, "sections")
    log_names = _check_logs(logs)
    if fingerprint is not None and op_key is None:
        raise ValueError("fingerprint without op_key")
    open_slugs: set[str] = getattr(_open, "slugs", None) or set()
    if slug in open_slugs:
        raise NestedTx(f"org_tx on {slug!r} is already open on this thread")
    timeout = DEFAULT_LOCK_TIMEOUT_S if lock_timeout is None else lock_timeout
    b = backend()
    attempt = 0
    while True:
        tx = OrgTx(slug=slug, org=cast(Org, None), lock_nodes=lock_nodes,
                   lock_sections=lock_sections, share_nodes=sh_nodes,
                   share_sections=sh_sections, logs=log_names,
                   op_key=op_key, fingerprint=fingerprint)
        body_ran = False
        open_slugs.add(slug)
        _open.slugs = open_slugs
        try:
            with b.transaction(tx, timeout):
                body_ran = True
                yield tx
        except Retryable:
            if body_ran or attempt >= retries:
                raise
            attempt += 1
            time.sleep(random.uniform(0, 0.01 * (2 ** attempt)))
            continue
        finally:
            open_slugs.discard(slug)
        break
    if tx.committed is not None:
        for fn in list(commit_listeners):
            try:
                fn(tx.committed)
            except Exception:                                   # noqa: BLE001
                pass


def org_tx_call(slug: str, fn: Callable[[OrgTx], T], *,
                retries: int = DEFAULT_RETRIES, **names: Any) -> T:
    """Run `fn(tx)` in an org_tx, re-running the WHOLE body on a retryable
    failure. On a replayed op_key, returns the stored result without
    calling fn. Keyword arguments are org_tx's."""
    attempt = 0
    while True:
        try:
            with org_tx(slug, retries=retries, **names) as tx:
                if tx.replayed:
                    return cast(T, tx.result)
                out = fn(tx)
                if tx.op_key is not None and tx.result is None:
                    tx.result = out
            return out
        except Retryable:
            if attempt >= retries:
                raise
            attempt += 1
            time.sleep(random.uniform(0, 0.01 * (2 ** attempt)))


def org_read(slug: str, *, sections: Iterable[str] = ()) -> Org:
    """A lock-free, read-only view; the named lazy sections are captured in
    one coherent read. Nothing written to the result is ever saved."""
    return backend().read(slug, tuple(_names(sections, "sections")))
