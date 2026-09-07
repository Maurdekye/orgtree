# pyright: strict
"""Bounded-staleness suppression for the per-turn dynamic envelope (D-223).

WHAT THIS IS FOR
----------------
D-181 moved the live org state and the provider-usage board OUT of the system
prompt and INTO a per-turn user event, because one byte of drift in the system
prompt discards the whole conversation cache. That fix was right and this does
not undo it — the envelope stays in the user-event stream, append-only, and
nothing here ever touches the cached prefix.

But "rides the turn envelope" is not free either. It costs those bytes ONCE
PER TURN, FOREVER: a user event is appended to the conversation, so turn N's
copy is still being re-read on turn N+40, and on a cold resume it is re-paid at
full price. MEASURED on this machine's real transcripts (2026-09-01, 240 ORG
STATE renderings, 23 usage boards):

    ORG STATE        961 chars/turn   chart 491 (51%), header 181 (19%),
                                      roster 128, credits 81, rest 80
    PROVIDER USAGE   986 chars/turn   real rows 468 (47%), constant
                                      unavailable(unsupported) rows 261 (27%),
                                      column header 86, header 69, legend 55

…and, diffing consecutive renderings within one session with timestamps,
countdowns and ages masked out:

    ORG STATE        only 15.8% of its characters change SEMANTICALLY per turn
    PROVIDER USAGE   only 34.0%

So the great majority of what the envelope spends is a re-send of something the
agent already has, a few thousand tokens further up the same conversation.

WHAT THIS MODULE DECIDES
------------------------
Only this: "has the agent already been shown this exact fact in THIS session,
recently enough and near enough in the context that pointing at it is honest?"
Everything else — what the blocks say, which facts are always sent in full —
belongs to the renderers.

⚠ EVERY UNCERTAIN ANSWER IS "SEND IT AGAIN". A wrongly-suppressed block is an
agent acting on a roster or a credit balance it cannot see; a wrongly-sent one
costs a few hundred characters. Those are not comparable, so `decide` returns
full on anything it cannot positively rule out — missing state, malformed
state, a different session, a shrunken context, a clock that went backwards.

⚠ AND THE RECORD IS WRITTEN ONLY AFTER THE TEXT WAS ACTUALLY CONSUMED. See
`Snapshot`. Recording at render time is the one way to get this badly wrong.
"""
from __future__ import annotations

import hashlib
import math
from typing import Any, Final, TypedDict

ORG_STATE: Final = "org_state"
USAGE: Final = "usage"
KINDS: Final = (ORG_STATE, USAGE)

# The staleness bound, three ways. A suppressed block is never more than ONE of
# these away from a full re-send, whichever comes first.
#
# TURNS/AGE are the ordinary belt-and-braces. TOKENS is the one the others
# cannot express: an agent can burn 200k tokens of tool output inside a single
# turn, and a snapshot that was two lines up is then a long way back. Measured
# threshold sweep over real transcripts (simulate_protocol.py): savings are
# 33.9% at 25k, 36.4% at 60k, and flat from there to 250k — 60k is the knee, so
# it buys the whole available saving without stretching the bound further than
# the evidence supports.
FULL_REFRESH_TURNS: Final = 10
FULL_REFRESH_AGE_S: Final = 900.0
FULL_REFRESH_TOKENS: Final = 60_000


class Snapshot(TypedDict):
    """What was last DELIVERED — not what was last rendered.

    ⚠ THE DISTINCTION IS THE WHOLE SAFETY ARGUMENT. `_run_one_turn` writes the
    turn's text to `inflight` BEFORE the envelope is attached, precisely so a
    replay re-renders a fresh block instead of replaying a stale one. So a turn
    that dies between render and launch is REPLAYED, and if this record had
    already been written at render time the replay would suppress a block the
    agent never saw — a roster it cannot read and does not know it is missing.
    The record is therefore committed at the `_confirm_delivered` seam, on the
    first stdout event the CLI cannot emit without having read stdin.
    """
    seq: int      # snapshot number, cited by the suppressed line
    dig: str      # semantic digest of the suppressible part
    sid: str      # the session it was delivered INTO
    at: float     # epoch of delivery
    occ: int      # context occupancy at delivery (0 = unmeasured)
    turns: int    # suppressed turns since this snapshot
    why: str      # why the last full send fired — observability, see `decide`


def digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16]


def _snapshot(raw: Any) -> Snapshot | None:
    """Parse a persisted record, or None if it cannot be trusted at all.

    A partially-written or hand-edited record must not be repaired into
    something plausible — it must fail to parse, so `decide` sends full.
    """
    if not isinstance(raw, dict):
        return None
    try:
        seq = int(raw.get("seq"))          # pyright: ignore[reportArgumentType]
        dig = str(raw.get("dig") or "")
        sid = str(raw.get("sid") or "")
        at = float(raw.get("at"))          # pyright: ignore[reportArgumentType]
        occ = int(raw.get("occ") or 0)
        turns = int(raw.get("turns") or 0)
    except (TypeError, ValueError, OverflowError):
        return None
    if not dig or not sid or seq < 0 or turns < 0:
        return None
    if not math.isfinite(at) or at <= 0:
        return None
    return {"seq": seq, "dig": dig, "sid": sid, "at": at,
            "occ": max(0, occ), "turns": turns,
            "why": str(raw.get("why") or "")}


def read(node: dict[str, Any], kind: str) -> Snapshot | None:
    book = node.get("envelope")
    if not isinstance(book, dict):
        return None
    return _snapshot(book.get(kind))       # pyright: ignore[reportUnknownArgumentType]


def write(node: dict[str, Any], kind: str, snap: Snapshot) -> None:
    book = node.get("envelope")
    if not isinstance(book, dict):
        book = {}
        node["envelope"] = book
    book[kind] = dict(snap)                # pyright: ignore[reportUnknownMemberType]


def clear(node: dict[str, Any]) -> None:
    """Drop the whole record — for anything that invalidates the agent's view
    of its own history wholesale (a re-seed, a cheap-compact successor). The
    session check below catches those too; this is the explicit belt."""
    node.pop("envelope", None)


def decide(prior: Snapshot | None, *, sid: str, dig: str,
           now: float, occ: int) -> tuple[bool, str]:
    """(send_full, reason). Reason is recorded for observability, and the
    suppression path is the ONLY one that returns False.

    Order matters only for which reason gets reported; the outcome is the OR of
    every full-trigger. `occ <= 0` means occupancy is unmeasured (a node that
    has never completed a turn reports None), and BOTH occupancy rules are then
    skipped rather than treated as a shrink to zero — the turn and age bounds
    still apply, so staleness stays bounded either way.
    """
    if prior is None:
        return True, "first"
    if not sid or prior["sid"] != sid:
        # A different session is a different conversation: whatever was
        # delivered into the old one is not in this one's context. This is what
        # makes restart, re-seed, fork and cheap-compact recover for free.
        return True, "new-session"
    if prior["dig"] != dig:
        return True, "changed"
    if occ > 0 and prior["occ"] > 0:
        if occ < prior["occ"]:
            # The context got SMALLER, so something was dropped — a compaction,
            # a truncated resume. The snapshot may be among the casualties and
            # there is no way to ask.
            return True, "context-shrank"
        if occ - prior["occ"] >= FULL_REFRESH_TOKENS:
            return True, "token-threshold"
    if prior["turns"] + 1 > FULL_REFRESH_TURNS:
        return True, "turn-threshold"
    if not math.isfinite(now) or now < prior["at"]:
        return True, "clock-moved"         # cannot age it — do not guess
    if now - prior["at"] >= FULL_REFRESH_AGE_S:
        return True, "age-threshold"
    return False, "unchanged"


def advance(prior: Snapshot | None, *, sid: str, dig: str, now: float,
            occ: int, full: bool, why: str = "") -> Snapshot:
    """The record to commit once this turn's text is known to be consumed.

    A full send starts a new snapshot (new number, new anchor). A suppressed
    turn keeps the old anchor — its timestamp, its occupancy, its number — and
    only counts one more turn against it, because the thing the agent is being
    pointed AT is still that older block.
    """
    if full or prior is None:
        return {"seq": (prior["seq"] + 1) if prior else 1, "dig": dig,
                "sid": sid, "at": now, "occ": max(0, occ), "turns": 0,
                "why": why}
    return {**prior, "turns": prior["turns"] + 1}
