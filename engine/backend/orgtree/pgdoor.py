"""pgdoor — THE SHARED PROLOGUE for agent tools converted off DOC_LOCK.

`api.agent_call` used to run every agent tool inside ONE resident write cycle
(`store.write_org` = DOC_LOCK + the whole document). The PostgreSQL alpha
(PYPG plan, lead ruling 2026-09-25 16:13Z) pulls the tools out FAMILY BY
FAMILY: each family gets its own `org_tx` branch, dispatched BEFORE the shared
cycle takes DOC_LOCK, and a converted branch never runs inside DOC_LOCK
(`org_tx` never waits on DOC_LOCK). Every converted branch needs the same
prologue the old cycle gave it for free, and this module is the ONE copy of
it:

    1. the caller's NODE ROW is locked FOR UPDATE — FIRST, before any other
       row the family names — and `halt` is checked ON THAT LOCKED ROW;
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

LOCK ORDER. The caller's own node row is always the FIRST row named, so the
halt ordering holds whatever else a family locks; the killswitch is held FOR
SHARE; the family's rows follow in the order `org_tx` takes them. A family
body must not reach back for a row it did not name. This is NOT a global total
order: two callers that each name the other's node row (a hire into a
subtree whose root is hiring back into ours) can deadlock. PostgreSQL detects
that and aborts one with 40P01, which `org_tx` retries — so the cost is a
retry, never a hang, and never a lost write.

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

from dataclasses import dataclass
from typing import Any, Callable, Iterable

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
# ONE place names the storage primitive. Until PG-0 (p03-ws2-storecore)
# publishes `pgstore.org_tx`, tests install a fake with `use_org_tx`. The
# expected shape (PG-0's item): a context manager
#
#     org_tx(slug, *, nodes=[...], sections=[...], share_nodes=[...],
#            share_sections=[...], logs=[...]) -> Org
#
# that BEGINs, locks the named node/section rows (FOR UPDATE, or FOR SHARE for
# `share_nodes`/`share_sections`), yields the org with those rows loaded, and on a clean
# exit writes the changed rows, bumps the revision, NOTIFYs and COMMITs. An
# exception rolls everything back. `is_retryable(exc)` says whether a failure
# is worth re-running.

@dataclass
class _Seam:
    org_tx: Callable[..., Any] | None = None
    is_retryable: Callable[[BaseException], bool] = lambda _e: False
    # the unlocked read a callable spec is computed from (tests: a fake)
    snapshot: Callable[[str], Any] | None = None


_SEAM = _Seam()


def use_org_tx(org_tx: Callable[..., Any] | None,
               is_retryable: Callable[[BaseException], bool] | None = None,
               snapshot: Callable[[str], Any] | None = None) -> None:
    """Install the storage primitive (tests: a fake; production: pgstore's)."""
    _SEAM.org_tx = org_tx
    _SEAM.is_retryable = is_retryable or (lambda _e: False)
    _SEAM.snapshot = snapshot


def _org_tx() -> Callable[..., Any]:
    if _SEAM.org_tx is not None:
        return _SEAM.org_tx
    try:
        from . import pgstore  # type: ignore[attr-defined]
    except ImportError as e:  # PG-0 not landed on this branch yet
        raise LedgerError("org_tx is not available: the PostgreSQL store "
                          "(pgstore) is not installed in this build") from e
    use_org_tx(pgstore.org_tx, getattr(pgstore, "is_retryable", None))
    return pgstore.org_tx


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
# the rows it yields can be stale by the time the locks are held: a body that
# finds it needs a row it did not declare raises `Widen(...)`, and the door
# rolls back, adds those rows and runs the whole transaction again. That is
# what keeps specs honest without every tool over-declaring.

@dataclass(frozen=True)
class TxSpec:
    """Rows one transaction locks. `nodes`/`sections` FOR UPDATE,
    `share_*` FOR SHARE; `logs` are append-only sections it writes."""
    nodes: tuple[str, ...] = ()
    sections: tuple[str, ...] = ()
    share_nodes: tuple[str, ...] = ()
    share_sections: tuple[str, ...] = ()
    logs: tuple[str, ...] = ()

    def widened(self, w: "Widen") -> "TxSpec":
        o = w.spec
        return TxSpec(tuple(dict.fromkeys(self.nodes + o.nodes)),
                      tuple(dict.fromkeys(self.sections + o.sections)),
                      tuple(dict.fromkeys(self.share_nodes + o.share_nodes)),
                      tuple(dict.fromkeys(self.share_sections
                                          + o.share_sections)),
                      tuple(dict.fromkeys(self.logs + o.logs)))


SpecFn = Callable[[Any, Any, "dict[str, Any]"], TxSpec]
LOCKS: "dict[str, TxSpec | SpecFn]" = {}
# a body may widen this many times before the door gives up (each widening is
# a full rollback and re-run, so a runaway would be a livelock, not a bug)
MAX_WIDEN = 3


class Widen(Exception):
    """Raised by a body that needs rows its spec did not declare. The door
    rolls back, merges them in and re-runs; nothing the body did survives."""

    def __init__(self, **rows: Iterable[str]) -> None:
        super().__init__(f"widen: {rows}")
        self.spec = TxSpec(**{k: tuple(v) for k, v in rows.items()})


def declare(name: str, spec: "TxSpec | SpecFn") -> None:
    """Register one tool (`orgtree_*`) or operator op. Re-declaring the same
    name with a DIFFERENT spec is refused: two families claiming one tool is
    a merge bug, and last-wins would hide it."""
    old = LOCKS.get(name)
    if old is not None and old != spec:
        raise ValueError(f"pgdoor: {name!r} is already declared")
    LOCKS[name] = spec


def declared(name: str) -> bool:
    """Does this tool/op run on the door (True) or keep DOC_LOCK (False)?"""
    return name in LOCKS


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


def _run(slug: str, spec: TxSpec, step: Callable[[Any, TxSpec], Any]
         ) -> tuple[Any, Any]:
    """Open org_tx on `spec` and run `step(org, spec)`; re-run on a retryable
    failure or a `Widen`. Returns (org, step's value) after the commit."""
    attempts = widens = 0
    while True:
        attempts += 1
        try:
            with _org_tx()(slug, nodes=list(spec.nodes),
                           sections=list(spec.sections),
                           share_nodes=list(spec.share_nodes),
                           share_sections=list(spec.share_sections),
                           logs=list(spec.logs)) as org:
                out = step(org, spec)
            return org, out
        except Widen as w:
            widens += 1
            if widens > MAX_WIDEN:
                raise LedgerError(f"pgdoor: the lock set kept growing after "
                                  f"{MAX_WIDEN} widenings — nothing was "
                                  f"applied; retry the call") from w
            spec = _norm(spec.widened(w))
            attempts -= 1          # a widening is not a failed attempt
        except BaseException as e:
            if attempts < MAX_ATTEMPTS and _SEAM.is_retryable(e):
                continue
            raise


# ------------------------------------------------------------ the prologue

@dataclass
class AgentTx:
    """What a family body receives: the locked document, the call, and the
    rows actually held (so a body can `Widen` when it finds one missing)."""
    org: Any
    node: str
    args: dict[str, Any]
    spec: TxSpec


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


def _norm(spec: TxSpec) -> TxSpec:
    """A row named both ways is held FOR UPDATE only; duplicates dropped."""
    ns = tuple(dict.fromkeys(spec.nodes))
    ss = tuple(dict.fromkeys(spec.sections))
    return TxSpec(ns, ss,
                  tuple(n for n in dict.fromkeys(spec.share_nodes)
                        if n not in ns),
                  tuple(s for s in dict.fromkeys(spec.share_sections)
                        if s not in ss),
                  tuple(dict.fromkeys(spec.logs)))


def agent_spec(body: Any, a: dict[str, Any], spec: TxSpec) -> TxSpec:
    """The rows `agent_tx` locks for this call, in lock order: the caller's
    node row FIRST and FOR UPDATE whatever the tool declared, the killswitch
    FOR SHARE (unless the tool itself holds it FOR UPDATE), and — when a key
    rides the call — the receipt log (appended) and its META row (FOR UPDATE). Public so a family (and a
    reviewer) can see exactly what a call will hold."""
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
             fn: Callable[[AgentTx], Any], *,
             admit: Callable[[Any, Any, dict[str, Any]], dict[str, Any] | None],
             file: Callable[[Any, Any, dict[str, Any], dict[str, Any], Any],
                            None],
             spec: TxSpec | None = None,
             on_commit: Callable[[Any, dict[str, Any] | None], None]
             | None = None) -> Any:
    """Run one agent tool as ONE row transaction with the shared prologue.

    The rows come from `LOCKS[body.tool]` (or an explicit `spec`). `fn(tx)`
    is the family body; its return value is the tool result. A LedgerError
    from the gate or the body rolls the whole transaction back and propagates
    (the caller maps it to 422 exactly as `agent_call`'s cycle does). A
    replayed key returns the receipt's replay payload and runs nothing.
    `on_commit(org, receipt_ctx)` runs once, after the commit (with None when
    no receipt rode the call), never on a retry, a replay or a rollback —
    `opreceipts.witness` belongs there."""
    base = spec if spec is not None else _resolve(body.tool, body.org, body, a)
    st: dict[str, Any] = {}

    def step(org: Any, held: TxSpec) -> Any:
        st.clear()
        _gate(org, body.node)
        rcpt = st["rcpt"] = admit(org, body, a)
        if rcpt is not None and "replay" in rcpt:
            # nothing changed; the clean exit commits an empty tx
            return rcpt["replay"]
        result = fn(AgentTx(org=org, node=body.node, args=a, spec=held))
        if rcpt is not None:
            # LAST write before commit: effect and receipt are one tx
            file(org, body, a, rcpt, result)
        return result

    org, result = _run(body.org, agent_spec(body, a, base), step)
    rcpt = st.get("rcpt")
    if on_commit is not None and not (rcpt and "replay" in rcpt):
        on_commit(org, rcpt)
    return result


@dataclass
class OpTx:
    """What an operator-op body receives."""
    org: Any
    op: str
    body: Any
    args: dict[str, Any]
    spec: TxSpec


def op_tx(slug: str, op: str, body: Any, a: dict[str, Any],
          fn: Callable[[OpTx], Any], *, spec: TxSpec | None = None,
          on_commit: Callable[[Any], None] | None = None) -> Any:
    """Run one OPERATOR op (the user's door, POST /api/orgs/{slug}/ops) as one
    row transaction. No caller node row, no halt gate and no receipts: the
    operator is the user, `org_op` never had that prologue, and the user must
    be able to act on a halted agent or a latched org (that is how they are
    released). The target rows come from `LOCKS[op]`."""
    base = spec if spec is not None else _resolve(op, slug, body, a)
    org, result = _run(slug, _norm(base),
                       lambda org, held: fn(OpTx(org=org, op=op, body=body,
                                                 args=a, spec=held)))
    if on_commit is not None:
        on_commit(org)
    return result
