# pyright: strict
"""Reserve-first routing for the `luna` tier (audit item 12, user ruling
2026-09-04).

THE RULING. `gpt-reserve` stops being a tier anyone hires. A `luna` hire
prefers OpenAI's reserve pool automatically and uses the direct Luna lane
when reserve is exhausted. One hire surface; two pools, metered apart.

WHAT A ROUTE IS. Model selection, credential selection and pool selection used
to be one string (the tier). This module separates them: a *route* is the
pool a turn is sent to (`reserve` or `plan`), the model id that names that pool
on the wire, the account namespace the evidence belongs to, and the reason the
choice was made. The tier stays what the org ASKED for; the route is what the
turn was SENT as; and what the provider REPORTS back (`reported_model`,
`model/rerouted`) is a third thing, recorded separately and never presented
as either of the first two.

WHAT THE EVIDENCE IS. The Codex app-server's rate-limit board. A pool OpenAI
has granted to the signed-in account shows up as a bucket whose `limitName`
is the model (`gpt-reserve`, measured 2026-09-03 in `codex_limits`); a
withdrawn grant has no such bucket; an exhausted one has a window at 100%.
Three facts, three different answers below, because the user's ruling and
audit §9 both say they must not be confused:

    reserve bucket present, room left  → route reserve         ("granted")
    reserve bucket present, at 100%    → route direct   ("reserve-exhausted")
    reserve bucket ABSENT, board complete → route direct        ("no-grant")
    board stale/unknown/sparse-only    → route reserve  ("board-unknown"),
                                         unless this node's own recent
                                         rejection says otherwise
    API-key login                      → route direct        ("login-kind")

⚠ ABSENCE IS ONLY EVIDENCE ON A COMPLETE BOARD. `codex_limits` folds a turn's
sparse `account/rateLimits/updated` notifications into its cache, and a
notification that does not mention reserve says nothing about reserve. Only a
board filled by a full `account/rateLimits/read` (`snapshot()["complete"]`)
can call a grant withdrawn. A sparse-only board that lacks the bucket is
"unknown", and unknown prefers reserve — the same fail-open the hire gate
has always had for reserve (an unreadable board never hides a tier the user
holds; the turn refuses loudly instead).

⚠ EXHAUSTION IS SCOPED. A node's mark that reserve rejected it carries the
account namespace it was learned under and an expiry. A mark from another
account, or one whose reset has passed, or one contradicted by a fresh board
that shows room, is ignored — so yesterday's withdrawal cannot pin a Luna to
direct forever. No reset time on a rejection means "re-probe after the floor",
never "recovered" and never "forever".

⚠ A RE-DRIVE NEEDS A TERMINAL REJECTION, NOT A HUNCH. `classify_failure`
says a request may be re-sent on the other route ONLY when the provider's own
terminal error names a usage-limit rejection AND the turn shows no item and
no token usage. A lost stream, a timeout, a missing error, an auth failure, a
rate limit (429-class, transient) are each their own kind and none of them
re-drives: an unknown outcome replayed is the duplicate this org has spent
days removing on other lanes.

This module is pure: it takes evidence and returns decisions. Reading the
board, spawning anything, and writing the node belong to the callers
(`supervisor._codex_leg`, `api.py`).
"""

from __future__ import annotations

import datetime as _dt
import math
import time
from typing import Any, Final, TypedDict, cast

#: the two models a routed tier can go out as. Read from `ledger.MODELS` by
#: name so a rename upstream is a one-line data correction there.
from .codex_decide import (  # noqa: F401 — the decision core; names re-exported
    KIND_AUTH, KIND_BUDGET, KIND_CONNECTION, KIND_CONTEXT, KIND_OTHER,
    KIND_OVERLOADED, KIND_RATE_LIMIT, KIND_UNKNOWN, KIND_USAGE_LIMIT,
    KIND_USAGE_PROSE, Evidence, FailureClass, _CODE_KIND, decide)
from .codex_decide import error_code as _error_code  # noqa: F401
from .codex_decide import attributed_pool as _attributed_pool
from .codex_decide import nothing_ran as _nothing_ran
from .ledger import MODELS as _MODELS

#: pool names — the RESOURCE a turn spends, distinct from the model string.
RESERVE_POOL: Final = "reserve"
PLAN_POOL: Final = "plan"

#: the tier that routes between pools, and the legacy token that pinned a
#: node to reserve alone. `gpt-reserve` nodes that already exist keep their
#: tier and keep running reserve-only (compatibility, not a fold-in: folding
#: them onto direct would change which budget they spend, which the ruling
#: does not authorise).
ROUTED_TIER: Final = "luna"
LEGACY_RESERVE_TIER: Final = "gpt-reserve"

RESERVE_MODEL: Final[str] = _MODELS[LEGACY_RESERVE_TIER]      # "gpt-reserve"
DIRECT_LUNA_MODEL: Final[str] = _MODELS[ROUTED_TIER]          # "gpt-5.6-luna"

#: HOW LONG A FACT ABOUT ONE WINDOW IS GOOD FOR. `codex_limits` binds its
#: `MAX_EVIDENCE_AGE` to this, and the resolver applies it PER WINDOW (parent
#: review 2026-09-05): a board whose plan bucket was refreshed a second ago
#: while its reserve bucket was last seen twenty minutes ago is fresh about
#: the plan and stale about reserve, and a global "the board was touched
#: recently" flag cannot say that. `pool_capacity` drops windows older than
#: this; a pool left with nothing fresh is `stale`, which never excludes.
EVIDENCE_MAX_AGE: Final = 900.0

#: how long a node's rejection mark stands when the provider gave no reset:
#: long enough not to burn a rejected request every turn, short enough that a
#: grant OpenAI hands back is noticed the same quarter-hour. The same "how
#: long is a fact about this account good for" question as the evidence age.
MARK_PROBE_FLOOR: Final = EVIDENCE_MAX_AGE

#: kinds `classify_failure` answers with (KIND_* — defined in codex_decide,
#: re-exported above). Only REJECTED_USAGE may re-drive.


class Route(TypedDict):
    """What a turn is SENT as. `selection` says whether this was the preflight
    choice or a retry after the other route's terminal rejection."""
    requested: str          # the node's tier — what the org asked for
    route: str              # "reserve" | "direct"
    pool: str               # RESERVE_POOL | PLAN_POOL
    model: str              # the id on the wire
    account: str            # codex account namespace the evidence belongs to
    reason: str             # why THIS route — see the table in the docstring
    evidence: str           # "board" | "board-complete" | "mark" | "login" | "tier" | "none"
    board_age: float | None
    reset_ts: float | None  # when the OTHER pool's wall lifts, if known
    selection: str          # "preflight" | "retry"
    prefer: str             # the pool the node tries FIRST (its checkbox),
                            # recorded apart from `pool`, the one chosen


class PoolCapacity(TypedDict):
    state: str              # "usable" | "exhausted" | "absent" | "stale"
    percent: float | None
    reset_ts: float | None  # LATEST exhausted reset for the pool, None = unknown
    reset_unknown: bool     # an exhausted window carried no resetsAt
    observed_at: float | None  # when THIS pool's windows were last observed
    stale_windows: int      # windows dropped as older than the evidence age


def _iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    try:
        return _dt.datetime.fromtimestamp(
            float(epoch), tz=_dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _epoch(iso_or_num: Any) -> float | None:
    if iso_or_num is None:
        return None
    if isinstance(iso_or_num, (int, float)):
        return float(iso_or_num) or None
    try:
        s = str(iso_or_num).replace("Z", "+00:00")
        return _dt.datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def pool_of_window(window: dict[str, Any]) -> str | None:
    """Which pool a NORMALIZED board window (`codex_limits._normalize` shape,
    `model` = limitName) constrains. The reserve pool is the bucket named
    after the reserve model; the plan pool is every unnamed bucket. A bucket
    named after some OTHER model (e.g. a Spark grant) constrains neither."""
    name = str(window.get("model") or "")
    if name == RESERVE_MODEL:
        return RESERVE_POOL
    if not name:
        return PLAN_POOL
    return None


def pool_of_snapshot(snapshot: dict[str, Any]) -> str | None:
    """Same question for a RAW `account/rateLimits/updated` snapshot (the
    shape `CodexTurn.rate_limit_snapshots` keeps): `limitName` names a pool."""
    name = str(snapshot.get("limitName") or "").strip()
    if name == RESERVE_MODEL:
        return RESERVE_POOL
    if not name:
        return PLAN_POOL
    return None


def _window_age(window: dict[str, Any], now: float) -> float | None:
    seen = window.get("observed_at")
    if isinstance(seen, (int, float)):
        return max(0.0, now - float(seen))
    return None


def pool_capacity(limits: list[dict[str, Any]], pool: str, *,
                  now: float | None = None,
                  max_age: float = EVIDENCE_MAX_AGE) -> PoolCapacity:
    """Capacity of one pool from a NORMALIZED board.

    Exhausted when ANY of its windows is at 100% or flagged active — a pool
    with a session window spent and a weekly window open is still spent right
    now. The reset is the LATEST among its exhausted windows (every constraint
    must clear before the pool serves again), and it is `None` with
    `reset_unknown=True` when an exhausted window carried no reset: an unknown
    reset is a re-probe time, not a recovery.

    ⚠ EVIDENCE AGES PER WINDOW. With `now`, a window whose own observation
    (`observed_at`, one per bucket+slot in `codex_limits`) is older than
    `max_age` is DROPPED before any of the above is judged: it is not
    exhausted, not usable, just old. A pool whose every window is old is
    `stale` — distinct from `absent` (no bucket at all, which on a complete
    board means no grant) and never an exclusion. A window with no
    observation time is judged as it is (a hand-built board carries its
    own `stale` flag). Without `now`, nothing is aged — the historical
    reading, kept for callers that pass a board they already aged.
    """
    mine = [w for w in limits if pool_of_window(w) == pool]
    if not mine:
        return {"state": "absent", "percent": None, "reset_ts": None,
                "reset_unknown": False, "observed_at": None,
                "stale_windows": 0}
    seen = [float(w["observed_at"]) for w in mine
            if isinstance(w.get("observed_at"), (int, float))]
    observed_at = max(seen) if seen else None
    fresh: list[dict[str, Any]] = []
    dropped = 0
    for w in mine:
        age = _window_age(w, now) if now is not None else None
        if age is not None and age > max_age:
            dropped += 1
            continue
        fresh.append(w)
    if not fresh:
        return {"state": "stale", "percent": None, "reset_ts": None,
                "reset_unknown": False, "observed_at": observed_at,
                "stale_windows": dropped}
    # from here on `observed_at` is the FRESH windows' latest sighting: the
    # time a verdict below rests on, which is what a mark is compared to
    seen = [float(w["observed_at"]) for w in fresh
            if isinstance(w.get("observed_at"), (int, float))]
    observed_at = max(seen) if seen else None
    worst = 0.0
    exhausted: list[dict[str, Any]] = []
    for w in fresh:
        try:
            pct = float(w.get("percent") or 0.0)
        except (TypeError, ValueError):
            pct = 0.0
        worst = max(worst, pct)
        if pct >= 100.0 or bool(w.get("is_active")):
            exhausted.append(w)
    if not exhausted:
        return {"state": "usable", "percent": worst, "reset_ts": None,
                "reset_unknown": False, "observed_at": observed_at,
                "stale_windows": dropped}
    resets = [_epoch(w.get("resets_at")) for w in exhausted]
    known = [r for r in resets if r is not None]
    unknown = len(known) != len(resets)
    return {"state": "exhausted", "percent": worst,
            "reset_ts": (max(known) if known and not unknown else None),
            "reset_unknown": unknown, "observed_at": observed_at,
            "stale_windows": dropped}


def snapshots_pool_reset(snapshots: Any, pool: str,
                         sent_pool: str | None = None) -> tuple[bool, float | None]:
    """From a turn's RAW rate-limit board (keyed by limitId): did this pool
    show an exhausted window, and when does the LATEST of them reset?

    → `(exhausted, reset_ts)`; `reset_ts` is None when unknown. Positive
    evidence only: a pool that does not appear here is simply not described
    by this turn's sparse notifications (see the module note on absence).

    ⚠ `sent_pool` — the pool the turn was SENT to. MEASURED 2026-09-05 (live
    control, codex-cli 0.153.0): a per-turn notification carries NO
    `limitName` whichever pool served the turn, only that pool's window
    under the generic `codex` id. So an UNNAMED bucket in a turn's own
    snapshots describes `sent_pool`, not the plan pool. A named bucket is
    still filed by its name. Without `sent_pool` the old rule (unnamed =
    plan) applies, which is right for a full board read.
    """
    if not isinstance(snapshots, dict):
        return False, None
    exhausted = False
    resets: list[float | None] = []
    for snap in snapshots.values():
        if not isinstance(snap, dict):
            continue
        named = bool(str(snap.get("limitName") or "").strip())
        snap_pool = (pool_of_snapshot(snap) if named or sent_pool is None
                     else sent_pool)
        if snap_pool != pool:
            continue
        reached = bool(snap.get("rateLimitReachedType"))
        for slot in ("primary", "secondary"):
            win = snap.get(slot)
            if not isinstance(win, dict):
                continue
            try:
                pct = float(win.get("usedPercent") or 0.0)
            except (TypeError, ValueError):
                continue
            if pct >= 100.0 or reached:
                exhausted = True
                try:
                    rs = float(win.get("resetsAt") or 0.0) or None
                except (TypeError, ValueError):
                    rs = None
                resets.append(rs)
    if not exhausted:
        return False, None
    known = [r for r in resets if r is not None]
    if not known or len(known) != len(resets):
        return True, None
    return True, max(known)


def node_wake_epoch(limits: list[dict[str, Any]], snapshots: Any,
                    pools: tuple[str, ...] = (RESERVE_POOL, PLAN_POOL),
                    sent_pool: str | None = None) -> float | None:
    """When might a routed node serve again, given BOTH pools are out?

    Per pool: the latest applicable exhausted reset (board and the turn's own
    snapshots, whichever is later). Across pools: the EARLIEST pool with a
    known reset — the first moment a re-probe could find capacity. None when
    no pool has a known reset (caller falls to its probe floor). This is a
    probe time, not a provider promise: `pool_capacity` says so per pool.
    """
    candidates: list[float] = []
    for pool in pools:
        cap = pool_capacity(limits, pool)
        _ex, snap_reset = snapshots_pool_reset(snapshots, pool, sent_pool=sent_pool)
        known = [t for t in (cap["reset_ts"], snap_reset) if t is not None]
        if known:
            candidates.append(max(known))
    return min(candidates) if candidates else None


#: where a `failure_deadline` answer came from — the turn's OWN rate-limit
#: notification (the app-server says it on the wire beside the error: the
#: limit message, in the user's sense), or the CACHED board
SRC_NOTIFICATION = "notification"
SRC_BOARD = "board"


def failure_deadline(route: Route, board: dict[str, Any], snapshots: Any,
                     served_pool: str | None, *,
                     now: float | None = None) -> tuple[float | None, str, str]:
    """Return the routed failure's deadline, its honest schedule kind and
    WHERE the deadline came from (`SRC_NOTIFICATION`, `SRC_BOARD`, or `""`
    when nothing answered).

    ⚠ THE TURN'S OWN NOTIFICATION OUTRANKS THE CACHED BOARD (user ruling
    2026-09-07 14:56Z: the time in the limit message first, cached usage only
    when the message carries none). Until then this took `max()` of the two,
    so a board read minutes earlier could push the wake PAST the reset the
    provider had just stated for this very turn. The board is consulted only
    when the notification carried no usable reset — an exhausted window
    WITHOUT a `resetsAt` is exactly "no time in the message", so the
    matching pool's cached reset answers then (coordinator correction
    15:32Z) — and then only for the account and pool captured by the route,
    never another namespace's. Nothing anywhere → the caller's probe floor.

    A single served pool recovers only after the latest exhausted constraint
    in that pool. Luna can use either pool, so its earlier per-pool deadline
    is only a time to probe the alternatives.
    """
    now = time.time() if now is None else now
    pool = served_pool or None
    account = str(route.get("account") or "")
    age = board.get("age")
    board_ok = (bool(account) and bool(pool)
                and board.get("account") == account
                and not bool(board.get("stale"))
                and isinstance(age, (int, float))
                and not isinstance(age, bool) and math.isfinite(float(age))
                and 0 <= float(age) <= EVIDENCE_MAX_AGE)
    limits = ([cast("dict[str, Any]", value)
               for value in cast("list[Any]", board.get("limits") or [])
               if isinstance(value, dict)] if board_ok else [])
    if route.get("requested") == ROUTED_TIER:
        if not pool:
            return None, "probe", ""
        # both pools out: PER POOL the notification answers first and the
        # board only where the notification said nothing about that pool;
        # across pools the earliest known reset is the probe time (the first
        # moment a re-probe could find capacity — `node_wake_epoch`'s rule).
        # ⚠ the provenance returned is that of the WINNING candidate, not of
        # the turn: when pool B's board reset is earlier than pool A's stated
        # one the answer is B's, labelled SRC_BOARD, and A's stated time
        # leaves the ranking — earlier and a `probe`, so one re-freeze at
        # worst (redteam 2026-09-07 R4)
        candidates: list[tuple[float, str]] = []
        for p in (RESERVE_POOL, PLAN_POOL):
            exhausted, snap = snapshots_pool_reset(snapshots, p, sent_pool=pool)
            if exhausted and snap is not None:
                candidates.append((snap, SRC_NOTIFICATION))
                continue
            # no stated time for this pool (no notification, or one without
            # a reset): the cached board for the same pool
            if not limits:
                continue
            cap = pool_capacity(limits, p)
            reset = cap.get("reset_ts")
            if isinstance(reset, (int, float)) and not cap.get("reset_unknown"):
                candidates.append((float(reset), SRC_BOARD))
        if not candidates:
            return None, "probe", ""
        wake, src = min(candidates)
        return wake, "probe", src
    if not pool:
        return None, "probe", ""
    exhausted, snap = snapshots_pool_reset(snapshots, pool, sent_pool=pool)
    if exhausted and snap is not None:
        # the notification is the message: an exhausted window with a reset
        # answers outright
        return snap, "observed-deadline", SRC_NOTIFICATION
    # no stated time (no notification, or an exhausted window without one):
    # the cached board for this account and pool, then the floor
    cap = pool_capacity(limits, pool, now=now) if board_ok else None
    if not cap or cap.get("reset_unknown"):
        return None, "probe", ""
    reset = cap.get("reset_ts")
    if not isinstance(reset, (int, float)):
        return None, "probe", ""
    return float(reset), "observed-deadline", SRC_BOARD


def failure_schedule(route: Route, board: dict[str, Any], snapshots: Any,
                     served_pool: str | None, *,
                     now: float | None = None) -> tuple[float | None, str]:
    """`failure_deadline` without the provenance — the older two-value shape,
    kept for callers that only schedule."""
    ts, kind, _src = failure_deadline(route, board, snapshots, served_pool,
                                      now=now)
    return ts, kind


# ── the decision ────────────────────────────────────────────────────────────

def _route_for(tier: str, pool: str, account: str, *, reason: str,
               evidence: str, board_age: float | None = None,
               reset_ts: float | None = None, selection: str = "preflight",
               prefer: str = RESERVE_POOL, direct_model: str | None = None,
               ) -> Route:
    if pool == RESERVE_POOL:
        return {"requested": tier, "route": "reserve", "pool": RESERVE_POOL,
                "model": RESERVE_MODEL, "account": account, "reason": reason,
                "evidence": evidence, "board_age": board_age,
                "reset_ts": reset_ts, "selection": selection,
                "prefer": prefer}
    return {"requested": tier, "route": "direct", "pool": PLAN_POOL,
            "model": direct_model or DIRECT_LUNA_MODEL, "account": account,
            "reason": reason, "evidence": evidence, "board_age": board_age,
            "reset_ts": reset_ts, "selection": selection, "prefer": prefer}


def direct_route(tier: str, model: str, account: str, *,
                 reason: str, evidence: str, board_age: float | None = None,
                 reset_ts: float | None = None,
                 selection: str = "preflight",
                 prefer: str = RESERVE_POOL) -> Route:
    return _route_for(tier, PLAN_POOL, account, reason=reason,
                      evidence=evidence, board_age=board_age,
                      reset_ts=reset_ts, selection=selection, prefer=prefer,
                      direct_model=model)


def reserve_route(tier: str, account: str, *, reason: str, evidence: str,
                  board_age: float | None = None,
                  reset_ts: float | None = None,
                  selection: str = "preflight",
                  prefer: str = RESERVE_POOL) -> Route:
    return _route_for(tier, RESERVE_POOL, account, reason=reason,
                      evidence=evidence, board_age=board_age,
                      reset_ts=reset_ts, selection=selection, prefer=prefer)


def mark_live(mark: Any, account: str, now: float) -> bool:
    """Is a node's rejection mark still binding for THIS account right now?
    Wrong account, expired, or shapeless → no."""
    if not isinstance(mark, dict):
        return False
    m: dict[str, Any] = mark
    if str(m.get("account") or "") != account:
        return False
    until = m.get("until_ts")
    try:
        until_f = float(until) if until is not None else None
    except (TypeError, ValueError):
        until_f = None
    if until_f is None:
        return False
    return now < until_f


def make_mark(kind: str, account: str, reset_ts: float | None, now: float,
              reason: str) -> dict[str, Any]:
    """A node's record that a pool rejected it: scoped to the account, timed
    to the provider's reset when it gave one, else to the probe floor —
    never open-ended."""
    if reset_ts is not None and reset_ts > now:
        until, src = reset_ts, "provider"
    else:
        until, src = now + MARK_PROBE_FLOOR, "probe"
    return {"kind": kind, "account": account, "until_ts": until,
            "until": _iso(until), "reset_src": src, "at": _iso(now),
            "at_ts": now, "reason": reason}


class _PoolView(TypedDict):
    """One pool's standing for the resolver: excluded or not, and why."""
    excluded: bool
    reason: str             # "usable" | "unknown" | "exhausted" | "no-grant"
                            # | "marked:<kind>" | "login-kind"
    evidence: str           # "board" | "board-complete" | "mark" | "login" | "none"
    reset_ts: float | None


def _mark_at(mark: dict[str, Any]) -> float | None:
    """When the mark was written (epoch). `at_ts` is exact; `at` (ISO) is
    the fallback for a record written without it."""
    ts = mark.get("at_ts")
    if isinstance(ts, (int, float)):
        return float(ts)
    return _epoch(mark.get("at"))


def _pool_view(pool: str, *, login_kind: str | None, board: dict[str, Any],
               marks: dict[str, Any], account: str, now: float) -> _PoolView:
    """What the evidence says about ONE pool, in precedence order: the login
    kind (reserve is a subscription grant); a fresh board OF THIS ACCOUNT
    (exhaustion excludes; absence excludes only on a COMPLETE board; room
    admits — but only when that pool was observed AFTER this node's own
    rejection mark, see below); then the node's live mark; then nothing
    (unknown — which never excludes).

    ⚠ A POSITIVE OBSERVATION MUST BE NEWER THAN THE REJECTION IT OVERRULES
    (parent review 2026-09-05). A board read at T-20 s that shows reserve at
    20% says nothing about a rejection the provider issued at T-1 s; and a
    sparse notification about the PLAN bucket does not refresh what is
    known about reserve. So recovery is judged per pool, on that pool's
    own last observation time (`codex_limits` keeps one per bucket): room
    observed after the mark clears it; room observed before the mark is
    outranked by it. Without a per-pool time the mark wins.

    ⚠ A BOARD FROM ANOTHER ACCOUNT IS NO EVIDENCE. `codex_limits` stamps
    the board with the account it read; if that is not the account this
    decision is being made for, the board is treated as absent.

    ⚠ FRESHNESS IS THIS POOL'S, NOT THE BOARD'S (parent review 2026-09-05,
    reproduced: a plan-only notification at T+1000 s made the board "not
    stale" while reserve's exhausted window was still the T reading, and
    reserve stayed excluded on 1000-second-old evidence). The board's own
    `stale` flag is one input — it is the age of the LAST touch, and a
    board nobody touched for the evidence age is stale in every pool — but
    a board that is fresh overall is then aged window by window
    (`pool_capacity(now=…)`), and a pool whose windows are all old is
    `stale`: unknown, never an exclusion, the turn is the probe.
    """
    if pool == RESERVE_POOL and login_kind == "api-key":
        return {"excluded": True, "reason": "login-kind", "evidence": "login",
                "reset_ts": None}
    mark = marks.get(pool)
    live_mark = mark_live(mark, account, now)
    fresh = bool(board.get("available")) and not bool(board.get("stale"))
    board_acct = board.get("account")
    if fresh and board_acct is not None and str(board_acct) != account:
        fresh = False                       # someone else's pools
    if fresh:
        limits = [w for w in (board.get("limits") or []) if isinstance(w, dict)]
        cap = pool_capacity(limits, pool, now=now)
        if cap["state"] == "stale":
            # the bucket exists but nothing fresh is known about it; the
            # node's own mark (below) is the only remaining evidence
            if not live_mark:
                return {"excluded": False, "reason": "stale",
                        "evidence": "board", "reset_ts": None}
        elif cap["state"] == "usable":
            newer = (live_mark and (cap["observed_at"] is None
                                    or _mark_at(mark) is None
                                    or cap["observed_at"] <= _mark_at(mark)))
            if not newer:
                return {"excluded": False, "reason": "usable",
                        "evidence": "board", "reset_ts": None}
            # room observed BEFORE the rejection: the mark stands, below
        elif cap["state"] == "exhausted":
            return {"excluded": True, "reason": "exhausted", "evidence": "board",
                    "reset_ts": cap["reset_ts"]}
        elif (cap["state"] == "absent" and pool == RESERVE_POOL
                and bool(board.get("complete"))):
            return {"excluded": True, "reason": "no-grant",
                    "evidence": "board-complete", "reset_ts": None}
        # absent on a sparse-only board, or a plan pool the board does not
        # describe: unknown — fall through to the node's own mark
    if live_mark:
        m: dict[str, Any] = mark
        try:
            until = float(m.get("until_ts") or 0.0) or None
        except (TypeError, ValueError):
            until = None
        return {"excluded": True, "reason": f"marked:{m.get('kind') or 'rejected'}",
                "evidence": "mark", "reset_ts": until}
    return {"excluded": False, "reason": "unknown", "evidence": "none",
            "reset_ts": None}


def resolve(tier: str, *, login_kind: str | None, board: dict[str, Any],
            marks: dict[str, Any] | None, account: str,
            now: float | None = None, direct_model: str | None = None,
            selection: str = "preflight",
            prefer_reserve: bool = True) -> Route:
    """Which pool this turn is sent to. See the module docstring's table.

    `prefer_reserve` (user ruling 2026-09-04, the per-agent "Prefer reserve"
    checkbox, on by default): the pool tried FIRST. The other pool is the
    fallback either way — turning the preference off never disables reserve
    as a fallback, and turning it on never disables the plan pool as one.
    The route records the preference (`prefer`) beside the pool that was
    actually chosen; the header token reads the latter.

    The rule is the same in both orders: send to the first pool in the
    preferred order that the evidence does not EXCLUDE (excluded = login
    kind cannot hold it, a fresh board shows it spent, a complete board shows
    it absent, or this node's live mark says it rejected us). Unknown never
    excludes — the turn's own answer is the probe. When both are excluded the
    preferred pool is sent to anyway (the provider's refusal is the freeze
    evidence; a pre-emptive freeze would be orgtree's word for the
    provider's), and `reason` says both were out.

    `board` is `codex_limits.snapshot()` (normalized, with `stale` and
    `complete`); `marks` is the node's `codex_routes` record; `account` is
    the codex account namespace (`supervisor._cache_codex_account_namespace`).
    `direct_model` is the non-routed model for `tier` (ledger MODELS); for
    the routed tier it defaults to the direct Luna id.
    """
    now = time.time() if now is None else now
    marks = marks if isinstance(marks, dict) else {}
    direct_model = direct_model or _MODELS.get(tier, tier)
    prefer = RESERVE_POOL if prefer_reserve else PLAN_POOL
    if tier == LEGACY_RESERVE_TIER:
        # compatibility: an old reserve node is reserve, full stop
        return reserve_route(tier, account, reason="legacy-tier",
                             evidence="tier", selection=selection,
                             prefer=RESERVE_POOL)
    if tier != ROUTED_TIER:
        return direct_route(tier, direct_model, account, reason="tier",
                            evidence="tier", selection=selection,
                            prefer=PLAN_POOL)
    age = board.get("age")
    board_age = float(age) if isinstance(age, (int, float)) else None
    order = ((RESERVE_POOL, PLAN_POOL) if prefer_reserve
             else (PLAN_POOL, RESERVE_POOL))
    views = {p: _pool_view(p, login_kind=login_kind, board=board,
                           marks=marks, account=account, now=now)
             for p in order}
    first, second = order
    v1, v2 = views[first], views[second]
    name = {RESERVE_POOL: "reserve", PLAN_POOL: "direct"}
    if not v1["excluded"]:
        # the preferred pool stands: "granted" keeps the historical wording
        # for a reserve-first luna on a board with room; "preferred" is the
        # plan-first case; unknown evidence prefers the preferred pool too
        reason = ("granted" if first == RESERVE_POOL and v1["reason"] == "usable"
                  else "preferred" if v1["reason"] == "usable"
                  else ("board-stale" if v1["reason"] == "stale"
                        or (board.get("available") and board.get("stale"))
                        else "board-unknown"))
        return _route_for(tier, first, account, reason=reason,
                          evidence=v1["evidence"], board_age=board_age,
                          selection=selection, prefer=prefer,
                          direct_model=DIRECT_LUNA_MODEL)
    if not v2["excluded"]:
        # the preferred pool is out; the other one is not known to be
        why = v1["reason"]
        reason = ("no-grant" if why == "no-grant"
                  else "login-kind" if why == "login-kind"
                  else f"{name[first]}-{why}")   # -exhausted | -marked:<kind>
        return _route_for(tier, second, account, reason=reason,
                          evidence=v1["evidence"], board_age=board_age,
                          reset_ts=v1["reset_ts"], selection=selection,
                          prefer=prefer, direct_model=DIRECT_LUNA_MODEL)
    # both excluded: the provider answers, on the preferred pool, unless the
    # preferred pool cannot be asked at all (api-key login has no reserve)
    target = second if v1["reason"] == "login-kind" else first
    known = [t for t in (v1["reset_ts"], v2["reset_ts"]) if t is not None]
    return _route_for(tier, target, account,
                      reason=f"both-out:{name[first]}-{v1['reason']},"
                             f"{name[second]}-{v2['reason']}",
                      evidence=v1["evidence"], board_age=board_age,
                      reset_ts=(min(known) if known else None),
                      selection=selection, prefer=prefer,
                      direct_model=DIRECT_LUNA_MODEL)


def other_route(route: Route) -> Route | None:
    """The route to retry on after `route` was terminally rejected — only a
    routed tier has one; a legacy reserve node and every other tier have
    nowhere else to go."""
    tier = route["requested"]
    if tier != ROUTED_TIER:
        return None
    prefer = route.get("prefer") or RESERVE_POOL
    if route["route"] == "reserve":
        return direct_route(tier, DIRECT_LUNA_MODEL, route["account"],
                            reason="reserve-rejected", evidence="rejection",
                            selection="retry", prefer=prefer)
    return reserve_route(tier, route["account"], reason="direct-rejected",
                         evidence="rejection", selection="retry",
                         prefer=prefer)


def served_pool(route: Route, rerouted: Any) -> str | None:
    """The pool that SERVED a turn, for attributing its unnamed rate-limit
    notification: the pool the turn was sent to — unless the server said
    `model/rerouted`, in which case the destination model decides
    (`gpt-reserve` → reserve; any other codex model → plan), and an
    unrecognised destination decides nothing (None: the notification is
    filed by its own id and the receipt says attribution is unknown). A
    selected pool is never called a billing fact when the server reports
    that it served something else."""
    if isinstance(rerouted, dict):
        to = str(rerouted.get("toModel") or "").strip()
        if not to:
            return None
        if to == RESERVE_MODEL:
            return RESERVE_POOL
        if to in _MODELS.values():
            return PLAN_POOL
        return None
    return route["pool"]


# ── the failure classifier ──────────────────────────────────────────────────

def failure_evidence(*, status: str | None, error: Any, snapshots: Any,
                     items_seen: int, token_usage: Any, agent_text: str,
                     pool: str, board: dict[str, Any] | None,
                     usage_prose: bool = False,
                     served: str | None = "<sent>",
                     now: float | None = None) -> Evidence:
    """The wire, resolved into the typed Evidence `codex_decide.decide`
    reads: the error's machine tag (`_error_code`), whether anything ran,
    the pool that answered, and — for that pool — the turn's own snapshots
    (`snapshots_pool_reset`) and the account board (`pool_capacity` at
    `now`). Resolved whenever a pool is attributed, whatever the kind, so a
    recorded Evidence is complete for re-deciding offline."""
    now = time.time() if now is None else now
    attributed = _attributed_pool(pool, served)
    ev: Evidence = {
        "status": status, "code": _error_code(error),
        "usage_prose": bool(usage_prose),
        "nothing_ran": _nothing_ran(
            items_seen=int(items_seen or 0),
            had_usage=token_usage is not None,
            text_len=len((agent_text or "").strip())),
        "pool": pool, "served": served,
        "snap_exhausted": False, "snap_reset": None,
        "board_fresh": False, "board_complete": False,
        "cap_state": None, "cap_reset": None,
    }
    if attributed is None:
        return ev
    # the turn's own unnamed notification describes the pool that SERVED
    # it (measured, see `snapshots_pool_reset`)
    ev["snap_exhausted"], ev["snap_reset"] = snapshots_pool_reset(
        snapshots, attributed, sent_pool=attributed)
    if board:
        ev["board_complete"] = bool(board.get("complete"))
        if board.get("available") and not board.get("stale"):
            ev["board_fresh"] = True
            limits = [w for w in (board.get("limits") or [])
                      if isinstance(w, dict)]
            cap = pool_capacity(limits, attributed, now=now)
            ev["cap_state"], ev["cap_reset"] = cap["state"], cap["reset_ts"]
    return ev


def classify_failure(*, status: str | None, error: Any, snapshots: Any,
                     items_seen: int, token_usage: Any, agent_text: str,
                     pool: str, board: dict[str, Any] | None,
                     usage_prose: bool = False,
                     served: str | None = "<sent>",
                     now: float | None = None) -> FailureClass:
    """What kind of failure this was, and whether the request may be re-sent
    on the other pool: `decide(failure_evidence(...))`. The rules (rejection
    needs the terminal status, the usage tag and nothing run; attribution to
    the pool that SERVED; re-drive only when that is the pool sent to;
    pool_state from snapshots, then a fresh board, else unexplained) are
    documented and implemented in `codex_decide.decide`."""
    return decide(failure_evidence(
        status=status, error=error, snapshots=snapshots,
        items_seen=items_seen, token_usage=token_usage,
        agent_text=agent_text, pool=pool, board=board,
        usage_prose=usage_prose, served=served, now=now))


def route_label(route: Route | None, *, live: bool,
                rerouted: Any = "<record>") -> str | None:
    """The header token text (user spec 2026-09-04: a token on the header's
    second row when Luna RUNS ON RESERVE; must reflect the actual route and
    must say when it describes the LAST turn rather than a live one).

    Nothing (None) for tiers that do not route and for a direct Luna with no
    reserve story to tell — the token carries news or it is absent.

    ⚠ A KNOWN REROUTE CHANGES THE TOKEN (parent review 2026-09-05). The
    token is about where the turn RAN, and when the server reported
    `model/rerouted` the selected pool is not where it ran. `rerouted` is
    read off the record (the shape `_codex_route_stamp` writes) unless
    passed; a reroute onto the reserve model wears "reserve", one off
    reserve onto the direct model wears "direct · rerouted off reserve",
    and one onto a model this code does not know wears "rerouted · pool
    unknown" — the destination is not inferred. The selected route stays
    in the record beside it; the token never claims billing.
    """
    if not route or route.get("requested") != ROUTED_TIER:
        return None
    prefix = "" if live else "last: "
    record = cast("dict[str, Any]", route)      # the stamp's superset shape
    rr = record.get("rerouted") if rerouted == "<record>" else rerouted
    if isinstance(rr, dict):
        served = served_pool(route, rr)
        if served is None:
            return prefix + "rerouted · pool unknown"
        if served == RESERVE_POOL:
            return prefix + ("reserve · rerouted" if route.get("route") != "reserve"
                             else "reserve")
        if route.get("route") == "reserve":
            return prefix + "direct · rerouted off reserve"
        # sent direct, served direct (a reroute between direct models)
    if route.get("route") == "reserve":
        return prefix + "reserve"
    reason = str(route.get("reason") or "")
    if (reason.startswith("reserve-") or reason == "no-grant"
            or reason.startswith("both-out:")):
        # a luna that ran direct because reserve is spent, withdrawn or
        # rejected it: disclosed, because reserve is out. A plan-first luna
        # running direct by preference has nothing to disclose.
        return prefix + "direct · reserve out"
    return None
