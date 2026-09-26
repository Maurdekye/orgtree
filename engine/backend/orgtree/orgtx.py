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
    PG-3d: a split section (store.SPLIT_SECTIONS: `mail`, `delivering`,
    `notices`) may also be named per owner, `("mail", nid)`: that locks
    only nid's row of it (plus the section's container row, SHARED, so a
    whole-section lock still excludes it). A bare `"mail"` locks every
    owner's row.
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
  * Locks are taken in one fixed order, all before the body runs: a
    'node:*' pseudo-row (shared; exclusive for nodes=ALL), then NODES,
    then SECTIONS, then (dict-log, owner) rows, each sorted (`_lock_plan`).
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
  * `whole=True` (plan decision 23; reconcile and other sweep code): the
    ORG pseudo-row EXCLUSIVE. Every org_tx takes it shared first, so a
    whole transaction excludes every other org_tx on the org, list-log
    appends and new rows included. Its node and doc rows are then locked
    FOR UPDATE in bulk (one lock-table entry in all); `lock_nodes`,
    `lock_sections` and `logs` list what exists; the body may write
    anything, new nodes and sections included. Name nothing else beside
    it. It does not exclude an unconverted DOC_LOCK save: the transition
    fence does (fence off on PostgreSQL, the row compare-and-set refuses
    the loser). On the SQLite fake the in-process row locks are not FIFO,
    so under steady traffic with the fence off it can wait its lock
    timeout out.
  * Nesting: an `org_tx` on the same org inside another on the same thread
    raises `NestedTx` (it would wait on its own locks).
  * DOC_LOCK: `org_tx` never takes or waits on DOC_LOCK. Unconverted code may
    hold DOC_LOCK and then call `org_tx`; the reverse order is forbidden.
  * Reads: `org_read(slug, sections=[...])` returns an Org whose named lazy
    sections were captured coherently (REPEATABLE READ on PostgreSQL). It
    holds no lock and nothing written to it is ever saved.

TEST HOOKS (PG-5): `set_pause_hook(fn)` installs `fn(point, tx)` called at
`before_lock`, `after_lock`, `before_commit` and `after_commit` (raising at
`after_commit` models a connection lost after the commit). Refused unless
`ORGTREE_ORGTX_TEST_HOOKS=1` is in the environment.

BACKENDS. `SeamBackend` (the default until `ORGTREE_STORE=postgres` lands) is
the FAKE: in-process row locks (`RowLocks`, with deadlock detection and a
lock timeout) over the existing SQLite seam — a fresh private load, then one
`save_org`, whose compare-on-save writes only the changed rows. Its limits:
  * the locks are per PROCESS (enough for threads in tests; not for two
    engines on one root);
  * receipts are kept in memory, not durably;
  * on ORGTREE_STORE=json it hands over to `JsonBackend` (plan decision 39):
    DOC_LOCK plus a whole-document load and save, row declarations ignored,
    receipts BEST-EFFORT (in memory only), no change set;
  * unconverted DOC_LOCK code takes no row locks, so it can still overwrite
    a row an org_tx wrote (the same limit the PostgreSQL backend closes with
    a per-row version check on the legacy `save_org` path).
The PostgreSQL backend (`pgstore.py`) implements the same contract with
`SELECT … FOR UPDATE / FOR SHARE`, `UPDATE orgs SET revision = revision + 1`
and `NOTIFY org_rev, '<slug>:<revision>'` in the same transaction.
"""

from __future__ import annotations

import contextlib
import json
import os
import random
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar, cast

from . import profiling, store
from .ledger import Org
from .stateprobe import SaveChanges

T = TypeVar("T")

#: A log name: a list/dict log section, or (dict-log section, owner).
LogName = str | tuple[str, str]
#: PG-3d: a doc section, or (split section, owner) — see `sections` above
SectionName = str | tuple[str, str]
#: PG-3d: former doc sections that are now list logs, still accepted in
#: `sections=` / `share_sections=` so a declaration written before a move
#: keeps working; name them in `logs=`. S8 (decision 38): `lifecycle` (moved
#: by decision 29) is no longer here — every caller names it in `logs=`, and
#: `sections=["lifecycle"]` is now refused (ValueError) like any log section.
MOVED_TO_LOGS: frozenset[str] = frozenset()

#: `after_commit` runs once the COMMIT has succeeded: raising there is how a
#: test models a connection lost after the server committed (RT6).
PAUSE_POINTS: tuple[str, ...] = ("before_lock", "after_lock", "before_commit",
                                 "after_commit")

DEFAULT_LOCK_TIMEOUT_S = float(os.environ.get("ORGTREE_ORGTX_LOCK_TIMEOUT_S", "10") or 10)
DEFAULT_RETRIES = 5

#: THE TRANSITION FENCE (plan decision 19). While any writer is still on
#: DOC_LOCK, every org_tx (single or multi-org) takes store.DOC_LOCK BEFORE
#: any row lock and holds it until its commit or rollback, so an unconverted
#: load→change→save cycle can never interleave with a converted write of the
#: same row. DOC_LOCK is re-entrant, so code that already holds it may call
#: org_tx. Read at call time; turn it off (tests, or once the last DOC_LOCK
#: writer is converted) with `orgtx.TRANSITION_FENCE = False` or
#: ORGTREE_ORGTX_FENCE=0. store.StaleWrite stays as the backstop.
TRANSITION_FENCE: bool = os.environ.get("ORGTREE_ORGTX_FENCE", "1").strip() != "0"
#: PostgreSQL ends a transaction whose body sits idle (between statements)
#: longer than this while holding its row locks (review N5)
IDLE_IN_TX_TIMEOUT_S = float(os.environ.get("ORGTREE_ORGTX_IDLE_TIMEOUT_S", "120") or 120)


# ----------------------------------------------------------------- errors

class OrgTxError(RuntimeError):
    """Base of every org_tx failure. Nothing was committed."""


class UnlockedWrite(OrgTxError):
    """The body changed a row it did not lock FOR UPDATE (or a log it did
    not name). The whole transaction was rolled back; nothing was written.
    `rows` names them: (('node'|'section'|'log', name), ...)."""

    def __init__(self, msg: str, rows: tuple[tuple[str, str], ...] = ()) -> None:
        super().__init__(msg)
        self.rows = rows


class NestedTx(OrgTxError):
    """org_tx on an org this thread already has an open org_tx on."""


class ReceiptConflict(OrgTxError):
    """The op_key already has a receipt with a different fingerprint."""


class MixedReplay(OrgTxError):
    """An org_tx_multi call where some orgs' op_keys already applied and
    others did not. Replaying would silently drop the fresh orgs' writes
    (review finding f1), so the call is refused; split it or re-key it."""


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
    #: False on the JSON fallback: it rewrites the whole document and has no
    #: change set, so `changes` is empty and says nothing (full-reload)
    changes_known: bool = True


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
    #: nodes=ALL: every node row is locked FOR UPDATE (and new ones may be
    #: inserted); `lock_nodes` holds the ids resolved under the lock
    all_nodes: bool = False
    #: slugs whose save hooks store deferred; org_tx fires them after COMMIT
    #: with every lock released (lead decision 14)
    deferred_hooks: list[str] = field(default_factory=lambda: [])
    #: whole=True (plan decision 23): the org pseudo-row EXCLUSIVE, then
    #: every node and doc row that exists, and any write allowed.
    #: `lock_nodes` / `lock_sections` / `logs` hold what was listed under it
    whole: bool = False

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
    `LockTimeout`. A shared holder may upgrade to exclusive.

    WRITER PREFERENCE (S8, p01): once an exclusive request is waiting on a
    key, a NEW shared request for it (one whose owner does not already hold
    the key) waits behind it, as PostgreSQL's lock queue does. Without it a
    steady stream of overlapping shared takers — every org_tx takes the org
    pseudo-row shared — starves a waiting whole=True until its timeout."""

    def __init__(self) -> None:
        self._cv = threading.Condition(threading.Lock())
        self._x: dict[RowKey, object] = {}
        self._s: dict[RowKey, set[object]] = {}
        self._held: dict[object, set[RowKey]] = {}
        self._waits: dict[object, set[object]] = {}
        #: owners waiting for an EXCLUSIVE grant, per key (writer preference)
        self._xwait: dict[RowKey, set[object]] = {}

    def _blockers(self, owner: object, key: RowKey, exclusive: bool) -> set[object]:
        out: set[object] = set()
        x = self._x.get(key)
        if x is not None and x is not owner:
            out.add(x)
        if exclusive:
            out |= {o for o in self._s.get(key, set()) if o is not owner}
        elif x is not owner and owner not in self._s.get(key, set()):
            out |= {o for o in self._xwait.get(key, set()) if o is not owner}
        return out

    def _unqueue(self, owner: object, key: RowKey) -> None:
        w = self._xwait.get(key)
        if w is not None:
            w.discard(owner)
            if not w:
                del self._xwait[key]
            self._cv.notify_all()          # shared waiters queued behind it may go

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
                        self._unqueue(owner, key)
                    if exclusive:
                        self._x[key] = owner
                    elif self._x.get(key) is not owner:
                        self._s.setdefault(key, set()).add(owner)
                    self._held.setdefault(owner, set()).add(key)
                    return
                self._waits[owner] = blockers
                if self._cycle(owner):
                    self._waits.pop(owner, None)
                    if exclusive:
                        self._unqueue(owner, key)
                    raise DeadlockDetected(f"deadlock on {key!r}")
                left = deadline - time.monotonic()
                if left <= 0:
                    self._waits.pop(owner, None)
                    if exclusive:
                        self._unqueue(owner, key)
                    raise LockTimeout(f"lock on {key!r} not granted in {timeout}s")
                if exclusive:
                    self._xwait.setdefault(key, set()).add(owner)
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

    def waiting(self, owner: object) -> frozenset[object]:
        """The owners `owner` is currently blocked behind (empty when it is
        not waiting) — the public probe PG-5's race harness reads."""
        with self._cv:
            return frozenset(self._waits.get(owner, ()))


# ----------------------------------------------------------------- backends

class Backend(Protocol):
    def transaction(self, tx: OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]: ...
    def read(self, slug: str, sections: tuple[str, ...]) -> Org: ...


#: the pseudo-row every node lock takes first: shared for named nodes,
#: exclusive for nodes=ALL, so an ALL sweep excludes node creations by other
#: org_tx calls (a legacy seam save can still insert a node; review N8)
_ALL_NODES_KEY = "*"
#: S8 (p01 review): the ORG pseudo-row, taken FIRST by every org_tx — shared
#: by all, exclusive only by whole=True, which it therefore excludes from
#: the whole org (list-log appends and new rows included) with one lock.
#: It is never named in a TxSpec and no family's plan names it.
_ORG_KEY = "*"


def _lock_plan(tx: OrgTx, node_ids: Iterable[str] = ()) -> list[tuple[str, str, bool]]:
    """THE lock order, one for both backends and every family (agreed with
    PG-3a/PG-3b): the org pseudo-row, the node pseudo-row, then NODE rows in
    ascending id, then SECTIONS in ascending key, then (dict-log, owner)
    rows. Each entry is (kind, name, exclusive). `node_ids` are the
    resolved ids for ALL. A whole=True plan is the org pseudo-row alone."""
    plan: list[tuple[str, str, bool]] = [("org", _ORG_KEY, tx.whole)]
    if tx.whole:
        return plan
    nodes = sorted(set(node_ids) | tx.lock_nodes | tx.share_nodes) if not tx.all_nodes \
        else sorted(set(node_ids))
    if tx.all_nodes or nodes:
        plan.append(("node", _ALL_NODES_KEY, tx.all_nodes))
    for name in nodes:
        plan.append(("node", name, tx.all_nodes or name in tx.lock_nodes))
    for name in sorted(tx.lock_sections | tx.share_sections):
        plan.append(("section", name, name in tx.lock_sections))
    for lg in sorted((x for x in tx.logs if not isinstance(x, str)),
                     key=lambda x: "\0".join(x)):
        plan.append(("log", json.dumps([lg[0], lg[1]]), True))
    return plan


def _disallowed(tx: OrgTx, changes: SaveChanges) -> tuple[tuple[str, str], ...]:
    """Rows the save wrote that the transaction did not lock for update."""
    if tx.whole:
        return ()           # decision 23: a whole-org transaction may write anything
    bad: list[tuple[str, str]] = []
    # an always-present row (the killswitch) that did not exist when this tx
    # loaded is CREATED with its cleared value by the save itself — not a
    # write by the body; popping a row that existed still needs the lock
    loaded = getattr(tx.org.d, "_snap_doc", None) if tx.org is not None else None
    created = {k for k in store.ALWAYS_ROWS
               if loaded is not None and k not in loaded
               and dict.get(tx.d, k) == json.loads(store.ALWAYS_ROWS[k])}   # still cleared
    for k in (*changes.doc_upserts, *changes.doc_deletes):
        if k in changes.containers_created and k in tx.share_sections:
            continue        # PG-3d: an empty split container, under an owner lock
        if k in created:
            continue        # PG-0b: an always-present row the save created, still cleared
        if k not in tx.lock_sections \
                and store.split_section_of(k) not in tx.lock_sections:
            bad.append(("section", k))
    if not tx.all_nodes:
        for n in (*changes.node_updates, *changes.node_inserts, *changes.node_deletes):
            if n not in tx.lock_nodes:
                bad.append(("node", n))
    named_logs = {x if isinstance(x, str) else x[0] for x in tx.logs}
    for s in sorted(changes.log_sections):
        if s not in named_logs:
            bad.append(("log", s))
    return tuple(dict.fromkeys(bad))


def _whole_rows(tx: OrgTx, doc_keys: Iterable[str],
                log_owners: Iterable[tuple[str, str]]) -> None:
    """whole=True: take the org's existing doc rows and (dict-log, owner)
    rows, as listed under the exclusive node pseudo-row, into the lock set.
    `lock_sections` then holds real row names (split owner rows included)
    and `logs` every log section by name plus each owner row, so a helper
    that checks what an enclosing transaction holds sees them held."""
    tx.lock_sections = frozenset(
        k for k in doc_keys if k != "nodes" and k not in store.LAZY_SECTIONS)
    tx.logs = frozenset(store.LAZY_SECTIONS) | frozenset(
        (s, o) for s, o in log_owners if s in store.DICT_LOGS)


def _sqlite_rows(slug: str) -> tuple[list[str], list[tuple[str, str]]]:
    """The doc keys and (dict-log, owner) pairs of one org's SQLite file."""
    conn = store._open_conn(store._db_path(slug))   # pyright: ignore[reportPrivateUsage]
    try:
        keys = [str(k) for (k,) in conn.execute("SELECT key FROM doc").fetchall()]
        owners = [(str(s), str(o)) for s, o in conn.execute(
            "SELECT DISTINCT sect, owner FROM log_d").fetchall()]
    finally:
        conn.close()
    return keys, owners


def _check(tx: OrgTx, changes: SaveChanges) -> None:
    bad = _disallowed(tx, changes)
    if bad:
        raise UnlockedWrite(
            f"org_tx on {tx.slug!r} wrote rows it did not lock: "
            + ", ".join(f"{k} {n!r}" for k, n in bad)
            + " (name them in nodes=/sections=/logs=; a save that touches asks "
              "or work_items also rewrites work_items)", bad)


class _HealNeeded(Exception):
    """Internal: the load itself changed rows (a ledger load-heal). The
    attempt releases its locks, the heal is committed, and it re-runs."""

    def __init__(self, slug: str, rows: list[str]) -> None:
        super().__init__(f"{slug}: load-heal pending on {rows}")
        self.slug = slug
        self.rows = rows


MAX_HEALS = 3


def _heal_pending(tx: OrgTx) -> list[str]:
    """What constructing tx.org changed before the body ran: the ledger's
    load-heals (`_migrations` markers, node scope, legacy freeze retags,
    their event rows). Not once per process — a heal recurs whenever any
    writer leaves a pre-heal shape (pg-supervisor-b, 18:47Z)."""
    d = tx.org.d
    if not isinstance(d, store.LazyDoc):
        return []
    rows = store._resident_dirty(d)                # pyright: ignore[reportPrivateUsage]
    rows += [f"{k} (append)" for k, v in d._pending.items() if v]   # pyright: ignore[reportPrivateUsage]
    return rows


def _refuse_mixed_replay(order: list[OrgTx]) -> None:
    replayed = [t.slug for t in order if t.replayed]
    if replayed and len(replayed) != len(order):
        fresh = [t.slug for t in order if not t.replayed]
        raise MixedReplay(f"org_tx_multi: {replayed} already applied under their op_keys "
                          f"but {fresh} did not; refusing rather than dropping their writes")


def _check_heal(tx: OrgTx) -> None:
    rows = _heal_pending(tx)
    if rows:
        raise _HealNeeded(tx.slug, rows)


def _heal(slug: str) -> None:
    """Commit a load-heal in its own save, with NO row lock held, through
    store's internal save — not the public `store.save_org`, which tests patch
    for fault injection (pg-supervisor-a, 18:50Z). The compare-and-set guards
    it like any legacy save; under the transition fence DOC_LOCK is held."""
    store._save_org(store._load_sqlite_org(slug))   # pyright: ignore[reportPrivateUsage]


def _billed_save(org: Org, got: list[SaveChanges], receipt: bool) -> None:
    """`store.save_org` for a row transaction, timed as `org_save_ms` only
    when it WROTE something — changed rows, or a receipt row. A body that
    left the document as it found it still runs the compare-on-save, and
    billing that as a save would report a write that never happened (the
    write-route timing sink's contract; the JSON backend skips the save
    outright in that case). The unbilled compare stays inside the held time,
    so it is reported as mutation, which is what it is."""
    if profiling.current() is None:
        store.save_org(org)
        return
    started, cpu0 = time.perf_counter(), time.thread_time()
    try:
        with profiling.detached():
            store.save_org(org)
    finally:
        if receipt or any(not c.is_empty() for c in got):
            profiling.add("org_save_ms", (time.perf_counter() - started) * 1000.0)
            profiling.add(profiling.cpu_field("org_save_ms"),
                          (time.thread_time() - cpu0) * 1000.0)


class SeamBackend:
    """The fake: in-process row locks over the existing SQLite seam.

    ⚠ A MULTI-ORG transaction here is NOT atomic across orgs: each org is its
    own SQLite file, so the saves commit one after another (in slug order)
    and a failure in a later org leaves the earlier ones committed. Only the
    PostgreSQL backend commits several orgs as one transaction."""

    def __init__(self) -> None:
        self.locks = RowLocks()
        self.receipts: dict[tuple[str, str], tuple[str | None, Any]] = {}
        self._rev_lock = threading.Lock()
        self.revisions: dict[str, int] = {}

    def revision(self, slug: str) -> int:
        with self._rev_lock:
            return self.revisions.get(slug, 0)

    def transaction(self, tx: OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]:
        return self.transaction_many([tx], lock_timeout)

    @contextlib.contextmanager
    def transaction_many(self, txs: list[OrgTx], lock_timeout: float) -> Iterator[None]:
        if store.STORE_BACKEND == "json":
            with _json_fallback().transaction_many(txs, lock_timeout):
                yield
            return
        if store.STORE_BACKEND != "sqlite":
            raise OrgTxError(f"org_tx needs ORGTREE_STORE=sqlite, postgres or json, "
                             f"not {store.STORE_BACKEND!r}")
        order = sorted(txs, key=lambda t: t.slug)
        owner = object()
        try:
            for tx in order:
                _pause("before_lock", tx)
            for tx in order:
                ids: list[str] = []
                self.locks.acquire(owner, (tx.slug, "org", _ORG_KEY), tx.whole, lock_timeout)
                if tx.all_nodes:
                    if not tx.whole:
                        self.locks.acquire(owner, (tx.slug, "node", _ALL_NODES_KEY), True,
                                           lock_timeout)
                    probe = store._load_sqlite_org(tx.slug)   # pyright: ignore[reportPrivateUsage]
                    ids = list(dict.keys(cast("dict[str, Any]", probe.d.get("nodes") or {})))
                    tx.lock_nodes = frozenset(ids)
                    if tx.whole:
                        _whole_rows(tx, *_sqlite_rows(tx.slug))
                for kind, name, exclusive in _lock_plan(tx, ids):
                    if kind == "org":
                        continue                       # taken above
                    self.locks.acquire(owner, (tx.slug, kind, name), exclusive, lock_timeout)
            for tx in order:
                _pause("after_lock", tx)
            for tx in order:
                if tx.op_key is not None:
                    hit = self.receipts.get((tx.slug, tx.op_key))
                    if hit is not None:
                        if hit[0] != tx.fingerprint:
                            raise ReceiptConflict(
                                f"op_key {tx.op_key!r} was used with another fingerprint")
                        tx.replayed = True
                        tx.result = hit[1]
                # billed as the load, as `store.load_org` bills the legacy one
                # (the write-route timing sink's `org_load_ms`)
                with profiling.stage("org_load_ms"):
                    tx.org = store._load_sqlite_org(tx.slug)   # pyright: ignore[reportPrivateUsage]
                _check_heal(tx)
            _refuse_mixed_replay(order)
            yield
            if any(tx.replayed for tx in order):
                for tx in order:
                    tx.revision = self.revision(tx.slug)
                return
            for tx in order:
                _pause("before_commit", tx)
            loc = store._orgtx_local                   # pyright: ignore[reportPrivateUsage]
            for tx in order:
                got: list[SaveChanges] = []

                def on_commit(changes: SaveChanges, tx: OrgTx = tx,
                              got: list[SaveChanges] = got) -> None:
                    got.append(changes)
                    if not changes.is_empty() or tx.op_key is not None:
                        with self._rev_lock:
                            self.revisions[tx.slug] = self.revisions.get(tx.slug, 0) + 1
                    if tx.op_key is not None:
                        self.receipts[(tx.slug, tx.op_key)] = (tx.fingerprint, tx.result)

                loc.guard = (lambda c, tx=tx: _check(tx, c))
                loc.on_commit = on_commit
                loc.defer_hooks = tx.deferred_hooks
                try:
                    _billed_save(tx.org, got, tx.op_key is not None)
                finally:
                    loc.guard = loc.on_commit = loc.defer_hooks = None
                tx.revision = self.revision(tx.slug)
                tx.committed = Committed(tx.slug, tx.revision,
                                         got[0] if got else SaveChanges(), tx.op_key)
            for tx in order:
                _pause("after_commit", tx)
        finally:
            self.locks.release_all(owner)

    def read(self, slug: str, sections: tuple[str, ...]) -> Org:
        return store.load_org_snapshot(slug, sections)

    @contextlib.contextmanager
    def exclusive(self, slug: str, lock_timeout: float) -> Iterator[None]:
        """`org_exclusive` on the fake: the org pseudo-row EXCLUSIVE, alone.
        On the JSON store DOC_LOCK (always taken there) is the whole lock.
        (Defensive: in production JSON runs JsonBackend, which has no
        `exclusive`; this branch serves a test that installs the seam there.)"""
        if store.STORE_BACKEND == "json":
            yield
            return
        owner = object()
        try:
            self.locks.acquire(owner, (slug, "org", _ORG_KEY), True, lock_timeout)
            yield
        finally:
            self.locks.release_all(owner)


class JsonBackend:
    """The JSON-store fallback (plan decision 39): the legacy cycle behind the
    org_tx interface, so a converted route still works on ORGTREE_STORE=json.

    `_run` holds store.DOC_LOCK for the whole transaction on this backend
    (fence or no fence); each org is loaded whole, the body runs, and each is
    saved whole. Row declarations are IGNORED — nothing is row-locked and no
    UnlockedWrite is raised. Its limits:
      * receipts are BEST-EFFORT: kept in this process's memory, so a replay
        is recognised only until the engine restarts;
      * `Committed.changes` is empty and `changes_known` is False (the store
        publishes the save as unknown; readers full-reload) — except that a
        body which changed nothing saves nothing and publishes no change;
      * a multi-org transaction saves the orgs one after another (slug order),
        not atomically."""

    def __init__(self) -> None:
        self.receipts: dict[tuple[str, str], tuple[str | None, Any]] = {}
        self.revisions: dict[str, int] = {}

    def revision(self, slug: str) -> int:
        return self.revisions.get(slug, 0)

    def transaction(self, tx: OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]:
        return self.transaction_many([tx], lock_timeout)

    @contextlib.contextmanager
    def transaction_many(self, txs: list[OrgTx], lock_timeout: float) -> Iterator[None]:
        order = sorted(txs, key=lambda t: t.slug)
        with store.DOC_LOCK:                       # held by _run already: re-entrant
            for tx in order:
                _pause("before_lock", tx)
            for tx in order:
                _pause("after_lock", tx)
            for tx in order:
                if tx.op_key is not None:
                    hit = self.receipts.get((tx.slug, tx.op_key))
                    if hit is not None:
                        if hit[0] != tx.fingerprint:
                            raise ReceiptConflict(
                                f"op_key {tx.op_key!r} was used with another fingerprint")
                        tx.replayed = True
                        tx.result = hit[1]
                tx.org = store.load_org(tx.slug)
            _refuse_mixed_replay(order)
            before = {tx.slug: _json_image(tx.org) for tx in order}
            yield
            if any(tx.replayed for tx in order):
                for tx in order:
                    tx.revision = self.revision(tx.slug)
                return
            for tx in order:
                _pause("before_commit", tx)
            loc = store._orgtx_local                   # pyright: ignore[reportPrivateUsage]
            for tx in order:
                # a body that left the document as it found it writes nothing,
                # as the legacy cycle did and as the row store does: no file
                # rewrite, no publish, and (as SeamBackend) no revision bump
                # unless a receipt is being recorded
                unchanged = before[tx.slug] is not None and _json_image(tx.org) == before[tx.slug]
                if not unchanged:
                    loc.defer_hooks = tx.deferred_hooks
                    try:
                        store.save_org(tx.org)
                    finally:
                        loc.defer_hooks = None
                if not unchanged or tx.op_key is not None:
                    self.revisions[tx.slug] = self.revision(tx.slug) + 1
                if tx.op_key is not None:
                    self.receipts[(tx.slug, tx.op_key)] = (tx.fingerprint, tx.result)
                tx.revision = self.revision(tx.slug)
                tx.committed = Committed(tx.slug, tx.revision, SaveChanges(), tx.op_key,
                                         changes_known=unchanged)
            for tx in order:
                _pause("after_commit", tx)

    def read(self, slug: str, sections: tuple[str, ...]) -> Org:
        return store.load_org(slug)            # a fresh whole-document parse


def _json_image(org: Org | None) -> str | None:
    """The whole document as JSON, key order included, to tell a no-op body from a
    write (two extra whole-document dumps per transaction, JSON store only).
    None (treated as changed) when it cannot be serialised — the save
    then raises exactly as it always did."""
    if org is None:
        return None
    try:
        return json.dumps(org.d, separators=(",", ":"))   # key ORDER counts: the file keeps it
    except (TypeError, ValueError):
        return None


_json_backend: JsonBackend | None = None


def _json_fallback() -> JsonBackend:
    """The one process-wide JSON fallback (its receipts must be shared)."""
    global _json_backend
    with _backend_lock:
        if _json_backend is None:
            _json_backend = JsonBackend()
        return _json_backend


_PG_RETRY = {"40001": SerializationFailure, "40P01": DeadlockDetected}


def _pg_error(e: BaseException) -> BaseException:
    """Map a PostgreSQL failure (raw psycopg, or store's sqlite3-shaped
    re-raise carrying `.sqlstate`) onto this module's errors."""
    state = str(getattr(e, "sqlstate", "") or "")
    if state in _PG_RETRY:
        return _PG_RETRY[state](f"{state}: {e}")
    if state == "55P03":
        return LockTimeout(f"{state}: {e}")
    return e


class PgBackend:
    """org_tx on PostgreSQL: ONE server connection and ONE transaction for
    every org the call names, pinned so the seam's loads and saves run inside
    it (pgstore module docstring). Orgs are locked in org_id order, each by
    `_lock_plan`.

    Each named row takes a transaction advisory lock keyed on (org, row) —
    exclusive or shared — which covers a row that does not exist yet (a
    node being created), then `SELECT … FOR UPDATE / FOR SHARE` on the row
    itself, so a legacy seam save's UPDATE of it waits too. PostgreSQL's
    own detector reports deadlocks (40P01) and `lock_timeout` bounds waits
    (55P03 → LockTimeout). Each org's save bumps that org's revision and
    NOTIFYs; only the last save's COMMIT reaches the server."""

    def transaction(self, tx: OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]:
        return self.transaction_many([tx], lock_timeout)

    @contextlib.contextmanager
    def transaction_many(self, txs: list[OrgTx], lock_timeout: float) -> Iterator[None]:
        from . import pgstore
        from .ledger import LedgerError
        conns: dict[str, Any] = {}
        for tx in txs:
            org_id = pgstore.read_marker(store._db_path(tx.slug))  # pyright: ignore[reportPrivateUsage]
            if org_id is None:
                raise LedgerError(f"no such org: {tx.slug!r}")
            pgstore.refuse_duplicate(tx.slug, org_id)   # a copied marker shares a schema
            conns[tx.slug] = org_id
        order = sorted(txs, key=lambda t: conns[t.slug])
        raw = pgstore._checkout()                  # pyright: ignore[reportPrivateUsage]
        shared: list[int | None] = [None]
        for tx in order:
            c = pgstore.PgConn(raw, tx.slug, conns[tx.slug])
            c.path_holder = shared
            conns[tx.slug] = c
        loc = store._orgtx_local                   # pyright: ignore[reportPrivateUsage]
        try:
            for tx in order:
                _pause("before_lock", tx)
            sel = {"node": "SELECT 1 FROM nodes WHERE id = %s",
                   "section": "SELECT 1 FROM doc WHERE key = %s",
                   "log": "SELECT 1 FROM log_d WHERE sect = %s AND owner = %s"}
            try:
                raw.execute("BEGIN")
                # LOCAL: dies with this transaction, so a pooled connection
                # never carries it into a later legacy save (review B3)
                raw.execute(f"SET LOCAL lock_timeout = '{max(1, int(lock_timeout * 1000))}ms'")
                raw.execute(f"SET LOCAL idle_in_transaction_session_timeout = "
                            f"'{int(IDLE_IN_TX_TIMEOUT_S * 1000)}ms'")
                for tx in order:
                    conn = conns[tx.slug]
                    conn.use()
                    ids: list[str] = []
                    raw.execute("SELECT pg_advisory_xact_lock" + ("" if tx.whole else "_shared")
                                + "(%s, hashtext(%s))", (conn.org_id, f"org:{_ORG_KEY}"))
                    # The marker was read BEFORE this lock. A delete_org
                    # (org_exclusive) that held it meanwhile has renamed the
                    # marker away but left the schema rows, so without this
                    # re-check the tx would commit into a deleted org — or,
                    # were the slug re-created, into the old org's orphaned
                    # rows (p01 review B1).
                    if pgstore.read_marker(store._db_path(tx.slug)) != conn.org_id:  # pyright: ignore[reportPrivateUsage]
                        raise LedgerError(f"no such org: {tx.slug!r}")
                    if tx.all_nodes:
                        if not tx.whole:
                            raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                                        (conn.org_id, f"node:{_ALL_NODES_KEY}"))
                        # the pseudo-rows exclude every other org_tx's node
                        # locks, so the rows take ONE bulk FOR UPDATE (stored
                        # on the tuples) instead of an advisory lock each: a
                        # lock-table entry per node overflows the server's
                        # shared lock table on a large org (S8 capacity)
                        ids = [str(r[0]) for r in raw.execute(
                            "SELECT id FROM nodes ORDER BY id FOR UPDATE").fetchall()]
                        tx.lock_nodes = frozenset(ids)
                        if tx.whole:
                            _whole_rows(
                                tx, [str(r[0]) for r in raw.execute(
                                    "SELECT key FROM doc ORDER BY key FOR UPDATE").fetchall()],
                                [(str(r[0]), str(r[1])) for r in raw.execute(
                                    "SELECT DISTINCT sect, owner FROM log_d").fetchall()])
                    for kind, name, exclusive in _lock_plan(tx, ids):
                        if kind == "org" or (tx.all_nodes and kind == "node"):
                            continue                   # taken above, in bulk
                        fn = ("pg_advisory_xact_lock" if exclusive
                              else "pg_advisory_xact_lock_shared")
                        raw.execute(f"SELECT {fn}(%s, hashtext(%s))",
                                    (conn.org_id, f"{kind}:{name}"))
                        if name == _ALL_NODES_KEY:
                            continue                   # a pseudo-row: no table row
                        args = tuple(json.loads(name)) if kind == "log" else (name,)
                        raw.execute(sel[kind] + (" FOR UPDATE" if exclusive else " FOR SHARE"),
                                    args)
            except Exception as e:
                raise _pg_error(e) from e
            for tx in order:
                _pause("after_lock", tx)
            for tx in order:
                if tx.op_key is None:
                    continue
                # a second call with the same key waits here for the first,
                # then finds its receipt and replays (review N1)
                try:
                    raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                                (conns[tx.slug].org_id, "receipt:" + tx.op_key))
                except Exception as e:
                    raise _pg_error(e) from e
                row = raw.execute("SELECT fingerprint, result FROM public.receipts "
                                  "WHERE org_id = %s AND op_key = %s",
                                  (conns[tx.slug].org_id, tx.op_key)).fetchone()
                if row is not None:
                    if row[0] != tx.fingerprint:
                        raise ReceiptConflict(
                            f"op_key {tx.op_key!r} was used with another fingerprint")
                    tx.replayed = True
                    tx.result = None if row[1] is None else json.loads(row[1])
            _refuse_mixed_replay(order)
            for c in conns.values():
                c.pinned = True
            loc.pinned = dict(conns)
            try:
                for tx in order:
                    with profiling.stage("org_load_ms"):     # as SeamBackend's
                        tx.org = store._load_sqlite_org(tx.slug)   # pyright: ignore[reportPrivateUsage]
                    _check_heal(tx)
                yield
                if any(tx.replayed for tx in order):
                    raw.execute("ROLLBACK")
                    for tx in order:
                        tx.revision = pgstore.revision(conns[tx.slug])
                    return
                for tx in order:
                    _pause("before_commit", tx)
                gots: dict[str, list[SaveChanges]] = {}
                for i, tx in enumerate(order):
                    conn = conns[tx.slug]
                    last = i == len(order) - 1
                    got: list[SaveChanges] = []
                    gots[tx.slug] = got

                    def guard(changes: SaveChanges, tx: OrgTx = tx, conn: Any = conn,
                              last: bool = last) -> None:
                        _check(tx, changes)
                        if tx.op_key is not None:
                            raw.execute("INSERT INTO public.receipts(org_id, op_key, "
                                        "fingerprint, result) VALUES (%s, %s, %s, %s)",
                                        (conn.org_id, tx.op_key, tx.fingerprint,
                                         json.dumps(tx.result)))
                            if changes.is_empty():
                                # the receipt IS the write: bump + NOTIFY, as
                                # the fake does (review N4)
                                pgstore.on_save_commit(conn, True)
                        # only the LAST save's COMMIT reaches the server
                        conn.commit_armed = last

                    loc.guard, loc.on_commit = guard, got.append
                    loc.defer_hooks = tx.deferred_hooks
                    try:
                        _billed_save(tx.org, got, tx.op_key is not None)
                    except Exception as e:
                        raise _pg_error(e) from e
                    finally:
                        loc.guard = loc.on_commit = loc.defer_hooks = None
            finally:
                loc.pinned = None
                for c in conns.values():
                    c.pinned = False
            if len(order) > 1:
                # the earlier orgs published their change sets before the one
                # real COMMIT; a snapshot rebuilt in that window may hold
                # pre-commit rows under the new seq — bump again, as unknown
                for tx in order[:-1]:
                    store._publish_changes_unknown(tx.slug)   # pyright: ignore[reportPrivateUsage]
                    store._bump_org_seq(tx.slug)              # pyright: ignore[reportPrivateUsage]
            for tx in order:
                conn = conns[tx.slug]
                got = gots[tx.slug]
                tx.revision = (conn.last_revision if conn.last_revision is not None
                               else pgstore.revision(conn))
                tx.committed = Committed(tx.slug, tx.revision,
                                         got[0] if got else SaveChanges(), tx.op_key)
            for tx in order:
                _pause("after_commit", tx)
        finally:
            with contextlib.suppress(Exception):
                pq = pgstore._psycopg().pq          # pyright: ignore[reportPrivateUsage]
                if raw.info.transaction_status != pq.TransactionStatus.IDLE:
                    raw.execute("ROLLBACK")
            pgstore._release(raw)                   # pyright: ignore[reportPrivateUsage]

    def read(self, slug: str, sections: tuple[str, ...]) -> Org:
        return store.load_org_snapshot(slug, sections)

    @contextlib.contextmanager
    def exclusive(self, slug: str, lock_timeout: float) -> Iterator[None]:
        """`org_exclusive` on PostgreSQL: the org pseudo-row's advisory lock
        EXCLUSIVE in a short transaction of its own that reads and writes
        nothing, rolled back when the block ends."""
        from . import pgstore
        from .ledger import LedgerError
        org_id = pgstore.read_marker(store._db_path(slug))   # pyright: ignore[reportPrivateUsage]
        if org_id is None:
            raise LedgerError(f"no such org: {slug!r}")
        raw = pgstore._checkout()                  # pyright: ignore[reportPrivateUsage]
        try:
            try:
                raw.execute("BEGIN")
                raw.execute(f"SET LOCAL lock_timeout = '{max(1, int(lock_timeout * 1000))}ms'")
                # DELIBERATELY no idle_in_transaction_session_timeout (unlike
                # transaction_many): this transaction is idle for the whole
                # file rename, and a server-side kill would drop the lock
                # while the org's files are half moved (p01 review N1).
                raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                            (org_id, f"org:{_ORG_KEY}"))
            except Exception as e:
                raise _pg_error(e) from e
            yield
        finally:
            with contextlib.suppress(Exception):
                raw.execute("ROLLBACK")
            pgstore._release(raw)                   # pyright: ignore[reportPrivateUsage]


_backend: Backend | None = None
_backend_lock = threading.Lock()


def backend() -> Backend:
    global _backend
    with _backend_lock:
        if _backend is None:
            _backend = PgBackend() if store.STORE_BACKEND == "postgres" else SeamBackend()
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


def _section_names(x: Iterable[str | tuple[str, str]] | None, what: str
                   ) -> tuple[frozenset[str], frozenset[str]]:
    """(row names, split containers to share): a bare section name is its
    row; a `(split section, owner)` pair is the owner's row
    (`section\\x1fowner`), and its section's container row is returned to be
    locked SHARED."""
    if x is None:
        return frozenset(), frozenset()
    if isinstance(x, str):
        raise TypeError(f"{what} must be a list of names, not a string")
    rows: set[str] = set()
    parents: set[str] = set()
    for n in x:
        if isinstance(n, str):
            if store.SPLIT_SEP in n:
                raise ValueError(f"{what}: {n!r}: name an owner row as "
                                 "(section, owner)")
            rows.add(n)
            continue
        if len(n) != 2 or n[0] not in store.SPLIT_SECTIONS \
                or not isinstance(n[1], str) or not n[1] \
                or store.SPLIT_SEP in n[1]:
            raise ValueError(f"{what}: {n!r} must be (section, owner) with "
                             f"section in {sorted(store.SPLIT_SECTIONS)!r}")
        rows.add(n[0] + store.SPLIT_SEP + n[1])
        parents.add(n[0])
    return frozenset(rows), frozenset(parents)


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


class _All:
    """The `nodes=ALL` sentinel: lock every node row of the org."""

    def __repr__(self) -> str:
        return "orgtx.ALL"


ALL: Any = _All()


def open_on(slug: str) -> bool:
    """Is an org_tx (single or multi-org) open on `slug` on THIS thread? For
    helpers callable both inside and outside a transaction (PG-3d)."""
    return slug in (getattr(_open, "slugs", None) or set())


def current_tx(slug: str) -> OrgTx | None:
    """The org_tx open on `slug` on THIS thread, or None — for code that runs
    inside a save (pre-save hooks, reconcile) and must confine its writes to
    the rows the transaction locked."""
    return cast("dict[str, OrgTx]", getattr(_open, "txs", None) or {}).get(slug)


def _new_tx(slug: str, nodes: Iterable[str] | Any = None,
            sections: Iterable[SectionName] | None = None,
            logs: Iterable[LogName] | None = None,
            share_nodes: Iterable[str] | None = None,
            share_sections: Iterable[SectionName] | None = None,
            op_key: str | None = None, fingerprint: str | None = None,
            whole: bool = False) -> OrgTx:
    """Validate one org's names and build its (not yet begun) OrgTx."""
    if whole:
        if nodes is not None or sections or logs or share_nodes or share_sections:
            raise ValueError("whole=True locks every row: name no nodes, sections, "
                             "logs or shares beside it")
        if fingerprint is not None and op_key is None:
            raise ValueError("fingerprint without op_key")
        return OrgTx(slug=slug, org=cast(Org, None), op_key=op_key,
                     fingerprint=fingerprint, all_nodes=True, whole=True)
    all_nodes = nodes is ALL
    lock_nodes = frozenset() if all_nodes else _names(nodes, "nodes")
    lock_sections, lock_parents = _section_names(sections, "sections")
    sh_nodes = _names(share_nodes, "share_nodes") - lock_nodes
    sh_rows, sh_parents = _section_names(share_sections, "share_sections")
    # PG-3d: a doc section that has become a log keeps working when named
    # the old way — written ones move to logs=, shared ones need no lock
    moved = lock_sections & MOVED_TO_LOGS
    if moved and not isinstance(logs, str):     # a str is _check_logs' refusal
        lock_sections -= moved
        logs = [*(logs or ()), *sorted(moved)]
    sh_rows -= MOVED_TO_LOGS
    sh_sections = (sh_rows | sh_parents | lock_parents) - lock_sections
    _check_sections(lock_sections | sh_sections, "sections")
    log_names = _check_logs(logs)
    if fingerprint is not None and op_key is None:
        raise ValueError("fingerprint without op_key")
    return OrgTx(slug=slug, org=cast(Org, None), lock_nodes=lock_nodes,
                 lock_sections=lock_sections, share_nodes=sh_nodes,
                 share_sections=sh_sections, logs=log_names,
                 op_key=op_key, fingerprint=fingerprint, all_nodes=all_nodes)


@contextlib.contextmanager
def _run(make: Callable[[], list[OrgTx]], lock_timeout: float | None,
         retries: int) -> Iterator[list[OrgTx]]:
    """The shared driver of org_tx and org_tx_multi: nesting check, retry
    of failures raised while taking locks, deferred hooks, listeners."""
    first = make()
    slugs = [t.slug for t in first]
    if len(set(slugs)) != len(slugs):
        raise ValueError("an org is named twice")
    open_slugs: set[str] = getattr(_open, "slugs", None) or set()
    nested = sorted(set(slugs) & open_slugs)
    if nested:
        raise NestedTx(f"org_tx on {nested!r} is already open on this thread")
    timeout = DEFAULT_LOCK_TIMEOUT_S if lock_timeout is None else lock_timeout
    b = backend()
    txs = first
    # the JSON fallback's only lock is DOC_LOCK, so it is taken here, before
    # any row-lock bookkeeping, whether or not the fence is on (decision 39)
    fence: contextlib.AbstractContextManager[Any] = (
        store.FENCE if TRANSITION_FENCE or store.STORE_BACKEND == "json"
        else contextlib.nullcontext())
    with fence:
        txs = yield from _attempts(b, txs, make, slugs, open_slugs, timeout, retries)
    # save hooks deferred out of the transaction: after COMMIT, with the row
    # locks AND the fence released
    for t in txs:
        for hs in t.deferred_hooks:
            store.fire_save_hooks(hs)
    for t in txs:
        if t.committed is not None:
            for fn in list(commit_listeners):
                try:
                    fn(t.committed)
                except Exception:                               # noqa: BLE001
                    pass


def _attempts(b: Backend, txs: list[OrgTx], make: Callable[[], list[OrgTx]],
              slugs: list[str], open_slugs: set[str], timeout: float,
              retries: int) -> Iterator[list[OrgTx]]:
    """The retry loop of `_run` (a generator it delegates to): retries only a
    failure raised while taking locks, before the body ran."""
    attempt = 0
    heals = 0
    while True:
        body_ran = False
        open_slugs.update(slugs)
        _open.slugs = open_slugs
        registry: dict[str, OrgTx] = getattr(_open, "txs", None) or {}
        for t in txs:
            registry[t.slug] = t
        _open.txs = registry
        loc = store._orgtx_local                   # pyright: ignore[reportPrivateUsage]
        loc.rowlock_depth = getattr(loc, "rowlock_depth", 0) + 1
        try:
            with b.transaction_many(txs, timeout):
                body_ran = True
                yield txs
        except _HealNeeded as h:
            # locks released by the backend's exit; commit the heal, re-run
            heals += 1
            if heals > MAX_HEALS:
                raise OrgTxError(f"org_tx on {h.slug!r}: the load keeps healing "
                                 f"{h.rows} (a writer keeps restoring a pre-heal shape)") from h
            _heal(h.slug)
            txs = make()
            continue
        except Retryable:
            if body_ran or attempt >= retries:
                raise
            attempt += 1
            time.sleep(random.uniform(0, 0.01 * (2 ** attempt)))
            txs = make()
            continue
        finally:
            loc.rowlock_depth -= 1
            for sl in slugs:
                open_slugs.discard(sl)
                registry.pop(sl, None)
        return txs


@contextlib.contextmanager
def org_tx(slug: str, *, nodes: Iterable[str] | Any = None,
           sections: Iterable[SectionName] | None = None,
           logs: Iterable[LogName] | None = None,
           share_nodes: Iterable[str] | None = None,
           share_sections: Iterable[SectionName] | None = None,
           op_key: str | None = None, fingerprint: str | None = None,
           lock_timeout: float | None = None,
           retries: int = DEFAULT_RETRIES, whole: bool = False) -> Iterator[OrgTx]:
    """One row transaction on one org. See the module docstring."""
    def make() -> list[OrgTx]:
        return [_new_tx(slug, nodes, sections, logs, share_nodes, share_sections,
                        op_key, fingerprint, whole)]
    with _run(make, lock_timeout, retries) as txs:
        yield txs[0]


@contextlib.contextmanager
def org_tx_multi(specs: dict[str, dict[str, Any]], *,
                 lock_timeout: float | None = None,
                 retries: int = DEFAULT_RETRIES) -> Iterator[dict[str, OrgTx]]:
    """One transaction over SEVERAL orgs (plan decision 13: interorg_send,
    deliver_org_inbox, net inbound), replacing DOC_LOCK's process-wide reach.

        with orgtx.org_tx_multi({a: dict(nodes=[x]), b: dict(sections=["org_inbox_q"])}) as t:
            t[a].d[...] ...; t[b].d[...] ...

    Each spec takes org_tx's keywords (nodes/sections/logs/share_*/op_key/
    fingerprint). Orgs are locked in org_id order (slug order on the fake);
    on PostgreSQL every org commits in ONE transaction, and each org's
    revision is bumped and NOTIFYd. ⚠ The SQLite fake commits the orgs one
    after another — not atomic across orgs."""
    def make() -> list[OrgTx]:
        return [_new_tx(slug, **spec) for slug, spec in specs.items()]
    with _run(make, lock_timeout, retries) as txs:
        yield {t.slug: t for t in txs}


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


@contextlib.contextmanager
def org_exclusive(slug: str, *, lock_timeout: float | None = None) -> Iterator[None]:
    """Exclude every org_tx on `slug` for the block, WITHOUT loading or
    saving it: the transition fence (while it is on, as every org_tx takes
    it), then the org pseudo-row EXCLUSIVE. For store.delete_org, whose
    rename must not race a transaction that loaded before it and saves after
    it (that save would re-create the org). A transaction queued behind it
    then finds the org gone. Not re-entrant with an org_tx on the same org
    on this thread (NestedTx)."""
    if slug in (getattr(_open, "slugs", None) or set()):
        raise NestedTx(f"org_exclusive on {slug!r} inside an org_tx on it")
    timeout = DEFAULT_LOCK_TIMEOUT_S if lock_timeout is None else lock_timeout
    fence: contextlib.AbstractContextManager[Any] = (
        store.FENCE if TRANSITION_FENCE or store.STORE_BACKEND == "json"
        else contextlib.nullcontext())
    b = backend()
    excl = getattr(b, "exclusive", None)
    with fence:
        if excl is None:                           # a test backend without it
            yield
            return
        with excl(slug, timeout):
            yield


def org_read(slug: str, *, sections: Iterable[str] = ()) -> Org:
    """A lock-free, read-only view; the named lazy sections are captured in
    one coherent read. Nothing written to the result is ever saved."""
    return backend().read(slug, tuple(_names(sections, "sections")))
