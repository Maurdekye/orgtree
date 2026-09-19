"""Quick staff selection and validation, shared by the preview and commit doors."""
from __future__ import annotations

import copy
import pickle
import time
from typing import Any

from . import appsettings, openrouter, providers, registry, staffcache, store
from .ledger import LedgerError, Org, USER, slugify


class HireProbe:
    """A factory for the throwaway organizations `tier_block` trial-hires into.

    ⚠ THE DEFECT THIS EXISTS FOR (user report 2026-09-15, after beta.5): the
    `Staff…` menu still took seconds to open even though every network call had
    already been moved off the click. The remaining cost was not I/O at all.
    `tier_block` builds its trial organization with `copy.deepcopy(org.d)`, and
    on the SQLite backend a whole-document walk MATERIALISES every append-only
    log first. Measured on the operator's own organization (576 nodes, an 80 MB
    store): one such copy costs 978 ms, of which 17.5 MB is `steered_log`,
    15.6 MB is `mail_log` and 6.2 MB is `events` — none of which a hire reads.
    `tier_block` paid it once PER TIER, so opening the menu on this sixteen-tier
    organization spent **14.2 seconds** deep-copying chat history.

    So: serialise the hire-relevant sections ONCE, and rebuild an independent
    document per tier from the blob. `store.eager_sections` leaves the logs out
    without materialising them, and `pickle.loads` rebuilds in 22 ms. Measured
    again on the same organization afterwards: those sixteen tiers went from
    10,611 ms to 756 ms, with every verdict identical.

    THE TRIAL STILL SEES THE WHOLE LEDGER IT JUDGES BY. Nothing is pruned from
    `nodes`, `tiers`, `dirs`, the credit pools or any setting; only the
    append-only logs are absent, and a hire never reads one — it only APPENDS,
    through `store.log_append`, which creates the section on a plain document.

    AND PICKLE IS SAFE HERE FOR A REASON, not by luck: an org document is
    persisted as JSON, so every value in it is already a plain JSON type. A
    value that could not be pickled could not be SAVED either, and catching that
    here to fall back on a deep copy would hide a live persistence bug behind a
    slow menu. It is left to raise.
    """

    __slots__ = ("_blob",)

    def __init__(self, org: Org) -> None:
        self._blob = pickle.dumps(store.eager_sections(org.d),
                                  pickle.HIGHEST_PROTOCOL)

    def org(self) -> Org:
        """A fresh, independent organization to mutate and throw away."""
        return Org(pickle.loads(self._blob))


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


def supported_efforts(tier: str, snap: dict[str, Any] | None = None) -> list[str]:
    """The efforts this tier advertises, from the WARM snapshot.

    It used to be computed here, on the menu open, and for a Codex tier that
    meant `providers.codex_model_inventory()` — which can spawn the Codex CLI.
    The contract is unchanged; only where the work happens moved."""
    return staffcache.efforts(snap or staffcache.read(), tier)


def staff_args(org: Org, item: dict[str, Any], ctx: dict[str, Any],
               tier: str, effort: str | None = None,
               account: str | None = None) -> dict[str, Any]:
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
    if account:
        # org.hire has validated this field for as long as the account registry
        # has existed; quick staff simply never offered it. Omitted, the hire
        # makes its own ordinary default choice, exactly as before.
        args["account"] = account
    return args


def request_models(*, kiosk: bool = False,
                   snap: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Offer existing models, independently of the actor's ability to hire.

    Provider discovery owns machine-wide configuration/sign-in and offered
    hire tokens. Its OpenRouter rows are favorites, so they additionally need
    live catalog membership: a saved favorite alone is not availability.
    Discovery errors are errors, never an authoritative empty model list.

    ⚠ THE DISCOVERY IS READ FROM THE WARM SNAPSHOT, NOT PERFORMED HERE. This
    used to call `_providers_payload()` and `openrouter.refresh_catalog()` — a
    live HTTP GET to openrouter.ai — on the user's click, which is the loading
    defect of 2026-09-15. It asks exactly the same questions of exactly the same
    data; `staffcache` is what makes the answers already be there.
    """
    snap = snap if snap is not None else staffcache.read()
    document = snap["providers"]
    if not isinstance(document, dict) or not isinstance(document.get("providers"), list):
        raise LedgerError("Provider discovery returned no model list. Retry the menu.")
    choices = []
    for provider in document["providers"]:
        if (not isinstance(provider, dict) or not isinstance(provider.get("id"), str)
                or not isinstance(provider.get("hire_enabled"), bool)
                or not isinstance(provider.get("tiers"), list)):
            raise LedgerError("Provider discovery returned invalid model data. Retry the menu.")
        if kiosk and provider["id"] in ("openai", "google", openrouter.PROVIDER_ID):
            continue  # These providers are not admitted in kiosk organizations.
        if not provider["hire_enabled"]:
            continue
        for model in provider["tiers"]:
            if not isinstance(model, dict):
                raise LedgerError("Provider discovery returned an invalid model. Retry the menu.")
            tier = model.get("tier")
            if not isinstance(tier, str) or not tier.strip():
                continue  # A model without a hire token cannot be requested.
            if provider["id"] == openrouter.PROVIDER_ID:
                catalog = staffcache.catalog_ids(snap)
                if catalog is None:
                    # "Could not find out" is NOT an empty catalog. Offering a
                    # favorite that may have been delisted is worse than saying
                    # the list could not be verified.
                    raise LedgerError("Could not verify current OpenRouter models. Retry the menu.")
                if model.get("model") not in catalog:
                    continue
            choices.append({"tier": tier, "seat": model.get("seat"), "reason": None,
                            "efforts": supported_efforts(tier, snap)})
    return choices


def tier_block(org: Org, item: dict[str, Any], ctx: dict[str, Any],
               tier: str, probe: HireProbe | None = None) -> str | None:
    """Why this tier cannot be staffed AT ALL here, independent of any account.

    Split out of `check_choice` so the account question can be asked separately
    — the user's rule is that a tier is offered when ANY eligible account can
    run it, which is not a question this half can answer. These four are the
    refusals no account can rescue: the tier is not in the organization, its
    provider is not usable, the tier ceiling is reached, or the hire itself
    would be refused.

    `probe` is where the trial organization comes from (see `HireProbe`). A
    caller asking about MANY tiers builds ONE and hands it to every call — that
    is the whole of the post-beta.5 menu-loading fix, because the trial copy was
    costing a second per tier. Omitted, one is built here, so a single-tier
    caller behaves exactly as it always did.
    """
    from .api import provider_hire_gate
    try:
        if tier not in org.d["tiers"]:
            return "That model is not available in this organization. Reopen Staff…."
        provider_hire_gate(org, tier)
        org._check_tier_ceiling(tier)
        args = staff_args(org, item, ctx, tier)
        trial = (probe or HireProbe(org)).org()
        # ⚠ THE TRIAL NAMES A HARNESS SO IT NEVER ASKS FOR ONE. Left to
        # itself, `hire` chooses a new OpenRouter agent's harness by asking
        # whether the Codex CLI can run — which spawns one. This runs once per
        # TIER while the Staff… menu is built, and the menu is exactly the
        # thing the HireProbe exists to keep fast. Nothing here reads the
        # stamp: this hire is thrown away, and the four refusals it is looking
        # for do not depend on the harness, so naming the default asks the
        # same question for free. The real hire resolves the live answer at
        # the door (`api.new_hire_harness`). ⚠ ONLY for an OpenRouter tier —
        # `hire` refuses a harness on any other, because no other tier has one
        # to choose.
        from . import openrouter as _orr, openrouter_harness  # noqa: PLC0415
        _trial_harness = (openrouter_harness.DEFAULT
                          if _orr.is_tier(tier) else None)
        result = trial.hire(USER, args.get("target"), tier, args["grant"], args["name"],
                            add_dirs=args.get("add_dirs"), tools=args.get("tools"),
                            org_visibility=args.get("org_visibility"), charter=args["charter"],
                            harness=_trial_harness)
        if args.get("permission_mode"):
            trial.set_scope(USER, result["node"], permission_mode=args["permission_mode"])
    except (LedgerError, ValueError) as e:
        return str(e)
    return None


def catalog_order(snap: dict[str, Any]) -> dict[str, int]:
    """Where each tier sits in the model list the user already reads elsewhere.

    ⚠ THE ORDER IS NOT INVENTED HERE (user ruling 2026-09-15, after beta.5: the
    menu's "model order must match the model-switch list, grouped by provider
    and ordered by tier"). The model-switch dropdown renders the provider
    document's families in the document's own sequence — Claude, then Codex,
    then Antigravity, then the OpenRouter favorites, each family in the order
    the document lists it. So reading that document IS reading the model-switch
    list's ordering, and a second ordering table that could drift from it never
    has to exist.

    A tier the document does not list gets no position at all; the caller leaves
    those in the organization's own order, after every tier that has one.
    """
    order: dict[str, int] = {}
    document = snap.get("providers")
    if not isinstance(document, dict):
        return order
    for provider in document.get("providers") or []:
        if not isinstance(provider, dict):
            continue
        for model in provider.get("tiers") or []:
            if not isinstance(model, dict):
                continue
            tier = model.get("tier")
            if isinstance(tier, str) and tier and tier not in order:
                order[tier] = len(order)
    return order


def in_catalog_order(tiers: list[str], order: dict[str, int]) -> list[str]:
    """`tiers` re-sequenced into `catalog_order`, unlisted ones kept last.

    The sort is STABLE and the fallback key is one past the end, so anything the
    provider document does not name keeps the caller's own order and lands after
    everything it does name — never silently interleaved.
    """
    return sorted(tiers, key=lambda t: order.get(t, len(order)))


def eligible_accounts(org: Org, tier: str,
                      snap: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every account that can run this tier for this organization, right now.

    Ineligible accounts are ABSENT rather than disabled: the user's ruling is
    that a staffing surface offers only what can actually be staffed.
    """
    return staffcache.tier_accounts(snap if snap is not None else staffcache.read(),
                                    org, tier)


def account_reason(org: Org, tier: str,
                   snap: dict[str, Any] | None = None) -> str | None:
    """Why the account an UNQUALIFIED hire would choose cannot run this tier.

    That account is the organization's `default_account` when it is compatible
    and the provider's ambient login otherwise — the ledger's own fallback,
    mirrored here so the menu and the hire name the same account.

    ⚠ ITS JOB NARROWED (2026-09-15). This used to decide whether a tier was
    OFFERED, which is why every Claude tier greyed out when one Claude account
    filled up. Offering is now `eligible_accounts`; this decides only whether
    the TIER ROW ITSELF is directly clickable.
    """
    snap = snap if snap is not None else staffcache.read()
    provider = providers.provider_of(tier)
    if provider not in registry.PROVIDERS:
        return None
    row = None
    selected = str(org.d.get("default_account") or "").strip()
    if selected:
        try:
            resolved = registry.validate_selection(str(org.d.get("slug") or ""),
                                                   tier, selected)
        except ValueError:
            # Ordinary hires fall back to the ambient account for an
            # incompatible organization default.
            resolved = None
        if resolved and resolved.get("id"):
            row = staffcache.row_of(snap, resolved["id"])
            if row is None:
                return "Default provider account is no longer registered. Open Accounts."
    block = staffcache.account_block(snap, row, provider, tier)
    if block is None:
        return None
    if block == "requires sign-in":
        return "Default provider account requires sign-in. Open Accounts."
    if block == "has reached its limit":
        return ("Default provider account has reached its limit. Change the "
                "hire default account or wait for reset.")
    return ("Default provider account is at 100%. Change the hire default "
            "account or wait for reset.")


def check_choice(org: Org, item: dict[str, Any], ctx: dict[str, Any], tier: str,
                 request_offers: list[dict[str, Any]] | None = None,
                 account: str | None = None,
                 snap: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """THE eligibility rule, and the reason a menu and a commit cannot disagree.

    The menu calls it to decide what to show; the commit calls it again — over a
    snapshot it refuses to accept as stale — to decide whether the click still
    stands. One function, so "the same rules the actual staffing operation
    enforces" is a fact about the code rather than a promise about it.
    """
    if ctx["mode"] == "request":
        offers = request_offers if request_offers is not None else request_models(
            kiosk=bool(org.d.get("kiosk")), snap=snap)
        for model in offers:
            if model["tier"] == tier:
                return model
        raise LedgerError("That model is not currently offered for Request staffing. Reopen Staff….")
    blocked = tier_block(org, item, ctx, tier)
    if blocked:
        raise LedgerError(blocked)
    if not staffcache.tier_needs_account(tier):
        if account:
            raise LedgerError("That model runs on a routed key, not an account. Reopen Staff….")
        return None
    choices = eligible_accounts(org, tier, snap)
    if not choices:
        raise LedgerError("No signed-in account can run that model right now. "
                          "Open Accounts, or wait for a window to reset.")
    if account:
        if not any(c["value"] == account or c["id"] == account for c in choices):
            raise LedgerError("That account cannot run this model right now. Reopen Staff….")
        return None
    reason = account_reason(org, tier, snap)
    if reason:
        # The tier IS staffable — one of `choices` can run it — just not on the
        # account an unqualified hire would pick, so the caller must name one.
        raise LedgerError(reason + " Choose an account from the model's submenu.")
    return None


def preview(org: Org, wid: str,
            request_offers: list[dict[str, Any]] | None = None,
            snap: dict[str, Any] | None = None) -> dict[str, Any]:
    """The staffing choices for one ticket — ONLY the ones that can be staffed.

    ⚠ STRICT OMISSION (user ruling 2026-09-15). This used to emit every tier in
    the organization, each carrying a `reason` string, and the menu rendered the
    unstaffable ones as greyed rows: the list in image-118.png. A disabled row
    is still an offer, so they are gone from the payload entirely.
    """
    item, result = context(org, wid)
    snap = snap if snap is not None else staffcache.read()
    result["availability"] = {"at": snap["at"], "stale": bool(snap.get("stale")),
                              "errors": list(snap["errors"])}
    if result["mode"] == "request":
        result["models"] = (request_offers if request_offers is not None
                            else request_models(kiosk=bool(org.d.get("kiosk")), snap=snap))
        return result
    choices = []
    # ONE trial source for every tier (`HireProbe`) — this loop is where the
    # menu spent 14.2 measured seconds before, one full document deep-copy per
    # tier — and the organization's tiers walked in the order the model-switch
    # list shows them rather than the order the document happens to store them.
    probe = HireProbe(org)
    order = catalog_order(snap)
    for tier in in_catalog_order(list(org.d["tiers"]), order):
        if tier_block(org, item, result, tier, probe):
            continue                        # no account can rescue this one
        needs = staffcache.tier_needs_account(tier)
        accounts = eligible_accounts(org, tier, snap) if needs else []
        if needs and not accounts:
            continue                        # nothing signed in can run it
        choices.append({"tier": tier, "seat": org.d["tiers"][tier], "reason": None,
                        "efforts": supported_efforts(tier, snap),
                        "accounts": accounts,
                        "default_ok": _default_ok(org, tier, snap, needs)})
    result["models"] = choices
    return result


def _default_ok(org: Org, tier: str, snap: dict[str, Any], needs: bool) -> bool:
    """Whether the tier row itself is directly clickable.

    Guarded, because this decides a MENU AFFORDANCE and nothing more: a refusal
    that cannot be computed must close the direct click and leave the account
    submenu standing, never take down the whole list the surface was about to
    render."""
    if not needs:
        return True
    try:
        return not account_reason(org, tier, snap)
    except (LedgerError, ValueError):
        return False


def availability(org: Org, snap: dict[str, Any] | None = None) -> dict[str, Any]:
    """THE organization-level staffing-availability document.

    Every chooser reads this — the hire modal's model/account/effort selects,
    the staffing context menus, anything that has to answer "what can I staff
    right now". It is deliberately free of any ticket: what it reports is the
    machine's availability, which is exactly the part each of those surfaces was
    separately discovering for itself on the user's click.

    It carries no `reason` strings, because there is nothing here to explain:
    an unstaffable tier and an ineligible account are absent, not annotated.
    `errors` is the one thing that IS reported, and it is not the same as
    emptiness — "we could not find out" must never render as "there is nothing".
    """
    snap = snap if snap is not None else staffcache.read()
    tiers = []
    order = catalog_order(snap)
    for tier in in_catalog_order(list(org.d["tiers"]), order):
        seat = org.d["tiers"][tier]
        try:
            provider_blocked = _provider_block(org, tier)
        except Exception:                                         # noqa: BLE001
            provider_blocked = "unavailable"
        if provider_blocked:
            continue
        needs = staffcache.tier_needs_account(tier)
        accounts = eligible_accounts(org, tier, snap) if needs else []
        if needs and not accounts:
            continue
        tiers.append({"tier": tier, "seat": seat,
                      "provider": providers.provider_of(tier),
                      "efforts": supported_efforts(tier, snap),
                      "accounts": accounts,
                      "default_ok": not needs or not account_reason(org, tier, snap)})
    state = staffcache.state()
    return {"tiers": tiers, "at": snap["at"], "stale": bool(snap.get("stale")),
            "errors": list(snap["errors"]), "loading": state["loading"],
            "generation": state["generation"]}


def _provider_block(org: Org, tier: str) -> str | None:
    """The account-independent, ticket-independent half of `tier_block`.

    `availability` cannot run the trial hire that `tier_block` does — that one
    needs a ticket and a parent, and this document has neither. It runs the
    checks that do not: the tier belongs to the organization, its provider can
    be hired from, and the tier ceiling is not already reached.
    """
    from .api import provider_hire_gate
    try:
        if tier not in org.d["tiers"]:
            return "not in this organization"
        provider_hire_gate(org, tier)
        org._check_tier_ceiling(tier)
    except (LedgerError, ValueError) as e:
        return str(e)
    return None
