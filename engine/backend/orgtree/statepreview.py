"""Bounded, read-only projections and dry-run ledger transitions.

This module deliberately works only with an isolated JSON round-trip of an
``Org`` document.  It never loads a store, touches a session, sends mail, or
calls a provider.  The API layer performs the ordinary actor and visibility
checks before returning these projections.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from typing import Any, cast

from . import providers
from .ledger import LedgerError, Org, USER, actor_kind


# Fields whose values can contain credentials, prompt text, or session data.
_PRIVATE_KEYS = frozenset({
    "account", "api_key", "credentials", "external_handles", "inflight",
    "mail", "mail_log", "user_inbox", "user_mail_log", "org_inbox",
    "resume_texts", "resume_views", "halt_sources", "session_id",
    "transcript", "charter", "team_charter", "token", "secret",
})


def _visible_ids(org: Org, actor: str, include_archived: bool = False) -> list[str]:
    """Return the actor's structure-visible node ids, in tree order."""
    if actor_kind(actor) in ("user", "system"):
        ids = org.children(None, live_only=not include_archived)
        out: list[str] = []
        for root in ids:
            out.append(root)
            out.extend(org.descendants(root, live_only=not include_archived))
        return out
    n = org.node(actor)
    vis = str((n.get("scope") or {}).get("org_visibility") or "team")
    if vis == "self":
        ids = [actor]
    elif vis == "team":
        parent = n.get("parent")
        ids = [actor, *org.children(parent, live_only=not include_archived)]
        ids = list(dict.fromkeys(ids))
    elif vis == "subtree":
        ids = [actor, *org.descendants(actor, live_only=not include_archived)]
    else:
        ids = _visible_ids(org, USER, include_archived)
    if not include_archived:
        ids = [k for k in ids if org.node(k).get("state") == "live"]
    return list(dict.fromkeys(ids))


def _safe_node(org: Org, nid: str) -> dict[str, Any]:
    n = org.node(nid)
    scope = n.get("scope") or {}
    frozen = n.get("frozen")
    pending = n.get("pending_switch")
    status = n.get("last_status")
    row: dict[str, Any] = {
        "id": nid,
        "title": str(n.get("title") or nid),
        "state": n.get("state"),
        "parent": n.get("parent"),
        "generation": int(n.get("generation") or 0),
        "model": n.get("model"),
        "provider": providers.provider_of(str(n.get("model") or "")),
        "grant": n.get("grant"),
        "seat_cost": org.seat_cost(nid),
        "free": org.free(nid) if n.get("state") == "live" else None,
        "archived_at": n.get("archived_at"),
        "bearer_state": n.get("bearer_state"),
        # Account identity is operational state, but the registry id can be a
        # credential-bearing handle. Expose only the non-secret binding facts.
        "account_binding": {
            "present": bool(n.get("account")),
            "missing": str(n.get("account") or "").startswith("missing:"),
            "provider": providers.provider_of(str(n.get("model") or "")),
        },
        "scope": {
            "org_visibility": scope.get("org_visibility"),
            "permission_mode": scope.get("permission_mode"),
            "tools": {
                key: bool(scope.get("tools", {}).get(key, True))
                for key in ("bash", "web", "edit", "subagents")
            },
            "mcp": list(scope.get("tools", {}).get("mcp") or []),
        },
    }
    if isinstance(frozen, Mapping):
        row["frozen"] = {
            key: frozen[key] for key in ("provider", "cause", "pool", "until_ts")
            if key in frozen
        }
    else:
        row["frozen"] = None
    if isinstance(pending, Mapping):
        row["pending_switch"] = {
            key: pending[key] for key in ("from", "tier", "crossing", "at")
            if key in pending
        }
    else:
        row["pending_switch"] = None
    if isinstance(status, Mapping):
        row["last_status"] = {
            key: status[key] for key in ("status", "at") if key in status
        }
    else:
        row["last_status"] = None
    return row


def inspect_state(org: Org, actor: str, targets: list[str] | None = None,
                  include_archived: bool = False) -> dict[str, Any]:
    """Project only state axes visible to ``actor``.

    A requested target is checked against the same visibility boundary as the
    returned set.  Thus an agent cannot use this diagnostic as a side channel
    for a peer, archived session, mailbox, or credential.
    """
    if actor_kind(actor) not in ("user", "system"):
        org.node(actor)
    visible = _visible_ids(org, actor, include_archived)
    wanted = [str(x) for x in (targets or []) if str(x)]
    if wanted:
        hidden = [x for x in wanted if x not in visible]
        if hidden:
            raise LedgerError(
                f"state inspection is outside your visible scope: {hidden[0]}")
        ids = wanted
    else:
        ids = visible
    return {
        "actor": actor,
        "visibility": ("full" if actor_kind(actor) in ("user", "system")
                       else (org.node(actor).get("scope") or {}).get(
                           "org_visibility", "team")),
        "nodes": [_safe_node(org, nid) for nid in ids],
    }


def isolated(org: Org) -> Org:
    """Construct a detached ledger from JSON data, never a live object copy."""
    doc = cast(Any, json.loads(json.dumps(org.d)))
    return Org(doc)


def _safe_result(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(k): _safe_result(v) for k, v in value.items()
            if str(k).lower() not in _PRIVATE_KEYS
        }
    if isinstance(value, list):
        return [_safe_result(v) for v in value[:200]]
    if isinstance(value, tuple):
        return [_safe_result(v) for v in value[:200]]
    return value


def _diff(before: Any, after: Any, path: str = "") -> list[dict[str, Any]]:
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        keys = sorted(set(before) | set(after), key=str)
        out: list[dict[str, Any]] = []
        for key in keys:
            child = f"{path}.{key}" if path else str(key)
            if key not in before:
                out.append({"path": child, "before": None, "after": after[key]})
            elif key not in after:
                out.append({"path": child, "before": before[key], "after": None})
            else:
                out.extend(_diff(before[key], after[key], child))
        return out
    if isinstance(before, list) and isinstance(after, list):
        out = []
        for i in range(max(len(before), len(after))):
            child = f"{path}[{i}]"
            if i >= len(before):
                out.append({"path": child, "before": None, "after": after[i]})
            elif i >= len(after):
                out.append({"path": child, "before": before[i], "after": None})
            else:
                out.extend(_diff(before[i], after[i], child))
        return out
    return [] if before == after else [{"path": path, "before": before, "after": after}]


def _apply(org: Org, actor: str, operation: str, args: Mapping[str, Any]) -> dict[str, Any]:
    op = operation.removeprefix("orgtree_")
    target = str(args.get("node") or "")
    if op == "reallocate":
        return org.reallocate(actor, target, float(args.get("delta", 0)))
    if op == "move":
        if isinstance(args.get("moves"), list):
            moves = [(str(m.get("node") or ""), m.get("new_parent", m.get("parent")))
                     for m in args["moves"] if isinstance(m, Mapping)]
            return org.move_batch(actor, moves)
        return org.move(actor, target, args.get("new_parent", args.get("parent")))
    if op == "move_batch":
        raw = args.get("moves")
        if not isinstance(raw, list):
            raise LedgerError("move_batch needs a moves list")
        moves = [(str(m.get("node") or ""), m.get("new_parent", m.get("parent")))
                 for m in raw if isinstance(m, Mapping)]
        return org.move_batch(actor, moves)
    if op in ("swap", "swap_seats"):
        return org.swap_seats(actor, str(args.get("a") or ""),
                              str(args.get("b") or ""))
    if op in ("self_subjugate", "subjugate"):
        return org.subjugate(actor, actor, str(args.get("target") or ""))
    if op in ("retool", "set_scope"):
        fields = {key: args[key] for key in (
            "add_dirs", "tools", "org_visibility", "permission_mode", "charter",
            "team_charter", "effort", "model_version", "auto_cheap_compact",
            "external_handles", "raise_ceiling", "account_fallback",
            "clear_account_fallback", "clear_prefer_reserve", "prefer_reserve")
                  if key in args}
        return org.set_scope(actor, target, **fields)
    if op == "retire":
        return org.retire(actor, target)
    if op == "dissolve":
        return org.dissolve(actor, target)
    if op == "delete":
        return org.delete(actor, target)
    if op == "rescind":
        return org.rescind(actor, target)
    if op == "promote":
        return org.promote(actor, target, args.get("new_parent"))
    if op == "demote":
        return org.demote(actor, target, str(args.get("new_parent") or ""))
    if op == "reseed":
        return org.reseed(actor, target, uuid.uuid4().hex)
    if op == "revoke_dir":
        return org.revoke_dir(actor, target, str(args.get("dir") or ""))
    if op == "switch_model":
        return org.switch_model(actor, target, str(args.get("tier") or ""),
                                busy=False, account=args.get("account"))
    if op == "audience":
        action = str(args.get("action") or "")
        if action == "grant":
            return org.audience_grant(actor, str(args.get("from") or ""),
                                      args.get("target"))
        if action == "revoke":
            return org.audience_revoke(actor, str(args.get("grantee") or ""))
        raise LedgerError("preview supports audience grant or revoke only")
    raise LedgerError(f"preview does not support {operation!r}")


def preview(org: Org, actor: str, operation: str, args: Mapping[str, Any],
            include_archived: bool = False) -> dict[str, Any]:
    """Run one supported ledger operation on an isolated document."""
    if not operation:
        raise LedgerError("preview needs an operation")
    before = inspect_state(org, actor, include_archived=include_archived)
    shadow = isolated(org)
    result = _apply(shadow, actor, operation, args)
    after = inspect_state(shadow, actor, include_archived=include_archived)
    return {
        "operation": operation,
        "applied": False,
        "result": _safe_result(result),
        "before": before,
        "after": after,
        "changes": _diff(before, after),
    }
