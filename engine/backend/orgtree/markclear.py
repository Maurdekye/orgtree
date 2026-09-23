"""Manual capacity-mark clearing — the one seam the agent tool and the UI share.

User item add-agent-tool-and-ui-to-clear-account-limit-mar (rulings
2026-09-23): a mark can outlive the limit it recorded and hold agents frozen
until somebody edits the live registry by hand. This module lets an agent or
the user READ an account's stored marks with their freshness, and CLEAR one
exact mark by compare-and-set.

Two stores hold marks, and both are covered because both hold agents:

  · the account registry (`registry.clear_mark`) — every bound spawn, per
    pool, with provenance and observation time;
  · the old roster `accounts.json` (`accounts.clear_limit`) — unbound agents
    on the default Claude login, per tier, with neither.

Each store's clear and its audit row are ONE file write in that store. A
clear never touches the other store, never adds capacity, and never resumes,
starts or switches an agent — resuming stays a separate act.

Authority (user ruling): ANY agent may clear any mark on an account its org
can see. An org-key row restricted to another org is not visible and is
refused exactly like an id that does not exist.
"""
from __future__ import annotations

import time
from typing import Any

from . import accounts, registry
from .registry_migration import observe_ambient

REGISTRY = "registry"
ROSTER = "legacy-roster"
SOURCES = (REGISTRY, ROSTER)


class UnknownMarkAccount(LookupError):
    """No visible account answers to this name. Deliberately the same refusal
    for a hidden other-org row, so its existence is not disclosed."""


def _unknown(name: str) -> UnknownMarkAccount:
    return UnknownMarkAccount(f"no account {name!r} is visible here")


def _visible(org: str | None) -> list[dict[str, Any]]:
    return registry.list_accounts(org)


def _roster_id(row: dict[str, Any], primary: str) -> str:
    """Which old-roster account this registry row is, or '' for none: the
    ambient Claude row is the roster's `primary`, a migrated key row is its
    token_ref."""
    if row.get("provider") != "claude":
        return ""
    if row["id"] == primary:
        return accounts.PRIMARY
    cred = row.get("credential") or {}
    ref = str(cred.get("token_ref") or "")
    if cred.get("kind") == "token" and ref and not ref.startswith("org-api-key:"):
        return ref
    return ""


def _roster_keys() -> set[str]:
    return {accounts.PRIMARY} | {str(k["id"]) for k in accounts.load()["keys"]}


def inspect(selector: str, *, org: str | None,
            now: float | None = None) -> dict[str, Any]:
    """Every stored mark on one account, from both stores, with freshness.

    `selector` is a registry id, a canonical name (`claude/primary`), the
    bare `primary`, or an old-roster key id. Each mark entry carries the
    exact `account` and `source` a clear must name, and the `expected`
    fingerprint it must present back."""
    now = time.time() if now is None else now
    want = str(selector or "").strip()
    if not want:
        raise _unknown(want)
    if want == accounts.PRIMARY:
        want = registry.primary_name("claude")
    primary = registry.resolve_alias("primary")
    ambient = observe_ambient()
    from . import accountusage
    row = next((r for r in _visible(org)
                if r["id"] == want
                or accountusage.canonical_name(r, primary, ambient) == want), None)
    roster = ""
    if row is not None:
        roster = _roster_id(row, primary)
    elif want == registry.primary_name("claude"):
        roster = accounts.PRIMARY     # the default login may have no row yet
    elif want in _roster_keys():
        roster = want
        row = next((r for r in _visible(org) if _roster_id(r, primary) == want),
                   None)
    if row is None and not roster:
        raise _unknown(selector)
    marks: list[dict[str, Any]] = []
    if row is not None:
        marks += [{**m, "account": row["id"]}
                  for m in registry.describe_marks(row["id"], now)]
    if roster and roster in _roster_keys():
        marks += [{**m, "account": roster}
                  for m in accounts.describe_limits(roster, now)]
    name = (accountusage.canonical_name(row, primary, ambient)
            if row is not None else registry.primary_name("claude"))
    return {"account": row["id"] if row is not None else "",
            "name": name,
            "provider": row["provider"] if row is not None else "claude",
            "roster_account": roster or None,
            "marks": marks,
            "note": ("Clearing a mark adds no capacity and resumes no agent; "
                     "if the provider still refuses, the account is marked "
                     "again.")}


def frozen_on_account(org_d: dict[str, Any], ids: set[str]) -> list[str]:
    """This org's live agents whose freeze names one of these accounts — a
    read-only hint after a manual clear, which resumes none of them.

    RAW WALK, like `supervisor._stamp_wakes_on_save`: the barriered node view
    would mark every node dirty and re-serialize the whole table on the save
    that follows, for a read."""
    from .supervisor import freeze_account_of     # noqa: PLC0415 — heavy module
    nodes = org_d.get("nodes") or {}
    out = []
    for nid in list(dict.keys(nodes)):
        n = dict.__getitem__(nodes, nid)
        fz = n.get("frozen") if isinstance(n, dict) else None
        if (isinstance(fz, dict) and n.get("state") == "live"
                and freeze_account_of(fz, n) in ids):
            out.append(str(nid))
    return sorted(out)


def clear(account: str, pool: str, expected: Any, *, source: str,
          org: str | None, actor: str, via: str, reason: str = "",
          companion_expected: Any = None,
          now: float | None = None) -> dict[str, Any]:
    """Clear ONE mark in ONE store if it is still exactly `expected`.

    Results: `cleared`, or `changed` / `missing` / `expired` with nothing
    written. Unknown and hidden accounts raise `UnknownMarkAccount`; a bad
    pool, source or alias raises `ValueError`."""
    account = str(account or "").strip()
    if source not in SOURCES:
        raise ValueError(f"source must be one of {', '.join(SOURCES)}")
    if not isinstance(expected, dict):
        raise ValueError("expected must be the `expected` object inspect returned")
    if source == ROSTER:
        if account not in _roster_keys():
            raise _unknown(account)
        try:
            return accounts.clear_limit(
                account, pool, expected, actor=actor, via=via,
                org=org or "", reason=reason, now=now)
        except KeyError:
            raise _unknown(account) from None
    visible = {r["id"] for r in _visible(org)}
    if account not in visible:
        resolved = registry.resolve_alias(account)
        if resolved != account and resolved in visible:
            raise registry.MarkClearRefused(
                f"{account!r} is an alias of {resolved!r}; a clear takes the "
                f"exact account id that inspect returned")
        raise _unknown(account)
    try:
        return registry.clear_mark(
            account, pool, expected, actor=actor, via=via, org=org or "",
            reason=reason, companion_expected=companion_expected, now=now)
    except registry.UnknownAccount:
        raise _unknown(account) from None
