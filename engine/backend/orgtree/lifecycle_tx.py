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

import contextlib
from typing import Iterator

from . import halt, store
from .ledger import NODE_KEYED_SECTIONS, USER, LedgerError, slugify


@dataclass(frozen=True)
class Spec:
    """The rows one operation locks. Node ids are filled in per call."""
    sections: tuple[str, ...] = ()
    share_sections: tuple[str, ...] = ()
    logs: tuple[Any, ...] = ()
    notes: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


# `work_items` too: `store._save_org` runs `reconcile_attention` whenever
# `asks` was touched, and mooting a question attached to a docket item
# rewrites that item's attention fields — a cross-family write (PG-3c's
# section) inside the archive's one transaction, PYPG-PLAN §3.3.
_ARCHIVE_SECTIONS = ("asks", "credit_requests", "notices", "scope_requests",
                     "work_items")

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
    # retire / dissolve / rescind. Node rows from `_archive_rows`: the node and
    # everything that goes with it (`_taken_with`: subtree + lineage stacks to
    # a fixpoint) FOR UPDATE, because retire auto-dissolves when the node has
    # live reports, and the children it decides on are exactly the rows a
    # hire under it would lock; rescind adds the PARENT (its grant is clawed
    # back, and `free(parent)` decides how much). Written sections: the
    # request queues `_moot_asks` resolves, and the notices.
    "retire": Spec(sections=_ARCHIVE_SECTIONS, logs=("events", "notice_log"),
                   notes="nodes/share_nodes = _archive_rows(org, actor, nid)"),
    "dissolve": Spec(sections=_ARCHIVE_SECTIONS, logs=("events", "notice_log"),
                     notes="nodes/share_nodes = _archive_rows(org, actor, nid)"),
    "rescind": Spec(sections=_ARCHIVE_SECTIONS, logs=("events", "notice_log"),
                    notes="nodes/share_nodes = _archive_rows(org, actor, nid, parent=True)"),
    # rehire. Node rows from `_rehire_rows`: the node, EVERY ancestor FOR
    # UPDATE (an archived chain above is rehired first, top-most first, and
    # `_chain_acquire` inflates grants up the paying path), the actor (a node
    # rehiring its own bearer becomes its parent and pays), and the re-seed
    # branch's rows (the new `nid@gen` bearer and the successor it notifies).
    # Sections: notices; watchdogs (archive-paused dogs re-arm); fable_lock
    # (a user fable rehire clears it). Decided-on: the settings a hire reads
    # (WS3a's staffdoor HIRE_SETTINGS, less fable_lock which is written).
    "rehire": Spec(sections=("fable_lock", "notices", "watchdogs"),
                   share_sections=("cascade_hire", "default_account",
                                   "default_effort", "default_tools",
                                   "default_top_grant", "default_visibility",
                                   "dirs", "kiosk", "max_children", "max_depth",
                                   "max_top_grant", "permission_mode", "slug",
                                   "tiers"),
                   logs=("events", "notice_log"),
                   notes="nodes = _rehire_rows(org, actor, nid)"),
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


def _archive_rows(org, actor: str, nid: str, parent: bool = False
                  ) -> tuple[set[str], set[str]]:
    """(FOR UPDATE, FOR SHARE) node rows of retire / dissolve / rescind."""
    n = org.nodes.get(nid)
    if n is None:
        return {nid}, set()
    upd = {nid, *org._taken_with(nid)}
    if parent and n["parent"] is not None and n["parent"] in org.nodes:
        upd.add(n["parent"])
    share = set()
    if actor in org.nodes:
        share.add(actor)
    for k in list(upd):
        share |= _anc(org, k)
    return upd, share - upd


def _archive_op(op: str, parent: bool = False):
    def body(org, held_nodes, held_share, actor: str, nid: str) -> dict[str, Any]:
        _need(org, lambda o: _archive_rows(o, actor, nid, parent),
              held_nodes, held_share)
        return getattr(org, op)(actor, nid)

    def run(slug: str, actor: str, nid: str) -> dict[str, Any]:
        return _run(op, slug, lambda o: _archive_rows(o, actor, nid, parent),
                    lambda org, hn, hs: body(org, hn, hs, actor, nid))
    body.__name__, run.__name__ = f"{op}_body", op
    return body, run


retire_body, retire = _archive_op("retire")
dissolve_body, dissolve = _archive_op("dissolve")
rescind_body, rescind = _archive_op("rescind", parent=True)


# ---------------------------------------------------------------- rename
# §rename (user ruling 2026-08-05; lead decisions 14 + 18.6). The identity
# rename re-keys the WHOLE document around a seat, so its row set is derived
# from the census the ledger itself re-keys by (`NODE_KEYED_SECTIONS`, class
# `rekey`) rather than written out by hand: a new per-node section the census
# learns about is locked here without anyone touching this file.
#   nodes FOR UPDATE: the stack (`nid`, `nid@g…`), the new ids (inserted), and
#     every node whose parent / predecessor / successor names the stack (its
#     pointer is rewritten);
#   nodes FOR SHARE: the ancestor chain (authority) and the actor;
#   sections: every `rekey` doc section, plus `orphan_keys` (a freed target's
#     leftover rows are set aside, never overwritten);
#   logs: every `rekey` log section — a dict log by name AND by the old and new
#     owner rows it moves — plus `events` / `notice_log`.


def _rename_plan(org, actor: str, nid: str, new_name: str
                 ) -> tuple[set[str], set[str], tuple[str, ...], tuple[Any, ...]]:
    n = org.nodes.get(nid)
    if n is None:
        return {nid}, set(), (), ()
    stack = [nid] + [k for k in org.nodes if k.startswith(nid + "@")]
    new = slugify(new_name)
    renamed = {k: new + k[len(nid):] for k in stack}
    upd = set(stack) | set(renamed.values())
    for k, v in org.nodes.items():
        if any(v.get(f) in renamed for f in ("parent", "predecessor", "successor")):
            upd.add(k)
    share = set()
    if actor in org.nodes:
        share.add(actor)
    share |= _anc(org, nid)
    sections: list[str] = ["orphan_keys"]
    logs: list[Any] = ["events", "notice_log"]
    owners = [*renamed, *renamed.values()]
    for key, (cls, _shape, _) in NODE_KEYED_SECTIONS.items():
        if cls != "rekey" or key == "nodes":
            continue
        if key in store.DICT_LOGS:
            logs.append(key)
            logs.extend((key, o) for o in owners)
        elif key in store.LIST_LOGS:
            logs.append(key)
        else:
            sections.append(key)
    return upd, share - upd, tuple(sorted(set(sections))), tuple(logs)


def rename_rows(slug: str, actor: str, nid: str, new_name: str):
    """The first-attempt plan, from the unlocked snapshot:
    (nodes, share_nodes, sections, logs)."""
    return _rename_plan(store.cached_org(slug), actor, nid, new_name)


@contextlib.contextmanager
def rename_tx(slug: str, plan) -> Iterator[Any]:
    """ONE attempt: a transaction on `plan` (from `rename_rows`, widened by
    the caller on `Widen`). The body must call `check_rename_rows(tx, …)`
    FIRST — before any side effect — so a stale snapshot re-runs instead of
    writing unlocked rows. Joins a transaction the caller already holds on
    this org (lead decision 14: callers that hold the lock call rename
    re-entrantly) — `halt.txn`'s join, which refuses a gap."""
    upd, share, sections, logs = plan
    with halt.txn(slug, nodes=upd, share_nodes=share, sections=sections,
                  logs=logs) as tx:
        yield tx


def widen_plan(plan, w: "Widen"):
    upd, share, sections, logs = plan
    return upd | w.nodes, share | w.share_nodes, sections, logs


def check_rename_rows(tx, actor: str, nid: str, new_name: str) -> None:
    """Re-derive the rename's rows on the LOCKED document; Widen if the
    snapshot missed any (a hire under the node, a new generation)."""
    upd, share, _s, _l = _rename_plan(tx.org, actor, nid, new_name)
    miss_u = upd - set(tx.lock_nodes)
    miss_s = share - set(tx.lock_nodes) - set(tx.share_nodes)
    if miss_u or miss_s:
        raise Widen(miss_u, miss_s)


def _rehire_rows(org, actor: str, nid: str) -> tuple[set[str], set[str]]:
    """(FOR UPDATE, FOR SHARE) node rows of `Org.rehire(actor, nid, ...)`."""
    n = org.nodes.get(nid)
    if n is None:
        return {nid}, set()
    upd = {nid} | _anc(org, nid)
    if actor in org.nodes:
        upd.add(actor)
    upd.add(f"{nid}@{n.get('generation', 0)}")      # a re-seed's new bearer
    succ = n.get("successor")
    if succ and succ in org.nodes:
        upd.add(succ)
    for k in [k for k in upd if k in org.nodes]:
        upd |= _anc(org, k)
    return upd, set()


def rehire_body(org, held_nodes, held_share, actor: str, nid: str,
                grant: float | None = None, tier: str | None = None,
                raise_ceiling: bool = False) -> dict[str, Any]:
    _need(org, lambda o: _rehire_rows(o, actor, nid), held_nodes, held_share)
    return org.rehire(actor, nid, grant=grant, tier=tier,
                      raise_ceiling=raise_ceiling)


def rehire(slug: str, actor: str, nid: str, grant: float | None = None,
           tier: str | None = None, raise_ceiling: bool = False) -> dict[str, Any]:
    return _run("rehire", slug, lambda o: _rehire_rows(o, actor, nid),
                lambda org, hn, hs: rehire_body(org, hn, hs, actor, nid, grant,
                                                tier, raise_ceiling))


# ---------------------------------------------------------------- delete
# §delete (USER only). Like rename, the row set is derived from the census
# (`NODE_KEYED_SECTIONS`, every section whose `on_delete` is `purged` or
# `marked`) so a new per-node record the census learns about is locked here
# without touching this file.
#   nodes FOR UPDATE: `_taken_with(nid)` — the subtree and every lineage stack
#     to a fixpoint (all popped; `bg_open` on any of them refuses);
#   nodes FOR SHARE: the PARENT and every ancestor. The parent's children are
#     the peers notified, and a hire under the parent locks it FOR UPDATE, so
#     the peer list cannot change under the delete;
#   sections: every purged/marked doc section, the notices, and the two
#     banked-cost keys;
#   logs: every purged dict log by name AND by each doomed owner row, every
#     purged/marked list log by name, plus `events` / `notice_log`.


def _delete_plan(org, actor: str, nid: str
                 ) -> tuple[set[str], set[str], tuple[str, ...], tuple[Any, ...]]:
    sections = {"notices", "deleted_cost_usd", "deleted_cost_usd_unknown"}
    logs: set[Any] = {"events", "notice_log"}
    n = org.nodes.get(nid)
    doomed = set(org._taken_with(nid)) if n is not None else {nid}
    for key, (_cls, _shape, on_delete) in NODE_KEYED_SECTIONS.items():
        if on_delete not in ("purged", "marked") or key == "nodes":
            continue
        if key in store.DICT_LOGS:
            logs.add(key)
            logs |= {(key, k) for k in doomed}
        elif key in store.LIST_LOGS:
            logs.add(key)
        else:
            sections.add(key)
    share: set[str] = set()
    if n is not None:
        parent = n["parent"]
        if parent is not None and parent in org.nodes:
            share.add(parent)
        share |= _anc(org, nid)
        if actor in org.nodes:
            share.add(actor)
    return (doomed, share - doomed, tuple(sorted(sections)),
            tuple(sorted(logs, key=lambda x: (isinstance(x, tuple), str(x)))))


def delete_body(tx, actor: str, nid: str) -> dict[str, Any]:
    """The door body: re-derive the plan on the LOCKED document (Widen on a
    gap — a hire under the subtree, a new generation), then the legacy
    method."""
    upd, share, _s, _l = _delete_plan(tx.org, actor, nid)
    miss_u = upd - set(tx.lock_nodes)
    miss_s = share - set(tx.lock_nodes) - set(tx.share_nodes)
    if miss_u or miss_s:
        raise Widen(miss_u, miss_s)
    return tx.org.delete(actor, nid)


def delete(slug: str, actor: str, nid: str) -> dict[str, Any]:
    """Standalone runner: plan from a snapshot, one halt.txn, re-run on Widen."""
    upd, share, sections, logs = _delete_plan(store.cached_org(slug), actor, nid)
    for _ in range(MAX_WIDEN + 1):
        try:
            with halt.txn(slug, nodes=upd, share_nodes=share - upd,
                          sections=sections, logs=logs) as tx:
                return delete_body(tx, actor, nid)
        except Widen as w:
            upd |= w.nodes
            share |= w.share_nodes
    raise LedgerError(f"delete: the lock set kept growing after {MAX_WIDEN} "
                      "widenings — nothing was applied; retry")
