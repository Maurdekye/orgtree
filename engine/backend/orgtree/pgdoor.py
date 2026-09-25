"""pgdoor — THE SHARED PROLOGUE for agent tools converted off DOC_LOCK.

`api.agent_call` used to run every agent tool inside ONE resident write cycle
(`store.write_org` = DOC_LOCK + the whole document). The PostgreSQL alpha
(PYPG plan, lead ruling 2026-09-25 16:13Z) pulls the tools out FAMILY BY
FAMILY: each family gets its own `org_tx` branch, dispatched BEFORE the shared
cycle takes DOC_LOCK, and a converted branch never runs inside DOC_LOCK
(`org_tx` never waits on DOC_LOCK). Every converted branch needs the same
prologue the old cycle gave it for free, and this module is the ONE copy of
it:

    1. the caller's NODE ROW is locked FOR UPDATE — with every other row the
       family names, in the org-wide order below — and `halt` is checked ON
       THAT LOCKED ROW, after every lock is held;
    2. the `killswitch` section is locked FOR SHARE and checked there;
    3. receipt admission (`_op_admit`): a replay returns its receipt and
       runs nothing;
    4. the family body runs, in the same transaction;
    5. the receipt is filed (`_op_file`) — the LAST write before commit, so
       the receipt and the effect it describes commit together or not at all;
    6. commit (org_tx does the save, the revision bump and NOTIFY), and only
       THEN the post-commit hook (`opreceipts.witness`).

WHY THE ORDER IN (1)-(2) IS LOAD-BEARING (halt.py:6-12). Under DOC_LOCK,
admission, delivery and the durable halt were serialised by the one lock. In
row terms that becomes: whoever writes `halt` on a node holds that node's row
FOR UPDATE and commits `halt` before it kills anything, and every tool call
checks `halt` only AFTER it holds the same row. So a tool call either
committed before the halt, or it sees the halt and is refused — there is no
third outcome. A check made before the lock (on a snapshot, `cached_org`,
a pre-read) reopens exactly the window the rule closes, which is why the
check lives inside `_gate` and `_gate` is only ever called on the locked
document. The killswitch works the same way with a shared lock: every tool
call holds the row FOR SHARE, the latch takes it FOR UPDATE, so a latch waits
for in-flight tools and every later tool sees it — without making every tool
in the org queue behind every other one on a single row.

LOCK ORDER (org-wide rule, agreed with WS3b 2026-09-25). Node rows in
ascending id order, then section rows in ascending name order; nothing locks
an org row. `_norm` sorts every declared list, and the caller's own row is
sorted in with the rest, so any two transactions that share rows meet them in
the same order and cannot deadlock on each other. The halt rule does not need
the caller's row FIRST, only HELD: the gate runs after every lock is granted.
A family body must not reach back for a row it did not name (it raises
`Widen` instead).

The receipt functions are PASSED IN (`admit`, `file`) rather than imported:
they live in `api` (they build HTTP refusals and read api-side helpers), and
importing `api` from here would be a cycle. This keeps the module free of
FastAPI and testable against a fake `org_tx`.

RE-RUN SAFETY. `org_tx` may retry the whole transaction on a serialization
failure or deadlock (40001 / 40P01). Everything inside `fn` must therefore be
a pure function of the locked document: no process spawns, no provider reads,
no mail sends outside the document — do those after `agent_tx` returns, the
way `agent_call` already does its post-save work.
"""
from __future__ import annotations

import contextlib
import os
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Iterator, Union

from . import opreceipts
from .ledger import LedgerError

KILLSWITCH = "killswitch"
# How many times a retryable failure re-runs the whole transaction before the
# error is raised to the caller. org_tx may retry on its own as well; this is
# the outer bound for the context-manager form, which cannot re-enter itself.
MAX_ATTEMPTS = 5

HALTED = "agent is halted — tools cannot execute until unhalt"
KILLSWITCHED = ("the org killswitch is latched — tools cannot execute until "
                "the user releases it")


# ------------------------------------------------------------ the tx seam
#
# ONE place names the storage primitive: PG-0's `orgtx.org_tx` (contract in
# its module docstring). It yields a HANDLE — the Org is `handle.org` — takes
# every lock up front in its own fixed order, and at commit refuses a write
# to any row it did not lock with `orgtx.UnlockedWrite` (nothing saved).
# Tests install a fake with `use_org_tx`; the fake must yield an object with
# an `.org` the same way.

@dataclass
class _Seam:
    org_tx: Callable[..., Any] | None = None
    is_retryable: Callable[[BaseException], bool] | None = None
    # the rows an UnlockedWrite refused, as (kind, name) pairs, or None when
    # the exception is not such a refusal
    refused: Callable[[BaseException], "list[tuple[str, str]] | None"] | None = None
    # the unlocked read a callable spec is computed from (tests: a fake)
    snapshot: Callable[[str], Any] | None = None


_SEAM = _Seam()


def use_org_tx(org_tx: Callable[..., Any] | None,
               is_retryable: Callable[[BaseException], bool] | None = None,
               snapshot: Callable[[str], Any] | None = None,
               refused: Callable[[BaseException], "list[tuple[str, str]] | None"]
               | None = None) -> None:
    """Install the storage primitive (tests: a fake). `None` restores PG-0's
    `orgtx.org_tx` with its own retry and refusal rules."""
    _SEAM.org_tx = org_tx
    _SEAM.is_retryable = is_retryable
    _SEAM.snapshot = snapshot
    _SEAM.refused = refused


def _org_tx() -> Callable[..., Any]:
    if _SEAM.org_tx is not None:
        return _SEAM.org_tx
    from . import orgtx
    return orgtx.org_tx


def _retryable(e: BaseException) -> bool:
    if _SEAM.is_retryable is not None:
        return _SEAM.is_retryable(e)
    if _SEAM.org_tx is not None:
        return False
    from . import orgtx
    return isinstance(e, orgtx.Retryable)


# PG-0's refusal message names each row as  section 'x' / node 'x' / log 'x'
_REFUSED = re.compile(r"\b(section|node|log) '([^']*)'")


def _refused(e: BaseException) -> "list[tuple[str, str]] | None":
    """The rows an `UnlockedWrite` names, preferring a structured `rows`
    attribute (asked of PG-0) over reading the message."""
    if _SEAM.refused is not None:
        return _SEAM.refused(e)
    from . import orgtx
    if not isinstance(e, orgtx.UnlockedWrite):
        return None
    rows = getattr(e, "rows", None)
    if rows:
        return [(str(k), str(n)) for k, n in rows]
    return [(m.group(1), m.group(2)) for m in _REFUSED.finditer(str(e))]


def enabled() -> bool:
    """Do declared tools run on the door in this process? On the PostgreSQL
    store, yes. On SQLite only when ORGTREE_PGDOOR=1 (tests, drills): there
    PG-0's SeamBackend keeps its row locks per process and an unconverted
    DOC_LOCK save takes none, so the door is not the default. ORGTREE_PGDOOR=0
    turns it off everywhere (the operational escape hatch)."""
    flag = os.environ.get("ORGTREE_PGDOOR", "").strip()
    if flag == "0":
        return False
    if flag == "1":
        return True
    from . import store
    return store.STORE_BACKEND == "postgres"


# ------------------------------------------------------ the declarations
#
# THE ONE TABLE (plan decision 12, WS3b's format). A tool or operator op is
# converted off DOC_LOCK exactly when it has an entry here; a tool with no
# entry keeps the old DOC_LOCK cycle. Each family registers its own entries
# from its own module with `declare`, so this file never has to know them.
#
# A spec is either a static `TxSpec` or a callable
# `(snapshot, body, args) -> TxSpec` for ops whose rows depend on the tree
# (a move's subtree, a hire's chain). The snapshot is an UNLOCKED read, so
# the rows it yields can be stale by the time the locks are held. Two things
# widen it, both by rolling back and running the whole transaction again
# with the extra rows: a body that finds a row missing raises `Widen(...)`,
# and PG-0 refusing a write to an unlocked row (`UnlockedWrite`) is turned
# into the same widening. Neither attempt commits anything.

LogName = Union[str, "tuple[str, str]"]


@dataclass(frozen=True)
class TxSpec:
    """Rows one transaction locks. `nodes`/`sections` FOR UPDATE,
    `share_*` FOR SHARE; `logs` are the append-only sections it writes (a
    name, or `(dict_log, owner)`)."""
    nodes: tuple[str, ...] = ()
    sections: tuple[str, ...] = ()
    share_nodes: tuple[str, ...] = ()
    share_sections: tuple[str, ...] = ()
    logs: "tuple[LogName, ...]" = ()

    def widened(self, w: "Widen") -> "TxSpec":
        o = w.spec
        return TxSpec(self.nodes + o.nodes, self.sections + o.sections,
                      self.share_nodes + o.share_nodes,
                      self.share_sections + o.share_sections,
                      self.logs + o.logs)

    def covers(self, o: "TxSpec") -> "TxSpec":
        """The part of `o` this spec does NOT hold (empty when it covers it).
        A shared row is covered by either lock; a log by its section name."""
        logs = {x if isinstance(x, str) else x[0] for x in self.logs}
        return TxSpec(
            tuple(n for n in o.nodes if n not in self.nodes),
            tuple(s for s in o.sections if s not in self.sections),
            tuple(n for n in o.share_nodes
                  if n not in self.nodes and n not in self.share_nodes),
            tuple(s for s in o.share_sections
                  if s not in self.sections and s not in self.share_sections),
            tuple(x for x in o.logs
                  if x not in self.logs
                  and (x if isinstance(x, str) else x[0]) not in logs))

    def empty(self) -> bool:
        return not (self.nodes or self.sections or self.share_nodes
                    or self.share_sections or self.logs)


SpecFn = Callable[[Any, Any, "dict[str, Any]"], TxSpec]
LOCKS: "dict[str, TxSpec | SpecFn]" = {}
BODIES: "dict[str, Callable[[AgentTx], Any]]" = {}
KIOSK_EXEMPT: "set[str]" = set()
# a body may widen this many times before the door gives up (each widening is
# a full rollback and re-run, so a runaway would be a livelock, not a bug)
MAX_WIDEN = 3


class Widen(Exception):
    """Raised by a body that needs rows its spec did not declare. The door
    rolls back, merges them in and re-runs; nothing the body did survives."""

    def __init__(self, **rows: "Iterable[LogName]") -> None:
        super().__init__(f"widen: {rows}")
        self.spec = TxSpec(**{k: tuple(v) for k, v in rows.items()})


def declare(name: str, spec: "TxSpec | SpecFn",
            body: "Callable[[AgentTx], Any] | None" = None, *,
            kiosk_exempt: bool = False) -> None:
    """Register one tool (`orgtree_*`) or operator op: its rows, and for an
    agent tool the body `agent_call` runs on the door (`body(tx) -> result`).
    `kiosk_exempt` (lead decision 18.8): the tool is PROVEN unable to move
    top-level holdings, so the door skips the kiosk credit-cap check for it —
    the family carries the proof. Re-declaring a name with a DIFFERENT spec
    or body is refused: two families claiming one tool is a merge bug, and
    last-wins would hide it."""
    old, old_body = LOCKS.get(name), BODIES.get(name)
    if (old is not None and old != spec) or (
            old_body is not None and body is not None and old_body != body):
        raise ValueError(f"pgdoor: {name!r} is already declared")
    LOCKS[name] = spec
    if body is not None:
        BODIES[name] = body
    if kiosk_exempt:
        KIOSK_EXEMPT.add(name)


def declared(name: str) -> bool:
    """Does this tool/op have a lock declaration (and so run on the door when
    `enabled()`), or does it keep DOC_LOCK?"""
    return name in LOCKS


def routed(name: str) -> bool:
    """Should `agent_call` hand this tool to the door right now?"""
    return name in LOCKS and name in BODIES and enabled()


def _snapshot(slug: str) -> Any:
    if _SEAM.snapshot is not None:
        return _SEAM.snapshot(slug)
    from . import store
    return store.cached_org(slug)


def _resolve(name: str, slug: str, body: Any, a: dict[str, Any]) -> TxSpec:
    spec = LOCKS.get(name)
    if spec is None:
        raise LedgerError(f"pgdoor: {name!r} has no lock declaration — it "
                          f"still runs under DOC_LOCK")
    if isinstance(spec, TxSpec):
        return spec
    return spec(_snapshot(slug), body, a)


# the transaction open on this thread/context, so a writer called from
# inside a door body JOINS it instead of opening a nested one (which PG-0
# refuses with NestedTx)
_CURRENT: "ContextVar[tuple[str, Any, TxSpec] | None]" = ContextVar(
    "pgdoor_current", default=None)


def current(slug: str) -> Any:
    """The open transaction handle for `slug` on this context, or None."""
    cur = _CURRENT.get()
    return cur[1] if cur is not None and cur[0] == slug else None


@contextlib.contextmanager
def join(slug: str, **rows: "Iterable[LogName]") -> "Iterator[Any]":
    """Use the transaction already open for `slug` from inside a door body.
    Every row asked for must already be held; a missing one raises `Widen`
    for it, so the door rolls back and re-runs holding it. Outside a door
    body there is nothing to join: open one with `run`."""
    cur = _CURRENT.get()
    if cur is None or cur[0] != slug:
        raise LedgerError(f"pgdoor.join: no transaction is open for {slug!r} "
                          f"— use pgdoor.run")
    need = cur[2].covers(TxSpec(**{k: tuple(v) for k, v in rows.items()}))
    if not need.empty():
        raise Widen(nodes=need.nodes, sections=need.sections,
                    share_nodes=need.share_nodes,
                    share_sections=need.share_sections, logs=need.logs)
    yield cur[1]


def _run(slug: str, spec: TxSpec, step: Callable[[Any, TxSpec], Any]
         ) -> tuple[Any, Any]:
    """Open org_tx on `spec` and run `step(handle, spec)`; re-run on a
    retryable failure, a `Widen`, or a refused write to an unlocked row.
    Returns (handle, step's value) after the commit."""
    if _CURRENT.get() is not None and _CURRENT.get()[0] == slug:
        raise LedgerError(f"pgdoor: a transaction on {slug!r} is already open "
                          f"here — join it (pgdoor.join) instead of nesting")
    spec = _norm(spec)
    attempts = widens = 0
    while True:
        attempts += 1
        token = None
        try:
            with _org_tx()(slug, nodes=list(spec.nodes),
                           sections=list(spec.sections),
                           share_nodes=list(spec.share_nodes),
                           share_sections=list(spec.share_sections),
                           logs=list(spec.logs)) as h:
                token = _CURRENT.set((slug, h, spec))
                try:
                    out = step(h, spec)
                finally:
                    _CURRENT.reset(token)
            return h, out
        except Widen as w:
            wider = _norm(spec.widened(w))
            if wider == spec:
                raise LedgerError(f"pgdoor: a body asked for rows it already "
                                  f"holds ({w}) — nothing was applied") from w
        except BaseException as e:
            rows = _refused(e)
            if rows is None:
                if attempts < MAX_ATTEMPTS and _retryable(e):
                    continue
                raise
            wider = _norm(spec.widened(Widen(
                nodes=[n for k, n in rows if k == "node"],
                sections=[n for k, n in rows if k == "section"],
                logs=[n for k, n in rows if k == "log"])))
            if wider == spec:
                raise              # refused rows we already hold: a real bug
        widens += 1
        if widens > MAX_WIDEN:
            raise LedgerError(f"pgdoor: the lock set kept growing after "
                              f"{MAX_WIDEN} widenings — nothing was applied; "
                              f"retry the call")
        spec = wider
        attempts -= 1          # a widening is not a failed attempt


def run(slug: str, spec: TxSpec, fn: Callable[[Any], Any]) -> Any:
    """A plain door transaction for a writer that is not an agent tool (a
    supervisor pass, a lifecycle writer called on its own): `fn(handle)` with
    the same widening and retries, and `join` works inside it."""
    return _run(slug, spec, lambda h, _held: fn(h))[1]


# ------------------------------------------------------------ the prologue

@dataclass
class After:
    """What a body leaves for AFTER the commit, reset on every attempt so a
    rolled-back run leaves nothing behind: agents to drive (wake), and
    callables run with the result once the commit has succeeded."""
    drive: list[str] = field(default_factory=list)
    then: "list[Callable[[Any], None]]" = field(default_factory=list)
    # set when the call was a REPLAY of a receipted key: nothing ran, nothing
    # committed, and the caller must skip every post-commit step too
    replayed: bool = False

    def reset(self) -> None:
        self.drive.clear()
        self.then.clear()
        self.replayed = False


class _Replay(Exception):
    """Carries a replayed key's payload OUT of the transaction, so org_tx
    rolls back instead of committing (and saving) an empty one."""

    def __init__(self, payload: Any) -> None:
        super().__init__("replay")
        self.payload = payload


@dataclass
class AgentTx:
    """What a family body receives: the locked document, the call, the rows
    actually held (so a body can `Widen` when it finds one missing), the
    open handle, and the `after` it fills for the post-commit tail."""
    org: Any
    node: str
    args: dict[str, Any]
    spec: TxSpec
    tx: Any = None
    call: Any = None
    after: After = field(default_factory=After)
    pre: dict[str, Any] = field(default_factory=dict)


def _gate(org: Any, nid: str) -> None:
    """Halt and killswitch — ONLY EVER CALLED ON THE LOCKED DOCUMENT."""
    node = org.node(nid)          # LedgerError when the seat is gone
    if node.get("halt"):
        raise LedgerError(HALTED)
    if org.d.get(KILLSWITCH):
        raise LedgerError(KILLSWITCHED)


def _receipted(body: Any, a: dict[str, Any]) -> bool:
    return bool(getattr(body, "op_key", None)) and opreceipts.receipted(
        body.tool, a)


def _logkey(x: "LogName") -> "tuple[str, ...]":
    return (x,) if isinstance(x, str) else tuple(x)


def _norm(spec: TxSpec) -> TxSpec:
    """A row named both ways is held FOR UPDATE only; duplicates dropped;
    every list sorted. PG-0's org_tx takes all its locks up front in its own
    fixed order (sections, then nodes, then logs, each sorted), and that is
    the org-wide rule; sorting here only makes the spec canonical, so a
    widened spec compares equal when nothing new was added."""
    ns = tuple(sorted(set(spec.nodes)))
    ss = tuple(sorted(set(spec.sections)))
    return TxSpec(ns, ss,
                  tuple(sorted(set(spec.share_nodes) - set(ns))),
                  tuple(sorted(set(spec.share_sections) - set(ss))),
                  tuple(sorted(set(spec.logs), key=_logkey)))


def agent_spec(body: Any, a: dict[str, Any], spec: TxSpec) -> TxSpec:
    """The rows `agent_tx` locks for this call: the caller's node row FOR
    UPDATE whatever the tool declared, the killswitch FOR SHARE (unless the
    tool itself holds it FOR UPDATE), and — when a key rides the call — the
    receipt log (appended) and its META row (FOR UPDATE). Public so a family
    (and a reviewer) can see exactly what a call will hold."""
    ns = (body.node,) + tuple(n for n in spec.nodes if n != body.node)
    secs, logs = tuple(spec.sections), tuple(spec.logs)
    if _receipted(body, a):
        # the receipts are an append-only LIST log (store.LIST_LOGS: one row
        # per receipt, appended); only the small META row — the seq counter
        # the rewind check reads — is a single row every keyed call rewrites
        if opreceipts.META not in secs:
            secs += (opreceipts.META,)
        if opreceipts.SECTION not in logs:
            logs += (opreceipts.SECTION,)
    return _norm(TxSpec(ns, secs, spec.share_nodes,
                        spec.share_sections + (KILLSWITCH,), logs))


def agent_tx(body: Any, a: dict[str, Any],
             fn: "Callable[[AgentTx], Any] | None" = None, *,
             admit: Callable[[Any, Any, dict[str, Any]], dict[str, Any] | None],
             file: Callable[[Any, Any, dict[str, Any], dict[str, Any], Any],
                            None],
             spec: TxSpec | None = None,
             after: After | None = None,
             pre: dict[str, Any] | None = None,
             on_commit: Callable[[Any, dict[str, Any] | None], None]
             | None = None) -> Any:
    """Run one agent tool as ONE row transaction with the shared prologue.

    The rows come from `LOCKS[body.tool]` (or an explicit `spec`), the body
    from `fn` or the one declared with the tool. `fn(tx)` returns the tool
    result. A LedgerError from the gate or the body rolls the whole
    transaction back and propagates (the caller maps it to 422 exactly as
    `agent_call`'s cycle does). A replayed key returns the receipt's replay
    payload and runs nothing.

    RECEIPTS are the engine's own (`opreceipts`, through `admit`/`file`),
    not org_tx's `op_key`: they live in the org's rows on every backend, so
    `orgtree_op_lookup` finds them and a restart's custody epoch still
    refuses a key it cannot vouch for. Do not also pass `op_key` to org_tx —
    one call would then carry two receipts.

    `on_commit(org, receipt_ctx)` runs once, after the commit (with None when
    no receipt rode the call), never on a retry, a replay or a rollback —
    `opreceipts.witness` belongs there."""
    base = spec if spec is not None else _resolve(body.tool, body.org, body, a)
    fn = fn if fn is not None else BODIES.get(body.tool)
    if fn is None:
        raise LedgerError(f"pgdoor: {body.tool!r} has no declared body")
    aft = after if after is not None else After()
    st: dict[str, Any] = {}

    def step(h: Any, held: TxSpec) -> Any:
        st.clear()
        aft.reset()
        org = h.org
        _gate(org, body.node)
        rcpt = st["rcpt"] = admit(org, body, a)
        if rcpt is not None and "replay" in rcpt:
            # nothing may run and nothing may be saved: leave by exception
            raise _Replay(rcpt["replay"])
        result = fn(AgentTx(org=org, node=body.node, args=a, spec=held, tx=h,
                            call=body, after=aft, pre=dict(pre or {})))
        if rcpt is not None:
            # LAST write before commit: effect and receipt are one tx
            file(org, body, a, rcpt, result)
        return result

    try:
        h, result = _run(body.org, agent_spec(body, a, base), step)
    except _Replay as r:
        aft.reset()
        aft.replayed = True
        return r.payload
    if on_commit is not None:
        on_commit(h.org, st.get("rcpt"))
    return result


@dataclass
class OpTx:
    """What an operator-op body receives."""
    org: Any
    op: str
    body: Any
    args: dict[str, Any]
    spec: TxSpec
    tx: Any = None


def op_tx(slug: str, op: str, body: Any, a: dict[str, Any],
          fn: Callable[[OpTx], Any], *, spec: TxSpec | None = None,
          on_commit: Callable[[Any], None] | None = None) -> Any:
    """Run one OPERATOR op (the user's door, POST /api/orgs/{slug}/ops) as one
    row transaction. No caller node row, no halt gate and no receipts: the
    operator is the user, `org_op` never had that prologue, and the user must
    be able to act on a halted agent or a latched org (that is how they are
    released). The target rows come from `LOCKS[op]`."""
    base = spec if spec is not None else _resolve(op, slug, body, a)
    h, result = _run(slug, base,
                     lambda h, held: fn(OpTx(org=h.org, op=op, body=body,
                                             args=a, spec=held, tx=h)))
    if on_commit is not None:
        on_commit(h.org)
    return result
