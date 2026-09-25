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
#     org_tx(slug, *, nodes=[...], sections=[...], share_sections=[...],
#            logs=[...]) -> Org
#
# that BEGINs, locks the named node/section rows (FOR UPDATE, or FOR SHARE for
# `share_sections`), yields the org with those rows loaded, and on a clean
# exit writes the changed rows, bumps the revision, NOTIFYs and COMMITs. An
# exception rolls everything back. `is_retryable(exc)` says whether a failure
# is worth re-running.

@dataclass
class _Seam:
    org_tx: Callable[..., Any] | None = None
    is_retryable: Callable[[BaseException], bool] = lambda _e: False


_SEAM = _Seam()


def use_org_tx(org_tx: Callable[..., Any] | None,
               is_retryable: Callable[[BaseException], bool] | None = None
               ) -> None:
    """Install the storage primitive (tests: a fake; production: pgstore's)."""
    _SEAM.org_tx = org_tx
    _SEAM.is_retryable = is_retryable or (lambda _e: False)


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


# ------------------------------------------------------------ the prologue

@dataclass
class AgentTx:
    """What a family body receives: the locked document and the call."""
    org: Any
    node: str
    args: dict[str, Any]


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


def rows(body: Any, a: dict[str, Any], *, nodes: Iterable[str] = (),
         sections: Iterable[str] = ()) -> dict[str, list[str]]:
    """The rows `agent_tx` locks, in lock order. Public so a family (and a
    reviewer) can see exactly what a call will hold."""
    ns = [body.node] + [n for n in dict.fromkeys(nodes) if n != body.node]
    secs = [s for s in dict.fromkeys(sections) if s != KILLSWITCH]
    if _receipted(body, a):
        for s in (opreceipts.SECTION, opreceipts.META):
            if s not in secs:
                secs.append(s)
    return {"nodes": ns, "sections": secs, "share_sections": [KILLSWITCH]}


def agent_tx(body: Any, a: dict[str, Any],
             fn: Callable[[AgentTx], Any], *,
             admit: Callable[[Any, Any, dict[str, Any]], dict[str, Any] | None],
             file: Callable[[Any, Any, dict[str, Any], dict[str, Any], Any],
                            None],
             nodes: Iterable[str] = (), sections: Iterable[str] = (),
             logs: Iterable[str] = (),
             on_commit: Callable[[Any, dict[str, Any] | None], None]
             | None = None) -> Any:
    """Run one agent tool as ONE row transaction with the shared prologue.

    `fn(tx)` is the family body; its return value is the tool result. A
    LedgerError from the gate or the body rolls the whole transaction back
    and propagates (the caller maps it to 422 exactly as `agent_call`'s cycle
    does). A replayed key returns the receipt's replay payload and runs
    nothing. `on_commit(org, receipt_ctx)` runs once, after the commit (with
    None when no receipt rode the call), never on a retry or a rollback —
    `opreceipts.witness` belongs there."""
    r = rows(body, a, nodes=nodes, sections=sections)
    logs = list(logs)
    attempt = 0
    while True:
        attempt += 1
        try:
            with _org_tx()(body.org, nodes=r["nodes"], sections=r["sections"],
                           share_sections=r["share_sections"],
                           logs=logs) as org:
                _gate(org, body.node)
                rcpt = admit(org, body, a)
                if rcpt is not None and "replay" in rcpt:
                    # nothing changed; the clean exit commits an empty tx
                    return rcpt["replay"]
                result = fn(AgentTx(org=org, node=body.node, args=a))
                if rcpt is not None:
                    # LAST write before commit: effect and receipt are one tx
                    file(org, body, a, rcpt, result)
        except BaseException as e:
            if attempt < MAX_ATTEMPTS and _SEAM.is_retryable(e):
                continue
            raise
        if on_commit is not None:
            on_commit(org, rcpt)
        return result
