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
                 until: float, observed: bool, served: str = "") -> None:
    """Codex errors name a login digest; marks name its registered profile.

    `served` is the account the turn ACTUALLY ran as, captured from the
    resolved spawn env. It matters for the metered lane, where the node may
    carry no binding at all: an unbound codex node routed to an API-key
    account is bound to nothing, so the old `node["account"]` read returned
    immediately and the wall went unrecorded.
    """
    bound = str(node.get("account") or "")
    tier = str(node.get("model") or "")
    # ── THE METERED KEY LANE FIRST. A key account has no login digest to
    # match and no plan/reserve pools to name — those are subscription
    # concepts. What it has is a rate limit, and the docket's multi-key rule
    # ("first enabled account without an active capacity mark") only works if
    # the wall lands ON the row that hit it. The mark is keyed by TIER, which
    # is exactly what `apikey_lane_row` consults when it picks the next key.
    keyed = str(served or bound)
    if keyed:
        try:
            krow = registry.get_account(keyed)
        except (registry.UnknownAccount, KeyError, ValueError):
            krow = None
        if (krow is not None and krow.get("provider") == "openai"
                and registry.account_mode(krow) == "apikey"):
            if tier:
                registry.record_mark(
                    keyed, tier, until,
                    provenance="observed" if observed else "inferred")
            return
    if not bound:
        return
    try:
        row = registry.get_account(bound)
        if row["provider"] != "openai":
            return
        cred = row["credential"]
        if cred["kind"] not in ("imported", "managed"):
            return
        digest, lane = codex_limits._account_namespace(cred["path"])
        if lane != "subscription" or digest != account:
            return
        for key in pools("openai", tier, pool):
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


def exhausted(board: dict[str, Any], provider: str, tier: str,
              pool: str, now: float) -> bool:
    """POSITIVE evidence that this account cannot serve `tier` right now.

    ⚠ IT IS NOT `not available(...)`, AND THAT IS THE WHOLE POINT. `available`
    answers "has this board PROVED there is room", so everything it cannot
    establish — an unreported window, a reading nobody has taken, a board that
    errored — comes back False and reads, to a caller that negates it, as "this
    account is full". Those are different facts, and conflating them is what
    made `Continue on` unreachable: the claude readout carries a `session`
    window with NO `resets_at` on every signed-in account (and marks the
    currently-running one `is_active` at 0% used), so `available` was False for
    accounts sitting at zero and the operator was shown nothing to click.

    So this function answers the OTHER question — "has this board proved there
    is NO room" — and answers False for everything it cannot establish. An
    applicable window reporting 100% or more is the only positive evidence
    there is. `available` is unchanged and still owns the AUTOMATIC path, where
    the machine acts unasked and must prove capacity before it moves anybody.

    ⚠ A PASSED `resets_at` DOES NOT DISCOUNT A FULL WINDOW. An expired window
    has probably rolled over, but "probably" is not a reading: the most recent
    number upstream gave for that lane still says full, and offering an account
    on the strength of a stamp having gone stale is exactly the predictable
    failure the operator must not be handed. Staleness makes evidence weaker,
    never more permissive.
    """
    if board.get("error"):
        return False                     # a failed read establishes nothing
    rows = board.get("limits")
    if not isinstance(rows, list):
        return False

    def full(windows: list[dict[str, Any]]) -> bool:
        for w in windows:
            value = w.get("percent")
            if isinstance(value, bool) or not isinstance(value, (float, int)):
                continue                 # unreadable percent: no evidence
            if math.isfinite(value) and value >= 100:
                return True
        return False
    if provider == "claude":
        return full([w for w in rows if isinstance(w, dict)
                     and w.get("kind") in ("session", "weekly_all",
                                           "weekly_scoped")
                     and limits.lane_applies(w, tier)])
    if provider == "openai":
        if board.get("lane") != "subscription":
            # a board describing another lane says nothing about this pool
            return False
        wanted = (codex_route.PLAN_POOL if pool == "plan" else
                  codex_route.RESERVE_POOL if pool == "reserve" else None)
        return full([w for w in rows if isinstance(w, dict)
                     and (wanted is None
                          or codex_route.pool_of_window(w) == wanted)])
    return False


def offerable(row: dict[str, Any], board: dict[str, Any], tier: str,
              pool: str) -> bool:
    """THE MANUAL PATH'S RULE: is this account worth offering the operator?

    `capacity`'s mirror, and deliberately a different question. The automatic
    scheduler moves an agent with nobody watching, so it may act only on proof
    of room. The operator is looking at the usage board when they open the menu
    and is choosing on purpose — so what they must be protected from is a
    choice that PREDICTABLY fails, not one whose evidence is merely silent.

    An account is therefore offered unless something positively says otherwise:
    an active capacity mark for this tier and pool (the same `marked` the
    automatic path honours — a wall this org has already recorded), or a window
    upstream reports at 100% (`exhausted`). A move made on silent evidence that
    turns out to be wrong re-freezes the agent, visibly, and the operator picks
    another account; a move the interface refused to offer at all leaves them
    with no route but halting the agent and rebinding it by hand.
    """
    now = time.time()
    choices = pool.split("+") if row["provider"] == "openai" else [pool]
    return any(not marked(row, tier, choice)
               and not exhausted(board, row["provider"], tier, choice, now)
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


def movable(org: Any, nid: str) -> bool:
    """Is this node's FREEZE the kind another account could actually clear —
    every condition except whether the operator opted into automatic moves.

    Split out of `eligible` so the manual recovery action (user requirement
    2026-09-14: `Continue on <account-id>`) asks the identical question. The
    two paths differ in exactly one thing — who decides to move — and a
    second copy of this list would be a second answer to "could another
    account help", drifting the moment either is edited.
    """
    from . import supervisor
    n = org.node(nid)
    if n.get("pending_switch"):
        return False
    fz = supervisor._resumable(n)
    st = supervisor.state(org.d["slug"], nid)
    return bool(fz and fz.get("limit")
                and not fz.get("untrusted") and not fz.get("on_fallback")
                and not fz.get("cause") and source_matches(n)
                and not re.search(r"per[-_ ](?:minute|second)|requests? per (?:minute|second)|\b(?:tpm|rpm)\b",
                                  str(fz.get("error") or ""), re.I)
                and not n.get("remote_controlled")
                and not n.get("bearer_state") and not n.get("inflight")
                and not st.get("busy") and not st.get("responding")
                and not org.d.get("spend_frozen") and not org.d.get("headless")
                and not supervisor.sbx.is_sandboxed(org)
                # a freeze earned on a metered API-key ACCOUNT row is the
                # API's own wall, never a subscription's — switching login
                # profiles cannot clear it (the V1 org-key form of this
                # guard was `bills_the_key`, retired 2026-09-12)
                and supervisor.served_metered_row(
                    str(fz.get("account") or "")) is None
                and providers.provider_of(str(n.get("model") or "")) in ("claude", "openai"))


def eligible(org: Any, nid: str) -> bool:
    """…and the operator asked for the move to happen by itself."""
    return bool(org.account_fallback_for(nid) and movable(org, nid))


def manual_only(org: Any, nid: str) -> bool:
    """…and the operator did NOT, so the move is theirs to make by hand.

    The manual entries exist BECAUSE automatic fallback is off (user
    requirement 2026-09-14). With it on, the automatic path owns the move and
    adding a hand control beside it would be two mechanisms racing for the
    same binding.
    """
    return bool(not org.account_fallback_for(nid) and movable(org, nid))


def identity(node: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy({k: node.get(k) for k in
                          ("account", "model", "generation", "session_id", "frozen")})


def pool_of(n: dict[str, Any]) -> str:
    """Which resource pool this node's freeze has to be cleared out of."""
    provider = providers.provider_of(str(n.get("model") or ""))
    fz = n.get("frozen") or {}
    return str(fz.get("resource_pool") or ("plan" if provider == "openai" else
                                           str(n.get("model") or "")))


def replacements(org: Any, nid: str,
                 rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Every registry row that could REPLACE this node's binding, before any
    capacity evidence is consulted — identity only.

    The list `candidates` walked inline, lifted out so the manual action and
    its menu ask one question. Excluded here, and the ticket names every one:
    the account already bound, another provider's accounts, a credential kind
    that is not a profile, an observed signed-out row, and — for a node with
    no binding at all — the ambient profile it is already running on, which
    is the very login that just hit its wall.

    `rows` lets a caller that has ALREADY loaded the registry for this render
    hand its list over. `api._org_view` loads it once for the whole graph, and
    re-reading it per node would be the per-node filesystem work D-239 forbids
    — the trap `accounts.serving_label` documents having fallen into once.
    """
    n = org.node(nid)
    provider = providers.provider_of(str(n.get("model") or ""))
    current = str(n.get("account") or "")
    ambient = (os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
               if provider == "openai" else os.path.dirname(subproxy.CREDS))
    out: list[dict[str, Any]] = []
    for row in (registry.list_accounts(org=org.d["slug"]) if rows is None
                else rows):
        cred = row.get("credential") or {}
        if (row["id"] == current or row["provider"] != provider
                or cred.get("kind") not in ("managed", "imported")
                or row.get("auth") == "unauthenticated"
                or (not current and os.path.normcase(os.path.abspath(cred["path"]))
                    == os.path.normcase(os.path.abspath(ambient)))):
            continue
        out.append(row)
    return out


def cached_board(row: dict[str, Any]) -> dict[str, Any]:
    """This account's standing FROM CACHE ONLY — no fetch, no process, no
    credential read.

    ⚠ WHY THE MENU MAY NOT USE `read_board`. That one forces a live provider
    read per account: for Codex it starts an app-server process. The node
    payload is recomposed for every node on a 6 s heartbeat, so calling it
    there is the per-node provider IO D-239 forbids and `accountusage`'s
    `allow_fetch=False` promise refuses by construction. So menu VISIBILITY
    is decided on the evidence already observed, and `continue_on` re-decides
    it with a forced read before it moves anything. An account whose cache
    says nothing simply does not appear — absence of evidence is not
    eligibility, which is exactly what the ticket asks for unreadable rows.
    """
    key = f'acct:{row["id"]}'
    try:
        if row["provider"] == "openai":
            return codex_limits.snapshot_for_key(key)
        return limits.snapshot_for_key(key)
    except (OSError, ValueError, RuntimeError, KeyError):
        return {}


def alternatives(org: Any, nid: str, *, board_of: Any = None,
                 rows: list[dict[str, Any]] | None = None,
                 rule: Any = None) -> list[str]:
    """The account IDs a frozen node could continue on, in registry order.

    `board_of` supplies the standing evidence — `cached_board` for the menu,
    `read_board` for the action about to commit.

    `rule` is the STANDING TEST applied to each candidate's board, and it is an
    argument because the two paths ask genuinely different questions of the
    same evidence. The default is `capacity`: prove there is room — a Claude
    tier needs its session AND its weekly window clear (the fable tier's own
    weekly one when that is the tier), a Codex tier needs the pool its freeze
    names, and a row carrying an active capacity mark is out. `offerable` is
    the operator's: offer unless something positively says the account is full.
    Both live in this module and both honour `marked`, so neither path has a
    private idea of eligibility; what differs is which way the burden of proof
    runs, and that is the one thing the two paths genuinely disagree about.
    """
    n = org.node(nid)
    tier = str(n.get("model") or "")
    pool = pool_of(n)
    read = board_of or cached_board
    test = rule or capacity
    out: list[str] = []
    for row in replacements(org, nid, rows):
        if marked(row, tier, pool):
            continue
        try:
            if not test(row, read(row), tier, pool):
                continue
        except (OSError, ValueError, RuntimeError, KeyError):
            continue
        out.append(str(row["id"]))
    return out


def offered(org: Any, nid: str, *, board_of: Any = None,
            rows: list[dict[str, Any]] | None = None) -> list[str]:
    """⭐ THE MANUAL PATH'S LIST — what `Continue on …` may name, and what the
    action will accept (docket `restore-continue-on-in-agent-context-menus`).

    One function so the menu and the action cannot drift: the payload builds
    its entries from this against cached evidence, and `_continue_on_account`
    re-asks it against a forced live read before it moves a binding. An account
    that disappears between the two is refused there, with its own message.
    """
    return alternatives(org, nid, board_of=board_of, rows=rows, rule=offerable)


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
        pool = pool_of(n)
        for row in replacements(org, nid):
            if marked(row, tier, pool):
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
    # allow_frozen: this IS the recovery path for a usage-limit freeze, so it
    # opts past the bare-rebind refusal; resume_frozen pops the freeze in the
    # same save window right after this returns.
    supervisor.assign_account(org.d["slug"], nid, row["id"], actor="@system",
                              org=org, via="limit_fallback", allow_frozen=True)
    return True
