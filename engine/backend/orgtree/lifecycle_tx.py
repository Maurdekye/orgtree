"""PG-3a: topology and lifecycle writers on row transactions (PYPG-PLAN §3).

Each writer here is the legacy `ledger.Org` method it names, run inside ONE
`halt.txn` (the transition fence, then `orgtx.org_tx`) that locks exactly the
rows the method reads for its decision or writes. The ledger methods keep
their behaviour; what changes is which rows are locked around them.

`SPECS` is this family's lock declaration, one entry per operation, in the
shape WS3a's door takes (`LOCKS[tool_or_op] -> TxSpec`). A writer whose
declaration misses a row it writes fails at commit with `orgtx.UnlockedWrite`
and writes NOTHING — the tests pin each spec against that.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from . import halt, store
from .ledger import USER, LedgerError


@dataclass(frozen=True)
class Spec:
    """The rows one operation locks. Node ids are filled in per call."""
    sections: tuple[str, ...] = ()
    share_sections: tuple[str, ...] = ()
    logs: tuple[Any, ...] = ()
    notes: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


SPECS: dict[str, Spec] = {
    # №31: the ledger said live, the session cannot resume. Writes the node's
    # state, a typed notice into its parent's box (`notices` + `notice_log`)
    # and the event row. The parent id is read from the node's own row; the
    # parent row itself is only tested for existence, never decided on.
    "mark_unrecoverable": Spec(sections=("notices",),
                               logs=("events", "notice_log"),
                               notes="nodes=[nid]"),
    # §4.5 move / promote / demote. Node rows come from `_move_rows`: the
    # moved node, its lineage stack and whole subtree (the stack is
    # reparented, the subtree's scope is clamped by `_sweep_dirs`), both
    # credit legs (release up to the LCA, acquire down to the new parent),
    # and the NEW PARENT FOR UPDATE even when no credit moves — it is the row
    # the children cap is decided on, and a hire under the same parent locks
    # it too, so the two cap checks can never both pass (RT7). Decided-on
    # only: every ancestor chain (authority, depth, LCA) FOR SHARE. Written
    # sections: the audience sweep and the notices; decided-on sections: the
    # three caps.
    "move": Spec(sections=("audiences", "notices"),
                 share_sections=("max_children", "max_depth", "max_top_grant"),
                 logs=("events", "notice_log"),
                 notes="nodes/share_nodes = _move_rows(org, actor, nid, new_parent)"),
}


class Widen(Exception):
    """The rows a body needs, computed on the LOCKED document, are not all
    held: roll back, add them and run again (WS3a's `pgdoor.Widen` contract;
    translated to it when the body runs on the door)."""

    def __init__(self, nodes=(), share_nodes=()):
        super().__init__(f"widen: nodes={sorted(nodes)} share={sorted(share_nodes)}")
        self.nodes, self.share_nodes = set(nodes), set(share_nodes)


MAX_WIDEN = 3


def _anc(org, nid: str | None) -> set[str]:
    if nid is None or nid not in org.nodes:
        return set()
    return {a for a in org.ancestors(nid) if a != USER and a in org.nodes}


def _move_rows(org, actor: str, nid: str, new_parent: str | None
               ) -> tuple[set[str], set[str]]:
    """(FOR UPDATE, FOR SHARE) node rows `Org.move(actor, nid, new_parent)`
    reads for its decision or writes, computed on `org`. Conservative: a row
    it names that the move ends up not touching costs a lock, never a bug."""
    n = org.nodes.get(nid)
    if n is None:
        return {nid}, set()
    tgt = None if new_parent in (None, USER) else new_parent
    if tgt is not None and tgt not in org.nodes:
        return {nid}, set()           # the move refuses; nothing to lock beyond
    p_old = n["parent"]
    moved = {nid, *org.lineage_stack(nid)}
    upd = set(moved)
    for m in moved:
        upd |= set(org.descendants(m, live_only=False))
    try:
        lca = org._lca(p_old, tgt)
        upd |= set(org._chain_up(p_old, lca))
        if tgt is not None:
            upd |= set(org._path_down(lca if lca is not None else USER, tgt))
    except (LedgerError, KeyError):
        pass                          # a broken chain refuses inside the move
    if tgt is not None:
        upd.add(tgt)
    share = _anc(org, nid) | _anc(org, tgt) | _anc(org, p_old)
    if actor in org.nodes:
        share.add(actor)
    for k in list(upd):
        share |= _anc(org, k)
    return upd, share - upd


def _need(org, rows: Callable[[Any], tuple[set[str], set[str]]],
          held_nodes, held_share) -> None:
    upd, share = rows(org)
    miss_u = upd - set(held_nodes)
    miss_s = share - set(held_nodes) - set(held_share)
    if miss_u or miss_s:
        raise Widen(miss_u, miss_s)


def move_body(org, held_nodes, held_share, actor: str, nid: str,
              new_parent: str | None) -> dict[str, Any]:
    """The door body: a pure function of the locked `org`."""
    _need(org, lambda o: _move_rows(o, actor, nid, new_parent),
          held_nodes, held_share)
    return org.move(actor, nid, new_parent)


def _run(op: str, slug: str, rows: Callable[[Any], tuple[set[str], set[str]]],
         body: Callable[[Any, Any, Any], Any]) -> Any:
    """Standalone runner (no door): spec from a snapshot, one halt.txn, and
    re-run on `Widen` with the missing rows merged in."""
    s = SPECS[op]
    upd, share = rows(store.cached_org(slug))
    for _ in range(MAX_WIDEN + 1):
        try:
            with halt.txn(slug, nodes=upd, share_nodes=share - upd,
                          sections=s.sections, share_sections=s.share_sections,
                          logs=s.logs) as tx:
                return body(tx.org, tx.lock_nodes, tx.share_nodes)
        except Widen as w:
            upd |= w.nodes
            share |= w.share_nodes
    raise LedgerError(f"{op}: the lock set kept growing after {MAX_WIDEN} "
                      "widenings — nothing was applied; retry")


def move(slug: str, actor: str, nid: str, new_parent: str | None) -> dict[str, Any]:
    return _run("move", slug, lambda o: _move_rows(o, actor, nid, new_parent),
                lambda org, hn, hs: move_body(org, hn, hs, actor, nid, new_parent))


def _txn(op: str, slug: str, nodes: list[str], share_nodes: list[str] = ()):
    s = SPECS[op]
    return halt.txn(slug, nodes=nodes, share_nodes=share_nodes,
                    sections=s.sections, share_sections=s.share_sections,
                    logs=s.logs)


def mark_unrecoverable(slug: str, nid: str, reason: str) -> bool:
    """Mark `nid` unrecoverable. Runtime-internal (no actor, no receipt).
    False when the node no longer exists."""
    with _txn("mark_unrecoverable", slug, [nid]) as tx:
        if nid not in tx.org.nodes:
            return False
        tx.org.mark_unrecoverable(nid, reason)
        return True
