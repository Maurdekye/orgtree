"""THE warm staffing-availability source — one cache, every staffing surface.

⚠ THE DEFECT THIS EXISTS FOR (user report 2026-09-15, screenshot image-118.png).
Every staffing chooser did its own discovery, on the user's click. Opening
`Staff…` on a ticket ran provider discovery, a Codex model-inventory probe that
can spawn a CLI, and — in Request mode — an unconditional `openrouter.
refresh_catalog()`, which is a live HTTP GET to openrouter.ai. The menu could
not appear until all of that returned, and the NEXT surface the user opened did
the whole thing again because nothing was shared. The user's ruling widened it
past the one menu: no staffing entry point may begin its first load when it is
opened, and every one of them reads the same warmed source.

WHAT IS CACHED IS THE I/O, NOT THE ANSWER. A snapshot holds the expensive,
organization-independent inputs — the provider document, the OpenRouter catalog
ids, the per-tier effort contracts, the account rows and their usage boards.
Everything a surface actually renders is derived from a snapshot by PURE
computation (`tier_accounts`, `efforts`), so the derivation can stay identical
to the one the staffing operation enforces without the cache having to know
about organizations, tickets or menus. A cached *answer* would have had to be
keyed by org, by item, by parent and by mode, and would have gone stale in ways
nothing could detect.

THREE PROPERTIES THE CALLERS DEPEND ON.

  * SINGLE FLIGHT. Ten surfaces opening at once perform ONE refresh and all ten
    wait on it. Without this the fix would have made the first paint worse, not
    better: every consumer racing to warm the same cold cache is the same
    network cost the defect had, multiplied.
  * A WARM READ NEVER BLOCKS. Once there is a snapshot, `read()` returns it and
    schedules any needed refresh behind the caller. That is what makes a menu
    open instantly, and it is why an invalidation marks the snapshot stale
    rather than deleting it — deleting it would turn the very next open into
    exactly the synchronous first load this module exists to remove.
  * STALE IS FOR READING, NEVER FOR COMMITTING. A menu may be built from a
    stale-but-recent snapshot; the staffing operation re-reads with
    `allow_stale=False` and a bounded age, so nothing is ever HIRED against an
    account the registry has since disabled. The cost of being wrong is
    therefore a refused click with a clear reason, never a bad seat.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Final

from . import accountusage, codex_limits, codex_route, limits, openrouter, providers, registry
from .ledger import Org, app_prefer_reserve_default

#: A snapshot older than this is refreshed — behind the caller when one already
#: exists, so ordinary use never waits for it.
TTL: Final = 90.0
#: The staffing operation's own tolerance. A commit re-reads within this age and
#: refuses to accept a stale snapshot, so the door that creates a seat is never
#: answering from evidence a menu was allowed to render from.
COMMIT_MAX_AGE: Final = 30.0

_lock = threading.RLock()
_snapshot: dict[str, Any] | None = None
_inflight: threading.Event | None = None
_generation = 0
_warm_thread: threading.Thread | None = None


# --------------------------------------------------------------- the snapshot
def _board_for_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """One registered account's usage board, from cached evidence only.

    `allow_fetch=False` is deliberate and load-bearing: this runs for every
    account on every refresh, and a fetching read would put N provider round
    trips on the refresh that the menus are waiting behind. Unknown telemetry
    stays unknown — `account_block` treats an unreadable board as "no evidence
    of exhaustion", which is the same thing the single-account check has always
    done, never as a zero reading.
    """
    try:
        return accountusage.view(row, allow_fetch=False)
    except Exception:                                             # noqa: BLE001
        # A board that cannot be read is not evidence that the account is full.
        return None


def _ambient_board(provider: str) -> dict[str, Any] | None:
    try:
        if provider == "openai":
            return codex_limits.snapshot(time.time())
        if provider == "claude":
            return limits.snapshot(time.time())
        from . import antigravity_limits
        return antigravity_limits.snapshot(time.time())
    except Exception:                                             # noqa: BLE001
        return None


def _compute() -> dict[str, Any]:
    """Gather every expensive input once. Never raises: a provider that cannot
    be reached is recorded as an error ON the snapshot, because a surface that
    gets an exception here has no way to tell "nothing is available" from
    "we could not find out", and those two must not look alike."""
    from .api import _providers_payload
    errors: list[str] = []
    document: Any = {}
    try:
        document = _providers_payload()
    except Exception as e:                                        # noqa: BLE001
        errors.append(f"provider discovery failed: {e}")
    # ⚠ THE RAW ANSWER IS KEPT, EVEN WHEN IT IS NONSENSE. Discovery returning
    # None, {} or a malformed row is a FAILURE to find out, and `request_models`
    # refuses on exactly that shape — coercing it to a tidy empty document here
    # would convert "we could not tell" into the authoritative "there are no
    # models", which is the one answer this subsystem must never invent. `doc`
    # is the defensive local view used to gather the rest.
    doc: dict[str, Any] = document if isinstance(document, dict) else {}
    if not isinstance(document, dict):
        errors.append("provider discovery returned no model list")
    # The OpenRouter rows in the provider document are FAVORITES; a saved
    # favorite is not availability, so catalog membership is checked too. None
    # means "could not find out", which is not the same as an empty catalog and
    # must never be rendered as "no models".
    catalog: frozenset[str] | None = None
    if any(p.get("id") == openrouter.PROVIDER_ID
           for p in doc.get("providers") or [] if isinstance(p, dict)):
        try:
            catalog = frozenset(card["id"] for card in openrouter.refresh_catalog())
        except openrouter.OpenRouterError as e:
            errors.append(f"OpenRouter catalog unavailable: {e}")
        except Exception as e:                                    # noqa: BLE001
            errors.append(f"OpenRouter catalog unavailable: {e}")
    effort_map: dict[str, list[str]] = {}
    # ⚠ THE UNION, NOT JUST WHAT DISCOVERY OFFERS. An organization can hold a
    # tier the provider document does not currently list, and answering "no
    # efforts" for it would silently drop the effort submenu rather than say
    # anything. The static tables plus discovered OpenRouter favorites cover
    # the known tier vocabulary; `efforts` below also derives the OpenRouter
    # contract for an organization-held tier absent from this document.
    for tier in sorted(set(_tiers_in(doc)) | set(providers.CODEX_TIERS)
                       | set(providers.ANTIGRAVITY_TIERS) | set(providers.CLAUDE_TIERS)):
        try:
            effort_map[tier] = _supported_efforts(tier)
        except Exception:                                         # noqa: BLE001
            effort_map[tier] = []
    rows = []
    try:
        rows = registry.list_accounts()
    except Exception as e:                                        # noqa: BLE001
        errors.append(f"account registry unreadable: {e}")
    accounts = [{"row": r, "board": _board_for_row(r)} for r in rows]
    ambient = {p: _ambient_board(p) for p in registry.PROVIDERS}
    return {"at": time.time(), "providers": document, "catalog": catalog,
            "efforts": effort_map, "accounts": accounts, "ambient": ambient,
            "errors": errors, "stale": False}


def _tiers_in(document: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for provider in document.get("providers") or []:
        if not isinstance(provider, dict):
            continue
        for model in provider.get("tiers") or []:
            if isinstance(model, dict) and isinstance(model.get("tier"), str):
                out.append(model["tier"])
    return out


def _supported_efforts(tier: str) -> list[str]:
    """The effort contract a tier advertises. Identical to what `quickstaff`
    used to compute inline — it lives here because `codex_model_inventory` can
    spawn the Codex CLI, which is exactly the kind of work that must not happen
    on a menu open."""
    if tier in providers.CODEX_TIERS:
        inventory = providers.codex_model_inventory()
        offered = inventory.get("efforts", {}).get(providers.CODEX_MODELS[tier], [])
        return [e for e in Org.EFFORTS if e in offered]
    if tier in providers.ANTIGRAVITY_TIERS:
        return [e for e in Org.EFFORTS if providers.antigravity_effort(tier, e) == e]
    if tier in providers.CLAUDE_TIERS:
        return list(Org.EFFORTS)
    if openrouter.is_tier(tier):
        return list(Org.EFFORTS)
    return []


# ------------------------------------------------------------------- the door
def _refresh_locked() -> dict[str, Any]:
    """Compute a snapshot, with ONE computation shared by every waiter.

    The `_inflight` event is published BEFORE the lock is dropped, so a second
    caller arriving mid-computation finds it and waits rather than starting its
    own — which is the whole difference between a cache and a thundering herd.
    """
    global _snapshot, _inflight
    with _lock:
        waiting = _inflight
        if waiting is None:
            _inflight = waiting = threading.Event()
            mine = True
        else:
            mine = False
    if not mine:
        waiting.wait(timeout=120)
        with _lock:
            if _snapshot is not None:
                return _snapshot
        # The owner died without publishing. Fall through and compute; the
        # alternative is answering "no models" because of somebody else's crash.
        with _lock:
            _inflight = None
        return _refresh_locked()
    try:
        fresh = _compute()
        with _lock:
            fresh["generation"] = _generation
            _snapshot = fresh
            return fresh
    finally:
        with _lock:
            done, _inflight = _inflight, None
        if done is not None:
            done.set()


def _spawn_refresh() -> None:
    """Refresh behind the caller. At most one warming thread at a time — the
    single-flight event makes a second one redundant anyway, and spawning a
    thread per aged read on a busy canvas is its own leak."""
    global _warm_thread
    with _lock:
        alive = _warm_thread is not None and _warm_thread.is_alive()
        if alive or _inflight is not None:
            return
        _warm_thread = threading.Thread(target=_refresh_locked, daemon=True,
                                        name="orgtree-staffcache-warm")
        thread = _warm_thread
    thread.start()


def warm(reason: str = "startup") -> None:
    """Begin loading NOW, in the background, so the first surface the user
    opens finds an answer already there. Safe to call repeatedly and from
    anywhere; it never blocks and never raises."""
    with _lock:
        snap = _snapshot
        if snap is not None and not snap.get("stale") and time.time() - snap["at"] < TTL:
            return
    _spawn_refresh()


def read(*, max_age: float | None = None, allow_stale: bool = True
         ) -> dict[str, Any]:
    """The current availability snapshot.

    Warm and acceptable → returned at once, with a background refresh scheduled
    if it has aged past `TTL`. Nothing usable → compute, under single flight.

    `allow_stale=False` (and a `max_age`) is the STAFFING OPERATION's read: it
    refuses evidence a menu was allowed to render from, so a click that a stale
    menu should not have offered is refused at the door instead of creating a
    seat nobody could have run.
    """
    now = time.time()
    with _lock:
        snap = _snapshot
    if snap is not None:
        stale = bool(snap.get("stale")) and not allow_stale
        aged = max_age is not None and now - snap["at"] > max_age
        if not stale and not aged:
            if now - snap["at"] > TTL or snap.get("stale"):
                _spawn_refresh()
            return snap
    return _refresh_locked()


def invalidate(reason: str = "") -> None:
    """Availability changed — an account, a sign-in, a mark, the catalog, a
    provider preference.

    ⚠ MARKED STALE, NOT DELETED. Dropping the snapshot would make the very next
    menu open a synchronous first load, which is the defect this module exists
    to remove; the refresh runs behind the user instead. Reading is allowed to
    see the old answer for that moment. COMMITTING is not — `read(allow_stale=
    False)` is what the staffing door uses — so the worst a stale menu can do
    is offer a click that is then refused with a reason.

    ⚠ AND IT STARTS NOTHING ITSELF. `read` already refreshes behind a caller it
    hands a stale snapshot to, so spawning here as well would only mean doing
    the work for nobody: every account write, sign-in and preference toggle on
    an idle machine would run full provider discovery that no surface had asked
    for. Worse, it made discovery observably reentrant — a forced provider read
    invalidated the cache, whose refresh then read the provider document again,
    which is how `test_providers_force` caught it.
    """
    global _generation
    with _lock:
        _generation += 1
        if _snapshot is not None:
            _snapshot["stale"] = True


def state() -> dict[str, Any]:
    """What the surfaces report and the tests assert on."""
    with _lock:
        snap = _snapshot
        inflight = _inflight is not None
    if snap is None:
        return {"warm": False, "loading": inflight, "age": None,
                "stale": False, "errors": [], "generation": _generation}
    return {"warm": True, "loading": inflight,
            "age": round(time.time() - snap["at"], 3),
            "stale": bool(snap.get("stale")), "errors": list(snap["errors"]),
            "generation": snap.get("generation", 0)}


def reset_for_tests() -> None:
    """Forget everything — and WAIT for any refresh already running first.

    ⚠ NOT OPTIONAL. A background warm that is mid-flight publishes its snapshot
    when it finishes, which lands AFTER a reset that did not wait for it; the
    next case then measures the previous case's world and fails in a way that
    only reproduces when the suite runs in a particular order."""
    global _snapshot, _inflight, _warm_thread
    with _lock:
        thread, waiting = _warm_thread, _inflight
    if waiting is not None:
        waiting.wait(timeout=30)
    if thread is not None and thread.is_alive():
        thread.join(timeout=30)
    with _lock:
        _snapshot, _inflight, _warm_thread = None, None, None


# ------------------------------------------------------- pure derivations
def efforts(snap: dict[str, Any], tier: str) -> list[str]:
    offered = snap["efforts"].get(tier)
    if offered is None and openrouter.is_tier(tier):
        return list(Org.EFFORTS)
    return list(offered or [])


def catalog_ids(snap: dict[str, Any]) -> frozenset[str] | None:
    return snap["catalog"]


def account_block(snap: dict[str, Any], row: dict[str, Any] | None,
                  provider: str, tier: str) -> str | None:
    """Why this ONE account cannot run this tier right now, or None.

    ⚠ THIS IS THE USER'S OWN ACCOUNTING AND IT IS NOT RESTATED HERE — it is the
    body that `quickstaff.account_reason` has always run, lifted out so it can
    be asked about ANY account instead of only the organization's default. That
    is the whole of the model-list defect: every Claude tier read as unavailable
    because the default Claude account's weekly window was full, while a second
    signed-in Claude account still had room.

    `row` None means the provider's ambient (`provider/primary`) login, which
    has no registry row of its own and answers from the provider-wide board.

    A board that is missing or stale is NOT exhaustion. Unknown telemetry is
    reported as unknown, exactly as before; the local credential and admission
    gates still run in the real hire.
    """
    if provider == "openrouter":
        return None
    if row is not None:
        if row.get("auth") == "unauthenticated":
            return "requires sign-in"
        if registry.active_mark(row["id"], tier):
            return "has reached its limit"
        if registry.account_mode(row) == "apikey":
            return None
        board = _find_board(snap, row["id"])
    else:
        board = snap["ambient"].get(provider)
    if not board or not board.get("available") or board.get("stale"):
        return None
    windows = board.get("limits") or []

    def full(rows: list[dict[str, Any]]) -> bool:
        return any(isinstance(w.get("percent"), (int, float)) and w["percent"] >= 100
                   for w in rows)

    if provider == "openai":
        # Luna accumulates in the reserve pool and does not touch the plan pool
        # until reserve is full, so a full plan window alone does not exclude it.
        plan = [w for w in windows if codex_route.pool_of_window(w) == codex_route.PLAN_POOL]
        reserve = [w for w in windows if codex_route.pool_of_window(w) == codex_route.RESERVE_POOL]
        exhausted = full(plan) and (tier != codex_route.ROUTED_TIER
                                    or not app_prefer_reserve_default()
                                    or not reserve or full(reserve))
    elif provider == "claude":
        # Fable spends the standard weekly window AND its own scoped one; the
        # lower tiers ignore the scoped window entirely.
        exhausted = full([w for w in windows if w.get("kind") in ("session", "weekly_all")
                          or (tier == "fable" and w.get("kind") == "weekly_scoped")])
    else:
        exhausted = full([w for w in windows if "gemini" in str(w.get("model") or "").lower()])
    return "is at 100%" if exhausted else None


def _find_board(snap: dict[str, Any], account_id: str) -> dict[str, Any] | None:
    for entry in snap["accounts"]:
        if entry["row"].get("id") == account_id:
            return entry["board"]
    return None


def tier_accounts(snap: dict[str, Any], org: Org, tier: str) -> list[dict[str, Any]]:
    """Every account that can run `tier` for this organization, right now.

    The ambient `provider/primary` login comes first — it is what an unqualified
    hire uses — followed by the registry rows that bind. INELIGIBLE ACCOUNTS ARE
    ABSENT, not marked: the user's ruling is that a surface offers only what can
    actually be staffed, and a disabled row is still an offer.

    An OpenRouter tier answers `[]` and that is not emptiness — that lane is not
    an account at all (design D6), so `tier_needs_account` is what callers ask
    before reading a length.
    """
    provider = providers.provider_of(tier)
    if provider not in registry.PROVIDERS:
        return []
    slug = str(org.d.get("slug") or "")
    out: list[dict[str, Any]] = []
    if not account_block(snap, None, provider, tier):
        out.append({"value": f"{provider}/primary", "id": "default",
                    "provider": provider, "ambient": True,
                    "email": _ambient_email(snap, provider)})
    for entry in snap["accounts"]:
        row = entry["row"]
        if row.get("provider") != provider or _is_ambient(row):
            continue
        if not registry.is_enabled(row):
            continue
        try:
            registry.validate_binding(slug, tier, row["id"])
        except registry.BindingRefused:
            continue                       # org-key scope, provider mismatch…
        if account_block(snap, row, provider, tier):
            continue
        out.append({"value": row["id"], "id": row["id"], "provider": provider,
                    "ambient": False,
                    "email": (row.get("identity") or {}).get("email")})
    return out


def _is_ambient(row: dict[str, Any]) -> bool:
    return bool(row.get("ambient")) or str(
        (row.get("credential") or {}).get("kind") or "") == "ambient"


def _ambient_email(snap: dict[str, Any], provider: str) -> str | None:
    for entry in snap["accounts"]:
        row = entry["row"]
        if row.get("provider") == provider and _is_ambient(row):
            return (row.get("identity") or {}).get("email")
    return None


def tier_needs_account(tier: str) -> bool:
    """Does staffing this tier involve an account at all? False for OpenRouter,
    whose lane is a routed key and not a signed-in account."""
    return providers.provider_of(tier) in registry.PROVIDERS


def row_of(snap: dict[str, Any], account_id: str) -> dict[str, Any] | None:
    """The cached registry row for an id, or None when the registry has none —
    which for a selection that resolved to an id means the account is gone."""
    for entry in snap["accounts"]:
        if entry["row"].get("id") == account_id:
            return entry["row"]
    return None
