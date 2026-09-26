"""accountdoor — fence-off S7's agent tools on the door (pgdoor): the tools that
still ran inside api.agent_call's DOC_LOCK cycle and belong to the account
and scope family (S7-LOCK-PLAN.md §3, reviewed by p01 2026-09-26 13:39Z).

  REQUEST_SCOPE (`Org.request_scope`, ledger.py) decides on the caller's
  own row (`scope`, `parent`, liveness: held FOR UPDATE by the door's
  prologue), `headless` and `audiences` (FOR SHARE: a settings or audience
  writer takes them FOR UPDATE). It then writes ONE of two things:
  · ROUTED (a parent and no user audience): the request mail to the parent,
    `mailtx.send_rows(parent)`. The parent is planned from the snapshot and
    re-derived from the locked document (`rcdoor.require` widens if the
    caller moved in between);
  · otherwise: the `scope_requests` row (a new `sr…` entry, or the one
    pending entry amended) and the `events` log.
  Nothing when everything asked for is already held. No IO. The routed
  drive to the parent is `_agent_door`'s generic routed step, as in the
  cycle. Not kiosk-exempt: the door's kiosk-cap check replaces the cycle's.

  ACCOUNT_ASSIGN (`supervisor.assign_account` on the door's org, landing
  L2): the target seat and the `target@<gen>` row a provider-crossing
  rebind archives into (FOR UPDATE), `supervisor._ASSIGN_SECTIONS`
  (asks/credit_requests/scope_requests mooted, notices folded, work_items
  rewritten by the docket reconcile), `_ASSIGN_SHARE` (kiosk, sandbox) and
  `_ASSIGN_LOGS` — the row set `account_removal._lock_spec` and
  `_agent_door`'s `_account_selection` already hold — plus the target's
  ancestor chain up to the caller FOR SHARE (`is_ancestor`). The chain and
  the generation are re-derived under the lock (`rcdoor.require`: a moved
  parent or a split in between widens and re-runs). After the commit, in
  `_agent_door`'s order: the transcript export (file IO, never under the
  row locks — lead decision 41), the account notify, the unpark and thaw
  wakes. Not kiosk-exempt.
"""
from __future__ import annotations

from typing import Any

from . import pgdoor, rcdoor
from .ledger import USER

SCOPE_SECTIONS = ("scope_requests",)
SCOPE_SHARE = ("headless", "audiences")
SCOPE_LOGS = ("events",)


def _routes(org: Any, nid: str) -> str | None:
    """The superior a request from `nid` routes to, or None when it files a
    `scope_requests` row — `Org.request_scope`'s own condition."""
    n = org.nodes.get(nid)
    if n is None or n.get("parent") is None or org._has_audience(nid, USER):
        return None
    return str(n["parent"])


def request_scope_rows(org: Any, nid: str) -> pgdoor.TxSpec:
    base = rcdoor._spec(sections=SCOPE_SECTIONS, share_sections=SCOPE_SHARE,
                        logs=SCOPE_LOGS)
    sup = _routes(org, nid)
    return base if sup is None else rcdoor.union(base, rcdoor._mail(sup))


def request_scope_spec(snapshot: Any, body: Any, a: dict[str, Any]
                       ) -> pgdoor.TxSpec:
    return request_scope_rows(snapshot, body.node)


def _request_scope_body(tx: Any) -> Any:
    # the orgtree_request_scope branch of api.agent_call, unchanged (FR-13:
    # user-only grantor; the ledger routes deep agents without a user
    # audience to their superior as mail). The re-check is belt-and-braces
    # (p01's L1 review): a changed routing writes the new parent's mail rows,
    # which PG-0's UnlockedWrite would also widen; this widens first, before
    # anything is written.
    rcdoor.require(tx.spec, request_scope_rows(tx.org, tx.node))
    return tx.org.request_scope(tx.node, tx.args.get("items") or [],
                                tx.args.get("reason"))


def account_assign_rows(org: Any, actor: str, target: str) -> pgdoor.TxSpec:
    from . import supervisor
    n = org.nodes.get(target)
    gen = int(n.get("generation") or 0) if n is not None else 0
    chain = tuple(x for x in rcdoor.chain(org, target, actor) if x != target)
    return rcdoor._spec(nodes=(target, f"{target}@{gen}") if target else (),
                        sections=supervisor._ASSIGN_SECTIONS,
                        share_nodes=chain,
                        share_sections=supervisor._ASSIGN_SHARE,
                        logs=supervisor._ASSIGN_LOGS)


def account_assign_spec(snapshot: Any, body: Any, a: dict[str, Any]
                        ) -> pgdoor.TxSpec:
    return account_assign_rows(snapshot, body.node, str(a.get("node") or ""))


def _account_assign_body(tx: Any) -> Any:
    # the orgtree_account_assign branch of api.agent_call, unchanged:
    # multi-account D2d node authority (strictly downward — a node cannot
    # rebind ITSELF); every check about the ACCOUNT lives in the shared
    # validator (`assign_account`)
    from fastapi import HTTPException
    from . import supervisor
    target = str(tx.args.get("node") or "")
    if not target:
        raise HTTPException(422, "node is required")
    if target == tx.node:
        raise HTTPException(
            403, "you cannot reassign your own account — a "
                 "node's billing is its supervisors' and the "
                 "user's decision, never its own")
    rcdoor.require(tx.spec, account_assign_rows(tx.org, tx.node, target))
    if not tx.org.is_ancestor(tx.node, target):
        raise HTTPException(
            403, f"you can only reassign accounts of your "
                 f"subordinates ({target!r} is not one)")
    slug = tx.call.org
    try:
        result = supervisor.assign_account(
            slug, target, str(tx.args.get("account") or ""),
            actor=tx.node, org=tx.org, doc_held=True, notify_change=False,
            export=False)
    except (RuntimeError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
    old_sid = result.pop("_export_old_sid", None)
    org = tx.org
    # after the commit, in `_agent_door`'s `_account_selection` order; each
    # step's failure is a warning on the committed result, never a raise
    if old_sid:
        def account_export(_res: Any, _s: str = str(old_sid)) -> None:
            supervisor.export_after_commit(slug, org, target, _s,
                                           "account_assign")
        tx.after.then.append(account_export)

    def account_notify(_res: Any) -> None:
        supervisor.notify(slug, target, "account")
    tx.after.then.append(account_notify)
    if result.get("unparked"):
        def account_unpark(_res: Any) -> None:
            supervisor.drive_account_unpark(slug, target)
        tx.after.then.append(account_unpark)
    if result.get("auth_thawed"):
        def auth_thaw(_res: Any) -> None:
            supervisor.drive_auth_thaw(slug, target)
        tx.after.then.append(auth_thaw)
    return result


def declare_all() -> None:
    pgdoor.declare("orgtree_request_scope", request_scope_spec,
                   body=_request_scope_body)
    pgdoor.declare("orgtree_account_assign", account_assign_spec,
                   body=_account_assign_body)


declare_all()
