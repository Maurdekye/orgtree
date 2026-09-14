"""Quick staff selection and validation, shared by the preview and commit doors."""
from __future__ import annotations

import copy
import time
from typing import Any

from . import accountusage, appsettings, codex_limits, codex_route, limits, providers, registry
from .ledger import LedgerError, Org, USER, app_prefer_reserve_default, slugify


def context(org: Org, wid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    item = org._work_find(wid)[0]
    if item.get("archived") or item.get("status") != "backlogged":
        raise LedgerError("Quick staff is available only for backlogged tickets. Reopen the menu.")
    owner = item.get("owner") or {}
    live, _ = org._work_owner_state(item)
    configured = appsettings.quick_staff_behavior()
    fallback = configured != "top_level" and not live
    mode = "top_level" if fallback else configured
    return item, {"mode": mode, "configured_mode": configured, "owner": owner,
                  "fallback": fallback,
                  "disclosure": ("Assignee unavailable — selected agent will be staffed immediately at top level. Choose a model."
                    if fallback else "Request staffing from the assignee."
                    if mode == "request" else "Staff immediately under the assignee. Choose a model."
                    if mode == "under_assignee" else "Staff immediately at top level. Choose a model.")}


def supported_efforts(tier: str) -> list[str]:
    if tier in providers.CODEX_TIERS:
        inventory = providers.codex_model_inventory()
        offered = inventory.get("efforts", {}).get(providers.CODEX_MODELS[tier], [])
        return [e for e in Org.EFFORTS if e in offered]
    if tier in providers.ANTIGRAVITY_TIERS:
        return [e for e in Org.EFFORTS if providers.antigravity_effort(tier, e) == e]
    if tier in providers.CLAUDE_TIERS:
        return list(Org.EFFORTS)
    return []  # No advertised effort contract for an OpenRouter favorite.


def staff_args(org: Org, item: dict[str, Any], ctx: dict[str, Any],
               tier: str, effort: str | None = None) -> dict[str, Any]:
    owner = ctx["owner"]
    node = org.nodes.get(str(owner.get("node") or ""))
    if node and (owner.get("deleted") or (owner.get("born") and
                    owner["born"] != node.get("seat_id")) or
                    (not owner.get("born") and int(node.get("generation") or 0) < int(owner.get("generation") or 0))):
        node = None
    top = ctx["mode"] == "top_level"
    base = slugify(str(item["title"]))[:80].rstrip("-")
    name, suffix = base, 2
    while name in org.nodes:
        name = f"{base}-{suffix}"
        suffix += 1
    args: dict[str, Any] = {
        "action": "update", "slug": item["slug"], "status": "open",
        "tier": tier, "name": name,
        "grant": int(org.d.get("default_top_grant", 50)) if top else 0,
        "charter": f"Own the docket item {item['slug']}: {item['title']}. Read its full description and complete its requirements. Keep the docket current.",
    }
    if not top:
        args["target"] = owner["node"]
    if node:
        scope = node["scope"]
        args.update({k: copy.deepcopy(scope[k]) for k in
                     ("add_dirs", "tools", "org_visibility", "permission_mode") if k in scope})
    if effort is not None:
        args["effort"] = effort
    return args


def check_choice(org: Org, item: dict[str, Any], ctx: dict[str, Any], tier: str) -> None:
    from .api import provider_hire_gate
    if tier not in org.d["tiers"]:
        raise LedgerError("That model is not available in this organization. Reopen Staff….")
    provider_hire_gate(org, tier)
    org._check_tier_ceiling(tier)
    reason = account_reason(org, tier)
    if reason:
        raise LedgerError(reason)
    if ctx["mode"] != "request":
        args = staff_args(org, item, ctx, tier)
        trial = Org(copy.deepcopy(org.d))
        result = trial.hire(USER, args.get("target"), tier, args["grant"], args["name"],
                            add_dirs=args.get("add_dirs"), tools=args.get("tools"),
                            org_visibility=args.get("org_visibility"), charter=args["charter"])
        if args.get("permission_mode"):
            trial.set_scope(USER, result["node"], permission_mode=args["permission_mode"])


def account_reason(org: Org, tier: str) -> str | None:
    """Use the ordinary default binding, and its cached account usage evidence.

    Unknown telemetry is reported as unknown, never treated as a zero reading.
    Local credential/admission gates still run in the normal hire operation.
    """
    provider = providers.provider_of(tier)
    if provider == "openrouter":
        return None
    selected = str(org.d.get("default_account") or "")
    row = None
    if selected:
        try:
            row = registry.validate_selection(org.d["slug"], tier, selected)
        except ValueError:
            # Ordinary hires fall back to the ambient account for an
            # incompatible organization default.
            row = None
    if row and row.get("id"):
        if row.get("auth") == "unauthenticated":
            return "Default provider account requires sign-in. Open Accounts."
        if registry.active_mark(row["id"], tier):
            return "Default provider account has reached its limit. Change the hire default account or wait for reset."
        if registry.account_mode(row) == "apikey":
            return None
        board = accountusage.view(row, allow_fetch=False)
    elif provider == "openai":
        board = codex_limits.snapshot(time.time())
    elif provider == "claude":
        board = limits.snapshot(time.time())
    else:
        from . import antigravity_limits
        board = antigravity_limits.snapshot(time.time())
    if not board.get("available") or board.get("stale"):
        return None
    windows = board.get("limits") or []
    def full(rows: list[dict[str, Any]]) -> bool:
        return any(isinstance(w.get("percent"), (int, float)) and w["percent"] >= 100 for w in rows)
    if provider == "openai":
        plan = [w for w in windows if codex_route.pool_of_window(w) == codex_route.PLAN_POOL]
        reserve = [w for w in windows if codex_route.pool_of_window(w) == codex_route.RESERVE_POOL]
        exhausted = full(plan) and (tier != codex_route.ROUTED_TIER or not app_prefer_reserve_default()
                                   or not reserve or full(reserve))
    elif provider == "claude":
        exhausted = full([w for w in windows if w.get("kind") in ("session", "weekly_all")
                          or (tier == "fable" and w.get("kind") == "weekly_scoped")])
    else:
        exhausted = full([w for w in windows if "gemini" in str(w.get("model") or "").lower()])
    return "Default provider account is at 100%. Change the hire default account or wait for reset." if exhausted else None


def preview(org: Org, wid: str) -> dict[str, Any]:
    item, result = context(org, wid)
    choices = []
    for tier, seat in org.d["tiers"].items():
        reason = None
        try:
            check_choice(org, item, result, tier)
        except (LedgerError, ValueError) as e:
            reason = str(e)
        choices.append({"tier": tier, "seat": seat, "reason": reason,
                        "efforts": supported_efforts(tier) if not reason else []})
    result["models"] = choices
    return result
