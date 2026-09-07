# pyright: strict
"""The Codex failure classifier's DECISION CORE, side-effect-free.

    codex_route.classify_failure(**kw) == decide(codex_route.failure_evidence(**kw))

`failure_evidence` (codex_route) resolves the wire into typed `Evidence`:
the error's machine tag, whether anything ran, the pool that answered, the
turn's own rate-limit snapshots and the account board read for that pool.
`decide` turns Evidence into the FailureClass and reads nothing else. This
module imports only `typing`, so a recorded Evidence (the codex projection
in a failure fixture, docs/failure-fixtures.md) is re-decided offline with
no storage, provider or process module loaded — and the supervisor's own
decision is that same function, not a copy of it.
"""
from __future__ import annotations

from typing import Any, Final, TypedDict

KIND_USAGE_LIMIT: Final = "usage-limit"
KIND_RATE_LIMIT: Final = "rate-limit"
KIND_AUTH: Final = "auth"
KIND_CONTEXT: Final = "context"
KIND_BUDGET: Final = "budget"
KIND_OVERLOADED: Final = "overloaded"
KIND_CONNECTION: Final = "connection"
KIND_USAGE_PROSE: Final = "usage-limit-prose"
KIND_OTHER: Final = "other"
KIND_UNKNOWN: Final = "unknown"

KINDS: Final = (KIND_USAGE_LIMIT, KIND_RATE_LIMIT, KIND_AUTH, KIND_CONTEXT,
                KIND_BUDGET, KIND_OVERLOADED, KIND_CONNECTION,
                KIND_USAGE_PROSE, KIND_OTHER, KIND_UNKNOWN)
POOL_STATES: Final = ("exhausted", "no-grant", "unexplained", "unattributed",
                      "n/a")
CAP_STATES: Final = ("absent", "stale", "usable", "exhausted")   # pool_capacity
SENT: Final = "<sent>"          # `served` sentinel: the pool the turn was sent to

_CODE_KIND: Final[dict[str, str]] = {
    "usagelimitexceeded": KIND_USAGE_LIMIT,
    "ratelimitexceeded": KIND_RATE_LIMIT,
    "unauthorized": KIND_AUTH,
    "contextwindowexceeded": KIND_CONTEXT,
    "sessionbudgetexceeded": KIND_BUDGET,
    "serveroverloaded": KIND_OVERLOADED,
    "httpconnectionfailed": KIND_CONNECTION,
    "responsestreamconnectionfailed": KIND_CONNECTION,
    "responsestreamdisconnected": KIND_CONNECTION,
    "responsetoomanyfailedattempts": KIND_CONNECTION,
}


class FailureClass(TypedDict):
    kind: str
    code: str
    rejected: bool          # explicit terminal rejection with nothing run
    attributed: str | None  # the pool the rejection is EVIDENCE ABOUT:
                            # the sent pool, or the reroute destination's,
                            # or None when the destination is unrecognised
    redrive: bool           # rejected AND the pool that rejected is the one
                            # we sent to — the only case a retry on the
                            # other pool is a different request
    pool_state: str         # one of POOL_STATES
    reset_ts: float | None  # the attributed pool's latest reset, if known
    why: str


class Evidence(TypedDict):
    """Everything `decide` reads, resolved and typed. `snap_*` is the turn's
    own rate-limit snapshots read for the attributed pool; `board_*` /
    `cap_*` are the account board (`pool_capacity`) read for that pool at
    `now`. They are False/None when there is no attributed pool."""
    status: str | None
    code: str
    usage_prose: bool
    nothing_ran: bool
    pool: str
    served: str | None          # SENT, a pool name, or None (unrecognised)
    snap_exhausted: bool
    snap_reset: float | None
    board_fresh: bool           # a board, available and not stale
    board_complete: bool
    cap_state: str | None       # one of CAP_STATES, or None without a board
    cap_reset: float | None


def error_code(error: Any) -> str:
    """The machine tag of a `TurnError`, normalised across the two spellings
    this codebase has measured: `usage_limit_exceeded` (0.150.1 specimen) and
    the v2 schema's `usageLimitExceeded` (0.153.3, `evidence/schema-0.153.3`).
    The object forms (`{"httpConnectionFailed": {...}}`) name their variant
    by their single key."""
    if not isinstance(error, dict):
        return ""
    info: Any = error.get("codexErrorInfo")
    if isinstance(info, dict):
        d: dict[str, Any] = info
        raw = str(d.get("type") or d.get("kind") or "")
        if not raw and len(d) == 1:
            raw = str(next(iter(d.keys())))
    else:
        raw = str(info or "")
    return raw.replace("_", "").replace("-", "").strip().lower()


def kind_of(status: str | None, code: str, usage_prose: bool) -> str:
    if status is None or status == "":
        return KIND_UNKNOWN
    if code in _CODE_KIND:
        return _CODE_KIND[code]
    if code:
        return KIND_OTHER
    if usage_prose:
        return KIND_USAGE_PROSE
    if status == "failed":
        return KIND_UNKNOWN
    return KIND_OTHER


def nothing_ran(*, items_seen: int, had_usage: bool, text_len: int) -> bool:
    """No item, no token usage, no (non-blank) text: `text_len` is the length
    of the agent text AFTER stripping."""
    return int(items_seen or 0) == 0 and not had_usage and int(text_len or 0) == 0


def attributed_pool(pool: str, served: str | None) -> str | None:
    """The pool the answer is EVIDENCE ABOUT: the one that served the turn."""
    return pool if served == SENT else served


def decide(ev: Evidence) -> FailureClass:
    """What kind of failure this was, and whether the request may be re-sent
    on the other pool — from resolved Evidence and nothing else.

    `rejected` is True ONLY for the provider's own terminal usage-limit tag on
    a turn that observed no item, no token usage and no text. Everything else
    — a lost stream, a timeout (status None), a 429-class rate limit, an auth
    failure, a usage-limit read out of PROSE with no machine tag — is not a
    rejection this code will act on by replaying.

    ⚠ `served` / `attributed` / `redrive` (parent review 2026-09-05). `pool`
    is the pool the turn was SENT to; `served` is the pool that answered —
    the same one unless the server said `model/rerouted` (`served_pool`).
    A rejection is evidence about the pool that ANSWERED, so `pool_state`
    and `reset_ts` describe `attributed = served`, and a rejection after a
    reroute is never booked against the pool we chose. And it may be
    re-driven on the other pool ONLY when the pool that rejected is the one
    we sent to: after a reserve→direct reroute, "the other pool" is direct
    — the pool that just rejected — and re-sending there is the same
    request to the same wall. With an unrecognised destination
    (`served=None`) nothing is attributed to any pool and nothing is
    re-driven: an unobserved destination is not inferred.

    `pool_state` explains a rejection from evidence, in order: the turn's own
    snapshots showing the attributed pool exhausted; else a fresh COMPLETE
    board (exhausted / absent = no-grant); else "unexplained" — still a
    rejection, but marked with the probe floor rather than a provider reset.
    """
    status = ev["status"]
    code = ev["code"]
    pool = ev["pool"]
    kind = kind_of(status, code, ev["usage_prose"])
    ran_nothing = ev["nothing_ran"]
    # ⚠ THREE conditions, all required (parent review 2026-09-05): the
    # provider's TERMINAL "failed" status — an interrupted, completed or
    # in-progress turn carrying a usage tag is not a terminal rejection —
    # the usage-limit machine tag, and nothing observed to have run
    rejected = (status == "failed" and kind == KIND_USAGE_LIMIT
                and ran_nothing)
    attributed = attributed_pool(pool, ev["served"])
    redrive = rejected and attributed == pool
    pool_state = "n/a"
    reset_ts: float | None = None
    why = ""
    if kind == KIND_USAGE_LIMIT and attributed is None:
        pool_state = "unattributed"
        why = (f"sent to {pool}, but the provider rerouted to a model this "
               "code does not know; the rejection is attributed to no pool")
    elif kind == KIND_USAGE_LIMIT:
        # the turn's own unnamed notification describes the pool that
        # SERVED it (measured, see `snapshots_pool_reset`)
        if ev["snap_exhausted"]:
            pool_state, reset_ts = "exhausted", ev["snap_reset"]
            why = f"{attributed} pool exhausted (turn's own rate-limit snapshot)"
        elif ev["board_fresh"]:
            if ev["cap_state"] == "exhausted":
                pool_state, reset_ts = "exhausted", ev["cap_reset"]
                why = f"{attributed} pool exhausted (account board)"
            elif ev["cap_state"] == "absent" and ev["board_complete"]:
                pool_state = "no-grant"
                why = (f"{attributed} pool is not granted to this account "
                       f"(absent from a complete board read)")
            else:
                pool_state = "unexplained"
                why = f"{attributed} rejected the request; the board does not say why"
        else:
            pool_state = "unexplained"
            why = f"{attributed} rejected the request; no fresh board to explain it"
        if attributed != pool:
            why = (f"sent to {pool}, rerouted by the provider to {attributed}: "
                   + why + " — not re-driven (the other pool is the one that "
                   "rejected)")
        if not ran_nothing:
            why += " — but the turn had already produced output, so it is not replayed"
    elif kind == KIND_UNKNOWN:
        why = "outcome unknown (no terminal error from the provider) — never replayed"
    elif kind == KIND_CONNECTION:
        why = "transport failure — the request may have executed; never replayed"
    elif kind == KIND_AUTH:
        why = "credential rejected — not a capacity fact; no route change"
    elif kind == KIND_RATE_LIMIT:
        why = "transient rate limit — not pool exhaustion; no route change"
    return {"kind": kind, "code": code, "rejected": rejected,
            "attributed": attributed, "redrive": redrive,
            "pool_state": pool_state, "reset_ts": reset_ts, "why": why}
