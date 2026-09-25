"""Removing a secondary account by REBINDING its agents to the provider's
primary account — one coordinated operation (user ticket 2026-09-21).

WHY THIS EXISTS. `registry.remove_account` is raw, and the API door above it
used to REFUSE while any node was bound to the row ("reassign them explicitly
first"). That made the remove control unusable: the operator had to walk every
org, find every binding — including the ones on ARCHIVED nodes, which no UI
lists — and move each one by hand before the button would do anything. This
module is the door's new body: it finds every stored binding to the account,
moves them all to that provider's primary, and only then removes the row.

WHAT IT IS NOT. It is not a second rebind writer. Every LIVE node goes through
`supervisor.assign_account`, the one writer both existing doors call, so the
session-boundary rules, the account-park clear, the auth/credential thaw, the
warm-pool identity record and the org audit log all happen exactly as they do
for a hand-made reassignment. Only the stores `assign_account` cannot reach are
touched directly here:

  · ARCHIVED nodes — `assign_account` requires a live node, and an archived one
    cannot run, so there is no session, no freeze and no wake to consider. But
    its binding is NOT inert: `ledger.rehire` does not touch `account`, so a
    knowledge bearer rehired after the row was removed would come back bound to
    an account that no longer exists. The binding is moved in place.
  · QUEUED intents — `pending_account` and `pending_switch.account` name an
    account that has not been applied yet. Left alone they would resolve, at
    the next turn boundary, against a row that is gone.
  · `default_account` — the org-level default for new hires.

ATOMICITY (ticket: "must not leave a partial result"). Three phases, in this
order, and the order is the guarantee:

  1. PLAN — every org is read (a lock-free `orgtx.org_read`) and every
     affected node is checked, including a real `registry.validate_selection`
     against the primary selector each node would move to. Nothing is
     mutated. Any blocker refuses the whole call.
  2. MIGRATE — ONE `orgtx.org_tx_multi` over every affected org (PYPG plan
     decision 13, replacing DOC_LOCK's fleet-wide reach). It locks exactly the
     bound seats, each live seat's `nid@<gen>` archive row, `default_account`
     and what `supervisor.assign_account` writes; the plan is re-run on the
     locked rows, and the whole transaction restarts if a binding moved to a
     seat it did not lock. A failure here rolls every org back.
  3. COMMIT — the transaction commits (on PostgreSQL every org at once), the
     fleet is re-read for a binding that appeared in an org the transaction
     did not lock, and only then is the registry row removed, LAST.

So the one genuinely broken state — the account gone while a binding still
names it — cannot happen: the row is removed only after every binding has been
migrated AND persisted. The residual risk is the reverse and benign: if an org
save fails after an earlier one succeeded, the account is RETAINED and some
agents are already on primary, which is a working state and an idempotent
retry away from finished. That case raises, says which orgs moved, and never
reports success.

THE IN-FLIGHT TURN (ticket: "define and test the boundary"). A node that is
mid-turn is handled by what its provider's rules allow, never by interrupting
it:

  · No session boundary required (a Claude-lane rebind on a node with no codex
    thread) — the binding moves NOW. The running process is never repointed: it
    keeps the credential its spawn resolved, and its usage attribution was
    captured at spawn from the resolved env's marker, not from org state. The
    NEXT turn resolves the primary binding. That is the boundary.
  · Session boundary required (an openai/google row, an openai/google tier, or
    a live codex thread) — the rebind owes an in-place session archive, and
    doing that to a running turn would corrupt its own bookkeeping. There is no
    safe half-measure: queueing it would mean removing the row while the node's
    stored binding still named it. So the whole removal is REFUSED, naming the
    agents and saying that it succeeds once their turns end.
"""
from __future__ import annotations

import os
from typing import Any

from . import orgtx, providers, registry, store

#: Providers whose account rebind is a SESSION boundary (codexrun §3.4:
#: CODEX_HOME is never repointed live). Same set `assign_account` uses.
SESSION_BOUNDARY_PROVIDERS = ("openai", "google")


class RemovalRefused(RuntimeError):
    """The removal cannot be carried out safely. NOTHING was changed: every
    refusal is raised from the plan phase, before any mutation."""


class _PlanMoved(RuntimeError):
    """Inside the transaction a binding sat on a row the plan did not lock:
    roll back and plan again."""


class RemovalIncomplete(RuntimeError):
    """A save failed after an earlier org had already been persisted. The
    ACCOUNT WAS NOT REMOVED — the row is still registered — and the message
    says which orgs were migrated, so a retry finishes the rest."""


# --------------------------------------------------------------- enumeration
def org_slugs() -> list[str]:
    """Every org slug on this machine, by the SAME enumeration the removal
    guard's evidence (`api._account_bindings`) uses — filename stems under the
    orgs directory, JSON and SQLite alike, premigration files excluded.

    Deliberately not `store.list_orgs()`: that parses every document to build
    summary rows, and a document it fails to summarize is simply absent from
    its answer. Here an org we cannot enumerate must be visible as a slug so
    the load below can refuse, rather than silently reading as "binds
    nothing"."""
    try:
        names = sorted(os.listdir(store._orgs_dir()))
    except OSError:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for f in names:
        slug = f[:-5] if f.endswith(".json") else (
            f[:-len(store.db_ext())] if f.endswith(store.db_ext()) else "")
        if not slug or slug in seen or f.endswith(".premigration"):
            continue
        seen.add(slug)
        out.append(slug)
    return out


def is_primary_row(row: dict[str, Any]) -> bool:
    """Whether this registry row IS a provider's primary (ambient) account —
    the one every surface calls `default` and submits as `provider/primary`.

    Decided by `accountusage.ambient_covered`, the same rule the account list,
    the usage modal and the turn envelope decide it by, so no surface can call
    a row `default` while this one treats it as a removable secondary."""
    from . import accountusage
    from .registry_migration import observe_ambient
    return accountusage.ambient_covered(
        row, registry.resolve_alias("primary"), observe_ambient())


def needs_session_boundary(node: dict[str, Any],
                           removed: dict[str, Any]) -> bool:
    """Whether rebinding THIS node off THIS account owes an in-place session
    archive — field-for-field the condition `supervisor.assign_account` and
    `supervisor.finish_switch_binding` both apply."""
    tier = str(node.get("model") or "")
    return (removed["provider"] in SESSION_BOUNDARY_PROVIDERS
            or providers.provider_of(tier) in SESSION_BOUNDARY_PROVIDERS
            or bool(node.get("codex_thread")))


def _is_busy(slug: str, nid: str, node: dict[str, Any]) -> bool:
    """Whether a turn is in flight for this node. `inflight` is the DURABLE
    marker (it survives a backend death mid-turn); the volatile state carries
    the live flags. Same three the rebind door reads."""
    from . import supervisor
    try:
        st = supervisor.state(slug, nid)
    except Exception:                                        # noqa: BLE001
        st = {}
    return bool(st.get("busy") or st.get("responding") or node.get("inflight"))


def _limit_frozen(node: dict[str, Any]) -> bool:
    """A MOVABLE usage-limit freeze — the one kind `assign_account` refuses a
    bare rebind on. An auth/credential freeze and an account park both carry
    their own cause and are deliberately NOT this."""
    fz = node.get("frozen")
    if not isinstance(fz, dict):
        return False
    auth = fz.get("cause") in ("auth", "balance") or bool(fz.get("untrusted"))
    return bool(fz.get("limit")) and not auth and fz.get("cause") != "account"


# ---------------------------------------------------------------------- plan
def _plan_org(slug: str, org: Any, aid: str, removed: dict[str, Any],
              plan: dict[str, Any]) -> None:
    """Record everything in ONE org that names `aid`, and every reason the
    removal cannot proceed. Mutates nothing."""
    from . import sandbox as sbx
    sandboxed = False
    try:
        sandboxed = sbx.is_sandboxed(org)
    except Exception:                                        # noqa: BLE001
        sandboxed = False
    primary = registry.primary_name(removed["provider"])
    live: list[dict[str, Any]] = []
    archived: list[str] = []
    pending: list[dict[str, Any]] = []
    for nid, node in (org.d.get("nodes") or {}).items():
        if not isinstance(node, dict):
            continue
        nid = str(nid)
        if str(node.get("account") or "") == aid:
            if str(node.get("state") or "") == "live":
                if sandboxed:
                    # Migration binds no sandboxed node at all (the container
                    # owns the credential), so this is a document that should
                    # not exist — say so rather than rebinding into a refusal.
                    plan["blockers"].append(
                        f"{slug}/{nid} is in a sandboxed organization, where "
                        f"accounts do not apply — its binding must be "
                        f"cleared by hand")
                else:
                    boundary = needs_session_boundary(node, removed)
                    busy = _is_busy(slug, nid, node)
                    if busy and boundary:
                        plan["blockers"].append(
                            f"{slug}/{nid} is running a turn and its provider "
                            f"requires a session boundary to change accounts "
                            f"— removal will succeed once that turn ends")
                    else:
                        try:
                            registry.validate_selection(
                                slug, str(node.get("model") or ""), primary)
                        except Exception as e:               # noqa: BLE001
                            plan["blockers"].append(
                                f"{slug}/{nid} cannot be moved to {primary}: "
                                f"{e}")
                        else:
                            live.append({"node": nid, "busy": busy,
                                         "allow_frozen": _limit_frozen(node)})
            else:
                archived.append(nid)
        pa = node.get("pending_account")
        if isinstance(pa, dict) and str(pa.get("account") or "") == aid:
            pending.append({"node": nid, "field": "pending_account"})
        ps = node.get("pending_switch")
        if isinstance(ps, dict) and str(ps.get("account") or "") == aid:
            pending.append({"node": nid, "field": "pending_switch",
                            "tier": str(ps.get("tier") or "")})
    default_account = str(org.d.get("default_account") or "") == aid
    if live or archived or pending or default_account:
        plan["orgs"].append({
            "slug": slug, "org": org, "live": live, "archived": archived,
            "pending": pending, "default_account": default_account,
            "primary": primary})


#: What the migration writes besides the bound seats (PG-3f). `default_account`
#: is this module's own; the rest is `supervisor.assign_account`'s row set when
#: the caller owns the transaction (PG-3e-B `_ASSIGN_SECTIONS`/`_SHARE`/`_LOGS`,
#: unioned in below when present so the two can never drift apart).
_SECTIONS = ("default_account", "asks", "credit_requests", "scope_requests",
             "notices", "work_items")
_SHARE = ("kiosk", "sandbox")
_LOGS: tuple[orgtx.LogName, ...] = ("events", "notice_log")
#: how many times a plan that moved under the transaction is re-made
_ATTEMPTS = 4


def _lock_spec(entry: dict[str, Any]) -> dict[str, Any]:
    """One org's org_tx keywords for its plan entry."""
    from . import supervisor
    nodes: set[str] = set()
    for target in entry["live"]:
        nid = str(target["node"])
        gen = entry["org"].nodes[nid].get("generation", 0)
        nodes |= {nid, f"{nid}@{gen}"}
    nodes |= {str(n) for n in entry["archived"]}
    nodes |= {str(r["node"]) for r in entry["pending"]}
    sections = set(_SECTIONS) | set(getattr(supervisor, "_ASSIGN_SECTIONS", ()))
    share = (set(_SHARE) | set(getattr(supervisor, "_ASSIGN_SHARE", ()))) - sections
    logs = set(_LOGS) | set(getattr(supervisor, "_ASSIGN_LOGS", ()))
    return {"nodes": sorted(nodes), "sections": sorted(sections),
            "share_sections": sorted(share), "logs": sorted(logs, key=str)}


def plan_removal(account_id: str) -> dict[str, Any]:
    """Everything the removal would do, and every reason it must not. Reads
    the whole fleet lock-free (`orgtx.org_read`) and mutates nothing."""
    row = registry.get_account(account_id)      # raises UnknownAccount
    aid = str(row["id"])
    plan: dict[str, Any] = {"account": aid, "row": row, "orgs": [],
                            "blockers": []}
    if is_primary_row(row):
        plan["blockers"].append(
            f"account {aid} is the {row['provider']} primary account — the "
            f"primary is what every other account is moved BACK to, so it is "
            f"not removable")
        return plan
    for slug in org_slugs():
        try:
            org = orgtx.org_read(slug)
        except Exception as e:                               # noqa: BLE001
            # A document we cannot read is a document whose bindings we cannot
            # know. The old guard skipped it, which reads as "binds nothing";
            # here that would be a removal that strands a binding.
            plan["blockers"].append(
                f"organization {slug!r} could not be read, so whether it "
                f"binds this account is unknown: {e}")
            continue
        _plan_org(slug, org, aid, row, plan)
    return plan


def _blocker_message(account_id: str, blockers: list[str]) -> str:
    head = (f"account {account_id} cannot be removed yet — "
            f"{len(blockers)} blocker(s):")
    return head + "".join(f"\n  · {b}" for b in blockers[:12]) + (
        f"\n  · … and {len(blockers) - 12} more" if len(blockers) > 12 else "")


# ------------------------------------------------------------------- migrate
def _migrate_org(entry: dict[str, Any], actor: str) -> dict[str, Any]:
    """Apply one org's whole share of the migration IN MEMORY. The caller
    owns the save, so `assign_account` is handed this exact `Org`."""
    from . import supervisor
    slug, org, primary = entry["slug"], entry["org"], entry["primary"]
    moved: list[dict[str, Any]] = []
    wakes: list[tuple[str, str]] = []
    for target in entry["live"]:
        nid = str(target["node"])
        out = supervisor.assign_account(
            slug, nid, primary, actor=actor, org=org, via="account_removed",
            allow_frozen=bool(target["allow_frozen"]),
            immediate=bool(target["busy"]), notify_change=False)
        if out.get("unparked"):
            wakes.append(("unpark", nid))
        if out.get("auth_thawed"):
            wakes.append(("auth_thaw", nid))
        moved.append({"org": slug, "node": nid, "state": "live",
                      "in_flight_turn": bool(target["busy"])})
    # A session-boundary rebind archives the old session as a knowledge
    # bearer (`nid@<gen>`, a row the transaction locked), and the bearer
    # inherits the binding being removed. The plan predates it, so it is
    # moved here like any other archived binding — before PG-3f it kept
    # naming the removed row.
    for nid, node in (org.d.get("nodes") or {}).items():
        if (isinstance(node, dict) and node.get("state") != "live"
                and str(node.get("account") or "") == entry.get("account")
                and nid not in entry["archived"]):
            entry["archived"].append(str(nid))
    for nid in entry["archived"]:
        # No session, no freeze, no wake — an archived node cannot run. Only
        # the binding itself, so a rehire comes back on the primary account.
        node = org.d["nodes"][nid]
        node.pop("account", None)
        node["account_primary"] = True
        moved.append({"org": slug, "node": nid, "state": "archived",
                      "in_flight_turn": False})
    for rec in entry["pending"]:
        nid, field = str(rec["node"]), str(rec["field"])
        pend = org.d["nodes"][nid].get(field)
        if not isinstance(pend, dict):
            continue
        if field == "pending_switch":
            # The queued intent is "switch to TIER on this account". The tier
            # decides the provider, so the replacement is the TARGET's primary
            # — and a target with no account provider at all (OpenRouter) is a
            # switch that takes no binding, so the key is dropped.
            target = providers.provider_of(str(pend.get("tier") or ""))
            if target in registry.PROVIDERS:
                pend["account"] = registry.primary_name(target)
            else:
                pend.pop("account", None)
        else:
            pend["account"] = primary
        org._log("account_queue_rebound", actor,
                 {"node": nid, "field": field,
                  "removed_account": entry.get("account"),
                  "account": pend.get("account")}, [])
    if entry["default_account"]:
        org.d["default_account"] = primary
        org._log("account_default_rebound", actor,
                 {"account": primary}, [])
    return {"moved": moved, "wakes": wakes}


def remove_account_rebinding_agents(account_id: str, *,
                                    actor: str) -> dict[str, Any]:
    """THE coordinated operation: move every stored binding to this account
    onto the provider's primary, then remove the account.

    Raises `registry.UnknownAccount` for a row that is not registered,
    `RemovalRefused` when the plan finds anything that makes the operation
    unsafe (nothing is changed), and `RemovalIncomplete` when a save fails
    after an earlier org was persisted (the account is RETAINED)."""
    from . import apikey_accounts
    for _ in range(_ATTEMPTS):
        plan = plan_removal(account_id)
        aid = str(plan["account"])
        if plan["blockers"]:
            raise RemovalRefused(_blocker_message(aid, plan["blockers"]))
        try:
            results, wakes, saved = _migrate_in_one_tx(plan, actor)
        except _PlanMoved:
            continue
        # A binding made in an org the transaction did not lock (a hire or a
        # rebind that validated this account before we committed) would be
        # stranded by removing the row, so the fleet is read once more first.
        again = plan_removal(account_id)
        if again["orgs"] or again["blockers"]:
            where = ", ".join(sorted({str(e["slug"]) for e in again["orgs"]}))
            raise RemovalIncomplete(
                f"account {aid} was NOT removed: while it was being removed it "
                f"was bound again, or an organization became unreadable "
                f"({where or 'see the blockers'}). Every agent already moved is "
                f"on its provider's primary and working; retry the removal to "
                f"finish the rest.")
        row = plan["row"]
        if not registry.remove_account(aid):
            raise registry.UnknownAccount(aid)
        apikey_accounts.forget_credentials(row)
        return {"removed": aid, "rebound": results, "wakes": wakes,
                "orgs": saved}
    raise RemovalRefused(
        f"account {account_id} was not removed: its bindings kept changing "
        f"while the removal ran. Nothing was changed; try again.")


def _migrate_in_one_tx(plan: dict[str, Any], actor: str
                       ) -> tuple[list[dict[str, Any]],
                                  list[tuple[str, str, str]], list[str]]:
    """PHASES 2 and 3: migrate every affected org in ONE org_tx_multi.

    Raises `_PlanMoved` (rolled back) when a binding sits outside the locked
    rows; `RemovalRefused` when the re-made plan blocks, or when nothing could
    be saved; `RemovalIncomplete` when the SQLite fake had already committed
    an earlier org (it commits org by org — on PostgreSQL the orgs commit
    together, so there a failed commit changed nothing). An exception from
    the migration itself propagates unchanged, with everything rolled back."""
    aid = str(plan["account"])
    specs = {str(e["slug"]): _lock_spec(e) for e in plan["orgs"]}
    results: list[dict[str, Any]] = []
    wakes: list[tuple[str, str, str]] = []
    if not specs:
        return results, wakes, []
    txs: dict[str, orgtx.OrgTx] = {}
    body_started = body_done = False
    try:
        with orgtx.org_tx_multi(specs) as txs:
            body_started = True
            for slug in sorted(specs):
                fresh: dict[str, Any] = {"orgs": [], "blockers": []}
                _plan_org(slug, txs[slug].org, aid, plan["row"], fresh)
                if fresh["blockers"]:
                    raise RemovalRefused(
                        _blocker_message(aid, fresh["blockers"]))
                if not fresh["orgs"]:
                    continue
                entry = fresh["orgs"][0]
                if not set(_lock_spec(entry)["nodes"]) <= set(specs[slug]["nodes"]):
                    raise _PlanMoved(slug)
                entry["account"] = aid
                out = _migrate_org(entry, actor)
                results.extend(out["moved"])
                wakes.extend((slug, kind, nid) for kind, nid in out["wakes"])
            body_done = True
    except (RemovalRefused, _PlanMoved):
        raise
    except Exception as e:                                   # noqa: BLE001
        if not body_started:
            # opening the transaction failed (a lock timeout, a load): no
            # row was touched
            raise RemovalRefused(
                f"account {aid} was not removed: the organizations could not "
                f"be locked ({e}). Nothing was changed.") from e
        if not body_done:
            raise
        saved =sorted(sl for sl, t in txs.items() if t.committed is not None)
        failed = ", ".join(repr(sl) for sl in sorted(set(specs) - set(saved)))
        if saved:
            raise RemovalIncomplete(
                f"account {aid} was NOT removed: {', '.join(saved)} had "
                f"already been migrated and saved when {failed} failed to "
                f"save ({e}). Every agent already moved is on its provider's "
                f"primary and working; retry the removal to finish the "
                f"rest.") from e
        raise RemovalRefused(
            f"account {aid} was not removed: {failed} could not be saved "
            f"({e}). Nothing was changed.") from e
    return results, wakes, sorted(specs)


def announce(slug_wakes: list[tuple[str, str, str]],
             rebound: list[dict[str, Any]]) -> None:
    """The off-lock half: the freeze wakes a rebind cleared, and the account
    notification each moved live node owes its surfaces. Never raises — the
    document is already saved and the account is already gone, so a failed
    fanout must not read as a failed removal."""
    from . import supervisor
    for slug, kind, nid in slug_wakes:
        try:
            if kind == "unpark":
                supervisor.drive_account_unpark(slug, nid)
            else:
                supervisor.drive_auth_thaw(slug, nid)
        except Exception:                                    # noqa: BLE001
            pass
    for rec in rebound:
        if rec.get("state") != "live":
            continue
        try:
            supervisor.notify(str(rec["org"]), str(rec["node"]), "account")
        except Exception:                                    # noqa: BLE001
            pass
