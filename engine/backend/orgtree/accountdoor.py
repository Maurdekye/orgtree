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
    # audience to their superior as mail)
    rcdoor.require(tx.spec, request_scope_rows(tx.org, tx.node))
    return tx.org.request_scope(tx.node, tx.args.get("items") or [],
                                tx.args.get("reason"))


def declare_all() -> None:
    pgdoor.declare("orgtree_request_scope", request_scope_spec,
                   body=_request_scope_body)


declare_all()
