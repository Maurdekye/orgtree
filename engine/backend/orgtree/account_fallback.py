"""Opt-in account reassignment after a limit, using fresh profile-local evidence.

Provider reads happen off DOC_LOCK. A plan is revalidated inside the existing
resume transaction, so replay and the permanent binding change commit together.
"""
from __future__ import annotations

import copy
import math
import os
import re
import threading
import time
from typing import Any

from . import codex_limits, codex_route, limits, providers, registry, subproxy

SCAN_INTERVAL = 300.0
PLAN_AGE = 30.0
_scan_lock = threading.Lock()
_scanned: dict[tuple[str, str], tuple[str, float]] = {}


def pools(provider: str, tier: str, pool: str) -> list[str]:
    if provider == "claude":
        return [tier]
    return ["openai:" + p for p in pool.split("+") if p in ("reserve", "plan")]


def marked(row: dict[str, Any], tier: str, pool: str) -> bool:
    keys = pools(row["provider"], tier, pool)
    return not keys or all(registry.active_mark(row["id"], k) for k in keys)


def record_limit(node: dict[str, Any], account: str, pool: str,
                 until: float, observed: bool) -> None:
    """Codex errors name a login digest; marks name its registered profile."""
    bound = str(node.get("account") or "")
    if not bound:
        return
    try:
        row = registry.get_account(bound)
        if row["provider"] != "openai":
            return
        digest, lane = codex_limits._account_namespace(row["credential"]["path"])
        if lane != "subscription" or digest != account:
            return
        for key in pools("openai", str(node.get("model") or ""), pool):
            registry.record_mark(bound, key, until,
                                 provenance="observed" if observed else "inferred")
    except (KeyError, OSError, ValueError):
        return


def available(board: dict[str, Any], provider: str, tier: str,
              pool: str, now: float) -> bool:
    if not board.get("available") or board.get("error"):
        return False
    rows = board.get("limits")
    if not isinstance(rows, list):
        return False
    def clear(windows: list[dict[str, Any]]) -> bool:
        if not windows:
            return False
        for w in windows:
            value = w.get("percent")
            if isinstance(value, bool) or not isinstance(value, (float, int)):
                return False
            if not math.isfinite(value) or not 0 <= value < 100:
                return False
            reset = limits._iso_to_epoch(w.get("resets_at"))
            if reset is None or reset <= now:
                return False
            if w.get("is_active"):
                return False
        return True
    if provider == "claude":
        selected = [w for w in rows if isinstance(w, dict)
                    and w.get("kind") in ("session", "weekly_all", "weekly_scoped")
                    and limits.lane_applies(w, tier)]
        kinds = {w.get("kind") for w in selected}
        # A session-only board cannot establish the weekly pool's capacity.
        weekly = "weekly_scoped" if tier == "fable" else "weekly_all"
        return "session" in kinds and weekly in kinds and clear(selected)
    if provider == "openai":
        if board.get("lane") != "subscription":
            return False
        plan = [w for w in rows if isinstance(w, dict) and codex_route.pool_of_window(w) == codex_route.PLAN_POOL]
        reserve = [w for w in rows if isinstance(w, dict)
                   and codex_route.pool_of_window(w) == codex_route.RESERVE_POOL]
        return ((pool in ("plan", "reserve+plan") and clear(plan))
                or (pool in ("reserve", "reserve+plan") and clear(reserve)))
    return False


def capacity(row: dict[str, Any], board: dict[str, Any], tier: str, pool: str) -> bool:
    choices = pool.split("+") if row["provider"] == "openai" else [pool]
    return any(not marked(row, tier, choice)
               and available(board, row["provider"], tier, choice, time.time())
               for choice in choices)


def source_matches(node: dict[str, Any]) -> bool:
    """An old freeze must not move an account the operator assigned afterward."""
    provider = providers.provider_of(str(node.get("model") or ""))
    frozen_account = str((node.get("frozen") or {}).get("account") or "")
    bound = str(node.get("account") or "")
    if not frozen_account:
        return False
    if not bound:
        return (frozen_account == "primary" if provider == "claude" else
                frozen_account == codex_limits._account_namespace()[0])
    try:
        row = registry.get_account(bound)
        if row["credential"]["kind"] not in ("managed", "imported"):
            return False
        if frozen_account == bound or registry.resolve_alias(frozen_account) == bound:
            return True
        return (provider == "openai" and frozen_account ==
                codex_limits._account_namespace(row["credential"]["path"])[0])
    except (ValueError, KeyError, OSError):
        return False


def read_board(row: dict[str, Any]) -> dict[str, Any]:
    cred = row["credential"]
    if row["provider"] == "openai":
        before = codex_limits._account_namespace(cred["path"])
        data = codex_limits.fetch_for_home(cred["path"], f'acct:{row["id"]}', force=True)
        after = codex_limits._account_namespace(cred["path"])
        return data if (before == after and after[1] == "subscription"
                        and data.get("account") == after[0]) else {}
    before = time.time()
    token = subproxy.profile_access_token(cred["path"])
    data = limits.fetch_for_token(token, f'acct:{row["id"]}', force=True)
    _, age = limits.account_readout(row["id"])
    # A failed read may return stale bars for display; those are not evidence
    # for an automatic move, even if the old bars looked healthy.
    return data if time.time() - age >= before else {}


def eligible(org: Any, nid: str) -> bool:
    from . import supervisor
    n = org.node(nid)
    if not org.account_fallback_for(nid) or n.get("pending_switch"):
        return False
    fz = supervisor._resumable(n)
    st = supervisor.state(org.d["slug"], nid)
    return bool(org.account_fallback_for(nid) and fz and fz.get("limit")
                and not fz.get("untrusted") and not fz.get("on_fallback")
                and not fz.get("cause") and source_matches(n)
                and not re.search(r"per[-_ ](?:minute|second)|requests? per (?:minute|second)|\b(?:tpm|rpm)\b",
                                  str(fz.get("error") or ""), re.I)
                and not n.get("remote_controlled")
                and not n.get("bearer_state") and not n.get("inflight")
                and not st.get("busy") and not st.get("responding")
                and not org.d.get("spend_frozen") and not org.d.get("headless")
                and not supervisor.sbx.is_sandboxed(org)
                and not (providers.provider_of(str(n.get("model") or "")) == "claude"
                         and supervisor.bills_the_key(org, bool(fz.get("on_fallback"))))
                and providers.provider_of(str(n.get("model") or "")) in ("claude", "openai"))


def identity(node: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy({k: node.get(k) for k in
                          ("account", "model", "generation", "session_id", "frozen")})


def candidates(org: Any) -> dict[str, dict[str, Any]]:
    """One off-lock scan of frozen, opted-in nodes, independent of auto-resume."""
    plans: dict[str, dict[str, Any]] = {}
    boards: dict[str, tuple[dict[str, Any], float]] = {}
    slug = org.d["slug"]
    for nid, n in org.nodes.items():
        if n.get("state") != "live" or not eligible(org, nid):
            continue
        fz = n["frozen"]
        stamp = str(fz.get("at") or "")
        with _scan_lock:
            prior, at = _scanned.get((slug, nid), ("", 0.0))
            if prior == stamp and time.time() - at < SCAN_INTERVAL:
                continue
            _scanned[(slug, nid)] = (stamp, time.time())
        tier = str(n.get("model") or "")
        provider = providers.provider_of(tier)
        pool = str(fz.get("resource_pool") or ("plan" if provider == "openai" else tier))
        current = str(n.get("account") or "")
        # Old unbound nodes use the ambient profile; never choose that profile
        # again under a new registry name after its own limit.
        ambient = (os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
                   if provider == "openai" else os.path.dirname(subproxy.CREDS))
        for row in registry.list_accounts(org=slug):
            cred = row.get("credential") or {}
            if (row["id"] == current or row["provider"] != provider
                    or cred.get("kind") not in ("managed", "imported")
                    or row.get("auth") == "unauthenticated"
                    or (not current and os.path.normcase(os.path.abspath(cred["path"]))
                        == os.path.normcase(os.path.abspath(ambient)))
                    or marked(row, tier, pool)):
                continue
            try:
                if row["id"] not in boards:
                    boards[row["id"]] = (read_board(row), time.time())
                board, observed_at = boards[row["id"]]
                if not capacity(row, board, tier, pool):
                    continue
            except (OSError, ValueError, RuntimeError, KeyError):
                boards[row["id"]] = ({}, time.time())
                continue
            plans[nid] = {"node": identity(n), "row": copy.deepcopy(row),
                          "board": board, "pool": pool, "at": observed_at}
            break
    return plans


def apply(org: Any, nid: str, plan: dict[str, Any]) -> bool:
    """Called only within resume_frozen's DOC_LOCK transaction; no remote IO."""
    from . import supervisor
    n = org.node(nid)
    if (identity(n) != plan["node"] or not eligible(org, nid)
            or time.time() - plan["at"] > PLAN_AGE):
        return False
    try:
        row = registry.validate_binding(org.d["slug"], n["model"], plan["row"]["id"])
        if (row["credential"] != plan["row"]["credential"]
                or row.get("identity") != plan["row"].get("identity")
                or row.get("auth") == "unauthenticated"
                or (row["provider"] == "openai" and
                    codex_limits._account_namespace(row["credential"]["path"]) !=
                    (plan["board"].get("account"), "subscription"))
                or marked(row, n["model"], plan["pool"])
                or not capacity(row, plan["board"], n["model"], plan["pool"])):
            return False
    except (ValueError, RuntimeError, KeyError):
        return False
    supervisor.assign_account(org.d["slug"], nid, row["id"], actor="@system",
                              org=org, via="limit_fallback")
    return True
