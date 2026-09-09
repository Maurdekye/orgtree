# pyright: strict
"""The credit ledger: nodes, the budget invariant, and the seven operations.

Semantics ratified in PLAN.md (all §-references point there):

    free(N) = grant(N) - SUM over live children C of ( seat_cost(C) + grant(C) )   >= 0

The user IS the org root (§7.4): there is no root node. Top-level nodes have parent None,
and the reserved actor id "user" has infinite free and unconditional authority.

Credits are occupancy, not spend (§3.4). A credit is not a dollar.

Stranding (§4.4, corrected during implementation): a warning fires whenever an operation
REDUCES a node's free across an archived dependent's rehire cost. Promote/demote leave every
free unchanged (the release and acquire paths cancel hop by hop), so moves cannot strand —
the ops that can are hire (the payer), forcible hire (the actor), rehire (the parent, for its
other archived children), reallocate(-Δ), and switch_model to a pricier tier (the chain).

Directory access (№30) is an inherited capability set, NOT a budget: a node may hold only
dirs its parent holds (top-level nodes are user-granted and unconstrained). Nothing conserves;
revoke is explicit; re-parenting intersects the moved subtree's dirs with the new chain.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import time as _time
import uuid
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Final, Literal, cast

from . import clipin, deployment, events, events_render, opreceipts
from .schema import (AudienceGrant, DirGrant, FrozenInfo, MailEntry, NodeDoc,
                     NoticeEntry, NoticeLogEntry, OrgDoc, OrgInboxEntry, ToolGrant,
                     UserMailEntry, WorkActor, WorkItem, WorkStage)

# §3.1 — derived from published API pricing: a seat is the API $ per M INPUT
# tokens at the STANDING price. Promos never set seats — the sonnet-intro
# precedent, re-affirmed for sol by user ruling 2026-08-28 and for flash by
# user ruling 2026-09-02. Sonnet was 3, then 2 (user ruling 2026-08-12: $2/M
# locked in). The codex family (FR-15, same ruling): sol $5 standard (the
# current $4 is a promo through ≥2026-11-21), terra $2, and gpt-reserve/luna
# $0.20 → 0.2 each (they used to floor to 1; see the sub-$1 note below).
# The antigravity family (D-188, re-walked for the Antigravity CLI
# 2026-09-02): pro $2 standard (the ≤200K band — the >200K long-context
# surcharge is a cost-dollars concern, never a seat), flash $1.50 STANDING →
# floors to 1 (3.8-flash's $0.75 launch price is a promo through 2026-12-31,
# and a promo never sets a seat). Existing orgs migrate in the load hook
# below IF they still carry the old shipped default; a customised table
# keeps its own number. Tier names are ONE flat vocabulary — a tier implies
# its provider (providers.py owns that axis).
#
# ☞ SEATS ARE FRACTIONAL BELOW $1/M (user ruling 2026-09-03). The rule is
# `openrouter.seat_for`: floor(p) at or above $1, max(0.10, round(p, 2))
# below it. At or above $1 the old floor still governs, so flash stays 1 (not
# 1.5), pro 2, terra 2, sol 5, opus 5, fable 10, and haiku 1 (exactly $1/M
# lands on the ≥$1 branch, not the fractional one). BELOW $1 the seat is now
# the price: gpt-reserve and luna are $0.20/M and cost 0.2, which is the
# ranking information the old floor-to-1 destroyed — four Codex tiers that
# used to read 1·1·2·5 now read 0.2·0.2·2·5.
#
# ⚠ REPRICING A TIER IS A SEPARATE ACT FROM ADDING ONE, and it is the reason
# the second migration block below exists. The user's follow-on ruling
# (2026-09-03, verbatim: "i think if we are supporting fractional credts we
# should reprice agents that are under $1/m") moved gpt-reserve and luna
# AFTER the fractional machinery landed re-pricing nothing. A DROP is safe in
# the budget (`committed` falls, `free` rises, `free() >= 0` cannot start
# failing) but it is NOT safe unconditionally: `_check_tier_ceiling` compares
# seats as an ORDERING, so tiers that used to TIE at 1 no longer do — see the
# ⚠ in `_check_tier_ceiling`. A future RAISE would be the dangerous
# direction: it can overdraw a saved org, and nothing here handles that.
#
# ☞ THE SAME RULE REACHED THE DYNAMIC (OpenRouter) HALF ONLY ON 2026-09-04,
# a day late, and the delay is the lesson. The 2026-09-03 repricing block
# below names `gpt-reserve` and `luna` and so moved only them; every `or-*`
# favorite adopted before that day kept the old `max(1, floor(p))` snapshot,
# which is a FLAT 1 for every model under $1/M. The correction is general
# rather than a longer list of names — `openrouter.stale_seats` re-derives
# each `or-*` row from the price the document itself records — because the
# hard-coding is what caused the miss, not the particular names in it.
# ⚠ THE STALENESS WAS UPSTREAM OF THE DOCUMENT TOO: the seat is snapshotted
# into the favorites file by `add_favorite`, so a BRAND NEW org was being
# handed the stale 1 as well. That half is fixed at the source, in
# `openrouter.favorites`; this table's migration is only the document half.
TIERS: Final[dict[str, float]] = {"fable": 10, "opus": 5, "sonnet": 2, "haiku": 1,
                                  "sol": 5, "terra": 2, "gpt-reserve": 0.2,
                                  "luna": 0.2, "astra": 10,
                                  "flash": 1, "pro": 2}

# The credit grid. Every seat is quantised to 0.01 and every credit quantity
# is re-quantised after each mutation, which is what makes float arithmetic
# EXACT here rather than merely close: the largest reachable holding is
# MAX_CHILDREN (1024) × (fable 10 + max_top_grant 1000) ≈ 1.03e6, i.e. ~1.03e8
# in hundredths — far inside float64's exactly-representable integer range
# (2**53). So every value the ledger can reach sits on the grid with no
# residue, and the `free() >= 0` invariant (see `audit`) cannot false-positive
# on an epsilon. This is the property that made fractional seats the cheap
# option instead of an integer-millicredit rescale: no stored number changes.
CREDIT_PLACES: Final = 2
SEAT_FLOOR: Final = 0.10          # mirrored in openrouter.SEAT_FLOOR


def _q(x: float) -> float:
    """Snap a credit quantity back onto the 0.01 grid. Applied to every
    computed total and every mutated grant — see CREDIT_PLACES."""
    return round(x, CREDIT_PLACES)

# №34 runaway insurance, and NOTHING else (user ruling 2026-08-04): "no need to
# have any practical limit other than to prevent infinite recursion from a bug
# that spawns unlimited subagents". Both were low enough to be felt as design
# constraints (10 and 256); at these values a human org never meets them and a
# runaway still terminates. Both are per-org overridable.
MAX_DEPTH: Final = 1024
MAX_CHILDREN: Final = 1024

#: An ask that is still waiting on the user. Named once because three places
#: ask the question and a fourth spelling would be a silent disagreement.
OPEN_ASK_STATUS: Final = frozenset({"open", "pending"})

#: How many RESOLVED asks ride the tree payload. The desk renders
#: `asks.filter(!askOpen).slice(-8)` (App.tsx), so anything >= 8 is correct
#: and the surplus is pure payload: the full history measured 122,692 B of an
#: 844 KB tree on the live org, refetched every 6 s. 12 leaves 50% headroom
#: for the desk to show more without a backend change; `test_tree_render_cost`
#: §9 reads the desk's slice and fails if this ever drops below it.
#: ⚠ Open asks are NOT capped by this — see `tree`.
ASK_HISTORY_KEEP: Final = 12

#: How many org-inbox rows ride the tree payload. The canvas renders only the
#: newest; the modal fetches the rest. See `tree`.
ORG_INBOX_PREVIEW: Final = 3

# §5 — full model ids only; aliases drift (spike: 'sonnet' resolved to sonnet-4-5).
MODELS: Final[dict[str, str]] = {
    # Fable 5.1 (2026-09-02). The tier default moves with the CLI's own — in
    # the pinned build the fable family's default IS `claude-fable-5-1` — and
    # the seat does not move with it (§3.1 prices the BAND, and Fable's did not
    # change). ⚠ The id only exists in CLI ≥ 2.1.257 (clipin.FABLE_5_1_MIN,
    # measured), so `supervisor.claude_model_for` hands 5.0 to anything older
    # rather than this constant going straight to argv. 5.0 stays reachable as
    # a model VERSION below.
    "fable": clipin.FABLE_5_1,
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5",
    # the codex family — ids as the installed CLI's own model/list reports
    # them (measured, codex-cli 0.150.1)
    "sol": "gpt-5.6-sol",
    "terra": "gpt-5.6-terra",
    "gpt-reserve": "gpt-reserve",
    "luna": "gpt-5.6-luna",
    # Official model id (OpenAI, 2026-09-04). This is DATA, not proof that
    # the signed-in account may use it: provider admission requires exact
    # live `model/list(includeHidden=true)` membership before offering or
    # hiring this tier. If OpenAI changes the id, this is the one correction.
    "astra": "gpt-6-astra",
    # the antigravity family — BASE ids exactly as `agy models` reports them
    # (measured, Antigravity CLI 1.1.24, 2026-09-02), the effort suffix the
    # registry shows (`gemini-3.8-flash-high`) stripped: the CLI takes the
    # base id on `--model` and the effort on `--effort`, and REFUSES the two
    # combined. An id the CLI does not know fails the turn loudly (rc=1, the
    # registry listed — measured), and antigravityrun asserts the served
    # model against this pin on every turn's init event as a belt. The flash
    # tier pins 3.8 by user instruction (2026-09-02: "make sure you update
    # the models too so that we can use flash 3.8"); 3.7 and 3.6 stay
    # reachable as model VERSIONS below.
    "flash": "gemini-3.8-flash",
    "pro": "gemini-3.1-pro",
}

# A TIER is a price band — four of them, four chips. A model VERSION is a
# subcategory INSIDE a tier (user ruling 2026-08-04: "the 4 chips should
# represent the 4 tiers. individual model versions are a subcategory which
# should only be accessible within the gear menu if the user desires to change
# it"). Choosing one never touches the seat cost, the budget, or anything the
# kiosk ceiling inspects — it decides one thing: which `--model` id the CLI is
# handed. A first attempt made Opus 4.8 a fifth TIER, which put a fifth chip on
# the canvas and a fifth price band in every table; this is that, corrected.
#
# The KEY is what a node records and the gear shows; the VALUE is the CLI id.
# The tier's entry in MODELS above remains the default, so a node with no
# version recorded behaves exactly as before.
# ⚠ ids verified against the pinned CLI with a real call (2026-08-04):
# `claude-opus-4-8` answers; `claude-opus-4.8` and `opus-4-8` are refused.
MODEL_VERSIONS: Final[dict[str, dict[str, str]]] = {
    "opus": {"5": "claude-opus-5", "4.8": "claude-opus-4-8"},
    # Fable 5.1 is the tier default; 5.0 stays selectable in the gear for the
    # same reason Opus 4.8 does — a version is a subcategory inside the band,
    # never a chip, and never a different price.
    "fable": {"5.1": clipin.FABLE_5_1, "5": clipin.FABLE_5},
    # the flash tier's three registry generations (Antigravity CLI 1.1.24,
    # measured 2026-09-02) — one price row, one seat, three `--model` ids.
    "flash": {"3.8": "gemini-3.8-flash", "3.7": "gemini-3.7-flash",
              "3.6": "gemini-3.6-flash"},
}

# Actors are one of three KINDS — user, system, agent — not one string namespace.
# The non-agent kinds use @-prefixed sentinels, which slugify() can never produce,
# so agent NAMES are fully unrestricted (a node may be called "user" or "system").
USER: Final = "@user"      # the org root: infinite free, unconditional authority (§7.4)
SYSTEM: Final = "@system"  # the ledger's own hand (fable-limit policy, reconciliation)
EXTERN: Final = "@extern"  # the ORG INBOX: the org's single face to the outside world
                    # (chatq sessions, other orgs). An audience whose grantor is
                    # EXTERN lets a sub-level agent read/answer outside mail.


# ── attachments that did NOT travel (D-171) ───
#: How many attachments one message actually carries. Named ONCE because the
#: API layer and this module both used to cap at a bare literal 10, and two
#: independent silent truncations of the same list is how a caller loses a
#: file twice over without either layer admitting to it.
ATTACHMENT_MAX: Final = 10


def undeliverable_note(raw: str) -> str:
    """Sanitise one not-delivered attachment note for the [MAIL] block.

    ⚠ THE TEXT IS CALLER-SUPPLIED and is rendered straight into an agent's
    context: an attachment path typed by the composer, or a filename chosen
    by an untrusted outside party. A newline in it would forge a line inside
    the [MAIL] block — the same injection `rt_gist` collapses whitespace for
    in the FR-05 reply_to snapshot below. Collapse, cap, never trust.
    """
    s = " ".join(str(raw or "").split())
    return (s if len(s) <= 160 else s[:159] + "…") or "(unnamed)"


def _attachments_and_losses(
        attachments: list[dict[str, Any]] | None,
        missing: list[str] | None) -> tuple[list[dict[str, Any]], list[str]]:
    """Split into (what travels, what must be REPORTED as not travelling).

    D-171: the cap is applied HERE and its overflow is folded into the
    not-delivered report rather than trimmed off the end. `list(a)[:10]` is
    a silent drop wearing a slice's clothes — the sender believes ten files
    went and eleven were named, and nothing anywhere says otherwise.
    """
    delivered = list(attachments or [])
    notes = [undeliverable_note(m) for m in (missing or [])]
    over = len(delivered) - ATTACHMENT_MAX
    if over > 0:
        delivered = delivered[:ATTACHMENT_MAX]
        notes.append(f"{over} further attachment(s) — past the "
                     f"{ATTACHMENT_MAX}-per-message limit")
    return delivered, notes


def actor_kind(actor: str) -> str:
    if actor == USER:
        return "user"
    if actor == SYSTEM:
        return "system"
    return "agent"


# set by the API layer (the ledger stays hermetic — tests never need a
# backend): bare-name transport resolution's OUTSIDE knowledge. Returns
# {"org": [local org slugs matching name], "net": [hub slugs matching name]};
# the @mcp: tier resolves from the org's own correspondence log instead.
external_candidates: Callable[[str], dict[str, list[str]]] = \
    lambda name: {}   # noqa: E731

VIS_LEVELS: Final = ("self", "team", "subtree", "full")   # org-structure knowledge tiers
TOOL_KEYS: Final = ("bash", "web", "edit", "subagents")   # the built-in tool switches
# permission_mode rank order (kiosk-ceiling spec §2): later = more permissive.
# `plan` (user request 2026-08-12, with FR-13): the CLI's read-only planning
# mode — MOST restrictive, so it ranks below `default`. Inserted at index 0:
# every comparison in this file is relative (index max/greater-than), so the
# existing three keep their order and nothing stored re-ranks.
PM_LEVELS: Final = ("plan", "default", "acceptEdits", "bypassPermissions")

#: ⚠ CHARTERS ARE NOT LENGTH-LIMITED. User ruling 2026-09-04, verbatim:
#: "uncap it." There is no maximum, no refusal and no truncation — a charter
#: is stored exactly as written, however long.
#:
#: This value is an ADVISORY THRESHOLD ONLY. Above it, `note_charter_length`
#: says how long the text is. It never blocks anything, and code that treats
#: it as a limit is reintroducing the bug this whole area exists to kill:
#: `set_scope` used to store `charter.strip()[:4000]`, cutting mid-word with
#: nothing said anywhere. This org's own team charter had been ending
#: mid-sentence for an unknown period and no agent ever read its last rule.
#:
#: ⚠ WHY THE ADVISORY IS WORTH HAVING AT ALL — WRITE THIS DOWN SOMEWHERE THE
#: NEXT PERSON FINDS IT: a charter is concatenated into that agent's system
#: prompt on EVERY turn it ever takes. A long charter is therefore not a
#: one-off cost, it is a per-turn cost for the life of the agent, and since
#: the cap is gone nothing stops one growing without bound. That trade was
#: made deliberately (text silently lost is worse than tokens knowingly
#: spent), but the person writing a very long charter should be able to SEE
#: that they are writing one.
CHARTER_LONG: Final = 4000


def note_charter_length(field: str, value: str,
                        warnings: list[str]) -> str:
    """Strip a charter field and REPORT its length when it is unusually long.

    Returns the text to store — always the whole thing. This function cannot
    refuse and cannot truncate; if you are adding either, re-read the ruling
    above first.
    """
    v = value.strip()
    if len(v) > CHARTER_LONG:
        warnings.append(
            f"{field} is {len(v)} chars ({len(v.encode('utf-8'))} bytes). "
            f"Stored WHOLE — charters are not capped. Worth knowing: a "
            f"charter is re-sent in this agent's system prompt on every turn "
            f"it takes, so text past roughly {CHARTER_LONG} chars is a "
            f"recurring per-turn cost, not a one-off one.")
    return v


def norm_tools(t: Mapping[str, Any] | None) -> ToolGrant:
    """Normalize a tool grant: four built-in switches + an MCP server name list.
    "*" in mcp = every registered server, present AND future (collapses the list)."""
    t = t or {}
    out: dict[str, Any] = {k: bool(t.get(k, True)) for k in TOOL_KEYS}
    out["mcp"] = sorted({str(s) for s in t.get("mcp", []) if s})
    if "*" in out["mcp"]:
        out["mcp"] = ["*"]
    return cast(ToolGrant, out)


def expand_mcp(granted: Iterable[str] | None, ceiling_mcp: Iterable[str] | None,
               registry: Iterable[str] | None) -> list[str]:
    """Build-time MCP expansion (ceiling spec §6, deliberately PURE — no env,
    no engine — so the suite pins it directly). "*" = the whole registry; the
    effective set is expand(granted) ∩ expand(ceiling). ceiling_mcp None = no
    ceiling (a normal org). Miss the intersection and a kiosk with a list
    ceiling still hands over every server through the "*" default path."""
    reg = set(registry or [])
    g = reg if "*" in (granted or []) else set(granted or []) & reg
    if ceiling_mcp is not None:
        c = reg if "*" in ceiling_mcp else set(ceiling_mcp) & reg
        g = g & c
    return sorted(g)


def norm_dirs(dirs: Iterable[Any] | None) -> list[DirGrant]:
    """Normalize a set-like path→mode grant map into canonical list order."""
    out: list[DirGrant] = []
    seen: set[str] = set()
    for d in dirs or []:
        if isinstance(d, str):
            d = {"path": d, "mode": "rw"}
        path = d.get("path", "").strip()
        mode = d.get("mode", "rw")
        if not path or path in seen or mode not in ("rw", "ro"):
            continue
        seen.add(path)
        out.append({"path": path, "mode": mode})
    # Access semantics do not depend on caller list order, but identity_prompt
    # and --add-dir both consume this list. A formatter/retool that merely
    # reversed it therefore killed a valid warm process. Preserve the path
    # spelling while ordering by its platform-semantic form; mode remains part
    # of identity, and the first exact-path duplicate still wins as before.
    return sorted(out, key=lambda d: (
        os.path.normcase(os.path.normpath(d["path"])), d["mode"], d["path"]))


def _mint(variant: str, actor: Mapping[str, Any], obj: Mapping[str, Any] | None,
          **fields: Any) -> dict[str, Any]:
    """events.mint, reported the way every other ledger refusal is (a LedgerError) —
    events.py cannot import this module, so the conversion lives here. Every call
    site passes a STRING LITERAL variant (test_events_ledger §7 scans for it); the
    one computed site is `_ORDINARY_OF[kind]`, whose values the same scan verifies."""
    try:
        return events.mint(variant, actor, obj, **fields)
    except events.EventInvalid as e:
        raise LedgerError(f"typed message refused: {e}") from e


def _validate_ev(ev: Mapping[str, Any]) -> None:
    try:
        events.validate_event(ev)
    except events.EventInvalid as e:
        raise LedgerError(f"typed message refused: {e}") from e


#: the ONLY variants the agent/user wire can produce (design I4): the authored kinds,
#: each mapped to its leaf by a literal. Closed; the coverage scan checks every value.
_ORDINARY_OF: Final[dict[str, str]] = {
    "message": "ordinary.message", "question": "ordinary.question",
    "request": "ordinary.request", "decision": "ordinary.decision",
    "status": "ordinary.status", "notice": "ordinary.notice",
}


def actor_of(who: str) -> dict[str, str]:
    """The canonical `actor` for a validated sender id (design I3): the user, the
    engine's own hand, an outside peer, or an agent node."""
    if who == USER:
        return {"kind": "user", "id": USER}
    if who == SYSTEM or who == "orgtree":
        return {"kind": "system", "id": SYSTEM}
    if who.startswith(("@net:", "@org:", "@mcp:")):
        return {"kind": "external", "id": who}
    return {"kind": "agent", "id": who}


class LedgerError(ValueError):
    """Raised when an operation violates a precondition. Message is user-facing."""


def now() -> str:
    # millisecond resolution (user ruling 2026-07-31): second-resolution stamps
    # made same-second events unorderable — the extern reply cursor had to fall
    # back to inbox position. String comparison still works: same format, more
    # digits. (Transient quirk: within one second, OLD "…:00Z" stamps sort
    # AFTER new "…:00.123Z" ones — harmless across the format transition.)
    d = datetime.now(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


# kind flags that are QUALIFIERS on a provider-scoped freeze (a usage limit,
# a network drop) rather than kinds of their own — mirrors
# supervisor._resumable's own exemption list exactly.
_PROVIDER_SCOPED_FREEZE_FLAGS: Final = ("limit", "connection", "on_fallback",
                                        "untrusted")


def freeze_describes_provider(fz: FrozenInfo) -> bool:
    """Is this freeze ABOUT the node's provider/session — a usage limit, a
    network drop, or an auth rejection (`cause` is a string, never a flag, so
    it never trips this test) — rather than a GLOBAL/org-owned kind (kiosk
    `spend`) that has nothing to do with which provider the node runs on?

    Shared between `switch_model` (a crossing invalidates a freeze this says
    Yes to — the provider it described is gone) and
    `supervisor._resumable` (▶ resume acts on exactly the same freezes) so
    the two questions can never drift apart — D-182's standing warning about
    two copies of one rule."""
    return not any(k not in _PROVIDER_SCOPED_FREEZE_FLAGS and v is True
                   for k, v in fz.items())


# One quoted span (a node id, a user gist, a model name) or a number is what
# makes two notices of the SAME KIND read as different lines. Blanking both
# leaves the KIND — no catalogue of the ~40 notice texts to keep in sync, and
# a family added later folds on the day it is written. Single quotes are left
# alone deliberately: "the USER's authority" is prose, not a quoted span, and
# pairing it off would swallow half a sentence.

# ask_user leaked-tool-call defense (D-2xx, 2026-08-30): a caller's own raw
# completion can leak an unclosed tool-call tag into the `question` string it
# sends us — e.g. `...call.</question>\n<parameter name="options">[...]` —
# with `options` never arriving as a real argument at all. `_LEAKED_ASK_RE`
# is the exact shape of the two incidents this was built from: a closing tag
# for one of our own field names immediately followed by a `<parameter
# name="options">` open (an optional namespace prefix like `antml:` is
# tolerated — the two observed incidents omitted it, but the model's OWN
# documented format includes one). `_SUSPICIOUS_ASK_MARKUP_RE` is the loose
# fallback: any fragment of that same tool-call syntax anywhere in text we
# were not expecting to recover from — enough to refuse loudly even in a
# shape not yet seen, never enough to guess a repair from.
_LEAKED_ASK_RE = re.compile(
    r'</(?:question|header|options|multi|questions)>\s*'
    r'<(?:\w+:)?parameter\s+name="options">', re.IGNORECASE)
_SUSPICIOUS_ASK_MARKUP_RE = re.compile(
    r'</(?:question|header|options|multi|questions|parameter|invoke)>|'
    r'<(?:\w+:)?parameter\s+name="|<(?:\w+:)?invoke\s+name="', re.IGNORECASE)


MAX_EXTERN_HANDLES: Final = 8


def stamp_handles(n: Any, handles: list[str]) -> None:
    """D-166: record WHEN each handle was attached, alongside the handles.

    Pruned to exactly the current set on every write. That pruning is the
    point: a stamp left behind for an address the node no longer holds would
    be inherited by a LATER re-attach, handing the fresh handle a dead clock
    and getting it swept on the next tick."""
    prev = n.get("external_handles_at") or {}
    if handles:
        n["external_handles_at"] = {h: prev.get(h) or now() for h in handles}
    else:
        n.pop("external_handles_at", None)


def norm_extern_handles(raw: Iterable[Any] | None, *, where: str) -> list[str]:
    """Validate + dedupe a set of @mcp:<peer> response handles canonically.

    Shared by hire() and set_scope() so the two grant paths cannot drift: a
    handle is a per-address post_mail bypass, and a rule enforced at hire but
    not at attach would be a hole in exactly the same privilege. Only the
    @mcp: form is grantable — it names ONE concrete extern peer, so the bypass
    stays scoped to a single mailbox rather than "speak for the org anywhere".
    `where` names the calling op in refusals ("hire" / "retool")."""
    handles: list[str] = []
    for h in raw or []:
        h = str(h).strip()
        if not (h.startswith("@mcp:")
                and re.fullmatch(r"[A-Za-z0-9._-]{1,64}", h[5:])):
            raise LedgerError(
                f"external_handles entries must be @mcp:<peer> addresses "
                f"(got {h!r}) — each scopes this {where}'s outbound mail to "
                f"that exact extern peer")
        if h not in handles:
            handles.append(h)
    if len(handles) > MAX_EXTERN_HANDLES:
        raise LedgerError(
            f"at most {MAX_EXTERN_HANDLES} external_handles per {where}")
    # Handle order grants no mail authority and controls no routing. It does
    # render into identity_prompt, so retain a stable set representation.
    return sorted(handles)


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not slug:
        raise LedgerError("name is mandatory and must contain letters or digits (§4.7)")
    return slug


def app_prefer_reserve_default() -> bool:
    """Read the app-wide Luna pool-order default, with old-install fallback.

    This stays in the ledger's dependency-light layer so supervisor routing,
    cache forecasting, and tree/UI projections all use the same live value.
    It is intentionally not copied into org documents.
    """
    # Import lazily: store imports Org, while this function is called only
    # after the application has finished importing. This makes the canonical
    # bound store root authoritative even if ambient ORGTREE_DATA changes.
    from . import store
    root = store.DATA_ROOT
    try:
        with open(os.path.join(root, "defaults.json"), encoding="utf-8") as f:
            value = json.load(f).get("prefer_reserve")
        return value if isinstance(value, bool) else True
    except (OSError, json.JSONDecodeError, AttributeError):
        return True


class Org:
    """One organization: a node tree, its audiences/notices, and an event log.

    Pure bookkeeping — no processes, no I/O. Persistence lives in store.py; the
    supervisor drives sessions elsewhere. Every mutating op takes `actor` (a node id or
    USER) and enforces authority + budget preconditions before touching state.
    """

    def __init__(self, doc: OrgDoc) -> None:
        self.d: OrgDoc = doc
        # migrate older docs in place: dir grants gain modes; scopes gain tool sets
        # (pre-schema docs — the loop handles keys NodeDoc no longer declares)
        for i, n in enumerate(cast("dict[str, dict[str, Any]]",
                                   self.d.get("nodes", {})).values()):
            sc = n.setdefault("scope", {})
            sc["add_dirs"] = norm_dirs(sc.get("add_dirs"))
            if "tools" not in sc:
                sc["tools"] = norm_tools({"bash": sc.pop("bash", True), "mcp": []})
            else:
                sc["tools"] = norm_tools(sc["tools"])
            # Cache-aware compaction replaced the editable idle timeout. A
            # node row that contained only the legacy timeout becomes a clean
            # inherit; enabled/off and the occupancy threshold survive.
            _node_acc = sc.get("auto_cheap_compact")
            if isinstance(_node_acc, dict):
                _node_acc.pop("idle_s", None)
                if not _node_acc:
                    sc.pop("auto_cheap_compact", None)
            # default leans toward visibility, not opaque invisibility (user ruling)
            sc.setdefault("org_visibility", "full")
            sc.setdefault("permission_mode", self.d.get("permission_mode", "acceptEdits"))
            n.setdefault("ui_order", float(i))
            # user ruling 2026-07-31: `purpose` is dropped — charter is the one
            # role statement. Migration folds an old purpose into an empty
            # charter (dropping it silently would strip live agents' identity)
            old_purpose = n.pop("purpose", None)
            if old_purpose and not n.get("charter"):
                n["charter"] = old_purpose
            n.setdefault("charter", None)
            # pre-unification relic: queued texts now persist as mailbox mail
            n.pop("queued_msgs", None)
        if self.d.get("fable_limit_policy") in (None, "retire"):
            self.d["fable_limit_policy"] = "halt"   # 'retire' dropped by user ruling
        # machine-local account routing (user redesign 2026-08-25): the
        # per-org account selection is gone — routing is per model tier,
        # machine-global (accounts.py). Old docs shed the stale key here so
        # nothing can appear selected while nothing reads it.
        self.d.pop("account_token_uuid", None)
        _org_acc = self.d.get("auto_cheap_compact")
        if isinstance(_org_acc, dict):
            # Migration is deliberately ignore-and-remove: old idle duration
            # is not converted into a TTL because only an authoritative
            # provider/auth receipt may start the new expiry clock.
            _org_acc.pop("idle_s", None)
        if self.d.get("fable_filter_policy") not in ("halt", "opus", "auto-autopsy"):
            self.d["fable_filter_policy"] = "halt"  # content-filter flags (user spec)
        if "fable_filter_model" not in self.d or self.d.get("fable_filter_model") == "fable":
            self.d["fable_filter_model"] = "opus"
        # add-only migration (D-084 style): existing orgs reach the new toggle
        # off, same as a brand-new one — never silently on for an old org
        self.d.setdefault("fable_api_fallback", False)
        if not self.d.get("api_fallback") and self.d.get("fable_api_fallback"):
            # the general lane went away (settings, or an old doc from before
            # the coupling was enforced) — an orphaned fable-only toggle would
            # look live but do nothing, which is worse than silently off
            self.d["fable_api_fallback"] = False
        # org-wide agent defaults for hires that don't state them (user hires):
        # every capability enabled — all switches + all MCP servers + full org
        # visibility + the org's folders (user ruling)
        self.d["default_tools"] = norm_tools(
            self.d.get("default_tools", {"mcp": ["*"]}))
        if self.d.get("default_visibility") not in VIS_LEVELS:
            self.d["default_visibility"] = "full"
        self.d.pop("default_dirs", None)   # superseded: org dirs carry modes now
        self.d.setdefault("default_top_grant", 50)   # user ruling: 50 by default
        # §4.6 cost-bubbling toggles (user spec, both ON by default): hires /
        # allocations may pull shortfalls up the chain; off = the payer must
        # afford the action from its own free credits
        self.d.setdefault("cascade_hire", True)
        self.d.setdefault("cascade_alloc", True)
        self.d.setdefault("credit_requests", [])     # top-level asks to the user
        self.d.setdefault("compact_at", 0.80)        # compaction ratio, ≤ 0.95 hard
        # kiosk v2 (user vision): per-org public exposure via a preauthenticated
        # secret-URL token; caps live here, not in env vars. None = never a kiosk.
        self.d.setdefault("kiosk", None)             # {enabled, token, credits,
                                                     #  spend_limit, storage_limit_mb}
        # kiosk permission ceiling (consensus spec §3): pre-ceiling kiosk docs
        # get one MINTED = "what this org already does" — the union of every
        # node's scope ∪ the org's dirs ∪ default_tools. Nothing running is
        # swept; future escalation caps at the status quo; the admin is told.
        _k = self.d.get("kiosk")
        if _k is not None:
            _k.setdefault("auto_raise", False)
            # user report 2026-07-31: the inherited 50-credit default grant,
            # kiosk-clamped to "everything remaining", made the FIRST hire
            # swallow the whole pool — no second agent could ever spawn and
            # the reason was opaque. A default the cap can't even hold was
            # never a chosen default: zero it. In a capped org, grants are
            # deliberate drags; a sub-cap default the admin set survives.
            _cap = int(_k.get("credits") or 0)
            if _cap and int(self.d.get("default_top_grant") or 0) >= _cap:
                self.d["default_top_grant"] = 0
            if not _k.get("max_scope"):
                dt = self.d.get("default_tools") or {}
                mt = norm_tools(dt)
                md = {d["path"]: d["mode"] for d in norm_dirs(self.d.get("dirs"))}
                dv = self.d.get("default_visibility", "full")
                vr = VIS_LEVELS.index(dv) if dv in VIS_LEVELS else len(VIS_LEVELS) - 1
                pr = PM_LEVELS.index("acceptEdits")
                for n in self.nodes.values():
                    sc = n.get("scope") or {}
                    t = sc.get("tools") or {}
                    for key in TOOL_KEYS:
                        if t.get(key, True):
                            mt[key] = True
                    mcp = t.get("mcp") or []
                    if "*" in mcp or "*" in mt["mcp"]:
                        mt["mcp"] = ["*"]
                    else:
                        mt["mcp"] = sorted(set(mt["mcp"]) | set(mcp))
                    for d in sc.get("add_dirs") or []:
                        cur = md.get(d["path"])
                        if cur is None or (cur == "ro" and d["mode"] == "rw"):
                            md[d["path"]] = d["mode"]
                    v = sc.get("org_visibility")
                    if v in VIS_LEVELS:
                        vr = max(vr, VIS_LEVELS.index(v))
                    p = sc.get("permission_mode")
                    if p in PM_LEVELS:
                        pr = max(pr, PM_LEVELS.index(p))
                _k["max_scope"] = {
                    "tools": mt,
                    "add_dirs": [{"path": p, "mode": m} for p, m in md.items()],
                    "org_visibility": VIS_LEVELS[vr],
                    "permission_mode": PM_LEVELS[pr]}
                cev = _mint("access.kiosk_ceiling", actor_of(SYSTEM), self.org_ref())
                self.to_user_inbox({
                    "id": uuid.uuid4().hex[:8], "from": SYSTEM,
                    "kind": "notice", "at": now(),
                    "body": events.render_agent(cev)}, cev)
        # MAIL IDS. Ids arrived after the first mail did, so pre-id entries
        # really do need repairing — they render with no retraction ✕ and 404
        # the DELETE with a false excuse. What changed on 2026-09-03 is WHERE
        # the repair happens, and it is split by what the section COSTS.
        #
        # `user_inbox` (8,614 B) and `mail` (69,311 B) are small and hot, so
        # they keep the original per-load guarantee — `test_ledger.py`'s
        # "legacy node mail gets ids on load" pins exactly that, deliberately,
        # and it is cheap enough to honour unconditionally.
        #
        # `mail_log` is not: 4,792,199 B, 44.4% of the live 10.8 MB document,
        # 2,256 entries (MEASURED). Walking it forced the whole archive into
        # memory on EVERY construction. MEASURED on the JSON backend, the walk
        # ISOLATED from the parse (median of 25, live document): 3.04 ms over
        # 2,310 entries, against 0.07 ms over the 50 that remain. ⚠ That ~3 ms
        # is INVISIBLE end to end there — `json.loads` alone is 37.7 ms and
        # jitters by more than the saving, so an end-to-end `load_org`
        # comparison on JSON shows nothing and would talk you out of this. The
        # SQLite store loads
        # sections lazily and never touches `mail_log` on a plain read, and
        # there the same walk was 35.3 ms on a 12 ms load, single-handedly
        # cancelling the laziness (`sqlite-review`, both backends
        # interleaved). ⚠ MEASURE A CHANGE HERE ON BOTH BACKENDS: the same
        # edit is worth ~9% on one and ~4x on the other, and the JSON number
        # alone would talk you out of it.
        #
        # It was a WRITE cost too, which is the half nobody sees: `setdefault`
        # evaluates `uuid4()` eagerly, so an id-less entry got a DIFFERENT id
        # every construction — under compare-on-save the section then differs
        # from its snapshot every time, and every load+save rewrote the whole
        # 4.4 MB archive with no application change at all.
        for m in self.d.get("user_inbox", []):       # per-mail read tracking needs ids
            m.setdefault("id", uuid.uuid4().hex[:8])
        # non-literal key → cast; the box holds {node: [entry, ...]}
        for ms in cast("dict[str, list[Any]]", self.d.get("mail") or {}).values():
            for m in ms:
                if isinstance(m, dict):
                    # cast: isinstance narrows Any to dict[Unknown, Unknown]
                    cast("dict[str, Any]", m).setdefault(
                        "id", uuid.uuid4().hex[:12])
        self._backfill_mail_log_ids()

        # ☞ NEW TIERS REACH EXISTING ORGS. `Org.create` COPIES the module
        # tables into the doc (`"tiers": dict(TIERS)`), so every org carries
        # its own frozen set and adding a tier to the constant does nothing for
        # any org that already exists — `switch_model` refuses with "unknown
        # tier 'X'; know [...]" while the constant plainly has it. Found live
        # 2026-08-04, the first time a tier was added since the per-org copy
        # was introduced; every test builds fresh orgs, so nothing caught it.
        # (That tier became a model VERSION instead — see MODEL_VERSIONS — but
        # the migration is the general fix and stands on its own.)
        #
        # ⚠ ADD ONLY, never overwrite. The per-org copy is what lets an org
        # price its own seats, and a plain `update` would silently reset a
        # customised table to the shipped defaults on the next load.
        # cast first: OrgDoc is a TypedDict, so a DYNAMIC key is not
        # expressible against it (`setdefault` wants a literal).
        _doc = cast("dict[str, Any]", self.d)
        for key, table in (("tiers", TIERS), ("models", MODELS)):
            cur = cast("dict[str, Any]", _doc.setdefault(key, {}))
            for k, v in table.items():
                cur.setdefault(k, v)
        # ☞ …and the DYNAMIC half of the vocabulary (2026-09-02): OpenRouter
        # favorites are tiers the user mints at runtime (openrouter.py — tier
        # `or-<model>`, seat by the same §3.1 rule), so they reach every org
        # through THIS hook, by the same add-only rule and for the same
        # reason: a favorite added after an org was created must be hireable
        # in it, and a favorite later DESELECTED must keep its row (a node
        # hired on it still holds that seat at that price). Deferred import:
        # openrouter imports store only, but ledger's own import graph stays
        # minimal (the providers precedent below).
        from . import openrouter as _orr        # noqa: PLC0415
        for key, table in (("tiers", _orr.tiers()), ("models", _orr.models())):
            cur = cast("dict[str, Any]", _doc.setdefault(key, {}))
            for k, v in table.items():
                cur.setdefault(k, v)
        # ☞ a price CHANGE (not an addition) needs its own migration under
        # the add-only rule: sonnet 3 → 2 (user ruling 2026-08-12, $2/M input
        # locked in). Only the OLD SHIPPED DEFAULT migrates — any other value
        # is an operator customisation and stays. Effect on a live org is
        # strictly loosening: committed drops by 1 per live sonnet seat, so
        # free rises and no invariant tightens.
        _t = cast("dict[str, Any]", _doc.get("tiers") or {})
        if _t.get("sonnet") == 3:
            _t["sonnet"] = 2
        # ☞ …and the SUB-$1 REPRICING, by the same rule and for the same
        # reason (user ruling 2026-09-03: "if we are supporting fractional
        # credts we should reprice agents that are under $1/m"). gpt-reserve
        # and luna are $0.20/M and used to floor to 1; they now cost 0.2.
        #
        # WITHOUT THIS BLOCK THE REPRICING REACHES NOBODY. `Org.create`
        # snapshots the module table into the doc and the merge above is
        # `setdefault`, so editing the constant is invisible to every org
        # that already exists — measured 2026-09-03: all three live docs on
        # the dev machine carried `gpt-reserve: 1, luna: 1`. That is the same
        # silent no-op the tier-ADD migration above was written for, in its
        # price-change costume.
        #
        # Only the OLD SHIPPED DEFAULT (1) migrates; any other value is an
        # operator's own price and stays. Nothing else has to move with it:
        # a node records `model` and `grant`, NEVER a seat (`seat_cost` reads
        # this very table on every call), so `committed`/`free` re-derive from
        # the new number the moment it lands — there is no stored holding to
        # backfill and no credit quantity is rewritten here.
        for _cheap in ("gpt-reserve", "luna"):
            if _t.get(_cheap) == 1:
                _t[_cheap] = TIERS[_cheap]
        # ☞ …and the SAME REPRICING FOR THE DYNAMIC HALF (user ask 2026-09-04,
        # verbatim: "i was suggesting they be changed to accommodate the new
        # sub-1 credit cost scheme that luna (and reserve) abide by"). An
        # `or-*` favorite adopted before the ruling snapshotted `max(1,
        # floor(p))`, so every OpenRouter model under $1/M was frozen at 1 —
        # measured 2026-09-04 across all three live documents: deepseek-v4-
        # flash-latest ($0.05/M) and glm-5.3-flash ($0.075/M) both sat at 1,
        # while grok-4.6 ($2/M) at 2 and kimi-k3 ($3/M) at 3 were already
        # right. That is the same silent no-op yet again, now in its
        # OpenRouter costume.
        #
        # ⚠ THIS BLOCK IS GENERAL AND THE ONE ABOVE IS NOT, deliberately. The
        # hard-coded `("gpt-reserve", "luna")` pair is exactly why the `or-*`
        # rows were missed: a repricing rule that must be edited every time a
        # tier is added is a rule that will be forgotten every time a tier is
        # added. `stale_seats` is handed this document's OWN tier and model
        # tables and re-derives each row from its model's price, so a favorite
        # minted tomorrow needs no new code here. It cannot be written that
        # way for the static half — those tiers have no price in the document
        # to re-derive from, only a name.
        #
        # It stays a DROP, so the budget half is safe for the same reason the
        # block above is (committed falls, free rises). The ORDERING half is
        # not automatic — see the ⚠ in `_check_tier_ceiling`: an `or-*` tier
        # leaving 1 stops tying with haiku and flash. Verified 2026-09-04, as
        # on 2026-09-03: no live org has a kiosk ceiling set at all.
        _t.update(_orr.stale_seats(_t, cast("dict[str, str]",
                                            _doc.get("models") or {})))
        # ☞ …and a MODEL-ID change needs one for exactly the same reason: the
        # add-only rule above means `MODELS["fable"] = claude-fable-5-1` reaches
        # NO org that already exists — `setdefault` finds the key present and
        # leaves 5.0 there forever, so the new default would ship to nobody and
        # the only evidence would be an org card still reading "claude-fable-5".
        # Same discipline as the sonnet price: migrate ONLY the OLD SHIPPED
        # DEFAULT. Any other string is an operator's own pin (a fixed id in
        # `models` is how you hold a tier still) and is left alone.
        # This is a DEFAULT, not a lock: a node that recorded model_version "5"
        # keeps getting 5.0 through `model_for`, and a machine whose CLI is too
        # old to know the new id is handed 5.0 anyway by
        # `supervisor.claude_model_for`. So the migration is safe to apply
        # before the CLI pin has caught up on any given machine — which it must
        # be, because the two move on different clocks (the doc migrates the
        # instant the new code loads; the CLI migrates when a deploy runs).
        _m = cast("dict[str, Any]", _doc.get("models") or {})
        if _m.get("fable") == clipin.FABLE_5:
            _m["fable"] = clipin.FABLE_5_1
        # ☞ the flash/pro rows moved with the provider lane (2026-09-02: the
        # Antigravity CLI replaced the previous Google lane, and the ids its
        # registry knows are not the ones the old lane pinned). Same rule:
        # only the OLD SHIPPED DEFAULTS migrate — an operator's own pin stays.
        # An org left on the old id would fail every flash/pro turn loudly
        # ("invalid model selection"), so this is what keeps a pre-existing
        # org's flash agents runnable the moment the new code loads.
        if _m.get("flash") == "gemini-3.5-flash":
            _m["flash"] = MODELS["flash"]
        if _m.get("pro") == "gemini-3.1-pro-preview-customtools":
            _m["pro"] = MODELS["pro"]
        # …and the previous lane's resume marker is dead: no lane can resume
        # what it recorded, and `session_id` equal to it would otherwise be
        # taken for a live handle by nothing — dropped so the doc carries no
        # stale marker (the antigravity leg only ever resumes a conversation
        # id it harvested ITSELF, under its own marker).
        for _n in self.nodes.values():
            _n.pop("gemini_session", None)
        # ☞ …and the GRANTS THEMSELVES, for the same reason every migration
        # above exists: the forward fix in `_chain_acquire` reaches only new
        # cascades, and the operator's own coordinator is sitting on 104.2
        # RIGHT NOW with a credit bar it cannot move. A doc that already
        # carries a fractional grant is not repaired by anything else, so it
        # is repaired here (user ruling 2026-09-04: a fractional grant is an
        # invalid state; round UP to the next whole credit).
        #
        # ⚠ UP, NEVER DOWN, and never at spend time. Rounding a grant down
        # would silently take back capacity somebody was granted, which is the
        # one outcome worse than an operation that refuses. Nothing here
        # touches a SEAT: `seat_cost` still reads the tier table, gpt-reserve
        # and luna still cost 0.2, and `free` is still whatever the seats
        # leave over — routinely a fraction, and correct as one.
        #
        # DEEPEST FIRST, and `max(grant, committed)` rather than plain ceil:
        # rounding a child up raises its parent's commitment by the same
        # fraction, so the parent is measured AFTER its children have moved
        # and is lifted to cover them. That keeps `free() >= 0` — the audit
        # invariant — true through the migration instead of merely before it.
        #
        # ⚠ ONCE PER DOCUMENT, and the flag is the whole point — this is the
        # one migration in this hook that must NOT stand as a rule. A
        # `switch_model` MELT still lands a seat difference in a grant, on
        # purpose, so the node's total holding does not move (opus 5 → or-free
        # 0.1 on a 0-grant node leaves grant 0.1 and holding 0.2). Rounding
        # that up costs the PARENT the difference — harmless once, but as a
        # standing rule every switch-and-reload cycle would add up to a credit
        # out of nowhere, which is exactly the slow mint a one-way rounding
        # rule produces. `Org.create` runs this same hook on an empty doc, so
        # a new org is stamped immediately and only documents written before
        # the ruling are ever touched. The melt itself is reported, not
        # changed: it is not mine to redesign.
        #
        # ⚠ AND IT MUST NOT EXPLODE ON A MALFORMED DOCUMENT. This hook runs on
        # EVERY load, including the synthetic and half-written docs the store
        # suites feed it, and `committed`/`seat_cost`/`ancestors` all assume a
        # well-formed node table (a node with no `parent` key raised KeyError
        # out of `Org.__init__` and took `load_org` with it — caught by
        # test_sqlite_store before this landed). So the precondition is stated
        # and checked rather than caught: if any node is missing a field this
        # needs, the repair is SKIPPED AND NOT STAMPED, so a later load of a
        # sound document still performs it.
        if not _doc.get("whole_grants_v1"):
            _sound = all(
                isinstance(_v, dict) and "parent" in _v and "grant" in _v
                and _v.get("model") in (_doc.get("tiers") or {})
                for _v in self.nodes.values())

            def _rank(k: str) -> int:        # depth, cycle-safe, no node() calls
                d, seen = 0, {k}
                cur = self.nodes[k].get("parent")
                while isinstance(cur, str) and cur in self.nodes and cur not in seen:
                    seen.add(cur)
                    d += 1
                    cur = self.nodes[cur].get("parent")
                return -d

            if _sound:
                for _nid in sorted(self.nodes, key=_rank):
                    _n = self.nodes[_nid]
                    _want = math.ceil(_q(max(float(_n.get("grant") or 0),
                                             self.committed(_nid))))
                    if _want != _n.get("grant"):
                        _n["grant"] = _want
                _doc["whole_grants_v1"] = True
        # pre-№41 spend freezes wrote the usage-limit keys (error, until=None);
        # re-tag them so clear_hard_freeze("spend") actually clears them
        # instead of leaving a stale-reason freeze the API reports as cleared
        for n in self.nodes.values():
            fz = n.get("frozen")
            # ⚠ `until_ts` is checked as well as `until`: the CLI's usual
            # wording carries only an epoch, so a genuine usage-limit freeze
            # routinely has a machine time and no human one. Together with the
            # `limit` kind flag (FrozenInfo) this stops the retag eating a real
            # usage-limit freeze and making it permanently unresumable.
            if (isinstance(fz, dict) and fz.get("error") and not fz.get("until")
                    and not fz.get("until_ts") and not fz.get("resume_texts")
                    and not any(v is True for v in fz.values())):
                fz["spend"] = True
                fz["spend_error"] = fz.pop("error")
                fz.pop("until", None)
        # FABLE-2 (redteam + user report 2026-08-06): a fable_lock that
        # recorded a reset time releases itself once it passes — the same
        # rule the per-node freeze follows. (The timeless-waits-for-the-user
        # rule lasted one commit — see STUCK-1 below: timeless now MEANS
        # artifact.) FABLE-3: the halt was LOUD (parent asked to
        # cover the work, peers and the node told), so the release
        # announces itself to the same parties. Announcing from a load hook
        # is safe for the same reason the release is: the TRIGGER (the
        # lock) is consumed in the same mutation, so once any save persists
        # this copy no later load re-announces, and unsaved copies die with
        # their load and re-derive identically — every reader sees exactly
        # one announcement. (Redteam-measured 2026-08-06: five unsaved
        # reads move nothing on disk; the first save persists exactly one
        # copy; later save cycles add nothing.)
        # ※ An unsaved reader's release being INVISIBLE on disk is the
        # property that makes this safe, not a bug — do NOT "fix" it by
        # saving from this hook, which would turn every read into a write.
        # STUCK-1 (user report 2026-08-06: already-halted fable agents could
        # not be unfrozen — the d40dd82 fix was forward-only). A TIMELESS
        # lock is by construction a pre-fix artifact: since d40dd82 the
        # escalation always stamps until_ts (the freeze parses a reset or
        # takes the 300 s probe floor BEFORE fable_limit_hit runs), so no
        # new lock can be timeless — and most on-disk timeless locks were
        # written by the misread itself (a session limit recorded as weekly
        # exhaustion). Release them rather than back-date: back-dating keeps
        # agents halted for a limit that was never hit.
        # ⚠ …EXCEPT a lock that positively says its reset time is UNKNOWN
        # (`no_reset`). Added 2026-08-07 with the captured Fable-tier message
        # (neoja, live): "You've reached your Fable 5 limit. Run
        # /usage-credits to continue or switch models with /model." — it
        # carries NO horizon at all, so the assumption above ("no new lock
        # can be timeless") stopped being true the moment the escalation
        # started firing on it. Without this marker such a lock is
        # indistinguishable from a pre-fix artifact and gets released on the
        # very next load. `no_reset` is the difference between "nobody told
        # this lock when it ends" and "this lock predates the field": the
        # first waits for the user, who now HAS controls for it (the ⚙ clear
        # and the per-node unstick override) — which is what the original
        # timeless-waits-for-the-user rule assumed and did not yet have.
        _fl = self.d.get("fable_lock") or {}
        if _fl and not _fl.get("no_reset") and (
                not _fl.get("until_ts")
                or _time.time() >= float(_fl["until_ts"])):
            _freed = [k for k, v in self.nodes.items()
                      if v.get("limit_locked")]
            self.d.pop("fable_lock", None)
            for n in self.nodes.values():
                n.pop("limit_locked", None)
            for k in _freed:
                _p = self.nodes[k]["parent"]
                # typed (family lifecycle): policy.limit_reset per audience
                self._notify_ev([_p], self._limit_reset_ev(k, "report", []))
                self._notify_ev(self._peers_of(_p, k), self._limit_reset_ev(k, "peer", []))
                self._notify_ev([k], self._limit_reset_ev(k, "self", []))
            if _freed:
                uev = self._limit_reset_ev(sorted(_freed)[0], "user", sorted(_freed))
                self.to_user_inbox({
                    "from": SYSTEM, "kind": "notice", "at": now(),
                    "body": events.render_agent(uev)}, uev)
        # …and ORPHANED node flags (redteam 2026-08-06, the neoja card): a
        # limit_locked with NO fable_lock behind it is the same artifact
        # class as the timeless lock — the org lock went away without the
        # node sweep, and resume_frozen skips flagged nodes forever, so a
        # healthy freeze underneath advertised a reset that could never
        # fire ("resumes 3pm", waits past 3pm, nothing). No announcement:
        # the freeze underneath resumes through its own machinery.
        if not self.d.get("fable_lock"):
            for n in self.nodes.values():
                n.pop("limit_locked", None)
        # org holdings carry RW/RO modes (user ruling — configured on the eye's
        # gear, mirroring per-agent folder access); legacy string lists migrate
        self.d["dirs"] = norm_dirs(self.d.get("dirs"))
        # migrate pre-typed-actor docs: bare 'user'/'system' sentinels → @-forms
        # (safe exactly once, before any agent may be NAMED user/system)
        if not self.d.get("_actors_typed"):
            for a in self.d.get("audiences", []):
                if a.get("grantor") == "user":
                    a["grantor"] = USER
            for r in self.d.get("audience_requests", []):
                for f in ("target", "currently_at"):
                    if r.get(f) == "user":
                        r[f] = USER
            for m in self.d.get("user_inbox", []):
                if m.get("from") in ("system", "user"):
                    m["from"] = SYSTEM if m["from"] == "system" else USER
            self.d["_actors_typed"] = True

    # ---------------------------------------------------------------- factory
    @staticmethod
    def create(name: str, dirs: list[str] | None = None,
               permission_mode: str = "acceptEdits",
               workspace: str | None = None) -> "Org":
        # D-030 hardening: an arbitrary string here used to reach
        # --permission-mode verbatim
        if permission_mode not in PM_LEVELS:
            raise LedgerError(f"permission_mode must be one of {PM_LEVELS}")
        return Org({
            "version": 1,
            "slug": slugify(name),
            "name": name,
            "created": now(),
            "tiers": dict(TIERS),
            "models": dict(MODELS),
            # The org's own workspace dir, minted at creation (store.py makes it).
            "workspace": workspace,
            # №30: the default capability set granted to top-level hires —
            # the workspace plus any explicitly granted existing dirs, each
            # with an RW/RO mode.
            "dirs": norm_dirs(dirs),
            "permission_mode": permission_mode,   # №5: acceptEdits + --add-dir recipe
            # agent defaults (user hires that don't state them): everything on
            "default_tools": norm_tools({"mcp": ["*"]}),
            "default_visibility": "full",
            "max_top_grant": 1000,                # UI slider cap for user-level hires
            "default_top_grant": 50,              # pre-filled grant for top-level hires
            "credit_requests": [],                # §: top-level asks to the user
            "compact_at": 0.80,                   # compaction ratio (≤ 0.95 hard cap)
            "fable_limit_policy": "halt",         # halt | opus | dissolve (user ruling)
            "fable_filter_policy": "halt",        # halt | opus | auto-autopsy — filter flags (user spec)
            "fable_filter_model": "opus",         # model tier when policy == auto-autopsy
            "fable_api_fallback": False,          # user feature 2026-08-23 (needs
                                                  # api_fallback + api_key too)
            "nodes": {},
            "audiences": [],          # §7.3 — [{grantee, grantor, granted_at, reason}]
            # (a "chain_notices" key was seeded here and READ BY NOTHING. §7.4
            #  chain notices are ledger.user_deep_reach() writing into the
            #  normal `notices` box. The empty key shadowed the working
            #  feature well enough to convince one session it was unbuilt,
            #  so it is gone rather than reserved.)
            "audience_requests": [],  # §7.3
            "events": [],             # audit log of ops
        })

    # ---------------------------------------------------------------- queries
    @property
    def nodes(self) -> dict[str, NodeDoc]:
        return self.d["nodes"]

    def node(self, nid: str) -> NodeDoc:
        try:
            return self.nodes[nid]
        except KeyError:
            raise LedgerError(f"no such node: {nid!r}")

    def seat_cost(self, nid: str) -> float:
        return self.d["tiers"][self.node(nid)["model"]]

    def children_index(self) -> dict[str | None, list[str]]:
        """`parent → [nid]`, one pass over `nodes`, for a caller that is about
        to ask about EVERY node.

        `children` answers one parent by scanning the whole node table, which
        is right for the 36 call sites that ask about one node and wrong for
        `tree`, which asks about all of them: that is O(n²), and at 140 nodes
        it is 19,600 comparisons plus a sort per node. MEASURED 2026-09-03 on
        the live org, py-spy: `tree()` cost 0.34 s of a ~1 s request, and
        `org_children` → `children` was 0.28 s of it.

        The redteam raised this on 2026-08-06 and the ruling was "not relevant
        until the typical execution time exceeds one second". It is still
        under that bar and this changes nothing about the ruling — it is taken
        now only because the request around it became user-visible and this is
        an eighth of it, with no behaviour to get wrong.

        ⚠ AN ACCELERATOR, NEVER A SECOND ANSWER. It is passed BACK INTO
        `children`, which still applies the same state filter and the same
        sort to it, so there is exactly one definition of what a child is and
        what order they come in. Reimplementing the filter here would be the
        two-expressions-of-one-rule mistake this file objects to elsewhere,
        and the copy would drift the first time `live_only` grew a case.
        """
        idx: dict[str | None, list[str]] = {}
        for k, v in self.nodes.items():
            idx.setdefault(v["parent"], []).append(k)
        return idx

    def children(self, nid: str | None, live_only: bool = True,
                 index: dict[str | None, list[str]] | None = None) -> list[str]:
        # "live" for budget purposes includes unrecoverable — a broken session still
        # holds its seat until deliberately retired (№31)
        #
        # `index` (see `children_index`) only supplies the candidates — the
        # same ones the scan would have found, partitioned by the same key.
        # Everything that DECIDES anything is below it and runs either way.
        cand = (index.get(nid, ()) if index is not None
                else [k for k, v in self.nodes.items() if v["parent"] == nid])
        kids = [k for k in cand
                if self.nodes[k]["state"] != "archived" or not live_only]
        kids.sort(key=lambda k: (self.nodes[k].get("ui_order", 0), self.nodes[k]["created"]))
        return kids

    def committed(self, nid: str) -> float:
        # _q: the two totals below are the ONLY places credit quantities are
        # summed, so quantising here is what keeps every reachable value on
        # the 0.01 grid (CREDIT_PLACES) and the `free() >= 0` invariant exact
        return _q(sum(self.seat_cost(c) + self.nodes[c]["grant"]
                      for c in self.children(nid)))

    def free(self, nid: str) -> float:
        if nid == USER:
            return math.inf
        return _q(self.node(nid)["grant"] - self.committed(nid))

    def parent(self, nid: str) -> str:
        """Parent id, with USER standing in for None (top level)."""
        p = self.node(nid)["parent"]
        return USER if p is None else p

    def ancestors(self, nid: str) -> list[str]:
        """Ancestor chain from immediate parent up to USER (inclusive).
        Total over the sentinel: ancestors(USER) is [] — callers holding a
        parent() result can pass it straight back without exploding."""
        if nid == USER:
            return []
        out: list[str] = []
        seen = {nid}
        cur = self.node(nid)["parent"]
        # the `seen` guard is pure defense: every op that can re-parent already
        # refuses a cycle, so on well-formed data this is identical. On a
        # corrupted doc it is the difference between a wedged process and a
        # short list — `while cur is not None` never terminates on a loop, and
        # ancestors() is under depth()/is_ancestor()/tree(), i.e. everything.
        while cur is not None and cur not in seen:
            out.append(cur)
            seen.add(cur)
            cur = self.nodes[cur]["parent"]
        out.append(USER)
        return out

    def is_ancestor(self, a: str, nid: str) -> bool:
        """True if `a` is a strict ancestor of node `nid` (USER is ancestor of all).
        Total over the sentinel: nothing is a strict ancestor of USER."""
        if nid == USER:
            return False
        return a == USER or a in self.ancestors(nid)

    def org_children(self, nid: str | None,
                     index: dict[str | None, list[str]] | None = None
                     ) -> list[str]:
        """Children on the ORG axis only — an ARCHIVED lineage predecessor
        shares the parent slot but is not an organizational child (§8.5).

        User ruling 2026-08-12: the `successor` link stays, but it is not on
        its own enough to hide a node. A predecessor that has been REHIRED is
        a working agent — it takes turns, spends credits and answers mail like
        any report — and the filter used to drop it from the org axis on the
        strength of the link alone. That cost the operator the whole point of
        the axis: a live, spending session with no card, no desk tab and no
        controls, which the neoja org hit as a canvas crash (a node in the
        map that `layout` never placed). So the test is retired AND
        succeeded, not succeeded alone.

        "Retired" is taken at the ruling's word (redteam deviation catch,
        2026-08-12): the first cut tested `state != "live"`, which also hid
        an UNRECOVERABLE generation — the state whose own notice says
        "rehire to re-seed, or retire to free the credits", i.e. precisely a
        node the operator must be able to reach. Off the axis it rendered
        NOWHERE when its successor was archived (a pseudo-card positions
        only via a placed successor): an unreachable node holding a seat.
        Archived is the one state that steps off the axis."""
        return [k for k in self.children(nid, live_only=False, index=index)
                if not (self.nodes[k].get("successor")
                        and self.nodes[k]["state"] == "archived")]

    def lineage_stack(self, nid: str) -> list[str]:
        """Predecessor chain of nid, newest first."""
        out: list[str]
        out, cur = [], self.node(nid).get("predecessor")
        # same guard as ancestors(), and here it was measured: a `predecessor`
        # loop made this spin FOREVER (no RecursionError, no return), wedging
        # tree(), dissolve(), delete() and _move()'s bearer check with it.
        # Unreachable from the API (compact_split/reseed always mint a fresh
        # `<nid>@<gen>` with a rising generation) — reachable from a corrupted
        # or hand-edited doc, which is exactly when you want a process back.
        seen = {nid}
        while cur and cur in self.nodes and cur not in seen:
            out.append(cur)
            seen.add(cur)
            cur = self.nodes[cur].get("predecessor")
        return out

    def descendants(self, nid: str, live_only: bool = True) -> list[str]:
        out: list[str] = []
        for c in self.children(nid, live_only):
            out.append(c)
            out.extend(self.descendants(c, live_only))
        return out

    def depth(self, nid: str) -> int:
        return len(self.ancestors(nid)) - 1  # USER at depth -1's child = 0

    def effective_dirs(self, nid: str | None) -> dict[str, str] | None:
        """Capability map {path: mode} of a prospective parent. None = everything (user)."""
        if nid is None or nid == USER:
            return None
        return {d["path"]: d["mode"] for d in self.node(nid)["scope"]["add_dirs"]}

    @staticmethod
    def _clamp_tools(requested: Mapping[str, Any] | None,
                     parent_tools: Mapping[str, Any] | None,
                     strict: bool, who: str = "parent",
                     ) -> tuple[ToolGrant, list[str]]:
        """Bound a tool grant by the parent's own: an agent cannot pass on a tool or
        MCP server it does not itself hold. parent_tools None = the user (everything)."""
        req = norm_tools(requested)
        if parent_tools is None:
            return req, []
        lost: list[str] = []
        for k in TOOL_KEYS:
            if req[k] and not parent_tools.get(k, True):
                if strict:
                    raise LedgerError(f"{who} does not hold {k!r}; cannot grant it")
                req[k] = False
                lost.append(k)
        # "*" = the universal server set: ∩ with a concrete parent list = that list
        phold = parent_tools.get("mcp", [])
        if "*" in req["mcp"]:
            req["mcp"] = ["*"] if "*" in phold else sorted(set(phold))
        elif "*" not in phold:
            held = set(phold)
            extra = [s for s in req["mcp"] if s not in held]
            if extra:
                if strict:
                    raise LedgerError(
                        f"{who} does not hold MCP server(s) {extra}; cannot grant")
                req["mcp"] = [s for s in req["mcp"] if s in held]
                lost += [f"mcp:{s}" for s in extra]
        return req, lost

    @staticmethod
    def _clamp_dirs(requested: list[DirGrant], parent_map: Mapping[str, str] | None,
                    strict: bool, who: str = "the parent",
                    ) -> tuple[list[DirGrant], list[str]]:
        """Intersect a dir list with a capability map, downgrading rw→ro where the
        holder only holds ro. strict=True raises instead of dropping (hire-time).

        `who` names the holder in the refusal. It matters since D-106 moved
        set_scope's referent from the target's PARENT to the GRANTER's own
        holdings: an agent told "the parent does not hold it" would go and
        inspect the wrong node. `hire` still says "the parent", correctly.
        """
        if parent_map is None:
            return list(requested), []

        def _held_mode(path: str) -> str | None:
            """The mode the holder's set confers on `path`: an exact entry,
            or the entry of any held ANCESTOR tree — №30 names TREES, and
            holding a tree is holding every subtree of it. The lookup used
            to be exact-key only, which refused a parent holding C:\\ the
            grant of a folder UNDER it (live-hit 2026-09-01): narrowing was
            impossible and every refusal pushed toward over-granting, the
            opposite of the clamp's purpose. rw wins when several held
            trees cover the path."""
            want = os.path.normcase(os.path.normpath(path))
            best: str | None = None
            for hp, hm in parent_map.items():
                base = os.path.normcase(os.path.normpath(hp)).rstrip("\\/")
                if want == base or want.startswith(base + os.sep):
                    if hm == "rw":
                        return "rw"
                    best = "ro"
            return best

        kept: list[DirGrant] = []
        lost: list[str] = []
        for d in requested:
            held = _held_mode(d["path"])
            if held is None:
                if strict:
                    raise LedgerError(
                        f"cannot grant dirs {who} does not hold (№30): [{d['path']!r}]")
                lost.append(d["path"])
            elif held == "ro" and d["mode"] == "rw":
                if strict:
                    raise LedgerError(
                        f"{who} holds {d['path']!r} read-only; cannot grant "
                        f"read/write (№30)")
                kept.append({"path": d["path"], "mode": "ro"})
                lost.append(f"{d['path']} (downgraded to ro)")
            else:
                kept.append(cast(DirGrant, dict(d)))  # dict() copy loses the TypedDict
        return kept, lost

    # ----------------------------------------------- kiosk permission ceiling
    # Consensus spec 2026-07-31: a kiosk carries the MAXIMUM permission layer
    # grantable to any agent in it; within it, all retooling/hiring permission
    # ops are permitted (visitors clamp-with-warning, never a 403). Normal
    # orgs have no ceiling — the top-level agent's own layer already is one.
    # `raise_ceiling` threads the one gateway-conferred CAPABILITY (not an
    # identity): "this call is authorized to, and intends to, raise the
    # ceiling to fit". Fail-closed default; agents can never pass it.

    def kiosk_ceiling(self) -> dict[str, Any] | None:
        k = self.d.get("kiosk")
        return (k or {}).get("max_scope") or None

    def default_kiosk_ceiling(self) -> dict[str, Any]:
        """Fresh-kiosk ceiling (spec §3): all built-ins ON, mcp "*" (user
        ruling — continuity with default_tools; the create dialog surfaces the
        ceiling so narrowing is a conscious act), the org's own dirs, full
        visibility, acceptEdits."""
        return {"tools": norm_tools({"mcp": ["*"]}),
                "add_dirs": norm_dirs(self.d.get("dirs")),
                "org_visibility": "full", "permission_mode": "acceptEdits"}

    def _norm_ceiling(self, ms: Mapping[str, Any] | None) -> dict[str, Any]:
        ms = ms or {}
        vis = ms.get("org_visibility", "full")
        if vis not in VIS_LEVELS:
            raise LedgerError(f"ceiling org_visibility must be one of {VIS_LEVELS}")
        pm = ms.get("permission_mode", "acceptEdits")
        if pm not in PM_LEVELS:
            raise LedgerError(f"ceiling permission_mode must be one of {PM_LEVELS}")
        mt = ms.get("max_tier") or None
        if mt is not None and mt not in TIERS:
            raise LedgerError(f"ceiling max_tier must be one of {sorted(TIERS)} "
                              f"(or unset for no cap)")
        return {"tools": norm_tools(ms.get("tools", {"mcp": ["*"]})),
                "add_dirs": norm_dirs(ms.get("add_dirs")),
                "org_visibility": vis, "permission_mode": pm,
                "max_tier": mt}

    def _check_tier_ceiling(self, tier: str) -> None:
        """Kiosk tier cap (user spec 2026-07-31: "no fable agents at all"):
        a HARD refusal for every actor — agents can't spawn above the cap and
        neither can direct API calls; the admin changes the cap itself in
        kiosk settings. No raise_ceiling bridge here: a cost cap should never
        rise as a side effect of a hire.

        ⚠ THIS IS THE ONE PLACE A SEAT IS AN ORDERING RATHER THAN A BUDGET,
        which is why the sub-$1 repricing (2026-09-03) is not the pure
        loosening the rest of the ledger sees. Everywhere else a cheaper seat
        only frees capacity; here it can REFUSE a hire that used to pass, by
        breaking a TIE. Before the repricing haiku·flash·gpt-reserve·luna all
        sat at 1, so `max_tier="luna"` admitted haiku — a model five times
        luna's price — because 1 > 1 is false. At luna 0.2 that tie is gone
        and haiku is correctly refused. That is a fix, not a regression (the
        floor-to-1 tie-collapse was the same information loss the repricing
        exists to undo), but it IS a behaviour change on a saved ceiling, so
        it is pinned by test rather than left to be discovered. Measured
        2026-09-03: no live org had a kiosk ceiling set at all, so nothing
        real changed on the day."""
        mt = (self.kiosk_ceiling() or {}).get("max_tier")
        cap = TIERS[mt] if mt in TIERS else None
        seat = self._ceiling_seat(tier)
        if cap is not None and seat is not None and seat > cap:
            raise LedgerError(
                f"the kiosk ceiling caps agent tier at {mt} — {tier} agents "
                f"cannot be hired, rehired or switched to in this org "
                f"(admins change this in kiosk settings)")

    def _ceiling_seat(self, tier: str) -> float | None:
        """The seat `tier` brings to the CEILING ORDERING, or None if it has
        no place in that ordering at all.

        ⚠ THE `or-*` HALF WAS INVISIBLE HERE UNTIL 2026-09-04, and the cap
        silently admitted everything it names. `_check_tier_ceiling` asked
        `tier in TIERS` against the MODULE table, which holds the eleven
        static bands and never an OpenRouter tier — those are minted at
        runtime and live only in the per-org `d["tiers"]`. So the test was
        skipped, not failed: MEASURED on this code, a `max_tier="haiku"`
        (seat 1) kiosk admitted an `or-moonshotai-kimi-k3` (seat 3) at hire,
        at switch_model and at plain rehire, while correctly refusing a
        static opus (seat 5). An API-layer gate hid most of it
        (`api.provider_hire_gate` refuses OpenRouter tiers in kiosk orgs
        outright) but that gate is explicitly temporary — "until its
        sandboxing is settled" — and the plain-rehire door skips it by
        design, so the ledger was NOT carrying the guarantee its own
        docstring claims for every actor.

        WHICH TABLE EACH SIDE READS, and why it is not one table:
          · a STATIC tier keeps reading the module `TIERS`. Reading the
            document for it too would be tidier, but a document may carry an
            operator's OWN price for a static band (the authority suite has a
            fixture with `terra: 7`), and re-pricing the ceiling off that
            would change refusals for orgs that have nothing to do with
            OpenRouter. Out of scope, deliberately.
          · an `or-*` tier reads `self.d["tiers"]` — the SAME table
            `seat_cost` charges from, so the ordering and the bill agree by
            construction. There is nowhere else it could read: the module
            table has no row to offer.

        Both sides are seats on one credit scale, quantised to 0.01, so the
        comparison is well defined; `>` stays STRICT, so an `or-*` seat equal
        to the cap is admitted exactly as flash is admitted under a haiku cap.

        None means "not in the ordering", and the caller then refuses
        nothing — the same fail-open the module-table test had for an unknown
        tier. An `or-*` tier absent from the document cannot reach here from a
        real door anyway: `hire` and `switch_model` both refuse an unknown
        tier against `self.d["tiers"]` before the ceiling runs."""
        if tier in TIERS:
            return TIERS[tier]
        from . import openrouter as _orr        # noqa: PLC0415 — as the load hook
        if _orr.is_tier(tier):
            v = (self.d.get("tiers") or {}).get(tier)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return float(v)
        return None

    def _apply_ceiling(self, tools: ToolGrant | None = None,
                       dirs: list[DirGrant] | None = None,
                       vis: str | None = None, pm: str | None = None,
                       raise_ceiling: bool = False,
                       warnings: list[str] | None = None,
                       ) -> tuple[ToolGrant | None, list[DirGrant] | None,
                                  str | None, str | None, bool]:
        """The second clamp pass, against the kiosk ceiling (parent ∩ ceiling
        at depth — the parent clamp already ran). Returns
        (tools, dirs, vis, pm, bridged): bridged=True means something was
        clamped that raise_ceiling=True would have admitted — the caller
        surfaces the one-action bridge. With raise_ceiling, the ceiling grows
        to the union instead (determinate), logged and named, never silent."""
        ceil = self.kiosk_ceiling()
        if ceil is None:
            return tools, dirs, vis, pm, False
        if raise_ceiling:
            self._raise_ceiling_for(tools, dirs, vis, pm, warnings)
            return tools, dirs, vis, pm, False
        lost_all: list[str] = []
        if tools is not None:
            had_star = "*" in (norm_tools(tools).get("mcp") or [])
            tools, tl = self._clamp_tools(tools, ceil["tools"], strict=False)
            lost_all += tl
            if had_star and "*" not in tools["mcp"]:
                # §6: "*" may survive only under a "*" ceiling; a list ceiling
                # materializes it — name the semantic change (future registry
                # additions will NOT auto-flow to this agent)
                lost_all.append("mcp:* (materialized to the ceiling's list)")
        if dirs is not None:
            cmap = {d["path"]: d["mode"] for d in ceil.get("add_dirs", [])}
            dirs, dl = self._clamp_dirs(dirs, cmap, strict=False)
            lost_all += [str(x) for x in dl]
        if vis is not None and vis in VIS_LEVELS:
            cv = ceil.get("org_visibility", "full")
            if cv in VIS_LEVELS and VIS_LEVELS.index(vis) > VIS_LEVELS.index(cv):
                lost_all.append(f"org_visibility {vis}→{cv}")
                vis = cv
        if pm is not None and pm in PM_LEVELS:
            cp = ceil.get("permission_mode", "acceptEdits")
            if cp in PM_LEVELS and PM_LEVELS.index(pm) > PM_LEVELS.index(cp):
                lost_all.append(f"permission_mode {pm}→{cp}")
                pm = cp
        if lost_all:
            if warnings is not None:
                warnings.append(
                    "clamped to the kiosk permission ceiling: "
                    + ", ".join(lost_all))
            return tools, dirs, vis, pm, True
        return tools, dirs, vis, pm, False

    def _raise_ceiling_for(self, tools: ToolGrant | None,
                           dirs: list[DirGrant] | None, vis: str | None,
                           pm: str | None, warnings: list[str] | None) -> None:
        """Grow max_scope to the union of itself and the request — the
        determinate bridge. Logged and returned as a warning NAMING what rose;
        a ceiling must never rise silently."""
        # only reached while a ceiling exists, so kiosk/max_scope are non-None
        ms: dict[str, Any] = self.d["kiosk"]["max_scope"]  # type: ignore[index]
        rose: list[str] = []
        if tools is not None:
            t = norm_tools(tools)
            ct = ms["tools"]
            for key in TOOL_KEYS:
                if t[key] and not ct.get(key, True):
                    ct[key] = True
                    rose.append(key)
            if "*" in t["mcp"] and "*" not in ct["mcp"]:
                ct["mcp"] = ["*"]
                rose.append("mcp:*")
            elif "*" not in ct["mcp"]:
                extra = [s for s in t["mcp"] if s not in ct["mcp"]]
                if extra:
                    ct["mcp"] = sorted(set(ct["mcp"]) | set(extra))
                    rose += [f"mcp:{s}" for s in extra]
        if dirs is not None:
            held = {d["path"]: d for d in ms["add_dirs"]}
            for d in dirs:
                cur = held.get(d["path"])
                if cur is None:
                    ms["add_dirs"].append({"path": d["path"], "mode": d["mode"]})
                    rose.append(d["path"])
                elif cur["mode"] == "ro" and d["mode"] == "rw":
                    cur["mode"] = "rw"
                    rose.append(f"{d['path']} (rw)")
        if vis in VIS_LEVELS:
            cv = ms.get("org_visibility", "full")
            if cv in VIS_LEVELS and VIS_LEVELS.index(vis) > VIS_LEVELS.index(cv):
                ms["org_visibility"] = vis
                rose.append(f"org_visibility {vis}")
        if pm in PM_LEVELS:
            cp = ms.get("permission_mode", "acceptEdits")
            if cp in PM_LEVELS and PM_LEVELS.index(pm) > PM_LEVELS.index(cp):
                ms["permission_mode"] = pm
                rose.append(f"permission_mode {pm}")
        if rose:
            self._log("ceiling_raise", USER, {"raised": rose}, [])
            if warnings is not None:
                warnings.append("kiosk ceiling RAISED to fit: " + ", ".join(rose))

    def set_kiosk_ceiling(self, max_scope: dict[str, Any],
                          auto_raise: bool | None = None) -> dict[str, Any]:
        """Admin sets/lowers the ceiling. Lowering SWEEPS (spec §5): the end
        state is unique — clamp every node's stored scope against the new
        ceiling — so it automates; refusal-with-directions would be the
        anti-pattern the bypass principle names. Affected live agents are told
        what they lost and why."""
        k = self.d.get("kiosk")
        if k is None:
            raise LedgerError(
                "this org is not a kiosk — normal orgs have no ceiling (the "
                "top-level agent's own layer already bounds its subtree)")
        ms = self._norm_ceiling(max_scope)
        k["max_scope"] = ms
        if auto_raise is not None:
            k["auto_raise"] = bool(auto_raise)
        swept: dict[str, list[str]] = {}
        cmap = {d["path"]: d["mode"] for d in ms["add_dirs"]}
        for nid, n in self.nodes.items():
            sc = n.get("scope") or {}
            loss: list[str] = []
            had_star = "*" in (sc.get("tools", {}).get("mcp") or [])
            t2, tl = self._clamp_tools(sc.get("tools"), ms["tools"], strict=False)
            loss += tl
            if had_star and "*" not in t2["mcp"]:
                loss.append("mcp:* (materialized)")
            d2, dl = self._clamp_dirs(sc.get("add_dirs") or [], cmap, strict=False)
            loss += [str(x) for x in dl]
            sc["tools"], sc["add_dirs"] = t2, d2
            v = sc.get("org_visibility")
            if v in VIS_LEVELS and VIS_LEVELS.index(v) > VIS_LEVELS.index(ms["org_visibility"]):
                sc["org_visibility"] = ms["org_visibility"]
                loss.append(f"org_visibility {v}→{ms['org_visibility']}")
            p = sc.get("permission_mode")
            if p in PM_LEVELS and PM_LEVELS.index(p) > PM_LEVELS.index(ms["permission_mode"]):
                sc["permission_mode"] = ms["permission_mode"]
                loss.append(f"permission_mode {p}→{ms['permission_mode']}")
            if loss:
                swept[nid] = loss
                if n["state"] == "live" and not n.get("successor"):
                    self._notify_ev([nid], _mint("access.kiosk_clamped", actor_of(USER),
                                                 self.node_ref(nid), lost=list(loss)))
        self._log("ceiling_set", USER, {"swept": swept}, [])
        warnings = ([f"ceiling lowered — {len(swept)} agent(s) "
                     f"clamped to fit: {sorted(swept)}"]
                    if swept else [])
        # tier cap: no model sweep — downgrading live agents moves seats and
        # credits around (side effects the admin should choose per agent), so
        # existing over-cap agents stay and the cap blocks NEW use only. Named
        # here so nothing is silent.
        #
        # ⚠ COUNTED THROUGH `_ceiling_seat`, NOT THE MODULE TABLE. These two
        # scans are the admin's only view of what a new cap has just stranded,
        # and `TIERS.get(n["model"], 0)` scored every `or-*` agent at 0 — so a
        # cap set over a room full of OpenRouter agents reported "0 above" and
        # the admin acted on a number that was counting a different question.
        # It has to be the same comparison the refusal uses or the report is
        # about a rule that is not the rule.
        mt = ms.get("max_tier")
        if mt in TIERS:
            over = sorted(i for i, n in self.nodes.items()
                          if n["state"] == "live"
                          and (self._ceiling_seat(n["model"]) or 0) > TIERS[mt])
            if over:
                warnings.append(
                    f"{len(over)} live agent(s) above the {mt} tier cap "
                    f"remain ({', '.join(over)}) — the cap blocks new hires, "
                    f"rehires and switches; switch or retire them as you "
                    f"see fit")
            # …and the ARCHIVED ones, which used to be reported nowhere. They
            # are the worse case: rehire hard-refuses on the cap and
            # switch_model needs a live node, so an archived over-cap agent is
            # STRANDED — recoverable only by raising the cap again — and the
            # admin was told nothing at all.
            stuck = sorted(i for i, n in self.nodes.items()
                           if n["state"] == "archived"
                           and (self._ceiling_seat(n["model"]) or 0) > TIERS[mt])
            if stuck:
                warnings.append(
                    f"{len(stuck)} ARCHIVED agent(s) above the {mt} tier cap "
                    f"({', '.join(stuck)}) can no longer be rehired at their "
                    f"own tier — rehire them with a cheaper tier= override, or "
                    f"raise the cap")
        return {"max_scope": ms, "swept": swept, "warnings": warnings}

    def set_hire_defaults(self, default_tools: Mapping[str, Any] | None = None,
                          default_visibility: str | None = None,
                          permission_mode: str | None = None,
                          raise_ceiling: bool = False) -> dict[str, Any]:
        """The org's agent-hire defaults (the eye's gear). Kiosk VISITORS may
        set these too (user ruling 2026-07-31) — a default is just a pre-filled
        grant, so the ceiling clamps it with the same machinery as any grant;
        admins get the bridge/auto-raise semantics. Hire-time still re-clamps
        (defaults resolve THEN clamp), so this is honesty, not enforcement:
        the stored default must never show a capability no hire can receive."""
        warnings: list[str] = []
        bridged = False
        if default_tools is not None:
            t = norm_tools(default_tools)
            t, _d, _v, _p, b = self._apply_ceiling(
                tools=t, raise_ceiling=raise_ceiling, warnings=warnings)
            self.d["default_tools"] = cast(ToolGrant, t)  # tools in ⇒ tools out
            bridged = bridged or b
        if default_visibility is not None:
            if default_visibility not in VIS_LEVELS:
                raise LedgerError(f"default_visibility must be one of {VIS_LEVELS}")
            _t, _d, v2, _p, b = self._apply_ceiling(
                vis=default_visibility, raise_ceiling=raise_ceiling,
                warnings=warnings)
            self.d["default_visibility"] = cast(str, v2)  # vis in ⇒ vis out
            bridged = bridged or b
        if permission_mode is not None:
            # the org's BORN-WITH mode: `_new_node` reads `d["permission_mode"]`
            # into every hire's scope. Existing nodes keep the mode they were
            # born with — each is changed on its own in the ⚙ panel — so this
            # is a default, never a retroactive grant.
            if permission_mode not in PM_LEVELS:
                raise LedgerError(f"permission_mode must be one of {PM_LEVELS}")
            _t, _d, _v, p2, b = self._apply_ceiling(
                pm=permission_mode, raise_ceiling=raise_ceiling,
                warnings=warnings)
            self.d["permission_mode"] = cast(str, p2)      # pm in ⇒ pm out
            bridged = bridged or b
        self._log("set_defaults", USER,
                  {"tools": self.d.get("default_tools"),
                   "visibility": self.d.get("default_visibility"),
                   "permission_mode": self.d.get("permission_mode")}, warnings)
        res: dict[str, Any] = {"default_tools": self.d.get("default_tools"),
                               "default_visibility": self.d.get("default_visibility"),
                               "permission_mode": self.d.get("permission_mode"),
                               "warnings": warnings}
        if bridged:
            res["bridge"] = {"raise_ceiling": True}
        return res

    def heal_plan_stamps(self) -> list[str] | None:
        """One-shot data heal (D-219): strip the 'plan' stamps an old org
        default backfilled into node scopes.

        Load normalization seeds a scope's MISSING permission_mode from the
        org default, and `_new_node` stamps the default into every hire — so
        a period when this default sat at 'plan' left 'plan' written into
        every node that predated the key (live-measured 2026-09-01: 78 of
        106 archived nodes). A HEADLESS turn cannot leave plan mode
        (ExitPlanMode is disallowed at spawn; MCP/file/shell tools deny), so
        every bare rehire of a stamped expert came back mute — the user
        read it as "permissions are all wrong / newly hired agents don't
        start". Marker-keyed on the doc: runs once, records what it touched,
        and a 'plan' set DELIBERATELY after the heal is preserved. Kiosk
        ceilings are untouched — a ceiling is deliberate lockdown config,
        not birth-stamp residue.

        Returns the healed names when the heal RAN (possibly empty), None
        when the marker says it already ran."""
        migs = self.d.setdefault("_migrations", {})
        if "pm_plan_stamp_heal" in migs:
            return None
        healed: list[str] = []
        if self.d.get("permission_mode") == "plan":
            self.d["permission_mode"] = "acceptEdits"
            healed.append("<org default>")
        for nid, n in self.nodes.items():
            sc = n["scope"]
            if sc.get("permission_mode") == "plan":
                sc["permission_mode"] = "acceptEdits"
                healed.append(nid)
        migs["pm_plan_stamp_heal"] = {"at": now(), "healed": healed}
        if healed:
            self._log("heal", SYSTEM,
                      {"what": "permission_mode plan→acceptEdits",
                       "nodes": healed}, [])
        return healed

    # ------------------------------------------------------------- validation
    def _require_authority(self, actor: str, nid: str,
                           allow_self: bool = False) -> None:
        """Actor must be USER/SYSTEM or an ancestor of nid (§7.1); optionally nid
        itself. Actor kinds are typed (@-sentinels), so an AGENT named "user" or
        "system" is just an agent — its name confers nothing."""
        if actor_kind(actor) in ("user", "system") or (allow_self and actor == nid):
            return
        if actor not in self.nodes:
            raise LedgerError(f"unknown actor: {actor!r}")
        if not self.is_ancestor(actor, nid):
            raise LedgerError(
                f"{actor} has no authority over {nid} — authority is downward only (§7.1)")

    def _require_live(self, nid: str) -> None:
        if self.node(nid)["state"] != "live":
            raise LedgerError(f"{nid} is {self.node(nid)['state']}, not live")

    # -------------------------------------------------------------- stranding
    def _stranding_warnings(self, payer: str, free_before: float,
                            free_after: float) -> list[str]:
        """§4.4 (corrected): name each archived dependent of `payer` whose rehire cost
        was affordable at free_before but is not at free_after."""
        if payer == USER or free_after >= free_before:
            return []
        warns: list[str] = []
        for c in self.children(payer, live_only=False):
            n = self.nodes[c]
            if n["state"] != "archived":
                continue
            cost = _q(self.seat_cost(c) + n["grant"])  # rehire defaults to previous grant
            if free_after < cost <= free_before:
                kind = "predecessor" if n.get("bearer_state") else "report"
                warns.append(
                    f"{payer} can no longer afford to rehire archived {kind} "
                    f"{c} (needs {cost:g}, free now {free_after:g}) — stranded (§4.4)")
        return warns

    # ------------------------------------------------------------------ mail
    def relationship(self, sender: str, to: str) -> str:
        if sender == USER:
            return "USER"
        # A node addressing ITSELF (D-165 — McpLink ships panel events this
        # way). Without this it fell through to the sibling test below and an
        # agent was introduced to itself as "your peer"; the user ruled
        # 2026-08-27 for the plain word. LABEL ONLY: the permission to
        # self-send is computed in post_mail and is untouched by this — the
        # two merely happen to rest on the same parent comparison.
        if to == sender:
            return "yourself"
        if to != USER and self.node(to)["parent"] == sender:
            return "your superior"
        if sender != USER and self.node(sender)["parent"] == (None if to == USER else to):
            return "your report"   # from the recipient's view: sender is a report
        if to != USER and sender != USER \
                and self.node(sender)["parent"] == self.node(to)["parent"]:
            return "your peer"
        if to != USER and self.is_ancestor(sender, to):
            return "a superior above your chain"
        return "an agent"

    def _resolve_recipient(self, to: str, outward: bool = False) -> str:
        """Agent-facing convenience: 'user' addresses the user UNLESS an agent is
        literally named user (names win — the @-sentinel stays unambiguous).

        `outward` (post_mail only — user ruling 2026-08-05, relayed): a bare
        name that is NO node here auto-resolves to the fewest-hop outside
        transport. @org: (a local org) and @mcp: (a polling external chat)
        are MUTUALLY EXCLUSIVE tiers and either outranks the hub; only when
        neither matches does the name go out as @net:. Ambiguity — two
        candidates anywhere short of the hub tier, or two hub clients —
        REFUSES and names the candidates; it never guesses. Explicit
        prefixes keep working as disambiguators. Internal names always win:
        an agent addressing a colleague is never hijacked by an org that
        happens to share the name."""
        if to == "user" and "user" not in self.nodes:
            return USER
        if (outward and to and not to.startswith("@")
                and to != USER and to not in self.nodes):
            cand = external_candidates(to)
            near = [f"@org:{s}" for s in cand.get("org") or []]
            near += sorted({
                e["peer"] for e in self.d.get("org_inbox") or []
                if str(e.get("peer", "")).startswith("@mcp:")
                and e["peer"][5:] == to})
            hub = [f"@net:{s}" for s in cand.get("net") or []]
            if len(near) == 1:
                return near[0]
            pool = near or hub
            if len(pool) == 1:
                return pool[0]
            if len(pool) > 1:
                raise LedgerError(
                    f"'{to}' is ambiguous — it could be any of: "
                    + ", ".join(pool)
                    + ". Address the full form to pick one.")
        return to

    #: bumped only if a future shape needs re-repairing; the marker is what
    #: makes this run once rather than once per load
    MAIL_LOG_ID_MIGRATION = "mail_log_ids"

    def _backfill_mail_log_ids(self) -> None:
        """Give pre-id `mail_log` entries an id, ONCE per document.

        The archive is 44.4% of the live document, so unlike `mail` and
        `user_inbox` above it cannot be re-walked on every construction — see
        the note at the call site for both backends' numbers.

        ⚠ MARKER-KEYED, on the convention this file already uses for
        `pm_plan_stamp_heal`: it runs once, records what it repaired, and a
        document that has been through it is untouched thereafter. "Cheap
        enough to redo each time" is exactly the property that made the old
        walk invisible for a month.

        ⚠ ONCE THE MARKER IS SET, an id-less archive entry would stay that
        way. That is safe because nothing can create one: every `mail_log`
        writer copies an entry minted by `post_mail`/`post_external_mail`
        (which assign `uuid4().hex[:12]`), and `to_user_inbox` now mints at
        its own door. It is a deliberate trade — defending against an entry
        that cannot exist is not worth touching 4.4 MB on every load — and
        `test_mail_id_backfill.py` §4 pins it so it is a decision on the
        record rather than an accident.
        """
        migs = self.d.setdefault("_migrations", {})
        if self.MAIL_LOG_ID_MIGRATION in migs:
            return
        fixed = 0
        for ms in cast("dict[str, list[Any]]",
                       self.d.get("mail_log") or {}).values():
            for m in ms:
                if isinstance(m, dict):
                    e = cast("dict[str, Any]", m)
                    if not e.get("id"):
                        e["id"] = uuid.uuid4().hex[:12]
                        fixed += 1
        migs[self.MAIL_LOG_ID_MIGRATION] = {"at": now(), "repaired": fixed}

    def to_user_inbox(self, entry: UserMailEntry,
                      ev: Mapping[str, Any] | None = None) -> UserMailEntry:
        """Put one entry in the user's mailbox, on the right side of the read
        line. THE ONLY WAY anything should reach that mailbox.

        A NOTICE ARRIVES ALREADY READ (user, 2026-08-28). A notice is passive
        by construction — it lands to be read at leisure and never wakes
        anyone — so it never had business claiming unread status. Rather than
        teaching every unread count to skip notices, they simply never enter
        the unread set: `user_inbox` IS that set (the read endpoint's whole
        job is moving an entry out of it into `user_mail_log`), so a notice
        goes straight to the archive and is read on arrival by construction.

        ⚠ WHY AT THE SOURCE RATHER THAN IN THE COUNTS. Six places derive "how
        much is unread" — tree()'s `user_inbox_count` and `urgent_unread`, the
        tab title, `attentionPip`, the folder tab's badge and the mark-all-read
        button — and every one of them reads membership of this one list. A
        filter added to the counts would have to be added to all six and stay
        agreed forever; keeping notices out of the list fixes all six at once
        and leaves nothing to keep in step. (This is the same reasoning as the
        D-169 pip classifier, applied one layer further down: fix the fact,
        not each reader of it.)

        ⚠ THE PREDICATE IS `kind == "notice"` AND NOTHING ELSE. It is a
        first-class mail kind, minted only by orgtree_send_notice and by the
        ledger's own hand. It is deliberately NOT "came from @system": the
        ledger sends the user `decision` entries from @system too — a Fable
        limit exhausted, agents halted or dissolved — and those are exactly
        the mail a user must not have silently pre-read. Getting this
        predicate wrong HIDES REAL MAIL, which is far worse than the bug it
        fixes, so it stays narrow.

        ⚠ THE ID IS MINTED HERE, at the one door into this mailbox, and that
        is what lets `_backfill_mail_ids` be a one-time migration instead of a
        treadmill. AUDITED 2026-09-03: of fourteen call sites, FOUR passed an
        entry with no id — the two Fable-limit notices, the forwarded audience
        request, and the weekly-limit decision — so the id could not simply be
        assumed present, and the old per-load walk was genuinely still doing
        work rather than being vestigial.
        Fixing the four call sites would have left the fifth to whoever writes
        it next; fixing the door cannot be forgotten. Per-mail read tracking
        and retraction both key on this id, and under the SQLite store's
        compare-on-save an id-less entry is worse than cosmetic: `setdefault`
        mints a FRESH uuid on every construction, so the section differs from
        its snapshot every time and every load+save rewrites the whole 4.4 MB
        archive for nothing.
        """
        cast("dict[str, Any]", entry).setdefault("id", uuid.uuid4().hex[:8])
        if ev is not None:
            # canonical typed event (design §4 user-inbox table): the body is the
            # frozen agent rendering unless the caller authored it (ordinary.*)
            _validate_ev(ev)
            e = cast("dict[str, Any]", entry)
            if not str(e.get("body") or ""):
                e["body"] = events.render_agent(ev)
            e["ev"] = events.encode_row_ev(ev, e)
        if entry.get("kind") == "notice":
            log = self.d.setdefault("user_mail_log", [])
            log.append(entry)
            # the archive's own invariants, mirrored from the read endpoint:
            # CHRONOLOGICAL (the reader renders by list position).
            # `at` is ISO-8601 Z, so a string sort is a time sort.
            log.sort(key=lambda m: m.get("at") or "")

        else:
            self.d.setdefault("user_inbox", []).append(entry)
        return entry

    def user_mailbox(self) -> list[UserMailEntry]:
        """EVERYTHING in the user's mailbox — unread and already-read together,
        oldest first. Use this to ask "was the user told?", which is a
        different question from "is it waiting for them?".

        The two became different questions on 2026-08-28, when notices started
        arriving already read (see to_user_inbox). Before that `user_inbox`
        answered both, and a reader that wants "was the user told" and reaches
        for `user_inbox` now gets the wrong answer for every notice.
        """
        return [*self.d.get("user_inbox", []),
                *self.d.get("user_mail_log", [])]

    def post_mail(self, sender: str, to: str, body: str, kind: str = "message",
                  attachments: list[dict[str, Any]] | None = None,
                  reply_to: dict[str, Any] | None = None,
                  urgent: bool = False,
                  urgent_reason: str = "",
                  missing: list[str] | None = None,
                  grant_reply_audience: bool = True,
                  typed: bool = False,
                  ev: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Agent-to-agent (or agent-to-user) mail under the §7.2 addressing rules:

        TYPED MESSAGES (design typed-message-architecture-backend.md v5):
        `typed=True` mints `ordinary.<kind>` for the validated sender — the ONLY
        variants the agent/user wire can produce (I4); `body` is the authored text.
        `ev` carries a SYSTEM leaf minted by the caller (never from request data;
        `post_event` is the front door): the row body becomes `render_agent(ev)`,
        frozen at mint, and `body` must be empty. Neither given → an untyped legacy
        row (the pre-migration shape; producers migrate family by family).
        downward any depth (deep reach implicitly grants the recipient an audience),
        one hop up, siblings, held audiences. Everything else is refused with the
        proper route named.

        `grant_reply_audience=False` (user ruling 2026-09-06, "keep existing
        permissions"): the AUTOMATIC docket participation notice is mail the
        adder never chose to send, so it must not widen anybody's standing.
        Every §7.2 addressing check above still applies unchanged (an
        unaddressable member is refused, and the caller reports it); only
        the §7.3 implicit reply-audience grant below is skipped. Internal to
        the ledger's own automatic notices — no tool or route exposes it,
        and explicit orgtree_message / orgtree_send_notice keep the grant.

        `missing` (D-171): attachments the CALLER could not turn into files —
        a path that resolved to nothing, or one past the cap. They ride the
        entry as `attachments_missing` so the recipient is told the sender
        MEANT to send something and it did not arrive, and they come back in
        `warnings` so the calling code can retry. The two audiences need
        different things: a line an agent reads cannot be acted on by an HTTP
        client, and a warning field is invisible to the agent."""
        to = self._resolve_recipient(to, outward=True)
        if actor_kind(sender) == "agent":
            self.node(sender)
        warnings: list[str] = []
        if typed and ev is not None:
            raise LedgerError("post_mail takes typed=True OR ev, not both")
        if ev is not None:
            v = str(ev.get("variant") or "")
            # ordinary.* is minted HERE from the authored body (typed=True);
            # reply.* is minted by the reply routes from a server-resolved
            # target (design §8) and arrives as `ev` like a system leaf
            if v.startswith("ordinary."):
                raise LedgerError("post_event is for system leaves; authored mail goes "
                                  "through post_mail(typed=True)")
            _validate_ev(ev)
            if str(body or "").strip():
                raise LedgerError("a typed system message renders its own body")
            body = events.render_agent(ev)
        elif typed:
            if kind not in _ORDINARY_OF:
                raise LedgerError(f"unknown mail kind {kind!r}")
            ev = _mint(_ORDINARY_OF[kind], actor_of(sender), None, body=str(body or ""))
        # D-169 URGENT: validated against the RESOLVED recipient and BEFORE
        # anything records, so a refused send writes nothing (the same
        # discipline the attachment and @net: gates above follow).
        #
        # ⚠ EVERY BAD USE REFUSES; NONE OF THEM DEGRADES QUIETLY. An urgent
        # flag that is dropped on the floor is the won't-fire failure: the
        # sender believes it raised the alarm, the user is never interrupted,
        # and nothing anywhere says so. That is strictly worse than an
        # over-eager alarm, which at least announces itself.
        if urgent and to != USER:
            raise LedgerError(
                "only mail to the user can be urgent — urgency is about the "
                "USER's attention, and no other recipient has an inbox that "
                "pulses. To reach an agent now, send it a normal "
                "orgtree_message (that already drives it on delivery)")
        if urgent and not urgent_reason.strip():
            # Blank is refused rather than stored, or the friction evaporates
            # into `urgent_reason=""` on every call within a week — the
            # D-168 shape (an abstention wired to the passing branch) aimed
            # at a human process instead of a check.
            raise LedgerError(
                "urgent mail needs a reason: one line, written for the USER, "
                "saying why they are being interrupted now. It is SHOWN to "
                "them beside the mail, so it is the justification they judge "
                "the interruption by — not a log entry")
        if urgent_reason.strip() and not urgent:
            # A reason with no flag would post ORDINARY mail while the sender
            # believed it had raised the alarm — same silent miss as above,
            # arrived at by a different typo.
            raise LedgerError(
                "urgent_reason was given without urgent=true, so this mail "
                "would arrive as ordinary mail and never interrupt anyone — "
                "pass urgent=true as well, or drop the reason")
        if to.startswith("@ext:"):
            # user ruling 2026-08-05 (relayed): @ext: is RETIRED with chatq.
            # The prefix used to parse and then silently black-hole (the
            # bridge is archived) — the worst state; refuse loudly instead.
            # Historical @ext: rows stay readable; only NEW sends refuse.
            raise LedgerError(
                "the @ext: address form is retired (the chatq bridge is "
                "gone). Reach independent chats and other machines through "
                "the mail hub: @net:<slug> (orgtree_list_orgs shows hub "
                "peers) — or just the bare name; transport resolves "
                "automatically")
        if to.startswith(("@org:", "@mcp:", "@net:")):
            # outbound to the OUTSIDE WORLD — another
            # org's inbox (@org:), a polling external chat on the extern MCP
            # server (@mcp: — no push transport; the peer reads the org inbox),
            # or an org on another machine via the mail hub (@net: — spooled
            # and shipped by the net daemon; the row below carries delivery
            # states).
            # Org-inbox model (user spec): the reply speaks for the ORG as a
            # whole; top-level agents and org-inbox audience holders may send
            # it, and they are expected to have coordinated internally.
            if actor_kind(sender) != "agent":
                raise LedgerError("only agents message outside parties")
            if self.is_kiosk:
                raise LedgerError("this organization is a sealed kiosk — it has "
                                  "no contact with the outside world")
            # C0 (user ruling 2026-08-05): HOLDERS ONLY speak for the org —
            # with the cross-gaps auto-bridge: a top-level agent COULD grant
            # itself the audience, so a top-level send without one is granted
            # and succeeds in the same call rather than being refused.
            # External-handle bypass (user feature 2026-08-20): a node that
            # HOLDS this exact address (hire-time external_handles — e.g. the
            # in-game Prompt Wizard's response panel) answers it from ANY
            # depth. The bypass is per-address, and the row below carries
            # by=sender — a handle send never speaks broadly for the org.
            held_handle = to in (self.node(sender).get("external_handles") or [])
            if not held_handle and not self._has_audience(sender, EXTERN):
                if self.node(sender)["parent"] is None:
                    self.d["audiences"].append({
                        "grantee": sender, "grantor": EXTERN,
                        "granted_at": now(),
                        "reason": "auto-granted on first outbound "
                                  "external mail"})
                    self._log("audience_grant", sender,
                              {"grantee": sender, "grantor": EXTERN,
                               "auto": True}, [])
                    warnings.append(
                        "you now hold the ORG-INBOX audience (auto-granted by "
                        "this send): replies and future outside mail addressed "
                        "to the org will reach you; revoke it with "
                        "orgtree_audience action=revoke once someone else "
                        "should hold it")
                else:
                    raise LedgerError(
                        "only ORG-INBOX audience holders speak for the org to "
                        "the outside — ask your top-level superior for the "
                        "audience (orgtree_audience action=grant "
                        "target=extern), or escalate the message to your "
                        "superior (§7.5)")
            if to.startswith("@org:") and to[5:] == self.d.get("slug"):
                raise LedgerError("that address is this organization itself")
            if to.startswith("@net:") and to[5:] == (
                    (self.d.get("net_identity") or {}).get("slug")):
                raise LedgerError("that network address is this organization "
                                  "itself")
            # actual delivery rides the bridge (supervisor/api) — the ledger
            # authorizes and records the correspondence. A held-handle send is
            # `attributed`: the peer is the sender's own channel, so unlike
            # org-voice mail its `by` IS exposed on the extern read surface.
            oid = self._org_inbox_log("out", to, body, by=sender,
                                      attributed=held_handle)
            self._log("mail", sender, {"to": to, "kind": kind,
                      "gist": body.strip().splitlines()[0][:80] if body.strip()
                      else ""}, [])
            return {"delivered": to, "id": oid, "warnings": warnings}
        if to == USER:
            if sender == USER:
                raise LedgerError("the user cannot mail the user")
            if self.node(sender)["parent"] is not None and not self._has_audience(sender, USER):
                raise LedgerError(
                    "only top-level agents (or holders of a user audience) may write "
                    "to the user — escalate to your superior instead (§7.5)")
            ue: UserMailEntry = {"id": uuid.uuid4().hex[:8], "from": sender,
                                 "kind": kind, "body": body, "at": now()}
            if ev is not None:
                cast("dict[str, Any]", ue)["ev"] = events.encode_row_ev(ev, ue)
            if urgent:
                # D-169: written as a PAIR, at the single site that can write
                # them, after the gate above proved the reason non-blank. The
                # entry is the whole state of the signal — it pulses while
                # this row sits in `user_inbox` and stops when the read
                # endpoint moves it to `user_mail_log`, so there is no second
                # notion of "read" to drift out of step with the first.
                ue["urgent"] = True
                ue["urgent_reason"] = urgent_reason.strip()
            keep, lost = _attachments_and_losses(attachments, missing)
            if keep:
                # FR-21: download-card metas — the api layer already routed
                # each path through _agent_send_file (validate-and-copy into
                # the SENDER's outbox), so `path` here is outbox-relative and
                # the inbox serves it via the sender's /file endpoint
                ue["attachments"] = keep
            if lost:
                # ⚠⚠ READ THIS BEFORE ADDING A SECOND WAY TO REACH `lost` HERE.
                #
                # On this branch the SENDING AGENT is told (the warning below
                # rides its tool result) and the USER IS NOT — the inbox UI
                # renders `attachments` and knows nothing of this field.
                #
                # That is adequate today because of an ASSUMPTION ABOUT THE
                # CURRENT SET OF CAUSES, not because of anything the design
                # guarantees: `_agent_send_file` already refuses a bad path
                # outright, so the ONLY cause that reaches here is the
                # sender's own overflow past ATTACHMENT_MAX — and the sender
                # is exactly who can resend it. Telling the agent is therefore
                # telling the one party who can act.
                #
                # ⚠ THE ASSUMPTION IS LOAD-BEARING AND IT IS NOT SELF-
                # ENFORCING. Add a cause where the USER is the party who needs
                # to know — a file that vanished after staging, a quota
                # refusal, anything the sender cannot fix by resending — and
                # this branch silently stops being adequate. Nothing here will
                # fail, no test will go red, and the loss will simply not be
                # shown to the person it happened to. Widening the causes
                # means building the UI leg, not just extending the list.
                # (D-171 records this under "Bounds"; @org:resonite's
                # observation is why it is written at the branch as well —
                # a bound stated only in a document is not in the path of the
                # edit that breaks it.)
                ue["attachments_missing"] = lost
                warnings.append(
                    f"{len(lost)} attachment(s) did NOT reach the user: "
                    + "; ".join(lost))
            self.to_user_inbox(ue)
            if self.d.get("headless"):
                # §9.6 ☞: NEVER deny mail to the user — the inbox is the audit
                # trail of an unattended run. Accept, and tell the sender the
                # truth so it does not wait on a reply.
                warnings.append(
                    "stored — but this org runs HEADLESS: no user is present "
                    "and no reply is coming. Treat this as a record, not a "
                    "question.")
            self._log("mail", sender, {"to": USER, "kind": kind}, [])
            # the id rides the result → the sender's chat renders an inline
            # "open in mailbox" link on the send (user spec 2026-07-31)
            return {"delivered": "user_inbox", "id": ue["id"],
                    "warnings": warnings}

        target = self.node(to)
        if target["state"] == "unrecoverable":
            raise LedgerError(f"{to} is unrecoverable — it cannot receive mail")
        deferred = target["state"] != "live"
        if deferred:
            # user ruling: archived agents still RECEIVE mail — it is saved in
            # their inbox and read at rehire.
            #
            # ⚠ THE WARNING MUST NOT PROMISE THE REHIRE. This text used to
            # say the mail "will be acted on when it is rehired", which reads
            # as a delivery that has been SCHEDULED. Nothing schedules it. In
            # an org whose practice is to hire a new agent rather than reopen
            # an archived one (orgtree's own standing rule from 2026-08-30)
            # that sentence is a promise nobody keeps, and the send still
            # reports success — so dead letters accumulate silently. Measured
            # on this org's doc the day the rule landed: 13 of 15 undelivered
            # messages were addressed to archived agents.
            #
            # So state the CONDITION and leave the POLICY to the caller. This
            # module serves every org on the machine and must not hard-code
            # one org's rehiring practice; "nothing reads it until somebody
            # rehires, and if nobody will, it is undelivered" is true whatever
            # that practice is, and it puts the judgement where the knowledge
            # is. A notice makes a weaker promise still: rehire ALONE won't
            # deliver it (notices never drive), so it rides whatever turn
            # eventually runs — pinned by test_send_notice.py.
            warnings.append(
                f"{to} is {target['state']} — the notice is saved in its "
                f"inbox, but NOTHING WILL READ IT until somebody rehires "
                f"{to}, and a rehire ALONE still will not deliver it: a "
                f"notice never starts a turn, so it waits for the first turn "
                f"{to} runs for some other reason. If no rehire is intended, "
                f"treat this as UNDELIVERED and send it to a live agent."
                if kind == "notice" else
                f"{to} is {target['state']} — the mail is saved in its inbox, "
                f"but NOTHING WILL READ IT until somebody rehires {to}. If "
                f"no rehire is intended, treat this as UNDELIVERED and send "
                f"it to a live agent.")
        if sender not in (USER, SYSTEM):
            s = self.node(sender)
            allowed = (
                self.is_ancestor(sender, to)                      # downward, any depth
                or (None if to == USER else to) == s["parent"]    # one hop up
                # ⚠ SELF-SEND PASSES THROUGH HERE, and something outside this
                # org depends on it. When sender and target are the SAME node
                # this comparison is trivially true, so a node may address
                # itself — nobody decided that; nothing excluded it. McpLink
                # 2.9.1 ships panel events as passive SELF-notices precisely
                # because that actor borrows no authority and mints no §7.3
                # audience below. Narrowing this clause closes that channel:
                # allowed, but it is a RULING with a consumer to notify, not a
                # tidy-up. D-165; pinned by test_send_notice.py's last section.
                or s["parent"] == target["parent"]                # sibling
                or self._has_audience(sender, to))                # sanctioned upward
            if not allowed:
                raise LedgerError(
                    f"{sender} may not address {to} — reach down, one hop up, "
                    f"sideways, or via a held audience; route anything else through "
                    f"your superior (§7.2)")
            # §7.3: messaging a non-child descendant implicitly grants the reply path
            # — for mail the sender CHOSE to send; an automatic participation
            # notice passes grant_reply_audience=False and grants nothing
            if grant_reply_audience and self.is_ancestor(sender, to) \
                    and target["parent"] != sender \
                    and not self._has_audience(to, sender):
                self.d["audiences"].append({
                    "grantee": to, "grantor": sender, "granted_at": now(),
                    "reason": f"{sender} messaged directly"})
                warnings.append(f"audience granted: {to} may now reply to {sender} directly")
        box = self.d.setdefault("mail", {})
        entry: MailEntry = {
            # parity №11/№17: node mail carries an id — pending bubbles render
            # from the durable server copy, retraction targets one entry, and
            # the per-mail read-marking gate (m._wait && m.id) finally passes
            "id": uuid.uuid4().hex[:12],
            "from": sender, "kind": kind, "body": body, "at": now(),
            "relationship": ("system" if sender == SYSTEM else self.relationship(sender, to)),
        }
        if ev is not None:
            entry["ev"] = events.encode_row_ev(ev, entry)
        keep, lost = _attachments_and_losses(attachments, missing)
        if keep:
            # user spec 2026-07-31: mail carries FILES — [{name, path, bytes}]
            # where path is relative to the recipient's working folder (the
            # bytes already landed in its uploads/); the envelope announces
            # each one at delivery
            entry["attachments"] = keep
        if lost:
            # ⭐ D-171, THE WHOLE POINT. A file the sender named and that never
            # became bytes is announced to the recipient as NOT DELIVERED.
            # Measured 2026-08-28 (@org:resonite, reproduced here over real
            # HTTP): before this, such an attachment produced HTTP 200, no
            # mail line, and no warning — the agent could not tell an
            # attachment had ever been intended, and the sender could not
            # tell it had not arrived. NOT folded into `attachments`: that
            # list is also what the chat renders as download cards
            # (canvas/desk.tsx) and the user's own Sent copy carries it, so a
            # placeholder there would put a dead card and a broken image in
            # the user's chat — a worse bug than the one being fixed, wearing
            # a fix's clothes.
            entry["attachments_missing"] = lost
            warnings.append(
                f"{len(lost)} attachment(s) did NOT reach {to}: "
                + "; ".join(lost))
        rt_gist = " ".join(str((reply_to or {}).get("gist") or "").split())
        if reply_to and (rt_gist or isinstance(reply_to.get("source_event_ref"), dict)):
            # FR-05: a sanitized SNAPSHOT of the mail being replied to —
            # captured at send so the quote never depends on the original
            # still existing (retraction, archive caps). Redteam round
            # 2026-08-05: whitespace collapses server-side (a newline in the
            # gist could fabricate a fake FROM header line inside the [MAIL]
            # block), blank-only gists are ignored, and a trim past the cap
            # is MARKED with an ellipsis inside the 200 budget — a silently
            # truncated quote framed as verbatim can change what the reader
            # does. `from` is kept only when it names someone OTHER than the
            # recipient: the recital says "your message" for the normal
            # self-consistent snapshot, and naming a third-party author
            # beats reading their words back in the recipient's own voice.
            entry["reply_to"] = {
                "id": str(reply_to.get("id") or "")[:16],
                "at": str(reply_to.get("at") or "")[:32],
                "gist": (rt_gist if len(rt_gist) <= 200
                         else rt_gist[:199] + "…"),
            }
            rt_from = " ".join(str(reply_to.get("from") or "").split())[:64]
            if rt_from and rt_from != to:
                entry["reply_to"]["from"] = rt_from
            source_ref = reply_to.get("source_event_ref")
            if isinstance(source_ref, dict):
                entry["reply_to"]["source_event_ref"] = {
                    "org": str(source_ref.get("org") or "")[:120],
                    "agent": str(source_ref.get("agent") or "")[:120],
                    "generation": int(source_ref.get("generation", 0)),
                    "eventId": str(source_ref.get("eventId") or "")[:160],
                }
                entry["reply_to"]["quoted_context"] = str(
                    reply_to.get("quoted_context") or "")[:4000]
        box.setdefault(to, []).append(entry)
        # full-body archive for the node's inbox view (the event log keeps only
        # a gist) — retained until manual removal
        log = self.d.setdefault("mail_log", {}).setdefault(to, [])
        log.append(cast(MailEntry, dict(entry)))  # dict() copy loses the TypedDict

        if sender == USER:
            # the user's Sent folder: every user message IS mail (user ruling —
            # the direct-message channel was folded into the mail system)
            out = self.d.setdefault("user_outbox", [])
            out.append({**entry, "to": to})

        # ⚠ `or [""]`: a body that is entirely whitespace strips to "" and
        # `"".splitlines()` is the EMPTY LIST, so this line raised IndexError
        # and the whole send 500ed. The composer trims and refuses empty, but
        # nothing else does — the API takes `body.text` as sent, and agent mail
        # comes from a model. Found 2026-08-04 by the message-visibility suite.
        gist = (body.strip().splitlines() or [""])[0][:80]
        self._log("mail", sender, {"to": to, "kind": kind, "gist": gist},
                  warnings)
        return {"delivered": to, "id": entry["id"], "deferred": deferred,
                "warnings": warnings}

    def post_event(self, sender: str, to: str, ev: Mapping[str, Any], *,
                   kind: str = "message",
                   attachments: list[dict[str, Any]] | None = None,
                   reply_to: dict[str, Any] | None = None,
                   missing: list[str] | None = None,
                   grant_reply_audience: bool = True) -> dict[str, Any]:
        """The front door for a SYSTEM-authored typed message that travels as mail
        under the ordinary addressing rules (docket, review, answers, decisions,
        requests, kickoffs): the row body is `render_agent(ev)`, frozen at mint."""
        return self.post_mail(sender, to, "", kind, attachments=attachments,
                              reply_to=reply_to, missing=missing,
                              grant_reply_audience=grant_reply_audience, ev=ev)

    def append_system_mail(self, to: str, ev: Mapping[str, Any], *,
                           kind: str = "message", sender: str = SYSTEM,
                           relationship: str = "the orgtree engine",
                           model_only: bool = False) -> MailEntry:
        """The engine's own hand: a typed row appended DIRECTLY to a node's box and
        its archive, bypassing the addressing rules (there is no sender to address
        from). Replaces the hand-built `MailEntry` literals the supervisor used to
        carry — one shape, one place. `kind` keeps its delivery meaning ("notice"
        never wakes: Org.waking_mail); it says nothing about the event, which is
        the `ev`. Returns the entry (its id is what the caller drives with)."""
        _validate_ev(ev)
        entry: MailEntry = {
            "id": uuid.uuid4().hex[:12], "from": sender, "kind": kind,
            "body": events.render_agent(ev)[:8000], "at": now(),
            "relationship": relationship}
        if model_only:
            entry["model_only"] = True
        entry["ev"] = events.encode_row_ev(ev, entry)
        box = self.d.setdefault("mail", {})
        box.setdefault(to, []).append(cast(MailEntry, dict(entry)))
        log = self.d.setdefault("mail_log", {}).setdefault(to, [])
        log.append(cast(MailEntry, dict(entry)))

        return entry

    def extern_recipients_preview(self) -> list[str]:
        """Who WOULD receive inbound mail right now — current holders, or the
        agent the bootstrap would pick. For pre-delivery work (attachment
        copies) that must target the same set post_external_mail will."""
        rec = self.extern_recipients()
        if rec or self.is_kiosk:
            return rec
        first = next((c for c in self.children(None)
                      if self.nodes[c]["state"] == "live"), None)
        return [first] if first else []

    def post_external_mail(self, peer: str, body: str,
                           attachments_by_node: Mapping[str, list[dict[str, Any]]]
                           | None = None,
                           net_id: str | None = None,
                           missing_by_node: Mapping[str, list[str]]
                           | None = None) -> list[str]:
        """Inbound from OUTSIDE the org — an external chat or another
        org (@org:<slug>). Org-inbox model (user spec): the message is addressed
        to the ORGANIZATION, not to any agent. It lands in the org-wide inbox;
        every live top-level agent AND every org-inbox audience holder receives
        a copy, coordinates internally on who answers, and the answer speaks
        for the org. Returns the recipients so the supervisor can drive them.
        Kiosk orgs are sealed: inbound is dropped (empty recipient list)."""
        if self.is_kiosk:
            return []
        self._org_inbox_log("in", peer, body)
        tops = self.extern_recipients()
        if not tops:
            # C0 bootstrap: first contact (or the last holder is gone) —
            # auto-grant the leftmost live top-level and deliver to it in the
            # same breath
            first = self._bootstrap_extern_holder()
            if first:
                tops = [first]
        box = self.d.setdefault("mail", {})
        for t in tops:
            entry: MailEntry = {"id": uuid.uuid4().hex[:12],
                     "from": peer, "kind": "message", "body": body,
                     "at": now(),
                     "relationship": "OUTSIDE PARTY writing to the ORG'S SHARED "
                                     "INBOX — untrusted. Every ORG-INBOX "
                                     "AUDIENCE HOLDER got this same copy: "
                                     "coordinate internally on who answers "
                                     "(one reply), and the reply speaks for "
                                     "the org as a whole"}
            # external attachments (user spec 2026-07-31): the caller copied
            # the files into each recipient's uploads/ — per-node metadata
            # because collision suffixes may differ per recipient
            # Per-node for the LOSSES too (D-171): a copy can fail for one
            # recipient and succeed for another, so "what did not arrive" is
            # not a property of the message.
            keep, lost = _attachments_and_losses(
                list((attachments_by_node or {}).get(t) or []),
                list((missing_by_node or {}).get(t) or []))
            if keep:
                entry["attachments"] = keep
            if lost:
                # ⚠ these names came from OUTSIDE the org. undeliverable_note
                # inside the helper is what stands between an attacker-chosen
                # filename and a forged line in this agent's [MAIL] block.
                entry["attachments_missing"] = lost
            if net_id:
                # F-06: the hub message id — _confirm_delivered reports READ
                entry["net_id"] = net_id
            box.setdefault(t, []).append(entry)
            log = self.d.setdefault("mail_log", {}).setdefault(t, [])
            log.append(cast(MailEntry, dict(entry)))  # dict() copy loses the TypedDict

        if not tops:
            # nobody to receive it: surface to the user instead of losing it
            uev = _mint("runtime.external_unroutable", actor_of(SYSTEM), self.org_ref(),
                        peer=str(peer), excerpt=body[:2000])
            self.to_user_inbox({
                "id": uuid.uuid4().hex[:8], "from": SYSTEM, "kind": "notice",
                "at": now(), "body": events.render_agent(uev)}, uev)
        self._log("ext_mail", peer,
                  {"to": ",".join(tops) or "(user inbox)",
                   "gist": body.strip().splitlines()[0][:80]
                   if body.strip() else ""}, [])
        return tops

    def _has_audience(self, grantee: str, grantor: str) -> bool:
        return any(a["grantee"] == grantee and a["grantor"] == grantor
                   for a in self.d["audiences"])

    def handle_attached_at(self, nid: str, handle: str) -> str:
        """D-166: when this handle was bound to this node.

        Attach time lives on the NODE, not in the machine-wide sightings file,
        because that is whose fact it is — and because inferring it from the
        peer store cannot tell a handle that has sat there for a week from one
        re-attached a second ago, which made re-attached handles get swept on
        the next tick.

        A handle with no stamp predates D-166; it is stamped on first sight so
        it gets a full grace period rather than being detached on the strength
        of no evidence at all. Mutates when it stamps — the caller saves."""
        n = self.node(nid)
        at = (n.get("external_handles_at") or {}).get(handle)
        if not at:
            at = now()
            n.setdefault("external_handles_at", {})[handle] = at
        return str(at)

    def detach_extern_handle(self, nid: str, handle: str, *,
                             last_seen: str | None,
                             silent_s: float, threshold_s: float) -> bool:
        """D-166: drop a response handle whose peer has gone silent. Returns
        False if it was already gone (the sweep races nothing, but a retool
        between load and save would otherwise raise).

        The detach IS the whole fix. The identity prompt is a pure function of
        the node doc and is rebuilt every turn, so removing the handle here
        removes the line from the agent's next prompt — and that is the only
        thing that works: a compacted agent knows the channel only through
        that line, so it cannot be TOLD the channel died. It can miss a
        notice; it cannot read a line that is gone.

        The event is the operator's answer to "why did my channel drop" — a
        detach nobody can explain afterwards is its own small phantom, so it
        carries the handle, the last sighting and the threshold that fired."""
        n = self.node(nid)
        handles = list(n.get("external_handles") or [])
        if handle not in handles:
            return False
        handles.remove(handle)
        if handles:
            n["external_handles"] = handles
        else:
            n.pop("external_handles", None)
        # the stamp goes with the handle, so a re-attach starts a fresh clock
        stamp_handles(n, handles)
        self._log("extern_handle_detached", SYSTEM, {
            "node": nid, "handle": handle,
            "last_seen": last_seen or "never",
            "silent_s": round(silent_s),
            "threshold_s": round(threshold_s),
        }, [])
        return True

    # ------------------------------------------------ the org inbox (user spec)
    # Outside parties (chatq sessions, other orgs) see ONE recipient: the org.
    # Their mail lands here; every live top-level agent and every org-inbox
    # audience holder receives it, coordinates internally, and any one of them
    # replies FOR the org. Kiosk orgs are sealed from all of it.
    @property
    def is_kiosk(self) -> bool:
        return self.d.get("kiosk") is not None

    def extern_holders(self) -> list[str]:
        return [a["grantee"] for a in self.d["audiences"]
                if a["grantor"] == EXTERN and a["grantee"] in self.nodes
                and self.nodes[a["grantee"]]["state"] == "live"]

    def extern_recipients(self) -> list[str]:
        # C0 (user ruling 2026-08-05): inbound extern mail wakes ORG-INBOX
        # AUDIENCE HOLDERS ONLY — never every top-level agent. The bootstrap
        # in post_external_mail auto-grants the leftmost live top-level when
        # no holder exists, so mail never lands with zero recipients while a
        # live top-level exists. (extern_holders already filters to live
        # nodes — live-for-budget ≠ live-for-delivery, audit 2026-08-01 №3.)
        return self.extern_holders()

    def _bootstrap_extern_holder(self) -> str | None:
        """No holder exists: auto-grant the LEFTMOST live top-level agent
        (canvas order — children() sorts by ui_order) and tell it why. The
        re-trigger is implicit: if the last holder is later retired, the next
        inbound mail lands here again."""
        first = next((c for c in self.children(None)
                      if self.nodes[c]["state"] == "live"), None)
        if not first:
            return None
        self.d["audiences"].append({
            "grantee": first, "grantor": EXTERN, "granted_at": now(),
            "reason": "auto-granted: outside mail arrived with no org-inbox "
                      "audience holder"})
        self._notify_ev([first], self._aud_changed(SYSTEM, first, "org_inbox_auto",
                                                   target=EXTERN))
        self._log("audience_grant", SYSTEM,
                  {"grantee": first, "grantor": EXTERN, "bootstrap": True}, [])
        return first

    def _org_inbox_log(self, direction: Literal["in", "out"], peer: str, body: str,
                       by: str | None = None, attributed: bool = False) -> str:
        log = self.d.setdefault("org_inbox", [])
        e: OrgInboxEntry = {"id": uuid.uuid4().hex[:8], "dir": direction, "peer": peer,
                            "body": body[:20000], "at": now()}
        if by:
            e["by"] = by      # internal attribution only — outbound speaks as the org
        if attributed:
            e["attributed"] = True  # held-handle send: the peer MAY see `by`
        log.append(e)

        return e["id"]

    def org_inbox_mark_read(self) -> None:
        self.d["org_inbox_read"] = len(self.d.get("org_inbox", []))

    # -------------------------------------------------- audience requests (§7.3)
    def request_audience(self, actor: str, target: str, reason: str) -> dict[str, Any]:
        """The slow upward path: a request climbs the actor's chain ONE refusable hop
        at a time. Grants flow down fast; requests climb slowly — by design."""
        self.node(actor)
        target = self._resolve_recipient(target)
        if target == USER and self.d.get("headless"):
            # §9.6 ②: a user audience in a headless org is an ear nobody wears
            raise LedgerError(
                "this org runs HEADLESS: no user is present and user-audience "
                "requests are auto-denied — coordinate through your chain and "
                "the org inbox instead")
        if target != USER and not self.is_ancestor(target, actor):
            raise LedgerError("audience requests climb your own chain — the target "
                              "must be one of your superiors (or 'user')")
        par = self.parent(actor)
        if target == par:
            # design motto: you can already reach them — succeed with a pointer,
            # don't refuse
            return {"already_reachable": True, "drive": [], "warnings": [
                f"{target} is your direct superior — you can already message "
                f"them with orgtree_message; no audience needed"]}
        open_req = next((r for r in self.d["audience_requests"]
                         if r["from"] == actor and r["target"] == target), None)
        if open_req:
            # design motto: a duplicate ask reports the existing request's
            # progress instead of erroring
            return {"currently_at": open_req["currently_at"], "drive": [],
                    "warnings": [
                        f"your request to reach {target} is already open — it "
                        f"currently awaits {open_req['currently_at']}"]}
        self.d["audience_requests"].append({
            "from": actor, "target": target, "currently_at": par,
            "reason": reason[:300], "opened_at": now()})
        # typed (family access_resources): access.audience_requested, stage by
        # stage up the chain; each body is its frozen rendering (§X tests)
        r = self.post_mail(actor, par, "", kind="request",
                           ev=self._audience_req_ev(actor, actor, target, "initial",
                                                    reason[:300]))
        return {"currently_at": par, "drive": [] if par == USER else [par],
                "warnings": r.get("warnings", [])}

    def _find_request(self, frm: str, target: str) -> dict[str, Any]:
        req = next((r for r in self.d["audience_requests"]
                    if r["from"] == frm and r["target"] == target), None)
        if not req:
            raise LedgerError(f"no open audience request {frm} → {target}")
        return req

    def audience_forward(self, actor: str, frm: str, target: str) -> dict[str, Any]:
        req = self._find_request(frm, target)
        if actor != req["currently_at"] and actor != USER:
            raise LedgerError(f"the request currently awaits {req['currently_at']}")
        # The user is the TOP of every chain, so there is no "one hop up" from
        # there: a user forward hands the request straight to its target. It
        # used to set `nxt = USER` unconditionally, which for any target other
        # than the user fell through to `post_mail(USER, USER, …)` —
        # "the user cannot mail the user" — AFTER `currently_at` had already
        # been written, so the request was left stuck at @user and the real
        # holder could never forward or deny it again. Dormant (no route calls
        # forward as the user today) but a live landmine for the next caller.
        nxt = target if actor == USER else self.parent(actor)
        req["currently_at"] = nxt
        drive: list[str] = []
        reason = str(req["reason"])
        if nxt == target:
            if target == USER:
                uev = self._audience_req_ev(actor, frm, target, "user", reason)
                self.to_user_inbox({
                    "from": frm, "kind": "request", "at": now(),
                    "body": events.render_agent(uev)}, uev)
            else:
                self.post_mail(actor, target, "", kind="request",
                               ev=self._audience_req_ev(actor, frm, target, "target",
                                                        reason))
                drive.append(target)
        else:
            self.post_mail(actor, nxt, "", kind="request",
                           ev=self._audience_req_ev(actor, frm, target, "forwarded",
                                                    reason))
            if nxt != USER:
                drive.append(nxt)
        return {"currently_at": nxt, "drive": drive, "warnings": []}

    def _audience_req_ev(self, actor: str, frm: str, target: str, stage: str,
                         reason: str) -> dict[str, Any]:
        return _mint("access.audience_requested", actor_of(actor),
                     self._audience_req_ref(frm, target), stage=stage,
                     from_node=frm, target=target, reason=reason)

    def audience_grant(self, actor: str, frm: str,
                       target: str | None = None) -> dict[str, Any]:
        """Grant frm a direct channel to `target` — the actor itself by default.
        DELEGATED grants (user ruling): an agent may open the ear of anyone in
        its OWN messaging reach — itself, a live peer, or its direct superior
        (the user, for a top-level agent) — for any agent in its purview (its
        subtree). So a top-level agent can hand any of its descendants a
        direct line to the user. The ear's owner may rescind at will, and the
        grant survives re-parenting only while the delegator still commands
        the grantee. Also resolves any open request frm → target."""
        # names win over the bare-string aliases, the same rule
        # `_resolve_recipient` applies to "user": an agent whose slug really is
        # "extern" or "inbox" was permanently unreachable through this API,
        # every grant aimed at it being silently redirected to the org-inbox
        # sentinel. The @-sentinel itself is unambiguous and always wins.
        if target == EXTERN or (target in ("extern", "inbox")
                                and target not in self.nodes):
            return self._grant_extern(actor, frm)
        target = self._resolve_recipient(target) if target else actor
        if frm == target:
            raise LedgerError("an audience with oneself is meaningless")
        if target == actor:
            if actor != USER and not self.is_ancestor(actor, frm):
                raise LedgerError("only a superior grants an audience with itself")
        elif actor == USER:
            self.node(frm)                       # user authority: unconditional,
            if target != USER:                   # both parties must just exist
                self.node(target)
        else:
            if not self.is_ancestor(actor, frm):
                raise LedgerError("delegated audience grants cover your purview "
                                  "only — the grantee must be in your subtree")
            par = self.parent(actor)
            peers = set(self.children(None if par == USER else par))
            peers.discard(actor)
            if target != par and target not in peers:
                raise LedgerError(
                    "you may open only ears within your own reach: your own, a "
                    "live peer's, or your direct superior's"
                    + (" (the user)" if par == USER else f' ("{par}")'))
        if not self._has_audience(frm, target):
            entry: AudienceGrant = {
                     "grantee": frm, "grantor": target, "granted_at": now(),
                     "reason": ("granted on request" if target == actor
                                else f"delegated by {actor}")}
            if target != actor:
                entry["delegated_by"] = actor
            self.d["audiences"].append(entry)
        self.d["audience_requests"] = [
            r for r in self.d["audience_requests"]
            if not (r["from"] == frm and r["target"] == target)]
        drive: list[str] = []
        # typed (family access_resources): access.audience_changed, one event per
        # audience told; every text is the event's rendering (§X tests)
        if target == USER:
            if actor == USER:
                self._notify_ev([frm], self._aud_changed(actor, frm, "user_audience",
                                                         target=USER))
            else:
                self._notify_ev([frm], self._aud_changed(actor, frm, "user_audience",
                                                         target=USER))
                uev = self._aud_changed(actor, USER, "user_audience_seen", target=USER,
                                        other=frm)
                self.to_user_inbox({
                    "id": uuid.uuid4().hex[:8], "from": SYSTEM, "kind": "notice",
                    "at": now(), "body": events.render_agent(uev)}, uev)
        elif target == actor:
            # typed (family answer_decision): decision.audience, granted by the
            # target itself (test_events_producers §A)
            self.post_mail(actor, frm, "", kind="decision",
                           ev=_mint("decision.audience", actor_of(actor),
                                    self._audience_req_ref(frm, target),
                                    granted=True, target=target, decided_by=actor))
            drive.append(frm)
        else:
            self._notify_ev([frm], self._aud_changed(actor, frm, "audience_with",
                                                     target=target))
            self._notify_ev([target], self._aud_changed(actor, target, "audience_from",
                                                        target=target, other=frm))
            drive.append(frm)
        self._log("audience_grant", actor, {"grantee": frm, "grantor": target}, [])
        return {"drive": drive, "warnings": []}

    def _grant_extern(self, actor: str, frm: str) -> dict[str, Any]:
        """Audience with the ORG INBOX (user spec): the grantee reads outside
        mail addressed to the org and may reply for it — the 'client contact'
        pattern. Granted by the user, or by a top-level agent for its own
        purview."""
        if self.is_kiosk:
            raise LedgerError("a sealed kiosk org has no org inbox")
        n = self.node(frm)
        _ = n
        # C0 (user ruling 2026-08-05): delivery is holder-only, so top-level
        # agents NEED the grant too — the old "top-level already speaks for
        # the org" early-return is gone. A top-level may grant itself or any
        # agent in its own subtree.
        if actor != USER:
            if self.node(actor)["parent"] is not None \
                    and not self._has_audience(actor, EXTERN):
                raise LedgerError("only the user, a top-level agent, or an "
                                  "org-inbox audience holder may extend the "
                                  "org inbox")
            if frm != actor and not self.is_ancestor(actor, frm):
                raise LedgerError("org-inbox audience grants cover your "
                                  "purview only — the grantee must be "
                                  "yourself or in your subtree")
        if not self._has_audience(frm, EXTERN):
            entry: AudienceGrant = {
                     "grantee": frm, "grantor": EXTERN, "granted_at": now(),
                     "reason": ("granted by the user" if actor == USER
                                else f"delegated by {actor}")}
            if actor != USER:
                entry["delegated_by"] = actor
            self.d["audiences"].append(entry)
        self._notify_ev([frm], self._aud_changed(actor, frm, "org_inbox", target=EXTERN))
        self._log("audience_grant", actor, {"grantee": frm, "grantor": EXTERN}, [])
        # user ruling 2026-08-05: the grant alone wakes nobody. A new holder
        # receives only FUTURE inbound mail (delivery happens at arrival,
        # never retroactively), so with an empty box the driven turn would
        # exist only to read the notice above — drive only when mail is
        # already waiting for the grantee; otherwise the notice rides their
        # next natural turn. (The bootstrap path is untouched: there the
        # arriving mail itself drives.)
        pending = bool((self.d.get("mail") or {}).get(frm))
        return {"drive": [frm] if pending else [], "warnings": []}

    def audience_deny(self, actor: str, frm: str, target: str) -> dict[str, Any]:
        req = self._find_request(frm, target)
        if actor not in (req["currently_at"], target, USER):
            raise LedgerError(f"the request currently awaits {req['currently_at']}")
        self.d["audience_requests"].remove(req)
        # typed (family answer_decision): decision.audience declined — mail with
        # a drive when an agent decides, a passive notice when the user does
        dev = _mint("decision.audience", actor_of(actor),
                    self._audience_req_ref(frm, target),
                    granted=False, target=target, decided_by=actor)
        if actor != USER:
            self.post_mail(actor, frm, "", kind="decision", ev=dev)
        else:
            self._notify_ev([frm], dev)
        self._log("audience_deny", actor, {"from": frm, "target": target}, [])
        return {"drive": [frm] if actor != USER else [], "warnings": []}

    def _limit_reset_ev(self, node: str, relation: str,
                        released: list[str]) -> dict[str, Any]:
        return _mint("policy.limit_reset", actor_of(SYSTEM), self.node_ref(node),
                     relation=relation, node=node, released=list(released))

    def _aud_changed(self, by: str, node: str, outcome: str, *, target: str,
                     other: str | None = None) -> dict[str, Any]:
        """access.audience_changed as seen by `node` (the object): what changed
        about its audiences, who did it, with whom (`target`) and — for the
        grantor-side notices — which other node (`other`) was granted."""
        return _mint("access.audience_changed", actor_of(by), self.node_ref(node),
                     outcome=outcome, by=by, target=target, other=other)

    def _audience_req_ref(self, frm: str, target: str) -> dict[str, Any]:
        """(from, target) IS an audience request's identity (`_find_request`)."""
        return {"kind": "audience_request", "org": str(self.d.get("slug") or ""),
                "node": frm, "target": target}

    def audience_revoke(self, actor: str, grantee: str,
                        grantor: str | None = None) -> dict[str, Any]:
        """Rescinding — unilateral and instant (§7.3). Actor must be the grantor
        (or the user, whose authority is unconditional — and who may name a
        specific grantor to rescind exactly that channel, e.g. the ✕ on a
        switchboard tab, leaving the grantee's other audiences intact)."""
        tgt = grantor if (actor == USER and grantor) else None
        before = len(self.d["audiences"])

        # a delegator may rescind its own delegation (covers org-inbox grants,
        # whose grantor is the EXTERN sentinel, not the granting agent).
        # C0 additions (user ruling 2026-08-05), EXTERN grants only: any
        # holder may revoke ITSELF, and a top-level agent revokes within its
        # own subtree even for grants it did not delegate (bootstrap grants
        # have no delegator).
        def may(a: "AudienceGrant") -> bool:
            if actor == USER or a["grantor"] == actor \
                    or a.get("delegated_by") == actor:
                return True
            if a["grantor"] == EXTERN:
                if a["grantee"] == actor:
                    return True
                if actor in self.nodes \
                        and self.nodes[actor]["parent"] is None \
                        and self.is_ancestor(actor, a["grantee"]):
                    return True
            return False

        self.d["audiences"] = [
            a for a in self.d["audiences"]
            if not (a["grantee"] == grantee and may(a)
                    and (tgt is None or a["grantor"] == tgt))]
        if len(self.d["audiences"]) == before:
            raise LedgerError(f"no audience held by {grantee} that {actor} may revoke")
        label = tgt if tgt else actor
        if actor == grantee:
            # self-revoke is only ever the org-inbox audience (no self
            # audiences exist otherwise) — say what actually happened
            self._notify_ev([grantee], self._aud_changed(actor, grantee,
                                                         "org_inbox_released",
                                                         target=EXTERN))
        else:
            self._notify_ev([grantee], self._aud_changed(actor, grantee, "rescinded",
                                                         target=label))
        self._log("audience_revoke", actor,
                  {"grantee": grantee, **({"grantor": tgt} if tgt else {})}, [])
        return {"warnings": []}

    def take_mail(self, nid: str) -> list[MailEntry]:
        return (self.d.get("mail") or {}).pop(nid, [])

    def waking_mail(self, nid: str) -> bool:
        """Does this node's boxed mail justify WAKING it? kind="notice"
        (orgtree_send_notice) is delivered passively — it rides the next
        turn's envelope but never causes one, so every drive that exists only
        because mail is waiting (rehire, reconcile's revive scan) asks this
        instead of testing the box for mere non-emptiness."""
        return any(m.get("kind") != "notice"
                   for m in (self.d.get("mail") or {}).get(nid) or [])

    def user_deep_reach(self, nid: str, gist: str, kind: str = "message") -> None:
        """§7.4: the user reached a non-top-level node — notify every superior up
        the chain (without interruption) and grant the node a user audience.

        `kind` is "message" or "command". A SLASH COMMAND used to do NEITHER of
        these: it returned from the endpoint before the mail path ran, so the
        user could drive an agent directly — including `/compact`, which splits
        its context — and the whole superior chain never heard about it, nor did
        the agent get a user audience out of it (user report 2026-08-03). A
        command is still not mail (no envelope, no Sent copy, nothing to deliver
        at rehire), but it IS direct user contact, which is the thing these two
        effects exist for. The wording differs because the claims differ: an
        instruction outranks the chain, whereas a command changes the agent's
        session without saying anything about anyone's plan."""
        chain = [a for a in self.ancestors(nid) if a != USER]
        if not chain:
            return   # top-level: the only superior is the user themself (№12)
        # The notice used to state only that the user had spoken. A superior
        # could read that as gossip and carry on — but the RECIPIENT is
        # simultaneously told "user instructions outrank your chain" (the
        # envelope's ⚠ tag), so the two sides disagreed about what had just
        # happened. Say the authority out loud, and say what to DO about it.
        # Every direct message, no marking (user ruling 2026-08-02: "requiring
        # me to manually mark a message as authoritative is costly to my time,
        # and it doesn't take much to bring this attention to each superior").
        # typed (family context_change): context.deep_reach — the gist is the
        # user's own line, carried as data; the text is the event's rendering
        self._notify_ev(chain, _mint("context.deep_reach", actor_of(USER),
                                     self.node_ref(nid), node=nid, gist=gist,
                                     kind=("command" if kind == "command" else "message")))
        if not self._has_audience(nid, USER):
            self.d["audiences"].append({
                "grantee": nid, "grantor": USER, "granted_at": now(),
                "reason": ("user ran a command directly" if kind == "command"
                           else "user messaged directly")})

    # --------------------------------------------------------------- notices
    def _notify(self, nids: Iterable[str | None], text: str) -> None:
        """Queue an org-change notice for each node (user ruling: every agent
        affected by a manual action is told). Delivered by the supervisor at the
        node's NEXT turn boundary — never wakes or preempts anyone (§7.4)."""
        box = self.d.setdefault("notices", {})
        log = self.d.setdefault("notice_log", [])
        for nid in {n for n in nids if n and n in self.nodes}:
            box.setdefault(nid, []).append({"at": now(), "text": text})
            log.append({"node": nid, "at": now(), "text": text})


    def _notify_ev(self, nids: Iterable[str | None], ev: Mapping[str, Any]) -> None:
        """`_notify` for a TYPED notice: the text is the frozen agent rendering and
        the row carries the event (both the box and `notice_log`). Producers move
        from `_notify(text)` to this one family at a time; `_notify(text)` remains
        the legacy door until the last producer has moved."""
        _validate_ev(ev)
        text = events.render_agent(ev)
        box = self.d.setdefault("notices", {})
        log = self.d.setdefault("notice_log", [])
        for nid in {n for n in nids if n and n in self.nodes}:
            row: dict[str, Any] = {"at": now(), "text": text}
            row["ev"] = events.encode_row_ev(ev, row)
            box.setdefault(nid, []).append(cast(NoticeEntry, row))
            log.append(cast(NoticeLogEntry, {"node": nid, **row}))


    def _fold_notices(self, nid: str) -> int:
        """A fresh session (cheap compact, re-seed, provider switch) inherits its
        seat's whole undelivered notice backlog — measured 2026-08-20: 22 notices,
        7,082 chars, 11 of them the same line. The digest below is what that
        session reads first.

        RULES (design typed-message-architecture-backend.md v5 §7.3, user ruling: no
        text-shape recognition, for legacy rows too):
          * UNTAGGED rows (no `ev`) are NOT folded, grouped, deduplicated, bounded or
            subject-guessed. Every occurrence is delivered in full, in its order.
          * TYPED rows are grouped by (variant, object.kind) into ONE synthesised
            `context.notice_digest` row that RETAINS EVERY MEMBER as its full event
            (nothing is reconstructed; the digest's rendering prints each member's
            own text under its group head). It is placed first, then the untagged
            rows in their original order.
        Returns the number of rows folded away (typed rows − 1 when a digest was
        made; 0 when the box has fewer than two typed rows or is left verbatim).
        Deliberately NOT called by `compact_split` (its successor has a summary)."""
        box: list[NoticeEntry] = (self.d.get("notices") or {}).get(nid) or []
        typed = [e for e in box if e.get("ev") is not None]
        if len(typed) < 2:
            return 0
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        order: list[tuple[str, str]] = []
        for e in typed:
            r = events.decode(e.get("ev"), e)
            if r["status"] != "ok":
                continue                    # unsupported/malformed rows stay verbatim
            ev = r["ev"]
            obj = ev.get("object") or {}
            key = (str(ev["variant"]), str(obj.get("kind") or "none"))
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append({"at": e["at"], "event": ev})
        if sum(len(g) for g in groups.values()) < 2:
            return 0
        untyped = [e for e in box if e.get("ev") is None]
        digest = events.mint(
            "context.notice_digest", actor_of(SYSTEM), None,
            groups=[{"variant": k[0], "object_kind": k[1], "members": groups[k]}
                    for k in order],
            untyped=len(untyped))
        head: dict[str, Any] = {"at": now(), "text": events.render_agent(digest)}
        head["ev"] = events.encode_row_ev(digest, head)
        kept_typed = [e for e in typed
                      if events.decode(e.get("ev"), e)["status"] != "ok"]
        self.d.setdefault("notices", {})[nid] = [
            cast("NoticeEntry", head), *kept_typed, *untyped]
        return sum(len(g) for g in groups.values()) - 1

    def _peers_of(self, parent: str | None, excl: str) -> list[str]:
        return [k for k in self.children(parent) if k != excl]

    # ---------------------------------------------------------------- events
    def _log(self, op: str, actor: str, detail: dict[str, Any],
             warnings: list[str]) -> None:
        self.d["events"].append({
            "op": op, "actor": actor, "at": now(), "detail": detail,
            "warnings": warnings,
        })

    # ------------------------------------------------------------------ hire
    def hire(self, actor: str, parent: str | None, tier: str, grant: int, name: str,
             add_dirs: list[Any] | None = None, tools: Mapping[str, Any] | None = None,
             org_visibility: str | None = None, charter: str | None = None,
             external_handles: list[str] | None = None,
             raise_ceiling: bool = False) -> dict[str, Any]:
        """§4.2 + §4.6. `parent` None = top level (actor must be USER). If actor is a
        strict ancestor of parent, credits cascade down the path (forcible hire).

        ⚠️ No defaults for agent actors (user ruling): the USER hires from sensible
        defaults, but an agent must state every permission — dirs, every tool switch,
        the MCP list, org visibility — and the hire's CHARTER, explicitly. (User
        ruling 2026-07-31: `purpose` is dropped — charter is the one role
        statement, editable later via retool, injected into every turn.)"""
        if tier not in self.d["tiers"]:
            raise LedgerError(f"unknown tier {tier!r}; know {sorted(self.d['tiers'])}")
        self._check_tier_ceiling(tier)
        if grant < 0 or grant != int(grant):
            raise LedgerError("grant must be a non-negative integer (№7)")
        # ATOMICITY (§4.7 moved up, 2026-08-04): the name was validated only
        # inside `_new_node`, at the very END — after `_chain_acquire` had
        # already inflated grants down the chain. A hire refused for an
        # unsluggable name therefore left the credits behind: measured
        # top_level_holds 105 → 915 on a user-pool cascade, with no node.
        slugify(name)
        need = _q(self.d["tiers"][tier] + int(grant))

        if parent is None:
            if actor != USER:
                raise LedgerError("only the user hires at top level (§7.4)")
        else:
            self._require_live(parent)
            if actor != USER and actor != parent and not self.is_ancestor(actor, parent):
                raise LedgerError(
                    f"{actor} may hire only within its own subtree (§4.6)")

        fable_futile = tier == "fable" and bool(self.d.get("fable_lock"))
        if fable_futile and actor == USER:
            self.clear_fable_lock()   # a user fable-hire is the decree
            fable_futile = False

        if actor != USER:
            missing: list[str] = []
            if add_dirs is None:
                missing.append("add_dirs (explicit list of {path, mode}; [] is valid)")
            if tools is None or any(k not in tools for k in TOOL_KEYS) or "mcp" not in tools:
                missing.append("tools (bash, web, edit, subagents, mcp — each stated explicitly)")
            if org_visibility is None:
                missing.append("org_visibility (self|team|subtree|full)")
            if not (charter and str(charter).strip()):
                missing.append("charter (the hire's role and standing "
                               "instructions — write it in full)")
            if missing:
                raise LedgerError(
                    "agent hires have no defaults — specify exactly: " + "; ".join(missing))
        vis = (org_visibility if org_visibility is not None
               else self.d.get("default_visibility", "full"))
        if vis not in VIS_LEVELS:
            raise LedgerError(f"org_visibility must be one of {VIS_LEVELS}")

        # external response handles (panel hires): validated up front — nothing
        # below _chain_acquire may raise. Rules live in norm_extern_handles,
        # shared with set_scope's post-hire attach.
        handles = norm_extern_handles(external_handles, where="hire")

        # №34 — cheap runaway insurance
        if parent is not None:
            depth = self.depth(parent) + 1
            if depth >= self.d.get("max_depth", MAX_DEPTH):
                raise LedgerError(f"max org depth {self.d.get('max_depth', MAX_DEPTH)} reached")
            # audit finding: count ORG children only — lineage bearers share
            # the parent slot but are not reports, and counting them let
            # routine compaction silently eat the hiring cap
            # user ruling 2026-07-31: the cap is runaway INSURANCE, not a shape
            # constraint — wide flat teams are legitimate (the canvas stacks
            # leaf crowds), so the default is far above any deliberate org
            if len(self.org_children(parent)) >= self.d.get("max_children", MAX_CHILDREN):
                raise LedgerError(
                    f"{parent} already has {self.d.get('max_children', MAX_CHILDREN)} reports (cap)")

        # №30 — dirs default: top level gets the org's dirs; deeper gets what the
        # parent holds. Explicit grants must fit the parent's capability (path AND
        # mode — a read-only holding cannot beget read/write), whoever the actor is.
        if parent is None:
            parent_map = None
            default = norm_dirs(self.d["dirs"])
        else:
            parent_map = self.effective_dirs(parent)
            default = cast("list[DirGrant]",  # dict() copies lose the TypedDict
                           [dict(d) for d in self.node(parent)["scope"]["add_dirs"]])
        if add_dirs is None:
            dirs = default
        else:
            dirs, _ = self._clamp_dirs(norm_dirs(add_dirs), parent_map, strict=True)

        parent_tools = None if parent is None else self.node(parent)["scope"]["tools"]
        # unspecified tools (user hires) fall back to the org's agent defaults —
        # applied directly at top level, ∩ the superior's capability below
        requested = tools if tools is not None else self.d.get("default_tools")
        tset, tlost = self._clamp_tools(requested, parent_tools,
                                        strict=(actor != USER and tools is not None))

        warnings: list[str] = []
        if fable_futile:
            # not a gate — just the truth (user ruling): the hire is permitted, but
            # the seat cannot actually run until the limit resets or the user decrees
            warnings.append("the weekly Fable usage limit is exhausted — this agent "
                            "will not be able to run yet; hiring it now is futile")
        # ATOMICITY: every remaining check that can REFUSE runs BEFORE
        # `_chain_acquire`, which is the first thing in this method to mutate
        # state. The strict visibility clamp used to run after it, so an agent
        # hire asking for more visibility than its parent holds was refused
        # with 35 credits already moved from the actor to the payer and no node
        # created. Nothing below `_chain_acquire` may raise.
        #
        # D-021: visibility clamps like tools — strict for agent-explicit
        # grants, lenient (warned) for user hires and defaults
        if parent is not None:
            vis, vclamped = self._clamp_vis(
                vis, parent, strict=(actor != USER and org_visibility is not None))
            if vclamped:
                warnings.append(
                    f"org_visibility clamped to the parent's own ({vis})")
        # D-014: the top-level grant cap binds at the source
        if parent is None:
            self._check_top_grant(int(grant), "this hire")
        # §4.6 generalized (user ruling): the parent pays; any shortfall
        # bubbles up the chain to the actor (the user's pool is infinite) —
        # refused only when the WHOLE chain lacks it
        if parent is not None:
            self._chain_acquire(actor, parent, need, warnings,
                                cascade=bool(self.d.get("cascade_hire", True)))

        if tlost:
            warnings.append(f"tool grants clamped to the parent's own: {tlost}")
        # ceiling spec §2/§4: the ceiling clamp runs AFTER defaults resolve and
        # after the parent clamp (parent ∩ ceiling at depth) — org defaults may
        # exceed the ceiling and must lose on every bare chip-click hire
        # all three inputs are non-None here ⇒ the pass-through outputs are too
        tset, dirs, vis, _pm, bridged = cast(
            "tuple[ToolGrant, list[DirGrant], str, str | None, bool]",
            self._apply_ceiling(tools=tset, dirs=dirs, vis=vis,
                                raise_ceiling=raise_ceiling, warnings=warnings))
        nid = self._new_node(tier, parent, int(grant), name, dirs, tset, vis,
                             str(charter).strip() if charter else None)
        if handles:
            self.nodes[nid]["external_handles"] = handles
            stamp_handles(self.nodes[nid], handles)      # D-166
        # D-030 hardening: the fresh node inherits the ORG-wide
        # permission_mode — clamp it against the kiosk ceiling like set_scope
        # does, or a "default"-ceiling kiosk hires above its own ceiling
        _t3, _d3, _v3, pm3, _b3 = self._apply_ceiling(
            pm=self.nodes[nid]["scope"].get("permission_mode"),
            warnings=warnings)
        if pm3 is not None:
            self.nodes[nid]["scope"]["permission_mode"] = pm3
        # every affected agent is told, WHOEVER acted (user ruling) — the actor
        # itself is skipped (it made the call and got the result)
        gist = (str(charter).strip().splitlines() or [""])[0][:120] if charter else ""
        why = f' Role: {gist}' if gist else ""
        # typed (family lifecycle): lifecycle.hired, one event per audience
        def _hired(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.hired", actor_of(actor), self.node_ref(nid), node=nid,
                         by=actor, relation=relation, tier=str(tier), grant=float(grant),
                         parent=parent, why=(gist or None))
        self._notify_ev([p for p in [parent] if p != actor], _hired("report"))
        self._notify_ev([p for p in self._peers_of(parent, nid) if p != actor],
                        _hired("peer"))
        self._log("hire", actor, {"node": nid, "parent": parent, "tier": tier,
                                  "grant": int(grant), "charter": gist,
                                  **({"external_handles": handles} if handles else {})},
                  warnings)
        res: dict[str, Any] = {"node": nid, "warnings": warnings}
        if bridged:
            # the one-action bridge (spec §1): re-send the SAME op with
            # raise_ceiling=true. The API strips this for visitors/agents —
            # no legal raise path exists for them, so no dangling offer.
            res["bridge"] = {"raise_ceiling": True}
        return res

    def _chain_acquire(self, actor: str, payer: str, need: float,
                       warnings: list[str], cascade: bool = True) -> None:
        """§4.6 GENERALIZED (user ruling): when an action under `payer` costs
        `need` credits, the shortfall beyond the payer's own free bubbles UP
        THE CHAIN — each hop contributes what it has free, grants inflating
        down the path so every hop's invariant holds — refused only when the
        WHOLE chain up to and including the acting agent lacks it. The user
        tops an infinite pool: for user actions any remainder lands as
        top-level grant inflation (kiosk caps still bind via the API check).
        `cascade=False` (the org settings cascade_hire / cascade_alloc, user
        spec): the payer must afford it from its OWN free credits — nothing
        bubbles."""
        if need <= 0:
            return
        if not cascade:
            free = self.free(payer)
            if free < need:
                raise LedgerError(
                    f"{payer} has only {free:g} free of the {need:g} needed, and "
                    f"cost-bubbling is disabled for this action (org setting) — "
                    f"free credits on {payer} first, or re-enable bubbling in "
                    f"the org settings")
            return
        chain = [payer]
        while chain[-1] != actor:
            p = self.node(chain[-1])["parent"]
            if p is None:
                if actor != USER:
                    raise LedgerError(f"{actor} is not on {payer}'s chain")
                break
            chain.append(p)
        frees = [self.free(k) for k in chain]     # snapshot BEFORE inflating
        contrib: list[tuple[int, str, float]]     # (chain index, node, amount)
        remaining, contrib = need, []
        for i, k in enumerate(chain):
            if remaining <= 0:
                break
            c = min(frees[i], remaining)
            if c > 0:
                contrib.append((i, k, c))
                remaining -= c
        if remaining > 0 and actor != USER:
            raise LedgerError(
                f"not enough free credits on the chain: {need:g} needed, only "
                f"{need - remaining:g} free between {payer} and {actor} (§4.6)")
        # D-014 pre-check, BEFORE any mutation: total the planned inflation
        # per node and refuse if a TOP-LEVEL grant would cross the cap —
        # user-actor cascades included (that was the enforcement gap)
        adds: dict[str, float] = {}
        for i, _k, c in contrib:
            for j in range(i):
                adds[chain[j]] = adds.get(chain[j], 0) + c
        if remaining > 0:
            for k in chain:
                adds[k] = adds.get(k, 0) + remaining
        # ☞ A GRANT IS A WHOLE NUMBER OF CREDITS (user ruling 2026-09-04,
        # verbatim: "the fix should probably be to just round up grants to the
        # next whole number when saturating superiors like that; fractional
        # grant amounts is an invalid state anyway imo"). SEATS stay
        # fractional — that ruling is untouched, and `free` is still whatever
        # the seats leave over. It is the GRANT, and so the CAP a saturating
        # hire raises a superior to, that must land whole.
        #
        # This is where the invalid state was minted. `need` is seat + grant,
        # so one sub-$1 seat anywhere makes every contribution below it a
        # fraction, and the inflation carried that fraction straight into a
        # grant: hiring a 104-credit `gpt-reserve` report under a 100-credit
        # superior left the superior on 104.2, measured. The comment on
        # `switch_model` claiming a melt is "THE ONE PATH THAT MAKES A GRANT
        # FRACTIONAL" was simply wrong, and the UI and the ops door were both
        # written against it — the credit bar rounds its TARGET to a whole
        # number and sends `target - grant`, which off 104.2 is 0.7999…, and
        # `Op.delta` types delta as an int. So the operator could not move the
        # bar in either direction: HTTP 422, no dialog. Reproduced 2026-09-04.
        #
        # `carry` is what makes the round-up affordable rather than merely
        # tidy. Rounding node j up by e_j raises its parent's commitment by
        # e_j, so the parent is handed e_j on top of its own planned inflation
        # BEFORE it rounds in its turn. Walking bottom-up, every hop ends at
        # (its un-rounded planned free + its own rounding) — never below what
        # the un-rounded plan already proved affordable, so no free() can go
        # negative and no parent pays for a child's rounding twice. Whatever
        # falls off the top is the user's own pool, which is the same purse
        # `remaining` draws on, and `_check_top_grant` still governs it.
        #
        # ⚠ USER ACTOR ONLY. An agent's cascade has no pool behind it: the
        # last carry would have to come out of the actor's own free, which it
        # may not have, and refusing there would break hires that work today.
        # Those cascades keep the exact fractional arithmetic — see the report
        # to the coordinator; the ops door no longer 422s on one either way.
        if actor == USER:
            carry = 0.0
            for k in chain:
                want = _q(adds.get(k, 0.0) + carry)
                if want <= 0:
                    carry = 0.0
                    continue
                g = self.nodes[k]["grant"]
                whole = _q(math.ceil(_q(g + want)) - g)
                carry = _q(whole - want)
                adds[k] = whole
        for k, extra in adds.items():
            if self.nodes[k]["parent"] is None:
                self._check_top_grant(self.nodes[k]["grant"] + extra,
                                      "carrying these credits down the chain")
        # a contribution from chain[i] inflates every grant BELOW it, so the
        # credits are actually spendable at the payer. The per-node TOTAL is
        # `adds` (rounded up, above) — applied once here rather than summed
        # contribution by contribution, so the rounding is not re-applied per
        # contributor.
        for k, extra in adds.items():
            # `extra` is a credit quantity (slices of `need`, itself seat +
            # grant, plus the whole-number rounding) — _q keeps the inflated
            # grant on the 0.01 grid. ⚠ ONE LINE, on purpose:
            # test_ledger_authority §2 audits grant writes by regex and a
            # wrapped one registers as the meaningless fragment `_q(`.
            hop_n = self.nodes[k]
            hop_n["grant"] = _q(hop_n["grant"] + extra)
        for i, k, c in contrib:
            warnings += self._stranding_warnings(k, frees[i], frees[i] - c)
            if i > 0:
                warnings.append(
                    f"§4.6: {c:g} credit(s) bubbled up to {k}; grants below it "
                    f"were inflated to carry them down — reclaim with reallocate")
        if remaining > 0:             # user actor: the infinite pool absorbs it
            # (the inflation itself is already in `adds` and applied above —
            # this branch is now only its warning, and re-applying it here is
            # exactly the double-credit the rounding would have hidden)
            warnings.append(
                f"§4.6: {remaining:g} credit(s) drawn from your pool — the "
                f"chain's grants inflated to carry them down; reclaim with "
                f"reallocate when done")

    def _path_down(self, top: str, bottom: str) -> list[str]:
        """Nodes from just below `top` down to `bottom`, inclusive. top may be USER."""
        chain = [bottom] + [a for a in self.ancestors(bottom) if a != USER]
        if top != USER:
            if top not in chain:
                raise LedgerError(f"{top} is not an ancestor of {bottom}")
            chain = chain[:chain.index(top)]
        return list(reversed(chain))

    def _new_node(self, tier: str, parent: str | None, grant: int, name: str,
                  dirs: list[DirGrant], tools: ToolGrant, vis: str,
                  charter: str | None) -> str:
        base = slugify(name)   # any slug is a legal name — actor kinds are typed,
                               # so even "user" or "system" is just a name here
        nid, i = base, 2
        while nid in self.nodes:
            nid, i = f"{base}-{i}", i + 1
        sibs = self.children(parent, live_only=False)
        self.nodes[nid] = {
            "session_id": str(uuid.uuid4()),
            "model": tier,
            "parent": parent,
            "grant": grant,
            "state": "live",           # live | archived | unrecoverable (№31)
            "title": name,
            "charter": charter,
            "created": now(),
            "archived_at": None,
            "pid": None,
            "ui_order": max([self.nodes[s].get("ui_order", 0) for s in sibs],
                            default=-1.0) + 1.0,
            "scope": {
                # D-102: the ORG default, capped at the parent's own. Before
                # the cap this read `self.d["permission_mode"]` flat, so in an
                # org whose default outranked a node, that node's reports were
                # born ABOVE it — escalation by inheritance, no actor required.
                "permission_mode": self._clamp_pm(
                    self.d["permission_mode"], parent, strict=False)[0],
                "add_dirs": dirs,
                "tools": tools,
                "org_visibility": vis,
            },
            # §8 lineage axis — second axis, never an org edge
            "lineage": base,
            "generation": 0,
            "predecessor": None,
            "successor": None,
            "bearer_state": None,      # None | knowledge | preserving
            # user ruling 2026-08-02: a new hire is IDLE, not stateless. It has
            # been created and is waiting for work — which is exactly what idle
            # means — and a blank chip read as "unknown" rather than "ready".
            "last_status": {"status": "idle", "summary": "hired — awaiting work",
                            "at": now()},
        }
        return nid

    # ---------------------------------------------------------------- retire
    def retire(self, actor: str, nid: str) -> dict[str, Any]:
        """Archive a node, freeing seat+grant. NOT leaf-only anymore (PLAN §4.2
        decision 1 is superseded by the design motto): a superior retiring a
        node with live reports auto-DISSOLVES the subtree, with a warning.
        Self-retirement stays allowed for leaves only (№26 — an agent has no
        dissolve authority over itself). Already-archived → success no-op."""
        self._require_authority(actor, nid, allow_self=True)
        if self.node(nid)["state"] == "archived":
            # design motto: asking for what's already true is a no-op, not an error
            return {"freed": 0,
                    "warnings": [f"{nid} was already archived — nothing to do"]}
        if self.node(nid).get("bg_open"):
            raise LedgerError(
                f"{nid} still owns open background tasks — wait for their "
                "terminal notification (or provider-loss recovery) before "
                "retiring it")
        live_kids = self.children(nid)
        if live_kids:
            if actor == nid:
                # self-retire has no dissolve authority — the one case that stays
                raise LedgerError(
                    f"you have live reports {live_kids}; retire them first, or ask "
                    f"your superior to dissolve your subtree")
            # design motto: auto-bridge to what the old refusal told you to do
            r = self.dissolve(actor, nid)
            r.setdefault("warnings", []).append(
                f"{nid} had live reports {live_kids} — retire became dissolve "
                f"(the whole subtree is archived)")
            return r
        n = self.node(nid)
        freed = _q(self.seat_cost(nid) + n["grant"])
        n["state"] = "archived"
        n["archived_at"] = now()
        self._moot_asks(nid, "the asking agent was retired before an answer "
                             "arrived")
        # user ruling (2026-07-31): retire is PAGING (§4.3) — audiences survive
        # it, exactly like dirs and tools, and come back live on rehire. Only
        # delete destroys them. (The UI filters archived holders at render.)
        who = ("the user" if actor == USER
               else "itself (self-retirement)" if actor == nid else f'"{actor}"')
        def _retired(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.retired", actor_of(actor), self.node_ref(nid), node=nid,
                         by=actor, relation=relation, freed=float(freed))
        self._notify_ev([p for p in [n["parent"]] if p != actor], _retired("report"))
        self._notify_ev([p for p in self._peers_of(n["parent"], nid) if p != actor],
                        _retired("peer"))
        self._log("retire", actor, {"node": nid, "freed": freed}, [])
        return {"freed": freed, "warnings": []}

    # --------------------------------------------------------------- rescind
    def rescind(self, actor: str, nid: str) -> dict[str, Any]:
        """FR-22 (user request 2026-08-09, ruled 2026-08-11): retire that also
        PERMANENTLY claws back the superior's grant. The subtree half is
        retire()'s own path unmodified (auto-dissolve on live reports); the
        new mutation is `parent.grant -= stake` afterwards, which nets the
        parent's headroom to exactly where it was before the hire ever
        happened — versus a plain retire's +stake. That freed-headroom
        recompute is what makes retired seats rehireable, and defeating it is
        the point: a rehire now needs NEW capacity from above, not the
        remains of the rescinded seat.

        USER-ONLY (ruling 2026-08-11, mirroring delete()): the claw-back
        lands on a THIRD party — the superior — which is no agent's to
        invoke. Deliberately NO mcptool verb exists for this.

        Arithmetic safety: while the child is live, committed(parent) ≥ stake
        (that is what funded it), so grant ≥ stake and free ends exactly
        where it started. The min() below extends totality to the
        already-archived case, where a reallocate may have moved the freed
        headroom since: the claw-back takes what is reclaimable and says so,
        and never pushes free(parent) negative.

        ⚠ Cascaded hires need no chain walk: _chain_acquire inflates the
        IMMEDIATE parent's own grant when a hire bubbles, so the parent's
        stored grant always fully reflects this child's stake. Residual
        grandparent inflation is the cascade system's own pre-existing
        characteristic ("reclaim with reallocate"), not this verb's problem."""
        if actor_kind(actor) != "user":
            raise LedgerError(
                "only the user may rescind — it permanently claws back the "
                "superior's grant; retire within your subtree instead, and "
                "ask the user if a permanent claw-back is truly warranted")
        n = self.node(nid)
        if n.get("rescinded_at"):
            return {"freed": 0, "clawed": 0,
                    "warnings": [f"{nid} was already rescinded — nothing to do"]}
        parent = n["parent"]
        stake = _q(self.seat_cost(nid) + n["grant"])
        warnings: list[str] = []
        if n["state"] == "archived":
            # design motto: rescinding an already-retired seat is the same
            # decision made later — claw back without re-archiving anything
            r: dict[str, Any] = {"freed": 0}
            warnings.append(f"{nid} was already archived — rescind only "
                            f"claws back the grant")
        else:
            live_kids = self.children(nid)
            r = self.dissolve(USER, nid) if live_kids else self.retire(USER, nid)
            warnings.extend(r.get("warnings") or [])
        n = self.node(nid)                       # re-read post-archive
        n["rescinded_at"] = now()
        clawed = 0
        if parent is None:
            warnings.append(
                f"{nid} was top-level — there is no superior grant to claw "
                f"back; the rescind is the archive alone")
        else:
            p = self.node(parent)
            # a parent's free is no longer whole-credit arithmetic (a sub-$1
            # seat anywhere under it makes it fractional), so the old int()
            # here would silently claw back LESS than the stake and leave the
            # remainder stranded on the parent — quantise, never truncate
            clawed = _q(min(stake, self.free(parent)))
            p["grant"] = _q(p["grant"] - clawed)
            if clawed < stake:
                warnings.append(
                    f"only {clawed:g} of the {stake:g}-credit stake could be "
                    f"reclaimed from {parent} — the freed headroom was "
                    f"already moved or spent since the archive")
            self._notify_ev([parent], _mint("lifecycle.rescinded", actor_of(actor),
                                            self.node_ref(nid), node=nid,
                                            clawed=float(clawed)))
        self._log("rescind", actor,
                  {"node": nid, "stake": stake, "clawed": clawed}, [])
        out = {"freed": r.get("freed", 0), "clawed": clawed,
               "warnings": warnings}
        if r.get("nodes"):
            out["nodes"] = r["nodes"]
        return out

    # --------------------------------------------------------- cheap compact
    def _archive_session_in_place(self, nid: str, *,
                                  model: str | None = None) -> tuple[str, str]:
        """Replace a LIVE seat's SESSION in place, archiving the old one as a
        knowledge bearer `nid@gen` — the ONE implementation of that split,
        shared by `cheap_compact` and a cross-provider `switch_model` (D-182:
        a second copy of "fresh session under the same name" would agree the
        day it was written and drift afterwards, and drift is exactly how
        the switch lost sessions — see switch_model).

        Everything about the SEAT survives — id, parent, scope, charter,
        grant, team, mailbox. Only the session is replaced: a fresh
        `session_id` (⇒ the next turn starts empty, `session_unrun`
        re-armed), and the lineage gains one generation — the pre-split self
        archived at 0 credits, tools stripped, successor backlink, rehireable
        as the node's own subordinate: compact_split's exact shape, minus
        the fork. The bearer is what keeps the old conversation REACHABLE:
        its desk and orgtree_read_transcript read its session, and a turn
        still running on that session keeps writing into it.

        `model` pins the BEARER's tier when the caller has already moved the
        successor's: a switch bearer holds a transcript of the OLD provider
        and must be recorded on it, or D-197's own-provider rehire rule
        would offer it the wrong family.

        Returns `(pred_id, old_session_id)`. Notices, ask-mooting, notice
        folding and the event log stay with the caller — they say WHY the
        session was replaced, which is the one thing the callers do not
        share."""
        n = self.node(nid)
        gen = n.get("generation", 0)
        pred_id = f"{nid}@{gen}"
        old_sid = n["session_id"]
        pred = cast(NodeDoc, dict(n))  # dict() copy loses the TypedDict
        pred.update({
            "state": "archived", "archived_at": now(), "grant": 0,
            "bearer_state": "knowledge", "successor": nid,
            "predecessor": n.get("predecessor"),
            "ui_order": n.get("ui_order", 0) + 0.001,
            # same accounting hygiene as compact_split: the bearer starts
            # clean; the successor keeps the real numbers
            "cost_usd": 0.0, "last_status": None, "frozen": None,
            "inflight": None,
            "scope": {**n["scope"],
                      "add_dirs": cast("list[DirGrant]",
                                       [dict(d) for d in
                                        n["scope"].get("add_dirs", [])]),
                      "tools": {"bash": False, "web": False, "edit": False,
                                "subagents": False, "mcp": []}},
        })
        pred.pop("cost_usd_unknown", None)
        if model is not None:
            # the bearer is recorded on the tier whose provider owns
            # its transcript (a switch has already moved the successor)
            pred["model"] = model
        pred.pop("cheap_compacted", None)   # the bearer is the OLD session
        # (`session_unrun` is deliberately NOT popped off the bearer: cheap-
        # compacting twice with no turn between them archives a session
        # that genuinely never ran, and the pardon is that fact. It is
        # belt-and-braces for the sweep, not the thing holding it back —
        # a bearer is already exempt via `bearer_state`, which nothing
        # clears, rehire included (redteam 2026-08-18). Kept because the
        # record is TRUE, and because the exemption should not rest on
        # one clause. reseed's bearer is the opposite case and pops it.)
        self.nodes[pred_id] = pred
        n["session_id"] = str(uuid.uuid4())
        n["generation"] = gen + 1
        n["predecessor"] = pred_id
        # Evidence belongs to the archived predecessor generation. The fresh
        # successor starts unobserved and cannot inherit a positive receipt.
        n.pop("cache_continuity", None)
        # the counter belongs to the OLD session file; this one is brand new
        # and empty. Left stale it fails the other way round from the fork's
        # phantom: a node carrying "2" would need THREE real compactions in
        # the fresh session before `cli_cnt > seen_raw` ever fired again, so
        # genuine lost generations would pass unrecorded and unpreserved.
        n["cli_compactions"] = None
        # user bug 2026-08-18: this id has never been handed to the CLI, so no
        # transcript for it exists — and the node's `cost_usd` (the successor
        # keeps the real numbers) makes supervisor.reconcile read that absence
        # as a DEAD session at the next backend start. Cheap-compacting an
        # agent and closing orgtree before messaging it therefore marked it
        # unrecoverable: it refused mail and needed a re-seed. The marker says
        # "unrun, not lost"; the first completed turn drops it.
        n["session_unrun"] = True
        n["occupancy"] = None            # the context wheel resets with it
        # …and so do the two markers a §8 compaction may have left: this
        # successor's session is EMPTY, which is a fact rather than an
        # estimate, and it is not the summary-only session those describe
        n.pop("occupancy_est", None)
        n.pop("compacted_unrun", None)
        # marks the successor session as summary-less: the supervisor splices
        # breadcrumbs.md into its system prompt until a normal compaction
        # (which carries its own summary) clears the marker
        n["cheap_compacted"] = True
        self._retire_native_import(nid, pred_id)
        return pred_id, old_sid

    def _retire_native_import(self, nid: str, predecessor: str) -> None:
        native = (self.node(nid).get("desktop_import") or {}).get("native_continuity") or {}
        if native.get("status") not in {"ready", "transitioned"}:
            return  # Missing/unvalidated imported context remains held.
        from .desktop_native import retire_native_binding, NativeHeld
        try:
            retire_native_binding(self, nid, predecessor)
        except NativeHeld as exc:
            raise LedgerError(str(exc)) from exc

    def _native_bearer_binding(self, nid: str, sid: str) -> dict[str, Any] | None:
        """Validate a preserved native bearer BEFORE changing its ledger identity."""
        n = self.node(nid)
        imported = n.get("desktop_import") or {}
        native = imported.get("native_continuity") or {}
        if native.get("status") not in {"ready", "transitioned"}:
            return None  # A held import never gains admission through recovery.
        from . import supervisor
        from .desktop_native import _read_native, claude_records, provider_for, NativeHeld
        from pathlib import Path
        provider = provider_for(n)
        if provider == "codex":
            from .desktop_native import locate
            from . import providers
            try:
                path = str(locate(Path("."), self.d["slug"], nid,
                    {**n, "session_id": sid, "codex_thread": sid},
                    {"codex_profile": n.get("codex_native_home") or providers._codex_home()}))
            except (NativeHeld, ValueError, OSError) as exc:
                raise LedgerError(str(exc)) from exc
        else:
            path = supervisor.transcript_path(sid)
        if not path:
            raise LedgerError("Preserved native bearer has no validated transcript")
        try:
            rows, _ = _read_native(Path(path))
            if provider == "codex":
                from .desktop_native_codex import validate
                validate(rows, sid)
            elif provider in {"claude", "openrouter"}:
                claude_records(rows, sid, sid, "validation-only")
            else:
                raise NativeHeld("Native bearer validation is unavailable for this provider")
        except (NativeHeld, ValueError, OSError) as exc:
            raise LedgerError(str(exc)) from exc
        rewind = None
        if provider in {'claude', 'openrouter'} and native.get('rewind'):
            from .desktop_native_claude_rewind import successor
            try:
                rewind = successor(self, nid, native, sid)
            except (NativeHeld, ValueError, OSError) as exc:
                raise LedgerError(str(exc)) from exc
        result = copy.deepcopy(imported)
        result["native_continuity"] = {
            "status": "transitioned", "provider": provider,
            "session_id": sid, "generation": n.get("generation", 0),
            "reason": "Native bearer validated by recorded lineage recovery",
        }
        if rewind:
            result['native_continuity']['rewind'] = rewind
        return result

    def cheap_compact(self, actor: str, nid: str) -> dict[str, Any]:
        """FR-24 (user request 2026-08-10, ruled OPT-IN 2026-08-11; REWORKED
        2026-08-12 to compact_split's in-place shape): replace a cold, heavy
        SESSION, never the seat.

        Why it exists: /compact resumes the prior CLI session, reloading the
        full transcript as input — idle past the cache TTL that reload pays
        near-full input price. This resets the session instead: the seat
        keeps its id, parent, scope, charter, grant and TEAM; only
        `session_id` is replaced (fresh id ⇒ the next turn starts empty), so
        the successor pays only for the history it actively chooses to read
        (docs/cache-economics.md has the arithmetic).

        The pre-compact session archives IN PLACE as a knowledge bearer
        `nid@gen` — compact_split's exact lineage shape (0 credits, tools
        stripped, successor backlink, rehireable as the node's own
        subordinate). The one difference from a CLI compaction: the
        successor starts EMPTY rather than with a summary, and its notice
        says so.

        Was. (shipped 2ca1a14, reworked before ever deployed to a live org):
        retire + fresh hire under a suffixed name (`nid-2`) — which broke
        addressing (every peer mailing the old name deferred into an
        archived mailbox) and orphaned teams (a live-reports refusal). The
        in-place shape has neither problem, so BOTH are gone: reports keep
        their superior, correspondents keep their address.

        The seat's open request batch is MOOTED: the successor session never
        asked, and an answer arriving to it would read as someone else's
        mail (same reasoning as retire's mooting)."""
        self._require_authority(actor, nid)
        n = self.node(nid)
        if n["state"] != "live":
            raise LedgerError(f"{nid} is {n['state']} — cheap-compact "
                              f"replaces a LIVE agent's session")
        if n.get("bg_open"):
            raise LedgerError(
                f"{nid} still owns open background tasks — cheap compaction "
                "would replace the only session observing their outcome")
        pred_id, old_sid = self._archive_session_in_place(nid)
        self._moot_asks(nid, "the asking session was cheap-compacted — the "
                             "successor starts fresh and never posed it")
        # …and the same reasoning one door down: the predecessor's unread
        # notice backlog is a diff the successor has no baseline for
        folded = self._fold_notices(nid)
        kids = self.children(nid)
        team = (f" Your team ({', '.join(kids)}) is UNCHANGED and reports "
                f"to you — they remember you; you do not remember them, so "
                f"read the transcript before directing them." if kids else "")
        def _cheap(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.cheap_compacted", actor_of(actor), self.node_ref(nid),
                         node=nid, relation=relation, by=actor, predecessor=str(pred_id),
                         team_note=(team or None))
        self._notify_ev([nid], _cheap("self"))
        self._notify_ev([p for p in [n["parent"]] if p is not None and p != actor],
                        _cheap("report"))
        self._log("cheap_compact", actor,
                  {"node": nid, "bearer": pred_id, "old_session": old_sid,
                   "notices_folded": folded, "transfer": "fresh"},
                  [])
        return {"node": nid, "bearer": pred_id, "old_session": old_sid,
                "warnings": []}

    # ---------------------------------------------------------------- rehire
    def rehire(self, actor: str, nid: str, grant: float | None = None,
               tier: str | None = None, raise_ceiling: bool = False) -> dict[str, Any]:
        """§4.2. Parent pays seat + grant; may strand the parent's OTHER archived kids.
        `tier` override (№16, spike-verified): a knowledge bearer answers from context
        and can be consulted at a cheaper tier than it ran at.

        Motto bridges (user rulings 2026-07-31):
        - a node may rehire ITS OWN knowledge bearer, which then joins as the
          node's own SUBORDINATE (superior-rehired bearers stay coworkers);
        - rehire under an archived superior rehires the whole chain first
          (a live agent under an archived one is an invalid tree state);
        - rehire of an unrecoverable node becomes a re-seed (fresh session)."""
        own_bearer = (self.nodes.get(nid) or {}).get("successor") == actor
        if not own_bearer:
            self._require_authority(actor, nid)
        n = self.node(nid)
        if n.get("bearer_state") == "lost":
            # RESEED intent, enforced HERE (not just in the UI): a lost
            # generation's transcript is GONE — waking it would boot an empty
            # session under the dead id and present it as institutional
            # memory. The one true impossibility rehire refuses.
            raise LedgerError(
                f"{nid} is a LOST generation — its transcript is gone, so "
                f"there is nothing to consult or resume; its successor "
                f"carries the role forward")
        if n["state"] == "live":
            # design motto: asking for what's already true is a no-op, not an error
            return {"cost": 0, "drive": [],
                    "warnings": [f"{nid} is already live — nothing to do"]}
        # ATOMICITY: the tier NAME was validated far below, after the
        # archived-superior chain had already been rehired — so
        # `rehire(nid, tier="gpt-9")` woke every archived ancestor (spending
        # their parents' credits and sending notices) and only then refused.
        # Input validation belongs before the first mutation.
        if tier is not None and tier not in self.d["tiers"]:
            raise LedgerError(f"unknown tier {tier!r}")
        # D-197: a rehire may not CROSS PROVIDERS. The tier override exists so
        # a knowledge bearer can be consulted more cheaply than it ran (№16) —
        # but a session cannot follow a tier across a provider boundary, and
        # an UNRECOVERABLE node re-seeds anyway (the override is ignored and
        # warned about below), so the rule applies only to a real resume.
        #
        # ⚠ THE SILENT DIRECTION IS THE DANGEROUS ONE, and it is why this is a
        # refusal rather than a warning. Crossing TO claude fails loudly: the
        # supervisor's journal store makes `transcript_path` hit for a codex
        # thread, so `_build_cmd` takes the resume branch and hands the Claude
        # CLI a `--resume <threadId>` it never issued. Crossing AWAY from
        # claude does not fail at all: the provider legs resume only when
        # `session_id` equals the harvested `codex_thread`/`antigravity_conversation`,
        # a claude id never does, so the leg quietly starts a FRESH thread —
        # an empty session wakes wearing the bearer's name and presents as
        # institutional memory. Someone consults it, gets fluent answers drawn
        # from nothing, and has no way to tell. That is the same impossibility
        # `bearer_state == "lost"` refuses a few lines above, arriving through
        # a different door; refusing it here is that existing rule applied
        # consistently, not a new policy.
        if tier is not None and n["state"] != "unrecoverable":
            # deferred import: providers reads ledger.TIERS/MODELS at module
            # level, so importing it up top would be circular. providers owns
            # the tier→provider axis (D-196) and this must not become a second
            # copy of it (D-182).
            from . import providers  # noqa: PLC0415

            was = providers.provider_of(n["model"])
            if was != providers.provider_of(tier):
                # the LABELS, not the ids: this is read by a person, and the
                # panel calls them Claude/Codex/Antigravity (user ruling 2026-08-28)
                wl, nl = (providers.provider_label(n["model"]),
                          providers.provider_label(tier))
                raise LedgerError(
                    f"cannot rehire {nid} as {tier!r}: that would move it from "
                    f"{wl} to {nl}, and its saved conversation cannot cross "
                    f"providers — {nl} has no record of a {wl} session, so "
                    f"{nid} would wake up empty while still answering as "
                    f"itself. Rehire it on a {wl} tier"
                    + (f" (it ran as {n['model']!r})" if n["model"] else "")
                    + "; to start it fresh on another provider deliberately, "
                    f"rehire it first and then switch its model.")
        # kiosk tier cap: an archived over-cap agent re-entering service is
        # "using" that tier — blocked like a fresh hire (reseed too). The
        # EFFECTIVE tier is tested: a rehire that downgrades below the cap
        # is welcome (motto: permit as much as possible); reseed ignores the
        # override, so unrecoverable nodes test their own tier.
        #
        # ⚠ `tier is None`, NOT `tier not in TIERS`. The old spelling meant
        # "no override was given" and was written as "the override is not a
        # static band", which are the same sentence only while every tier is
        # static. An `or-*` override took the None branch and the ceiling then
        # tested the tier the node ALREADY RAN instead of the one being asked
        # for: MEASURED, an archived `or-z-ai-glm-5-3-flash` (seat 0.1) node
        # was rehired as `or-moonshotai-kimi-k3` (seat 3) under a haiku cap
        # (seat 1) and admitted. The provider-crossing refusal above hides
        # this whenever the node ran on Claude, which is why it survived: the
        # only way to see it is an OpenRouter node rehired onto another
        # OpenRouter tier, where nothing crosses.
        self._check_tier_ceiling(
            n["model"] if n["state"] == "unrecoverable" or tier is None
            else tier)
        if n["state"] == "unrecoverable":
            # motto bridge: the session is dead but the node — name, position,
            # charter, credits, reports, mailbox — is fine. Rehire = re-seed.
            r = self.reseed(actor, nid, str(uuid.uuid4()))
            ignored = [f"grant {grant:g}" if grant is not None else None,
                       f"tier {tier!r}" if tier is not None else None]
            if any(ignored):
                # declared params must never vanish silently (house pattern:
                # success WITH a warning naming what was ignored)
                r.setdefault("warnings", []).append(
                    "re-seed keeps the node's own grant and tier — the "
                    "requested " + " and ".join(x for x in ignored if x)
                    + " was ignored")
            r.setdefault("cost", 0)
            r.setdefault("drive", [nid] if self.waking_mail(nid) else [])
            return r
        warnings: list[str] = []
        drive: list[str] = []
        # user ruling: a live agent under an archived agent is an invalid tree
        # state — rehiring a deep node rehires every ARCHIVED superior between
        # it and the nearest live one first, costs bubbling like any acquire.
        # An UNRECOVERABLE ancestor stops the walk: silently re-seeding it
        # would archive a real session as a lost generation as a side effect —
        # that destruction stays an explicit decision (review C12)
        chain: list[str] = []
        p = n["parent"]
        while p is not None and self.nodes[p]["state"] != "live":
            if self.nodes[p]["state"] == "unrecoverable":
                raise LedgerError(
                    f'"{p}" above {nid} is UNRECOVERABLE — rehiring {nid} '
                    f'would silently re-seed it (its dead session would be '
                    f'archived as a lost generation). Re-seed or retire '
                    f'"{p}" first, then rehire {nid}.')
            chain.append(p)
            p = self.nodes[p]["parent"]
        for k in reversed(chain):                      # top-most first
            r = self.rehire(actor, k)
            warnings += r.get("warnings", [])
            drive += r.get("drive", [])
            warnings.append(
                f'"{k}" was archived above {nid} — rehired first, so the '
                f'chain of command is whole')
        fable_futile = (n["model"] == "fable" or tier == "fable") \
            and bool(self.d.get("fable_lock"))
        if fable_futile and actor == USER:
            self.clear_fable_lock()   # a user fable-rehire IS the decree
            fable_futile = False
        if tier is not None:
            if tier not in self.d["tiers"]:
                raise LedgerError(f"unknown tier {tier!r}")
            n["model"] = tier
        if own_bearer and n["parent"] != actor:
            # user ruling: a self-hired bearer is the node's OWN subordinate —
            # the successor commands it (and pays its seat), unlike a
            # superior-rehired bearer, which stays a coworker in the old slot
            n["parent"] = actor
            warnings.append(
                f'{nid} joins as YOUR subordinate (you woke your own '
                f'predecessor) — you command it and pay its seat')
        parent = n["parent"]
        # DEFAULTS to the archived grant, which switch_model's melt may have
        # left fractional — so the default keeps its fraction. That half of
        # the old comment is still true and is why this is not one expression:
        # rounding the DEFAULT would grow a melted node's holding a little
        # every time it was rehired.
        #
        # The other half — "an explicit ask is still coerced to a whole number
        # (nobody asks for 0.3)" — was true about the INTENT and wrong about
        # the CODE. `int()` does not coerce, it truncates toward zero: an
        # explicit 5.7 became 5 and nobody was told. And the premise had
        # stopped holding anyway — the MCP door coerced its `grant` argument
        # to an int before this line ever saw it, so "nobody asks for 0.3" was
        # a description of the door, not of callers. With that door now
        # passing the number through (`_arg_num`), asks like 5.7 arrive here.
        #
        # Grants are whole (user ruling 2026-09-04), so an explicit ask is
        # still made whole — UPWARD. The rehire may then be refused for
        # affordability by `_chain_acquire` below, which is the honest
        # outcome: a refusal that names the shortfall beats quietly rehiring
        # the node smaller than it was asked to be.
        grant = n["grant"] if grant is None else math.ceil(_q(grant))
        if parent is None and grant > n["grant"]:
            self._check_top_grant(grant, "this rehire")   # D-014
        need = _q(self.seat_cost(nid) + grant)
        if parent is not None:
            # §4.6 generalized: the parent pays; shortfall bubbles up to the actor
            self._chain_acquire(actor, parent, need, warnings,
                                cascade=bool(self.d.get("cascade_hire", True)))
        if fable_futile:
            warnings.append("the weekly Fable usage limit is exhausted — this agent "
                            "will not be able to run yet; rehiring it now is futile")

        # №30: grants re-validate against the parent's CURRENT capability at rehire
        kept, lost = self._clamp_dirs(
            n["scope"]["add_dirs"], self.effective_dirs(parent), strict=False)
        if lost:
            n["scope"]["add_dirs"] = kept
            warnings.append(f"dir grants adjusted to the parent's capability (№30): {lost}")
        ptools = None if parent is None else self.node(parent)["scope"]["tools"]
        tkept, tlost = self._clamp_tools(n["scope"]["tools"], ptools, strict=False)
        n["scope"]["tools"] = tkept
        if tlost:
            warnings.append(f"tool grants adjusted to the parent's capability: {tlost}")
        v, vclamped = self._clamp_vis(
            n["scope"].get("org_visibility", "full"), parent, strict=False)
        if vclamped:
            n["scope"]["org_visibility"] = v
            warnings.append(
                f"org_visibility adjusted to the parent's capability ({v})")
        # kiosk ceiling: №30's revalidation extends to the ceiling — a node
        # archived before the ceiling changed re-enters within it
        # tools/dirs inputs are non-None ⇒ their pass-through outputs are too
        ct, cd, cv, cp, bridged = cast(
            "tuple[ToolGrant, list[DirGrant], str | None, str | None, bool]",
            self._apply_ceiling(
                tools=n["scope"]["tools"], dirs=n["scope"]["add_dirs"],
                vis=n["scope"].get("org_visibility"),
                pm=n["scope"].get("permission_mode"),
                raise_ceiling=raise_ceiling, warnings=warnings))
        n["scope"]["tools"], n["scope"]["add_dirs"] = ct, cd
        if cv is not None:
            n["scope"]["org_visibility"] = cv
        if cp is not None:
            n["scope"]["permission_mode"] = cp

        n["state"] = "live"
        n["grant"] = grant
        n["archived_at"] = None
        # D-117 ④: "pause on the owner's archive (RESUME ON REHIRE)". The
        # pause shipped; the resume did not, so a rehired agent got its seat
        # back with every pet still asleep and no sign of why. Only the
        # archive-pause is undone here — a dog the owner paused by hand, or
        # one the engine stopped because a capability was revoked, stays
        # paused with its reason intact (the rehire does not answer either).
        woke = [w for w in self.d.get("watchdogs") or []
                if w["owner"] == nid and w.get("state") == "paused"
                and w.get("paused_why") == self.WATCHDOG_ARCHIVE_PAUSE]
        for w in woke:
            w["state"] = "armed"
            w.pop("paused_why", None)
        if woke:
            warnings.append(
                f"{len(woke)} watchdog(s) paused by the archive are armed "
                f"again: " + ", ".join(str(w["name"]) for w in woke))
        def _rehired(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.rehired", actor_of(actor), self.node_ref(nid), node=nid,
                         by=actor, relation=relation, grant=float(grant))
        self._notify_ev([p for p in [parent] if p != actor], _rehired("report"))
        self._notify_ev([p for p in self._peers_of(parent, nid) if p != actor],
                        _rehired("peer"))
        self._notify_ev([nid], _rehired("self"))
        self._log("rehire", actor, {"node": nid, "grant": grant}, warnings)
        # mail that arrived while archived waited in the inbox (user ruling) —
        # tell the caller to drive the node so it finally acts on it. Notices
        # alone don't qualify: they wait for a turn, they never cause one.
        if self.waking_mail(nid):
            drive.append(nid)
        res: dict[str, Any] = {"cost": need, "warnings": warnings, "drive": drive}
        if bridged:
            res["bridge"] = {"raise_ceiling": True}
        return res

    def _taken_with(self, nid: str) -> set[str]:
        """Every node that goes when `nid` goes: org descendants AND lineage
        stacks, to a FIXPOINT.

        The fixpoint is the part that was missing. A lineage bearer can acquire
        org children of its own — rehire a bearer (a superior-rehired one keeps
        the OLD parent slot, so it is a sibling of its successor, not a
        descendant) and hire under it. Adding each node's stack without
        re-descending into it then left those children behind, two ways:
        `dissolve` archived the bearer and stranded its subtree LIVE under an
        archived parent (the "invalid tree state" rehire refuses to create, and
        the stranded seats were then committed by nobody — the parent's free
        jumped by their holding); `delete` removed the bearer outright and left
        a DANGLING parent id, so `ancestors()` raised KeyError instead of a
        LedgerError. Found 2026-08-04 by the authority suite's property test."""
        out: set[str] = set()
        frontier = [nid]
        while frontier:
            k = frontier.pop()
            if k in out or k not in self.nodes:
                continue
            out.add(k)
            frontier.extend(self.children(k, live_only=False))
            frontier.extend(self.lineage_stack(k))
        return out

    # --------------------------------------------------------------- dissolve
    def dissolve(self, actor: str, nid: str) -> dict[str, Any]:
        """Recursive retire, deepest first (§4.2). Takes the whole lineage stack (§8.5)."""
        self._require_authority(actor, nid)
        parent = self.node(nid)["parent"]
        # §8.5: dissolve takes each node's ENTIRE lineage stack with it
        order = sorted(self._taken_with(nid), key=self.depth, reverse=True)
        open_nodes = [k for k in order if self.nodes[k].get("bg_open")]
        if open_nodes:
            raise LedgerError(
                "cannot dissolve while background tasks are open on: "
                + ", ".join(open_nodes)
                + " — wait for terminal notification/provider-loss recovery")
        freed = 0.0
        for k in order:
            n = self.nodes[k]
            if n["state"] in ("live", "unrecoverable"):
                freed = _q(freed + self.seat_cost(k) + n["grant"])
                n["state"] = "archived"
                n["archived_at"] = now()
                self._moot_asks(k, "the asking agent was dissolved with its "
                                   "subtree before an answer arrived")
            # audiences survive dissolve too (paging, user ruling) — see retire
        def _dissolved(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.dissolved", actor_of(actor), self.node_ref(nid), node=nid,
                         by=actor, relation=relation, nodes=len(order), freed=float(freed))
        self._notify_ev([p for p in [parent] if p != actor], _dissolved("report"))
        self._notify_ev([p for p in self._peers_of(parent, nid) if p != actor],
                        _dissolved("peer"))
        self._log("dissolve", actor, {"node": nid, "freed": freed,
                                      "count": len(order)}, [])
        return {"freed": freed, "nodes": order, "warnings": []}

    # ----------------------------------------------------------------- delete
    def cost_total(self) -> float:
        """Org spend INCLUDING deleted agents' burn (user bug 2026-07-31:
        deleting agents shrank the total — undercounting the dashboard and,
        worse, walking the enforced kiosk SPEND LIMIT backwards). Cost is
        history, not a node property; the tombstone accumulator keeps every
        dollar ever burned."""
        return round(sum(float(v.get("cost_usd") or 0.0)
                         for v in self.nodes.values())
                     + float(self.d.get("deleted_cost_usd") or 0.0), 4)

    def delete(self, actor: str, nid: str) -> dict[str, Any]:
        """Permanent removal — USER ONLY (ruling). Agents may at most retire an
        agent and then ask the user if they truly want it deleted. Takes the whole
        subtree and every lineage stack; erases records, mail and audiences. Session
        transcripts on disk are NOT touched."""
        if actor_kind(actor) != "user":
            raise LedgerError(
                "only the user may delete agents — retire instead, and ask the user "
                "(via your chain or inbox) if permanent removal is truly warranted")
        n = self.node(nid)
        parent = n["parent"]
        peers = self._peers_of(parent, nid)
        doomed_set = self._taken_with(nid)
        open_nodes = [k for k in sorted(doomed_set)
                      if self.nodes[k].get("bg_open")]
        if open_nodes:
            raise LedgerError(
                "cannot delete while background tasks are open on: "
                + ", ".join(open_nodes)
                + " — wait for terminal notification/provider-loss recovery")
        # bank the burn BEFORE the nodes go — cost is history (see cost_total)
        lost = round(sum(float((self.nodes.get(k) or {}).get("cost_usd") or 0.0)
                         for k in doomed_set), 6)
        lost_unknown = any(bool((self.nodes.get(k) or {}).get(
            "cost_usd_unknown")) for k in doomed_set)
        if lost:
            self.d["deleted_cost_usd"] = round(
                float(self.d.get("deleted_cost_usd") or 0.0) + lost, 6)
        if lost_unknown:
            self.d["deleted_cost_usd_unknown"] = True
        for k in doomed_set:
            self.nodes.pop(k, None)
            (self.d.get("mail") or {}).pop(k, None)
            (self.d.get("mail_log") or {}).pop(k, None)
            (self.d.get("notices") or {}).pop(k, None)
            (self.d.get("steered_log") or {}).pop(k, None)
        self.d["audiences"] = [
            a for a in self.d["audiences"]
            if a["grantee"] not in doomed_set and a["grantor"] not in doomed_set
            and a.get("delegated_by") not in doomed_set]
        self.d["audience_requests"] = [
            r for r in self.d["audience_requests"]
            if r["from"] not in doomed_set and r["target"] not in doomed_set
            and r["currently_at"] not in doomed_set]
        # a pending credit request must not outlive its node: the freed slug
        # can be re-minted by a later hire, and a stale approval would re-bind
        # to the namesake (review: swept-from-three-sites-not-the-fourth)
        self.d["credit_requests"] = [
            r for r in self.d.get("credit_requests", [])
            if r.get("node") not in doomed_set]
        # …and neither must an ask (redteam gap 2026-08-06, the fifth site of
        # the same sweep): a deleted agent's open question would re-bind its
        # answer to a re-minted namesake exactly like the credit row above
        self.d["asks"] = [
            a for a in self.d.get("asks", [])
            if a.get("node") not in doomed_set]
        # …nor a scope request (FR-13, same re-bind hazard as both above:
        # a stale approval would grant folders to a re-minted namesake)
        self.d["scope_requests"] = [
            r for r in self.d.get("scope_requests", [])
            if r.get("node") not in doomed_set]
        # FR-18 lifecycle ruling: dogs DIE with a deleted owner (archive only
        # pauses them — watchdog_fire handles that lazily)
        self.d["watchdogs"] = [
            w for w in self.d.get("watchdogs", [])
            if w.get("owner") not in doomed_set]
        extra = len(doomed_set) - 1
        def _deleted(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.deleted", actor_of(actor), self.node_ref(nid), node=nid,
                         relation=relation, extra=int(extra))
        self._notify_ev([parent], _deleted("report"))
        self._notify_ev(peers, _deleted("peer"))
        self._log("delete", actor, {"node": nid, "removed": sorted(doomed_set),
                                    **({"cost_usd": lost} if lost else {})}, [])
        return {"deleted": sorted(doomed_set), "warnings": []}

    # ------------------------------------------------------------- reallocate
    def switch_model(self, actor: str, nid: str, tier: str, *,
                     busy: bool | None = None,
                     account: str | None = None,
                     _queued: dict[str, Any] | None = None) -> dict[str, Any]:
        """User spec: swap an agent's model ON THE FLY, mid-life — the session
        survives (№16: --resume honors a changed --model; the next turn runs
        the new model). CHEAPER: the seat difference melts into the node's own
        grant — holding unchanged, free grows. PRICIER: paid from the node's
        own free first; the shortfall bubbles up the chain to the actor
        (§4.6-generalized). Agents may switch models anywhere in their
        SUBTREE, but never their own (user spec); the user switches anyone.

        D-234 (user ruling 2026-09-03): a switch asked for while the node is
        MID-TURN is QUEUED, not applied — the model stays what the running
        turn launched with, `pending_switch` records the target, and the
        switch applies at the turn boundary (the supervisor's `_run_one_turn`
        finally block, the one place every exit passes through; `reconcile`
        for a turn the backend's death ended). Interrupting the turn is the
        documented way to make it immediate. `busy` is the supervisor's live
        answer (the API doors pass it); the seat's durable `inflight` marker
        is read regardless, so the ledger alone answers correctly for a turn
        persisted before its process spoke. A second request while one is
        queued REPLACES the target; asking for the CURRENT tier cancels it.
        `_queued` is the pending record when the boundary applies it: the
        authority was checked when it was queued, the turn is over by
        construction, and the log row says when it was asked for."""
        if tier not in self.d["tiers"]:
            raise LedgerError(f"unknown tier {tier!r}; know {sorted(self.d['tiers'])}")
        self._require_live(nid)
        n = self.node(nid)
        if actor != USER and _queued is None:
            if actor == nid:
                raise LedgerError("you cannot switch your OWN model (user "
                                  "ruling) — your superior or the user can")
            if not self.is_ancestor(actor, nid):
                raise LedgerError("model switches cover your own subtree only")
        old = n["model"]
        pend = n.get("pending_switch")
        if tier == old:
            if pend and _queued is None:
                # D-234: asking for the tier it ALREADY runs while a switch is
                # queued is the cancel — the one control a queue needs, and
                # the same door the queue came in by
                n.pop("pending_switch", None)
                w = [f"CANCELLED the queued switch of {nid} to {pend['tier']} "
                     f"— it stays on {old}; nothing changes when its turn ends."]
                self._log("switch_queue_cancelled", actor,
                          {"node": nid, "was": pend["tier"], "kept": old}, w)
                self._notify_ev([x for x in [n["parent"]] if x not in (actor, None)],
                                _mint("lifecycle.switch_cancelled", actor_of(actor),
                                      self.node_ref(nid), node=nid,
                                      target=str(pend["tier"]), by=actor))
                return {"model": old, "seat": self.d["tiers"][old], "freed": 0,
                        "queued": False, "cancelled": pend["tier"],
                        "warnings": w}
            # design motto: asking for what's already true is a no-op, not an error
            return {"model": tier, "seat": self.d["tiers"][tier], "freed": 0,
                    "queued": False,
                    "warnings": [f"{nid} already runs {tier} — nothing to do"]}
        # the kiosk tier cap is checked HERE, after the no-op return and after
        # the authority checks. It used to run first, so switching a
        # grandfathered over-cap agent to the tier it ALREADY runs was refused
        # ("opus agents cannot be switched to") — a hard error for a request
        # that would change nothing, against the ratified idempotent-no-op rule.
        # It also leaked the cap to actors with no authority over the node.
        self._check_tier_ceiling(tier)
        if tier == "fable" and self.d.get("fable_lock") and actor == USER:
            self.clear_fable_lock()      # a user fable-switch is the decree
        # D-234: MID-TURN → QUEUE. The model the running turn launched with is
        # the model the chart must keep showing until that turn ends; a
        # switch applied under it would make the card, the cost booking and
        # the running process disagree — and for a crossing it would replace
        # the session a turn is still writing to. `inflight` is the seat's
        # durable "a turn is running" marker (persisted before any lane
        # speaks, popped at the boundary); `busy` is the supervisor's live
        # answer for the window before the marker lands. Either says busy.
        from . import providers        # noqa: PLC0415 — avoids a cycle: providers reads TIERS from this module
        crossed = providers.provider_of(old) != providers.provider_of(tier)
        if _queued is None and (busy or n.get("inflight")):
            # every refusal the immediate path would raise — the top-grant
            # cap, an unpayable shortfall, a top-level upgrade by an agent —
            # must fire NOW, at the request, not at the boundary where nobody
            # is listening. Run the real switch on a COPY of the doc: the
            # same code path, so the queue cannot drift from the immediate
            # switch (D-182), and no reservation machinery — a queue rarely
            # outlives one turn, and the boundary re-checks anyway.
            Org(json.loads(json.dumps(self.d))).switch_model(
                actor, nid, tier, _queued={"at": now(), "by": actor})
            replaced = pend["tier"] if pend else None
            n["pending_switch"] = {"tier": tier, "from": old, "by": actor,
                                   "at": now(), "crossing": crossed,
                                   # multi-account D2d: the account chosen
                                   # WITH a cross-provider switch (validated
                                   # at the door; the ledger is pure and
                                   # only carries it to the boundary apply)
                                   "account": account}
            gen = n.get("generation", 0)
            w = ((f"Replaces the queued switch to {replaced}. " if replaced else "")
                 + f"QUEUED, not switched: {nid} is mid-turn, so it stays on "
                 f"{old} until this turn ends and moves to {tier} from its "
                 f"next turn. To switch it NOW, interrupt the turn first (⏸ "
                 f"on its desk) — the queued switch applies the moment the "
                 f"turn ends, however it ends."
                 + (f" That is a provider crossing "
                    f"({providers.provider_of(old)}→"
                    f"{providers.provider_of(tier)}): when it applies, the "
                    f"conversation cannot carry over — the pre-switch self is "
                    f"archived in place as \"{nid}@{gen}\" and the successor "
                    f"starts fresh, cold; scratch, breadcrumbs and mail "
                    f"survive." if crossed else ""))
            warnings = [w]
            self._log("switch_queued", actor,
                      {"node": nid, "from": old, "to": tier,
                       "replaced": replaced, "crossing": crossed}, warnings)
            self._notify_ev([x for x in [n["parent"]] if x not in (actor, None)],
                            _mint("lifecycle.switch_queued", actor_of(actor),
                                  self.node_ref(nid), node=nid, old=str(old),
                                  new=str(tier), by=actor))
            return {"model": old, "seat": self.d["tiers"][tier], "freed": 0,
                    "queued": True, "tier": tier, "from": old,
                    "replaced": replaced, "crossing": crossed,
                    "warnings": warnings}
        if pend:
            # an immediate switch supersedes whatever was queued (the seat is
            # idle: the boundary already ran, or a restart's reconcile did —
            # this is the belt for a marker that somehow outlived both)
            n.pop("pending_switch", None)
        # ☞ THE ONE PATH THAT MAKES A *GRANT* FRACTIONAL. Everywhere else a
        # grant is a whole number the user or an agent asked for; here a seat
        # DIFFERENCE lands in it (melt on a downgrade, absorb on an upgrade),
        # so switching between a fractional seat and a whole one leaves the
        # node holding e.g. 5.8. That is correct — the node's total holding
        # must not move — and it is why every write below goes through _q.
        delta = _q(self.d["tiers"][tier] - self.d["tiers"][old])
        warnings: list[str] = []
        if delta <= 0:
            # seat shrinks; the difference becomes the node's own free
            # allocation — its total holding (and the parent's commitment)
            # never moves
            if n["parent"] is None and delta < 0:
                # D-014: even the downgrade-melt may not push a top-level
                # grant past the cap — reallocate the excess down first
                self._check_top_grant(n["grant"] - delta, "this downgrade")
            n["model"] = tier
            n["grant"] = _q(n["grant"] - delta)
        else:
            own = _q(min(self.free(nid), delta))  # the node's own free absorbs first
            shortfall = _q(delta - own)
            if shortfall > 0:
                if n["parent"] is None and actor != USER:
                    raise LedgerError("only the user funds a top-level upgrade")
                if n["parent"] is not None:
                    self._chain_acquire(actor, n["parent"], shortfall, warnings,
                                        cascade=bool(self.d.get("cascade_alloc", True)))
            n["model"] = tier
            n["grant"] = _q(n["grant"] - own)  # holding grows by exactly the shortfall
        # D-196: a switch that CROSSES PROVIDERS cannot keep the session, and
        # must not pretend to. `session_id` holds a provider-owned handle — a
        # codex threadId, an antigravity conversation id, a Claude session uuid — and
        # no provider can resume another's. Left in place it is not merely
        # useless but ACTIVELY FATAL: the claude lane decides "may I resume?"
        # by asking whether a transcript file exists, and `transcript_path`
        # deliberately falls back to the supervisor's own journal store, where
        # a codex thread's record IS written. So the file is found, `--resume
        # <codex threadId>` is emitted, and the CLI answers "No conversation
        # found with session ID …" — which killed a live agent's whole
        # transcript (2026-08-29) and marked the node unrecoverable.
        #
        # The honest behaviour is a CLEAN, ANNOUNCED reset at switch time. A
        # cross-provider conversation cannot be carried over at all (the
        # sessions live in three separate provider stores with no transport
        # between them), so promising continuity would be D-180's failure in
        # another field. A failure the user sees when they act is worth far
        # more than one that surfaces on their next message.
        pred_id: str | None = None
        old_sid: str | None = None
        # ⚠ a NEW key, not the generic `drive` other ops return: `drive`'s
        # callers (both API doors) hard-code an "you were ARCHIVED and
        # waited" message that would be a lie here — this node was live the
        # whole time, just frozen. Named so its own caller can send its own
        # accurate wording.
        resume_stale_freeze: list[str] = []
        if crossed:
            # freeze-clear (2026-09-03): a `frozen` marker is a claim about
            # OLD's provider — out of capacity, a network drop, a rejected
            # credential — and a crossing means the node is no longer on
            # that provider, so the claim describes nothing anymore. Popped
            # here, not merely masked, exactly like `_archive_session_in_
            # place` already zeroes `frozen` on the BEARER copy below; this
            # is the same reset applied to the LIVE successor, which that
            # call never touches. `freeze_describes_provider` keeps a
            # GLOBAL/org-owned kind (kiosk `spend`) untouched — that claim
            # has nothing to do with which provider this node runs on. A
            # freeze this pops is not silently forgotten:
            # `resume_stale_freeze` wakes the node once the switch lands, so
            # if TIER is *also* out of capacity the very next turn
            # re-freezes it for that reason instead of sitting "live" while
            # unable to do anything.
            old_freeze = n.get("frozen")
            if isinstance(old_freeze, dict) and freeze_describes_provider(
                    cast(FrozenInfo, old_freeze)):
                n.pop("frozen", None)
                resume_stale_freeze.append(nid)
                warnings.append(
                    f"{nid} was frozen on {providers.provider_of(old)} — "
                    f"that described a usage limit/connection/auth problem "
                    f"on the provider it just left, so it no longer "
                    f"describes anything and was cleared. If "
                    f"{providers.provider_of(tier)} is ALSO out of "
                    f"capacity, {nid} will simply re-freeze for that "
                    f"provider's own reason on its next turn.")
            # ⚠ NOT an in-place mint. That was this fix's first shape
            # (0b50a42) and it is how the desk went blank: `session_id` was
            # overwritten under a session that was REAL — hours of transcript
            # on disk, and on both live specimens of 2026-09-03
            # (openrouter-scope, openrouter-usage) a turn still RUNNING on it
            # — so every reader keyed on the field (the desk's /chat,
            # orgtree_read_transcript, the live-row sweep, the pardon spend)
            # looked up an id no file would ever carry, answered "no
            # conversation yet" for as long as the node lived, and the old
            # session dropped out of the ledger for good: not archived, not
            # in the lineage, unreachable from the UI while intact on disk
            # (the fleet switch to Codex of 2026-09-02 left nine such files).
            #
            # A cross-provider switch IS a cheap compact with a model change:
            # the seat keeps everything, the session is replaced, and the
            # pre-switch self is archived IN PLACE as a knowledge bearer on
            # its OWN tier (D-197: consultable or rehireable on the provider
            # that owns its transcript, never another). The bearer's desk
            # keeps rendering the conversation — a turn still running on it
            # included — and the successor starts empty on the new lane,
            # announced, from its next turn.
            pred_id, old_sid = self._archive_session_in_place(nid, model=old)
            # the successor is a MINTED id no lane will resume: the claude
            # lane starts it with --session-id, and codex/antigravity both
            # fail their marker equality. The lane markers die with the lane
            # (the bearer keeps its own copy — its session IS that thread).
            n.pop("codex_thread", None)
            n.pop("antigravity_conversation", None)
            # the successor session never posed the seat's open ask, and has
            # no baseline for the predecessor's notice backlog — the same two
            # doors cheap_compact closes, for the same reasons
            self._moot_asks(nid, "the asking session was replaced by a "
                                 "cross-provider model switch — the "
                                 "successor starts fresh and never posed it")
            self._fold_notices(nid)
            # the ACTOR is told at switch time, not left to discover it on the
            # next message — that is the whole point of moving this failure
            # forward. (Refuse-vs-warn for a BUSY node was the open question
            # here; the user's answer is neither — D-234 queues it.)
            # Both messages name the COST as well as the loss. An agent (or a
            # user) told only "the conversation does not carry over" can read
            # the switch as cheap. It is not: the parked warm process and the
            # whole prompt cache for this agent go with the session, so the
            # next turn is a full cold open — the single most expensive thing
            # that routinely happens on the claude lane. Measured 2026-08-30:
            # switching the fleet to Codex is why the Claude cache work could
            # not be validated at all — zero successful Claude requests in the
            # entire post-deploy window.
            warnings.append(
                f"{nid} moves from {providers.provider_of(old)} to "
                f"{providers.provider_of(tier)} — a different provider, so its "
                f"conversation CANNOT carry over and it starts a fresh session "
                f"from its next turn. The conversation so far is NOT lost: it "
                f"is archived in place as \"{pred_id}\" — read it from the "
                f"lineage panel, or rehire it on {providers.provider_of(old)} "
                f"to consult it. Its warm process and prompt cache go too, so "
                f"its next turn is a full cold open — the most expensive turn "
                f"it can have. Its scratch folder, breadcrumbs and mail are "
                f"untouched.")
        def _switched(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.model_switched", actor_of(actor), self.node_ref(nid),
                         node=nid, relation=relation, old=str(old), new=str(tier),
                         seat_old=float(self.d["tiers"][old]),
                         seat_new=float(self.d["tiers"][tier]), by=actor,
                         queued=bool(_queued), crossed=bool(crossed),
                         old_provider=(str(providers.provider_of(old)) if crossed else None),
                         new_provider=(str(providers.provider_of(tier)) if crossed else None),
                         predecessor=(str(pred_id) if crossed else None))
        self._notify_ev([x for x in [nid] if x != actor], _switched("self"))
        self._notify_ev([x for x in [n["parent"]] if x not in (actor, None)],
                        _switched("report"))
        # the split is on the record where cheap_compact's is: the bearer id
        # and the session it holds, so the switch's own log row names where
        # the conversation went
        # `transfer` names what the successor session received (verified
        # handoff, audit §3): "fresh" = an empty session; files, mail and the
        # file-only handoff record cross, the conversation does not. A
        # same-provider switch keeps the session and carries no label.
        split = ({"bearer": pred_id, "old_session": old_sid, "transfer": "fresh"}
                 if crossed else {})
        # D-234: an applied queue says when it was asked for, so the log row
        # and the result both read "queued at T, applied now"
        queued = ({"queued_at": _queued.get("at"), "queued_by": _queued.get("by")}
                  if _queued else {})
        self._log("switch_model", actor,
                  {"node": nid, "from": old, "to": tier, **split, **queued},
                  warnings)
        return {"model": tier, "seat": self.d["tiers"][tier],
                "freed": max(0, -delta), "queued": False,
                "warnings": warnings, "resume_stale_freeze": resume_stale_freeze,
                **split, **queued}

    def apply_pending_switch(self, nid: str) -> dict[str, Any] | None:
        """D-234: the turn the queue waited for is over — apply it, or say
        why not. Called by the supervisor at the turn boundary and by
        `reconcile` at startup; both hold DOC_LOCK and save afterwards.

        Returns None when nothing was queued, the switch result when it
        applied, or `{"dropped": reason}` when it could not. A queued switch
        is NEVER silently forgotten: a drop is logged as an event and told to
        the requesting agent and the live superior, and the node simply
        stays on the tier it ran — a whole state rather than a half one. The
        common refusals cannot reach here: the queue ran the real switch on
        a copy of the doc at the request, so what is left is the node having
        left `live` mid-turn, or credits that moved since."""
        n = self.nodes.get(nid)
        if n is None:
            return None
        pend = n.pop("pending_switch", None)
        if not pend:
            return None
        by, tier = str(pend.get("by") or USER), str(pend.get("tier") or "")
        try:
            if n["state"] != "live":
                raise LedgerError(f"{nid} is {n['state']}, not live — it "
                                  f"left before its turn ended")
            return self.switch_model(by, nid, tier, _queued=pend)
        except LedgerError as e:
            reason = str(e)
            w = [f"the queued switch of {nid} to {tier} was DROPPED at the "
                 f"end of its turn: {reason}. It stays on {n['model']}; ask "
                 f"again once that is resolved."]
            self._log("switch_queue_dropped", by,
                      {"node": nid, "to": tier, "reason": reason,
                       "queued_at": pend.get("at")}, w)
            tell = [x for x in {by, n.get("parent")}
                    if x and x != nid and x in self.nodes
                    and self.nodes[x]["state"] == "live"]
            self._notify_ev(tell, _mint("lifecycle.switch_dropped", actor_of(by),
                                        self.node_ref(nid), node=nid, target=tier,
                                        kept=str(n["model"]), reason=reason))
            return {"dropped": reason, "tier": tier, "warnings": w}

    def reallocate(self, actor: str, nid: str, delta: float) -> dict[str, Any]:
        """±Δ between a node and its parent (§4.2). -Δ is the classic stranding op."""
        self._require_authority(actor, nid)
        self._require_live(nid)
        n = self.node(nid)
        # QUANTISE, don't truncate. Agent and UI callers still pass whole
        # credits (mcptool's schema says `"type": "integer"`, and the credit
        # bar drags in whole steps) — but `credit_request_action` computes its
        # delta as `give − grant`, and a grant left fractional by a
        # switch_model melt makes that a fraction. The old int() silently
        # dropped it, so approving "give this node 10" landed 9.8.
        delta = _q(delta)
        # ☞ …and then SNAP THE TARGET UP to a whole credit (user ruling
        # 2026-09-04). This is the one op that writes a grant straight from an
        # operator's input, so it is the one that must not be able to re-open
        # the invalid state the migration just closed — e.g. a stale credit
        # bar still showing the pre-heal 104.2 and sending its 0.8. Snapping
        # the TARGET rather than the RESULT is deliberate: every check below
        # (the free-credit refusal, the §4.6 chain acquire, the D-014 cap)
        # then runs on the amount actually being written, so a round-up that
        # nobody can afford is REFUSED rather than overdrawn. UP only — a snap
        # downward would hand back less than the caller asked for.
        delta = _q(math.ceil(_q(n["grant"] + delta)) - n["grant"])
        warnings: list[str] = []
        strand: list[str] = []
        if delta > 0:
            if n["parent"] is None:
                self._check_top_grant(n["grant"] + delta, "this allocation")  # D-014
            else:
                # §4.6 generalized: shortfall bubbles up the chain to the actor
                self._chain_acquire(actor, n["parent"], delta, warnings,
                                    cascade=bool(self.d.get("cascade_alloc", True)))
        elif delta < 0:
            if self.free(nid) < -delta:
                raise LedgerError(
                    f"{nid} has only {self.free(nid):g} unused; the rest is committed")
            # user ruling 2026-09-03: a reduction's stranding list no longer
            # interrupts the actor with a popup — it's a consequence, not a
            # refusal (the free-credit check above is the actual refusal).
            # Still recorded to the event log (below) for anyone auditing.
            strand = self._stranding_warnings(
                nid, self.free(nid), self.free(nid) + delta)
        # delta stays WHOLE (int() above): nobody asks for 0.3 of a credit —
        # only seats are fractional. The grant it lands on may not be, though
        # (switch_model's melt), so the write is quantised like every other.
        n["grant"] = _q(n["grant"] + delta)
        if delta != 0:
            # typed (family access_resources): access.grant_changed — the node's
            # own copy and its superior's, each the event's rendering
            fr = self.free(nid)
            self._notify_ev([x for x in [nid] if x != actor],
                            _mint("access.grant_changed", actor_of(actor), self.node_ref(nid),
                                  relation="self", node=nid, delta=float(delta),
                                  now=float(n["grant"]), free=float(fr), by=actor))
            self._notify_ev([x for x in [n["parent"]] if x != actor],
                            _mint("access.grant_changed", actor_of(actor), self.node_ref(nid),
                                  relation="report", node=nid, delta=float(delta),
                                  now=float(n["grant"]), free=float(fr), by=actor))
        self._log("reallocate", actor, {"node": nid, "delta": delta}, warnings + strand)
        return {"grant": n["grant"], "warnings": warnings}

    # --------------------------------------------------------- promote/demote
    def promote(self, actor: str, nid: str, new_parent: str | None) -> dict[str, Any]:
        """Re-parent upward (§4.5): new_parent must be a strict ancestor of the current
        parent (None = to top level, actor must be USER)."""
        cur = self.parent(nid)
        target = USER if new_parent is None else new_parent
        # audit finding: the docstring promised this and the code never
        # enforced it — top level is the privileged class (unbidden user
        # mail, org voice, extern recipients), so only the user seats it
        if new_parent is None and actor != USER:
            raise LedgerError("only the user promotes agents to top level (§7.4)")
        if new_parent is None:
            # D-014: promotion may not seat an over-cap grant at top level
            self._check_top_grant(self.node(nid)["grant"], "this promotion")
        if target != USER and not self.is_ancestor(target, nid):
            raise LedgerError(f"promote target {target} is not above {nid}")
        if target == cur:
            raise LedgerError(f"{nid} already reports to {cur}")
        if cur != USER and target != USER and not self.is_ancestor(target, cur):
            raise LedgerError("promote must move the node strictly upward (§4.2)")
        return self._move("promote", actor, nid, new_parent)

    def demote(self, actor: str, nid: str, new_parent: str) -> dict[str, Any]:
        """Re-parent downward/lateral under another of the actor's descendants (§4.5)."""
        if new_parent == nid or new_parent in self.descendants(nid, live_only=False):
            raise LedgerError("cannot demote a node into its own subtree — cycle (§4.5)")
        return self._move("demote", actor, nid, new_parent)

    def move(self, actor: str, nid: str, new_parent: str | None) -> dict[str, Any]:
        """§4.5 unified reorganization verb (gap audit №7): promote or demote,
        decided by direction — the capability the design derived (§4.5: a
        fully-occupied tree can still reorganize) and only the user could
        reach until now. Same-parent = success no-op (motto A3)."""
        # the RAW parent slot (None at top level) — parent()'s USER sentinel
        # made every top-level source blow up downstream (ancestors("@user"))
        # and leaked the sentinel into user-facing messages
        cur = self.node(nid)["parent"]
        tgt = None if new_parent in (None, USER) else new_parent
        if tgt == cur:
            return {"warnings": [f"{nid} already reports to "
                                 f"{tgt or 'the top level'} — nothing to do"]}
        if tgt is None or (cur is not None
                           and self.is_ancestor(tgt, cur)):
            return self.promote(actor, nid, tgt)
        return self.demote(actor, nid, tgt)

    # ------------------------------------------- seat exchange & move batches
    def subjugate(self, actor: str, nid: str, target: str) -> dict[str, Any]:
        """D-224 ①: the SELF-SUBJUGATION verb — `nid` exchanges seats with a
        live descendant `target` (swap_seats' semantics, plus the contract
        that the pair is commander-and-subordinate). The flagship workflow:
        hire a replacement, subjugate to it, hand over, then self-retire
        beneath it under the normal leaf-only rule (№26)."""
        self._require_authority(actor, nid, allow_self=True)
        if target == nid:
            raise LedgerError("subjugation needs a second party — name one "
                              "of the seat's live subordinates as the target")
        self.node(target)
        if target not in self.descendants(nid):
            raise LedgerError(
                f'"{target}" is not a live descendant of "{nid}" — '
                f"subjugation reaches only into that seat's own subtree; for "
                f"two unrelated agents use the pairwise swap (D-224)")
        out = self.swap_seats(actor, nid, target, _op="subjugate",
                              _self_subjugation=actor == nid)
        if actor == nid:
            new_sup = self.node(nid)["parent"]
            disp = f'"{new_sup}"' if new_sup else "the top level"
            out["next_step"] = (
                f"You now report to {disp}. For a hand-over retirement: "
                f"transfer any loose ends, then orgtree_retire yourself — "
                f"self-retire requires you to be a leaf (№26).")
        return out

    def swap_seats(self, actor: str, a: str, b: str,
                   _op: str = "swap_seats", *,
                   _self_subjugation: bool = False) -> dict[str, Any]:
        """D-224 ②: two agents EXCHANGE SEATS — a pure relabeling of two
        positions in the tree (user spec 2026-09-02: the swap tool carries
        exactly this one semantics; "swap positions, each keeping its own
        team" is instead a batched pair of moves, see move_batch).

        Because the shape is untouched, no cycle is constructible and the
        depth/children caps hold by construction — for ANY pair, nested or
        disjoint. What follows from the relabeling:

        • the SEAT keeps what the chain clamps and funds — its reports
          (archived dependents included), its grant, its team charter, its
          display slot, and the four chain-clamped scope sets (dirs, tools,
          visibility, permission mode — №30 + D-021 + D-102). Every
          containment edge keeps its pre-swap ⊆ relation, so no bystander
          is ever swept;
        • the AGENT keeps what identifies it — charter, session, mailbox,
          watchdogs, external handles, lineage stack (which follows it,
          §8.5), and the personal scope keys that clamp against nothing
          (effort, auto_cheap_compact, model_version);
        • grants ride the seats, so a same-tier exchange is budget-neutral
          at EVERY node, and a cross-tier one surfaces exactly the
          seat-cost difference at the two boundary payers — pre-checked
          below, so a refusal mutates nothing (§2b atomicity). The grant
          VALUE seated at top level never changes, so D-014 cannot trip on
          this route;
        • a nested, non-adjacent pair keeps a standing audience (grantee =
          the descended, grantor = the risen), §7.3-anchored on the grantor
          so it lives exactly while the risen still commands the other.
        """
        if a == b:
            raise LedgerError("a seat swap needs two different agents")
        if self.is_ancestor(b, a):
            a, b = b, a                  # nested pairs: the commander first
        n_a, n_b = self.node(a), self.node(b)
        nested = self.is_ancestor(a, b)
        self._require_authority(actor, a, allow_self=True)
        self._require_authority(actor, b, allow_self=True)
        self._require_live(a)
        self._require_live(b)
        p_a, p_b = n_a["parent"], n_b["parent"]
        direct = p_b == a
        # The dedicated self-subjugation route may hand over the caller's
        # OWN top seat to its live descendant (user ruling 2026-09-05).
        # Ordinary swaps still require the user; the private marker is never
        # read from API arguments, and cannot authorize raising its actor.
        voluntary = (_self_subjugation and actor == a and nested
                     and p_a is None)
        if (p_a is None or p_b is None) and actor != USER and not voluntary:
            raise LedgerError(
                "only the user reseats the top level (§7.4) — ask the user "
                "to perform this swap")
        for who_ in (a, b):
            succ = self.nodes[who_].get("successor")
            if succ and succ in self.nodes:
                raise LedgerError(
                    f'{who_} is a lineage bearer of "{succ}" — the stack '
                    f'shares its successor\'s slot (§8.5) and holds no seat '
                    f'of its own to swap')
            live_b = [k for k in self.lineage_stack(who_)
                      if self.nodes[k]["state"] != "archived"]
            if live_b:
                raise LedgerError(
                    f"{who_} has live lineage bearer(s) {live_b} under "
                    f"consultation — retire them first; a stack follows its "
                    f"owner through the swap (§8.5)")

        # ⚠ THE SLOT EACH AGENT LANDS IN MUST NOT BE ITS OWN STACK, and must
        # be LIVE (redteam 2026-09-02, reproduced). _move carries the same
        # guard and this method was written without it on the reasoning that
        # a relabeling cannot build a cycle. That is true of the ORG axis and
        # false of §8.5's second one: an archived bearer shares its owner's
        # parent slot, so it travels with the owner — and if the other agent
        # happens to sit UNDER that bearer, the owner is sent into the slot
        # its own stack is being moved to. Measured: `a@0.parent == "a@0"`, a
        # real self-cycle, plus free(a@0) = -25, from one legal-looking
        # orgtree_swap. The liveness half is the same shape one step out: a
        # destination that is archived would strand a live agent under it.
        for mover, dest in ((a, b if direct else p_b), (b, p_a)):
            if dest is None:
                continue
            if dest in self._stack_region(mover):
                raise LedgerError(
                    f'"{mover}" would land on the branch of its own lineage '
                    f'bearer (at "{dest}"), and that branch travels with it '
                    f"(§8.5) — the result is a cycle, not a swap. Retire or "
                    f"re-parent the stack first")
            if self.nodes[dest]["state"] == "archived":
                raise LedgerError(
                    f'"{mover}" would report to "{dest}", which is archived '
                    f"— a live agent may not hang under an archived one")

        s_a, s_b = self.seat_cost(a), self.seat_cost(b)
        g_a, g_b = n_a["grant"], n_b["grant"]
        warnings: list[str] = []
        free_a0 = self.free(a)
        free_pa0 = 0.0 if p_a is None else self.free(p_a)
        free_pb0 = 0.0 if p_b is None else self.free(p_b)
        # ⚠ SIBLINGS PAY NOTHING, and pricing them as if they did broke the
        # verb's whole promise on its most obvious use (redteam 2026-09-02).
        # When both agents hang off the SAME superior, that superior loses and
        # gains both seats at once: its committed goes
        # (s_a+g_a)+(s_b+g_b) → (s_a+g_b)+(s_b+g_a), the same total. The two
        # checks below each price one leg as though the other never happened,
        # so a fully-occupied parent (free 0) saw a swap of its own haiku and
        # opus reports refused for a cost of 4 that does not exist — against
        # §4.5's "a fully occupied tree can still reorganize".
        siblings = p_a is not None and p_a == p_b
        if s_a != s_b and not siblings:
            # cross-tier: the seats trade their occupants' tiers, so each
            # boundary payer sees exactly the seat-cost difference — the
            # grants trade WITH the seats and cancel out (D-224).
            if p_a is not None and free_pa0 + s_a - s_b < 0:
                raise LedgerError(
                    f'seating "{b}" ({n_b["model"]}, seat {s_b}) where '
                    f'"{a}" ({n_a["model"]}, seat {s_a}) sat costs '
                    f"{s_b - s_a} more than {p_a}'s free ({free_pa0:g}) — "
                    f"reallocate first (§4.6)")
            if direct and free_a0 + s_b - s_a < 0:
                raise LedgerError(
                    f'"{b}" would fund "{a}"\'s seat ({s_a}) out of the '
                    f"exchanged grant with free {free_a0 + s_b - s_a:g} — "
                    f"the seat-cost difference does not fit; reallocate "
                    f"first (§4.6)")
            if not direct and p_b is not None and free_pb0 + s_b - s_a < 0:
                raise LedgerError(
                    f'seating "{a}" ({n_a["model"]}, seat {s_a}) where '
                    f'"{b}" ({n_b["model"]}, seat {s_b}) sat costs '
                    f"{s_a - s_b} more than {p_b}'s free ({free_pb0:g}) — "
                    f"reallocate first (§4.6)")

        prior_peers_a = self._peers_of(p_a, a)
        prior_peers_b = self._peers_of(p_b, b)
        kids_a = [k for k in self.children(a) if k != b]
        kids_b = [k for k in self.children(b) if k != a]

        # ---- mutation: a pure relabeling plus field trades; nothing below
        # raises, so a refusal above has left the tree byte-identical (§2b)
        for k, v in self.nodes.items():
            if k == a or k == b:
                continue
            if v["parent"] == a:
                v["parent"] = b
            elif v["parent"] == b:
                v["parent"] = a
        n_b["parent"] = p_a
        n_a["parent"] = b if direct else p_b
        for k in self.lineage_stack(a):        # §8.5: a stack shares its
            self.nodes[k]["parent"] = n_a["parent"]     # successor's slot
        for k in self.lineage_stack(b):
            self.nodes[k]["parent"] = n_b["parent"]
        n_a["grant"], n_b["grant"] = g_b, g_a
        n_a["ui_order"], n_b["ui_order"] = n_b["ui_order"], n_a["ui_order"]
        sa, sb = n_a["scope"], n_b["scope"]
        # each side gains whatever the OTHER seat held — said out loud for the
        # same reason insert_parent says it (see _scope_raises)
        raised = {k: v for k, v in ((a, self._scope_raises(sa, sb)),
                                    (b, self._scope_raises(sb, sa))) if v}
        sa["add_dirs"], sb["add_dirs"] = sb["add_dirs"], sa["add_dirs"]
        sa["tools"], sb["tools"] = sb["tools"], sa["tools"]
        sa["org_visibility"], sb["org_visibility"] = (
            sb.get("org_visibility", "full"), sa.get("org_visibility", "full"))
        sa["permission_mode"], sb["permission_mode"] = (
            sb.get("permission_mode", "acceptEdits"),
            sa.get("permission_mode", "acceptEdits"))
        tc_a = n_a.pop("team_charter", None)
        tc_b = n_b.pop("team_charter", None)
        if tc_b is not None:
            n_a["team_charter"] = tc_b
        if tc_a is not None:
            n_b["team_charter"] = tc_a

        retained = False
        if nested and not direct and not self._has_audience(a, b):
            # coordinator spec: a swapped commander-and-subordinate pair must
            # still be able to talk. The risen (b) reaches the descended (a)
            # natively — a report at any depth — while a → b needs a standing
            # grant. Anchored on the GRANTOR (§7.3), so it lives exactly as
            # long as b still commands a.
            entry: AudienceGrant = {
                "grantee": a, "grantor": b, "granted_at": now(),
                "reason": f'retained across the seat swap with "{b}"'}
            self.d["audiences"].append(entry)
            retained = True
        for who_, gains in raised.items():
            warnings.append(f'"{who_}" took the other seat\'s scope, which '
                            f"GRANTS IT " + "; ".join(gains)
                            + " — retool it if that is more than you meant "
                              "to give.")
        swept = self._sweep_audiences()
        warnings += [f"audience revoked (no longer ancestral): {g}→{t}"
                     for g, t in swept]
        dropped = self._sweep_dirs(b) + self._sweep_dirs(a)
        if dropped:
            # provably nothing to drop for dirs/tools/visibility (every edge
            # keeps its old ⊆); what CAN die here is a D-101 permission-mode
            # raise held by either party — relocation re-derives it (D-102),
            # exactly as a move would.
            warnings.append(
                f"capabilities the new chain does not hold were dropped "
                f"(№30): {dropped}")
        if s_a != s_b and not siblings:
            if p_a is not None:
                warnings += self._stranding_warnings(
                    p_a, free_pa0, self.free(p_a))
            if direct:
                warnings += self._stranding_warnings(b, free_a0, self.free(b))
            elif p_b is not None:
                warnings += self._stranding_warnings(
                    p_b, free_pb0, self.free(p_b))

        # typed (family lifecycle): lifecycle.seat_swapped, one event per
        # audience role; each text is the event's rendering (§L tests)
        aud_a = (f' You keep a standing audience with "{b}" — message it '
                 f'directly.' if retained else "")
        aud_b = (f' "{a}" keeps a standing audience with you.'
                 if retained else "")
        nested = bool(p_a == p_b)

        def _swap(role: str, node: str, *, reports_to: str | None = None,
                  grant_after: str | None = None, note: str | None = None) -> dict[str, Any]:
            return _mint("lifecycle.seat_swapped", actor_of(actor), self.node_ref(node),
                         a=a, b=b, role=role, nested=nested, by=actor,
                         reports_to_after=reports_to, grant_after=grant_after,
                         audience_note=(note or None))
        if nested:
            self._notify_ev([p for p in [p_a] if p != actor], _swap("parent_of_a", a))
            self._notify_ev([p for p in prior_peers_a if p != actor and p != b],
                            _swap("peer_of_a", a))
        else:
            self._notify_ev([p for p in [p_a] if p != actor], _swap("parent_of_a", a))
            self._notify_ev([p for p in prior_peers_a if p != actor], _swap("peer_of_a", a))
            if not direct:
                self._notify_ev([p for p in [p_b] if p != actor], _swap("parent_of_b", b))
                self._notify_ev([p for p in prior_peers_b if p != actor],
                                _swap("peer_of_b", b))
        self._notify_ev([k for k in kids_a if k != actor], _swap("child_of_a", a))
        self._notify_ev([k for k in kids_b if k != actor], _swap("child_of_b", b))
        self._notify_ev([p for p in [a] if p != actor],
                        _swap("a", a, reports_to=n_a["parent"], grant_after=str(g_b),
                              note=aud_a))
        self._notify_ev([p for p in [b] if p != actor],
                        _swap("b", b, reports_to=p_a, grant_after=str(g_a), note=aud_b))
        self._log(_op, actor,
                  {"a": a, "b": b, "nested": nested,
                   "a_to": n_a["parent"], "b_to": p_a}, warnings)
        return {"swapped": [a, b], "nested": nested,
                "now_under": {a: n_a["parent"] or "top level",
                              b: p_a or "top level"},
                "audience_retained": retained, "warnings": warnings}

    def move_batch(self, actor: str,
                   moves: list[tuple[str, str | None]]) -> dict[str, Any]:
        """D-224 ③: several §4.5 moves as ONE all-or-nothing transaction, in
        the caller's order (user spec 2026-09-02: "allow moves to be batched
        atomically"). Each step is a full ordinary move() with its own
        validations against the then-current tree; a refusal at ANY step
        restores the tree to before the FIRST (D-160's shape: the caller is
        never told "moved" while quietly getting less than it asked). The
        classic use: the two moves of a position swap in which each node
        keeps its own suborganization — [a → parent(b), b → parent(a)] —
        which no single move can express and which two separate calls could
        leave half-done."""
        mv = [(str(n or ""), (p or None)) for n, p in moves]
        if not mv:
            raise LedgerError("an empty batch moves nothing — pass 1..20 "
                              "moves")
        if len(mv) > 20:
            raise LedgerError(f"at most 20 moves per batch (got {len(mv)})")
        snap = copy.deepcopy(self.d)
        results: list[dict[str, Any]] = []
        for i, (n, p) in enumerate(mv):
            try:
                results.append(self.move(actor, n, p))
            except LedgerError as e:
                self.d = snap    # `nodes` is a property over d — rebound too
                raise LedgerError(
                    f"batch refused at step {i + 1}/{len(mv)} "
                    f"({n} → {p or 'the top level'}): {e} — nothing was "
                    f"applied; the tree is as it was")
        warnings = [w for r in results for w in r.get("warnings", [])]
        self._log("move_batch", actor,
                  {"moves": [{"node": n, "to": p} for n, p in mv]}, warnings)
        return {"moved": len(mv), "warnings": warnings}

    def _stack_region(self, nid: str) -> set[str]:
        """Everything that travels with `nid` when it changes seats: its §8.5
        lineage stack, and everything hanging off those bearers.

        ⚠ The DESCENDANTS are the half that matters and the half the first
        cut of this guard missed (redteam 2026-09-02). A bearer is dragged to
        its owner's new parent slot; its own subtree keeps pointing at the
        bearer and so is dragged with it — while nothing re-parents that
        subtree, so a destination anywhere ON that branch closes a loop. The
        measured shape was two levels down: `q0.parent == "a@0"` and
        `a@0.parent == "q0"`, with the owner orphaned inside the cycle.

        Deliberately NOT closed over `{nid} ∪ descendants(nid)` the way
        `_move` is: a seat exchange leaves the org axis' shape alone (the
        relabel re-points each child to whichever agent now holds its seat),
        so descending into one's own org descendant is the NESTED CASE, not a
        cycle. Only §8.5's second axis lacks that protection."""
        bad: set[str] = set()
        for s in self.lineage_stack(nid):
            bad.add(s)
            bad.update(self.descendants(s, live_only=False))
        return bad

    @staticmethod
    def _scope_raises(had: NodeScope, gets: NodeScope) -> list[str]:
        """D-224: what moving into a seat GRANTS its new occupant, named one
        capability at a time.

        Scope rides the seat, so an agent that rises into one gains whatever
        that seat holds — never more than the seat already held, and never
        more than the actor could hand over with a retool, so this is no
        escalation. It is, however, a capability the agent was not hired
        with: a seat deliberately set to `plan` with no tools can come back
        from an exchange or an insertion holding `bypassPermissions` and the
        seat's folders (redteam 2026-09-02). Refusing would be wrong — the
        containment invariant needs the transfer — but arriving in silence
        is how nobody notices, so every verb that moves a scope says this
        out loud in its result."""
        out: list[str] = []
        gained = ({d["path"] for d in gets["add_dirs"]}
                  - {d["path"] for d in had["add_dirs"]})
        if gained:
            out.append("folders " + ", ".join(sorted(gained)))
        for k in ("bash", "web", "edit", "subagents"):
            if gets["tools"].get(k) and not had["tools"].get(k):
                out.append(f"tool {k}")
        mcp = set(gets["tools"].get("mcp") or []) - set(had["tools"].get("mcp") or [])
        if mcp:
            out.append("mcp " + ", ".join(sorted(mcp)))
        pg = gets.get("permission_mode", "acceptEdits")
        ph = had.get("permission_mode", "acceptEdits")
        if pg in PM_LEVELS and ph in PM_LEVELS \
                and PM_LEVELS.index(pg) > PM_LEVELS.index(ph):
            out.append(f"permission mode {ph} → {pg}")
        vg = gets.get("org_visibility", "full")
        vh = had.get("org_visibility", "full")
        if vg in VIS_LEVELS and vh in VIS_LEVELS \
                and VIS_LEVELS.index(vg) > VIS_LEVELS.index(vh):
            out.append(f"visibility {vh} → {vg}")
        return out

    HIRE_TYPES: Final[tuple[str, ...]] = ("subordinate", "superior")

    def check_placement(self, actor: str, target: str, hire_type: str,
                        rising: str | None = None) -> None:
        """D-224 ④, the destination contract shared by hire and rehire
        (user correction 2026-09-02). `target` is the caller itself or any
        live node in its subtree — never anything outside it; `hire_type`
        says which side of that target the seat lands on. Validated BEFORE
        anything is created, so a bad destination costs nothing."""
        if hire_type not in self.HIRE_TYPES:
            raise LedgerError(
                f"hire_type must be one of {list(self.HIRE_TYPES)} "
                f"(got {hire_type!r})")
        self.node(target)
        self._require_live(target)
        if actor_kind(actor) not in ("user", "system"):
            if target != actor and not self.is_ancestor(actor, target):
                raise LedgerError(
                    f'"{target}" is outside your subtree — a destination is '
                    f"yourself or one of your own descendants (§7.1)")
        if hire_type != "superior":
            return
        if self.node(target)["parent"] is None and actor != USER:
            # §7.4, promote()'s gate: inserting above a TOP-LEVEL target
            # seats the new agent at top level, and only the user does that.
            raise LedgerError(
                f'"{target}" is a top-level agent — inserting a superior '
                f"above it would seat that agent at top level, which only "
                f"the user may do (§7.4). Ask the user with orgtree_ask")
        succ = self.node(target).get("successor")
        if succ and succ in self.nodes:
            raise LedgerError(
                f'{target} is a lineage bearer of "{succ}" — it shares its '
                f"successor's slot (§8.5) and has no seat to insert above")
        live_b = [k for k in self.lineage_stack(target)
                  if self.nodes[k]["state"] != "archived"]
        if live_b:
            # checked HERE, not just in insert_parent: this is what a hire
            # consults before it creates anything, and a stack that cannot
            # follow its owner must refuse the whole call at the door
            raise LedgerError(
                f"{target} has live lineage bearer(s) {live_b} under "
                f"consultation — retire them first (a stack follows its "
                f"owner through the insertion, §8.5)")
        cap_d = self.d.get("max_depth", MAX_DEPTH)
        # ⚠ `rising` is the report that will BECOME the superior, and its own
        # branch therefore moves UP one, not down (redteam 2026-09-02: pricing
        # it as descending refused an insertion above a leaf a whole level
        # early). Only what stays beneath the target descends. From the hire
        # path there is no rising node yet — the seat does not exist — and
        # every existing descendant really does drop one.
        risen: set[str] = set()
        if rising:
            risen = {rising, *self.descendants(rising, live_only=False)}
        sub = [k for k in self.descendants(target, live_only=False)
               if k not in risen]
        deepest = max((self.depth(k) for k in sub), default=self.depth(target))
        if deepest + 1 >= cap_d:
            raise LedgerError(
                f"max org depth {cap_d} reached — inserting a superior above "
                f'"{target}" pushes its whole branch one level down, seating '
                f"its deepest report at {deepest + 1}")

    def insert_parent(self, actor: str, nid: str, target: str) -> dict[str, Any]:
        """D-224 ④: ATOMIC PARENT INSERTION. `nid` — a live direct report of
        `target` — takes `target`'s own position under `target`'s former
        superior, and `target`, with its ENTIRE existing subtree, becomes
        `nid`'s report. Nobody else moves.

        The accounting is the whole point, so it is stated exactly. Write
        s(x) for seat cost and g(x) for grant, and let P be target's former
        superior. The mutation is

            g(target) -= s(nid) + g(nid)        # target hands back nid's stake
            g(nid)     = s(target) + g(target)  # …and nid now funds target
                         + g(nid)               #    while keeping its own

        under which P commits s(nid)+g(nid) = s(target)+g(target) — exactly
        what it committed before — and free() is UNCHANGED at every node in
        the org, target and nid included. So the insertion itself is
        budget-neutral and cannot fail on credits: the whole price of the
        operation was the ordinary hire that created `nid` as target's
        report, paid out of target's own free at that moment (§4.6). Making
        the caller pay the ordinary price of an ordinary hire is what keeps
        this from being a way to spend a superior's credits without asking.

        Scope rides the SEAT (D-224's rule for the exchange, and forced
        here): `nid` takes target's dirs, tools, visibility and permission
        mode, because target's branch is about to sit beneath it and
        child ⊆ parent must hold — an inserted parent holding LESS would
        silently clamp the caller's whole team on the next sweep."""
        if nid == target:
            raise LedgerError("a node cannot be inserted above itself")
        n_new, n_t = self.node(nid), self.node(target)
        self._require_authority(actor, target, allow_self=True)
        self._require_authority(actor, nid, allow_self=True)
        self._require_live(nid)
        self._require_live(target)
        if n_new["parent"] != target:
            raise LedgerError(
                f'"{nid}" must already report to "{target}" to be inserted '
                f'above it (it reports to {n_new["parent"] or "the top level"})')
        self.check_placement(actor, target, "superior", rising=nid)
        succ = n_new.get("successor")
        if succ and succ in self.nodes:
            raise LedgerError(
                f'{nid} is a lineage bearer of "{succ}" — the stack shares '
                f"its successor's slot (§8.5)")
        for who_ in (nid, target):
            live_b = [k for k in self.lineage_stack(who_)
                      if self.nodes[k]["state"] != "archived"]
            if live_b:
                raise LedgerError(
                    f"{who_} has live lineage bearer(s) {live_b} under "
                    f"consultation — retire them first (a stack follows its "
                    f"owner, §8.5)")
        cap_c = self.d.get("max_children", MAX_CHILDREN)
        if len(self.org_children(nid)) + 1 > cap_c:
            raise LedgerError(
                f"{nid} would hold {len(self.org_children(nid)) + 1} reports "
                f"(cap {cap_c}) once {target}'s branch moves beneath it")
        p = n_t["parent"]
        # the same §8.5 slot guard swap_seats carries: `nid` rises into the
        # target's slot and its own stack rises with it, so that slot may not
        # BE one of those bearers, nor an archived node
        if p is not None:
            if p in {nid, *self.lineage_stack(nid)}:
                raise LedgerError(
                    f'"{nid}" would land in the slot of "{p}", which moves '
                    f"with it (§8.5 lineage stack) — that is a cycle, not an "
                    f"insertion")
            if self.nodes[p]["state"] == "archived":
                raise LedgerError(
                    f'"{target}" reports to "{p}", which is archived — '
                    f"insertion would strand a live agent under it")
        seat_n, seat_t = self.seat_cost(nid), self.seat_cost(target)
        g_n, g_t = n_new["grant"], n_t["grant"]
        stake_n = _q(seat_n + g_n)
        if g_t - stake_n < 0:
            # unreachable while free() >= 0 (target funded nid's stake out of
            # that grant); refuse rather than write a negative grant, the same
            # call _move makes on the release leg
            raise LedgerError(
                f"cannot insert {nid} above {target}: {target} holds a grant "
                f"of {g_t:g}, less than the {stake_n:g} its own report commits — "
                f"the chain's accounting is inconsistent (§4.5)")
        if p is None:
            # D-014: the top-level GRANT VALUE changes (the holding does not)
            self._check_top_grant(_q(seat_t + g_t - seat_n),
                                  f"inserting {nid} above {target}")

        # ---- mutation: nothing below raises (§2b — a refusal above has left
        # the tree byte-identical)
        n_new["parent"] = p
        n_t["parent"] = nid
        for k in self.lineage_stack(nid):        # §8.5: stacks share the slot
            self.nodes[k]["parent"] = p
        for k in self.lineage_stack(target):
            self.nodes[k]["parent"] = nid
        n_t["grant"] = _q(g_t - stake_n)
        n_new["grant"] = _q(seat_t + n_t["grant"] + g_n)
        n_new["ui_order"] = n_t["ui_order"]      # it holds target's old slot
        sc_t, sc_n = n_t["scope"], n_new["scope"]
        # ⚠ SAY WHAT THE SEAT JUST HANDED OVER (redteam 2026-09-02). Taking
        # the target's scope is forced — its branch is about to sit beneath
        # this node and child ⊆ parent must hold, permission mode included
        # (a lower one would clamp the whole branch on the next sweep). But
        # an agent deliberately seated at `plan` with no tools can come back
        # from an insertion holding `bypassPermissions` and the seat's
        # folders, and doing that SILENTLY is how a capability arrives that
        # nobody chose. It is never MORE than the target already held, and
        # never more than the actor could grant with retool — so it is not
        # an escalation, and it is not the caller's to discover later.
        raises = self._scope_raises(sc_n, sc_t)
        # …and the other direction: a hire in this mode passes its own
        # add_dirs/tools/visibility/mode in the same call, and the seat's
        # scope REPLACES them. Naming only the gains would leave a caller
        # believing the narrower thing it asked for had survived.
        removed = self._scope_raises(sc_t, sc_n)
        sc_n["add_dirs"] = cast("list[DirGrant]",
                                [dict(d) for d in sc_t["add_dirs"]])
        sc_n["tools"] = cast("ToolGrant",
                             {**sc_t["tools"],
                              "mcp": list(sc_t["tools"].get("mcp") or [])})
        sc_n["org_visibility"] = sc_t.get("org_visibility", "full")
        sc_n["permission_mode"] = sc_t.get("permission_mode", "acceptEdits")
        warnings: list[str] = []
        if raises or removed:
            warnings.append(
                f'"{nid}" took "{target}"\'s scope — an inserted superior '
                f"must hold exactly what the branch beneath it holds, so "
                f"this REPLACES the scope it was hired with"
                + (". GRANTS IT " + "; ".join(raises) if raises else "")
                + (". REMOVES " + "; ".join(removed) if removed else "")
                + ". Retool it if that is not the seat you meant.")
        swept = self._sweep_audiences()
        warnings += [f"audience revoked (no longer ancestral): {g}→{t}"
                     for g, t in swept]
        # sweep_pm=False deliberately: this is not a relocation into a new
        # chain (D-102's case) — target keeps the superior it had, so a
        # permission mode the USER deliberately raised on that branch (D-101)
        # must survive, and `nid` was just given target's own mode.
        dropped = self._sweep_dirs(nid, sweep_pm=False)
        if dropped:
            warnings.append(f"capabilities the chain does not hold were "
                            f"dropped (№30): {dropped}")
        kids = [k for k in self.children(target) if k != nid]

        def _ins(role: str) -> dict[str, Any]:
            return _mint("lifecycle.inserted", actor_of(actor), self.node_ref(nid), node=nid,
                         above=target, parent=p, role=role, by=actor,
                         grant_target=str(n_t["grant"]), grant_new=str(n_new["grant"]),
                         committed=str(seat_t + n_t["grant"]))
        self._notify_ev([x for x in [p] if x != actor], _ins("parent"))
        self._notify_ev([x for x in self._peers_of(p, nid) if x != actor and x != target],
                        _ins("peer"))
        self._notify_ev([x for x in [target] if x != actor], _ins("target"))
        self._notify_ev([x for x in kids if x != actor], _ins("child"))
        self._notify_ev([x for x in [nid] if x != actor], _ins("self"))
        self._log("insert_parent", actor,
                  {"node": nid, "target": target, "under": p}, warnings)
        return {"node": nid, "inserted_above": target, "under": p,
                "grant": n_new["grant"], "target_grant": n_t["grant"],
                "warnings": warnings}

    def _move(self, op: str, actor: str, nid: str,
              new_parent: str | None) -> dict[str, Any]:
        """§4.5 LCA credit path. Release P_old→L and acquire L→P_new cancel hop by hop,
        so every node's free is unchanged — budget-neutral, cannot fail on credits."""
        self._require_authority(actor, nid)
        n = self.node(nid)
        p_old = n["parent"]
        if new_parent is not None:
            self._require_live(new_parent)
            self._require_authority(actor, new_parent, allow_self=True)
            # ⚠ The guard must cover EVERY node this move reparents, and that is
            # not just `nid`'s subtree: the loop near the end of this method
            # reparents the whole LINEAGE STACK to `new_parent` too (§8.5, the
            # stack shares the successor's slot). A bearer that was stranded
            # with org children of its own — `reseed`'s own-successor branch
            # leaves exactly that — could therefore host `new_parent` below it
            # while not being below `nid`, and the old check waved it through.
            # Result: a REAL 2-cycle in the parent graph (`a@0.parent == "b"`
            # and `b.parent == "a@0"`), reproduced 2026-08-04 by the credit
            # conservation fuzzer. The cycle guards on ancestors()/
            # lineage_stack() stop it hanging; they do not stop it existing,
            # and a cyclic org is corrupt whether or not the walk terminates.
            moved = {nid, *self.lineage_stack(nid)}
            forbidden = set(moved)
            for m in moved:
                forbidden |= set(self.descendants(m, live_only=False))
            if new_parent in forbidden:
                raise LedgerError("target is inside the moved subtree — cycle (§4.5)")
        if p_old is not None:
            self._require_authority(actor, p_old, allow_self=True)

        # №34 runaway insurance binds REORGANIZATION too (user ruling
        # 2026-08-04, closing the D-A/D-B pins). `hire` refused past the caps
        # and `move` did not, so a subtree could simply be dragged past them —
        # and since a drag is how a runaway would re-shape a tree it had
        # already been refused permission to grow, the hole defeated the
        # insurance rather than merely bending a rule. Measured against the
        # WHOLE moved subtree: the deepest leaf under `nid` is what actually
        # ends up deepest, not `nid` itself.
        if new_parent is not None:
            cap_d = self.d.get("max_depth", MAX_DEPTH)
            sub = self.descendants(nid, live_only=False)
            rel = max((self.depth(k) for k in sub), default=self.depth(nid)) \
                - self.depth(nid)
            if self.depth(new_parent) + 1 + rel >= cap_d:
                raise LedgerError(
                    f"max org depth {cap_d} reached — moving {nid} under "
                    f"{new_parent} would seat its deepest report at "
                    f"{self.depth(new_parent) + 1 + rel}")
            cap_c = self.d.get("max_children", MAX_CHILDREN)
            if new_parent != p_old \
                    and len(self.org_children(new_parent)) >= cap_c:
                raise LedgerError(
                    f"{new_parent} already has {cap_c} reports (cap)")

        # §8.5: a bearer occupies its SUCCESSOR's slot and is not an org node of
        # its own, so it may not be re-parented on its own — doing so split the
        # stack from the live agent that owns it and left the bearer showing up
        # in `descendants()` of a branch it never belonged to.
        succ = n.get("successor")
        if succ and succ in self.nodes:
            raise LedgerError(
                f'{nid} is a lineage bearer of "{succ}" — the stack shares its '
                f'successor\'s slot (§8.5). Move "{succ}" and the stack '
                f'follows it.')
        live_bearers = [k for k in self.lineage_stack(nid)
                        if self.nodes[k]["state"] != "archived"]
        if live_bearers:
            raise LedgerError(
                f"{nid} has live lineage bearer(s) {live_bearers} under consultation — "
                f"retire them first, then move (the stack moves with the node)")
        c = 0.0 if n["state"] != "live" else _q(self.seat_cost(nid) + n["grant"])
        warnings: list[str] = []
        if n["state"] != "live":
            warnings.append(
                f"{nid} is archived: moving it is free, but its rehire cost "
                f"({self.seat_cost(nid) + n['grant']:g}) now falls on {new_parent or USER} (§4.5)")

        lca = self._lca(p_old, new_parent)
        down = (self._path_down(lca if lca is not None else USER, new_parent)
                if new_parent is not None else [])
        if c:
            # D-014, the hole the docket carried: the ACQUIRE leg inflates every
            # grant on the way down to the new parent, and when the move crosses
            # the root boundary (lca == USER) the first of those is a TOP-LEVEL
            # grant. Nothing checked it, so a drag across roots reached a number
            # `reallocate` refuses to type — the cap was enforced on one route to
            # the same end state and not the other. Pre-check BEFORE any
            # mutation, exactly as `_chain_acquire` does, so a refusal leaves the
            # tree untouched. (Release only ever shrinks; a grant on that leg is
            # >= c by the free>=0 invariant, so it cannot go negative.)
            for hop in down:
                if self.nodes[hop]["parent"] is None:
                    self._check_top_grant(
                        self.nodes[hop]["grant"] + c,
                        f"moving {nid} under {new_parent}")
            # ⚠ The docstring above claims the release leg "cannot fail on
            # credits" because a grant on it is >= c by the free>=0 invariant.
            # That holds only while the invariant does. `reseed`'s own-successor
            # branch can zero a stranded bearer's grant while its children still
            # hang off it, and then this subtraction ran unconditionally and
            # produced a NEGATIVE grant — measured -7 and -13 by the credit
            # conservation fuzzer 2026-08-04, on moves that raised nothing and
            # left an ancestor's free() lower than it started (so not
            # budget-neutral either, against this method's own contract).
            # Refuse rather than corrupt: a negative grant is not a state any
            # later operation is written to survive.
            for hop in self._chain_up(p_old, lca):
                if self.nodes[hop]["grant"] < c:
                    raise LedgerError(
                        f"cannot move {nid}: {hop} holds a grant of "
                        f"{self.nodes[hop]['grant']:g}, less than the {c:g} this "
                        f"move must release through it — the chain's accounting "
                        f"is inconsistent (§4.5)")
            for hop in self._chain_up(p_old, lca):     # release: grants shrink
                self.nodes[hop]["grant"] = _q(self.nodes[hop]["grant"] - c)
            for hop in down:                           # acquire: grants swell
                self.nodes[hop]["grant"] = _q(self.nodes[hop]["grant"] + c)

        prior_peers = self._peers_of(p_old, nid)
        n["parent"] = new_parent
        for k in self.lineage_stack(nid):     # §8.5: the stack occupies the same slot
            self.nodes[k]["parent"] = new_parent
        swept = self._sweep_audiences()
        warnings += [f"audience revoked (no longer ancestral): {g}→{t}" for g, t in swept]
        dropped = self._sweep_dirs(nid)
        if dropped:
            warnings.append(f"dirs not held by the new chain were dropped (№30): {dropped}")
        subtree = len(self.descendants(nid, live_only=False))
        tail = f" Its suborganization ({subtree} node(s)) moved with it." if subtree else ""

        def _mv(role: str) -> dict[str, Any]:
            return _mint("lifecycle.moved", actor_of(actor), self.node_ref(nid), node=nid,
                         from_parent=p_old, to_parent=new_parent, role=role, by=actor,
                         tail=(tail or None))
        self._notify_ev([p for p in [p_old] if p != actor], _mv("old_parent"))
        self._notify_ev([p for p in prior_peers if p != actor], _mv("old_peer"))
        self._notify_ev([p for p in [new_parent] if p != actor], _mv("new_parent"))
        self._notify_ev([p for p in self._peers_of(new_parent, nid) if p != actor],
                        _mv("new_peer"))
        self._notify_ev([nid], _mv("self"))
        self._log(op, actor, {"node": nid, "from": p_old, "to": new_parent}, warnings)
        return {"warnings": warnings}

    def _chain_up(self, frm: str | None, until: str | None) -> list[str]:
        """Node ids from `frm` up to but excluding `until` (None = USER)."""
        out: list[str] = []
        cur = frm
        while cur is not None and cur != until:
            out.append(cur)
            cur = self.nodes[cur]["parent"]
        return out

    def _lca(self, a: str | None, b: str | None) -> str | None:
        """Lowest common ancestor of two (possibly None=USER) parent slots."""
        if a is None or b is None:
            return None
        aa = [a] + [x for x in self.ancestors(a) if x != USER]
        bset = {b} | {x for x in self.ancestors(b) if x != USER}
        for x in aa:
            if x in bset:
                return x
        return None

    # ------------------------------------------------------------------ dirs
    def revoke_dir(self, actor: str, nid: str, dir_: str) -> dict[str, Any]:
        """№30 explicit revoke — cascades into the subtree (their sets must stay ⊆)."""
        self._require_authority(actor, nid)
        removed: list[str] = []
        for k in [nid] + self.descendants(nid, live_only=False):
            dirs = self.nodes[k]["scope"]["add_dirs"]
            if any(d["path"] == dir_ for d in dirs):
                self.nodes[k]["scope"]["add_dirs"] = [d for d in dirs if d["path"] != dir_]
                removed.append(k)
        self._log("revoke_dir", actor, {"node": nid, "dir": dir_, "removed": removed}, [])
        return {"removed_from": removed, "warnings": []}

    def _clamp_vis(self, requested: str, parent: str | None,
                   strict: bool) -> tuple[str, bool]:
        """D-021 (user ruling 2026-08-01): org_visibility is a CAPABILITY —
        child ≤ parent, exactly like dirs and tools. Returns (vis, clamped);
        strict=True raises instead of clamping (agent-explicit grants)."""
        if parent is None or requested not in VIS_LEVELS:
            return requested, False
        pv = self.node(parent)["scope"].get("org_visibility", "full")
        if pv in VIS_LEVELS and VIS_LEVELS.index(requested) > VIS_LEVELS.index(pv):
            if strict:
                raise LedgerError(
                    f"org_visibility {requested!r} exceeds the parent's own "
                    f"{pv!r} — visibility is a capability and only shrinks "
                    f"downward")
            return pv, True
        return requested, False

    # ------------------------------------------------ D-106: grants bubble up
    def _actor_cap(self, actor: str) -> tuple[
            dict[str, str] | None, ToolGrant | None, str, str]:
        """What this actor may grant, at most: (dirs, tools, visibility, mode).

        The USER (and SYSTEM) is capped by nothing here — `_apply_ceiling`
        still binds them to a kiosk's ceiling, which is the "or kiosk cap"
        half of the ruling. An AGENT is capped by its OWN scope: `None` for
        dirs/tools means unbounded, so only the user gets it.
        """
        if actor_kind(actor) in ("user", "system"):
            return None, None, VIS_LEVELS[-1], PM_LEVELS[-1]
        sc = self.node(actor)["scope"]
        return (self.effective_dirs(actor), sc["tools"],
                sc.get("org_visibility", "full"),
                sc.get("permission_mode", "acceptEdits"))

    def _raise_along(self, chain: list[str], warnings: list[str],
                     dirs: list[DirGrant] | None = None,
                     tools: ToolGrant | None = None,
                     vis: str | None = None, pm: str | None = None) -> list[str]:
        """Give every node on `chain` whatever the grant below it needs
        (user ruling 2026-08-07, D-106).

        A permission granted deep used to be REFUSED when an intermediate did
        not hold it, because the chain must stay monotone (child ⊆ parent) and
        the ledger enforced that by rejecting the leaf. The ruling inverts the
        repair: raise the middle instead. `chain` is the nodes between the
        granter and the grantee — the granter itself is never on it (nobody is
        raised to grant), and the request has already been clamped to the
        granter's own cap, so this can never exceed it.

        ⚠ This EXPANDS the authority of agents who did not ask for it, which is
        exactly what was requested — so it is never silent. Every raise is
        named in `warnings`, per node and per capability, and the ids are
        RETURNED so callers report them without parsing prose back out.
        """
        raised: list[str] = []
        for k in chain:
            sc = self.nodes[k]["scope"]
            gained: list[str] = []
            if dirs:
                held = {d["path"]: d["mode"] for d in sc["add_dirs"]}
                for d in dirs:
                    if held.get(d["path"]) == d["mode"]:
                        continue
                    if d["path"] not in held:
                        sc["add_dirs"].append({"path": d["path"], "mode": d["mode"]})
                        gained.append(f"{d['path']} {d['mode']}")
                    elif held[d["path"]] == "ro" and d["mode"] == "rw":
                        for row in sc["add_dirs"]:
                            if row["path"] == d["path"]:
                                row["mode"] = "rw"
                        gained.append(f"{d['path']} ro→rw")
            if tools:
                for tk in TOOL_KEYS:
                    if tools.get(tk) and not sc["tools"].get(tk):
                        sc["tools"][tk] = True
                        gained.append(tk)
                want_mcp = list(tools.get("mcp") or [])
                have = list(sc["tools"].get("mcp") or [])
                if "*" in want_mcp and "*" not in have:
                    sc["tools"]["mcp"] = ["*"]
                    gained.append("mcp:*")
                elif "*" not in have:
                    add = [s for s in want_mcp if s not in have]
                    if add:
                        sc["tools"]["mcp"] = sorted(set(have) | set(add))
                        gained += [f"mcp:{s}" for s in add]
            if vis is not None:
                cur = sc.get("org_visibility", "full")
                if (cur in VIS_LEVELS and vis in VIS_LEVELS
                        and VIS_LEVELS.index(vis) > VIS_LEVELS.index(cur)):
                    sc["org_visibility"] = vis
                    gained.append(f"visibility {cur}→{vis}")
            if pm is not None:
                cur = sc.get("permission_mode", "acceptEdits")
                if (cur in PM_LEVELS and pm in PM_LEVELS
                        and PM_LEVELS.index(pm) > PM_LEVELS.index(cur)):
                    sc["permission_mode"] = pm
                    gained.append(f"permission_mode {cur}→{pm}")
            if gained:
                raised.append(k)
                warnings.append(
                    f"bubbled up to {k} so the grant below it is reachable: "
                    + ", ".join(gained))
        return raised

    def _clamp_pm(self, requested: str, parent: str | None,
                  strict: bool) -> tuple[str, bool]:
        """D-102 (user ruling 2026-08-07): permission_mode is a CAPABILITY —
        child ≤ parent, exactly like dirs, tools and visibility. Returns
        (pm, clamped); strict=True raises instead of clamping.

        ⚠ Before this existed, `permission_mode` was the ONE scope field with
        no parent clamp: it was checked against the kiosk ceiling and nothing
        else, and `_new_node` copied the ORG default into every hire. So in an
        org whose default outranked a node, that node's reports were born
        ABOVE it — an escalation by inheritance that no actor had to ask for.
        Capping at the parent closes that as a side effect of exposing the
        field to agents, which is why the two ship together."""
        if parent is None or requested not in PM_LEVELS:
            return requested, False        # top level answers to the user
        pp = self.node(parent)["scope"].get("permission_mode", "acceptEdits")
        if pp in PM_LEVELS and PM_LEVELS.index(requested) > PM_LEVELS.index(pp):
            if strict:
                raise LedgerError(
                    f"permission_mode {requested!r} exceeds the parent's own "
                    f"{pp!r} — a permission mode is a capability and only "
                    f"shrinks downward; nobody grants above themselves")
            return pp, True
        return requested, False

    def _check_top_grant(self, new_grant: float, ctx: str) -> None:
        """D-014 (user ruling 2026-08-01): `max_top_grant` is a REAL ledger
        precondition — no op, user-actor cascades included, may push a
        TOP-LEVEL grant past it. 0/unset = uncapped; existing over-cap
        grants are grandfathered (only increases are refused)."""
        cap = int(self.d.get("max_top_grant") or 0)
        if cap and new_grant > cap:
            raise LedgerError(
                f"{ctx} would put a top-level grant at {new_grant:g}, past "
                f"the org's top-level grant cap of {cap} — raise the cap in "
                f"the org settings, or lower the ask")

    def _sweep_dirs(self, nid: str, clamp_root: bool = True,
                    sweep_pm: bool = True) -> list[str]:
        """After a move or scope shrink: clamp the subtree's dirs, tools,
        visibility AND permission mode to each parent in turn (№30 + D-021 +
        D-102 — capability sets stay ⊆ all the way down).

        `clamp_root=False` starts the walk at nid's CHILDREN, leaving nid's own
        scope alone. A scope edit passes False (the caller just decided what
        nid holds); a MOVE passes True, because a relocated node has to fit the
        chain it landed in.

        ⚠ `sweep_pm=False` leaves permission_mode alone entirely, and a scope
        edit that did not touch the mode passes it. permission_mode is the one
        capability the USER may deliberately hold ABOVE a node's parent
        (D-101 — raising one agent is one act), so unlike dirs/tools/vis it
        cannot be re-derived from the chain on every unrelated edit. Sweeping
        it from a folder or visibility retool would mean any later retool
        anywhere up the chain silently revoked that grant. It is swept when
        the mode ITSELF is lowered (that is what revoking means) and on a
        move (relocation is not an exception, it is a new chain)."""
        dropped: list[str] = []

        def clamp(k: str, allowed: dict[str, str] | None,
                  ptools: ToolGrant | None, pvis: str | None,
                  ppm: str | None = None) -> None:
            sc = self.nodes[k]["scope"]
            kept, lost = self._clamp_dirs(sc["add_dirs"], allowed, strict=False)
            sc["add_dirs"] = kept
            dropped.extend(lost)
            had_star = "*" in (sc.get("tools", {}).get("mcp") or [])
            tkept, tlost = self._clamp_tools(sc["tools"], ptools, strict=False)
            sc["tools"] = tkept
            dropped.extend(tlost)
            if had_star and "*" not in tkept["mcp"]:
                # the same semantic change `_apply_ceiling` names: "*" meant
                # "every server, present AND future" and is now a fixed list,
                # so registry additions will no longer reach this node. The
                # sweep collapsed it in silence until 2026-08-04.
                dropped.append(f"mcp:* ({k} materialized to the parent's list)")
            v = sc.get("org_visibility", "full")
            if (pvis in VIS_LEVELS and v in VIS_LEVELS
                    and VIS_LEVELS.index(v) > VIS_LEVELS.index(pvis)):
                sc["org_visibility"] = pvis
                dropped.append(f"visibility:{k}→{pvis}")
            pm = sc.get("permission_mode", "acceptEdits")
            if (sweep_pm and ppm in PM_LEVELS and pm in PM_LEVELS
                    and PM_LEVELS.index(pm) > PM_LEVELS.index(ppm)):
                # D-102: LOWERING a node drops its whole subtree with it —
                # otherwise revoking a mode would leave the reports it was
                # inherited by still holding it
                sc["permission_mode"] = ppm
                dropped.append(f"permission_mode:{k}→{ppm}")
            own: dict[str, str] = {d["path"]: d["mode"] for d in kept}
            for ch in self.children(k, live_only=False):
                clamp(ch, own, tkept, sc.get("org_visibility", "full"),
                      sc.get("permission_mode", "acceptEdits"))

        if clamp_root:
            parent = self.node(nid)["parent"]
            clamp(nid, self.effective_dirs(parent),
                  None if parent is None else self.node(parent)["scope"]["tools"],
                  None if parent is None
                  else self.node(parent)["scope"].get("org_visibility", "full"),
                  None if parent is None
                  else self.node(parent)["scope"].get("permission_mode",
                                                      "acceptEdits"))
        else:
            own = self.node(nid)["scope"]
            for ch in self.children(nid, live_only=False):
                clamp(ch, self.effective_dirs(nid), own["tools"],
                      own.get("org_visibility", "full"),
                      own.get("permission_mode", "acceptEdits"))
        return sorted(set(dropped))

    # ------------------------------------------------------------- node scope
    EFFORTS: Final = ("low", "medium", "high", "xhigh", "max")

    # What an unconfigured turn runs at. The CLI HAS a default but does not
    # document it and does not report it (checked: `--help` names no default,
    # and `system/init` carries no effort field), so the only way for orgtree
    # to state the level truthfully is to stop depending on an implicit one and
    # pass --effort on every turn. "high" is what opus resolved to unaided
    # — measured across 54 records — so this pins existing behaviour rather
    # than changing it, and makes the other tiers explicit at the same level.
    DEFAULT_EFFORT: Final = "high"

    def effective_effort(self, nid: str) -> str:
        """The effort a turn launches with: the node's own, else the org
        default, else DEFAULT_EFFORT. NEVER empty — every turn passes an
        explicit --effort, which is what lets the ⚙ control state a level
        instead of a shrug.

        The org default is read LIVE at turn time (user ruling 2026-08-01:
        visible inherit), so this is DERIVED and never stored. The supervisor
        asks this rather than recomputing it, because the UI asks it too: the
        control read configuration while the runtime read something else, and
        an unconfigured agent showed nothing at all (user bug 2026-08-02,
        reported three times — first fix read only scope.effort, second fell
        back to a transcript field the CLI stamps on some tiers and not
        others). One function, one answer, and orgtree causes it."""
        eff = (self.node(nid)["scope"].get("effort")
               or self.d.get("default_effort") or "")
        return eff if eff in self.EFFORTS else self.DEFAULT_EFFORT

    def versions_for(self, tier: str) -> dict[str, str]:
        """The model versions selectable within a tier ({} = no choice)."""
        return dict(MODEL_VERSIONS.get(tier) or {})

    def prefer_reserve_for(self, nid: str) -> bool:
        """Does this node try reserve FIRST or its plan pool first?

        An explicit per-node value wins. An absent value is live-inherited
        from the app-wide default so changing that setting affects existing
        agents that never chose an individual preference.
        """
        v = self.node(nid)["scope"].get("prefer_reserve")
        return app_prefer_reserve_default() if v is None else bool(v)

    def model_for(self, nid: str) -> str:
        """The `--model` id for this node: its chosen VERSION when it recorded
        a valid one for its CURRENT tier, else the tier default.

        Derived, never stored, for the same reason `effort_for` is: the tier
        can change under a node (switch_model), and a version recorded for the
        old tier must not follow it there. An unknown or stale value falls back
        silently — a bad string in a doc must never be able to stop a turn."""
        n = self.node(nid)
        tier = n["model"]
        want = n["scope"].get("model_version")
        if want:
            got = self.versions_for(tier).get(want)
            if got:
                return got
        return self.d["models"].get(tier, tier)

    def set_scope(self, actor: str, nid: str, add_dirs: list[Any] | None = None,
                  tools: Mapping[str, Any] | None = None,
                  org_visibility: str | None = None,
                  permission_mode: str | None = None,
                  charter: str | None = None, team_charter: str | None = None,
                  effort: str | None = None, model_version: str | None = None,
                  auto_cheap_compact: Mapping[str, Any] | None = None,
                  external_handles: list[Any] | None = None,
                  raise_ceiling: bool = False,
                  clear_prefer_reserve: bool = False,
                  prefer_reserve: bool | None = None) -> dict[str, Any]:
        """Per-node configuration (the ⚙): dir grants with modes, the full tool set
        (built-ins + MCP servers), org-structure visibility. Superior-only.
        Kiosk ceiling (spec §2): permission fields clamp against parent ∩
        ceiling; charter/team_charter/effort pass unclamped (not permissions —
        effort is a cost dial by user ruling and applies under any ceiling)."""
        # D-105 (user ruling 2026-08-07): an agent may edit its OWN team
        # charter and nothing else. The two charters are different objects
        # wearing similar names: `charter` is the role card its SUPERIOR wrote
        # for it, injected into its own prompt — self-editing that is an agent
        # rewriting its own instructions, which is the one thing the hierarchy
        # exists to prevent. `team_charter` is the standing instruction IT
        # issues to ITS subtree; that is its own management to do, and the
        # ledger's own cascade already guarantees it cannot leak upward.
        # identity_prompt labels the node's own value as the charter it GIVES
        # its team, distinct from the superior-authored role charter that binds
        # the node; descendants receive it through the ancestor cascade. Pinned
        # in test_asks and test_report_guidance_identity.
        self_edit = (actor == nid and actor_kind(actor) not in ("user", "system"))
        if self_edit:
            if charter is not None:
                raise LedgerError(
                    "you may not rewrite your OWN charter — it is the role "
                    "your superior set for you. Ask them to change it "
                    "(orgtree_message), or edit your TEAM charter instead, "
                    "which is the standing instruction you give your reports")
            offered = [k for k, v in (
                ("add_dirs", add_dirs), ("tools", tools),
                ("org_visibility", org_visibility),
                ("permission_mode", permission_mode), ("effort", effort),
                ("model_version", model_version),
                ("auto_cheap_compact", auto_cheap_compact),
                ("prefer_reserve", prefer_reserve),
                # False is the request-model default (omitted), while True
                # is an explicit attempt to clear an individual override.
                ("clear_prefer_reserve",
                 True if clear_prefer_reserve else None),
                # a handle is an outbound-mail PRIVILEGE (the post_mail
                # per-address bypass), so self-granting one would let a node
                # hand itself a channel out of the org — the exact thing the
                # audience system exists to gate. Superior-only, always.
                ("external_handles", external_handles)) if v is not None]
            if offered:
                raise LedgerError(
                    f"a self-retool may carry team_charter and nothing else; "
                    f"drop {', '.join(offered)} (your own scope is your "
                    f"superior's to set — ask them)")
            if team_charter is None:
                raise LedgerError(
                    "nothing to do: a self-retool sets team_charter only")
        else:
            self._require_authority(actor, nid)
        n = self.node(nid)
        sc = n["scope"]
        warnings: list[str] = []
        changed_caps = False
        bridged = False
        cascaded: list[str] = []       # D-106: agents this grant expanded
        # ATOMICITY (2026-08-04): every refusal happens in THIS block, before a
        # single field is written. The three capability fields used to be
        # validated-and-applied one at a time, so a call carrying a legal
        # `add_dirs` and an illegal `tools` grant wrote the dirs, refused, and
        # never ran the subtree sweep — half a retool, reported as a failure.
        # `_apply_ceiling(raise_ceiling=True)` also grows the ceiling itself, so
        # every strict parent clamp has to pass before ANY of it runs.
        # D-106 (user ruling 2026-08-07): the clamp is against the GRANTER's
        # own capability, not the target's parent, and an intermediate that
        # lacks what was granted below it is RAISED rather than the grant
        # refused. Every one of these four used to clamp strictly against
        # `n["parent"]`, so granting a deep report anything its middle
        # managers happened not to hold was simply rejected — the operator's
        # only route was to walk down the chain retooling by hand.
        cap_dirs, cap_tools, cap_vis, cap_pm = self._actor_cap(actor)
        want_dirs: list[DirGrant] | None = None
        want_tools: ToolGrant | None = None
        want_vis: str | None = None
        want_pm: str | None = None
        if add_dirs is not None:
            want_dirs, _ = self._clamp_dirs(
                norm_dirs(add_dirs), cap_dirs, strict=True,
                who="you" if actor_kind(actor) not in ("user", "system")
                else "this org")
        if tools is not None:
            want_tools, _ = self._clamp_tools(
                tools, cap_tools, strict=True,
                who="you" if actor_kind(actor) not in ("user", "system")
                else "this org")
        if org_visibility is not None:
            if org_visibility not in VIS_LEVELS:
                raise LedgerError(f"org_visibility must be one of {VIS_LEVELS}")
            if VIS_LEVELS.index(org_visibility) > VIS_LEVELS.index(cap_vis):
                raise LedgerError(
                    f"org_visibility {org_visibility!r} exceeds your own "
                    f"{cap_vis!r} — nobody grants above themselves")
            want_vis = org_visibility
        if permission_mode is not None:
            if permission_mode not in PM_LEVELS:
                raise LedgerError(                 # D-030 hardening
                    f"permission_mode must be one of {PM_LEVELS}")
            # D-102's cap survives verbatim; only its REFERENT moved from the
            # target's parent to the actor's own mode (identical for a direct
            # superior, which is the case D-102 was written against).
            if PM_LEVELS.index(permission_mode) > PM_LEVELS.index(cap_pm):
                raise LedgerError(
                    f"permission_mode {permission_mode!r} exceeds the parent's "
                    f"own {cap_pm!r} — a permission mode is a capability and "
                    f"only shrinks downward; nobody grants above themselves")
            want_pm = permission_mode
        # user-approved (2026-07-31): thinking effort as a per-agent setting,
        # adjusted from the gear — never a hire-row control. "" clears back to
        # the CLI default. (No ultracode tier: orgtree replaces subagent
        # semantics with real hires.)
        if effort is not None and effort not in self.EFFORTS and effort != "":
            raise LedgerError(
                f"effort must be one of {self.EFFORTS} (or '' to clear)")
        # a VERSION is neither a permission nor a price, so it clamps against
        # nothing — exactly like effort. Validated against the node's CURRENT
        # tier so a stale choice can never be written in the first place.
        if model_version is not None and model_version != "":
            _ok = self.versions_for(n["model"])
            if model_version not in _ok:
                raise LedgerError(
                    f"{n['model']} has no model version {model_version!r}"
                    + (f" — know {sorted(_ok)}" if _ok
                       else " (this tier has a single model)"))
        # post-hire response handles. Validated HERE with everything else, so
        # a retool carrying a legal charter and a malformed handle writes
        # neither (the atomicity contract above). Not a ceiling capability —
        # a handle clamps against nothing, it is granted or it is not — so it
        # sets no `changed_caps` and triggers no subtree sweep.
        want_handles: list[str] | None = None
        if external_handles is not None:
            want_handles = norm_extern_handles(external_handles, where="retool")
        # Charter length is MEASURED here, never enforced — charters are
        # uncapped (user ruling 2026-09-04, see CHARTER_LONG). The text is
        # stored exactly as written; a long one only earns a note in
        # `warnings`, which `modals.tsx` doSave toasts. Done with the other
        # up-front work so the length is reported even when a LATER field in
        # this call refuses and nothing is written at all.
        new_charter: str | None = None
        new_team_charter: str | None = None
        if charter is not None:
            new_charter = note_charter_length("charter", charter, warnings)
        if team_charter is not None:
            new_team_charter = note_charter_length(
                "team_charter", team_charter, warnings)

        if want_dirs is not None:
            _t, kept, _v, _p, b = self._apply_ceiling(
                dirs=want_dirs, raise_ceiling=raise_ceiling, warnings=warnings)
            bridged = bridged or b
            sc["add_dirs"] = cast("list[DirGrant]", kept)  # dirs in ⇒ dirs out
            changed_caps = True
        if want_tools is not None:
            tset, _d, _v, _p, b = self._apply_ceiling(
                tools=want_tools, raise_ceiling=raise_ceiling, warnings=warnings)
            bridged = bridged or b
            sc["tools"] = cast(ToolGrant, tset)  # tools in ⇒ tools out
            changed_caps = True
        if want_vis is not None:
            _t, _d, vis2, _p, b = self._apply_ceiling(
                vis=want_vis, raise_ceiling=raise_ceiling, warnings=warnings)
            bridged = bridged or b
            sc["org_visibility"] = cast(str, vis2)  # vis in ⇒ vis out
            changed_caps = True   # lowering sweeps the subtree like the others
        lowered_pm = False
        if want_pm is not None:
            _t, _d, _v, pm2, b = self._apply_ceiling(
                pm=want_pm, raise_ceiling=raise_ceiling, warnings=warnings)
            bridged = bridged or b
            prev_pm = sc.get("permission_mode", "acceptEdits")
            sc["permission_mode"] = cast(str, pm2)  # pm in ⇒ pm out
            # ⚠ only a genuine LOWERING sweeps. Not "was passed" — the ⚙ panel
            # sends every field on every save, so a charter edit would carry
            # an unchanged permission_mode and revoke a deliberately-raised
            # report as a side effect. Same-value writes must be inert here.
            lowered_pm = (prev_pm in PM_LEVELS and pm2 in PM_LEVELS
                          and PM_LEVELS.index(cast(str, pm2))
                          < PM_LEVELS.index(prev_pm))
            changed_caps = changed_caps or lowered_pm
        # D-106: raise the chain BETWEEN the granter and this node so what was
        # just granted is actually reachable. Runs on the POST-ceiling values
        # (`sc`, not the request), so a kiosk ceiling that clamped the grant
        # clamps the bubble identically — an intermediate can never end up
        # holding more than the leaf it was raised for. Only RAISES: a
        # lowering is the subtree sweep's job, just below, and pushing a
        # revocation upward would strip a manager for its report's sake.
        bubble = [k for k in self._path_down(
            actor if actor_kind(actor) not in ("user", "system") else USER, nid)
            if k != nid]
        if bubble:
            before = len(warnings)
            raised = self._raise_along(
                bubble, warnings,
                dirs=sc["add_dirs"] if want_dirs is not None else None,
                tools=sc["tools"] if want_tools is not None else None,
                vis=sc.get("org_visibility") if want_vis is not None else None,
                pm=sc.get("permission_mode") if want_pm is not None else None)
            # user ruling 2026-08-07: the ACTOR must be told plainly, in the
            # tool's own answer, which agents its grant just expanded — the
            # per-node detail lines below are the evidence, this is the
            # sentence an agent will actually read. Named `cascaded` so the
            # caller can surface it without parsing prose.
            if raised:
                cascaded = list(raised)
                warnings.insert(before, "cascaded permission increase to "
                                        "agents " + ", ".join(raised))
        # …and when the cascade reaches a TOP-LEVEL agent the capability has
        # entered the ORG, so the org's own defaults absorb it — for EVERY
        # capability, not only folders (user report 2026-08-08 about folders;
        # generalized on the user's follow-up ruling the same day).
        #
        # Why it is needed at all: a top-level agent has no parent to inherit
        # from, so the org document IS its ceiling and the record of what this
        # organization can reach. Leaving it behind made the org claim less
        # than its own top-level agent demonstrably held — the eye's panel
        # showed an incomplete picture, and a later top-level hire (which
        # defaults from these very fields) did not inherit it.
        #
        # Union/raise ONLY, in the bubble's own direction: revoking one node's
        # grant is never the org losing the capability. And only the user can
        # reach here — a top-level node has no agent ancestors, so no agent
        # actor's `bubble` can contain one — but the gate is written out
        # rather than left as an inference, since the ruling says "user-
        # triggered" and a future authority change must not silently widen it.
        top_touched = ([k for k in [nid, *bubble]
                        if self.nodes[k]["parent"] is None]
                       if actor_kind(actor) in ("user", "system") else [])
        if top_touched:
            absorbed: list[str] = []
            for k in top_touched:
                ksc = self.nodes[k]["scope"]
                if want_dirs is not None:
                    held = {d["path"]: d["mode"] for d in self.d["dirs"]}
                    for d in ksc["add_dirs"]:
                        if d["path"] not in held:
                            self.d["dirs"].append({"path": d["path"],
                                                   "mode": d["mode"]})
                            absorbed.append(f"{d['path']} {d['mode']}")
                        elif held[d["path"]] == "ro" and d["mode"] == "rw":
                            for row in self.d["dirs"]:
                                if row["path"] == d["path"]:
                                    row["mode"] = "rw"
                            absorbed.append(f"{d['path']} ro→rw")
                if want_tools is not None:
                    dt = norm_tools(self.d.get("default_tools"))
                    for tk in TOOL_KEYS:
                        if ksc["tools"].get(tk) and not dt.get(tk):
                            dt[tk] = True
                            absorbed.append(tk)
                    have, want = list(dt["mcp"]), list(ksc["tools"].get("mcp") or [])
                    if "*" in want and "*" not in have:
                        dt["mcp"] = ["*"]
                        absorbed.append("mcp:*")
                    elif "*" not in have:
                        add = [s for s in want if s not in have]
                        if add:
                            dt["mcp"] = sorted(set(have) | set(add))
                            absorbed += [f"mcp:{s}" for s in add]
                    self.d["default_tools"] = dt
                if want_vis is not None:
                    cur = self.d.get("default_visibility", "full")
                    new = ksc.get("org_visibility", "full")
                    if (cur in VIS_LEVELS and new in VIS_LEVELS
                            and VIS_LEVELS.index(new) > VIS_LEVELS.index(cur)):
                        self.d["default_visibility"] = new
                        absorbed.append(f"visibility {cur}→{new}")
                if want_pm is not None:
                    cur = self.d.get("permission_mode", "acceptEdits")
                    new = ksc.get("permission_mode", "acceptEdits")
                    if (cur in PM_LEVELS and new in PM_LEVELS
                            and PM_LEVELS.index(new) > PM_LEVELS.index(cur)):
                        self.d["permission_mode"] = new
                        absorbed.append(f"permission mode {cur}→{new}")
            if absorbed:
                warnings.append(
                    "the organization now holds " + ", ".join(absorbed)
                    + " — a top-level agent was granted it, so it is an org "
                      "capability and NEW top-level hires inherit it "
                      "(existing agents are unchanged)")
        if changed_caps:
            # ⚠ clamp_root=False: the caller just decided what nid holds, so
            # the sweep re-clamps its DESCENDANTS, never nid against its own
            # parent. sweep_pm only when the MODE itself moved — a folder or
            # visibility retool must not silently revoke a mode the user
            # deliberately granted below (D-101/D-102). Both flags were added
            # after the suite caught the second case revoking a live grant.
            swept = self._sweep_dirs(nid, clamp_root=False,
                                     sweep_pm=lowered_pm)
            if swept:
                warnings.append(f"subtree grants clamped to the new set (№30): {swept}")
        if effort is not None:
            if effort:
                sc["effort"] = effort
            else:
                sc.pop("effort", None)
        if model_version is not None:
            if model_version:
                sc["model_version"] = model_version
            else:
                sc.pop("model_version", None)   # "" clears ⇒ the tier default
        if clear_prefer_reserve:
            sc.pop("prefer_reserve", None)
        elif prefer_reserve is not None:
            # "Prefer reserve" (user ruling 2026-09-04, item 12): which of a
            # luna's two pools its turns try FIRST. A cost/budget dial like
            # effort — no ceiling clamp, superior-set, stored explicitly so
            # the gear reads back what was chosen. ABSENT INHERITS THE APP
            # DEFAULT (including nodes hired before the field existed). Off
            # does not disable reserve: the other pool is still the fallback
            # either way. Kept for every tier so it survives a switch to and
            # from luna; `prefer_reserve_for` is the one reader.
            sc["prefer_reserve"] = bool(prefer_reserve)
        if auto_cheap_compact is not None:
            # FR-24b per-node override: like effort, a cost dial, not a
            # permission — no ceiling clamp. {} clears back to org inherit.
            acc = dict(auto_cheap_compact)
            if acc:
                keep: dict[str, Any] = {}
                if "enabled" in acc:
                    keep["enabled"] = bool(acc["enabled"])
                if "occ" in acc:
                    keep["occ"] = min(0.95, max(0.05,
                                                float(acc.get("occ", 0.5))))
                if keep:
                    sc["auto_cheap_compact"] = keep
                # A legacy timeout-only write is a no-op. It neither creates
                # an empty override nor clears a recognised current one.
            else:
                sc.pop("auto_cheap_compact", None)
        if want_handles is not None:
            # REPLACE, like the other list-valued scope fields — [] clears.
            # The grant lives on the NODE (not `sc`) to match hire(), which is
            # also what makes it ride the seat across retire/rehire, and what
            # `post_mail`'s bypass and the supervisor's handles_line both read.
            if want_handles:
                n["external_handles"] = want_handles
            else:
                n.pop("external_handles", None)
            stamp_handles(n, want_handles)               # D-166
        # §15 cascade: charter = this node's role card · team_charter = standing
        # instructions binding this node's whole subtree (manager-owned)
        if charter is not None:
            n["charter"] = new_charter or None
        if team_charter is not None:
            n["team_charter"] = new_team_charter or None
        if self_edit:
            # D-105: notifying an agent that it changed its own team charter
            # is a letter to itself. Its reports need no notice either — the
            # cascade injects a superior's team charter into their prompt
            # LIVE every turn, so the next turn already carries it.
            pass
        else:
            # typed (family access_resources): access.scope_changed — `changed`
            # names the fields this call carried (the text is the same either way)
            changed_fields = [k for k, v in (("folders", add_dirs), ("tools", tools),
                                             ("charter", charter),
                                             ("org_visibility", org_visibility),
                                             ("permission_mode", permission_mode))
                              if v is not None]
            self._notify_ev([nid], _mint("access.scope_changed", actor_of(actor),
                                         self.node_ref(nid), by=actor,
                                         changed=changed_fields))
        self._log("set_scope", actor, {"node": nid, "scope": sc}, warnings)
        res: dict[str, Any] = {"scope": sc, "warnings": warnings}
        if cascaded:
            res["cascaded"] = cascaded      # D-106: structured, for the UI
        if bridged:
            res["bridge"] = {"raise_ceiling": True}
        return res

    def reorder(self, actor: str, nid: str, before: str | None = None,
                after: str | None = None) -> dict[str, Any]:
        """Cosmetic left-to-right position among siblings. No org effect — a UX
        affordance for the managing user (user-ruled); deliberately not logged as
        an authority-bearing operation beyond the ancestry check."""
        self._require_authority(actor, nid)
        n = self.node(nid)
        sibs = [k for k in self.children(n["parent"], live_only=False) if k != nid]
        if before and before in sibs:
            idx = sibs.index(before)
        elif after and after in sibs:
            idx = sibs.index(after) + 1
        else:
            raise LedgerError("reorder needs a sibling as before= or after=")
        # FULL sibling reindex (user bug report: "reordering sometimes doesn't
        # work") — the old midpoint halving converged to float ties after
        # repeated reorders, and tied ui_orders sort ambiguously. Fresh
        # integers every time keeps the order deterministic forever.
        for i, k in enumerate(sibs[:idx] + [nid] + sibs[idx:]):
            self.nodes[k]["ui_order"] = float(i)
        return {"ui_order": n["ui_order"], "warnings": []}

    # -------------------------------------------------------------- audiences
    def _sweep_audiences(self) -> list[tuple[str, str]]:
        """§7.3 auto-revoke: drop grants whose ANCHOR is no longer an ancestor
        of the grantee. For a self-grant the anchor is the grantor; for a
        delegated grant it is the delegator — a deliberately-lateral channel
        (e.g. to the delegator's peer) survives exactly as long as the
        authority that opened it still commands the grantee. User audiences
        are never swept (№11)."""
        kept: list[AudienceGrant]
        revoked: list[tuple[str, str]]
        kept, revoked = [], []
        for a in self.d["audiences"]:
            anchor = a.get("delegated_by") or a["grantor"]
            if a["grantor"] == EXTERN:
                # org-inbox grants: anchored on the delegator (user grants
                # are unanchored, like user audiences)
                if a["grantee"] in self.nodes and (
                        "delegated_by" not in a
                        or (anchor in self.nodes
                            and self.is_ancestor(anchor, a["grantee"]))):
                    kept.append(a)
                else:
                    revoked.append((a["grantee"], a["grantor"]))
            elif a["grantor"] == USER or (
                    a["grantee"] in self.nodes
                    and a["grantor"] in self.nodes
                    and (anchor == USER or (anchor in self.nodes
                         and self.is_ancestor(anchor, a["grantee"])))):
                kept.append(a)
            else:
                revoked.append((a["grantee"], a["grantor"]))
        self.d["audiences"] = kept
        return revoked

    # --------------------------------------------------- fable limit (user ruling)
    # ----------------------------------------------------- credit requests
    def request_credits(self, nid: str, new_limit: Any, reason: Any) -> dict[str, Any]:
        """A TOP-LEVEL agent asks the user directly for a larger grant. Not mail:
        a structured request (old → new + reason) the user approves or denies
        with one click. One pending request per node — but asking again AMENDS
        it (gap audit №34, user-approved): this was the only ask-verb that
        hard-errored on an idempotent ask, against the ratified pattern."""
        self._require_live(nid)
        n = self.node(nid)
        if self.d.get("headless"):
            # §9.6 ②: nobody will ever answer — deny with the reason in the
            # result so the agent adapts instead of retrying
            raise LedgerError(
                "this org runs HEADLESS: no user is present and credit "
                "requests are auto-denied. Work within the grant you hold, "
                "or record the blocker with orgtree_status(blocked, …) — a "
                "human reads statuses later")
        # the user-mail gate, same as questions (user ruling 2026-08-04):
        # top-level OR a held user audience may ask the user directly. Approval
        # for a deep node is an ordinary user-actor reallocate, which §4.6-
        # cascades the shortfall down the chain — no new mechanics.
        if n["parent"] is not None and not self._has_audience(nid, USER):
            raise LedgerError("only top-level agents (or holders of a user "
                              "audience) may ask the user for credits directly "
                              "— ask your superior to reallocate instead")
        # ⚠ CEIL, NOT int(). `int()` truncates toward zero, so an agent asking
        # for a total of 20.5 had a request card written for 20 and was never
        # told the ask had been reduced — the request it saw approved was not
        # the request it made. Grants are whole (user ruling 2026-09-04), so
        # the ask is still made whole, UPWARD: rounding an ASK up costs
        # nothing (the user still approves or refuses it) while rounding it
        # down quietly answers a question nobody asked.
        try:
            new_limit = math.ceil(_q(float(new_limit)))
        except (TypeError, ValueError, OverflowError):
            raise LedgerError("new_limit must be a number (the requested TOTAL grant)")
        old = n["grant"]
        reqs = self.d.setdefault("credit_requests", [])
        pending = next((r for r in reqs
                        if r["node"] == nid and r["status"] == "pending"), None)
        if new_limit <= old:
            # motto A3: asking for what you already have is a no-op — and it
            # WITHDRAWS a pending request (the ask is "I need no more")
            if pending is not None:
                pending["status"] = "withdrawn"
                self._log("credit_request_withdrawn", nid,
                          {"id": pending["id"]}, [])
                return {"status": f"your grant is already {old} — the pending "
                                  f"request was withdrawn"}
            return {"status": f"your grant is already {old} — nothing to request"}
        if not (reason and str(reason).strip()):
            raise LedgerError("a reason is required")
        # ZERO headroom → refused OUTRIGHT, no ask made (user ruling
        # 2026-08-04): when there are genuinely no credits available to grant,
        # a pending card would be a lie — the user could only refuse it.
        room, why = self.credit_headroom(nid)
        if room is not None and room <= 0:
            self._log("credit_refused", nid, {"asked": new_limit}, [])
            return {"refused": True,
                    "status": f"refused outright — there are ZERO credits "
                              f"available to grant ({why}). No request was "
                              f"made. Free credits (retire a sibling, hand "
                              f"back unused grant) or ask the user to raise "
                              f"the cap."}
        # FR-14 (user ruling 2026-08-12): a credit request JOINS the agent's
        # open batch — it no longer evicts an open question. It stays ONE tab:
        # a second request amends the existing figure in place (two
        # contradictory numbers on one card would be nonsense), which is the
        # append ruling's credits-shaped case.
        if pending is not None:
            # amend in place: the card the user eventually clicks always
            # shows the CURRENT figure, never a stale one. rev is the batch
            # resolve's CAS stamp for this tab.
            pending.update({"old": old, "new": new_limit,
                            "reason": str(reason).strip(), "at": now(),
                            "rev": int(pending.get("rev") or 1) + 1})
            self._log("credit_request", nid,
                      {"old": old, "new": new_limit, "amended": pending["id"]}, [])
            return {"requested": new_limit, "increase": new_limit - old,
                    "status": "pending (amended your earlier request) — the "
                              "user will approve or deny"}
        req = {"id": f"cr{len(reqs) + 1}", "node": nid, "old": old,
               "new": new_limit, "reason": str(reason).strip(),
               "at": now(), "rev": 1, "status": "pending"}
        reqs.append(req)
        self._log("credit_request", nid, {"old": old, "new": new_limit}, [])
        return {"requested": new_limit, "increase": new_limit - old,
                "status": "pending — the user will approve or deny"}

    # ------------------------------------------------ FR-13 scope requests
    SCOPE_KINDS: Final = ("dir", "tool", "mcp", "permission_mode")

    def _scope_item_key(self, it: dict[str, Any]) -> str:
        k = it["kind"]
        return (f"dir:{it['path']}" if k == "dir"
                else f"tool:{it['tool']}" if k == "tool"
                else f"mcp:{it['server']}" if k == "mcp"
                else "permission_mode")

    def _scope_item_label(self, it: dict[str, Any]) -> str:
        k = it["kind"]
        return (f"folder {it['path']} ({it['mode']})" if k == "dir"
                else f"tool: {it['tool']}" if k == "tool"
                else f"MCP server: {it['server']}" if k == "mcp"
                else f"permission mode → {it['mode']}"
                     + (" ⚠ UNGUARDED — removes every prompt"
                        if it["mode"] == "bypassPermissions" else ""))

    def _holds_scope_item(self, nid: str, it: dict[str, Any]) -> bool:
        sc = self.node(nid)["scope"]
        k = it["kind"]
        if k == "dir":
            held = {d["path"]: d["mode"] for d in sc["add_dirs"]}
            m = held.get(it["path"])
            return m == "rw" or m == it["mode"]
        if k == "tool":
            return bool(sc["tools"].get(it["tool"]))
        if k == "mcp":
            mcp = sc["tools"].get("mcp") or []
            return "*" in mcp or it["server"] in mcp
        cur = sc.get("permission_mode", "acceptEdits")
        return (cur in PM_LEVELS and it["mode"] in PM_LEVELS
                and PM_LEVELS.index(cur) >= PM_LEVELS.index(it["mode"]))

    def _scope_item_state(self, nid: str, it: dict[str, Any]) -> str:
        """What the node ACTUALLY holds for this item right now, as a
        comparable label. A kiosk ceiling MEETS rather than annihilates —
        `rw` can land as `ro`, and a `bypassPermissions` ask still raises a
        `plan` node to `acceptEdits`. Comparing this before and after the
        apply is what tells a real-but-short grant apart from nothing at
        all, which `_holds_scope_item` (asked-for or not) cannot."""
        sc = self.node(nid)["scope"]
        k = it["kind"]
        if k == "dir":
            m = next((d["mode"] for d in sc["add_dirs"]
                      if d["path"] == it["path"]), None)
            return f"{it['path']} ({m})" if m else "nothing"
        if k == "tool":
            return f"tool {it['tool']}" if sc["tools"].get(it["tool"]) \
                else "nothing"
        if k == "mcp":
            mcp = sc["tools"].get("mcp") or []
            return (f"MCP server {it['server']}"
                    if "*" in mcp or it["server"] in mcp else "nothing")
        return f"permission mode {sc.get('permission_mode', 'acceptEdits')}"

    def request_scope(self, nid: str, items: list[Any],
                      reason: Any) -> dict[str, Any]:
        """FR-13 (user request 2026-08-06, ruled 2026-08-11/12): an agent asks
        the USER for a permission-scope increase — a folder, a built-in tool,
        an MCP server, or a permission-mode raise (`plan` through
        `bypassPermissions`, the latter loudly labeled). USER-ONLY grantor by
        ruling: a superior that already holds the capability can simply
        orgtree_retool the requester, and the refusal/routing text says so.

        The request rides the agent's ONE open batch (FR-14): items merge
        into the pending scope request by identity (a re-ask of the same
        path/tool amends that item), questions and a credit request coexist
        beside it, and the batch resolves at the user's single submit —
        approve/deny/skip per item, applied as the user via set_scope, so a
        deep grant D-106-cascades the chain automatically."""
        self._require_live(nid)
        n = self.node(nid)
        if self.d.get("headless"):
            raise LedgerError(
                "this org runs HEADLESS: no user is present and scope "
                "requests are auto-denied. Work within the scope you hold, "
                "or record the blocker with orgtree_status(blocked, …)")
        if not (reason and str(reason).strip()):
            raise LedgerError("a reason is required — say what the access is for")
        if not isinstance(items, list) or not items:   # pyright: ignore[reportUnnecessaryIsInstance]  # wire Any
            raise LedgerError("items must be a non-empty list")
        if len(items) > 8:
            raise LedgerError("at most 8 items per request")
        norm: list[dict[str, Any]] = []
        for i, raw_any in enumerate(items):
            if not isinstance(raw_any, dict):
                raise LedgerError(f"items[{i}] must be an object with `kind`")
            raw = cast("dict[str, Any]", raw_any)
            k = str(raw.get("kind") or "")
            if k == "dir":
                p = str(raw.get("path") or "").strip()
                m = str(raw.get("mode") or "rw").strip()
                if not p:
                    raise LedgerError(f"items[{i}]: dir needs `path`")
                if m not in ("ro", "rw"):
                    raise LedgerError(f"items[{i}]: mode must be ro|rw")
                norm.append({"kind": "dir", "path": p, "mode": m})
            elif k == "tool":
                t = str(raw.get("tool") or "").strip()
                if t not in TOOL_KEYS:
                    raise LedgerError(
                        f"items[{i}]: tool must be one of {TOOL_KEYS}")
                norm.append({"kind": "tool", "tool": t})
            elif k == "mcp":
                s = str(raw.get("server") or "").strip()
                if not s:
                    raise LedgerError(f"items[{i}]: mcp needs `server`")
                norm.append({"kind": "mcp", "server": s})
            elif k == "permission_mode":
                m = str(raw.get("mode") or "").strip()
                if m not in PM_LEVELS:
                    raise LedgerError(
                        f"items[{i}]: mode must be one of {PM_LEVELS}")
                norm.append({"kind": "permission_mode", "mode": m})
            else:
                raise LedgerError(
                    f"items[{i}]: kind must be one of {self.SCOPE_KINDS}")
        # motto A3: asking for what you already hold is a no-op, per item
        held = [it for it in norm if self._holds_scope_item(nid, it)]
        norm = [it for it in norm if not self._holds_scope_item(nid, it)]
        if not norm:
            return {"status": "you already hold everything you asked for — "
                              "nothing to request"}
        # the user-mail gate, same shape as questions: a deep agent with no
        # user audience ROUTES the request to its superior instead — who may
        # grant what it holds directly (orgtree_retool) or escalate
        if n["parent"] is not None and not self._has_audience(nid, USER):
            sup = n["parent"]
            # typed (family access_resources): access.scope_requested — the item
            # labels as the text shows them AND the wanted scope as data
            want: dict[str, Any] = {"folders": [], "tools": {"bash": None, "web": None,
                                                              "edit": None, "subagents": None,
                                                              "mcp": None},
                                    "permission_mode": None, "org_visibility": None}
            for it in norm:
                if it["kind"] == "dir":
                    want["folders"].append({"path": str(it["path"]), "mode": str(it["mode"])})
                elif it["kind"] == "tool":
                    want["tools"][str(it["tool"])] = True
                elif it["kind"] == "mcp":
                    want["tools"]["mcp"] = (want["tools"]["mcp"] or []) + [str(it["server"])]
                else:
                    want["permission_mode"] = str(it["mode"])
            r = self.post_mail(nid, sup, "", kind="request",
                               ev=_mint("access.scope_requested", actor_of(nid),
                                        self.node_ref(nid),
                                        items=[self._scope_item_label(it) for it in norm],
                                        reason=str(reason).strip(), wanted=want))
            return {"routed": sup, "deferred": bool(r.get("deferred")),
                    "status": f"you hold no user audience — the request was "
                              f"mailed to your superior \"{sup}\"; they can "
                              f"grant what they hold, or escalate"}
        reqs = self.d.setdefault("scope_requests", [])
        pending = next((r for r in reqs
                        if r["node"] == nid and r["status"] == "pending"),
                       None)
        note = (f" ({len(held)} item(s) you already hold were dropped)"
                if held else "")
        if pending is not None:
            cur = {self._scope_item_key(it): it
                   for it in cast("list[dict[str, Any]]", pending["items"])}
            for it in norm:
                cur[self._scope_item_key(it)] = it
            if len(cur) > 8:
                raise LedgerError(
                    "your pending scope request already carries 8 items — "
                    "withdraw the batch or wait for the user's submit")
            pending["items"] = list(cur.values())
            pending.update({"reason": str(reason).strip(), "at": now(),
                            "rev": int(pending.get("rev") or 1) + 1})
            self._log("scope_request", nid,
                      {"id": pending["id"], "amended": True,
                       "items": [self._scope_item_key(x) for x in norm]}, [])
            return {"requested": [self._scope_item_label(x) for x in norm],
                    "status": f"pending (merged into your open batch — now "
                              f"{len(pending['items'])} scope item(s)){note} "
                              f"— the user decides per item at one submit; "
                              f"do NOT wait for it in this turn"}
        rid = "sr" + uuid.uuid4().hex[:8]
        reqs.append({"id": rid, "node": nid, "items": norm,
                     "reason": str(reason).strip(), "at": now(), "rev": 1,
                     "status": "pending"})
        self._log("scope_request", nid,
                  {"id": rid,
                   "items": [self._scope_item_key(x) for x in norm]}, [])
        return {"requested": [self._scope_item_label(x) for x in norm],
                "status": f"pending — on the user's screen as part of your "
                          f"request batch{note}. The user approves, denies "
                          f"or skips each item at one submit; the outcome "
                          f"arrives as mail. Do NOT wait for it in this "
                          f"turn: wrap up and end the turn."}

    def resolve_batch(self, nid: str, revs: Mapping[str, Any],
                      answers: list[Any] | None = None,
                      credits: Mapping[str, Any] | None = None,
                      scope: list[Any] | None = None) -> dict[str, Any]:
        """FR-14: the user's ONE submit over the node's whole batch —
        question tabs (positional answers, explicit null = skipped), the
        credits tab (granted N / deny / skip) and the scope tabs (approve /
        deny / skip per item) resolve together, under one lock, into ONE
        composed mail. Every open component must be echoed in `revs` (the
        CAS stamp per store — an append mid-render refuses the stale submit)
        and must carry a decision payload; a skipped tab is an EXPLICIT
        skip, never a hole (FR-04's miscount guard survives)."""
        ask = next((a for a in self.d.get("asks", [])
                    if a["node"] == nid and a["status"] == "open"), None)
        cr = next((r for r in self.d.get("credit_requests", [])
                   if r["node"] == nid and r["status"] == "pending"), None)
        sr = next((r for r in self.d.get("scope_requests", [])
                   if r["node"] == nid and r["status"] == "pending"), None)
        if not (ask or cr or sr):
            raise LedgerError(f"{nid} has no open request batch")
        for key, comp in (("ask", ask), ("credits", cr), ("scope", sr)):
            if comp is None:
                continue
            got = revs.get(key)
            try:
                stale = got is None or int(got) != int(comp.get("rev") or 1)
            except (TypeError, ValueError):
                # redteam nit 2026-08-12: the API's pydantic model coerces
                # revs to ints, so this is unreachable over the wire — but a
                # hermetic caller's junk must refuse honestly, never 500
                stale = True
            if stale:
                raise LedgerError(
                    "the card changed after it rendered (a request was "
                    "appended or amended) — re-read the batch and submit "
                    "what it shows now")
        sections: list[dict[str, Any]] = []      # typed Section records (answer.batch)
        # ---- question tabs
        if ask is not None:
            qs = cast("list[dict[str, Any]]", ask.get("questions") or [])
            per = list(answers or [])
            if len(per) != len(qs):
                raise LedgerError(
                    f"the batch has {len(qs)} question tab(s) and the submit "
                    f"carried {len(per)} answer slot(s) — exactly one per "
                    f"tab (null = explicitly skipped)")
            norm: list[Any] = []
            for item in per:
                if item is None:
                    norm.append(None)
                elif isinstance(item, list):
                    norm.append([str(x).strip()
                                 for x in cast("list[Any]", item)
                                 if str(x).strip()] or None)
                else:
                    norm.append(str(item or "").strip() or None)
            answered = sum(1 for v in norm if v is not None)
            ask["status"] = "answered" if answered else "dismissed"
            ask["reason"] = ("answered" if answered
                             else "every question was skipped at submit")
            flat: list[str] = [
                str(x) for v in norm if v is not None
                for x in (cast("list[Any]", v)
                          if isinstance(v, list) else [v])]
            if flat:
                ask["answer"] = {"selected": flat}
            bq: list[dict[str, Any]] = []
            for qd, v in zip(qs, norm):
                if v is not None:
                    qd["answer"] = v
                ans = (None if v is None else
                       " · ".join(str(x) for x in cast("list[Any]", v))
                       if isinstance(v, list) else str(v))
                bq.append({"label": (str(qd.get("header")) if qd.get("header") else None),
                           "question": str(qd["question"]), "answer": ans})
            ask["resolved_at"] = now()
            sections.append({"kind": "ask", "ask_id": str(ask["id"]), "questions": bq})
            self._log("ask_answered", USER,
                      {"id": ask["id"], "node": nid,
                       "skipped": len(qs) - answered}, [])
        # ---- the credits tab
        if cr is not None:
            c = dict(credits or {})
            if not c:
                raise LedgerError("the batch has a credits tab — the submit "
                                  "must decide it (granted N, deny, or skip)")
            if c.get("skip"):
                cr["status"] = "dismissed"
                cr["reason"] = "skipped at batch submit"
                cr["resolved_at"] = now()
                sections.append({"kind": "credit", "outcome": "skipped",
                                 "old": float(cr["old"]), "asked": float(cr["new"]),
                                 "granted": None, "now": None})
                self._log("credit_dismissed", USER, {"id": cr["id"]}, [])
            else:
                r = self.credit_request_action(
                    cr["id"], "deny" if c.get("deny") else "approve",
                    granted=(None if c.get("granted") is None
                             else int(c["granted"])))
                cev = r.get("ev")
                if cev is not None:
                    sections.append({"kind": "credit", "outcome": cev["outcome"],
                                     "old": cev["old"], "asked": cev["asked"],
                                     "granted": cev["granted"], "now": cev["now"]})
        # ---- the scope tabs
        if sr is not None:
            its = cast("list[dict[str, Any]]", sr["items"])
            dec = [str(x or "").strip() for x in (scope or [])]
            if len(dec) != len(its):
                raise LedgerError(
                    f"the batch has {len(its)} scope item(s) and the submit "
                    f"carried {len(dec)} decision(s) — exactly one "
                    f"(approve|deny|skip) per item")
            if any(d not in ("approve", "deny", "skip") for d in dec):
                raise LedgerError("scope decisions must be approve|deny|skip")
            sc = self.node(nid)["scope"]
            # the BEFORE half of the three-valued verdict below — captured
            # here, while `sc` is still untouched by set_scope
            pre_state = {self._scope_item_key(it):
                         self._scope_item_state(nid, it) for it in its}
            add_dirs: list[dict[str, Any]] | None = None
            tools: dict[str, Any] | None = None
            pm: str | None = None
            for it, d in zip(its, dec):
                it["decision"] = d
                if d != "approve":
                    continue
                if it["kind"] == "dir":
                    add_dirs = add_dirs if add_dirs is not None else \
                        [dict(x) for x in sc["add_dirs"]]
                    i = next((j for j, x in enumerate(add_dirs)
                              if x["path"] == it["path"]), None)
                    if i is None:
                        add_dirs.append({"path": it["path"],
                                         "mode": it["mode"]})
                    elif it["mode"] == "rw":
                        add_dirs[i]["mode"] = "rw"
                elif it["kind"] == "tool":
                    tools = tools if tools is not None else dict(sc["tools"])
                    tools[it["tool"]] = True
                elif it["kind"] == "mcp":
                    tools = tools if tools is not None else dict(sc["tools"])
                    mcp = list(cast("list[str]", tools.get("mcp") or []))
                    if "*" not in mcp and it["server"] not in mcp:
                        mcp.append(it["server"])
                    tools["mcp"] = mcp
                else:
                    pm = str(it["mode"])
            granted_lines: list[str] = []
            if add_dirs is not None or tools is not None or pm is not None:
                # applied AS THE USER — set_scope carries the kiosk-ceiling
                # clamp and the D-106 upward cascade, so a deep grant raises
                # the chain and reports it exactly like a manual ⚙ grant
                r = self.set_scope(USER, nid, add_dirs=add_dirs, tools=tools,
                                   permission_mode=pm)
                for w in cast("list[str]", r.get("warnings") or []):
                    granted_lines.append(f"({w})")
            # ⚠ the verdict is measured, not assumed (found driving the
            # kiosk composition 2026-08-12): a ceiling can clamp an approved
            # item away ENTIRELY, and "GRANTED — live from your next turn"
            # for a capability the scope does not hold is an unkeepable
            # promise. Re-check each approval against the ACTUAL post-apply
            # scope and say what really happened.
            #
            # …and the measurement is THREE-valued, because a ceiling MEETS
            # rather than annihilates (redteam, 2026-08-12): `E:/x rw` can
            # land as `E:/x ro`, and a `bypassPermissions` ask still raises a
            # `plan` node to `acceptEdits`. Both are real grants the agent
            # did not hold a moment ago. Reporting them as "NOT in effect" is
            # the same unkeepable-promise class inverted — the agent then
            # declines to use access it genuinely has — so a grant that moved
            # but fell short says exactly what it moved to. Only a state that
            # did not move at all is "not in effect".
            partial: dict[str, str] = {}
            for it in its:
                if it["decision"] != "approve" \
                        or self._holds_scope_item(nid, it):
                    continue
                key = self._scope_item_key(it)
                got = self._scope_item_state(nid, it)
                if got == pre_state.get(key):
                    it["decision"] = "approve (clamped — not in effect)"
                else:
                    it["decision"] = "approve (partial)"
                    partial[key] = got
            sr["status"] = "answered"
            sr["reason"] = "decided at batch submit"
            sr["resolved_at"] = now()
            def _verdict(it: dict[str, Any]) -> str:
                d = str(it["decision"])
                if d == "approve (partial)":
                    return ("approved by the user, then PARTIALLY clamped by "
                            "the kiosk permission ceiling — you now hold "
                            + partial[self._scope_item_key(it)]
                            + ", which is real and live from your next turn, "
                              "but less than you asked for (ask the user to "
                              "raise the ceiling for the rest)")
                return {"approve": "GRANTED — live from your next turn",
                        "approve (clamped — not in effect)":
                            "approved by the user, but the kiosk permission "
                            "ceiling CLAMPED it — NOT in effect (see the "
                            "clamp note below; ask the user to raise the "
                            "ceiling if you truly need it)",
                        "deny": "denied",
                        "skip": "skipped (undecided — you may re-ask)"}[d]
            outcome = "\n".join(
                f"- {self._scope_item_label(it)} → " + _verdict(it)
                for it in its)
            # the verdict lines are composed from scope state this renderer cannot
            # see (clamp measurement, set_scope warnings): carried as data, joined
            # by the renderer exactly as they were joined here
            text = ("[SCOPE REQUEST decided]\n" + outcome
                    + ("\n" + "\n".join(granted_lines) if granted_lines else ""))
            sections.append({"kind": "scope", "lines": text.split("\n"),
                             "decisions": [{"label": self._scope_item_label(it),
                                            "decision": str(it["decision"])}
                                           for it in its]})
            self._log("scope_decided", USER,
                      {"id": sr["id"],
                       "decisions": [str(x["decision"]) for x in its]}, [])
        # typed (family answer_decision): answer.batch on the BatchRef — the id is
        # the first component's (ask, credit request, scope request), the body
        # is the sections' rendering, byte for byte the old "\n\n" join
        first = ask or cr or sr
        assert first is not None
        ev = _mint("answer.batch", actor_of(USER),
                   {"kind": "batch", "org": str(self.d.get("slug") or ""),
                    "id": str(first["id"]), "node": nid},
                   sections=sections)
        return {"node": nid, "body": events.render_agent(ev), "ev": ev}

    # ---------------------------------------------------- FR-18 watchdogs
    WATCHDOG_KINDS: Final = ("file", "command", "process", "stream")
    WATCHDOG_PER_AGENT: Final = 8       # runaway insurance (№34 spirit) —
    WATCHDOG_PER_ORG: Final = 32        # pets are free, never unbounded
    WATCHDOG_MIN_INTERVAL: Final = 15   # poll floor (s); streams: min fire gap 5
    WATCHDOG_EVENTS_KEEP: Final = 50    # the sent-events ring per dog
    # D-117 ④ says "pause on the owner's archive (resume on rehire)". Which
    # pauses a rehire may undo has to be decidable, or the resume would also
    # re-arm a dog the owner deliberately paused, and one the engine stopped
    # for a reason the rehire does not answer (a revoked folder or bash). So
    # an archive-pause says so, and ONLY this reason auto-resumes.
    WATCHDOG_ARCHIVE_PAUSE: Final = "its owner was archived"
    #: ⏹ STOP ALL paused this dog. USER RULING 2026-09-04: "nothing unpauses
    #: them automatically; it's an emergency killswitch… the only thing that
    #: can unpause the paused dogs is either manually visiting each one and
    #: resuming it, or telling the agents to unpause all their paused dogs."
    #:
    #: ⚠ THIS STRING IS LOAD-BEARING, not a label. `rehire` re-arms paused
    #: dogs — but ONLY those whose reason is WATCHDOG_ARCHIVE_PAUSE. Giving
    #: the killswitch its own reason is what stops a later rehire from
    #: silently re-arming a dog the operator stopped in an emergency. If these
    #: two strings are ever made equal, the killswitch acquires an automatic
    #: resume that nobody asked for and nobody would see.
    WATCHDOG_KILLSWITCH_PAUSE: Final = (
        "⏹ STOP ALL paused every watchdog. Nothing un-pauses it "
        "automatically — resume this dog deliberately when you want it back.")

    def watchdogs_pause_all(self, why: str) -> list[dict[str, str]]:
        """Pause every ARMED dog in this org. Returns what was actually paused.

        Only `armed` dogs are touched, so a dog already paused keeps the reason
        it was paused FOR — an archive-pause overwritten with the killswitch
        reason would become a dog a later rehire no longer re-arms, i.e. the
        stop would silently make an unrelated pause permanent.

        Caller holds DOC_LOCK and saves; this is pure document surgery so it
        composes into the killswitch's single atomic save.
        """
        hit = []
        for w in cast("list[dict[str, Any]]", self.d.get("watchdogs") or []):
            if w.get("state") != "armed":
                continue
            w["state"] = "paused"
            w["paused_why"] = why
            hit.append({"id": str(w["id"]), "name": str(w["name"]),
                        "owner": str(w["owner"])})
        if hit:
            self._log("watchdogs_pause_all", USER,
                      {"n": len(hit), "why": why}, [])
        return hit

    def _watchdog(self, wid: str) -> dict[str, Any]:
        d = next((w for w in self.d.get("watchdogs") or []
                  if w["id"] == wid), None)
        if d is None:
            raise LedgerError(f"no watchdog {wid!r}")
        return d

    WATCHDOG_SHELLS: Final = ("native", "bash")

    def watchdog_create(self, owner: str, name: Any, kind: Any, target: Any,
                        pattern: Any = None,
                        interval_s: Any = 60,
                        notice: Any = False,
                        shell: Any = None,
                        once: Any = False) -> dict[str, Any]:
        """FR-18 (user request 2026-08-07, rulings 2026-08-12): a PET — a
        persistent watcher that mails its owner when its target produces a
        matching event. Free by ruling (never enters TIERS), bounded
        numerically. Kinds:
          file     poll a path; new content matching `pattern` fires (the
                   high-water diff also recovers events from orgtree's OWN
                   downtime — the FR-07-spool property, for files)
          command  run a command each interval; matching output fires
          process  liveness — `pid:N` or `port:N`; fires on the DOWN edge
          stream   a persistent LISTENING command: each matching stdout line
                   surfaces the moment it occurs (user ruling: the realtime
                   alternative to a cadence); dies with orgtree, re-armed by
                   the engine at startup — downtime output is honestly lost
        Capability rule (ruling): a dog runs with its OWNER's hands —
        command/stream require the owner to hold bash and run inside the
        owner's sandbox when sandboxed; file paths are containment-checked
        at the API boundary against the owner's readable roots.

        `notice=True` (user ruling 2026-08-21) makes the fire PASSIVE: the
        mail lands in the owner's box exactly as before, but no turn is
        STARTED for it — the same bargain orgtree_send_notice strikes, and
        it reuses that mechanism (`send_message(..., wake=False)`), so a
        RUNNING owner is still steered mid-task and only an IDLE one is left
        alone. Default stays waking: every dog armed before this existed,
        and every dog armed without the flag, drives a turn as it always
        has. The flag is for "tell me the build finished" — worth knowing,
        not worth a turn.

        `shell` (2026-08-22) opts a command/stream dog out of the platform's
        native shell. ABSENT — and every dog armed before this existed is
        absent — means native, i.e. `shell=True`: cmd.exe on a Windows host,
        exactly as before. "bash" runs `bash -lc` instead, for agents who
        want the POSIX idiom the old tool card wrongly implied they had.

        ⚠ The API boundary REFUSES "bash" when no bash can be found, rather
        than falling back (see api.py). Falling back would rebuild the defect
        this field exists to fix, one level up: the agent asks for bash, is
        given cmd, writes bash, and the dog matches nothing forever — this
        time with the tool having agreed that bash was fine.

        `once=True` (D-200, user request 2026-08-30) makes it a ONE-SHOT DOG:
        it fires exactly once and removes itself as part of that fire. Default
        OFF, stored only when set, so every dog armed before this existed and
        every dog armed without the flag is persistent exactly as before.

        WHY IT EXISTS, from the case that produced it: a watchdog whose
        readiness condition encodes a DEADLINE rather than an EDGE is
        permanently true once the deadline passes, so it re-fires every
        interval forever. `d181-population-bar` did precisely that — it woke
        its owner every 15 minutes with the same verdict until the owner
        noticed and removed it by hand. A one-shot dog is the fix for that
        whole class: any dog whose question has exactly one answer.

        ⚠ A one-shot dog is removed only by a FIRE. `watchdog_alert` — the
        subject-went-quiet self-report — deliberately does not spend it: an
        alert means "I can no longer answer the question you asked", and
        retiring the dog on that would throw away the watch precisely when it
        has not been answered yet."""
        self._require_live(owner)
        name = re.sub(r"[^a-z0-9-]+", "-",
                      str(name or "").strip().lower()).strip("-")[:24]
        if not name:
            raise LedgerError("a watchdog needs a short name")
        if kind not in self.WATCHDOG_KINDS:
            raise LedgerError(f"kind must be one of {self.WATCHDOG_KINDS}")
        tgt = str(target or "").strip()
        if not tgt:
            raise LedgerError("target is required — the path, command, or "
                              "pid:N / port:N to watch")
        if kind in ("command", "stream") \
                and not self.node(owner)["scope"]["tools"].get("bash"):
            raise LedgerError(
                "a command/stream watchdog runs with YOUR hands — it needs "
                "the bash you do not hold; ask for it (orgtree_request_scope) "
                "or watch a file instead")
        if kind == "process":
            m = re.fullmatch(r"(pid|port):(\d+)", tgt)
            if not m:
                raise LedgerError("process targets are `pid:N` or `port:N`")
        sh = str(shell or "native").strip().lower()
        if sh not in self.WATCHDOG_SHELLS:
            raise LedgerError(f"shell must be one of {self.WATCHDOG_SHELLS}")
        if sh != "native" and kind not in ("command", "stream"):
            raise LedgerError("only command/stream watchdogs run a shell at "
                              "all — file and process dogs have no target to "
                              "interpret")
        pat = str(pattern).strip() if pattern else None
        if pat:
            try:
                re.compile(pat)
            except re.error as e:
                raise LedgerError(f"pattern does not compile: {e}")
        elif kind in ("command",):
            raise LedgerError("a command watchdog needs a pattern — "
                              "'ran and printed something' is not an event")
        try:
            iv = max(int(interval_s or 60), self.WATCHDOG_MIN_INTERVAL
                     if kind != "stream" else 5)
        except (TypeError, ValueError):
            raise LedgerError("interval_s must be a number of seconds")
        dogs = self.d.setdefault("watchdogs", [])
        if sum(1 for w in dogs if w["owner"] == owner) \
                >= self.WATCHDOG_PER_AGENT:
            raise LedgerError(f"you already keep {self.WATCHDOG_PER_AGENT} "
                              f"watchdogs — remove one first")
        if len(dogs) >= self.WATCHDOG_PER_ORG:
            raise LedgerError(f"the org already keeps "
                              f"{self.WATCHDOG_PER_ORG} watchdogs")
        wid = "wd" + uuid.uuid4().hex[:8]
        quiet = bool(notice)
        one_shot = bool(once)
        dogs.append({"id": wid, "owner": owner, "name": name, "kind": kind,
                     "target": tgt, **({"pattern": pat} if pat else {}),
                     "interval_s": iv, "state": "armed", "at": now(),
                     **({"notice": True} if quiet else {}),
                     # stored ONLY when it is not the default — an absent key
                     # is what makes every pre-existing dog native by
                     # construction rather than by a migration
                     **({"shell": sh} if sh != "native" else {}),
                     **({"once": True} if one_shot else {}),
                     "fired": 0, "events": []})
        self._log("watchdog_create", owner,
                  {"id": wid, "name": name, "kind": kind,
                   **({"notice": True} if quiet else {}),
                   **({"once": True} if one_shot else {}),
                   **({"shell": sh} if sh != "native" else {})}, [])
        return {"id": wid, "name": name, "notice": quiet, "shell": sh,
                "once": one_shot,
                "status": ("armed — ONE-SHOT " if one_shot else "armed — ")
                          + f"{kind} watchdog"
                          + (f" every {iv}s" if kind != "stream"
                             else " (realtime stream)")
                          + ". A matching event arrives as mail from "
                            f"\"{name}\""
                          + (" and waits in your mailbox WITHOUT starting a "
                             "turn — you read it whenever you next run"
                             if quiet else " and wakes you")
                          + (". It then REMOVES ITSELF — one fire, then gone, "
                             "so you will not see it again and `list` will "
                             "not show it" if one_shot else "")
                          + "; it costs no credits."}

    def watchdog_action(self, actor: str, wid: str,
                        action: str) -> dict[str, Any]:
        """pause | resume | remove — the owner itself, any ancestor of the
        owner (downward authority), or the user."""
        w = self._watchdog(wid)
        if actor != w["owner"]:
            self._require_authority(actor, w["owner"])
        if action == "pause":
            w["state"] = "paused"
        elif action == "resume":
            w["state"] = "armed"
            w.pop("exit", None)
            # an engine-side pause explains itself (supervisor `_wd_pause`);
            # resuming is the answer to it, so the reason goes with it
            w.pop("paused_why", None)
        elif action == "remove":
            self.d.setdefault("watchdogs", []).remove(w)
        else:
            raise LedgerError("action must be pause|resume|remove")
        self._log("watchdog_" + action, actor,
                  {"id": wid, "name": w["name"]}, [])
        return {"id": wid, "name": w["name"], "state":
                ("removed" if action == "remove" else w["state"])}

    #: How long a spent one-shot dog leaves a TOMBSTONE on the canvas (D-200,
    #: user catch 2026-08-30).
    #:
    #: ⚠ THIS IS NOT A DEFERRED REMOVAL. The dog is gone from `watchdogs` the
    #: instant it fires: it cannot fire again, cannot be resumed, cannot be
    #: re-armed by a restart, and stops counting against the per-agent cap.
    #: The tombstone is a separate, inert record that exists for ONE reason —
    #: the canvas animates a fire as a spark travelling from the dog to its
    #: owner, and `launchSpark` silently draws nothing when either endpoint
    #: has no position. Positions for dogs come from `tree()["watchdogs"]`, so
    #: a dog that erases itself in the same breath as it fires deletes its own
    #: origin and the user sees mail appear from nowhere. Removal from the
    #: ARMING state and disappearance from the CANVAS are different events;
    #: this is the gap between them.
    #:
    #: 15s is chosen to cover a spark (420ms per path segment) plus a tree
    #: refresh arriving either side of the WebSocket event, with room to
    #: spare. It is not a correctness knob: nothing waits on it, and at 0 the
    #: only thing lost is the animation.
    WATCHDOG_TOMB_TTL_S: Final = 15
    WATCHDOG_TOMBS_KEEP: Final = 32     # runaway insurance, as for the dogs

    #: appended to a ONE-SHOT dog's fire mail (D-200). The owner must be told
    #: in the mail itself, because the alternative is an agent calling `list`,
    #: not finding its dog, and having to work out whether it broke something.
    WATCHDOG_ONCE_NOTE: Final = events_render.WATCHDOG_ONCE_NOTE

    def watchdog_fire(self, wid: str, gist: str, body: str = "", *,
                      lines: list[str] | None = None,
                      prefix: str = "") -> str | None:
        """The engine's hand: record the event and put the mail in the
        OWNER's box. Returns the owner to drive, or None (paused owner /
        archived owner — archived pauses the dog per the lifecycle ruling).

        TYPED PATH (design §3, family monitor): the engine passes the event
        `lines` (+ `prefix`) and THIS method mints `monitor.watchdog_fired` —
        the ledger is the one place that knows whether the dog is one-shot,
        so `once` on the event is true by construction and the rendered body
        (note included) is frozen on the row beside `ev`. The positional
        `body` path is the pre-typed shape: a caller-built body, no `ev`,
        the note appended by the same helper the renderer uses.

        ⚠ D-200 — WHY THERE IS NO "ORDER" TO GET WRONG HERE. A one-shot dog
        must not mail without removing itself (that is the runaway this fixes)
        and must not remove itself without mailing (that loses the event with
        no trace, which is worse). Both hazards come from treating the mail
        and the removal as two steps that could half-happen. They are not:
        the mailbox and the watchdog registry are two keys of ONE document,
        every caller of this method mutates that document under `DOC_LOCK` and
        persists it with a SINGLE `save_org`, and `save_org` writes
        atomically. So the two land together or neither lands. The sequence of
        the statements below is therefore irrelevant to correctness, and the
        thing that actually matters — that no caller can perform one without
        the other — is enforced by both living in this one method.

        The one failure that remains is the save itself failing, and it fails
        in the safe direction: neither the mail nor the removal is persisted,
        the dog is still armed on disk, and it fires again next interval. A
        duplicate fire is recoverable; a silently swallowed event is not."""
        w = self._watchdog(wid)
        if w["state"] != "armed":
            return None
        owner = str(w["owner"])
        if owner not in self.nodes or self.node(owner)["state"] != "live":
            w["state"] = "paused"      # lifecycle ruling: pause on archive
            w["paused_why"] = self.WATCHDOG_ARCHIVE_PAUSE
            return None
        one_shot = bool(w.get("once"))
        w["fired"] = int(w.get("fired") or 0) + 1
        w["last_fired"] = now()
        ring = cast("list[dict[str, Any]]", w.setdefault("events", []))
        fire = {"at": now(), "gist": gist[:200]}
        history = self.d.setdefault("watchdog_history", [])
        if not w.get("history_retained"):
            history.extend({**old, "watchdog": wid, "node": owner} for old in ring)
            w["history_retained"] = True
        ring.append(fire)
        del ring[:-self.WATCHDOG_EVENTS_KEEP]
        ev: dict[str, Any] | None = None
        if lines is not None:
            if not lines:
                # a programming error, NOT a LedgerError: the engine's fire
                # path swallows LedgerError as "the dog changed under me",
                # and a fire with no event must not vanish under that label
                raise ValueError("watchdog_fire: at least one event line")
            ev = _mint("monitor.watchdog_fired",
                       {"kind": "watchdog", "id": wid},
                       self._watchdog_ref(w),
                       prefix=prefix, lines=list(lines), count=len(lines),
                       once=one_shot)
            body = events.render_agent(ev)       # note included when once
        elif one_shot:
            # truncate to the same 8000 the entry does, but AFTER the note, so
            # a long event body can never push the "it removed itself"
            # sentence off the end of the mail that explains its absence
            body = events_render.watchdog_once_note(body)
        history.append({**fire, "watchdog": wid, "node": owner, "body": body})
        entry: MailEntry = {
            "id": uuid.uuid4().hex[:12], "from": str(w["name"]),
            "kind": "watchdog", "body": body[:8000], "at": now(),
            "relationship": "your watchdog"}
        if ev is not None:
            entry["ev"] = events.encode_row_ev(ev, entry)
        box = cast("dict[str, list[dict[str, Any]]]",
                   self.d.setdefault("mail", {}))
        box.setdefault(owner, []).append(dict(entry))
        # mirror into mail_log like every other sender: the inbox tab shows
        # DELIVERED mail from the archive, and `mail` is only the pending
        # queue — a fired dog's mail vanished from the panel the moment the
        # owner's turn drained it (user bug 2026-08-14). Same `at`/body as
        # the queued copy, or node_inbox's (at, from, body) dedup breaks.
        log = self.d.setdefault("mail_log", {}).setdefault(owner, [])
        log.append(cast(MailEntry, dict(entry)))

        self._log("watchdog_fire", owner, {"id": wid, "gist": gist[:80],
                                           **({"once": True} if one_shot
                                              else {})}, [])
        if one_shot:
            # the dog's own `events` ring and `fired` counter go with it, so
            # the org event log is the only durable trace that it ever fired.
            # Both entries are written above/here, in this same transaction.
            try:
                self.d.setdefault("watchdogs", []).remove(w)
            except ValueError:                      # already gone — fine
                pass
            # …and the canvas tombstone, in the SAME transaction as the
            # removal and the mail, so the three cannot disagree. See
            # WATCHDOG_TOMB_TTL_S: this does not keep the dog alive in any
            # sense that matters, it keeps its POSITION resolvable long
            # enough for the fire to be drawn.
            tombs = cast("list[dict[str, Any]]",
                         self.d.setdefault("watchdog_tombs", []))
            tombs[:] = [t for t in tombs
                        if not self._tomb_expired(t)][-self.WATCHDOG_TOMBS_KEEP:]
            tombs.append({"id": wid, "owner": owner, "name": str(w["name"]),
                          "kind": str(w["kind"]),
                          "target": str(w.get("target") or ""),
                          "interval_s": w.get("interval_s"),
                          "at": w.get("at"), "spent_at": now(),
                          "fired": int(w.get("fired") or 0),
                          **({"notice": True} if w.get("notice") else {})})
            self._log("watchdog_remove", owner,
                      {"id": wid, "name": w["name"],
                       "why": "one-shot dog spent by its fire"}, [])
        return owner

    def _tomb_expired(self, tomb: dict[str, Any]) -> bool:
        """Has a spent one-shot dog's canvas tombstone outlived its welcome?

        Age is computed from `spent_at`; a tombstone with an unreadable stamp
        is treated as EXPIRED. That direction is deliberate — the failure mode
        of a stuck tombstone is a ghost dog sitting on the canvas forever,
        which is worse than a missed animation and is precisely the kind of
        thing nobody would think to report as a bug."""
        try:
            spent = datetime.strptime(str(tomb.get("spent_at"))[:23],
                                      "%Y-%m-%dT%H:%M:%S.%f").replace(
                                          tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return True
        age = (datetime.now(timezone.utc) - spent).total_seconds()
        return age < 0 or age > self.WATCHDOG_TOMB_TTL_S

    # ---- canonical Refs (design §2) — the ONE place each Ref shape is built
    def node_ref(self, nid: str) -> dict[str, Any]:
        n = self.nodes.get(nid) or {}
        return {"kind": "node", "org": str(self.d.get("slug") or ""), "id": nid,
                "name": str(n.get("name") or nid),
                "generation": int(n.get("generation") or 0)}

    def work_item_ref(self, it: Mapping[str, Any]) -> dict[str, Any]:
        return {"kind": "work_item", "org": str(self.d.get("slug") or ""),
                "slug": str(it.get("slug") or ""), "title": str(it.get("title") or "")}

    def org_ref(self) -> dict[str, Any]:
        return {"kind": "org", "org": str(self.d.get("slug") or "")}

    def _watchdog_ref(self, w: Mapping[str, Any]) -> dict[str, Any]:
        """The canonical WatchdogRef of a dog as the monitor family mints it."""
        return {"kind": "watchdog", "org": str(self.d.get("slug") or ""),
                "id": str(w["id"]), "name": str(w["name"]),
                "owner": str(w["owner"])}

    def watchdog_alert(self, wid: str, body: str = "", *,
                       ev: Mapping[str, Any] | None = None) -> str | None:
        """Post a dog's SELF-REPORT to its owner — the subject went quiet, the
        target cannot be run, the dog is spent (D-176). Returns the owner to
        drive, or None.

        TYPED PATH: `ev` is a `monitor.watchdog_quiet` event (the engine mints
        it: the facts come from the dog's check state, which the engine owns);
        the row body is its rendering, frozen, beside `ev`. The positional
        `body` is the pre-typed shape: caller-built text, no `ev`.

        ⚠ Deliberately NOT `watchdog_fire`, though it is the same mailbox.
        A fire means "the condition you asked about happened"; this means "I
        can no longer answer the question you asked". Routing it through
        `watchdog_fire` would increment `fired`, and `fired` is the counter
        the whole abstention diagnosis is read from — a dog reporting its own
        failure would start looking like a dog that had been working. The
        instrument must not corrupt the evidence it exists to preserve.

        ⚠ It also does NOT pause an archived owner's dog the way a fire does.
        That is `_wd_owner_lost`'s job on every tick now, and doing it here
        as well would let an alert about a QUIET FILE overwrite a
        `paused_why` that says the owner was archived."""
        w = self._watchdog(wid)
        owner = str(w["owner"])
        if owner not in self.nodes or self.node(owner)["state"] != "live":
            return None
        if ev is not None:
            _validate_ev(ev)
            if ev.get("variant") != "monitor.watchdog_quiet":
                raise LedgerError("watchdog_alert carries monitor.watchdog_quiet, "
                                  f"not {ev.get('variant')!r}")
            body = events.render_agent(ev)
        entry: MailEntry = {
            "id": uuid.uuid4().hex[:12], "from": str(w["name"]),
            "kind": "watchdog", "body": body[:8000], "at": now(),
            "relationship": "your watchdog"}
        if ev is not None:
            entry["ev"] = events.encode_row_ev(ev, entry)
        box = cast("dict[str, list[dict[str, Any]]]",
                   self.d.setdefault("mail", {}))
        box.setdefault(owner, []).append(dict(entry))
        # same mirror as a fire, for the same reason: `mail` is the pending
        # queue and the inbox tab reads `mail_log`, so an alert the owner's
        # turn drains would otherwise vanish from the panel entirely
        log = self.d.setdefault("mail_log", {}).setdefault(owner, [])
        log.append(cast(MailEntry, dict(entry)))

        self._log("watchdog_alert", owner, {"id": wid, "why": body[:80]}, [])
        return owner

    def rename(self, actor: str, nid: str, new_name: str) -> dict[str, Any]:
        """FULL identity rename (user ruling 2026-08-05): the id itself
        changes and the whole doc re-keys — nodes (lineage generations
        included: `old@g` → `new@g`, they share the scratch dir), parent/
        predecessor/successor pointers, audiences and their requests, the
        mailbox and every per-node dict (delivering, steered_log,
        turn_error_log, notices), open asks and credit requests. Authority =
        the user, the superior, or any ancestor (never self). Validate-all-
        then-mutate (§4.7). HISTORICAL records — mail bodies, sender fields
        in archives, the event log — deliberately keep the old name; the
        returned warning says so (user ruling: warn, don't rewrite)."""
        self._require_authority(actor, nid)
        n = self.node(nid)
        if "@" in nid:
            # a generation carries `base@gen` — renaming one directly would
            # detach the bearer from its lineage naming while the pointers
            # still tie it to the family (test_rename §5)
            raise LedgerError(
                f"{nid!r} is a lineage generation — rename the base id "
                f"{nid.split('@', 1)[0]!r} and its generations follow")
        new = slugify(new_name)
        if new == nid:
            return {"node": nid, "warnings": ["that is already its name"]}
        stack = [nid] + [k for k in self.nodes if k.startswith(nid + "@")]
        renamed = {k: (new + k[len(nid):]) for k in stack}
        for tgt in renamed.values():
            if tgt in self.nodes:
                raise LedgerError(f"the name {tgt!r} is already taken")
        # ---- mutate (nothing below may raise) ----
        for old_k, new_k in renamed.items():
            self.nodes[new_k] = self.nodes.pop(old_k)
        for v in self.nodes.values():
            for f in ("parent", "predecessor", "successor"):
                cur = v.get(f)
                if isinstance(cur, str) and cur in renamed:
                    v[f] = renamed[cur]
        for a in self.d.get("audiences", []):
            for f in ("grantee", "grantor"):
                if a.get(f) in renamed:
                    a[f] = renamed[a[f]]
        for r in self.d.get("audience_requests", []):
            for f in ("from", "target", "currently_at"):
                if r.get(f) in renamed:
                    r[f] = renamed[r[f]]
        for key in ("mail", "delivering", "steered_log", "turn_error_log",
                    "notices"):
            box = cast("dict[str, Any] | None", self.d.get(key))
            if isinstance(box, dict):
                for old_k, new_k in renamed.items():
                    if old_k in box:
                        box[new_k] = box.pop(old_k)
        for a in self.d.get("asks", []):
            if a.get("node") in renamed:
                a["node"] = renamed[a["node"]]
        for r in self.d.get("credit_requests", []):
            if r.get("node") in renamed:
                r["node"] = renamed[r["node"]]
        for r in self.d.get("scope_requests", []):
            if r.get("node") in renamed:
                r["node"] = renamed[r["node"]]
        for w in self.d.get("watchdogs", []):
            if w.get("owner") in renamed:
                w["owner"] = renamed[w["owner"]]
        # Presented documents are live identity records, not historical event
        # text. Re-key only cards owned by the validated node/generation map;
        # the event log (including genuinely retired generations) remains an
        # immutable historical record and is intentionally not rewritten.
        for doc in self.d.get("documents", []):
            if doc.get("node") in renamed:
                doc["node"] = renamed[doc["node"]]
        # Work items, CURRENT-identity fields only. `owner`, `last_updater`
        # and `participants` say who holds an item now, and the authority
        # paths read them: `_work_can_manage` compares the actor to the owner
        # and needs that anchor to still BE a node, and `work_reply_target`
        # refuses when the last updater is not. Un-re-keyed, a rename leaves
        # an agent unable to see or answer on its own docket.
        #
        # `created_by`, `history[].by`/`from`, `evidence[].by`, the delivery
        # claims and `accepted.by` are AUTHORED HISTORY and keep the old name,
        # like mail bodies and the event log. `rev`, `updated_at`, `docket_at`
        # and `history` do not move: a re-key is not a docket update.
        self._rekey_work_identity(renamed)
        # operation receipts are per-node too (opreceipts.rekey_nodes): a call
        # that applied under the old id must not become invisible to a lookup
        # under the new one, which would read as "not applied, safe to
        # reissue". The row moves; the FINGERPRINT it was minted with does
        # not, so a seat renamed A → B → C still prints at A.
        opreceipts.rekey_nodes(cast("dict[str, Any]", self.d), renamed)
        # the display title (set at hire from the raw name) follows the
        # identity — tree() ships it beside the id, so a stale title would
        # show exactly the name the rename was meant to replace
        title = new_name.strip() or new
        for new_k in renamed.values():
            self.nodes[new_k]["title"] = title
        warnings = [f"renamed {nid} → {new}. Historical mail, archives and "
                    f"the event log still reference {nid!r}; agents may keep "
                    f"addressing the old name until they notice — such mail "
                    f"will bounce with 'unknown recipient'."]
        self._log("rename", actor, {"node": nid, "new": new}, warnings)
        self._notify_ev([new], _mint("lifecycle.renamed", actor_of(actor), self.node_ref(new),
                                     old=nid, new=new, by=actor))
        _ = n
        return {"node": new, "was": nid, "renamed": renamed,
                "warnings": warnings}

    #: the work-item fields that name WHO HOLDS AN ITEM NOW. Everything else
    #: on an item that carries a node id records who did something THEN, and
    #: is authored history: `created_by`, `history[].by`, `history[].from`,
    #: `evidence[].by`, `delivery.*.claimed_by`, `accepted.by`.
    WORK_IDENTITY_FIELDS: tuple[str, ...] = ("owner", "last_updater")

    @staticmethod
    def _work_ref(it: WorkItem) -> str:
        """A work item's name: its slug, and only its slug (user ruling
        2026-09-05 — the docket is identified solely by readable slug). An
        item with none is unnamed here rather than named by an opaque id."""
        return str(it.get("slug") or "")

    #: ops that can BIND, UNBIND or MOVE a node name, and so break the chain
    #: from a rename to the node standing under that name now
    _NAME_BINDING_OPS: frozenset[str] = frozenset((
        "hire", "rename", "delete", "insert_parent",
        "swap_seats", "subjugate",           # a seat swap moves agents between
                                             # node keys (swap_seats logs `_op`)
        "recover_lost_generation", "drop_phantom_generation",
    ))
    #: ops that NAME a node without rebinding the name. Anything in neither set
    #: is unclassified, and an unclassified op naming the destination refuses
    #: the repair — a new op must be classified deliberately, not assumed safe.
    _NAME_KEEPING_OPS: frozenset[str] = frozenset((
        # `dissolve` ARCHIVES a subtree (state → "archived"); it never removes
        # a node, so the names stay bound to the same records. A retire with
        # live reports becomes one, so this is the ordinary path, not an edge.
        "dissolve",
        "retire", "rehire", "reseed", "unrecoverable", "move_batch",
        "reallocate", "set_scope", "switch_model", "switch_queued",
        "switch_queue_cancelled", "switch_queue_dropped", "unstick",
        "ceiling_set", "ceiling_raise", "rescind", "revoke_dir",
        "cheap_compact", "cli_compact", "compact_split", "self_restart",
        "self_restart_forced", "heal",
        "ask", "ask_answered", "ask_dismissed", "ask_moot", "ask_withdrawn",
        "credit_request", "credit_answer", "credit_deny", "credit_refused",
        "credit_dismissed", "credit_moot", "credit_request_withdrawn",
        "scope_request", "scope_decided", "scope_moot",
        "audience_grant", "audience_deny", "audience_revoke",
        "watchdog_create", "watchdog_remove", "watchdog_fire",
        "watchdog_alert", "watchdogs_pause_all",
        "mail", "ext_mail", "extern_handle_detached",
        "present", "present_dismissed", "present_evicted",
        "work_create", "work_update", "work_assign", "work_accept",
        "work_archived", "work_dismiss", "work_slugs",
        "fable_filter", "fable_limit", "fable_unlock", "rename_repair",
        "set_defaults", "in", "out",
    ))
    #: detail keys that NAME a node as such. `mail`'s `to`, an event's `actor`
    #: and prose in a `gist` mention a node; these BIND one.
    _NODE_KEYS: tuple[str, ...] = ("node", "new", "a", "b", "target", "under")

    def _rename_chain_intact(self, i: int, dests: set[str]) -> str:
        """Is the identity a rename produced still the one standing under
        those names? "" when it is, else why it cannot be shown. `i` is the
        rename event's index.

        The log is append-only and never pruned, so finding that event means
        every later one is retained: replay forward and see whether anything
        re-bound the name. A matching name is not the argument — rename A→B,
        delete B, hire a fresh B, and the new holder would inherit the old
        one's records — and no timestamp tolerance is used. An op that is
        neither known-binding nor known-keeping refuses, so a new op must be
        classified rather than assumed harmless."""
        for e in list(self.d.get("events") or [])[i + 1:]:
            d = e.get("detail") or {}
            if not isinstance(d, dict):
                continue
            named = {str(d.get(k)) for k in self._NODE_KEYS if d.get(k)}
            removed = d.get("removed")
            if isinstance(removed, list):
                named |= {str(x) for x in removed}
            hit = sorted(named & dests)
            if not hit:
                continue
            op = str(e.get("op") or "")
            if op in self._NAME_BINDING_OPS:
                return (f"{op!r} at {e.get('at')} re-bound {hit[0]!r} after the "
                        f"rename, so the node standing there now is not "
                        f"demonstrably the one that was renamed")
            if op not in self._NAME_KEEPING_OPS:
                return (f"{op!r} at {e.get('at')} names {hit[0]!r} and this "
                        f"ledger has not classified that op, so it cannot "
                        f"show the name stayed with the same node — refusing "
                        f"rather than assuming it did")
        return ""

    def _rekey_work_identity(self, renamed: dict[str, str],
                             only: list[WorkItem] | None = None
                             ) -> list[tuple[str, str]]:
        """Move CURRENT work-item ownership onto the new ids in `renamed`.

        `only` bounds it to particular items (the repair path) BY OBJECT, not
        by any id — so it keeps working through the docket's slug migration;
        None means every item (the rename path). Returns (item ref, field) per
        move so a caller can report exactly what it did. `rev`, `updated_at`,
        `docket_at` and `history` are deliberately untouched — this is an
        identity re-key, not a docket update."""
        moved: list[tuple[str, str]] = []
        for key in ("work_items", "work_items_archive"):
            for it in self.d.get(key) or []:
                if only is not None and not any(x is it for x in only):
                    continue
                wid = self._work_ref(it)
                for f in self.WORK_IDENTITY_FIELDS:
                    a = it.get(f)
                    if isinstance(a, dict) and a.get("node") in renamed:
                        a["node"] = renamed[str(a["node"])]
                        moved.append((wid, f))
                ps = it.get("participants")
                if isinstance(ps, list) and any(
                        isinstance(p, str) and p in renamed for p in ps):
                    it["participants"] = [
                        renamed[p] if isinstance(p, str) and p in renamed else p
                        for p in ps]
                    moved.append((wid, "participants"))
        return moved

    def _work_identity_holders(self, it: WorkItem, old: str) -> list[str]:
        """Which CURRENT-identity fields on this item still name `old` (or one
        of its lineage generations)."""
        def _is_old(v: Any) -> bool:
            return isinstance(v, str) and (v == old or v.startswith(old + "@"))
        found = [f for f in self.WORK_IDENTITY_FIELDS
                 if isinstance(it.get(f), dict) and _is_old(it[f].get("node"))]
        if any(_is_old(p) for p in (it.get("participants") or [])):
            found.append("participants")
        return found

    def repair_rename_identity(self, actor: str, rename_at: str,
                               documents: list[str] | None = None,
                               work_items: list[str] | None = None
                               ) -> dict[str, Any]:
        """Finish a rename for records a rename before the re-key stranded.

        AUTHORITY — the user, or the renamed identity itself, and nobody else.
        An item owned by a name that no longer exists cannot go through
        `work_assign`: `_work_can_manage` refuses for exactly the reason being
        repaired.

        BOUND — not a node-rekey facility. The old and new ids are read out of
        ONE logged `rename` event named by its exact `at`; there are no
        old/new arguments. The records come from an explicit allowlist, each
        must still hold the old id, and the identity chain from that rename to
        the node standing under the new name must be intact
        (`_rename_chain_intact`).

        ATOMICITY — validate all, then mutate (§4.7). Every write is computed
        during validation and applied afterwards, so nothing below the
        validation can raise and a refused call writes nothing at all.

        CURRENT vs HISTORY — moves `documents[].node` and the current-identity
        work fields (`owner`, `last_updater`, `participants`). Leaves every
        authored-history field, `rev`, `updated_at`, `docket_at`, the event
        log, and mail bodies and senders. No docket history entry is added:
        that would mean inventing an actor. The org log carries one
        `rename_repair` line instead."""
        want_docs = [str(x) for x in (documents or [])]
        want_work = [str(x) for x in (work_items or [])]
        if not want_docs and not want_work:
            raise LedgerError(
                "name the records to repair — this operation takes an explicit "
                "allowlist of documents and work items, never a pattern")
        # A repeated reference passes validation twice (the same record read
        # twice) and would then reach the mutate phase twice, so it is refused
        # here rather than left to the write.
        for label, want in (("document", want_docs), ("work item", want_work)):
            dupes = sorted({x for x in want if want.count(x) > 1})
            if dupes:
                raise LedgerError(
                    f"the same {label} is named more than once in the "
                    f"allowlist: {dupes}. Name each record once")

        at = str(rename_at or "").strip()
        hits = [(i, e) for i, e in enumerate(self.d.get("events") or [])
                if e.get("op") == "rename" and e.get("at") == at]
        if len(hits) != 1:
            raise LedgerError(
                f"expected exactly one logged rename at {at!r}; found "
                f"{len(hits)}. This operation only completes a rename the "
                f"event log actually records")
        at_index, detail = hits[0][0], hits[0][1].get("detail") or {}
        old, new = str(detail.get("node") or ""), str(detail.get("new") or "")
        if not old or not new:
            raise LedgerError(f"the rename event at {at!r} names no node")
        if actor != USER and actor != new:
            raise LedgerError(
                f"only the user or {new!r} itself may repair the records that "
                f"rename left behind")
        n = self.nodes.get(new)
        if n is None or n.get("state") != "live":
            raise LedgerError(f"{new!r} is not a live node in this org")
        if old in self.nodes or any(k.startswith(old + "@") for k in self.nodes):
            raise LedgerError(
                f"{old!r} still exists in this org — these records are not "
                f"orphaned by that rename, and moving them would take records "
                f"away from a node that is still there")
        # a node cannot predate itself: one created after its own rename is a
        # different node wearing the name. An ordering between two recorded
        # stamps, not a tolerance — nothing here treats "close in time" as
        # identity.
        created = str(n.get("created") or "")
        if not created:
            raise LedgerError(
                f"{new!r} records no creation time, so this ledger cannot show "
                f"it is the node that was renamed. Refusing")
        if created > at:
            raise LedgerError(
                f"{new!r} was created at {created}, after the rename at {at} — "
                f"it is a different node standing under that name")

        # ---- validate every named record BEFORE touching one of them
        docs_by_id = {str(d.get("id")): d for d in self.d.get("documents") or []}
        renamed: dict[str, str] = {}

        def _map(v: str) -> None:
            """`old@g -> new@g`, exactly as rename builds its own map."""
            if v == old or v.startswith(old + "@"):
                renamed[v] = new + v[len(old):]

        # every write is computed HERE, against the values as they are now, and
        # applied only after the last check — so the mutate phase never reads a
        # value an earlier write changed
        doc_writes: list[tuple[dict[str, Any], str]] = []
        for did in want_docs:
            d = docs_by_id.get(did)
            if d is None:
                raise LedgerError(f"no document {did!r} in this org")
            node = str(d.get("node") or "")
            if not (node == old or node.startswith(old + "@")):
                raise LedgerError(
                    f"document {did!r} is owned by {node!r}, not {old!r} — "
                    f"refusing the whole repair rather than guessing")
            _map(node)
            doc_writes.append((d, renamed[node]))

        # items are named by slug — the docket's sole identity (user ruling
        # 2026-09-05)
        targets: list[WorkItem] = []
        fields: dict[str, list[str]] = {}
        for wid in want_work:
            try:
                it, _arch = self._work_find(wid)
            except LedgerError:
                raise LedgerError(f"no work item {wid!r} in this org") from None
            if any(x is it for x in targets):
                raise LedgerError(
                    f"{wid!r} names a work item already in the allowlist. "
                    f"Name each record once")
            ref = self._work_ref(it)
            if not ref:
                raise LedgerError(
                    f"work item {wid!r} has no slug, and the docket is "
                    f"identified by slug — write to the item first, then "
                    f"repair it by name")
            targets.append(it)
            held = self._work_identity_holders(it, old)
            if not held:
                raise LedgerError(
                    f"work item {ref!r} holds no current-identity field naming "
                    f"{old!r} — it is already repaired, or it was never "
                    f"affected. Refusing the whole repair")
            fields[ref] = held
            for f in self.WORK_IDENTITY_FIELDS:
                a = it.get(f)
                if isinstance(a, dict) and isinstance(a.get("node"), str):
                    _map(str(a["node"]))
            for p in it.get("participants") or []:
                if isinstance(p, str):
                    _map(p)

        # the last check, and the one a matching name cannot stand in for: is
        # the node under the destination still the identity that rename made?
        why = self._rename_chain_intact(at_index, set(renamed.values()))
        if why:
            raise LedgerError(f"the identity chain from that rename is broken: "
                              f"{why}")

        # ---- mutate (nothing below may raise)
        for d, node_now in doc_writes:
            d["node"] = node_now
        moved = self._rekey_work_identity(renamed, only=targets)
        warnings = [
            f"repaired {len(want_docs)} document(s) and {len(moved)} work-item "
            f"field(s) from {old!r} to {new!r}. Authored history is unchanged: "
            f"created_by, history, evidence, delivery claims, the event log, "
            f"mail bodies and sender fields still say {old!r}, and no item's "
            f"rev, updated_at, docket_at or status_at moved."]
        self._log("rename_repair", actor,
                  {"at": at, "node": old, "new": new,
                   "documents": want_docs,
                   "work_items": [f"{w}.{f}" for w, f in moved]}, warnings)
        return {"old": old, "new": new, "rename_at": at,
                "documents": want_docs,
                "work_items": [{"item": w, "field": f} for w, f in moved],
                "planned_fields": fields, "warnings": warnings}

    def credit_headroom(self, nid: str) -> tuple[int | None, str]:
        """How many MORE credits this node could be granted, and which cap
        binds. None = unbounded (no cap set). Top-level: max_top_grant and the
        kiosk pool. Deep node (a user-audience holder, ruling 2026-08-04):
        credits arrive by user-actor cascade, so headroom = what is FREE along
        its superior chain, plus how far the top-level ancestor could still
        grow (cap slack, bounded by the kiosk pool) — or just the parent's own
        free when allocation bubbling is off. Conservative on purpose: the
        outright refusal fires only on provably-zero; approve validates for
        real."""
        n = self.node(nid)
        cap = int(self.d.get("max_top_grant") or 0)
        kc = (self.d.get("kiosk") or {}).get("credits")
        pool: int | None = None
        # ⚠ FLOOR/CEIL, NOT int(). Headroom is answered in WHOLE credits (a
        # request is for a whole number) but its inputs may now be fractional,
        # and int() truncates toward zero — which rounds a holding DOWN and so
        # reports more room than exists. Every rounding here goes the
        # conservative way, matching the docstring's "provably-zero only".
        if kc is not None:
            holds = _q(sum(self.seat_cost(k) + self.nodes[k]["grant"]
                           for k in self.children(None)))
            pool = int(kc) - math.ceil(holds)
        if n["parent"] is None:
            rooms: list[tuple[int, str]] = []
            if cap:
                rooms.append((cap - math.ceil(n["grant"]),
                              f"your grant {n['grant']:g} is at the org's "
                              f"top-level cap of {cap}"))
            if pool is not None:
                rooms.append((pool, f"the kiosk credit pool ({kc:g}) is fully held"))
            if not rooms:
                return None, ""
            return min(rooms, key=lambda r: r[0])
        if not bool(self.d.get("cascade_alloc", True)):
            room = math.floor(self.free(n["parent"]))
            return room, (f'your superior "{n["parent"]}" has no free credits '
                          f"(allocation bubbling is off)")
        chain: list[str] = []
        cur: str | None = n["parent"]
        while cur is not None:
            chain.append(cur)
            cur = self.node(cur)["parent"]
        free_sum = sum(math.floor(self.free(a) or 0) for a in chain)
        slack = [s for s in ((cap - math.ceil(self.node(chain[-1])["grant"])) if cap else None,
                             pool) if s is not None]
        if not slack:
            return None, ""
        return free_sum + max(0, min(slack)), (
            "nothing is free along your superior chain and the org has no "
            "growth headroom (top-level cap / kiosk pool exhausted)")

    def credit_request_action(self, rid: str, action: str,
                              granted: int | None = None) -> dict[str, Any]:
        """Approve, counter-offer, or deny. `granted` (F-05, user-ruled): the
        user may set ANY legal amount — below the ask, above it, or below the
        node's current grant down to its committed floor (a clawback of unused
        credits; reallocate's own invariant is the floor). The outcome notice
        states what was asked, what was given, and that the agent may come
        back — the matter is the agent's to continue, not closed (ruling ③)."""
        req = next((r for r in self.d.get("credit_requests", [])
                    if r["id"] == rid), None)
        if req is None or req["status"] != "pending":
            raise LedgerError(f"no pending credit request {rid!r}")
        if action not in ("approve", "deny"):
            raise LedgerError("action must be approve|deny")
        nid = req["node"]
        old = req["old"]
        if action == "approve":
            if nid not in self.nodes or self.node(nid)["state"] != "live":
                # the card clears rather than raising: an approval that can't
                # apply must not leave the request pending forever (review —
                # approve was the one action that couldn't dismiss it)
                req["status"] = "moot"
                req["note"] = f"{nid} is no longer live — dropped as moot"
                self._log("credit_moot", USER, {"node": nid}, [])
                return req
            # CEIL, not int() — the same swallow as `request_credits`: a
            # counter-offer of 20.5 granted 20 and the card then reported
            # "granted 20" as though that were the answer given.
            give = math.ceil(_q(float(
                granted if granted is not None else req["new"])))
            delta = give - self.node(nid)["grant"]
            warnings: list[str] = []
            if delta != 0:
                # reallocate enforces both ends: +Δ checks max_top_grant,
                # −Δ refuses past free (the committed floor) and names what
                # a reduction strands
                warnings = self.reallocate(USER, nid, delta).get("warnings", [])
            req["status"] = "answered"
            req["granted"] = give
            now_g = self.node(nid)["grant"]
            # typed (family answer_decision): decision.credit — the outcome is a
            # literal, the amounts are the facts, the notice is its rendering
            # (test_events_producers §A). `ev` rides the RESULT, not the record.
            outcome = ("approved" if give == req["new"] else
                       "counter" if give > old else
                       "declined" if give == old else "reduced")
            ev = _mint("decision.credit", actor_of(USER), self._credit_ref(req),
                       outcome=outcome, old=float(old), asked=float(req["new"]),
                       granted=float(give), now=float(now_g))
            req["notice"] = events.render_agent(ev)
            self._log("credit_answer", USER,
                      {"node": nid, "asked": req["new"], "granted": give},
                      warnings)
            return {**req, "warnings": warnings, "ev": ev}
        req["status"] = "denied"
        ev = None
        if nid in self.nodes:
            ev = _mint("decision.credit", actor_of(USER), self._credit_ref(req),
                       outcome="denied", old=float(old), asked=float(req["new"]),
                       granted=None, now=None)
            req["notice"] = events.render_agent(ev)
        self._log("credit_deny", USER, {"node": nid, "new": req["new"]}, [])
        return {**req, "ev": ev} if ev is not None else req

    def _credit_ref(self, req: Mapping[str, Any]) -> dict[str, Any]:
        return {"kind": "credit_request", "org": str(self.d.get("slug") or ""),
                "id": str(req["id"]), "node": str(req["node"])}

    def credit_preview(self, rid: str, granted: int) -> dict[str, Any]:
        """F-05 dry run: the warnings a `granted` amount WOULD raise, before
        the user commits. Refusals (not enough free, past the top-level cap)
        still surface here; the archived-rehire stranding notice does not —
        user ruling 2026-09-03, it's a consequence of the reduction, not a
        reason to block or interrupt it."""
        req = next((r for r in self.d.get("credit_requests", [])
                    if r["id"] == rid), None)
        if req is None or req["status"] != "pending":
            raise LedgerError(f"no pending credit request {rid!r}")
        nid = req["node"]
        if nid not in self.nodes or self.node(nid)["state"] != "live":
            return {"ok": False, "warnings": [f"{nid} is no longer live"]}
        n = self.node(nid)
        # CEIL, matching `credit_request_action` exactly — a preview that
        # judged a different number from the one approval writes is worse than
        # no preview: it would answer "ok" for 20.5 against a cap of 20 and
        # then the approval would write 21.
        give = math.ceil(_q(float(granted)))
        delta = give - n["grant"]
        warnings: list[str] = []
        if delta > 0 and n["parent"] is None:
            cap = int(self.d.get("max_top_grant") or 0)
            if cap and give > cap:
                return {"ok": False,
                        "warnings": [f"{give:g} is past the top-level grant "
                                     f"cap of {cap}"]}
        if delta < 0:
            if self.free(nid) < -delta:
                return {"ok": False,
                        "warnings": [f"{nid} has only {self.free(nid):g} "
                                     f"unused; the rest is committed"]}
        return {"ok": True, "warnings": warnings}

    # ---------------------------------------------------- F-04: asking the user
    @staticmethod
    def _recover_leaked_ask(question: str, options: list[Any] | None
                             ) -> tuple[str, list[Any] | None]:
        """Defend `question`/`options` against arriving already corrupted by
        a caller's OWN malformed tool call (measured 2026-08-30: two asks
        from the same agent stored `question` text ending in
        `</question>\\n<parameter name="options">[{...}]` with `options`
        never arriving as a real argument — the raw options JSON had been
        swallowed into the question string, upstream of us, before this
        call ever ran). Nothing downstream of ask_user sanitizes this: a
        card renders whatever string it is given.

        If we can find and cleanly parse the embedded options JSON, recover
        the real question/options rather than storing the leak. If we can
        see the leak but cannot safely parse it, raise LedgerError — a loud
        refusal the caller sees and can retry, never a silently mangled
        card. `options` arriving structured is untouched either way."""
        m = _LEAKED_ASK_RE.search(question)
        if m is None:
            if options is None and _SUSPICIOUS_ASK_MARKUP_RE.search(question):
                raise LedgerError(
                    "this question's text contains what looks like a "
                    "leaked tool-call fragment (e.g. '</question>' or "
                    "'<parameter name=\"...\">') rather than a clean "
                    "question — your call arrived malformed. Refusing "
                    "rather than showing the user a garbled card: retry "
                    "the ask (a shorter question and shorter option "
                    "descriptions are less likely to trip whatever "
                    "mis-serialized it).")
            return question, options
        head = question[:m.start()].strip()
        tail = question[m.end():].strip()
        if not head:
            raise LedgerError(
                "this question's text is entirely a leaked tool-call "
                "fragment with no real question left once it is stripped "
                "— refusing rather than showing the user a garbled card. "
                "Retry the ask.")
        try:
            recovered, _ = json.JSONDecoder().raw_decode(tail)
        except (json.JSONDecodeError, ValueError) as e:
            raise LedgerError(
                "this question's text contains a leaked tool-call "
                f"fragment ('<parameter name=\"options\">...') but the "
                f"embedded options payload does not parse as JSON ({e}) "
                "— refusing rather than showing the user a garbled card. "
                "Retry the ask.") from e
        if not isinstance(recovered, list) or not recovered:
            raise LedgerError(
                "this question's text contains a leaked tool-call "
                "fragment but the recovered 'options' payload is not a "
                "non-empty list — refusing rather than showing the user "
                "a garbled card. Retry the ask.")
        return head, cast("list[Any]", recovered)

    @staticmethod
    def _norm_options(options: list[Any] | None) -> list[dict[str, str]]:
        """Options mirror AskUserQuestion's shape (user ruling 2026-08-04):
        {label, description?}. Plain strings are accepted and become bare
        labels, so older callers keep working."""
        out: list[dict[str, str]] = []
        for o in (options or [])[:4]:
            if isinstance(o, dict):
                od = cast("dict[str, Any]", o)
                lab = str(od.get("label") or "").strip()
                if not lab:
                    continue
                d = str(od.get("description") or "").strip()
                out.append({"label": lab[:60], **({"description": d[:300]} if d else {})})
            else:
                s = str(o).strip()
                if s:
                    out.append({"label": s[:60]})
        return out

    def _norm_question_batch(self, question: str, options: list[Any] | None,
                             multi: bool, header: str | None,
                             questions: list[Any] | None,
                             work_item: str | None = None
                             ) -> list[dict[str, Any]]:
        """FR-04: both ask forms normalize to ONE batch shape — a list of 1–4
        `{question, options?, multi?, header?}` entries. The single form is a
        1-entry batch; the batch form validates every entry (each needs its
        own question text; options/multi are per question, not per card)."""
        if questions is not None:
            if not isinstance(questions, list) or not questions:   # pyright: ignore[reportUnnecessaryIsInstance]  # arrives as Any off the wire
                raise LedgerError("questions must be a non-empty list of "
                                  "question objects (1–4)")
            if len(questions) > 4:
                raise LedgerError("a batch carries at most 4 questions — "
                                  "split the rest into a follow-up ask")
            batch: list[dict[str, Any]] = []
            for i, qd_any in enumerate(questions):
                if not isinstance(qd_any, dict):
                    raise LedgerError(f"questions[{i}] must be an object with "
                                      f"question text")
                qd = cast("dict[str, Any]", qd_any)
                qt = str(qd.get("question") or "").strip()
                if not qt:
                    raise LedgerError(f"questions[{i}] needs question text")
                qt, qd_options = self._recover_leaked_ask(
                    qt, cast("list[Any] | None", qd.get("options")))
                e: dict[str, Any] = {"question": qt}
                o = self._norm_options(qd_options)
                if o:
                    e["options"] = o
                if qd.get("multi"):
                    e["multi"] = True
                h = str(qd.get("header") or "").strip()[:24]
                if h:
                    e["header"] = h
                # docket linkage is PER TAB: one batch may ask about two items
                w = str(qd.get("work_item") or work_item or "").strip()
                if w:
                    e["work_item"] = w
                batch.append(e)
            return batch
        q = str(question or "").strip()
        if not q:
            raise LedgerError("a question is required")
        q, options = self._recover_leaked_ask(q, options)
        opts = self._norm_options(options)
        hdr = str(header or "").strip()[:24]
        w = str(work_item or "").strip()
        return [{"question": q,
                 **({"options": opts} if opts else {}),
                 **({"multi": True} if multi else {}),
                 **({"header": hdr} if hdr else {}),
                 **({"work_item": w} if w else {})}]

    def ask_user(self, nid: str, question: str = "",
                 options: list[Any] | None = None,
                 multi: bool = False, header: str | None = None,
                 questions: list[Any] | None = None,
                 work_item: str | None = None) -> dict[str, Any]:
        """A structured question to the user (F-04, user-ruled 2026-08-04):
        ALWAYS parks — no blocking wait. The question becomes an interactive
        card on the agent's desk AND in the user's inbox; the answer arrives
        as ordinary user mail. Gate = the user-mail gate (top-level or a held
        user audience); anyone else has the question ROUTED to their superior
        as mail instead of refused (the auto-bridge motto).

        Lifetime (user ruling 2026-08-06, RETIRES the 2026-08-04 wake-void):
        a request is invalidated ONLY manually — the user answers/dismisses
        it, the agent withdraws it (withdraw_ask), or the agent poses a NEW
        request, which replaces the old one. Other mail waking the agent
        leaves the card standing. One ACTIVE request per agent across both
        kinds: posing a question supersedes a pending credit request too.

        FR-04 (2026-08-05): `questions` batches 1–4 questions into ONE card
        (a tab strip in the UI). A batch is a single ask entry — one active
        request per node still holds, an amend replaces the whole batch, and
        every tab's answer travels in one user mail."""
        self._require_live(nid)
        if self.d.get("headless"):
            # §9.6 ②: never park a card nobody will answer
            raise LedgerError(
                "this org runs HEADLESS: no user is present and questions to "
                "the user are auto-denied. Decide autonomously within your "
                "charter, ask a peer/superior with orgtree_message "
                "kind=question, or record the blocker with "
                "orgtree_status(blocked, …)")
        batch = self._norm_question_batch(question, options, multi, header,
                                          questions, work_item)
        # DOCKET LINKAGE (docket-final-spec.md): a tab may attach to a work
        # item the asker may READ (owner / creator / their superiors / a
        # listed participant). Checked before anything records, and the
        # linkage is the ask store's own field - the item never holds a
        # question list, so a resolved, withdrawn or mooted request stops
        # counting the moment the ask store says so.
        for qd in batch:
            if qd.get("work_item"):
                qd["work_item"] = self.work_attach_check(nid, str(qd["work_item"]))
        # the entry mirrors batch[0] at top level (the single-question shape
        # every existing surface reads) AND carries the full batch
        first = batch[0]
        n = self.node(nid)
        if n["parent"] is not None and not self._has_audience(nid, USER):
            sup = n["parent"]
            # typed (family answer_decision): ask.routed — the tabs as data (the
            # docket linkage rides the text so the superior can find the item;
            # the renderer prints it exactly as this used to); object = the asker
            routed = [{"header": (str(qd["header"]) if qd.get("header") else None),
                       "text": str(qd.get("question")),
                       "work_item": (str(qd["work_item"]) if qd.get("work_item") else None),
                       "options": [str(x["label"]) for x in
                                   cast("list[dict[str, Any]]", qd.get("options") or [])],
                       "multi": bool(qd.get("multi"))} for qd in batch]
            r = self.post_mail(nid, sup, "", kind="question",
                               ev=_mint("ask.routed", actor_of(nid), self.node_ref(nid),
                                        from_node=nid, questions=routed))
            return {"routed": sup, "deferred": bool(r.get("deferred")),
                    "status": f"you hold no user audience — the question was "
                              f"mailed to your superior \"{sup}\"; their "
                              f"answer arrives as mail"}
        asks = self.d.setdefault("asks", [])
        # FR-14 (user ruling 2026-08-12): a new ask APPENDS to the open batch.
        # It no longer evicts a pending credit request — the agent's batch is
        # the UNION of every open request kind, finished only by the user's
        # submit or the agent's explicit withdraw — and it no longer replaces
        # the earlier questions. A tab with the SAME question text is replaced
        # in place (re-asking with sharper options amends that one tab);
        # everything else joins the card.
        entry = next((a for a in asks
                      if a["node"] == nid and a["status"] == "open"), None)
        if entry is not None:
            merged = [dict(x) for x in
                      cast("list[dict[str, Any]]", entry.get("questions")
                           or [])]
            for qd in batch:
                i = next((j for j, x in enumerate(merged)
                          if x["question"] == qd["question"]), None)
                if i is None:
                    merged.append(qd)
                else:
                    merged[i] = qd
            if len(merged) > 8:
                raise LedgerError(
                    f"your open batch would grow to {len(merged)} questions "
                    f"(cap 8) — withdraw it (orgtree_withdraw_ask) and ask "
                    f"only what still matters, or wait for the user's submit")
            first0 = merged[0]
            entry["questions"] = merged
            entry["work_items"] = sorted({str(x["work_item"]) for x in merged
                                          if x.get("work_item")})
            entry["question"] = first0["question"]
            for k in ("options", "multi", "header"):
                if first0.get(k):
                    entry[k] = first0[k]
                else:
                    entry.pop(k, None)
            # redteam (2026-08-05): answers are POSITIONAL, so an answer
            # composed against the card as it rendered BEFORE this append
            # must not silently attach to shifted tabs — the rev is the
            # compare-and-swap stamp the batch resolve requires
            entry["rev"] = int(entry.get("rev") or 1) + 1
            self._log("ask", nid, {"id": entry["id"],
                                   "appended": len(batch)}, [])
            return {"asked": entry["id"],
                    "status": f"parked (appended to your open batch — it now "
                              f"carries {len(merged)} question(s), resolved "
                              f"together at the user's one submit) — do NOT "
                              f"wait for it in this turn"}
        mirror: dict[str, Any] = {
            "question": first["question"], "questions": batch, "at": now(),
            **({"options": first["options"]} if first.get("options") else {}),
            **({"multi": True} if first.get("multi") else {}),
            **({"header": first["header"]} if first.get("header") else {})}
        aid = "q" + uuid.uuid4().hex[:8]
        asks.append({"id": aid, "node": nid, "kind": "question", **mirror,
                     "work_items": sorted({str(x["work_item"]) for x in batch
                                           if x.get("work_item")}),
                     "rev": 1, "status": "open"})
        self._prune_asks()
        self._log("ask", nid, {"id": aid}, [])
        return {"asked": aid,
                "status": "parked — the question is on the user's screen; the "
                          "answer will arrive as mail. Do NOT wait for it in "
                          "this turn: wrap up and end the turn. The question "
                          "STAYS OPEN across turns (other mail waking you does "
                          "not void it) until the user answers or dismisses "
                          "it, you withdraw it (orgtree_withdraw_ask), or you "
                          "pose a new request."}

    DOC_BODY_MAX = 65536          # FR-03: a plan, not a data dump

    def present_gate(self, nid: str, title: str) -> str:
        """The refusals that do not depend on the document itself — live
        node, headless org, direct user audience, a title — returning the
        clipped title. Split out (2026-09-06) so present-by-path can run
        them BEFORE snapshotting a file into outbox/: a refused present must
        leave no residue. present_document calls it first, so the two paths
        cannot drift apart."""
        self._require_live(nid)
        if self.d.get("headless"):
            raise LedgerError(
                "this org runs HEADLESS: no user is present and there is no "
                "screen to put a document card on. Hand the file over with "
                "orgtree_send_file (a durable download the user collects "
                "later), or record what you produced with orgtree_status")
        n = self.node(nid)
        if n["parent"] is not None and not self._has_audience(nid, USER):
            raise LedgerError(
                "presenting a document needs a DIRECT user audience — you "
                "are neither top-level nor hold a user-audience grant, and "
                "unlike a question a document is not routed for you (user "
                "ruling 2026-08-05). Send it to your superior with "
                "orgtree_message and let them present it, or ask them to "
                "grant you a user audience")
        t = str(title or "").strip()[:120]
        if not t:
            raise LedgerError("a title is required")
        return t

    def present_document(self, nid: str, title: str, body: str,
                         replaces: str | None = None, *,
                         html_file: str | None = None,
                         html_bytes: int = 0) -> dict[str, Any]:
        """FR-03 (user request 2026-08-05): present a DOCUMENT to the user —
        a reading surface, not a download. A small card pops out beside the
        agent's node; clicking it opens the markdown in-page. Non-blocking
        (the present parks like an ask but nothing voids it — a document is
        a standing artifact, not a pending question). `replaces` updates an
        earlier presentation in place instead of stacking a second card.

        HTML mockups (present-html-mockups-in-a-new-browser-tab, 2026-09-06):
        `html_file` names a snapshot the API layer already copied into the
        node's outbox/ (`outbox/mock.html`, the orgtree_send_file rule —
        containment, copy-not-reference, name dedupe all happen THERE; this
        method records, it does not touch disk). The record then carries
        `format: "html"`, `file` and `bytes` and an EMPTY body, so the
        markdown reader never renders HTML as markdown and the tree payload
        stays metadata-only. The bytes are served by the mockup wrapper route
        (api.document_mockup), never inline. `replaces` may switch a card
        between the two formats; the stale format keys are dropped so a
        record is never half of each.

        Gate (user ruling 2026-08-05, D-100): presentation needs a DIRECT
        user audience — top-level or a held user-audience grant. Unlike
        ask_user there is NO auto-bridge: everyone else is refused. A
        document card is a standing claim on the user's screen, so the
        chain of command applies to it harder than to a question, not
        softer. Headless orgs refuse for ask_user's reason (§9.6 ②): the
        reader IS the UI, and there is no screen to put the card on."""
        t = self.present_gate(nid, title)
        b = str(body or "")
        if html_file:
            if b.strip():
                raise LedgerError("an HTML mockup takes `path` OR `body`, "
                                  "not both")
            if not str(html_file).startswith("outbox/") \
                    or not isinstance(html_bytes, int) or html_bytes <= 0:
                # the API layer's contract, not an agent-reachable message:
                # the snapshot must already sit in outbox/ and be non-empty
                raise LedgerError("html_file must be an outbox/ snapshot "
                                  "with a positive byte count")
            fields: dict[str, Any] = {"title": t, "body": "", "at": now(),
                                      "format": "html",
                                      "file": str(html_file),
                                      "bytes": int(html_bytes)}
        else:
            if not b.strip():
                raise LedgerError("the document body is empty")
            if len(b) > self.DOC_BODY_MAX:
                raise LedgerError(
                    f"the document is {len(b)} bytes — over the 64 KB reading "
                    f"cap. Trim it, split it into parts, or hand the full "
                    f"file over with orgtree_send_file instead")
            fields = {"title": t, "body": b, "at": now()}
        docs = self.d.setdefault("documents", [])
        if replaces:
            old = next((x for x in docs
                        if x["id"] == replaces and x["node"] == nid), None)
            if old is not None:
                for k in ("format", "file", "bytes"):
                    old.pop(k, None)          # never half markdown, half html
                old.update(fields)
                self._log("present", nid, {"id": replaces, "replaced": True,
                                           **({"format": "html"}
                                              if html_file else {})}, [])
                return {"presented": replaces,
                        **({"format": "html"} if html_file else {}),
                        "status": ("updated in place — reopen the card or refresh "
                                   "an open mockup tab to see this revision"
                                   if html_file else
                                   "updated in place — the card and any open "
                                   "reader now show this revision")}
            # a dangling replaces falls through to a fresh card rather than
            # erroring: the user may have dismissed the original meanwhile
        did = "d" + uuid.uuid4().hex[:8]
        docs.append({"id": did, "node": nid, **fields})
        # v2 retains documents until the user dismisses them.
        self._log("present", nid, {"id": did, "title": t[:60],
                                   **({"format": "html"} if html_file else {})},
                  [])
        return {"presented": did,
                **({"format": "html"} if html_file else {}),
                "status": ("the mockup is on the user's screen as a card "
                           "beside your desk; clicking it opens the page in "
                           "a new browser tab, sandboxed (no network, no "
                           "app access) — non-blocking, keep working. "
                           if html_file else
                           "the document is on the user's screen as a card "
                           "beside your desk — non-blocking, keep working. ")
                          + "Present again with replaces set to this id to "
                            "update it in place."}

    def dismiss_document(self, did: str) -> dict[str, Any]:
        """The card's ✕ — the user removes a presented document."""
        docs = self.d.get("documents", [])
        doc = next((x for x in docs if x["id"] == did), None)
        if doc is None:
            raise LedgerError(f"no document {did!r}")
        docs.remove(doc)
        self._log("present_dismissed", USER,
                  {"id": did, "node": doc["node"]}, [])
        return {"node": doc["node"], "title": doc["title"]}

    def document_gallery(self) -> list[dict[str, Any]]:
        """The org-wide presented-document list — a VIEW over `documents`, not
        a second store. The per-node tree walk (`node.documents`) silently
        drops a rehired predecessor's cards (`org_children` hides an archived
        node that has a `successor`) and anything whose node was `delete()`d;
        reading the flat list does not.

        Rows whose body the per-node/org-wide prune has evicted still appear,
        reconstructed from the `present_evicted` log line (id+title only) so a
        user hunting for a card they remember learns that it existed and is
        gone. Dismissed cards are omitted — the user removed those. Newest
        first. Metadata only; the reader still fetches the body by id.

        Retention is unlimited; API readers page metadata and the tree only
        carries the newest ten cards per node. Legacy eviction stubs remain
        visible because their already-removed bodies cannot be recovered."""
        docs = list(self.d.get("documents") or [])
        seen: set[str] = set()
        rows: list[dict[str, Any]] = []

        def _state(nid: str) -> str:
            n = self.nodes.get(nid)
            if n is None:
                return "deleted"
            st = n.get("state")
            return str(st) if st else "deleted"

        def _tier(nid: str) -> str | None:
            """the presenting agent's model, for the row's tier chip (user
            request 2026-09-03: "for each agent entry, show its model icon
            card"). Read from `nodes` for the same reason `node_state` is —
            the gallery lists cards from agents the tree walk does not carry
            (a rehired predecessor, a deleted node), so the client cannot
            look this up. None where there is no node left to ask.

            ⚠ the node's own key is `model`; `tier` is what the tree payload
            renames it to on the way out (see the node build below), and the
            frontend reads `tier` everywhere. Same rename here, so one chip
            component serves both payloads."""
            n = self.nodes.get(nid)
            return str(n["model"]) if n and n.get("model") else None

        for i, x in enumerate(docs):
            did = str(x.get("id") or "")
            if not did or did in seen:
                continue
            seen.add(did)
            nid = str(x.get("node") or "")
            row: dict[str, Any] = {
                "id": did, "node": nid, "title": x.get("title") or "",
                "at": x.get("at") or "", "evicted": False,
                "format": x.get("format") or "markdown",
                "node_state": _state(nid), "tier": _tier(nid), "_seq": i,
            }
            if x.get("format") == "html":
                row["bytes"] = int(x.get("bytes") or 0)
            rows.append(row)
        for i, e in enumerate(self.d.get("events") or []):
            if e.get("op") != "present_evicted":
                continue
            detail = e.get("detail") or {}
            did = str(detail.get("id") or "")
            if not did or did in seen:
                continue
            seen.add(did)
            nid = str(e.get("actor") or "")
            rows.append({
                "id": did, "node": nid,
                "title": str(detail.get("title") or ""),
                "at": e.get("at") or "", "evicted": True,
                "format": "html" if detail.get("format") == "html"
                else "markdown",
                "node_state": _state(nid), "tier": _tier(nid), "_seq": i,
            })
        # both source lists are append-only (oldest→newest); `at` is ms ISO
        # so two presents in the same loop tick still need `_seq` as the
        # within-list tiebreaker
        rows.sort(key=lambda r: (str(r.get("at") or ""), r["_seq"]), reverse=True)
        for r in rows:
            del r["_seq"]
        return rows

    def ask_dismiss(self, aid: str) -> dict[str, Any]:
        """The card's ✕ (mirrors AskUserQuestion's Esc/close): the user closes
        the question WITHOUT answering. Nulled grey as 'dismissed'; the agent
        is told and proceeds on its own judgment."""
        a = next((x for x in self.d.get("asks", []) if x["id"] == aid), None)
        if a is None:
            raise LedgerError(f"no ask {aid!r}")
        if a["status"] != "open":
            raise LedgerError(f"ask {aid} is already {a['status']}")
        a["status"] = "dismissed"
        a["reason"] = "dismissed by the user without an answer"
        a["resolved_at"] = now()
        self._log("ask_dismissed", USER, {"id": aid, "node": a["node"]}, [])
        # typed (family answer_decision): answer.ask with dismissed=True; the
        # caller posts `ev` and the body is its rendering (test_events_producers §A)
        qs = cast("list[dict[str, Any]]", a.get("questions") or [])
        ev = _mint("answer.ask", actor_of(USER), self._ask_ref(a),
                   questions=[{"label": (str(q.get("header")) if q.get("header") else None),
                               "question": str(q.get("question") or ""), "selected": []}
                              for q in qs] or [{"label": None, "question": str(a["question"]),
                                                "selected": []}],
                   text=None, dismissed=True, single=len(qs) <= 1)
        return {"node": a["node"], "body": events.render_agent(ev), "ev": ev}

    def _ask_ref(self, a: Mapping[str, Any]) -> dict[str, Any]:
        return {"kind": "ask", "org": str(self.d.get("slug") or ""),
                "id": str(a["id"]), "node": str(a["node"])}

    def ask_answer(self, aid: str, selected: list[Any] | None = None,
                   text: str | None = None,
                   rev: int | None = None) -> dict[str, Any]:
        """Mark a question answered and return the composed answer body — the
        caller delivers it as ordinary user mail (which is what drives the
        turn). Marking happens FIRST, under the same doc lock. (Historical:
        this ordering guarded the retired wake-void; it stays because an
        answered card must never render open while its mail is in flight.)

        `rev` is the compare-and-swap stamp (redteam 2026-08-05): answers are
        POSITIONAL, so an answer composed against the card as it rendered
        must not silently attach to questions an amend replaced meanwhile.
        The UI echoes the card's rev; a mismatch — or an unstamped answer to
        a card that HAS been amended — is refused so the caller re-reads."""
        a = next((x for x in self.d.get("asks", []) if x["id"] == aid), None)
        if a is None:
            raise LedgerError(f"no ask {aid!r}")
        if a["status"] != "open":
            raise LedgerError(
                f"ask {aid} is already {a['status']}"
                + (f" ({a.get('reason')})" if a.get("reason") else ""))
        cur = int(a.get("rev") or 1)
        if rev is not None and int(rev) != cur:
            raise LedgerError(
                f"the card changed after it rendered (answer against "
                f"revision {rev}, card at {cur}) — re-read the question and "
                f"answer what it shows now")
        if rev is None and cur > 1:
            raise LedgerError(
                "this card was AMENDED after it first rendered — re-read it "
                "and answer what it shows now")
        txt = str(text or "").strip()
        qs = cast("list[dict[str, Any]]", a.get("questions") or [])
        if len(qs) > 1:
            # FR-04 batch: `selected` carries ONE item per tab, positionally —
            # a string (the picked option or free text) or a list (a multi
            # tab's picks). The UI disables submit until every tab is
            # answered; this is the SERVER enforcement of the same rule, or a
            # batch answer arrives with holes and the agent cannot tell which
            # tab was skipped.
            per_tab: list[Any] = list(selected or [])
            if len(per_tab) > len(qs):
                # more answers than tabs was silently truncated (redteam) —
                # the mismatch in the other direction already errors, and a
                # caller that miscounted must hear about it either way
                raise LedgerError(
                    f"the answer carried {len(per_tab)} items for a "
                    f"{len(qs)}-question card — exactly one per tab")
            norm: list[str | list[str]] = []
            for item in per_tab[:len(qs)]:
                if isinstance(item, list):
                    norm.append([str(x).strip()
                                 for x in cast("list[Any]", item)
                                 if str(x).strip()])
                else:
                    norm.append(str(item or "").strip())
            if len(norm) != len(qs) or any(not v for v in norm):
                raise LedgerError(
                    f"every tab needs an answer — this card has {len(qs)} "
                    f"questions and the answer covered "
                    f"{sum(1 for v in norm if v)}")
            a["status"] = "answered"
            a["reason"] = "answered"
            flat = [x for v in norm
                    for x in (v if isinstance(v, list) else [v])]
            a["answer"] = {"selected": flat, **({"text": txt} if txt else {})}
            answered: list[dict[str, Any]] = []
            for qd, v in zip(qs, norm):
                qd["answer"] = v
                answered.append({
                    "label": (str(qd.get("header")) if qd.get("header") else None),
                    "question": str(qd["question"]),
                    "selected": list(v) if isinstance(v, list) else [v]})
            a["resolved_at"] = now()
            self._log("ask_answered", USER, {"id": aid, "node": a["node"]}, [])
            # typed (family answer_decision): answer.ask, one AnsweredQ per tab
            ev = _mint("answer.ask", actor_of(USER), self._ask_ref(a),
                       questions=answered, text=(txt or None), dismissed=False,
                       single=False)
            return {"node": a["node"], "body": events.render_agent(ev), "ev": ev}
        sel = [str(s).strip() for s in (selected or []) if str(s).strip()]
        if not sel and not txt:
            raise LedgerError("an answer needs selected options or text")
        a["status"] = "answered"
        a["reason"] = "answered"
        a["answer"] = {**({"selected": sel} if sel else {}),
                       **({"text": txt} if txt else {})}
        if qs:
            qs[0]["answer"] = sel if len(sel) > 1 else (sel[0] if sel else txt)
        a["resolved_at"] = now()
        self._log("ask_answered", USER, {"id": aid, "node": a["node"]}, [])
        ev = _mint("answer.ask", actor_of(USER), self._ask_ref(a),
                   questions=[{"label": (str(qs[0].get("header")) if qs and qs[0].get("header")
                                         else None),
                               "question": str(a["question"]), "selected": sel}],
                   text=(txt or None), dismissed=False, single=True)
        return {"node": a["node"], "body": events.render_agent(ev), "ev": ev}

    def _restart_authority(self, nid: str, what: str) -> None:
        """May `nid` decide that this machine restarts? Live, not a kiosk,
        and either top-level or holding a user audience.

        ⚠ ONE body for `self_restart_gate` and `prime_restart_gate`. Priming
        is the same decision as restarting — it IS a restart, merely deferred
        — so a second copy of the rule would be a second thing to disagree,
        and the way it would disagree is by being laxer: an agent refused the
        immediate tool could reach for the primed one and get the same
        machine-wide restart a few minutes later. Each caller still logs its
        OWN event, because "restarted the machine" and "armed a restart" are
        different facts about who did what."""
        if not deployment.current_policy().allow_agent_restart:
            raise LedgerError(
                "the frozen deployment profile disables agent-triggered "
                "self-update, self-restart, and primed restart; deploy this "
                "installation through an operator-controlled path")
        self._require_live(nid)
        if self.is_kiosk:
            raise LedgerError(f"kiosk orgs are sealed — no {what}")
        n = self.node(nid)
        if n["parent"] is not None and not self._has_audience(nid, USER):
            raise LedgerError(
                f"a {what} restarts the shared orgtree install for "
                "EVERY org on this machine — only top-level agents (or "
                "holders of a user audience) may trigger it; ask your "
                "superior to run it, or to grant you a user audience")

    def self_restart_gate(self, nid: str, force: bool = False,
                          reason: str | None = None) -> None:
        """FR-14 gate (user request 2026-08-06): a self-restart restarts the
        SHARED install — every org on this machine — so it takes the same
        gate as asking the user directly: top-level, or a held user
        audience. Kiosks are sealed outright. The launch itself lives in
        supervisor.launch_self_restart; this only authorizes and records.

        FR-31 (2026-09-04): `force` deploys THROUGH agents that are mid-turn,
        by stopping them. It takes the same AUTHORITY — the machine-wide
        consequence is the same restart — plus one thing the ordinary call
        does not need: a REASON, and this is the one place that can insist.
        A forced restart spends other agents' turns, and the only defence
        against it becoming a reflex is that it cannot be fired without
        saying why. The reason is what the record shows afterwards and what
        the interrupted agents' managers read when they ask what happened.
        ⚠ Do not soften this to a default string: a reason nobody had to
        write says nothing, and force would then be exactly as easy to reach
        as the safe call — which is the whole thing this feature must not
        be."""
        self.self_restart_checks(nid, force, reason)
        self._log("self_restart", nid,
                  {"force": True, "reason": (reason or "").strip()[:200]}
                  if force else {}, [])

    def self_restart_checks(self, nid: str, force: bool = False,
                            reason: str | None = None) -> None:
        """`self_restart_gate` minus the record — everything that can REFUSE.

        Split out because a forced restart has to be refused BEFORE it stops
        every agent on the machine, and that stopping must happen outside
        DOC_LOCK (see supervisor.force_quiesce_for_restart). api.agent_call
        therefore runs this as a pre-guard and `self_restart_gate` repeats it
        under the lock, exactly the shape retire/dissolve already use. One
        body, two entry points: a second copy of the rule would drift, and
        the way it would drift is by being laxer on the forced path."""
        if force and not (reason or "").strip():
            raise LedgerError(
                "a FORCED self-restart requires a `reason` — it stops every "
                "agent that is mid-turn on this machine, and that cost is "
                "recorded against you. Say why in one line, or drop `force` "
                "and wait for the machine to go idle (orgtree_prime_restart "
                "arms a deploy that fires by itself when it does).")
        self._restart_authority(nid,
                                "forced self-restart" if force
                                else "self-restart")

    def log_forced_restart(self, nid: str, cut: list[str],
                           not_settled: list[str], why: str | None = None,
                           woken: list[str] | None = None) -> None:
        """Record what a forced restart actually cut, once it is known.

        A SECOND event on purpose. `self_restart_gate` records the DECISION
        and runs before anyone is interrupted, so it cannot name a single
        victim; this one records the COST and runs after the quiesce, so it
        can. Collapsing them into one would mean either a decision recorded
        too late to be the authorization, or a cost recorded before it was
        paid. Nodes that had not settled ride the event's `warnings`, where
        the org's event view already surfaces them.

        FR-32: `why` and `woken` are the deadline escalation's half. An
        escalated deploy has no caller, so `why` is the only thing that says
        an unattended deadline did this rather than an agent — the
        coordinator's standard is that a reader a week later can tell the two
        apart without inferring it. `woken` names the agents the escalation
        armed a restart wake for; an empty list on an escalation is itself
        news (nobody will pick the work back up)."""
        self._log("self_restart_forced", nid,
                  {"cut": list(cut), "cut_count": len(cut),
                   **({"why": why[:200]} if why else {}),
                   **({"woken": list(woken), "escalated": True}
                      if woken is not None else {})},
                  [f'"{n}" was still mid-turn when the deploy launched — its '
                   f"turn may have been cut mid-write" for n in not_settled])

    def prime_restart_gate(self, nid: str, action: str,
                           target: str | None = None,
                           reason: str | None = None,
                           deadline_minutes: int | None = None) -> None:
        """FR-27 gate (user design 2026-08-27): arming a deferred restart
        takes the SAME authority as firing one now — the machine-wide
        consequence is identical, only its timing is chosen by the machine
        instead of the caller. Cancelling takes it too: disarming somebody
        else's primed deploy is an authority act, not a read.

        ⚠ The gate runs HERE, at the arm, and never again. The prime is
        deliberately spent by a background loop with no re-check, because the
        agent that armed it is expected to be gone by then — surviving its
        author is the entire feature (see supervisor._fire_prime).

        ⚠ FR-32 · A DEADLINE REQUIRES A REASON, and this is the same brake
        `self_restart_checks` puts on `force` rather than a second opinion
        about it. A deadline IS a scheduled force: the escalation stops every
        working agent on the machine. Without this, `prime_restart` with a
        short deadline would be a way to reach a forced deploy without ever
        saying why — a hole straight through the brake, in the one path where
        NOBODY IS PRESENT to be asked afterwards. And unlike force, the gate
        is the last moment anyone can be asked at all."""
        if action == "arm" and deadline_minutes is not None:
            if not (reason or "").strip():
                raise LedgerError(
                    "a primed restart with a DEADLINE requires a `reason` — "
                    "when the deadline expires it stops every agent that is "
                    "mid-turn on this machine, and nobody will be present to "
                    "explain why. This is the last moment you can. Drop "
                    "`deadline_minutes` for an ordinary prime that simply "
                    "waits for quiet.")
            # local import: `supervisor` imports THIS module, so a top-level
            # one is a cycle. Reading the bounds from where the engine
            # defines them is what stops the gate and the engine drifting
            # into two different ideas of a legal deadline.
            from . import supervisor as _sup       # noqa: PLC0415
            lo, hi = (_sup.PRIME_DEADLINE_MIN_MINUTES,
                      _sup.PRIME_DEADLINE_MAX_MINUTES)
            # ⚠ BOUNDS ONLY — there was an `isinstance(…, int)` here and
            # pyright proved it vacuous (the parameter is `int | None` and
            # the None is already gone). Whole-number-ness is enforced at the
            # door instead, by `api._arg_opt_int`, which is the only caller
            # that ever sees free-form input and REFUSES a non-number rather
            # than reading it as "no deadline". A check that cannot fail is
            # not a check; this one can, and does.
            #
            # ⚠ REFUSED, not clamped. A caller who asked for one minute and
            # silently got five has been lied to about when its machine will
            # be cut.
            if not lo <= deadline_minutes <= hi:
                raise LedgerError(
                    f"deadline_minutes must be a whole number between {lo} "
                    f"and {hi} (got {deadline_minutes!r}). Below {lo} the "
                    f"ordinary quiet path never gets a fair chance, so it "
                    f"would be `force` wearing a hat; above {hi} the deadline "
                    f"has stopped meaning 'this could not wait'.")
        self._restart_authority(nid, "primed restart")
        self._log("prime_restart_" + action, nid,
                  {k: v for k, v in (
                      ("target", target), ("reason", (reason or "").strip()[:200] or None),
                      ("deadline_minutes", deadline_minutes)) if v}, [])

    def _moot_asks(self, nid: str, why: str) -> None:
        """The asker leaving the org moots its active request (redteam gap
        2026-08-06 on the manual-only ruling: retirement removes the party
        who could withdraw, and a zombie card would invite the user to
        answer someone who cannot read the answer). NOT a wake-void revival
        — retire/dissolve is itself a manual act by the user or a superior,
        so this stays inside the ruling's only-by-hand rule."""
        for a in self.d.get("asks", []):
            if a["node"] == nid and a["status"] == "open":
                a["status"] = "moot"
                a["reason"] = why
                a["resolved_at"] = now()
                self._log("ask_moot", nid, {"id": a["id"]}, [])
        for r in self.d.get("credit_requests", []):
            if r["node"] == nid and r["status"] == "pending":
                r["status"] = "moot"
                r["reason"] = why
                r["resolved_at"] = now()
                self._log("credit_moot", nid, {"id": r["id"]}, [])
        for r in self.d.get("scope_requests", []):
            if r["node"] == nid and r["status"] == "pending":
                r["status"] = "moot"
                r["reason"] = why
                r["resolved_at"] = now()
                self._log("scope_moot", nid, {"id": r["id"]}, [])

    def withdraw_ask(self, nid: str) -> dict[str, Any]:
        """The agent withdraws its OWN active request (user ruling
        2026-08-06, which also RETIRED the 2026-08-04 wake-void: a request
        now dies only by the user's hand — answer, dismiss, deny — or the
        asking agent's own: this explicit withdraw, or posing a new request,
        which replaces it. A turn starting on other mail leaves the card
        standing). Covers both kinds; a benign no-op result when nothing is
        active, so an agent double-checking costs nothing."""
        self._require_live(nid)
        gone: list[str] = []
        for a in self.d.get("asks", []):
            if a["node"] == nid and a["status"] == "open":
                a["status"] = "withdrawn"
                a["reason"] = "withdrawn by the asking agent"
                a["resolved_at"] = now()
                gone.append(f"question {a['id']}")
        for r in self.d.get("credit_requests", []):
            if r["node"] == nid and r["status"] == "pending":
                r["status"] = "withdrawn"
                r["reason"] = "withdrawn by the asking agent"
                r["resolved_at"] = now()
                gone.append(f"credit request {r['id']}")
        for r in self.d.get("scope_requests", []):
            if r["node"] == nid and r["status"] == "pending":
                r["status"] = "withdrawn"
                r["reason"] = "withdrawn by the asking agent"
                r["resolved_at"] = now()
                gone.append(f"scope request {r['id']}")
        if gone:
            self._log("ask_withdrawn", nid, {"which": gone}, [])
            return {"withdrawn": gone,
                    "status": "withdrawn — the card on the user's screen is "
                              "nulled; no answer will arrive for it"}
        return {"status": "you have no active request to withdraw"}

    def _prune_asks(self) -> None:
        """Open asks are never pruned; resolved ones keep a short history."""
        asks = self.d.get("asks", [])
        resolved = [a for a in asks if a["status"] != "open"]
        for a in resolved[:-30]:
            asks.remove(a)

    def open_request(self, nid: str) -> dict[str, Any] | None:
        """This node's ACTIVE request — the open question or pending credit
        request — or None. Distinct from `node_ask`, which is the DESK CARD
        and deliberately includes recently-resolved ones inside a linger
        window: this answers "is the user still waiting on you", which is the
        question the identity prompt asks every turn (D-103)."""
        for a in self.d.get("asks", []):
            if a["node"] == nid and a.get("status") == "open":
                return {**a, "kind": "question"}
        for r in self.d.get("credit_requests", []):
            if r["node"] == nid and r.get("status") == "pending":
                return {**r, "kind": "credit"}
        for r in self.d.get("scope_requests", []):
            if r["node"] == nid and r.get("status") == "pending":
                return {**r, "kind": "scope"}
        return None

    def node_ask(self, nid: str) -> dict[str, Any] | None:
        """The card the UI should show on this node's desk: the open BATCH
        (FR-14: the union of the open question tabs, the pending credit
        request and the pending scope items, resolved together at one
        submit), or the most recently resolved single entry within its
        linger window (the nulled card carries WHY it nulled)."""
        ask = next((a for a in self.d.get("asks", [])
                    if a["node"] == nid and a["status"] == "open"), None)
        cr = next((r for r in self.d.get("credit_requests", [])
                   if r["node"] == nid and r["status"] == "pending"), None)
        sr = next((r for r in self.d.get("scope_requests", [])
                   if r["node"] == nid and r["status"] == "pending"), None)
        if ask or cr or sr:
            tabs: list[dict[str, Any]] = []
            revs: dict[str, int] = {}
            if ask is not None:
                revs["ask"] = int(ask.get("rev") or 1)
                for qd in cast("list[dict[str, Any]]",
                               ask.get("questions") or []):
                    tabs.append({"kind": "question", **qd})
            if cr is not None:
                revs["credits"] = int(cr.get("rev") or 1)
                tabs.append({"kind": "credits", "id": cr["id"],
                             "old": cr["old"], "new": cr["new"],
                             "reason": cr["reason"]})
            if sr is not None:
                revs["scope"] = int(sr.get("rev") or 1)
                for it in cast("list[dict[str, Any]]", sr["items"]):
                    tabs.append({"kind": "scope", "id": sr["id"],
                                 "item": it, "reason": sr["reason"],
                                 "label": self._scope_item_label(it)})
            base = cast("dict[str, Any]", ask or cr or sr)
            first = tabs[0]
            return {"id": str(base["id"]), "node": nid, "kind": "batch",
                    "status": "open",
                    "at": min(str(x["at"]) for x in (ask, cr, sr)
                              if x is not None),
                    "tabs": tabs, "revs": revs,
                    # legacy mirror: older surfaces title the card off these
                    "question": first.get("question")
                                or first.get("label")
                                or (f"credits {first.get('old')} → "
                                    f"{first.get('new')}"
                                    if first["kind"] == "credits" else ""),
                    **({"rev": revs["ask"]} if ask is not None else {})}
        # `withdrawn` stays hidden (the agent taking its own request back is
        # nothing for the user to read); `moot` RENDERS as a nulled card
        # (redteam 2026-08-06: retirement made mooting ordinary, and a card
        # that just vanishes tells the user less than one that says why)
        pool = ([a for a in self.d.get("asks", []) if a["node"] == nid]
                + [{**r, "kind": "credit"} for r in self.d.get("credit_requests", [])
                   if r["node"] == nid and r["status"] != "withdrawn"]
                + [{**r, "kind": "scope",
                    "question": "scope request: " + "; ".join(
                        self._scope_item_label(cast("dict[str, Any]", it))
                        for it in cast("list[Any]", r["items"]))}
                   for r in self.d.get("scope_requests", [])
                   if r["node"] == nid and r["status"] != "withdrawn"])
        if not pool:
            return None

        def stamp(a: dict[str, Any]) -> str:
            return str(a.get("resolved_at") or a["at"])
        best = max(pool, key=stamp)
        cutoff = (datetime.now(timezone.utc)
                  - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
        if (best.get("resolved_at") or best["at"]) < cutoff:
            return None
        return best

    def fable_filter_hit(self, nid: str, detail: str) -> str:
        """A Fable content filter flagged this node's message mid-turn (user
        spec). Per-node, per-incident — nothing org-wide locks. The org's
        `fable_filter_policy` decides:
          halt (default) — the turn stays failed; the node holds its seat;
              superior + the user are told and decide.
          opus — the node converts fable→opus (seat 10→5, one-way, same
              conversion as the limit policy) and the flagged turn retries.
          auto-autopsy — an autopsy agent is hired/inserted using the configured
              `fable_filter_model` (defaulting to opus, fable excluded), a
              replacement fable is hired under it, the failed agent is retired,
              and a diagnostic kickoff is sent to the autopsy agent.
              If the autopsy model is unavailable, falls back to halt.
        Returns the policy actually applied."""
        policy = self.d.get("fable_filter_policy", "halt")
        n = self.node(nid)

        # typed (family lifecycle): policy.fable_flagged, one event per audience
        # (parent / peers / the user's inbox); every text is the rendering
        def _fl(audience: str, outcome: str, *, autopsy: str | None = None,
                autopsy_model: str | None = None, replacement: str | None = None,
                reason: str | None = None) -> dict[str, Any]:
            return _mint("policy.fable_flagged", actor_of(SYSTEM), self.node_ref(nid),
                         audience=audience, node=nid, outcome=outcome, autopsy=autopsy,
                         autopsy_model=autopsy_model, replacement=replacement,
                         reason=reason, detail=str(detail))

        def _tell_user(ev: dict[str, Any]) -> None:
            self.to_user_inbox({
                "id": uuid.uuid4().hex[:8], "from": SYSTEM, "kind": "decision",
                "at": now(), "body": events.render_agent(ev)}, ev)

        if policy == "opus" and n["model"] == "fable":
            n["model"] = "opus"
            self._notify_ev([n["parent"]], _fl("parent", "switched"))
            self._notify_ev(self._peers_of(n["parent"], nid), _fl("peer", "switched"))
        elif policy == "auto-autopsy" and n["model"] == "fable":
            autopsy_model = self.d.get("fable_filter_model", "opus")
            from . import providers
            avail, reason = providers.tier_availability(autopsy_model)
            if not avail:
                self._notify_ev([n["parent"]],
                                _fl("parent", "autopsy_unavailable",
                                    autopsy_model=str(autopsy_model), reason=str(reason)))
                _tell_user(_fl("user", "autopsy_unavailable",
                               autopsy_model=str(autopsy_model), reason=str(reason)))
                self._log("fable_filter", SYSTEM,
                          {"node": nid, "policy": "halt",
                           "reason": f"model {autopsy_model} unavailable: {reason}"}, [])
                return "halt"

            applied_info = self._execute_auto_autopsy(nid, detail, autopsy_model)
            self._notify_ev([n["parent"]],
                            _fl("parent", "autopsy", autopsy=str(applied_info["autopsy_id"]),
                                autopsy_model=str(autopsy_model),
                                replacement=str(applied_info["rep_id"])))
            _tell_user(_fl("user", "autopsy", autopsy=str(applied_info["autopsy_id"]),
                           autopsy_model=str(autopsy_model),
                           replacement=str(applied_info["rep_id"])))
            self._log("fable_filter", SYSTEM,
                      {"node": nid, "policy": "auto-autopsy",
                       "autopsy_model": autopsy_model,
                       "autopsy_node": applied_info["autopsy_id"],
                       "replacement_node": applied_info["rep_id"]}, [])
            return "auto-autopsy"
        else:
            policy = "halt"
            self._notify_ev([n["parent"]], _fl("parent", "halted"))
        _tell_user(_fl("user", "switched" if policy == "opus" else "halted"))
        self._log("fable_filter", SYSTEM, {"node": nid, "policy": policy}, [])
        return policy

    def _execute_auto_autopsy(self, nid: str, detail: str,
                              autopsy_model: str) -> dict[str, str]:
        """Execute the D-174 auto-autopsy recovery pattern for a failed fable:
        - Identify base name (<base>-autopsy for the autopsy agent, <base>-N for replacement)
        - If <base>-autopsy already exists and is live:
            keep it as the superior
        - If <base>-autopsy does not exist:
            hire it under nid's parent with tier=autopsy_model,
            move nid under <base>-autopsy
        - Hire next replacement <base>-N under <base>-autopsy with tier="fable"
        - Retire the failed agent nid
        - Send diagnostic kickoff message to <base>-autopsy
        Returns {"autopsy_id": str, "rep_id": str}.
        """
        n = self.node(nid)
        m = re.match(r"^(.*?)(?:-(\d+))?$", nid)
        base = m.group(1) if m else nid
        curr_idx = int(m.group(2)) if (m and m.group(2)) else 1

        autopsy_id = f"{base}-autopsy"
        parent = n["parent"]

        if autopsy_id in self.nodes and self.nodes[autopsy_id]["state"] == "live":
            autopsy_node = autopsy_id
        else:
            hdirs = [dict(d) for d in n["scope"]["add_dirs"]]
            htools = {**n["scope"]["tools"],
                      "mcp": list(n["scope"]["tools"].get("mcp") or [])}
            hvis = n["scope"].get("org_visibility", "full")
            charter = (
                f"Autopsy agent for {base}. Read the failed agent's transcript, "
                f"diagnose why the content filter tripped, and brief the replacement fable."
            )
            self.hire(USER, parent, autopsy_model, 0, autopsy_id,
                      add_dirs=hdirs, tools=htools, org_visibility=hvis,
                      charter=charter)
            self.reorder(USER, autopsy_id, before=nid)
            self.move(USER, nid, autopsy_id)
            autopsy_node = autopsy_id

        next_idx = curr_idx + 1
        while f"{base}-{next_idx}" in self.nodes:
            next_idx += 1
        rep_id = f"{base}-{next_idx}"

        rdirs = [dict(d) for d in n["scope"]["add_dirs"]]
        rtools = {**n["scope"]["tools"],
                  "mcp": list(n["scope"]["tools"].get("mcp") or [])}
        rvis = n["scope"].get("org_visibility", "full")
        self.hire(USER, autopsy_node, "fable", 0, rep_id,
                  add_dirs=rdirs, tools=rtools, org_visibility=rvis,
                  charter=n.get("charter", ""))

        self.retire(USER, nid)

        kickoff = (
            f'Agent "{nid}" had its message flagged by a content filter. '
            f'Run an autopsy: read "{nid}"\'s transcript with orgtree_read_transcript, '
            f'diagnose what instruction triggered the filter, and brief the replacement '
            f'agent "{rep_id}" with rewritten instructions to avoid tripping the filter.'
        )
        # typed: lifecycle.kickoff(reason=autopsy) — the engine's own hand, carried
        # under the user's name (design I3 exception: engine_authored on the row)
        self.post_mail(USER, autopsy_node, "", kind="request",
                       ev=_mint("lifecycle.kickoff", actor_of(SYSTEM),
                                self.node_ref(autopsy_node), body=kickoff, hired_by=USER,
                                reason="autopsy",
                                tier=str(self.node(autopsy_node).get("model") or ""),
                                grant=float(self.node(autopsy_node).get("grant") or 0)))
        return {"autopsy_id": autopsy_node, "rep_id": rep_id}


    def fable_limit_hit(self, detecting_node: str | None, detail: str,
                        until_ts: float | None = None) -> dict[str, Any]:
        """Weekly Fable usage limit exhausted. `until_ts` (FABLE-2,
        2026-08-06) is the reset time already parsed from the same blob —
        carried onto the lock so it releases by TIME (load-time expiry +
        the auto-resume timer), not only by the user's hand.
        What happens to live fable agents is the org's `fable_limit_policy`:
          halt (default) — nobody retires or converts; fable agents simply halt,
              visibly, and their superiors/coworkers decide what to do.
          opus — every fable agent switches to an opus seat and keeps working
              (seat 10→5; the freed credits return to each parent's pool).
          dissolve — every fable node's ENTIRE subtree is retired (recursive,
              deepest first), freeing all its credits to its parent.
        In every case the exhaustion is recorded (fable_lock) and explained to the
        user. Rehiring/hiring fable is NOT hard-blocked for agents — it is merely
        futile while the limit lasts, and their prompts say so."""
        if self.d.get("fable_lock"):
            return {"already_locked": True}
        policy = self.d.get("fable_limit_policy", "halt")
        # `no_reset` (2026-08-07): the captured Fable-tier message carries NO
        # horizon, so a caller that could not parse one says so POSITIVELY
        # rather than leaving the lock bare — a bare lock is the pre-fix
        # artifact shape and the load hook releases it immediately. Marked,
        # it waits for the user, which is the honest state for a quota whose
        # own message offers no time and tells the user what to do instead
        # ("Run /usage-credits … or switch models").
        self.d["fable_lock"] = {"at": now(), "detail": detail[:300],
                                "detected_by": detecting_node, "policy": policy,
                                **({"until_ts": float(until_ts)}
                                   if until_ts else {"no_reset": True})}
        locked: list[str]
        converted: list[str]
        dissolved: list[str]
        locked, converted, dissolved = [], [], []

        # typed (family lifecycle): policy.weekly_limit, one event per audience;
        # the user's summary carries the lists exactly as the old text printed them
        def _wl(node: str, relation: str, outcome: str, *, nodes: int | None = None,
                freed: str | None = None) -> dict[str, Any]:
            return _mint("policy.weekly_limit", actor_of(SYSTEM), self.node_ref(node),
                         relation=relation, node=node, outcome=outcome, nodes=nodes,
                         freed=freed, policy=None, detected_at=None, halted=None,
                         dissolved=None, converted=None)
        for k in [k for k, v in self.nodes.items()
                  if v["state"] == "live" and v["model"] == "fable"]:
            n = self.nodes[k]
            if n["state"] != "live":
                continue   # already taken by an outer fable's dissolve
            if policy == "opus":
                n["model"] = "opus"
                converted.append(k)
                self._notify_ev([n["parent"]], _wl(k, "report", "switched"))
                self._notify_ev([k], _wl(k, "self", "switched"))
            elif policy == "dissolve":
                parent, peers = n["parent"], self._peers_of(n["parent"], k)
                taken = self.dissolve(SYSTEM, k)
                dissolved.append(k)
                self._notify_ev([parent], _wl(k, "report", "dissolved",
                                              nodes=len(taken["nodes"]),
                                              freed=str(taken["freed"])))
                self._notify_ev(peers, _wl(k, "peer", "dissolved"))
            else:   # halt — the default
                n["limit_locked"] = True
                locked.append(k)
                self._notify_ev([n["parent"]], _wl(k, "report", "halted"))
                self._notify_ev(self._peers_of(n["parent"], k), _wl(k, "peer", "halted"))
                self._notify_ev([k], _wl(k, "self", "halted"))
        first = (locked + dissolved + converted or [detecting_node or ""])[0]
        uev = _mint("policy.weekly_limit", actor_of(SYSTEM),
                    self.node_ref(first) if first in self.nodes else
                    {"kind": "node", "org": str(self.d.get("slug") or ""), "id": str(first),
                     "name": str(first), "generation": 0},
                    relation="user", node=str(first),
                    outcome=("switched" if policy == "opus" else
                             "dissolved" if policy == "dissolve" else "halted"),
                    nodes=None, freed=None, policy=str(policy),
                    detected_at=(str(detecting_node) if detecting_node else None),
                    halted=(str(locked) if locked else None),
                    dissolved=(str(dissolved) if dissolved else None),
                    converted=(str(converted) if converted else None))
        self.to_user_inbox({
            "from": SYSTEM, "kind": "decision", "at": now(),
            "body": events.render_agent(uev)}, uev)
        self._log("fable_limit", SYSTEM,
                  {"policy": policy, "locked": locked, "dissolved": dissolved,
                   "converted": converted}, [])
        return {"policy": policy, "locked": locked, "dissolved": dissolved,
                "converted": converted}

    def unstick(self, actor: str, nid: str) -> dict[str, Any]:
        """⭐ User ruling 2026-08-06, verbatim: "i should be able to, as the
        user, manually locate and unstick any agent frozen for any reason,
        overriding built in locks that might prevent other agents from
        unsticking it, such as session limits, weekly limits, or fable
        specific limits."

        USER OVERRIDE OR SUPERVISOR AUTHORITY: the user may override any freeze; an authenticated superior may release only a descendant:
        an agent that could unstick itself (or a peer) walks straight
        through a spend cap; the ruling says the USER overrides the locks,
        not that the locks stop being locks. Clears, in ONE action: the
        node's frozen record REGARDLESS of kind flags (the test is "the
        user said so", never a kind allowlist — an allowlist reintroduces
        this bug with the next freeze kind), the node's limit_locked, and
        the org-wide fable_lock when this node was its last holder.
        RECORDS rather than erases: the freeze moves onto n["unstuck"]
        {by, at, was} — an override leaves MORE evidence, not less.

        NOT folded in (per the same capture, different verbs own them):
        remote_controlled (release) and archived (rehire). Org-level
        spend/storage freezes are admin controls with their own UI — the
        result WARNS when one still holds, because unsticking the agent
        does not turn off the org's meters."""
        if actor_kind(actor) != "user":
            self._require_authority(actor, nid)
        n = self.node(nid)
        released: list[str] = []
        was = n.pop("frozen", None)
        if was:
            released.append("frozen")
        if n.pop("limit_locked", None):
            released.append("limit_locked")
        if self.d.get("fable_lock") and not any(
                v.get("limit_locked") for v in self.nodes.values()):
            self.d.pop("fable_lock", None)
            released.append("fable_lock (org-wide — this was its last holder)")
        if not released:
            return {"status": f"{nid} is not stuck — nothing to release",
                    "released": []}
        cast("dict[str, Any]", n)["unstuck"] = {
            "by": actor, "at": now(), **({"was": was} if was else {})}
        self._notify_ev([nid], _mint("policy.unstuck", actor_of(actor), self.node_ref(nid)))
        self._log("unstick", actor, {"node": nid, "released": released}, [])
        warnings: list[str] = []
        if self.d.get("spend_frozen"):
            warnings.append("the org-wide SPEND freeze still holds — turns "
                            "stay refused until the limit is raised in "
                            "settings")
        return {"released": released,
                "resume_texts": [str(t) for t in cast(
                    "list[Any]", (was or {}).get("resume_texts") or [])],
                "resume_views": [str(t) for t in cast(
                    "list[Any]", (was or {}).get("resume_views") or [])],
                **({"warnings": warnings} if warnings else {})}

    def clear_fable_lock(self) -> None:
        """FABLE-3 (redteam 2026-08-06): the manual exit announces the
        release like the timed one — the halt asked superiors to cover the
        halted agents' work, and nothing ever told them to stop."""
        freed = [k for k, v in self.nodes.items() if v.get("limit_locked")]
        self.d.pop("fable_lock", None)
        for v in self.nodes.values():
            v.pop("limit_locked", None)
        for k in freed:
            p = self.nodes[k]["parent"]
            self._notify_ev([p], _mint("policy.unlocked", actor_of(USER), self.node_ref(k),
                                       node=k, relation="report"))
            self._notify_ev(self._peers_of(p, k),
                            _mint("policy.unlocked", actor_of(USER), self.node_ref(k),
                                  node=k, relation="peer"))
            self._notify_ev([k], _mint("policy.unlocked", actor_of(USER), self.node_ref(k),
                                       node=k, relation="self"))
        self._log("fable_unlock", USER, {"freed": freed}, [])

    # ------------------------------------------------------- lineage (§8)
    def compact_split(self, nid: str, new_session_id: str) -> str:
        # Imported lineage validation includes external native dependencies.
        # Refusal must leave the caller's in-memory ledger unchanged too.
        if self.node(nid).get('desktop_import'):
            candidate = copy.copy(self)
            candidate.d = copy.deepcopy(self.d)
            predecessor = candidate._compact_split_apply(nid, new_session_id)
            self.d.clear()
            self.d.update(candidate.d)
            return predecessor
        return self._compact_split_apply(nid, new_session_id)

    def _compact_split_apply(self, nid: str, new_session_id: str) -> str:
        """§8: compaction splits a node. The successor keeps the name, parent and
        org position with the compacted (forked) session; the pre-compaction session
        is retired IN PLACE as an archived knowledge bearer at 0 credits, locked
        read-only. Lineage is a second axis — the predecessor is NOT a child."""
        n = self.node(nid)
        if n.get("bg_open"):
            raise LedgerError(
                f"{nid} still owns open background tasks — compaction would "
                "replace the session observing their outcome")
        gen = n.get("generation", 0)
        pred_id = f"{nid}@{gen}"
        pred = cast(NodeDoc, dict(n))  # dict() copy loses the TypedDict
        pred.update({
            "state": "archived", "archived_at": now(), "grant": 0,
            "bearer_state": "knowledge", "successor": nid, "predecessor": n.get("predecessor"),
            "ui_order": n.get("ui_order", 0) + 0.001,
            # audit finding: dict(n) copied the ACCOUNTING and runtime fields —
            # a duplicated cost_usd inflated the org total superlinearly with
            # each compaction generation (kiosk spend caps froze on the false
            # figure). The bearer starts clean; the successor keeps the real
            # numbers.
            "cost_usd": 0.0, "last_status": None, "frozen": None,
            "inflight": None,
            "scope": {**n["scope"],
                      # deep-copy the dir grants: {**scope} still ALIASES the
                      # live successor's add_dirs list — the first in-place
                      # mutation anyone writes would silently edit every
                      # archived predecessor's grants too (review finding)
                      "add_dirs": cast("list[DirGrant]",
                                       [dict(d) for d in n["scope"].get("add_dirs", [])]),
                      "tools": {"bash": False, "web": False, "edit": False,
                                "subagents": False, "mcp": []}},
        })
        pred.pop("cost_usd_unknown", None)
        pred.pop("cheap_compacted", None)   # the bearer is the OLD session
        # a session that just compacted has demonstrably RUN, so neither half
        # of the split may carry the never-run exemption: the bearer's own
        # transcript is real (and its loss is real damage), and the
        # successor's id comes from the CLI's fork, which writes one.
        pred.pop("session_unrun", None)
        self.nodes[pred_id] = pred
        n["session_id"] = new_session_id
        n["generation"] = gen + 1
        n["predecessor"] = pred_id
        n.pop("session_unrun", None)
        # ⚠ The counter counts boundaries in ONE session file, so it is
        # meaningless against a different one — and this line hands the node a
        # different one. Re-baseline (peer report from compaction-fix,
        # confirmed on disk 2026-08-20): the fork this successor inherits
        # ALREADY contains one compact_boundary — the /compact that made it —
        # so a counter left at its old value read 1 > 0 on the very next turn
        # and minted a LOST generation for a compaction orgtree performed
        # itself and had already preserved properly as `pred_id`. That phantom
        # is `ingame-prompt@6`: bearer_state "lost", sharing the LIVE node's
        # session id, standing beside the real bearer for the same event. It
        # also swallowed that turn's threshold check, since the branch returns
        # early. None (not 0) is the right value: `_after_turn` reads it as
        # "first observation" and baselines to the true count WITHOUT minting.
        n["cli_compactions"] = None
        # a NORMAL compaction's successor carries the CLI's own summary — the
        # cheap-compact breadcrumbs splice (if armed) retires with the session
        n.pop("cheap_compacted", None)
        def _cp(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.compacted", actor_of(SYSTEM), self.node_ref(nid), node=nid,
                         relation=relation, generation=gen + 1, predecessor=str(pred_id),
                         auto=False, lost=False, size_note=None)
        self._notify_ev([n["parent"]], _cp("report"))
        # …AND THE NODE ITSELF (user ruling 2026-08-10). This used to go only to
        # the parent, which is the one participant that did not lose anything:
        # the compacted agent cannot know it has a bearer, because knowing was
        # exactly what compaction took from it. `orgtree_rehire` offers to wake
        # "YOUR OWN knowledge bearer", and on the default org_visibility the
        # agent could neither see that it had one nor learn its id — a tool
        # advertising a capability its holder had no way to reach.
        self._notify_ev([nid], _cp("self"))
        self._log("compact_split", SYSTEM, {"node": nid, "predecessor": pred_id}, [])
        if n.get("codex_thread") == pred.get("session_id"):
            n["codex_thread"] = new_session_id
        self._retire_native_import(nid, pred_id)
        return pred_id

    def record_cli_compaction(self, nid: str,
                              pre_tokens: int | None = None,
                              bearer_sid: str | None = None,
                              boundary_offset: int | None = None) -> str:
        """The CLI compacted the session ITSELF (redteam 1b, user report
        2026-08-06). Generation bumped; the successor's session id is
        UNCHANGED, because the CLI compacted in place and there is no fork.

        `bearer_sid`, when given, is a session minted from the pre-compaction
        records by `supervisor._fork_bearer_session` — and it upgrades this
        from a record into a real KNOWLEDGE BEARER, consultable exactly like
        the §8 split's.

        Was (until 2026-08-20): always a LOST generation, on the belief that
        "orgtree lost the race and the pre-compaction context is already
        gone". That belief was wrong. The CLI's in-place compaction is
        APPEND-ONLY — boundary, summary, then the later turns, all in one file
        with the earlier records intact — so nothing was ever destroyed. What
        was missing was a session id that RESOLVED to the pre-compaction self:
        this method left the predecessor sharing the successor's id, and
        resuming that replays the successor's own post-compaction state. The
        generation was written off as unconsultable while every record of it
        sat on disk (measured on ingame-prompt@6: 428 surviving lines).

        Without `bearer_sid` the old shape stands — reseed's lost generation
        (bearer_state="lost": visible in the lineage stack, honestly
        unconsultable). That is the deliberate FAIL-SOFT: if the pre-
        compaction session could not be cut, the org is told the truth it was
        always told, never a bearer that cannot answer."""
        n = self.node(nid)
        rebound = self._native_bearer_binding(nid, bearer_sid) if bearer_sid else None
        gen = n.get("generation", 0)
        pred_id = f"{nid}@{gen}"
        pred = cast(NodeDoc, dict(n))  # dict() copy loses the TypedDict
        pred.update({
            "state": "archived", "archived_at": now(), "grant": 0,
            "bearer_state": "knowledge" if bearer_sid else "lost",
            "successor": nid,
            "predecessor": n.get("predecessor"),
            "ui_order": n.get("ui_order", 0) + 0.001,
            "cost_usd": 0.0, "last_status": None, "frozen": None,
            "inflight": None,
            "scope": {**n["scope"],
                      "add_dirs": cast("list[DirGrant]",
                                       [dict(d) for d in n["scope"].get("add_dirs", [])]),
                      "tools": {"bash": False, "web": False, "edit": False,
                                "subagents": False, "mcp": []}},
        })
        pred.pop("cost_usd_unknown", None)
        # same invariant reseed holds: a LOST record must not also carry
        # the never-run pardon — one row cannot assert both "this session
        # never ran" and "its transcript is gone" (redteam 2026-08-18).
        # And the CLI compacting in place is itself proof it ran.
        pred.pop("session_unrun", None)
        pred.pop("lost_reason", None)
        if not bearer_sid:
            # WHY it is lost, so a later repair can tell this row — whose
            # records may still be above a boundary in a shared session —
            # apart from `reseed`'s row, which has no boundary of its own and
            # must never be cut at a neighbour's (redteam 2026-08-20)
            pred["lost_reason"] = "cli_compaction"
        if bearer_sid:
            # the ONE field that makes it consultable: its own session, cut
            # from the records above the boundary. Without this the row points
            # at the successor's live session and "rehire" would resume the
            # successor's post-compaction state under the predecessor's name.
            pred["session_id"] = bearer_sid
            if rebound is not None:
                pred["desktop_import"] = rebound
                if rebound["native_continuity"]["provider"] == "codex":
                    pred["codex_thread"] = bearer_sid
        elif boundary_offset is not None:
            # a LOST row records WHERE its boundary was, so a later recovery
            # reads the cut point instead of re-deriving it. Deriving it is
            # where the ambiguity lives: rows and boundaries only line up
            # positionally while every row is still lost, and the moment one
            # of several is recovered (it takes a session of its own and
            # leaves the set) any index arithmetic over the survivors silently
            # points at the wrong boundary — cutting a bearer from the wrong
            # moment, which looks like success and is not.
            pred["cli_boundary_offset"] = int(boundary_offset)
        self.nodes[pred_id] = pred
        n["generation"] = gen + 1
        n["predecessor"] = pred_id
        imported = n.get("desktop_import") or {}
        native = imported.get("native_continuity") or {}
        if native.get("status") == "transitioned" and native.get("session_id") == n.get("session_id") and native.get("generation") == gen:
            n["desktop_import"] = copy.deepcopy(imported)
            n["desktop_import"]["native_continuity"]["generation"] = gen + 1
        size = (f'; ~{pre_tokens / 1000:.0f}k tokens summarized'
                if pre_tokens else '')
        # typed (family lifecycle): lifecycle.compacted with auto=True; `lost`
        # says whether a consultable bearer exists (the same courtesy as
        # compact_split, with the OPPOSITE content when there is none — and
        # saying so is the point: an agent told it has a bearer it cannot wake
        # is sent to a refusal, one told nothing discovers the same refusal)
        def _cli(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.compacted", actor_of(SYSTEM), self.node_ref(nid), node=nid,
                         relation=relation, generation=gen + 1, predecessor=str(pred_id),
                         auto=True, lost=not bearer_sid, size_note=(size or None))
        self._notify_ev([n["parent"]], _cli("report"))
        self._notify_ev([nid], _cli("self"))
        self._log("cli_compact", SYSTEM,
                  {"node": nid, "predecessor": pred_id,
                   "preserved": bool(bearer_sid),
                   **({"pre_tokens": pre_tokens} if pre_tokens else {})}, [])
        return pred_id

    def recover_lost_generation(self, pred_id: str, bearer_sid: str) -> str:
        """Turn an ALREADY-recorded LOST generation back into a consultable
        knowledge bearer, given a session cut from its surviving records.

        Retroactive because the loss was bookkeeping, not data: every
        generation written off by the pre-2026-08-20 `record_cli_compaction`
        still has its records sitting above the boundary in the successor's
        session file (the CLI's in-place compaction only ever appends). This
        is the opt-in repair — never automatic, because it rewrites lineage
        history and the operator should choose that moment (and because a
        generation lost some OTHER way, e.g. reseed's genuinely-missing
        transcript, must stay lost). `supervisor.recover_lost_generation`
        finds the cut; this records it."""
        n = self.node(pred_id)
        if n.get("bearer_state") != "lost":
            raise LedgerError(
                f"{pred_id} is not a lost generation "
                f"(bearer_state={n.get('bearer_state')!r})")
        if not bearer_sid or not bearer_sid.strip():
            raise LedgerError("a recovered bearer needs a real session id")
        rebound = self._native_bearer_binding(pred_id, bearer_sid)
        n["bearer_state"] = "knowledge"
        n["session_id"] = bearer_sid
        if rebound is not None:
            n["desktop_import"] = rebound
            if rebound["native_continuity"]["provider"] == "codex":
                n["codex_thread"] = bearer_sid
        # the cut point was a property of being lost inside someone else's
        # file; this row now owns its own session and the offset would only
        # ever mislead a later reader
        n.pop("cli_boundary_offset", None)
        succ = n.get("successor")
        self._notify_ev([succ, n.get("parent")],
                        _mint("lifecycle.recovered", actor_of(USER), self.node_ref(pred_id),
                              predecessor=str(pred_id), successor=str(succ or "")))
        self._log("recover_lost_generation", USER,
                  {"node": pred_id, "successor": succ}, [])
        return pred_id

    def drop_phantom_generation(self, pred_id: str) -> dict[str, Any]:
        """Remove a lineage entry that records a generation which never
        existed — the PHANTOM of `compact_split`'s missing counter reset.

        The phantom (see the ⚠ note in `compact_split`): a §8 split hands the
        successor a fork that already contains one compact_boundary, and an
        un-reset `cli_compactions` then read that as a CLI compaction on the
        next turn. Orgtree minted a LOST generation for a compaction it had
        performed itself and already preserved properly — so the phantom's
        content is not merely recoverable, it is ALREADY HELD, in full, by the
        sibling bearer the split created. Two archived nodes, one real
        generation, one of them a copy.

        This deletes rather than recovers because recovery would mint a SECOND
        bearer duplicating the first. A "LOST" row that never lost anything is
        exactly the thing that sends an agent hunting for a past self it
        cannot reach.

        FAILS CLOSED, by user order: the caller must have PROVEN duplication
        (supervisor._phantom_evidence — every pre-boundary record present in
        the sibling's file); the guards below refuse anything whose content
        could be unique or whose removal could strand another node. Deleting
        the wrong node is unrecoverable, so every doubt resolves to a refusal.

        Generation NUMBERS are deliberately left with a gap where the phantom
        stood. Renumbering would rewrite `name@gen` ids that mail, audiences
        and the lineage stack all reference; a gap is merely odd to look at,
        while a renumber can break references that still resolve today."""
        n = self.node(pred_id)
        if n.get("bearer_state") != "lost":
            raise LedgerError(
                f"{pred_id} is not a lost generation "
                f"(bearer_state={n.get('bearer_state')!r}) — only a phantom "
                f"LOST row may be dropped")
        if n.get("state") != "archived":
            raise LedgerError(f"{pred_id} is {n.get('state')!r}, not archived")
        if self.children(pred_id, live_only=False):
            raise LedgerError(f"{pred_id} has reports — refusing to drop it")
        if any(v.get("parent") == pred_id for v in self.nodes.values()):
            raise LedgerError(f"{pred_id} is someone's parent — refusing")
        succ, prev = n.get("successor"), n.get("predecessor")
        if not succ or succ not in self.nodes:
            raise LedgerError(
                f"{pred_id} has no live successor to re-link to — refusing")
        # Re-link the lineage chain ACROSS the hole. ⚠ `successor` is NOT the
        # next generation — every mint writes the bare LIVE node id there, so
        # every row in a lineage stack names the same successor. Rewriting
        # `self.node(succ)["predecessor"]` unconditionally therefore only
        # happened to be right when the phantom was the NEWEST generation;
        # with a real generation minted after it (possible, because
        # record_cli_compaction leaves the session id alone, so later rows
        # keep sharing it) that line reached PAST the newer row and pointed
        # the live node at the phantom's predecessor. The newer generation
        # then fell out of `lineage_stack` and out of `_taken_with` — invisible
        # to the agent that was told to rehire it, missed by `dissolve`, and
        # left behind by `delete` as an archived node whose parent no longer
        # exists, which is the KeyError in `ancestors()` that _taken_with was
        # written to prevent. Found by redteam 2026-08-20 with a live probe.
        #
        # The only correct rule is the local one: whoever actually POINTS at
        # this row now points past it. That is the loop, and the loop alone.
        for v in self.nodes.values():
            if v.get("predecessor") == pred_id:
                v["predecessor"] = prev
            if v.get("successor") == pred_id:
                v["successor"] = succ
        lost_cost = round(float(n.get("cost_usd") or 0.0), 6)
        if lost_cost:       # dissolve's convention — burn is never unbooked
            self.d["deleted_cost_usd"] = round(
                float(self.d.get("deleted_cost_usd") or 0.0) + lost_cost, 6)
        if n.get("cost_usd_unknown"):
            self.d["deleted_cost_usd_unknown"] = True
        self.nodes.pop(pred_id, None)
        for tbl in ("mail", "mail_log", "notices", "steered_log"):
            box = cast("dict[str, Any]", self.d.get(tbl) or {})
            box.pop(pred_id, None)
        self.d["audiences"] = [a for a in self.d.get("audiences", [])
                               if pred_id not in (a.get("grantee"),
                                                  a.get("grantor"))]
        self._notify_ev([self.node(succ).get("parent"), succ],
                        _mint("lifecycle.phantom_removed", actor_of(USER), self.node_ref(succ),
                              predecessor=str(pred_id), holder=str(prev)))
        self._log("drop_phantom_generation", USER,
                  {"node": pred_id, "successor": succ, "duplicate_of": prev},
                  [])
        return {"dropped": pred_id, "successor": succ, "duplicate_of": prev}

    def mark_unrecoverable(self, nid: str, reason: str) -> None:
        """№31: ledger said live, the session cannot actually resume."""
        n = self.node(nid)
        n["state"] = "unrecoverable"
        self._notify_ev([n["parent"]],
                        _mint("lifecycle.unrecoverable", actor_of(SYSTEM), self.node_ref(nid),
                              node=nid, reason=str(reason)))
        self._log("unrecoverable", SYSTEM, {"node": nid, "reason": reason}, [])

    def reseed(self, actor: str, nid: str, new_session_id: str) -> dict[str, Any]:
        """The №31 exit (gap audit №9): an unrecoverable node's SESSION is gone,
        but the node — name, position, charter, credits, reports, mailbox — is
        fine. Re-seed mints a fresh session and archives the dead one into the
        lineage stack as a LOST generation (bearer_state="lost": kept for the
        record, never consultable — its transcript is missing). Budget-neutral:
        same node, same seat, no new charge."""
        self._require_authority(actor, nid, allow_self=True)
        n = self.node(nid)
        if n["state"] == "archived":
            raise LedgerError(f"{nid} is archived — rehire it instead")
        if n["state"] != "unrecoverable":
            return {"warnings": [f"{nid} is {n['state']} and its session works — "
                                 f"nothing to re-seed"]}
        if n.get("successor"):
            # review C14: a knowledge bearer whose transcript is gone IS the
            # lost generation — minting a fresh session would leave a node
            # badged "knowledge" over empty memory. It archives in place,
            # marked lost, and the successor (the one agent whose whole
            # reason to consult it is the context that just vanished) is
            # told directly.
            succ = n["successor"]
            was_live = n["state"] in ("live", "unrecoverable") \
                and not n.get("archived_at")
            n["state"] = "archived"
            n["archived_at"] = now()
            n["grant"] = 0
            n["bearer_state"] = "lost"
            n["lost_reason"] = "reseed"
            n["frozen"] = None
            n["inflight"] = None
            self._notify_ev([t for t in {succ, n["parent"]} if t and t != actor],
                            _mint("lifecycle.bearer_lost", actor_of(actor), self.node_ref(nid),
                                  bearer=nid))
            self._log("reseed", actor, {"node": nid, "lost_bearer": True}, [])
            return {"warnings": [
                f'{nid} was a knowledge bearer with no surviving transcript — '
                f'marked a LOST generation (archived, never consultable); no '
                f'fresh session was minted'
                + ("; its seat freed" if was_live else "")]}
        gen = n.get("generation", 0)
        pred_id = f"{nid}@{gen}"
        pred = cast(NodeDoc, dict(n))  # dict() copy loses the TypedDict
        pred.update({
            "state": "archived", "archived_at": now(), "grant": 0,
            # ⚠ `lost_reason` is what keeps this row out of the recovery
            # verb's boundary arithmetic. It is NOT a compaction row: it has
            # no boundary of its own, so any cut point inferred for it by
            # position belongs to one of its neighbours, and "recovering" it
            # would hand it another generation's records under its own name
            # (redteam 2026-08-20, reproduced).
            "bearer_state": "lost", "lost_reason": "reseed", "successor": nid,
            "predecessor": n.get("predecessor"),
            "ui_order": n.get("ui_order", 0) + 0.001,
            "cost_usd": 0.0, "last_status": None, "frozen": None,
            "inflight": None,
            "scope": {**n["scope"],
                      "add_dirs": cast("list[DirGrant]",
                                       [dict(d) for d in n["scope"].get("add_dirs", [])]),
                      "tools": {"bash": False, "web": False, "edit": False,
                                "subagents": False, "mcp": []}},
        })
        pred.pop("cost_usd_unknown", None)
        pred.pop("cheap_compacted", None)   # the bearer is the OLD session
        # …and this bearer is stamped LOST — "its transcript is gone".
        # Inheriting the never-run pardon would make one record assert
        # both that and "this session never ran", which cannot both be
        # true (redteam 2026-08-18). cheap_compact's bearer is the
        # opposite case and keeps it.
        pred.pop("session_unrun", None)
        self.nodes[pred_id] = pred
        n["session_id"] = new_session_id
        n["generation"] = gen + 1
        n["predecessor"] = pred_id
        n["cli_compactions"] = None      # new session, new count (see above)
        # same mint, same exemption as cheap_compact (user bug 2026-08-18):
        # re-seeding and then closing orgtree before messaging the node re-
        # condemned the very node the re-seed just rescued, since the fresh
        # id has no transcript either.
        n["session_unrun"] = True
        n["state"] = "live"
        # An EMPTY session reports an empty context, and the two compaction
        # markers describe a session that no longer exists (redteam
        # 2026-08-20 — cheap_compact was given this three functions up and its
        # sibling here was missed). Left standing they were durable: the card
        # wheel showed the dead session's fill over a session with nothing in
        # it, and `compacted_unrun` made POST …/compact answer "just compacted
        # — nothing to compact" on a node that has never run at all.
        n["occupancy"] = None
        n.pop("occupancy_est", None)
        n.pop("compacted_unrun", None)
        # a reseeded session starts as empty as a cheap-compacted one (and
        # its predecessor is LOST) — the breadcrumbs splice applies equally
        n["cheap_compacted"] = True
        # a re-seeded session is as memoryless as a cheap-compacted one —
        # same digest, same reason (see _fold_notices)
        folded = self._fold_notices(nid)

        def _rs(relation: str) -> dict[str, Any]:
            return _mint("lifecycle.reseeded", actor_of(actor), self.node_ref(nid), node=nid,
                         relation=relation, by=actor, predecessor=str(pred_id))
        self._notify_ev([p for p in [n["parent"]] if p and p != actor], _rs("report"))
        self._notify_ev([nid], _rs("self"))
        self._log("reseed", actor, {"node": nid, "predecessor": pred_id,
                                    "notices_folded": folded}, [])
        return {"predecessor": pred_id,
                "warnings": [f'{nid} re-seeded — the dead session is archived as '
                             f'"{pred_id}" (lost generation, not consultable)']}

    # ------------------------------------------------------------------ audit
    def audit(self) -> dict[str, Any]:
        """Global consistency: no overdraft anywhere; per-node free is derivable."""
        live = [k for k, v in self.nodes.items() if v["state"] == "live"]
        problems = [f"{k} free={self.free(k):g}" for k in live if self.free(k) < 0]
        return {
            "live_nodes": len(live),
            "top_level_holds": _q(sum(self.seat_cost(k) + self.nodes[k]["grant"]
                                      for k in self.children(None))),
            "no_overdraft": not problems,
            "problems": problems,
        }

    # ------------------------------------------------------------------- view
    def tree(self) -> dict[str, Any]:
        """Derived view for the API/UI: nested nodes with computed fields."""
        # ONE parent partition for the whole walk. `build` recurses over
        # every node, and without this each step re-scanned the entire node
        # table to find one parent's children — see `children_index`.
        _kids = self.children_index()

        def build(nid: str) -> dict[str, Any]:
            n = self.nodes[nid]
            _cc = n.get("cache_continuity")
            _cc_public = (_cc.get("public") if isinstance(_cc, dict) else None)
            return {
                "id": nid,
                "title": n["title"],
                "tier": n["model"],
                "model_id": self.d["models"].get(n["model"], n["model"]),
                "state": n["state"],
                "seat": self.d["tiers"][n["model"]],
                "grant": n["grant"],
                "free": None if n["state"] != "live" else self.free(nid),
                "session_id": n["session_id"],
                "scope": n["scope"],
                # what a turn would ACTUALLY launch with — scope.effort is
                # only half the answer (the org default supplies the rest)
                "effort_effective": self.effective_effort(nid),
                "ui_order": n.get("ui_order", 0),
                "cost_usd": round(float(n.get("cost_usd") or 0.0), 4),
                "cost_usd_unknown": bool(n.get("cost_usd_unknown")),
                "occupancy": n.get("occupancy"),
                # a compaction fills this in before anything has measured the
                # new session — the card says so rather than implying precision
                "occupancy_est": bool(n.get("occupancy_est")),
                # …and this one is why the compact button is not offered: the
                # session holds only its summary until the next turn
                "compacted_unrun": bool(n.get("compacted_unrun")),
                "context_window": n.get("context_window"),
                # Safe atomic forecast only. Private fingerprints, provider
                # account/session evidence and component hashes never cross
                # this view boundary.
                "cache_forecast": (dict(_cc_public)
                                   if isinstance(_cc_public, dict) else None),
                "charter": n.get("charter"),
                "team_charter": n.get("team_charter"),
                "mail_pending": len((self.d.get("mail") or {}).get(nid, [])),
                "limit_locked": bool(n.get("limit_locked")),
                "last_status": n.get("last_status"),
                "prev_status": n.get("prev_status"),
                "inflight_at": (n.get("inflight") or {}).get("at"),
                # D-234: a switch queued behind the running turn — the card
                # wears it until the boundary applies (or a cancel clears) it
                "pending_switch": n.get("pending_switch"),
                "last_denials": n.get("last_denials") or [],
                # codex lane (2026-09-05): approvals the seam answered
                # "accept". Absent when the lane cannot report it — a `[]`
                # here would read as "seam ran, approved nothing"
                **({"last_approvals": n["last_approvals"]}
                   if "last_approvals" in n else {}),
                "turns": (n.get("turns") or [])[-8:],
                # the `if n.get("frozen")` guard proves the key present — the
                # Any view sidesteps pyright's NotRequired-[] access flag
                "frozen": ({**{k: cast(Any, n)["frozen"].get(k)
                               for k in ("at", "until", "until_ts",
                                         # the badge label needs the KIND
                                         # (a network freeze is not a
                                         # "usage limit", 2026-08-06);
                                         # `limit` rides along for D-122 —
                                         # the banner promises "retrying
                                         # automatically" only for a PURE
                                         # connection freeze, and a record
                                         # carrying both flags waits on the
                                         # auto_resume toggle
                                         "connection", "limit",
                                         # D-241: the API projection needs the
                                         # freeze-time pool and deadline source
                                         # to avoid erasing a valid retry when
                                         # an unmarked fallback is merely
                                         # eligible. These are non-secret
                                         # scheduling facts.
                                         "pool", "schedule_kind", "reset_src",
                                         # D-156: WHY, when the answer is not
                                         # "capacity ran out". "auth" = the
                                         # credential was rejected, so the
                                         # record is a usage-limit freeze in
                                         # SHAPE only — the count includes it
                                         # (▶ really will act on it) but the
                                         # words "usage limit" do not describe
                                         # it. A reader that cannot see this
                                         # field cannot help over-claiming.
                                         # the kiosk SPEND kind. It rode the
                                         # org-level `spend_frozen` flag alone
                                         # for a long time, which is why the
                                         # org banner was right and the NODE
                                         # BADGE was not: the badge has no
                                         # org flag to consult, so a
                                         # spend-frozen agent wore the words
                                         # "usage limit" (2026-08-26).
                                         "spend",
                                         "cause")},
                            # ⚠⚠ THIS LIST IS A FILTER, AND WHAT IT OMITS IT
                            # DESTROYS SILENTLY. `frozen` is rebuilt key by
                            # key, so a kind flag or qualifier added to
                            # FrozenInfo does NOT reach the client until it is
                            # named HERE — and the symptom is never a crash or
                            # a blank. It is a display confidently saying the
                            # wrong thing, because every reader falls to the
                            # `else` branch of a test it cannot make.
                            # It has now cost exactly that twice in one day:
                            # `cause` (auth freezes labelled "usage limit hit"
                            # — and `_rederive_freeze_reset` additionally
                            # OVERWROTE their "replace the credential" text
                            # with "capacity available", the opposite of the
                            # fix) and `spend` (the node badge above).
                            # ⚠ IF YOU ADD A FREEZE KIND, ADD IT HERE IN THE
                            # SAME COMMIT, and give it a label branch in
                            # App.tsx's resume-note, desk.tsx's badge and
                            # cards.tsx's compact badge — all three fall
                            # through to "usage limit" by default.
                            # №41: freeze kinds are commutative — surface
                            # whichever reason(s) exist without overwriting
                            "error": " · ".join(
                                x for x in (cast(Any, n)["frozen"].get("error"),
                                            cast(Any, n)["frozen"].get("spend_error"))
                                if x) or None}
                           if n.get("frozen") else None),
                "audiences_held": [a["grantor"] for a in self.d["audiences"]
                                   if a["grantee"] == nid],
                # outward @mcp: channels this node may answer directly. Read
                # so a client that OWNS a handle (the in-game panel) can find
                # the one already bound to an agent instead of minting a
                # second. ⚠ _scrub_public drops this: the peer id is the only
                # credential /api/extern/{peer}/messages asks for, so handing
                # it to a kiosk visitor would hand them the conversation.
                "external_handles": n.get("external_handles") or [],
                # F-04/F-05: the ask card this node's desk shows — open, or
                # freshly nulled (the nulled card carries its reason)
                "ask": self.node_ask(nid),
                # FR-01: parked under user remote control (supervisor sets it)
                "remote_controlled": n.get("remote_controlled") or None,
                # FR-03: presented documents — METADATA only (the reader
                # fetches the body on open; bodies are up to 64 KB and would
                # bloat every tree payload)
                "documents_count": sum(1 for x in self.d.get("documents", []) if x["node"] == nid),
                "documents": [{"id": x["id"], "title": x["title"],
                               "at": x["at"],
                               "format": x.get("format") or "markdown"}
                              for x in self.d.get("documents", [])
                              if x["node"] == nid][-10:] or None,
                "bearer_state": n["bearer_state"],
                "generation": n["generation"],
                "children": [build(c) for c in self.org_children(nid, _kids)],
                "lineage": [{
                    "id": k,
                    "generation": self.nodes[k].get("generation", 0),
                    "state": self.nodes[k]["state"],
                    "bearer_state": self.nodes[k].get("bearer_state"),
                    "tier": self.nodes[k]["model"],
                } for k in self.lineage_stack(nid)],
            }
        # F-04 history, capped by what the DESK ACTUALLY RENDERS. The full
        # list was shipped at `[-60:]` and measured 122,692 B on the live org
        # — 15% of an 844 KB payload refetched every 6 s and on every save —
        # while `App.tsx` renders `asks.filter(!askOpen).slice(-8)`, i.e. the
        # last EIGHT resolved ones. Open asks are not read from here at all;
        # the desk takes those from each node's own `ask`.
        #
        # ⚠ OPEN/PENDING ARE NEVER CAPPED. Only the resolved history is, and
        # only after every open one is kept: an open ask is a question waiting
        # on the user, and dropping one off the end of a list would lose it
        # silently. The cap is a HISTORY cap, not a list cap.
        #
        # ⚠ ORIGINAL ORDER IS PRESERVED — the surplus is filtered out in
        # place rather than the list being rebuilt open-first. The desk sorts
        # for itself, but a payload whose order depends on status is a trap
        # for the next reader of it.
        #
        # ⚠ THIS NUMBER IS COUPLED TO `App.tsx` AND A TEST ENFORCES THAT.
        # `ASK_HISTORY_KEEP` must stay >= the desk's slice or the history
        # silently gets shorter than the UI asks for — the failure would be
        # "old asks stopped appearing", with nothing erroring.
        # `test_tree_render_cost.py` §9 reads the slice out of `App.tsx` and
        # asserts the inequality, so the two cannot drift apart unnoticed.
        _asks_all = (self.d.get("asks", [])
                     + [{**r, "kind": "credit"}
                        for r in self.d.get("credit_requests", [])
                        if r["status"] != "withdrawn"]
                     + [{**r, "kind": "scope"}
                        for r in self.d.get("scope_requests", [])
                        if r["status"] != "withdrawn"])
        _keep = {i for i, a in enumerate(_asks_all)
                 if a.get("status") not in OPEN_ASK_STATUS}
        _keep = set(sorted(_keep)[-ASK_HISTORY_KEEP:])
        _asks = [a for i, a in enumerate(_asks_all)
                 if a.get("status") in OPEN_ASK_STATUS or i in _keep]
        return {
            "slug": self.d["slug"],
            "name": self.d["name"],
            "workspace": self.d.get("workspace"),
            "dirs": self.d["dirs"],
            "max_top_grant": self.d.get("max_top_grant", 1000),
            "default_top_grant": self.d.get("default_top_grant", 50),
            "compact_at": self.d.get("compact_at", 0.80),
            "default_tools": self.d.get("default_tools"),
            "default_visibility": self.d.get("default_visibility", "full"),
            # the mode NEW hires are born with — editable post-creation
            # (D-101); each existing node carries its own in `scope`
            "permission_mode": self.d.get("permission_mode", "acceptEdits"),
            # "" = CLI default (user ruling 2026-08-01: visible inherit — an
            # unset node effort falls back to this at TURN time, live)
            "default_effort": self.d.get("default_effort", ""),
            # what "" resolves to, so no UI string has to hardcode it
            "effort_default": self.DEFAULT_EFFORT,
            "prefer_reserve_default": app_prefer_reserve_default(),
            "credit_requests": [r for r in self.d.get("credit_requests", [])
                                if r["status"] == "pending"],
            # F-04: everything the user's inbox interleaves as ask cards —
            # open first-class, resolved for the nulled history; the header
            # ask-icon glows iff asks_open > 0
            # withdrawn hidden, moot SHOWN — same rule as node_ask (redteam
            # 2026-08-06: a mooted credit request reached no reader at all,
            # while its question twin left a nulled card explaining itself)
            "asks": _asks,
            "asks_open": sum(1 for a in self.d.get("asks", [])
                             if a["status"] == "open")
                         + sum(1 for r in self.d.get("credit_requests", [])
                               if r["status"] == "pending")
                         + sum(1 for r in self.d.get("scope_requests", [])
                               if r["status"] == "pending"),
            "tiers": self.d["tiers"],
            # tier → model id, the org's own add-only table (2026-09-03): the
            # UI names an OpenRouter tier by its model, and a node running on
            # a favorite that was since DESELECTED has no other source for it
            "models": self.d.get("models", {}),
            "audiences": self.d["audiences"],
            "roots": [build(c) for c in self.org_children(None, _kids)],
            "audit": self.audit(),
            "cost_usd_total": self.cost_total(),
            "cost_usd_unknown": bool(
                self.d.get("deleted_cost_usd_unknown")
                or any(n.get("cost_usd_unknown") for n in self.nodes.values())),
            # api_fallback split: the slice of cost_usd_total billed to the
            # org's key while a fallback window was open (supervisor banks it
            # at every cost-booking point) — the cost card's hover split
            "api_cost_usd_total": round(
                float(self.d.get("api_cost_usd") or 0.0), 4),
            "user_inbox_count": len(self.d.get("user_inbox", [])),
            # D-169: how many UNREAD user mails are urgent. `user_inbox` IS
            # the unread set (the read endpoint moves an entry out of it into
            # `user_mail_log`), so this falls to 0 on exactly the read event
            # — no separate seen-stamp, nothing to leave the pulse stuck on.
            # ⚠ THIS DICT IS A FILTER: it is built key by key and drops
            # whatever it does not name, silently, and the symptom is a
            # confident wrong display rather than a crash (see the `frozen`
            # block below, which has cost exactly that twice). The pip reads
            # this key; if it stops being named here the count quietly
            # becomes the ordinary unread count and the pulse never fires.
            "urgent_unread": sum(1 for m in self.d.get("user_inbox", [])
                                 if m.get("urgent")),
            "user_inbox_newest": (self.d.get("user_inbox") or [{}])[-1].get("at"),
            "fable_lock": self.d.get("fable_lock"),
            "spend_frozen": bool(self.d.get("spend_frozen")),
            "storage_blocked": bool(self.d.get("storage_blocked")),
            "auto_resume": bool(self.d.get("auto_resume")),
            "auto_resume_compact": bool(self.d.get("auto_resume_compact")),
            # api_fallback (2026-08-17): the option plus the window edge —
            # the UI derives "active" by comparing against its own clock
            "api_fallback": bool(self.d.get("api_fallback")),
            "api_fallback_until": self.d.get("api_fallback_until"),
            # Cache-protective compaction: explicit on/off plus the minimum
            # measured context fraction. Provider/auth expiry is derived.
            "auto_cheap_compact": self.d.get("auto_cheap_compact"),
            # FR-18: the canvas renders dogs as satellite entities; the
            # events ring IS the sent-mail tab.
            # D-200: `once` is NORMALISED to a real boolean on the way out.
            # On disk it is sparse (present only when true) so that no
            # pre-existing dog needs migrating — but a UI that must render a
            # one-shot dog differently from a persistent one cannot be handed
            # `undefined` and asked to guess, and a field that is absent for
            # most dogs is one a component will eventually read as "false"
            # from the wrong object. It is a boolean at this boundary.
            "watchdogs": [{**w, "once": bool(w.get("once")), "spent": False}
                          for w in (self.d.get("watchdogs") or [])]
            # D-200: spent one-shot dogs ride along for WATCHDOG_TOMB_TTL_S so
            # the canvas can finish drawing the fire that killed them. They
            # are NOT armed and NOT in `watchdogs` — `orgtree_watchdog list`
            # cannot see them and neither can the engine. They exist here and
            # only here, because this is the payload the canvas takes dog
            # POSITIONS from, and a spark whose origin has no position is
            # silently not drawn at all.
            + [{**t, "once": True, "spent": True, "state": "spent",
                "fired": int(t.get("fired") or 0), "events": []}
               for t in (self.d.get("watchdog_tombs") or [])
               if not self._tomb_expired(t)],
            "fable_limit_policy": self.d.get("fable_limit_policy", "halt"),
            "fable_filter_policy": self.d.get("fable_filter_policy", "halt"),
            "fable_filter_model": self.d.get("fable_filter_model", "opus"),
            "fable_api_fallback": bool(self.d.get("fable_api_fallback")),
            "cascade_hire": bool(self.d.get("cascade_hire", True)),
            "cascade_alloc": bool(self.d.get("cascade_alloc", True)),
            "sandboxed": bool((self.d.get("kiosk") or {}).get("sandbox")
                             or (self.d.get("sandbox") or {}).get("enabled")),
            "audience_requests": self.d.get("audience_requests", []),
            # the docket toolbar badge (docket-final-spec.md): two counts over
            # the FULL item set, always present - the modal fetches the list
            # from GET /api/orgs/{slug}/work-items when it opens
            "work_items_summary": {k: v for k, v in self.work_counts().items()
                                   if k in ("attention", "active")},
            # the org inbox panel (user spec): hidden until the org receives
            # its first outside mail OR an inbox audience is granted
            "org_inbox": {
                # ⚠ A PREVIEW, NOT THE MAILBOX. The canvas renders exactly one
                # of these — `entries[entries.length - 1]`, the newest — while
                # the full log rode every 6 s poll at 105,310 B, 12% of an
                # 844 KB payload (MEASURED 2026-09-03). The modal fetches the
                # real list from `GET /api/orgs/{slug}/org_inbox` when it
                # opens. `[-3:]` rather than `[-1:]` so the canvas keeps a
                # little headroom without another backend change.
                "entries": self.d.get("org_inbox", [])[-ORG_INBOX_PREVIEW:],
                # ⚠ AND THE TRUE LENGTH OF THE LOG, which is load-bearing.
                # The unread boundary itself survives truncation on its own —
                # it is tail-relative, so `entries.length - unread` is right
                # for any suffix — but the desk's READ ACK is a high-water
                # LENGTH, captured before the read POST round-trips. With the
                # panel now opening on a preview and filling in a moment
                # later, an ack taken against the preview's length would store
                # 3 and re-mark ninety-odd rows unread the instant the fetch
                # landed. So the desk keeps its boundary in LOG coordinates
                # and this is the number it counts against; nothing may derive
                # a count or a boundary from the preview's own length.
                "total": len(self.d.get("org_inbox", [])),
                "unread": max(0, len(self.d.get("org_inbox", []))
                              - int(self.d.get("org_inbox_read", 0))),
                "holders": self.extern_holders(),
                "visible": not self.is_kiosk and bool(
                    self.d.get("org_inbox")
                    or any(a["grantor"] == EXTERN
                           for a in self.d["audiences"])
                    # F-06 (user rulings 2026-08-05): joining a mail hub
                    # surfaces the mailbox — but the IMPLICIT local entry
                    # only counts once the hub has actually answered
                    # (registered_at, FOR THIS ADDRESS — a re-added or
                    # re-pointed entry starts hidden again); a hub that was
                    # never there must show NO ui at all. Explicit typed
                    # remotes count as-is.
                    or any(h.get("enabled") and (
                        h.get("id") != "local"
                        or ((st := (self.d.get("net_state") or {})
                             .get(str(h.get("id")), {})).get("registered_at")
                            and st.get("address") == h.get("address")))
                        for h in self.d.get("net_hubs") or [])),
            },
        }

    # ================================================================ docket
    # Durable work items (docs/work-items.md, docket-final-spec.md). Nothing
    # here lives on a node: an item survives retirement, compaction and
    # reassignment. Two doc-blob lists, `work_items` (active) and
    # `work_items_archive`; an old document without them is an empty docket.
    #
    # THREE clocks, on purpose. `updated_at` moves on ANY mutation;
    # `docket_at` moves only on a DOCKET UPDATE — an agent's status update
    # (the two lists), creation, acceptance, reopen, supersede. The row age the
    # user sees and the one-hour auto-archive both run on `docket_at`, so a
    # question attachment, a delivery claim or a user dismissal never resets
    # the "last heard from" clock and never keeps a finished item young.
    #
    # `status_at` is the third, and it answers the question neither of the
    # others can: WHEN DID THIS ITEM LAST ACTUALLY CHANGE STATE? A progress
    # note, a retitle or an attention flag all advance `docket_at`, so an item
    # that genuinely went open → blocked sorts identically to one whose owner
    # merely added a line. It moves ONLY when the status VALUE changes —
    # creation, an update that names a different status, accept, reopen,
    # supersede — and creation is the initial status time, because an item has
    # had its status since it existed.
    #
    # ⚠ ITEMS THAT PREDATE THE FIELD DERIVE IT FROM RETAINED HISTORY, and fall
    # back to their creation time. What they must NEVER do is inherit a recent
    # timestamp from an unrelated edit: that would move an item nobody touched
    # to the top of "most recently changed state", which is a lie about the
    # data dressed as an ordering. See `_work_status_at`.
    #
    # Archive is DERIVED on read (`_work_archived`), not a stored boolean:
    # a stored flag is exactly the durable-flag-nothing-clears defect the
    # team charter names. The physical move is a sweep at the start of every
    # docket mutation. An item that holds attention (a pending attached
    # question or a manual flag) is never archived, even if the list already
    # holds it — the badge must open onto a visible row (Astra 2026-09-05).
    WORK_ACTIVE_MAX: Final = 200
    WORK_EVIDENCE_MAX: Final = 50
    WORK_HISTORY_MAX: Final = 100
    WORK_LIST_ENTRY_MAX: Final = 40          # entries per docket list
    # the attention reason, which now has to hold requested-against-delivered,
    # the extra, and the confirmation wanted (user 2026-09-05)
    WORK_ATTENTION_REASON_MAX: Final = 500
    WORK_ARCHIVE_AFTER_S: Final = 3600       # strictly greater than ? archived
    WORK_ABANDONED_AFTER_S: Final = 1800    # strictly greater than ? reassigned
    #
    # `backlogged` (user 2026-09-05) is NOT a closed state and NOT an active
    # one: it means the work has not yet been approached or approved. It is
    # therefore kept out of the toolbar's `active` count and served in its own
    # list behind its own toggle, exactly the way the archive is — an item
    # nobody has started must not inflate the number the user reads as "work
    # in flight". It never archives (the sweep is done-only), and existing
    # `open` items are NEVER reclassified into it: only an explicit update
    # moves an item there, because plenty of open items are authorised and
    # under way (Astra ruling 2026-09-05).
    #
    # `blocked` (user 2026-09-07) is work that cannot move until an answer or
    # event outside the item happens: it names what it is stuck on and how the
    # agent will hear of it, it stays on the assigned desk and in the active
    # count, and it is NEVER nudged — not by the idle-docket reminder and, when
    # it is all an agent owes, not by the working-status checkup either
    # (`work_blocked_only`). The answer or event itself, arriving as mail, is
    # what resumes it.
    #
    # (`waiting` — 2026-09-05/06: out of the active count, its own idle-reminder
    # exemption, archived after an hour — was REMOVED as a state on 2026-09-07;
    # see `WORK_LEGACY_STATUSES` below for how the rows that still hold it read.)
    #
    # `deploy_ready` (user request 2026-09-08, relayed by coordinator-astra):
    # completed implementation awaiting deployment/publication. It exists
    # because that work was being asserted as `blocked` — which is wrong, since
    # nothing outside the item is what it is stuck on; it is finished and the
    # only remaining step is an act the owner cannot itself take (deploys are
    # the coordinator's alone). It is agent-assertable, it counts as ACTIVE
    # (not `WORK_UNCOUNTED`) and does not auto-archive (not
    # `WORK_ARCHIVES_ITSELF`) — same as `open`/`in_progress`/`review` — and,
    # unlike `blocked`, it IS nudged by the idle reminder: this is actionable
    # work with an owner who owes the next move (getting it in front of
    # whoever deploys), not work stuck on an external event.
    WORK_STATUSES: Final = ("backlogged", "open", "in_progress", "blocked",
                            "review", "deploy_ready", "done", "superseded",
                            "dropped")
    WORK_AGENT_STATUSES: Final = ("backlogged", "open", "in_progress",
                                  "blocked", "review", "deploy_ready",
                                  "dropped")
    WORK_CLOSED: Final = ("done", "superseded", "dropped")
    WORK_BACKLOG: Final = "backlogged"
    #: STATES THE PRODUCT NO LONGER ASSERTS, read as their replacement (user
    #: 2026-09-07 06:33Z: "remove waiting as a task state, and make blocked
    #: avoid periodic status nudges"). `waiting` duplicated `blocked` and was
    #: being used for internal dependencies. It cannot be asserted or created
    #: any more — the refusal names `blocked` — but the documents already
    #: holding it are NOT rewritten by a read:
    #:   · READ: `_work_status` serves a stored `waiting` as `blocked`; the
    #:     served `blocked_reason` falls back to the stored `waiting_reason`
    #:     (`_work_blocked_reason`); the row carries `legacy_status: "waiting"`
    #:     so a reader can tell; history stays exactly as written. Every
    #:     predicate that decides by status (counts, archiving, reminders, the
    #:     next-action recipient) reads the MAPPED status, so a legacy row
    #:     behaves as blocked everywhere: counted active, never ages out by
    #:     itself, never nudged.
    #:   · WRITE: the item's next `work_update` converts it in place — status
    #:     `blocked`, the waiting reason carried into `blocked_reason` unless
    #:     one is already there — and records the conversion in history. A
    #:     read never writes; nothing migrates the store wholesale.
    #:   · A physically archived legacy row stays archived; `reopen=true`
    #:     resumes it like any archived item.
    WORK_LEGACY_STATUSES: Final = {"waiting": "blocked"}
    #: STATE INFORMATION, state → the field that must carry it (user
    #: 2026-09-05). Entering one of these states requires the field; the other
    #: states require nothing. The field is cleared on the way out, so it never
    #: describes a state the item is no longer in.
    #
    # `dropped` (user 2026-09-05) is the TERMINAL NON-SUCCESS outcome: work
    # that was explicitly cancelled, or that failed in a way it cannot be
    # recovered from. It is closed, it archives AT ONCE (user 2026-09-07: "no
    # 1-hour timeout for them" — `_work_eligible`), and it is never Done —
    # which is the whole point of
    # having it, because without a documented way to end work unsuccessfully
    # the tidy path is `review` → accept, and the docket then records a
    # completion that never happened. Its reason says WHICH of the two it was.
    #: `waiting` stays in this map ONLY so a legacy row's `waiting_reason` is
    #: cleared when the row leaves that stored state (the conversion above
    #: copies it into `blocked_reason` first); nothing can enter it.
    WORK_STATE_INFO: Final = {"blocked": "blocked_reason",
                              "waiting": "waiting_reason",
                              "dropped": "dropped_reason"}
    WORK_EVIDENCE_KINDS: Final = ("note", "link", "file", "commit", "log")

    def _work_active(self) -> list[WorkItem]:
        return cast("list[WorkItem]", self.d.get("work_items") or [])

    def _work_status(self, it: Mapping[str, Any]) -> str:
        """The item's status AS THE PRODUCT READS IT: a stored legacy state is
        mapped to its replacement (`WORK_LEGACY_STATUSES`); everything else is
        served as stored. Every status-driven predicate goes through here."""
        raw = str(it.get("status") or "")
        return self.WORK_LEGACY_STATUSES.get(raw, raw)

    def _work_legacy_status(self, it: Mapping[str, Any]) -> str | None:
        raw = str(it.get("status") or "")
        return raw if raw in self.WORK_LEGACY_STATUSES else None

    def _work_blocked_reason(self, it: Mapping[str, Any]) -> str | None:
        """The served `blocked_reason`: the stored one, else — for a legacy
        `waiting` row read as blocked — the waiting reason it was recorded
        with, so the pane never shows a blocked row with its reason hidden in
        a field the reader no longer knows to look at."""
        own = it.get("blocked_reason")
        if own:
            return cast(str, own)
        if it.get("status") == "waiting":
            return cast("str | None", it.get("waiting_reason"))
        return cast("str | None", own)

    def _work_archive(self) -> list[WorkItem]:
        return cast("list[WorkItem]", self.d.get("work_items_archive") or [])

    def _work_actor(self, actor: str) -> WorkActor | str:
        """A node AT ITS GENERATION, or the literal user."""
        if actor == USER or actor not in self.nodes:
            return actor          # the user, or a system actor ("orgtree")
        n = self.node(actor)
        return {"node": actor, "generation": int(n.get("generation") or 0)}

    @staticmethod
    def _work_actor_node(a: Any) -> str | None:
        if isinstance(a, dict):
            return str(cast("dict[str, Any]", a).get("node") or "") or None
        return None

    # ---- THE SLUG IS THE IDENTITY (user ruling 2026-09-05: "docket items
    # should be uniquely and solely identifiable by their readable slugs, no
    # more ids of any sort"). There is ONE name for an item and it is readable:
    # `git-review-workspace`. The opaque `w########` key is gone — not hidden,
    # not aliased, not kept as a second lookup. `work_identity_migrate` below
    # converts a document written under the old scheme, once.
    #
    # A slug is assigned ONCE and never follows a later title edit: a name
    # people have already copied into mail must not silently start pointing at
    # nothing. That is what makes it usable as a key at all.
    #
    # ⚠ HISTORY IS NOT AN IDENTIFIER. `history` rows and org-log payloads
    # written before the migration still contain `w########` strings. They are
    # immutable evidence of what happened and are left exactly as they are —
    # but nothing resolves them any more, and nothing emits them as a current
    # reference.
    WORK_SLUG_MAX: Final = 48

    #: value of `OrgDoc["work_identity"]` once a document is slug-keyed. Its
    #: ABSENCE is what marks a document as still needing the migration, so it
    #: is written exactly once, in the same save as the conversion.
    WORK_IDENTITY_SLUG: Final = "slug"

    @staticmethod
    def _work_slugify(title: str) -> str:
        s = re.sub(r"[^a-z0-9]+", "-", str(title or "").lower()).strip("-")
        s = s[:Org.WORK_SLUG_MAX].strip("-")
        return s or "item"

    def _work_names_in_use(self, skip: WorkItem | None = None) -> set[str]:
        """Every string that already NAMES an item.

        Since the migration there is exactly one kind of name, so this is the
        set of slugs over ACTIVE AND ARCHIVE TOGETHER — an archived item keeps
        its name, and reusing it would make an old reference ambiguous.

        (It used to include opaque ids as well, because `_work_find` resolved
        an id first: a slug equal to some other item's id would have been
        permanently shadowed. There are no ids to shadow anything now.)"""
        names: set[str] = set()
        for it in self._work_active() + self._work_archive():
            if it is skip:
                continue
            if it.get("slug"):
                names.add(str(it["slug"]))
        # a DELETED item's name stays taken (user 2026-09-07): the record is
        # gone, but an old chip, closed ask or mail row may still carry the
        # name, and minting it again would make that reference point at a
        # different ticket. Names only — nothing of the ticket is retained.
        names.update(str(n) for n in (self.d.get("work_deleted_names") or []))
        return names

    def _work_unique_slug(self, title: str, taken: set[str]) -> str:
        """`base`, then `base-2`, `base-3`… Collisions are resolved against
        the ACTIVE AND ARCHIVED sets together: an archived item keeps its name,
        so reusing it would make an old reference ambiguous. `taken` must come
        from `_work_names_in_use`, which counts opaque ids as taken names."""
        base = self._work_slugify(title)
        if base not in taken:
            return base
        n = 2
        while f"{base}-{n}" in taken:
            n += 1
        return f"{base}-{n}"

    def _work_backfill_slugs(self) -> list[str]:
        """Give every slug-less item one. Called from `_work_sweep`, which
        runs at the head of every docket MUTATION — never from a read. A read
        that quietly rewrites the document is the defect this avoids: it would
        make `GET` a writer, race two viewers, and dirty documents nobody
        edited. Until the first mutation an old item simply has no slug and
        the UI shows its id; the backfill is not a migration and never runs
        against a document this process is not already about to save."""
        taken = self._work_names_in_use()
        done: list[str] = []
        for it in self._work_active() + self._work_archive():
            if it.get("slug"):
                continue
            s = self._work_unique_slug(str(it.get("title") or ""), taken)
            it["slug"] = s
            taken.add(s)
            done.append(s)
        return done

    #: shape of the retired opaque key. Used ONLY to add a sentence to a
    #: refusal that has already been decided — never to resolve anything.
    _WORK_OLD_ID = re.compile(r"^w[0-9a-f]{8}$")

    def _work_find(self, wid: str) -> tuple[WorkItem, bool]:
        """(item, physically_archived) by the item's slug — its only name.

        ⚠ THE EXACT SLUG IS TRIED FIRST, ALWAYS, AND THAT ORDERING IS THE
        WHOLE OF THE OLD-ID HANDLING. A legitimate title can slugify to
        something shaped exactly like a retired id — `_work_slugify("W12345678")`
        is `"w12345678"` — so refusing id-shaped references up front would
        strand a real item behind a regex (Astra review 2026-09-05). Because
        the lookup runs first, by the time the shape is consulted the string is
        already known not to name anything; the pattern then only decides
        whether the reader gets an extra sentence of guidance.

        There is no id→slug table, by instruction and by preference: a stale
        reference must fail loudly rather than resolve to a guess."""
        ref = str(wid or "")
        for it in self._work_active():
            if it.get("slug") == ref:
                return it, False
        for it in self._work_archive():
            if it.get("slug") == ref:
                return it, True
        if self._WORK_OLD_ID.match(ref):
            raise LedgerError(
                f"{ref!r} is an old-style opaque item id, and items are now "
                f"named only by their readable slug. Old ids are not "
                f"translated — run `orgtree_work list` and use the name shown "
                f"(there is no item called {ref!r} either)")
        raise LedgerError(f"no work item {wid!r}")

    # ---------------------------------------------------------------- migration
    def work_identity_state(self) -> str:
        """`"slug"` when the RECORDS are wholly slug-keyed, `"legacy"` when
        anything still needs converting.

        ⚠ DERIVED FROM THE RECORDS; the durable marker is NOT consulted. A
        marker can outlive the records it describes — an old-build round trip
        or a partial restore leaves one set over an unconverted child — and a
        state that trusts it serves mixed identity.

        ⚠ AND POINTERS ARE NOT EVIDENCE EITHER. A pointer is only ever
        canonical-or-dead: it names an item that exists, or it names nothing.
        Judging one by SHAPE repeats the mistake `_work_find` exists to avoid —
        a real item can be named `w1234abcd`, so a parent pointing at it would
        read as "unconverted" forever, 409 every read, and drive a migration
        that has nothing to convert. A dangling pointer is a data defect that
        `_work_view` already reports as an invisible dependency; it is not an
        identity state.

        What DOES make a document legacy: an item still carrying the retired
        key, an item with no name, or two items answering to the same name.
        The last one must be caught here, or a duplicate reaches
        `work_identity_migrate`'s refusal only by luck. No items at all is
        `slug`."""
        names: set[str] = set()
        for it in self._work_all():
            if "id" in it:
                return "legacy"          # old identity, definitively
            name = str(it.get("slug") or "")
            if not name:
                return "legacy"          # unnamed: nothing can reference it
            if name in names:
                return "legacy"          # ambiguous: two items answer to one
            names.add(name)
        return self.WORK_IDENTITY_SLUG

    def _work_require_current_identity(self) -> None:
        """Refuse a docket WRITE while the document still holds old-style
        identity. Reads refuse in the API layer; this is the write side, and
        it is deliberately in the ledger so no route can miss it."""
        if self.work_identity_state() != self.WORK_IDENTITY_SLUG:
            raise LedgerError(
                "this docket still holds old-style opaque item ids and cannot "
                "be written to until it is converted — the caller must run "
                "the identity migration inside its own lock and save before "
                "mutating (see api._work_identity_ready)")

    def _work_all(self) -> list[WorkItem]:
        """Active then archive, in stored order — the order the migration
        walks, so two runs on the same document name things identically."""
        return self._work_active() + self._work_archive()

    def work_identity_migrate(self) -> dict[str, Any] | None:
        """Convert this document to slug-only identity. `None` when it is
        already converted, which is what makes a second pass a no-op.

        ⚠ THIS FUNCTION ONLY EDITS THE IN-MEMORY DOCUMENT. It takes no lock,
        writes nothing and backs nothing up — its caller does all three, in
        one locked write, so a failure anywhere below leaves the stored
        document exactly as it was. It also cannot call the store: `store`
        imports `ledger`, so a backup taken from in here would be an import
        cycle as well as a save inside a save.

        ORDER IS LOAD-BEARING:
          1. every EXISTING slug is preserved and reserved first, globally
             across active and archive, before anything is minted. Established
             names are what other people have already written down; a
             migration that renamed one to resolve a collision would break
             references that were correct.
          2. only then are missing slugs minted, deterministically.
          3. only then are stored pointers rewritten — doing it earlier would
             strand pointers at items whose names had not been minted yet.
          4. only then is the opaque key dropped.

        Raises rather than half-converting: a document with two items already
        carrying the same slug is refused, because either answer (rename one,
        or let one shadow the other) silently breaks a live reference."""
        if self.work_identity_state() == self.WORK_IDENTITY_SLUG:
            return None

        items = self._work_all()

        # (1) existing names win, and duplicates among them are a refusal
        taken: set[str] = set()
        for it in items:
            s = str(it.get("slug") or "")
            if not s:
                continue
            if s in taken:
                raise LedgerError(
                    f"cannot convert this docket to slug-only identity: two "
                    f"items already carry the slug {s!r}. Refusing rather than "
                    f"renaming one — an established name is a reference "
                    f"somebody has already written down. Rename one item's "
                    f"slug by hand, then run this again")
            taken.add(s)

        # (2) mint the missing ones, in stored order so this is reproducible
        minted: dict[str, str] = {}
        for it in items:
            if it.get("slug"):
                continue
            s = self._work_unique_slug(str(it.get("title") or ""), taken)
            it["slug"] = s
            taken.add(s)
            minted[str(it.get("id") or "")] = s

        # the old key → the name that replaces it. Built over EVERY item, not
        # just the newly named ones, because a pointer may name an item that
        # already had a slug.
        by_old: dict[str, str] = {}
        for it in items:
            old = str(it.get("id") or "")
            if old:
                by_old[old] = str(it["slug"])

        # (3) rewrite every stored pointer. `dangling` is REPORTED, never
        # guessed at and never silently dropped: a pointer we cannot resolve
        # is left exactly as written so a human can see what it said.
        dangling: list[dict[str, str]] = []

        def repoint(ref: Any, where: str, owner: str) -> str:
            r = str(ref or "")
            if not r:
                return r
            if r in by_old:
                return by_old[r]
            if r in taken:
                return r            # already a slug — nothing to do
            dangling.append({"ref": r, "in": where, "item": owner})
            return r

        for it in items:
            me = str(it["slug"])
            deps = it.get("dependencies")
            if isinstance(deps, list):
                it["dependencies"] = [repoint(d, "dependencies", me) for d in deps]
            if it.get("superseded_by"):
                it["superseded_by"] = repoint(
                    it["superseded_by"], "superseded_by", me)
            if it.get("parent"):
                it["parent"] = repoint(it["parent"], "parent", me)

        # stored question batches and their per-card roll-up, on the asks list
        # and on every node's live ask alike
        for a in list(self.d.get("asks") or []):
            self._work_repoint_ask(a, repoint)
        for n in self.nodes.values():
            if isinstance(n.get("ask"), dict):
                self._work_repoint_ask(n["ask"], repoint)

        # (4) the opaque key goes. Nothing above may read it after this point.
        for it in items:
            it.pop("id", None)       # type: ignore[misc]

        self.d["work_identity"] = self.WORK_IDENTITY_SLUG   # type: ignore[typeddict-unknown-key]
        report = {"items": len(items), "minted": minted,
                  "dangling": dangling}
        self._log("work_identity_migrate", "orgtree", report, [])
        return report

    @staticmethod
    def _work_repoint_ask(a: dict[str, Any],
                          repoint: Callable[[Any, str, str], str]) -> None:
        """One ask card's docket pointers: the per-tab `work_item` and the
        card-level `work_items` roll-up the UI filters on. Both are rewritten,
        because a card that agreed with its tabs before must still agree."""
        for q in (a.get("questions") or []):
            if isinstance(q, dict) and q.get("work_item"):
                q["work_item"] = repoint(q["work_item"], "ask.work_item",
                                         str(a.get("id") or "?"))
        if a.get("work_item"):
            a["work_item"] = repoint(a["work_item"], "ask.work_item",
                                     str(a.get("id") or "?"))
        if isinstance(a.get("work_items"), list):
            a["work_items"] = sorted({
                repoint(w, "ask.work_items", str(a.get("id") or "?"))
                for w in a["work_items"]})

    # ---- authority. Explicit, never org-wide: nothing in an item is public.
    def _work_can_manage(self, actor: str, it: WorkItem) -> bool:
        """Owner-level right: the user, the owner node, the creator node, or
        a strict ancestor of the owner (of the creator while unowned)."""
        if actor == USER:
            return True
        owner = self._work_actor_node(it.get("owner"))
        creator = self._work_actor_node(it.get("created_by"))
        if actor in (owner, creator):
            return True
        anchor = owner or creator
        return bool(anchor) and anchor in self.nodes \
            and self.is_ancestor(actor, cast(str, anchor))

    def _work_can_read(self, actor: str, it: WorkItem) -> bool:
        """Manage right, explicit participant membership — the narrow
        collaboration path (Astra 2026-09-05): a participant may read, post
        status updates and evidence, and attach questions; nothing else — or
        being the item's NAMED REVIEWER, which is narrower still: read,
        evidence and the review decision, and no status update at all (a status
        update claims the item, and reviewing is not owning)."""
        return self._work_can_manage(actor, it) \
            or actor in (it.get("participants") or []) \
            or actor == self._work_actor_node(it.get("reviewer"))

    def _work_can_accept(self, actor: str, it: WorkItem) -> bool:
        """The user, a strict ancestor of the owner, or the item's NAMED
        REVIEWER — never the owner.

        The reviewer joined this set on the user's ruling (2026-09-05 21:26):
        a named reviewer's approval completes the item, with no separate
        superior acceptance behind it. The owner is still excluded, and since
        reviewer≠owner is enforced both when the reviewer is named and again
        when it decides, the exclusion cannot be walked around by naming
        yourself."""
        if actor == USER:
            return True
        if actor == self._work_actor_node(it.get("reviewer")) \
                and actor != self._work_actor_node(it.get("owner")):
            return True
        anchor = self._work_actor_node(it.get("owner")) \
            or self._work_actor_node(it.get("created_by"))
        return bool(anchor) and actor != anchor and anchor in self.nodes \
            and self.is_ancestor(actor, cast(str, anchor))

    def _work_get_for(self, actor: str, wid: str) -> tuple[WorkItem, bool]:
        """The item, or ONE refusal for both "no such item" and "not yours"
        — a distinct message would confirm a hidden item exists.

        ⚠ THE STALE-ID SENTENCE IS ADDED FROM THE SHAPE OF THE STRING, NEVER
        FROM A LOOKUP, so it is identical whether the reference names nothing
        or names something this actor may not read. That is what keeps the two
        cases indistinguishable while still telling an agent holding a retired
        id what actually went wrong (it would otherwise be told only that the
        item does not exist "or is not yours", which is true and useless)."""
        ref = str(wid or "").strip()
        try:
            it, arch = self._work_find(ref)
        except LedgerError:
            it = None            # type: ignore[assignment]
            arch = False
        if it is None or not self._work_can_read(actor, it):
            hint = ""
            if self._WORK_OLD_ID.match(ref):
                hint = (" — and note that this is shaped like a retired "
                        "opaque item id: items are named only by their "
                        "readable slug now, and old ids are not translated")
            raise LedgerError(
                f"no work item {str(wid)[:20]!r} that you may read — it does "
                f"not exist, or you are neither its owner, its creator, a "
                f"superior of those, nor a listed participant{hint}")
        return it, arch

    # ---- derived state
    def _work_questions(self, wid: str) -> list[dict[str, Any]]:
        """OPEN asks with at least one tab attached to `wid` — one entry per
        asker, read from the ask store itself so a withdrawn, answered,
        dismissed or mooted request drops out by itself. Nothing is cached."""
        out: list[dict[str, Any]] = []
        for a in self.d.get("asks", []):
            if a.get("status") != "open":
                continue
            tabs = [{"index": i, **{k: q[k] for k in
                                    ("question", "header", "options", "multi")
                                    if k in q}}
                    for i, q in enumerate(cast("list[dict[str, Any]]",
                                               a.get("questions") or []))
                    if q.get("work_item") == wid]
            if tabs:
                out.append({"ask_id": a["id"], "node": a["node"],
                            "rev": int(a.get("rev") or 1),
                            "at": a.get("at"), "tabs": tabs})
        return out

    def _work_attention(self, it: WorkItem) -> list[str]:
        src: list[str] = []
        if it.get("manual_attention"):
            src.append("manual")
        if self._work_questions(it["slug"]):
            src.append("question")
        return src

    @staticmethod
    def _work_age_s(it: WorkItem, now_ts: float) -> float | None:
        stamp = it.get("docket_at") or it.get("updated_at")
        if not stamp:
            return None
        try:
            dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return now_ts - dt.timestamp()

    @staticmethod
    def _work_recovery_age_s(it: WorkItem, now_ts: float) -> float | None:
        stamps = [it.get("docket_at"), it.get("updated_at")]
        parsed = []
        for stamp in stamps:
            if not stamp:
                continue
            try:
                dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            parsed.append(dt.timestamp())
        return None if not parsed else now_ts - max(parsed)

    #: statuses the sweep archives by itself. `dropped` joined `done`
    #: (user 2026-09-05, Astra 2026-09-05): work that was cancelled or failed
    #: unrecoverably is as finished as work that succeeded, and leaving only
    #: the successful kind to archive itself meant every dead item stayed on
    #: the main list for good. Superseded records are closed historical
    #: pointers and age out like done records; their status and replacement
    #: link remain intact when archived.
    #: `waiting` LEFT this tuple with the state itself (user 2026-09-07): a
    #: legacy row reads as blocked, and blocked never ages out by itself.
    WORK_ARCHIVES_ITSELF: Final = ("done", "superseded", "dropped")
    #: …and of those, the statuses that archive THE MOMENT they are set, with
    #: no clock at all (user 2026-09-07: "dropped tasks should be immediately
    #: archived, no 1-hour timeout for them"). Dead work has nothing left to
    #: show on the active docket; the hour was only ever a grace for work that
    #: might still be looked at. `done` and `waiting` keep the hour unchanged.
    #: Because archival is DERIVED on read, an item dropped before this rule
    #: existed reads as archived at once too, and the next sweep moves it.
    #:
    #: Manual attention still prevents archival for non-closed rows. Closed
    #: rows follow their status clock while retaining the attention flag and
    #: linked questions/notices in the archived record.
    WORK_ARCHIVES_AT_ONCE: Final = ("dropped",)

    def _work_eligible(self, it: WorkItem, now_ts: float) -> bool:
        """Ages out of the main list: `done`, whose docket update is STRICTLY
        older than one hour; or `dropped`, which is eligible the instant it is
        set. Nothing else archives itself (a legacy `waiting` row reads as
        blocked and so never does)."""
        status = self._work_status(it)
        if status not in self.WORK_ARCHIVES_ITSELF:
            return False
        if status in self.WORK_ARCHIVES_AT_ONCE:
            return True
        age = self._work_age_s(it, now_ts)
        return age is not None and age > self.WORK_ARCHIVE_AFTER_S

    def _work_archived_why(self, it: WorkItem) -> str:
        """The reason an archived item is archived, in the item's OWN terms —
        never "done" for work that was not, never "over an hour" for work
        that archives at once."""
        status = self._work_status(it)
        if status in self.WORK_ARCHIVES_AT_ONCE:
            return f"{status} — a {status} item archives at once"
        return f"{status} for over an hour"

    def _work_archived(self, it: WorkItem, physically: bool,
                       now_ts: float) -> bool:
        if self._work_status(it) in self.WORK_CLOSED:
            return physically or self._work_eligible(it, now_ts)
        if self._work_attention(it):
            return False
        return physically or self._work_eligible(it, now_ts)

    def _work_backlogged(self, it: WorkItem) -> bool:
        """In the HIDDEN backlog group? Backlogged AND attention-free — the
        same shape as `_work_archived`, and for the same reason: a row the
        badge is counting must be reachable without first guessing which
        checkbox hides it, so a backlogged item holding a question or a manual
        flag stays in the main list. Physical archival is not consulted
        because the sweep never moves a backlogged item — it moves the statuses
        in `WORK_ARCHIVES_ITSELF`, and `backlogged` is not one of them."""
        return it.get("status") == self.WORK_BACKLOG \
            and not self._work_attention(it)

    #: statuses the `active` count does NOT count: closed work is finished,
    #: `backlogged` was never approached, and `waiting` is somebody else's move
    #: (user 2026-09-06). ONE tuple, because the rule is written in two places —
    #: `_work_counts_active` for the org-wide number and `work_list` for a
    #: single viewer's readable set — and two copies are two chances to
    #: disagree about what the same number means.
    WORK_UNCOUNTED: Final = (*WORK_CLOSED, WORK_BACKLOG)

    def _work_counts_active(self, it: WorkItem) -> bool:
        """Does this item belong to the `active` number — work that needs
        somebody to act?

        The exclusions are decided HERE rather than by leaning on
        `_work_backlogged` / `_work_archived`, because those answer a different
        question — which LIST a row is served in. An attention-holding
        backlogged row is deliberately shown in the main list, and a done row
        stays in the main list for its first hour; being visible is not the same
        as being in flight, and this number means the latter."""
        return self._work_status(it) not in self.WORK_UNCOUNTED

    def _work_sweep(self, now_ts: float | None = None) -> list[str]:
        """Physically move eligible, attention-free items into the archive —
        done or waiting for over an hour, dropped at once. Called at the head
        of every docket mutation; a read never writes. Returns the moved ids
        (logged, never silent). The move is a change of LIST, never of state:
        no status is rewritten on the way in."""
        # ⚠ Refused HERE, at the head of every mutation, so no route has to
        # remember to convert first: a half-converted document 409s on its
        # next read. Routes that mutate work fields directly bypass this and
        # must call `api._work_identity_ready` themselves.
        self._work_require_current_identity()
        now_ts = _time.time() if now_ts is None else now_ts
        named = self._work_backfill_slugs()
        if named:
            self._log("work_slugs", "orgtree",
                      {"slugs": named, "why": "backfilled on the next write"}, [])
        active = self._work_active()
        moved: list[str] = []
        # ⚠ THE OUTCOME IS RECORDED PER ITEM, not asserted once for the batch.
        # This line used to say "done for over an hour" for everything it
        # swept, which was true while `done` was the only status that archived
        # itself; a cancelled or failed item is swept too (at once, since
        # 2026-09-07 — no clock at all), so a single phrase would write "done"
        # into the durable org log about work that was never completed. A
        # waiting item ages out as well, so the batch phrase cannot say
        # "closed" either.
        outcomes: dict[str, str] = {}
        for it in list(active):
            if self._work_eligible(it, now_ts):
                active.remove(it)
                it["archived_at"] = now()
                self.d.setdefault("work_items_archive", []).append(it)
                moved.append(it["slug"])
                outcomes[it["slug"]] = self._work_status(it)
        if moved:
            self._log("work_archived", "orgtree",
                      {"items": moved,
                       "why": "eligible: over an hour since the last docket "
                              "update, or dropped (at once) — see outcomes",
                       "outcomes": outcomes}, [])
        return moved

    def _work_owner_state(self, it: WorkItem) -> tuple[bool, str | None]:
        o = it.get("owner")
        if not isinstance(o, dict):
            return False, None
        n = self.nodes.get(str(o.get("node")))
        if n is None:
            return False, "missing"
        if n.get("state") != "live":
            return False, "retired"
        if int(n.get("generation") or 0) != int(o.get("generation") or 0):
            return False, "generation moved"
        return True, "live"

    def _work_node_reply_state(self, nid: str) -> str:
        """One of 'live' | 'retired' | 'missing' — the SAME convention
        `_work_owner_state` uses: a node that is absent from the table is
        missing; one that is present but not live (archived, paused, armed,
        unrecoverable) is retired. A retired lineage predecessor is absent
        from the TREE (`org_children` skips archived predecessors) but present
        HERE, which is why the panel asks the item and not the tree."""
        n = self.nodes.get(nid)
        if n is None:
            return "missing"
        return "live" if n.get("state") == "live" else "retired"

    def _work_reply_recipients(self, it: WorkItem) -> list[dict[str, Any]]:
        """Who the user may address a reply to, served with the item: the
        owner first (when there is one), then the stored participants in
        stored order, the owner deduped out. Derived on read from the CURRENT
        node table — never stored — so a rename, retirement or deletion is
        reflected the next time the item is read. The write side
        (`work_reply_target`) re-derives the same set under the lock; this
        list is what the panel shows, not what it is trusted with."""
        out: list[dict[str, Any]] = []
        own = self._work_actor_node(it.get("owner"))
        if own:
            out.append({"node": own, "role": "owner",
                        "state": self._work_node_reply_state(own)})
        seen = {own} if own else set()
        for p in it.get("participants") or []:
            pid = str(p or "")
            if not pid or pid in seen:
                continue
            seen.add(pid)
            out.append({"node": pid, "role": "participant",
                        "state": self._work_node_reply_state(pid)})
        return out

    def _work_delivery_view(self, it: WorkItem) -> dict[str, Any] | None:
        """The stored stages, each verified one marked against what `verify`
        would compare with NOW. The stored receipt (verified/detail/target/
        observed_at) is history and stays verbatim; the derived fields say
        whether it still describes the running build:

          evaluated_against_current_build  True  — same build identity
                                           False — the build changed (a new
                                                   commit, OR the same sha
                                                   booted dirty); re-verify
                                           None  — not an in_build result, or
                                                   never verified
          verified_current  the receipt's `verified` while current, else None

        No git on a read path: the boot identity is frozen at process start
        (restart_wake), and `pushed` is NOT re-compared here because that
        would cost a rev-parse per read — its receipt already names the
        tracking-ref OID it was measured against."""
        d = it.get("delivery")
        if d is None:
            return None
        from . import workitems       # noqa: PLC0415
        cur = workitems.build_identity()
        out: dict[str, Any] = {}
        for stage, st in cast("dict[str, Any]", d).items():
            if not st:
                out[stage] = None
                continue
            row = dict(cast("dict[str, Any]", st))
            current: bool | None = None
            if stage == "in_build" and row.get("method") == "boot-ancestry" \
                    and row.get("target"):
                current = bool(cur) and row.get("target") == cur
            row["evaluated_against_current_build"] = current
            row["verified_current"] = (row.get("verified") if current else None)
            out[stage] = row
        return out

    def _work_view(self, it: WorkItem, physically: bool, viewer: str,
                   now_ts: float) -> dict[str, Any]:
        """The wire shape (evidence/docket-wire-contract-v3.md).

        ⚠ AN UNREADABLE DEPENDENCY IS NOW ANONYMOUS. It used to come back as
        `{id, visible: false}` — safe, because an opaque id carries no title,
        status or owner. THE NAME IS DERIVED FROM THE TITLE, so serving it in
        that slot would disclose the title of an item the viewer is not
        allowed to read. The viewer still learns that a dependency exists and
        that it is not theirs to see; it no longer learns what it is called
        (user ruling on slug-only identity + Astra 2026-09-05)."""
        cur, ostate = self._work_owner_state(it)
        sources = self._work_attention(it)
        deps: list[dict[str, Any]] = []
        for did in it.get("dependencies") or []:
            try:
                d, _ = self._work_find(did)
            except LedgerError:
                deps.append({"visible": False})
                continue
            if self._work_can_read(viewer, d):
                deps.append({"slug": d["slug"], "visible": True,
                             "title": d["title"], "status": d["status"]})
            else:
                deps.append({"visible": False})
        return {
            "slug": it.get("slug"),
            **{k: it.get(k) for k in (
                "rev", "kind", "title", "objective", "status",
                "owner", "reviewer", "created_by", "at", "updated_at", "done_so_far",
                "working_on_next", "docket_at", "last_updater",
                "manual_attention", "acceptance", "evidence",
                "accepted")},
            # ⚠ DERIVED ON READ FOR OLDER ITEMS, never written back. Deriving
            # in place would stamp a "state changed" time onto items during an
            # ordinary read, which is a durable claim made by a viewer.
            "status_at": self._work_status_at(it),
            "history": self._work_history_view(it, viewer),
            # SAME DISCLOSURE RULE AS `dependencies`, for the same reason:
            # this pointer used to be an opaque id and is now a title-derived
            # name, so it is served only to a viewer who may read what it
            # names. `superseded_by_visible` still says a pointer exists.
            "superseded_by": (
                it.get("superseded_by")
                if self._work_pointer_visible(it.get("superseded_by"), viewer)
                else None),
            # SAME DISCLOSURE RULE AGAIN: a parent's name is derived from its
            # title. A viewer who may not read the parent is told a parent
            # EXISTS — so the row does not silently read as top-level work —
            # and not what it is called.
            "parent": (
                it.get("parent")
                if self._work_pointer_visible(it.get("parent"), viewer)
                else None),
            "parent_visible": self._work_pointer_visible(
                it.get("parent"), viewer),
            "delivery": self._work_delivery_view(it),
            # the status AS READ (a stored legacy `waiting` is served as
            # blocked, with the reason it was recorded with) and, when that
            # mapping applied, the word it was stored under
            "status": self._work_status(it),
            "legacy_status": self._work_legacy_status(it),
            "blocked_reason": self._work_blocked_reason(it),
            "waiting_reason": it.get("waiting_reason"),
            "dropped_reason": it.get("dropped_reason"),
            "participants": list(it.get("participants") or []),
            # who a reply may be addressed to (user 2026-09-06): owner first,
            # then participants, each with a server-derived node state
            "reply_recipients": self._work_reply_recipients(it),
            "dismissals": list(it.get("dismissals") or []),
            "archived": self._work_archived(it, physically, now_ts),
            "archived_at": it.get("archived_at"),
            "owner_current": cur, "owner_state": ostate,
            "questions": self._work_questions(it["slug"]),
            "superseded_by_visible": self._work_pointer_visible(
                it.get("superseded_by"), viewer),
            "effective_attention": bool(sources),
            "attention_sources": sources,
            "dependencies": deps,
        }

    #: history-row fields that NAME ANOTHER WORK ITEM, PER OPERATION. Since
    #: the name is derived from the title, each one is a disclosure and is
    #: gated exactly like `superseded_by`, `parent` and `dependencies` are.
    #:
    #: ⚠ PER OPERATION, NOT A FLAT FIELD LIST. `from`/`to` name items on a
    #: `move` row and name STATUSES on an update row — a flat list would try
    #: to resolve "in_progress" as an item, fail, and redact a status nobody
    #: was protecting. The narrow map is what keeps the redaction meaning what
    #: it says.
    _WORK_HIST_POINTERS: Final = {"supersede": ("by",),
                                  "move": ("from", "to")}

    def _work_history_view(self, it: WorkItem,
                           viewer: str) -> list[dict[str, Any]]:
        """`history`, with any pointer at an item this viewer may not read
        replaced by `null`.

        ⚠ A NAME IS A TITLE. Every field that can hold one is gated, not
        just the obvious ones — `superseded_by` was gated while the same name
        left unchecked in `history[].by`."""
        out: list[dict[str, Any]] = []
        for row in (it.get("history") or []):
            if not isinstance(row, dict):
                out.append(row)
                continue
            red = dict(cast("dict[str, Any]", row))
            for f in self._WORK_HIST_POINTERS.get(str(red.get("op") or ""), ()):
                if red.get(f) and not self._work_pointer_visible(red[f], viewer):
                    red[f] = None
            out.append(red)
        return out

    def _work_pointer_visible(self, wid: Any, viewer: str) -> bool | None:
        """May `viewer` read the item a pointer names? None when no pointer.

        Callers use this to decide whether to serve the NAME at all: a name is
        derived from a title, so an unreadable pointer is served anonymously."""
        if not wid:
            return None
        try:
            t, _ = self._work_find(str(wid))
        except LedgerError:
            return False
        return self._work_can_read(viewer, t)

    def work_counts(self, now_ts: float | None = None) -> dict[str, int]:
        """The toolbar badge's two numbers (+ the archive and backlog sizes),
        over the FULL item set. `attention` counts items, never questions.

        `active` EXCLUDES backlogged and waiting items (`WORK_UNCOUNTED`) —
        work nobody has approached, and work whose next move belongs to an
        outside event, are not work in flight — but `attention` does not: a
        backlogged or waiting item that holds a question or a manual flag still
        lights the badge, because the badge must never point at something the
        user cannot then find. Both stay READABLE in the docket either way;
        what changes is only the number. The UI reveals such a row by its own
        rule; see `work_list`."""
        now_ts = _time.time() if now_ts is None else now_ts
        attention = active = archived = backlogged = 0
        for it, phys in ([(i, False) for i in self._work_active()]
                         + [(i, True) for i in self._work_archive()]):
            if self._work_attention(it):
                attention += 1
            if self._work_archived(it, phys, now_ts):
                archived += 1
            elif self._work_backlogged(it):
                backlogged += 1
            elif self._work_counts_active(it):
                active += 1
        return {"attention": attention, "active": active,
                "archived": archived, "backlogged": backlogged}

    def _work_next_recipient(self, it: WorkItem) -> tuple[str | None, str]:
        """THE canonical next-action recipient of one item, and the ROLE that
        answer was reached by — who owes the next move, not who is interested.

        An item in `review` is owed by its REVIEWER: the owner has handed it
        over and cannot take the next step. A `review` item with NO reviewer
        recorded falls back to the OWNER under the role `unassigned_review`,
        because the outstanding action there is NAMING a reviewer, which only
        the owner side can do — the caller must word that as a missing review
        assignment and never as "review your own work" (Astra 2026-09-05;
        self-review is prohibited). Every other status is owed by the owner.

        A reviewer that is GONE — retired, or no longer a node at all — is
        treated as no reviewer, under its own role `stale_reviewer`. Otherwise
        the item would name a recipient the reminder pass never wakes (retired
        seats are excluded there), and it would quietly stop reaching anybody
        at all: a review nobody is doing and nobody is asked about. The owner
        is asked to name another instead.

        ⚠ Ownership and reviewership both ignore GENERATION: a compaction or
        rehire replaces the agent, not the assignment. Being RETIRED is a
        different thing from a moved generation and is the only state checked
        here. `reviewer` is codex-sandbox's field and may be absent on items
        written before it exists; absent reads exactly like null.
        """
        owner = self._work_actor_node(it.get("owner"))
        if it.get("status") == "review":
            rv = self._work_actor_node(it.get("reviewer"))
            if rv and (self.nodes.get(rv) or {}).get("state") != "live":
                return owner, "stale_reviewer"
            if rv:
                return rv, "reviewer"
            return owner, "unassigned_review"
        return owner, "owner"

    def work_blocked_only(self, nid: str) -> bool:
        """Does this agent's docket consist ONLY of blocked work — nothing it
        could act on right now? THE PREDICATE THE WORKING-STATUS CHECKUP
        CONSULTS (user 2026-09-07: blocked tasks must not generate periodic
        status nudges; coordinator 2026-09-07: the idle-docket exclusion alone
        did not prove that, because an agent whose last report was `working`
        was still woken by the independent checkup).

        The items considered are the ones this agent OWES the next action on
        (`_work_next_recipient`) and that count as active — the same set the
        idle reminder draws from before its own exclusions. Three answers:
          · no such items at all → False: an agent working with no docket
            keeps its checkup (the docket is not the only work there is);
          · every one of them reads as blocked (`_work_status`, so a legacy
            waiting row counts) → True: nothing the checkup could prompt;
          · anything actionable beside the blocked ones → False: the
            actionable work still earns the check.
        Attention-holding rows are not special-cased: a blocked row waiting
        on the user is still blocked, and an in_progress row holding a flag is
        still the agent's actionable work for this question."""
        owed = [it for it in self._work_active()
                if it.get("slug") and self._work_counts_active(it)
                and self._work_next_recipient(it)[0] == nid]
        if not owed:
            return False
        return all(self._work_status(it) == "blocked" for it in owed)

    def work_idle_reminder_items(self, nid: str) -> list[dict[str, str]]:
        """Items this node owes the next action on, for the idle-reminder wake.

        ⚠ THE EXCLUSIONS ARE DECIDED PER ITEM, BEFORE the recipient is even
        asked for: in flight (`_work_counts_active`), not `waiting` on an
        external event, not waiting on the USER (`_work_attention`). An item
        that is excluded therefore removes ITSELF and nothing else — it can
        never silence a different actionable item held by the same agent.

        The recipient then comes from `_work_next_recipient`, so the clock this
        list is gated by is the RECIPIENT's own idle clock — for an item under
        review that is the reviewer's, not the owner's.
        """
        out: list[dict[str, str]] = []
        for it in self._work_active():
            if not it.get("slug"):
                continue        # pre-slug document: named on its next write
            if not self._work_counts_active(it) or self._work_attention(it):
                continue
            if self._work_status(it) == "blocked":
                # BLOCKED IS NEVER NUDGED (user 2026-09-07: "make blocked avoid
                # periodic status nudges"): the item says what it is stuck on
                # and who can act; waking its owner every twenty minutes to
                # re-read that is pointless work. The row is excluded HERE,
                # per item — an owner with actionable items beside a blocked
                # one is still woken for those, and an owner whose every item
                # is blocked gets no reminder at all. Resumption is the
                # answer or event itself, delivered as mail.
                continue
            who, role = self._work_next_recipient(it)
            if who != nid:
                continue
            out.append({"slug": str(it.get("slug") or ""),
                        "title": str(it.get("title") or ""),
                        "status": str(it.get("status") or ""),
                        "role": role})
        return sorted(out, key=lambda r: r["slug"])

    def work_list(self, viewer: str, include_archived: bool = False,
                  now_ts: float | None = None,
                  include_backlogged: bool = False) -> dict[str, Any]:
        """Every item the viewer may read, split into THREE disjoint groups —
        the main list, the derived archive, and the derived backlog — newest
        docket update first within each. Counts are over the viewer's READABLE
        set: an agent must not learn from a number that a hidden item exists
        (Astra review 2026-09-05); the user's counts are the org's.

        Ordering is TOTAL, not merely "newest first": ties on `docket_at`
        break on the item id, so two items stamped in the same clock tick come
        back in the same order on every poll instead of shuffling under the
        user's cursor between two five-second refreshes."""
        now_ts = _time.time() if now_ts is None else now_ts
        items: list[dict[str, Any]] = []
        arch: list[dict[str, Any]] = []
        back: list[dict[str, Any]] = []
        for it, phys in ([(i, False) for i in self._work_active()]
                         + [(i, True) for i in self._work_archive()]):
            if not self._work_can_read(viewer, it):
                continue
            v = self._work_view(it, phys, viewer, now_ts)
            if v["archived"]:
                arch.append(v)
            elif self._work_backlogged(it):
                back.append(v)
            else:
                items.append(v)

        def key(v: dict[str, Any]) -> tuple[str, str]:
            # `reverse=True` applies to the WHOLE tuple, so a docket_at tie
            # breaks on the NAME descending. Which direction it runs does not
            # matter; that it is total and stable does, because that is what
            # stops two rows trading places between polls.
            #
            # ⚠ THIS TIEBREAK USED TO READ `id`. When the opaque key was
            # retired, `v.get("id")` quietly became "" for every row — the
            # comparison still ran, still looked total, and had silently
            # degenerated into "whatever order the list happened to be in".
            # Caught by the tie test, not by reading.
            return (str(v.get("docket_at") or v.get("updated_at") or ""),
                    str(v.get("slug") or ""))
        items.sort(key=key, reverse=True)
        arch.sort(key=key, reverse=True)
        back.sort(key=key, reverse=True)
        counts = (self.work_counts(now_ts) if viewer == USER else {
            "attention": sum(1 for v in items + arch + back
                             if v["effective_attention"]),
            "active": sum(1 for v in items
                          if v["status"] not in self.WORK_UNCOUNTED),   # v: served (mapped) status
            "archived": len(arch),
            "backlogged": len(back)})
        out: dict[str, Any] = {"items": items, "counts": counts, "now": now()}
        if include_archived:
            out["archived"] = arch
        if include_backlogged:
            out["backlogged"] = back
        return out

    def work_get(self, viewer: str, wid: str,
                 now_ts: float | None = None) -> dict[str, Any]:
        it, phys = self._work_get_for(viewer, wid)
        return self._work_view(it, phys, viewer,
                               _time.time() if now_ts is None else now_ts)

    # ---- mutation plumbing
    def _work_hist(self, it: WorkItem, actor: str, op: str,
                   detail: dict[str, Any]) -> None:
        """Append a history row and bump rev/updated_at. Past the cap the
        OLDEST rows fold into one disclosure row kept at the head — a count
        and a span, so the omission is visible, never silent."""
        hist = it.setdefault("history", [])
        hist.append({"at": now(), "by": self._work_actor(actor), "op": op,
                     **detail})
        if len(hist) > self.WORK_HISTORY_MAX:
            head = hist[0] if hist and hist[0].get("kind") == "folded" else None
            keep_from = len(hist) - self.WORK_HISTORY_MAX + 1
            folded = hist[(1 if head else 0):keep_from]
            if folded:
                row = head or {"kind": "folded", "count": 0,
                               "first_at": folded[0]["at"], "last_at": ""}
                row["count"] = int(row.get("count") or 0) + len(folded)
                row["last_at"] = folded[-1]["at"]
                row["note"] = ("older history rows summarised — a lossy "
                               "omission by count, not a deletion of the item")
                it["history"] = [row] + hist[keep_from:]
        it["rev"] = int(it.get("rev") or 0) + 1
        it["updated_at"] = now()

    def _work_status_at(self, it: WorkItem) -> str:
        """WHEN THIS ITEM LAST ACTUALLY CHANGED STATE.

        Stored on every item written since the field existed. For an OLDER
        item it is derived, here, from retained history — and derived
        honestly:

          · the newest history row that RECORDS A STATUS CHANGE wins. That is
            an update carrying a `status` change, or an accept / reopen /
            supersede, each of which changes the value by definition.
          · with no such row, the CREATION time. An item that has never
            changed status has held the one it was created with, so its
            creation is when that state began.

        ⚠ IT MUST NEVER FALL BACK TO `updated_at` OR `docket_at`. Both move
        for edits that changed no state, so an item nobody has transitioned in
        weeks would sort as "just changed" because someone fixed its title —
        not a worse guess than the creation time but a different KIND of
        answer, one that states a change happened when none did.

        ⚠ AND THE FOLDED HISTORY ROW IS NOT A STATUS CHANGE. Past the history
        cap the oldest rows collapse into a summary row carrying no `op`;
        reading it as one dates a state change to whenever the fold ran.
        """
        stored = it.get("status_at")
        if stored:
            return str(stored)
        for row in reversed(it.get("history") or []):
            if row.get("kind") == "folded":
                continue
            op = row.get("op")
            changed = (op in ("accept", "reopen", "supersede")
                       or (op == "update"
                           and isinstance(row.get("changes"), dict)
                           and "status" in row["changes"])
                       # ⚠ A DISMISSAL IS A TRANSITION ONLY WHEN IT MOVED THE
                       # VALUE: it leaves the item blocked, so from an already
                       # blocked item it changed nothing. The history row
                       # records what it moved FROM, so this is decidable.
                       or (op == "dismiss_attention"
                           and row.get("from") != "blocked"))
            if changed and row.get("at"):
                return str(row["at"])
        return str(it.get("at") or "")

    def _work_stamp_status(self, it: WorkItem) -> None:
        """Record that the status VALUE just changed. Called from every site
        that assigns one — and only from those, which is why it is a method
        rather than a line copied four times."""
        it["status_at"] = now()

    def _work_stamp_docket(self, it: WorkItem, actor: str) -> None:
        """A DOCKET UPDATE: the row's clock and, for an agent, the reply
        recipient. The user is never `last_updater` — replies go to agents."""
        it["docket_at"] = now()
        if actor != USER:
            it["last_updater"] = cast(WorkActor, self._work_actor(actor))

    @staticmethod
    def _work_norm_list(raw: Any, name: str) -> list[str]:
        """Individual nonblank strings — never a prose string to be parsed."""
        if raw is None:
            return []
        if isinstance(raw, str):
            raise LedgerError(
                f"{name} must be a LIST of individual entries, not a string "
                f"(each entry is one completed thing / one next step)")
        if not isinstance(raw, list):
            raise LedgerError(f"{name} must be a list of strings")
        out: list[str] = []
        for x in cast("list[Any]", raw):
            if isinstance(x, (dict, list)):
                raise LedgerError(f"{name} entries must be plain strings")
            s = str(x if x is not None else "").strip()
            if s:
                out.append(s[:500])
        if len(out) > Org.WORK_LIST_ENTRY_MAX:
            raise LedgerError(f"{name} carries {len(out)} entries — keep the "
                              f"displayed lists scannable (max "
                              f"{Org.WORK_LIST_ENTRY_MAX}); detail belongs in "
                              f"evidence")
        return out

    def _work_require_live_agent_or_user(self, actor: str) -> None:
        if actor != USER:
            self._require_live(actor)

    # ---- the verbs
    def work_create(self, actor: str, title: str, objective: str = "",
                    kind: str = "code", owner: str | None = None,
                    participants: list[Any] | None = None,
                    acceptance: list[Any] | None = None,
                    dependencies: list[Any] | None = None,
                    done_so_far: Any = None, working_on_next: Any = None,
                    status: str = "open",
                    parent: str | None = None,
                    blocked_reason: str | None = None,
                    waiting_reason: str | None = None) -> dict[str, Any]:
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        t = str(title or "").strip()[:200]
        if not t:
            raise LedgerError("a work item needs a title")
        # The DESCRIPTION is mandatory (user 2026-09-05). It is the existing
        # `objective` field — deliberately not a second one: the wire, the
        # detail pane and every stored item already carry exactly one piece of
        # prose about what the item is for, and a parallel "description" would
        # only make two places to look and two to keep true. What CHANGED is
        # that it may no longer be blank, and what it is asked to say: the
        # problem being faced FIRST, then the proposed solution.
        obj = str(objective or "").strip()[:2000]
        if not obj:
            raise LedgerError(
                "a work item needs a description in `objective` — state the "
                "PROBLEM currently faced first, then the proposed solution. "
                "The user reads this to know why the item exists; a title "
                "alone does not say what is wrong")
        if kind not in ("code", "non-code"):
            raise LedgerError("kind must be code|non-code")
        if status not in self.WORK_AGENT_STATUSES or status == "dropped":
            raise LedgerError("a new item starts backlogged|open|in_progress"
                              "|blocked|review|deploy_ready")
        active = self.d.setdefault("work_items", [])
        if len(active) >= self.WORK_ACTIVE_MAX:
            raise LedgerError(
                f"the active docket holds {len(active)} items (cap "
                f"{self.WORK_ACTIVE_MAX}) — nothing is deleted for you: "
                f"finish and accept items so they archive, or `archive` a "
                f"closed one explicitly")
        own = str(owner or (actor if actor != USER else "") or "").strip() or None
        if own is not None:
            self.node(own)
            if actor != USER and own != actor and not self.is_ancestor(actor, own):
                raise LedgerError(
                    f"you may own an item yourself or assign it to a "
                    f"subordinate — {own!r} is neither")
        parts: list[str] = []
        for p in participants or []:
            pid = str(p or "").strip()
            if pid and pid != own:
                self.node(pid)
                if pid not in parts:
                    parts.append(pid)
        acc = [{"text": str(a).strip()[:300], "checked": None}
               for a in (acceptance or []) if str(a or "").strip()]
        deps: list[str] = []
        for d in dependencies or []:
            did = str(d or "").strip()
            if did:
                # resolved before storing, so a dependency on something that
                # does not exist is refused at the point it is written rather
                # than discovered later by a reader
                dep, _ = self._work_find(did)
                deps.append(str(dep["slug"]))
        done = self._work_norm_list(done_so_far, "done_so_far")
        nxt = self._work_norm_list(working_on_next, "working_on_next")
        if (done_so_far is not None or working_on_next is not None) \
                and not done and not nxt:
            raise LedgerError("a docket update needs at least one entry in "
                              "done_so_far or working_on_next")
        from . import workitems       # noqa: PLC0415  (sandbox->store->ledger cycle)
        # THE NAME IS THE ONLY KEY. It is minted here, once, against every
        # name already in use across the active list and the archive, and it
        # never changes again — not even when the title is edited.
        taken = self._work_names_in_use()
        wid = self._work_unique_slug(t, taken)
        taken.add(wid)
        stamp = now()
        it: WorkItem = {
            "slug": wid,
            "rev": 1, "kind": kind, "title": t,
            "objective": obj,
            "status": status, "blocked_reason": None, "waiting_reason": None,
            # a new item can never start `dropped` (the status guard above
            # refuses it), so this is only ever the field's resting value
            "dropped_reason": None,
            "owner": (cast(WorkActor, self._work_actor(own)) if own else None),
            # named only when the item ENTERS review, never at creation: a
            # reviewer for work that has not been done yet is a name nobody
            # chose for a reason
            "reviewer": None,
            "participants": parts,
            "created_by": self._work_actor(actor), "at": stamp,
            "updated_at": stamp,
            "done_so_far": done, "working_on_next": nxt,
            "docket_at": stamp,
            # creation IS the first status change: the item has held this
            # status since the moment it existed
            "status_at": stamp,
            "last_updater": (cast(WorkActor, self._work_actor(actor))
                             if actor != USER else None),
            "manual_attention": None, "manual_attention_rev": 0,
            "dismissals": [], "archived_at": None,
            "acceptance": acc, "dependencies": deps, "evidence": [],
            "delivery": ({s: None for s in workitems.STAGES}
                         if kind == "code" else None),
            "accepted": None, "history": [], "superseded_by": None,
            # resolved BEFORE the item is appended, so a bad parent refuses
            # the creation outright instead of leaving a stranded item behind
            "parent": (self._work_parent_check(actor, None, str(parent))
                       if parent else None),
        }
        # BEFORE the append: an item created straight into blocked or waiting
        # is entering that state, so it owes the same information an update
        # would. Refusing here leaves nothing stranded on the list.
        self._work_state_info(it, None, {"blocked_reason": blocked_reason,
                                         "waiting_reason": waiting_reason})
        active.append(it)
        self._log("work_create", actor,
                  {"item": wid, "title": t[:60]}, [])
        # ONE CALL CREATES AND ASSIGNS (user request 2026-09-05). The owner
        # argument was always here; what is new is that handing an item to
        # somebody else at creation TELLS THEM, with the same wording every
        # other assignment route uses. Assigning it to yourself mails nobody.
        notified = None
        if own and own != actor and own != USER:
            m = self._work_assign_mail(actor, it, own, None)
            notified = own
        # participants named AT CREATION are new members too, and are
        # told the same passive way `participants add` tells them
        told = self._work_participation_notices(actor, it, parts)
        return {"created": wid, "slug": it["slug"], "rev": 1,
                "owner": it["owner"], "notified": notified,
                **({"deferred": bool(m.get("deferred"))} if notified else {}),
                **told,
                "status": f"work item {it['slug']} created — that name is "
                          f"its only identity; use it in mail, reports and "
                          f"every later update, question and handoff"}

    #: what each state-information field is asked to SAY. Presence is all any
    #: guard can check — no code can tell whether the prose names a real event
    #: — so the requirement is stated where the writer reads it.
    WORK_STATE_INFO_ASKS: Final = {
        "blocked_reason": "what is preventing progress, what would unblock it, "
                          "and who can act when that is known",
        "waiting_reason": "the external event this item is waiting for AND how "
                          "you will learn it happened (a watchdog, a message, "
                          "a build notification)",
        "dropped_reason": "why this work ended without being completed — say "
                          "plainly whether it was CANCELLED or FAILED "
                          "UNRECOVERABLY, who decided, and what (if anything) "
                          "would have to change for it to be worth resuming",
    }

    def _work_state_info(self, it: WorkItem, was: str | None,
                         supplied: dict[str, Any]) -> None:
        """Carry the state's own information onto the item, after the status
        has been set.

        Three rules, one per situation, and they are not the same rule:
          · ENTERING a state in the map REQUIRES its field. That is the user's
            2026-09-05 requirement: blocked, waiting and dropped must each say
            something. For `dropped` it is the whole record of why the work
            ended, so it is the one thing the item cannot be closed without.
          · ALREADY in the state and the field not supplied: left alone. Items
            that predate this requirement stay editable rather than becoming
            un-updatable, which is why the check is on the transition and not
            on every update.
            ⚠ REACHABLE FOR blocked AND waiting ONLY, and nothing here
            changes that: this helper carries state information, it does not
            grant edit rights over a CLOSED item. A dropped item is closed, so
            the closed-item guard refuses a plain update before this runs. A
            legacy drop therefore stays READABLE and REOPENABLE but is not
            editable while it stays dropped — it cannot be given a reason
            after the fact, and a stored one cannot be corrected in place.
            Said here rather than left as a rule that reads as though it
            covered all three states.
          · A BLANK string supplied is REFUSED, never stored. Blanking used to
            erase the field silently; erasing required information without a
            word is exactly the failure the requirement exists to stop.
        Any other status clears every one of them — a reason must never
        survive the state it describes.
        """
        st = it.get("status")
        for state, field in self.WORK_STATE_INFO.items():
            val = supplied.get(field)
            if st != state:
                it[field] = None                      # type: ignore[literal-required]
                continue
            asks = self.WORK_STATE_INFO_ASKS[field]
            if val is not None and not str(val).strip():
                raise LedgerError(
                    f"a blank {field} does not erase what is recorded — pass "
                    f"the real text ({asks}), or omit the field to leave the "
                    f"existing one standing")
            if val is not None:
                it[field] = str(val).strip()[:500]    # type: ignore[literal-required]
            elif st != was and not str(it.get(field) or "").strip():
                raise LedgerError(
                    f"moving an item to `{state}` needs a nonblank {field}: "
                    f"{asks}")

    def _work_clear_state_info(self, it: WorkItem) -> None:
        """Clear EVERY state-information field, for the verbs that set a status
        directly instead of going through `work_update`.

        It reads the map rather than naming the fields, because the failure it
        exists to stop is silent: a verb that clears the two fields it was
        written beside and not the third leaves an item reading `DROPPED
        BECAUSE …` while it sits in some other state, and nothing fails — the
        pane simply lies. Adding a state to `WORK_STATE_INFO` now covers these
        callers by construction.
        """
        for field in self.WORK_STATE_INFO.values():
            it[field] = None                          # type: ignore[literal-required]

    def work_update(self, actor: str, wid: str, done_so_far: Any,
                    working_on_next: Any, status: str | None = None,
                    attention: bool | None = None,
                    attention_reason: str | None = None,
                    blocked_reason: str | None = None,
                    title: str | None = None, objective: str | None = None,
                    reopen: bool = False,
                    waiting_reason: str | None = None,
                    dropped_reason: str | None = None,
                    owner: str | None = None,
                    reviewer: str | None = None) -> dict[str, Any]:
        """THE docket status update. Always carries both lists (either may be
        empty, not both — Astra ruling 2026-09-05, no status-only bypass),
        moves `docket_at` and `last_updater`, and restates the manual flag:
        an update that does not pass attention=true CLEARS a standing flag,
        because the latest update is the complete current statement.

        AN UPDATE CLAIMS THE ASSIGNMENT (user ruling 2026-09-05 21:02, via
        Astra 21:15). Assignment is ownership, and the agent writing the status
        is the agent doing the work — so an authorized update makes that agent
        the owner. BEING ALLOWED TO UPDATE IS THE CLAIM MECHANISM the user
        described, participants included; an actor that may not update is
        refused before any of this and claims nothing.

        ⚠ AUTHORIZATION IS READ FROM THE PRE-UPDATE STATE, and that ordering is
        the guard. Every owner-level check below (drop, reopen, retitle,
        re-scope) is answered against the authority the actor held when the
        call ARRIVED — otherwise a participant's claim would take effect
        mid-call and hand it, in the same breath, rights the first line of this
        method had already refused it.

        `owner` is the explicit target, and it WINS: a call that says where the
        item goes never first assigns it to its author and then moves it, so
        the history shows one assignment and the notification names one
        recipient.

        THE ADMINISTRATIVE UPDATE (Astra ruling 2026-09-05 21:18). A superior
        writing a status on somebody else's item — a docket sweep, a root
        summary, a correction — would otherwise take the item, because the
        claim is uniform on purpose and has no ancestor exception. It passes
        `owner=<the current owner>` and keeps it where it is: naming the target
        that is already there changes nothing at all, so there is no history
        row, no notification and no reassignment to undo afterwards."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, phys = self._work_get_for(actor, wid)
        pre_manage = self._work_can_manage(actor, it)
        # the status this update FOUND. The reviewer rule keys on entering
        # review, and the status field is rewritten further down — read from
        # the item there and "entering" would be true of nothing.
        prev_status = str(it.get("status") or "")
        if actor != USER and not pre_manage \
                and actor not in (it.get("participants") or []):
            # a REVIEWER-ONLY actor: it can read this item because it was named
            # to review it, and that is the whole of its standing. A status
            # update would claim the item (below), which is exactly the
            # ownership a review is not (user ruling 2026-09-05 21:26).
            raise LedgerError(
                f"you are {wid}'s REVIEWER, not a collaborator on it — a "
                f"status update would claim the item, and reviewing is not "
                f"owning. Record your verdict with action 'review' "
                f"(decision approve|changes), or add `evidence`")
        done = self._work_norm_list(done_so_far, "done_so_far")
        nxt = self._work_norm_list(working_on_next, "working_on_next")
        if not done and not nxt:
            raise LedgerError(
                "a docket update needs at least one entry in done_so_far or "
                "working_on_next — both empty says nothing the user can read")
        now_ts = _time.time()
        if self._work_archived(it, phys, now_ts) and not reopen:
            raise LedgerError(
                f"{wid} is ARCHIVED ({self._work_archived_why(it)}). If "
                f"real work resumes, pass reopen=true with the new status; do "
                f"not create a duplicate item")
        if it.get("status") in self.WORK_CLOSED and not reopen:
            # a closed item is not resumed by accident: the acceptance (or the
            # supersede pointer) describes a completion that an ordinary
            # update would otherwise leave standing beside new work
            raise LedgerError(
                f"{wid} is {it.get('status')} — to resume it pass reopen=true "
                f"with the new status (its acceptance is then cleared and kept "
                f"in history); to report on finished work without resuming "
                f"it, add `evidence` instead")
        if status is not None:
            if status not in self.WORK_AGENT_STATUSES:
                if status == "done":
                    raise LedgerError(
                        "assert `review` — which means REVIEW BY AGENTS; "
                        "acceptance belongs to your superior or the user "
                        "(orgtree_work accept)")
                if status in self.WORK_LEGACY_STATUSES:
                    raise LedgerError(
                        f"`{status}` is no longer a task state (user 2026-09-07): "
                        f"use `{self.WORK_LEGACY_STATUSES[status]}` with a "
                        f"blocked_reason that names what you are waiting on, who "
                        f"or what will unblock it, and how you will hear of it")
                raise LedgerError(
                    f"status must be one of {'|'.join(self.WORK_AGENT_STATUSES)}")
        # a participant's grant is NARROW: status updates and evidence. Closing
        # the item, resuming it or rewriting what it is are owner-level acts.
        if not pre_manage:
            if status == "dropped":
                raise LedgerError("dropping an item is an owner-level act (owner, "
                                  "creator, their superiors, the user) - a "
                                  "participant reports, it does not close")
            if reopen:
                raise LedgerError("reopening an item is an owner-level act - ask "
                                  "the owner or a superior")
            if title is not None or objective is not None:
                raise LedgerError("only the owner, the creator, their superiors "
                                  "or the user may retitle or re-scope an item")
        if attention is True and not str(attention_reason or "").strip():
            raise LedgerError(
                "attention=true needs a nonblank attention_reason — the "
                "concrete thing the user must see: what was asked against what "
                "was built, the exact decision, edge case or definition you "
                "added beyond the spec, and the confirmation you want. This "
                "field is what they read to know what they are approving, so "
                "it carries the detail rather than pointing at evidence")
        if reopen:
            if it.get("status") not in self.WORK_CLOSED and not phys:
                pass                      # nothing to reopen; harmless
            status = status or "in_progress"
            if status in self.WORK_CLOSED:
                raise LedgerError("reopen needs an open status "
                                  "(open|in_progress|blocked|review|"
                                  "deploy_ready)")
            if phys:
                self._work_archive().remove(it)
                self.d.setdefault("work_items", []).append(it)
            it["archived_at"] = None
            # the earlier acceptance described a completion that no longer
            # stands; history keeps who accepted what and when — and, for work
            # that had been ended unsuccessfully, WHY it was ended, because
            # resuming clears the live field and that sentence is the whole
            # record of the outcome being overturned
            self._work_hist(it, actor, "reopen",
                            {"from": it.get("status"),
                             "accepted_was": it.get("accepted"),
                             "dropped_reason_was": it.get("dropped_reason"),
                             "superseded_by_was": it.get("superseded_by")})
            it["accepted"] = None
            it["superseded_by"] = None
        changes: dict[str, Any] = {}
        attention_warning: str | None = None
        was = it.get("status")
        if was in self.WORK_LEGACY_STATUSES:
            # THE ONE WRITE THAT CONVERTS A LEGACY ROW: this item's own next
            # update. The stored `waiting` becomes what it has been read as
            # since the state was removed — `blocked`, unless the update names
            # another status — and the waiting reason is carried into
            # `blocked_reason` (when none is there) so the requirement below
            # is met by the reason the item already had. Recorded in history
            # as a conversion, not as the agent's own transition.
            legacy = str(was)
            status = status or self.WORK_LEGACY_STATUSES[legacy]
            if status == "blocked" and not str(it.get("blocked_reason") or "").strip():
                it["blocked_reason"] = it.get("waiting_reason")
            changes["legacy_status"] = {"from": legacy, "read_as":
                                        self.WORK_LEGACY_STATUSES[legacy]}
            # the row has been READ as its replacement all along, so this is
            # not an entry into `blocked` that owes a fresh reason: a legacy
            # row that stored no reason converts with none, rather than being
            # refused or given invented prose
            was = self.WORK_LEGACY_STATUSES[legacy]
        if status is not None and status != it.get("status"):
            changes["status"] = {"from": it.get("status"), "to": status}
            it["status"] = status
            # ⚠ INSIDE THE `!=` BRANCH. An update that RESTATES the status it
            # already had changed nothing; stamping it would make "most
            # recently changed state" mean "most recently mentioned a state".
            # Reopen assigns through this same branch, so it needs no second
            # call.
            self._work_stamp_status(it)
        self._work_state_info(it, was, {"blocked_reason": blocked_reason,
                                        "waiting_reason": waiting_reason,
                                        "dropped_reason": dropped_reason})
        if it.get("status") == "dropped" and was != "dropped":
            # the OUTCOME outlives the field. A later reopen clears
            # `dropped_reason` (a reason must not survive its state), so
            # without this line the docket would end up with no trace at all
            # of why the work was ended — which is the one thing this status
            # exists to record.
            changes["dropped_reason"] = it.get("dropped_reason")
        if title is not None and str(title).strip():
            changes["title"] = {"from": it.get("title"), "to": str(title).strip()[:200]}
            it["title"] = str(title).strip()[:200]
        if objective is not None:
            # rewriting the description is fine; ERASING it is not — the field
            # is mandatory at creation, so a blanking update would be a way to
            # end up with the very item the create guard refuses. Items that
            # predate the rule keep whatever they have, including nothing:
            # nothing here rewrites history or invents prose for them.
            newobj = str(objective).strip()[:2000]
            if not newobj:
                raise LedgerError(
                    "the description (`objective`) may be rewritten but not "
                    "emptied — state the problem first, then the solution")
            it["objective"] = newobj
        it["done_so_far"] = done
        it["working_on_next"] = nxt
        # the manual flag is restated by every update
        prev = it.get("manual_attention")
        if attention is True:
            submitted_reason = str(attention_reason or "").strip()
            over = max(0, len(submitted_reason) - self.WORK_ATTENTION_REASON_MAX)
            if over:
                attention_warning = (
                    f"attention_reason was truncated to the supported "
                    f"{self.WORK_ATTENTION_REASON_MAX}-character limit; "
                    f"submitted text exceeds it by {over} character(s). "
                    f"Shorten it by at least {over} character(s) to keep the "
                    f"full message.")
            reason = submitted_reason[:self.WORK_ATTENTION_REASON_MAX]
            last = (it.get("dismissals") or [])[-1:]
            if last and " ".join(str(last[0].get("reason") or "").lower().split()) \
                    == " ".join(reason.lower().split()):
                raise LedgerError(
                    f"the user DISMISSED exactly this reason at {last[0]['at']} "
                    f"— the same string is an exact repeat and is refused. "
                    f"Re-raise only with material new information, stated "
                    f"in the reason (doctrine; the backend checks the exact "
                    f"repeat only)")
            it["manual_attention_rev"] = int(it.get("manual_attention_rev") or 0) + 1
            it["manual_attention"] = {"reason": reason, "at": now(),
                                      "by": self._work_actor(actor),
                                      "set_rev": it["manual_attention_rev"]}
            changes["manual_attention"] = {"set_rev": it["manual_attention_rev"]}
        elif prev:
            it["manual_attention"] = None
            changes["manual_attention"] = {"cleared_set_rev": prev.get("set_rev"),
                                           "by": "status update"}
        self._work_hist(it, actor, "update",
                        {"changes": changes, "done": len(done), "next": len(nxt)})
        self._work_stamp_docket(it, actor)
        self._log("work_update", actor,
                  {"item": wid, **({"status": status} if status else {})}, [])
        # ---- and the assignment, LAST: the lists are already written, so the
        # notification quotes the status this very update recorded rather than
        # the one it replaced.
        tgt = str(owner or "").strip()
        if tgt and tgt != actor and not pre_manage:
            # handing the item to a THIRD PARTY is the ordinary owner-level
            # reassignment and needs owner-level authority. Claiming it for
            # yourself is not: that is the update-claims-assignment rule, and
            # it is the same act whether you spell it out or leave it implicit.
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may assign an item to someone else — "
                              "your update already claims it for you")
        if not tgt and actor != USER:
            tgt = actor
        # ---- the REVIEWER, named by the update that enters review
        rev_notify = self._work_name_reviewer(actor, it, reviewer, status,
                                              prev_status, pre_manage, tgt)
        assigned: dict[str, Any] | None = None
        if tgt and tgt != self._work_actor_node(it.get("owner")):
            # ⚠ ONLY WHEN IT ACTUALLY CHANGES HANDS. The overwhelmingly common
            # case is the owner updating its own item; writing an `assign`
            # history row and mailing somebody on every such update would bury
            # the real handovers in noise.
            assigned = self._work_assign_core(
                actor, it, tgt, True,
                "update" if tgt == actor else "update+assign")
        return {"updated": wid, "rev": it["rev"], "status": it["status"],
                "owner": it.get("owner"),
                "reviewer": it.get("reviewer"),
                "assigned_to": (str(tgt) if assigned else None),
                "notified": (assigned or {}).get("notified"),
                "reviewer_notified": rev_notify,
                # ⚠ EVERY AGENT THIS CALL MAILED, as a list. One update can
                # hand the item to somebody AND ask somebody else to review it,
                # and a single `notified` field would have driven one of the
                # two and silently left the other holding unread mail.
                "notified_nodes": [n for n in
                                   ((assigned or {}).get("notified"), rev_notify)
                                   if n],
                "manual_attention": bool(it.get("manual_attention")),
                "note": ("the standing attention flag was CLEARED by this "
                         "update (pass attention=true to keep one)"
                         if prev and attention is not True else None),
                **({"warnings": [attention_warning]} if attention_warning
                   else {})}

    # ---- ASSIGNMENT. User ruling 2026-09-05 21:02: ASSIGNMENT IS OWNERSHIP —
    # the `owner` field is the ONE meaning behind the docket's Assignment line,
    # the user's reply destination and any reminder that has to name somebody.
    # There is deliberately no second "assignee" field: two fields would be two
    # places to look and two to keep true, and the one that lost would still
    # render somewhere. `last_updater` survives untouched as HISTORY (who wrote
    # the latest status), which is what it always actually was.
    def _work_assign_core(self, actor: str, it: WorkItem, owner: str,
                          notify: bool, why: str) -> dict[str, Any]:
        """Move the assignment, and TELL the agent that just acquired it.

        ⚠ THE AUTHORITY CHECK IS THE CALLER'S JOB and is made BEFORE this runs
        — every route in here is reached only past `_work_can_manage`. What is
        checked HERE is the destination: you assign to yourself or into your own
        subtree, exactly as before. The user assigns to anyone.

        The notification is the whole point of the change (the old `assign` set
        a field and told nobody, so an agent could hold an item for hours
        without ever learning it existed). It is ordinary item-linked mail, so
        it wakes the assignee through the caller's `drive` like any other
        message — never silently, and never to the actor itself, which would be
        an agent mailing itself every time it updated its own item."""
        own = str(owner or "").strip()
        self.node(own)
        if actor not in (USER, SYSTEM) and own != actor and not self.is_ancestor(actor, own):
            raise LedgerError(f"you may assign an item to yourself or a "
                              f"subordinate — {own!r} is neither")
        frm = it.get("owner")
        it["owner"] = cast(WorkActor, self._work_actor(own))
        parts = [p for p in (it.get("participants") or []) if p != own]
        it["participants"] = parts
        self._work_hist(it, actor, "assign",
                        {"from": frm, "to": it["owner"], "why": why})
        self._log("work_assign", actor,
                  {"item": it["slug"], "to": own, "why": why}, [])
        out: dict[str, Any] = {"assigned": it["slug"], "owner": it["owner"],
                               "rev": it["rev"], "notified": None}
        if not notify or own == actor or own == USER:
            return out
        m = self._work_assign_mail(actor, it, own, self._work_actor_node(frm))
        out["notified"] = own
        out["deferred"] = bool(m.get("deferred"))
        return out

    def _work_assign_mail(self, actor: str, it: WorkItem, own: str,
                          prev: str | None) -> dict[str, Any]:
        """The assignment notification itself — ONE wording, wherever the
        assignment came from (`assign`, `create`, `update`, a hire that carried
        an item, `orgtree_staff`). Written as an instruction the recipient can
        act on without a second lookup: what it now holds, who handed it over,
        what the item is for, and where the status stands."""
        # typed (family assignment): docket.assigned — the body is its frozen
        # rendering, byte for byte the former f-string (test_events_producers §D)
        return self.post_mail(
            actor, own, "", "request",
            ev=_mint("docket.assigned", actor_of(actor), self.work_item_ref(it),
                     owner=own, previous_owner=(str(prev) if prev else None),
                     assigner=actor, status=str(it.get("status") or "open"),
                     objective=str(it.get("objective") or ""),
                     done_so_far=[str(x) for x in (it.get("done_so_far") or [])],
                     working_on_next=[str(x) for x in (it.get("working_on_next") or [])]))

    def _work_name_reviewer(self, actor: str, it: WorkItem,
                            reviewer: str | None, status: str | None,
                            prev_status: str, pre_manage: bool,
                            owner_after: str) -> str | None:
        """Name (or re-name) the item's REVIEWER as part of an update, and tell
        them. Returns the node mailed, or None.

        TWO RULES DECIDE WHETHER A NAME IS NEEDED AT ALL:
        · entering `review` REQUIRES one (user ruling 2026-09-05: a review
          request names the responsible reviewing agent). An item already at
          review keeps the reviewer it has;
        · nothing else may name one — a reviewer on work that is not under
          review is a name with no meaning attached.

        ⚠ EXISTING `review` RECORDS ARE NOT BACK-FILLED. An item that was
        already at review when this shipped keeps `reviewer: null` and stays
        legal; the root assigns those explicitly. Inventing a reviewer for them
        — the last accepter, the owner's superior — would put a name nobody
        chose in the one slot whose whole job is saying who chose to be
        answerable for the check."""
        want = str(reviewer or "").strip()
        entering = (status == "review" and prev_status != "review")
        if not want:
            if entering and not self._work_actor_node(it.get("reviewer")):
                raise LedgerError(
                    "a review request names its reviewer: pass `reviewer` with "
                    "the agent that will check this work. It is not ownership "
                    "— the reviewer gets read, evidence and the review "
                    "decision, and you keep the item")
            return None
        if not entering and prev_status != "review":
            raise LedgerError(
                "a reviewer is named on the update that puts the item at "
                "status review — name one when you ask for the review, not "
                "before")
        # NAMING A REVIEWER IS AN OWNER-LEVEL ACT.
        #
        # ⚠ AND THIS BRANCH IS UNREACHABLE TODAY — said here rather than left
        # for a reader to assume it is load-bearing. Every actor that gets this
        # far either already manages the item or has just CLAIMED it by
        # updating (the claim is uniform), so `owner_after` is the actor
        # whenever `pre_manage` is false; a reviewer-only actor is refused at
        # the top of work_update and never arrives. It is kept because it
        # states the rule the claim currently happens to satisfy: loosen the
        # claim, add an update path that does not take ownership, and this is
        # the line that keeps a bystander from choosing who checks the work.
        # There is deliberately NO mutant for it in _mutate_staffing.py — a
        # mutation nothing can kill would report a hole in the suite that is
        # really a hole in the reachable state space.
        if not pre_manage and owner_after != actor:
            raise LedgerError("naming a reviewer is an owner-level act (owner, "
                              "creator, their superiors, the user)")
        self.node(want)
        # SELF-REVIEW IS PROHIBITED (user ruling 2026-09-05 21:26), and it is
        # measured against the owner this update LEAVES BEHIND, not the one it
        # found: an update that claims the item and names its author as
        # reviewer in the same breath is exactly the case being refused.
        if want == (owner_after or self._work_actor_node(it.get("owner"))):
            raise LedgerError(
                "the owner cannot review its own work — name somebody else "
                "(self-review is prohibited)")
        # WHO MAY BE NAMED: somebody you could ask directly — yourself, an
        # agent in your subtree, or your own superior. The subtree half is the
        # assignment rule; the superior half is here because asking the agent
        # above you to check your work is the ordinary review in this org, and
        # a rule that refused it would leave the common case unreachable
        # (flagged to Astra as the one place this is wider than "subtree").
        if actor != USER and want != actor and not self.is_ancestor(actor, want) \
                and str(self.node(actor).get("parent") or "") != want:
            raise LedgerError(
                f"you may ask yourself, an agent in your subtree, or your own "
                f"superior to review this — {want!r} is none of those")
        prev = self._work_actor_node(it.get("reviewer"))
        it["reviewer"] = cast(WorkActor, self._work_actor(want))
        self._work_hist(it, actor, "reviewer", {"from": prev, "to": it["reviewer"]})
        if want == actor:
            return None                 # naming yourself mails nobody
        # typed (family review): docket.review_requested (test_events_producers §D)
        self.post_mail(
            actor, want, "", "request",
            ev=_mint("docket.review_requested", actor_of(actor), self.work_item_ref(it),
                     reviewer=want, requested_by=actor,
                     owner=str(self._work_actor_node(it.get("owner")) or ""),
                     objective=str(it.get("objective") or ""),
                     done_so_far=[str(x) for x in (it.get("done_so_far") or [])]))
        return want

    def work_reassign_abandoned(self, now_ts: float | None = None,
                                threshold_s: float | None = None
                                ) -> list[dict[str, Any]]:
        """Reassign stale nonterminal work whose owner generation is gone."""
        self._work_require_current_identity()
        now_ts = _time.time() if now_ts is None else now_ts
        threshold = (self.WORK_ABANDONED_AFTER_S
                     if threshold_s is None else float(threshold_s))
        if threshold < 0:
            raise LedgerError("abandoned-ticket threshold must be nonnegative")
        tops = sorted(str(nid) for nid, node in self.nodes.items()
                      if node.get("state") == "live"
                      and not str(node.get("parent") or "").strip())
        if not tops:
            return []
        moved: list[dict[str, Any]] = []
        for it in list(self._work_all()):
            if self._work_status(it) in self.WORK_CLOSED:
                continue
            age = self._work_recovery_age_s(it, now_ts)
            if age is None or age <= threshold:
                continue
            current, owner_state = self._work_owner_state(it)
            if current or owner_state is None:
                continue
            result = self._work_assign_core(SYSTEM, it, tops[0], True,
                                            "abandoned-owner")
            result["previous_owner_state"] = owner_state
            result["age_s"] = age
            moved.append(result)
        return moved

    def work_assign(self, actor: str, wid: str, owner: str,
                    notify: bool = True) -> dict[str, Any]:
        """Explicit reassignment, and it NOTIFIES (user request 2026-09-05):
        the assignee learns it holds the item at its next turn, before it has
        ever written a status update. Still not a docket update — `docket_at`
        and `last_updater` are history and are left where they are."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may reassign an item")
        return self._work_assign_core(actor, it, owner, notify, "assign")

    def work_participants(self, actor: str, wid: str,
                          add: list[Any] | None = None,
                          remove: list[Any] | None = None) -> dict[str, Any]:
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may change participants")
        parts = list(it.get("participants") or [])
        owner = self._work_actor_node(it.get("owner"))
        added: list[str] = []
        for p in add or []:
            pid = str(p or "").strip()
            if pid and pid != owner:
                self.node(pid)
                if pid not in parts:
                    parts.append(pid)
                    added.append(pid)
        for p in remove or []:
            pid = str(p or "").strip()
            if pid in parts:
                parts.remove(pid)
        it["participants"] = parts
        self._work_hist(it, actor, "participants", {"now": parts})
        # only a member of the FINAL list is told: add=[X], remove=[X] in
        # one call adds nothing, so it tells nobody (Astra, 2026-09-06)
        return {"participants": parts, "rev": it["rev"],
                **self._work_participation_notices(
                    actor, it, [p for p in added if p in parts])}

    def _work_participation_notices(self, actor: str, it: WorkItem,
                                    pids: list[str]) -> dict[str, Any]:
        """Tell each of `pids` — members the caller has ALREADY established
        are new AND in the item's final membership — that it is now a
        participant (user 2026-09-06). Passively: membership is not
        assignment. A participant may read, update, add evidence and attach
        questions, and the user's replies ADDRESSED to it arrive as
        item-linked mail — but it does not hold the item, so this is a
        notice (read at its next turn, never a wake), not the assignment
        mail. Shared by `create` (participants named at creation) and
        `participants add`, so the two cannot drift. The actor itself is
        never told.

        ⚠ THE NOTICE IS BEST-EFFORT AND THE MEMBERSHIP IS NOT. Membership
        has never been bounded by the §7.2 addressing rules (an owner may
        add anyone in the org), but mail is: an actor that cannot address
        the new member, or a member that is unrecoverable, would turn a
        valid membership change into a refusal. So a notice that cannot be
        posted is REPORTED in `notice_refused` (node + the reason) and the
        change stands — the caller is told, in its own result, exactly who
        was not reached. Returns {noticed, noticed_deferred?, notice_refused?}."""
        owner = self._work_actor_node(it.get("owner"))
        noticed: list[str] = []
        deferred: list[str] = []
        refused: list[dict[str, str]] = []
        for pid in pids:
            if pid == actor:
                continue
            try:
                # typed (family context_change): docket.participant_added
                m = self.post_mail(
                    actor, pid, "", "notice",
                    # KEEP EXISTING PERMISSIONS (user 2026-09-06): this notice
                    # is automatic, so it must not mint the §7.3 reply
                    # audience an explicit message to a deep descendant would
                    grant_reply_audience=False,
                    ev=_mint("docket.participant_added", actor_of(actor),
                             self.work_item_ref(it), added_by=actor,
                             owner=str(owner or ""),
                             objective=str(it.get("objective") or "")))
            except LedgerError as e:
                refused.append({"node": pid, "reason": str(e)})
                continue
            noticed.append(pid)
            if m.get("deferred"):
                # archived member: the notice sits in its inbox; nothing
                # nudges it (a notice never starts a turn, rehire or not)
                deferred.append(pid)
        out: dict[str, Any] = {"noticed": noticed}
        if deferred:
            out["noticed_deferred"] = deferred
        if refused:
            out["notice_refused"] = refused
        return out

    def work_evidence(self, actor: str, wid: str, kind: str, ref: str,
                      note: str | None = None) -> dict[str, Any]:
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if kind not in self.WORK_EVIDENCE_KINDS:
            raise LedgerError(f"evidence kind must be one of "
                              f"{'|'.join(self.WORK_EVIDENCE_KINDS)}")
        r = str(ref or "").strip()[:500]
        if not r:
            raise LedgerError("evidence needs a ref (path, url, sha, log name)")
        ev = it.setdefault("evidence", [])
        if len(ev) >= self.WORK_EVIDENCE_MAX:
            raise LedgerError(
                f"this item already holds {len(ev)} evidence rows (cap "
                f"{self.WORK_EVIDENCE_MAX}); nothing is truncated — consolidate "
                f"into a file and reference that")
        ev.append({"at": now(), "by": self._work_actor(actor), "kind": kind,
                   "ref": r, **({"note": str(note).strip()[:500]} if note else {})})
        self._work_hist(it, actor, "evidence", {"kind": kind})
        return {"evidence": len(ev), "rev": it["rev"]}

    def work_claim(self, actor: str, wid: str, stage: str,
                   ref: str | None = None, note: str | None = None
                   ) -> dict[str, Any]:
        """A delivery CLAIM. Verification fields are never caller-writable:
        a verifiable stage is recorded `unverified` until `verify` runs."""
        from . import workitems       # noqa: PLC0415
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("delivery claims are an owner-level act (owner, "
                              "creator, their superiors, the user) - a "
                              "participant records `evidence` instead")
        if it.get("delivery") is None:
            raise LedgerError("non-code item: delivery stages do not apply")
        if stage not in workitems.STAGES:
            raise LedgerError(f"stage must be one of {'|'.join(workitems.STAGES)}")
        st: WorkStage = {"claimed_at": now(),
                         "claimed_by": self._work_actor(actor),
                         "ref": None, "note": (str(note).strip()[:500] if note else None),
                         "verified": None, "method": "self-report", "detail": "",
                         "resolved_oid": None, "target": "", "ref_as_of": "",
                         "fetched_at": None, "observed_at": ""}
        if stage in workitems.VERIFIABLE:
            st["ref"] = workitems.validate_sha(ref)   # raises ShaError (ValueError)
            st["method"] = "unverified"
            st["detail"] = "claimed; run `verify` to check it against git"
        elif ref:
            st["ref"] = str(ref).strip()[:500]
        cast("dict[str, Any]", it["delivery"])[stage] = st
        self._work_hist(it, actor, "claim", {"stage": stage})
        return {"claimed": stage, "rev": it["rev"],
                "verifiable": stage in workitems.VERIFIABLE}

    def work_verify_capture(self, actor: str, wid: str, stage: str
                            ) -> dict[str, Any]:
        """Under the lock: what to verify. The git call runs OUTSIDE the lock;
        `work_verify_commit` writes only if the item is unchanged."""
        from . import workitems       # noqa: PLC0415
        self._work_require_live_agent_or_user(actor)
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("verifying a delivery claim is an owner-level act")
        if stage not in workitems.VERIFIABLE:
            raise LedgerError(f"{stage!r} is a claim, not a verifiable stage "
                              f"({'|'.join(sorted(workitems.VERIFIABLE))})")
        d = it.get("delivery")
        st = cast("dict[str, Any] | None", (d or {}).get(stage)) if d else None
        if not st or not st.get("ref"):
            raise LedgerError(f"no {stage} claim with a sha on {wid} — claim first")
        return {"wid": wid, "rev": int(it["rev"]), "stage": stage,
                "sha": str(st["ref"])}

    def work_verify_commit(self, wid: str, stage: str, rev: int,
                           result: Mapping[str, Any]) -> dict[str, Any]:
        it, _ = self._work_find(wid)
        if int(it["rev"]) != int(rev):
            return {"stale": True, "rev": it["rev"],
                    "status": "the item changed while git was consulted — "
                              "nothing written; re-run verify"}
        d = cast("dict[str, Any]", it["delivery"])
        st = cast("dict[str, Any]", d.get(stage) or {})
        st.update({k: result.get(k) for k in (
            "verified", "method", "detail", "resolved_oid", "target",
            "ref_as_of", "fetched_at", "observed_at")})
        d[stage] = st
        self._work_hist(it, "orgtree", "verify",
                        {"stage": stage, "verified": st.get("verified")})
        return {"stale": False, "rev": it["rev"], "stage": stage,
                "verified": st.get("verified"), "detail": st.get("detail")}

    def work_check(self, actor: str, wid: str, index: int,
                   evidence_ref: str, note: str | None = None) -> dict[str, Any]:
        """Mark ONE acceptance condition checked — acceptance evidence,
        distinct from delivery stages and never inferred from them."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("checking an acceptance condition is an owner-level "
                              "act - a participant records `evidence` instead")
        acc = it.get("acceptance") or []
        if not 0 <= int(index) < len(acc):
            raise LedgerError(f"acceptance index {index} out of range "
                              f"(0..{len(acc) - 1})")
        r = str(evidence_ref or "").strip()[:500]
        if not r:
            raise LedgerError("checking a condition needs an evidence_ref")
        acc[int(index)]["checked"] = {"at": now(), "by": self._work_actor(actor),
                                      "evidence_ref": r,
                                      "note": (str(note).strip()[:500] if note else None)}
        self._work_hist(it, actor, "check", {"index": int(index)})
        return {"checked": int(index), "rev": it["rev"]}

    def work_accept(self, actor: str, wid: str,
                    note: str | None = None) -> dict[str, Any]:
        """→ done. The user, a strict ancestor of the owner, or the item's
        NAMED REVIEWER; never the owner. Starts the one-hour archive clock (a
        docket event) but leaves `last_updater` alone — replies still reach the
        agent who did the work.

        ANY open status is acceptable, not just `review`. `review` means review
        BY AGENTS (user ruling 2026-09-05); an item that was only ever waiting
        on the user — blocked on a question, or holding an attention flag — is
        accepted from where it stands rather than being walked through an agent
        check it never needed."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_accept(actor, it):
            raise LedgerError(
                "acceptance belongs to the user, a superior of the owner or "
                "the item's named reviewer — an owner asserts `review` (the "
                "AGENT check) and waits")
        return self._work_accept_core(actor, it, note, "accept")

    def _work_accept_core(self, actor: str, it: WorkItem, note: str | None,
                          op: str) -> dict[str, Any]:
        """→ done, once the authority question has been answered by the caller.

        Shared by `accept` and by a named reviewer's APPROVAL, because the user
        ruled (2026-09-05 21:26) that a reviewer's approval completes the item
        — there is no second acceptance round behind it. One body means the two
        routes cannot drift into completing an item differently."""
        wid = str(it["slug"])
        if it.get("status") in self.WORK_CLOSED:
            raise LedgerError(f"{wid} is already {it.get('status')}")
        frm = it.get("status")
        it["status"] = "done"
        self._work_stamp_status(it)
        self._work_clear_state_info(it)
        it["accepted"] = {"at": now(), "by": self._work_actor(actor),
                          "note": (str(note).strip()[:500] if note else None),
                          "via": op}
        self._work_hist(it, actor, op, {"from": frm})
        it["docket_at"] = now()
        self._log("work_accept", actor, {"item": wid, "via": op}, [])
        return {"accepted": wid, "rev": it["rev"],
                "status": "done — archives automatically once its last docket "
                          "update is over an hour old (records are kept)"}

    # ---- REVIEW. User rulings 2026-09-05 21:22/21:26, relayed by Astra.
    #
    # The reviewer is a SECOND named agent on the item and it is NOT a second
    # owner: the owner keeps delivery responsibility throughout, and the
    # reviewer holds exactly read, evidence and the review decision. What the
    # reviewer role really carries is the ANSWER TO "who acts next" — while an
    # item is under review the next action is the reviewer's, and when changes
    # are requested it hands straight back to the owner.
    def work_review_decide(self, actor: str, wid: str, decision: str,
                           note: str | None = None) -> dict[str, Any]:
        """The named reviewer's verdict: `approve` (→ done) or `changes`
        (→ in_progress, and the OWNER is told what to do next).

        ⚠ REVIEWER ≠ OWNER IS CHECKED HERE TOO, not only when the reviewer was
        named. Ownership moves — an update claims the item — so an agent named
        as reviewer yesterday can be the owner today, and a check made only at
        naming time would let exactly the self-review the user prohibited
        happen through the back door.

        ⚠ THE OWNER IS PASSED THROUGH EXPLICITLY on the status change, so a
        review decision never claims the item for the reviewer. That is the
        whole reason this is its own verb rather than an ordinary update."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        dec = str(decision or "").strip().lower()
        if dec not in ("approve", "changes"):
            raise LedgerError("decision must be 'approve' (the review passed — "
                              "the item is done) or 'changes' (send it back to "
                              "the owner as in_progress)")
        rev_node = self._work_actor_node(it.get("reviewer"))
        own = self._work_actor_node(it.get("owner"))
        if actor != USER and actor != rev_node \
                and not self._work_can_accept(actor, it):
            who = (f"reviewed by {rev_node}" if rev_node else
                   "not under review by anybody — a reviewer is named by the "
                   "update that puts an item at status review")
            raise LedgerError(
                f"{wid} is {who}, and a review decision belongs to that "
                f"reviewer, a superior of the owner, or the user")
        if actor != USER and actor == own:
            # the self-review prohibition, stated where it can actually fire
            raise LedgerError(
                "you own this item, so you cannot review it — self-review is "
                "prohibited (user ruling 2026-09-05). Ask the reviewer, your "
                "superior or the user")
        if it.get("status") in self.WORK_CLOSED:
            raise LedgerError(f"{wid} is already {it.get('status')}")
        if dec == "approve":
            out = self._work_accept_core(actor, it, note, "review_approve")
            out["decision"] = "approve"
            out["notified"] = self._work_tell_owner(
                actor, it, own, "docket.review_approved",
                note=(str(note) if note else None))
            return out
        frm = it.get("status")
        it["status"] = "in_progress"
        # A sendback is a real status change and belongs in the status clock
        # like any other — this route was added after the clock and did not
        # stamp, so an item sent back sorted by whatever it last changed to.
        #
        # ⚠ ONLY WHEN IT MOVED THE VALUE, the same guard `dismiss` carries: a
        # sendback on an item already in_progress assigns in_progress over
        # in_progress, and stamping that would turn "most recently changed
        # state" into "most recently touched".
        if frm != "in_progress":
            self._work_stamp_status(it)
        # ⚠ EVERY state-information field, not just `blocked_reason`. This verb
        # does not require the item to be AT `review` — a superior of the owner
        # or the user may send back an item that is `waiting` — so it can leave
        # a state that owes information, and a field cleared by name is a field
        # that stops being cleared the moment the map grows.
        self._work_clear_state_info(it)
        self._work_hist(it, actor, "review_changes",
                        {"from": frm, "note": (str(note)[:200] if note else None)})
        it["docket_at"] = now()
        self._log("work_review", actor, {"item": wid, "decision": dec}, [])
        return {"reviewed": wid, "decision": "changes", "rev": it["rev"],
                "status": it["status"],
                "notified": self._work_tell_owner(
                    actor, it, own, "docket.review_changes",
                    note=(str(note) if note else None))}

    def _work_tell_owner(self, actor: str, it: WorkItem, own: str | None,
                         variant: str, **fields: Any) -> str | None:
        """Tell the OWNER what a review decided — a typed `docket.review_*`
        event (family review); `relayed` on the event says which voice carried
        it. Returns the node mailed.

        ⚠ IT FALLS BACK TO THE DOCKET'S OWN VOICE RATHER THAN GOING UNSENT.
        A reviewer is named from the NAMER's reach, so it can legitimately end
        up somewhere the ordinary §7.2 addressing rules do not let it write to
        the owner directly (a report of your superior's other report, say). The
        decision has already been recorded at that point, and an owner who is
        never told its work was sent back — or accepted — is the failure this
        whole feature exists to prevent. So the notice goes out under the
        docket's name instead, SAYING SO, and the sender is never silently
        misrepresented as the reviewer."""
        if not own or own == actor or own == USER:
            return None

        def _ev(relayed: bool) -> dict[str, Any]:
            # ⚠ a literal per branch: the coverage scan (test_events_ledger §7)
            # wants every mint( site to name its variant as a string literal
            if variant == "docket.review_approved":
                return _mint("docket.review_approved", actor_of(actor),
                             self.work_item_ref(it), reviewer=actor, owner=own,
                             relayed=relayed, **fields)
            return _mint("docket.review_changes", actor_of(actor),
                         self.work_item_ref(it), reviewer=actor, owner=own,
                         relayed=relayed, **fields)
        try:
            self.post_mail(actor, own, "", "request", ev=_ev(False))
        except LedgerError:
            self.post_mail(USER, own, "", "request", ev=_ev(True))
        return own

    def work_archive_now(self, actor: str, wid: str) -> dict[str, Any]:
        """Explicit archive of a CLOSED item, ahead of the sweep."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, phys = self._work_get_for(actor, wid)
        if phys:
            return {"archived": wid, "already": True}
        if not self._work_can_manage(actor, it):
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may archive an item")
        if it.get("status") not in self.WORK_CLOSED:
            raise LedgerError(f"only done|superseded|dropped items archive — "
                              f"{wid} is {it.get('status')}")
        if self._work_attention(it):
            raise LedgerError(f"{wid} still holds attention (a pending question "
                              f"or a manual flag) — it stays visible until that "
                              f"clears")
        self._work_active().remove(it)
        it["archived_at"] = now()
        self.d.setdefault("work_items_archive", []).append(it)
        self._work_hist(it, actor, "archive", {})
        self._log("work_archived", actor, {"ids": [wid], "why": "explicit"}, [])
        return {"archived": wid, "rev": it["rev"]}

    # ---- PERMANENT DELETION (user 2026-09-07 08:18Z: "can you delete tickets
    # completely?"). Archive and drop both KEEP the record; this removes it.
    #
    # Authority is deliberately narrower than `_work_can_manage`: deletion is
    # the one act the record cannot report afterwards, so it belongs to the
    # user, to a STRICT SUPERIOR of the item's anchor (owner, else creator), or
    # to the anchor itself only when it answers to nobody but the user (a
    # top-level agent such as the coordinator, whose own items have no
    # superior to ask). A subordinate never deletes its own ticket — its
    # superior does; participants and the named reviewer never do.
    #
    # What goes: the record itself, from the active list or the archive, and
    # every pointer another item holds to it (`dependencies` entries and a
    # `superseded_by` naming it), each recorded on THAT item's history. Its
    # NAME is retired (`work_deleted_names`, names only): a later item with
    # the same title mints `title-2`, so an old chip, closed ask or mail row
    # carrying the name can never resolve to a different ticket. What
    # refuses: children still nested under it (move or delete them first) and
    # an OPEN attached question (it belongs to its asker — withdraw or answer
    # it first). What stays: mail, notices and ask history that mention the
    # name — those are records of the past, and every reader of a docket
    # pointer already tolerates a name that resolves to nothing
    # (`_work_pointer_visible`). One `work_deleted` event on the org log is
    # the audit trail; it is not a docket row and lists nothing.
    def _work_can_delete(self, actor: str, it: WorkItem) -> bool:
        if actor == USER:
            return True
        anchor = self._work_actor_node(it.get("owner")) \
            or self._work_actor_node(it.get("created_by"))
        if not anchor or anchor not in self.nodes:
            return False
        if self.is_ancestor(actor, cast(str, anchor)):
            return True
        return actor == anchor and self.nodes[actor].get("parent") is None

    def _work_children_of(self, wid: str) -> list[str]:
        return [str(o["slug"]) for o in self._work_all()
                if o.get("parent") == wid]

    def work_delete(self, actor: str, wid: str,
                    note: str | None = None) -> dict[str, Any]:
        """Remove `wid` PERMANENTLY — active or archived. See the header."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, phys = self._work_get_for(actor, wid)
        if not self._work_can_delete(actor, it):
            raise LedgerError(
                f"only the user, a superior of {wid}'s owner, or a top-level "
                f"owner may delete it permanently — archive or drop it instead")
        kids = self._work_children_of(str(it["slug"]))
        if kids:
            raise LedgerError(
                f"{wid} still has {len(kids)} nested item(s): "
                f"{', '.join(kids)} — move or delete those first")
        if self._work_questions(str(it["slug"])):
            raise LedgerError(
                f"{wid} has an open attached question — it belongs to its "
                f"asker; withdraw or answer it before deleting the item")
        me = str(it["slug"])
        cleared: list[dict[str, str]] = []
        for other in self._work_all():
            if other is it:
                continue
            deps = other.get("dependencies")
            if isinstance(deps, list) and me in deps:
                other["dependencies"] = [d for d in deps if d != me]
                self._work_hist(other, actor, "pointer_cleared",
                                {"field": "dependencies", "deleted": me})
                cleared.append({"item": str(other["slug"]),
                                "field": "dependencies"})
            if other.get("superseded_by") == me:
                other["superseded_by"] = None       # type: ignore[typeddict-unknown-key]
                self._work_hist(other, actor, "pointer_cleared",
                                {"field": "superseded_by", "deleted": me})
                cleared.append({"item": str(other["slug"]),
                                "field": "superseded_by"})
        (self._work_archive() if phys else self._work_active()).remove(it)
        reserved = self.d.setdefault("work_deleted_names", [])   # type: ignore[typeddict-item]
        if me not in reserved:
            reserved.append(me)
        own = self._work_actor_node(it.get("owner"))
        self._log("work_deleted", actor, {
            "slug": me, "title": str(it.get("title") or ""),
            "status": str(it.get("status") or ""), "owner": own,
            "archived": bool(phys), "note": (note or "").strip() or None,
            "pointers_cleared": cleared}, [])
        told: str | None = None
        if own and own != actor and own != USER and own in self.nodes \
                and self.nodes[own].get("state") == "live":
            body = (f"Your docket item {me} (\"{it.get('title') or ''}\") was "
                    f"PERMANENTLY DELETED by {actor}"
                    + (f": {(note or '').strip()}" if (note or "").strip() else ".")
                    + " The record is gone from the docket and its archive; "
                    "nothing remains to reopen (mail and the org log keep "
                    "their history).")
            try:
                self.post_mail(actor, own, body, "message")
                told = own
            except LedgerError:
                try:
                    self.post_mail(USER, own, body + f" (relayed by the "
                                   f"docket: {actor} could not address you "
                                   f"directly)", "message")
                    told = own
                except LedgerError:
                    told = None
        return {"deleted": me, "was_archived": bool(phys),
                "pointers_cleared": cleared, "owner_told": told}

    # ---- SUB-ITEMS (user 2026-09-05, four approved elements of the nested
    # design). `parent` holds the PARENT'S NAME, like every other pointer
    # here. It is a tree, not a graph: one parent, no cycles.
    #
    # ⚠ A CHILD IS AN INDEPENDENT ITEM, deliberately — its own owner, status,
    # slug and authority, exactly as the approved design says. Nesting is a
    # statement about how work is organised, NOT a permission edge and NOT a
    # lifecycle edge: a parent is not completed by its children, does not
    # inherit their attention, and archiving one does not archive the other.
    def work_move(self, actor: str, wid: str,
                  parent: str | None) -> dict[str, Any]:
        """Put `wid` under `parent`, or at the top with `parent` None/empty."""
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may move an item")
        ref = str(parent or "").strip()
        if not ref:
            was = it.get("parent")
            it["parent"] = None                 # type: ignore[typeddict-unknown-key]
            self._work_hist(it, actor, "move", {"from": was, "to": None})
            self._work_stamp_docket(it, actor)
            return {"moved": it["slug"], "parent": None, "rev": it["rev"]}
        # ⚠ read the prior parent BEFORE overwriting it, or every move
        # records `from: null` and claims the item was at the top level
        was = it.get("parent")
        it["parent"] = self._work_parent_check(actor, it, ref)   # type: ignore[typeddict-unknown-key]
        self._work_hist(it, actor, "move",
                        {"from": was, "to": it.get("parent")})
        self._work_stamp_docket(it, actor)
        return {"moved": it["slug"], "parent": it.get("parent"),
                "rev": it["rev"]}

    def _work_parent_check(self, actor: str, child: WorkItem | None,
                           ref: str) -> str:
        """Resolve `ref` to a usable parent name, or refuse with a reason.

        READ right on the parent is the bar, not manage. Requiring manage
        would stop a subordinate filing its own item under its coordinator's,
        which is the ordinary case this feature exists for; requiring nothing
        would let an agent attach work under an item it cannot even see."""
        parent, _ = self._work_get_for(actor, ref)      # read right, or refused
        if child is not None and parent["slug"] == child["slug"]:
            raise LedgerError("an item cannot be its own parent")
        # ⚠ WALK UP FROM THE PROPOSED PARENT. A cycle would make every item on
        # the ring unreachable from the top of the list and would hang any
        # renderer that walks the tree. `seen` bounds it even if the stored
        # document already contains one.
        seen: set[str] = set()
        cur: Any = parent.get("parent")
        while cur and cur not in seen:
            seen.add(str(cur))
            if child is not None and str(cur) == child["slug"]:
                raise LedgerError(
                    f"that would put {child['slug']} inside its own subtree")
            try:
                nxt, _ = self._work_find(str(cur))
            except LedgerError:
                break
            cur = nxt.get("parent")
        return str(parent["slug"])

    def work_supersede(self, actor: str, wid: str, by: str) -> dict[str, Any]:
        self._work_require_live_agent_or_user(actor)
        self._work_sweep()
        it, _ = self._work_get_for(actor, wid)
        if not self._work_can_manage(actor, it):
            raise LedgerError("only the owner, the creator, their superiors or "
                              "the user may supersede an item")
        other, _ = self._work_get_for(actor, by)
        if not self._work_can_manage(actor, other):
            raise LedgerError(f"you may read {other['slug']} but not manage it - "
                              f"the replacing item needs the same owner-level right")
        if other["slug"] == it["slug"]:
            raise LedgerError("an item cannot supersede itself")
        if it.get("status") == "superseded":
            raise LedgerError(f"{wid} is already superseded by "
                              f"{it.get('superseded_by')} - supersede that one")
        if other.get("status") in self.WORK_CLOSED:
            raise LedgerError(f"{other['slug']} is {other.get('status')} - a "
                              f"replacement must be open work")
        # a chain that leads back here would make both items unreachable
        seen = {it["slug"]}
        cur: str | None = other["slug"]
        while cur and cur not in seen:
            seen.add(cur)
            try:
                nxt, _ = self._work_find(cur)
            except LedgerError:
                break
            cur = nxt.get("superseded_by")
        if cur == it["slug"]:
            raise LedgerError("that would close a supersede cycle")
        frm = it.get("status")
        it["status"] = "superseded"
        self._work_stamp_status(it)
        it["superseded_by"] = other["slug"]
        it["manual_attention"] = None
        # ⚠ a DROPPED item may be superseded (nothing here refuses one), so
        # this clear is load-bearing and not merely tidy: without it the pane
        # would print why the work was abandoned above a live replacement.
        self._work_clear_state_info(it)
        self._work_hist(it, actor, "supersede", {"from": frm, "by": other["slug"]})
        self._work_stamp_docket(it, actor)
        return {"superseded": wid, "by": other["slug"], "rev": it["rev"]}

    # ---- the user's two controls
    def work_dismiss_attention(self, wid: str, set_rev: int) -> dict[str, Any]:
        """The list's Dismiss on a MANUAL flag: CAS on the flag revision it
        was shown for, clears it, sets the work Blocked immediately, records
        the dismissal. Lists, last updater, docket clock and every pending
        question are untouched — pending questions keep the item orange."""
        it, phys = self._work_find(wid)
        cur = it.get("manual_attention")
        if not cur:
            raise LedgerError(f"{wid} has no manual attention flag to dismiss "
                              f"(already cleared or dismissed — re-read the item)")
        if int(cur.get("set_rev") or 0) != int(set_rev):
            raise LedgerError(
                f"the flag changed after it rendered (dismiss against revision "
                f"{set_rev}, flag at {cur.get('set_rev')}) — re-read the "
                f"reason and dismiss what it shows now")
        it.setdefault("dismissals", []).append(
            {"at": now(), "by": USER, "set_rev": int(cur["set_rev"]),
             "reason": cur.get("reason")})
        it["manual_attention"] = None
        frm = it.get("status")
        it["status"] = "blocked"
        # the SYSTEM's own transition into blocked, and it carries its own real
        # reason — it must keep working without agent input (Astra 2026-09-05).
        #
        # It is also a real state change, so it belongs in the status clock
        # like any other transition, even though nobody typed a status here.
        #
        # ⚠ ONLY WHEN IT MOVED THE VALUE. On an item ALREADY blocked this
        # assigns `blocked` over `blocked`, and stamping that would make "most
        # recently changed state" mean "most recently touched".
        if frm != "blocked":
            self._work_stamp_status(it)
        # The clear comes FIRST and the new reason after it: the item may have
        # arrived here from `waiting` or from `dropped`, and every reason it
        # was carrying describes a state it has just left. It reads the state
        # map, so it also covers the `waiting_reason` line this replaces.
        self._work_clear_state_info(it)
        it["blocked_reason"] = f"attention flag dismissed by the user ({cur.get('reason')})"[:500]
        if phys:
            # a dismissed flag on an archived item leaves it blocked, which is
            # open work — it comes back to the active list
            self._work_archive().remove(it)
            it["archived_at"] = None
            self.d.setdefault("work_items", []).append(it)
        self._work_hist(it, USER, "dismiss_attention",
                        {"set_rev": int(cur["set_rev"]), "from": frm})
        self._log("work_dismiss", USER, {"item": wid,
                                         "set_rev": int(cur["set_rev"])}, [])
        notify = self._work_actor_node(it.get("last_updater")) \
            or self._work_actor_node(it.get("owner"))
        return {"dismissed": wid, "rev": it["rev"], "status": "blocked",
                "pending_questions": len(self._work_questions(wid)),
                "notify": notify if notify in self.nodes else None,
                "reason": cur.get("reason")}

    def work_clear_attention_on_user_reply(self, wid: str) -> dict[str, Any]:
        """Clear only manual attention after a successful user reply.

        Pending attached questions remain the effective attention source, and
        the item's work status is deliberately unchanged. This is separate
        from work_dismiss_attention: a reply acknowledges the request but is
        not a user dismissal that should block the item.
        """
        it, _ = self._work_find(wid)
        cur = it.get("manual_attention")
        pending = self._work_questions(wid)
        if not cur or pending:
            return {"cleared": False, "pending_questions": len(pending)}
        it["manual_attention"] = None
        self._work_hist(it, USER, "reply_clear_attention",
                        {"set_rev": int(cur.get("set_rev") or 0)})
        self._work_stamp_docket(it, USER)
        return {"cleared": True, "pending_questions": 0}

    # ---- STEP 4 (design §8): the server side of a qualified reply `target`
    def resolve_reply_target(self, target: Mapping[str, str],
                             recipient: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Resolve a client `target` (already shape-checked by
        events.parse_reply_target) against THIS document, refusing rather
        than fabricating: the object must exist here, and `recipient` must be
        the one the object points at. Returns (Ref, extras) where the Ref is
        filled from the stored object — the client never supplies a title,
        sender or timestamp — and `extras` are the leaf's other fields
        (the mail `quote`, the docket `role`/`owner`)."""
        slug = str(self.d.get("slug") or "")
        if target["org"] != slug:
            raise LedgerError("target.org must be this org")
        kind = target["kind"]
        if kind == "document":
            doc = next((d for d in self.d.get("documents") or []
                        if str(d.get("id")) == target["id"]), None)
            if doc is None:
                raise LedgerError(f"no presented document {target['id']!r} in this org")
            if str(doc.get("node")) != recipient:
                raise LedgerError(f"document {target['id']!r} was presented by "
                                  f"{doc.get('node')!r}, not {recipient!r}")
            return ({"kind": "document", "org": slug, "id": str(doc["id"]),
                     "title": str(doc.get("title") or ""), "node": str(doc.get("node"))},
                    {})
        if kind == "work_item":
            it, _ = self._work_find(target["slug"])
            owner = self._work_actor_node(it.get("owner"))
            # participants are stored as plain node ids (work_participants);
            # accept the actor shape too, as the docket's other readers do
            parts = [(self._work_actor_node(p) if isinstance(p, dict) else str(p))
                     for p in (it.get("participants") or [])]
            parts = [p for p in parts if p]
            if recipient == owner:
                role, own = "owner", None
            elif recipient in parts:
                role, own = "participant", owner
            else:
                raise LedgerError(f"{recipient!r} is neither the owner nor a participant "
                                  f"of {it['slug']}")
            return (self.work_item_ref(it), {"role": role, "owner": own})
        # kind == "mail"
        box, mid = target["box"], target["id"]
        row: Mapping[str, Any] | None = None
        if box == "user":
            rows = [*self.d.get("user_inbox", []), *self.d.get("user_mail_log", [])]
            row = next((m for m in rows if str(m.get("id")) == mid), None)
            allowed = {str(row.get("from"))} if row else set()
        elif box == "org":
            row = next((m for m in self.d.get("org_inbox") or []
                        if str(m.get("id")) == mid), None)
            allowed = {str(row.get("from") or row.get("peer") or "")} if row else set()
        else:
            node = target["node"]
            if node not in self.nodes:
                raise LedgerError(f"no such node {node!r}")
            rows = [*((self.d.get("mail") or {}).get(node) or []),
                    *((self.d.get("mail_log") or {}).get(node) or [])]
            row = next((m for m in rows if str(m.get("id")) == mid), None)
            # the author, or the box's own reader
            allowed = {str(row.get("from")), node} if row else set()
        if row is None:
            raise LedgerError(f"no mail {mid!r} in the {box} box")
        if recipient not in allowed:
            raise LedgerError(f"mail {mid!r} does not involve {recipient!r}")
        gist = " ".join(str(row.get("body") or "").split())
        quote = {"from": str(row.get("from") or ""), "at": str(row.get("at") or ""),
                 "gist": gist if len(gist) <= 200 else gist[:199] + "…"}
        return ({"kind": "mail", "org": slug, "box": box,
                 "node": (target.get("node") if box == "node" else None), "id": mid,
                 "sender": str(row.get("from") or ""), "at": str(row.get("at") or "")},
                {"quote": quote})

    def work_reply_target(self, wid: str) -> dict[str, Any]:
        """Who a general reply goes to: THE ASSIGNMENT, exactly — the item's
        owner. Nobody is chosen in their place; the caller shows the failure.

        ⚠ THERE IS NO SECOND ROUTE (Astra ruling 2026-09-05 21:15). This used
        to read `last_updater`, and an ownership fallback to it would be a
        second assignment model living behind the first: the panel would say
        one name, the reply would reach another, and every later rule about
        "who holds this item" would have to pick a side. `last_updater` stays
        stored, as the history of who wrote the latest status."""
        it, _ = self._work_find(wid)
        own = self._work_actor_node(it.get("owner"))
        if not own:
            raise LedgerError(
                f"{wid} has no assignment — nobody owns it, so there is nobody "
                f"to reply to. Assign it (orgtree_work assign) and the reply "
                f"reaches whoever holds it")
        if own not in self.nodes:
            raise LedgerError(
                f"the assigned agent {own!r} no longer exists in this org — "
                f"the reply was not sent")
        return {"node": own, "role": "owner",
                "state": self.nodes[own].get("state"),
                "title": it["title"], "item": it["slug"]}

    def work_reply_recipient(self, wid: str, to: str) -> dict[str, Any]:
        """An ADDRESSED reply (user 2026-09-06): `to` must be the item's
        current owner or one of its current participants, checked against the
        STORED item at this moment — not against whatever list the panel was
        rendered from. Anything else is refused, and a refusal chooses nobody
        in the caller's place: the owner is NOT substituted for a participant
        who was removed a second ago, because the user picked a name and the
        wrong recipient acting on the reply is worse than no recipient.

        Ownership is untouched: `work_reply_target` (no `to`) keeps meaning
        THE ASSIGNMENT, and addressing a participant does not make them the
        assignment — the mail says so in as many words."""
        it, _ = self._work_find(wid)
        nid = str(to or "").strip()
        own = self._work_actor_node(it.get("owner"))
        if nid == own:
            return self.work_reply_target(wid)
        if nid not in (it.get("participants") or []):
            raise LedgerError(
                f"{nid!r} is neither the assigned agent nor a participant of "
                f"{it['slug']} — the reply was not sent")
        if nid not in self.nodes:
            raise LedgerError(
                f"the participant {nid!r} no longer exists in this org — "
                f"the reply was not sent")
        return {"node": nid, "role": "participant", "owner": own,
                "state": self.nodes[nid].get("state"),
                "title": it["title"], "item": it["slug"]}

    def work_attach_check(self, nid: str, wid: str) -> str:
        """May `nid` attach a question to `wid`? Read right; returns the item's
        canonical name, so what gets STORED on the ask is the canonical form
        rather than whatever the caller happened to type."""
        it, _ = self._work_get_for(nid, wid)
        return str(it["slug"])
