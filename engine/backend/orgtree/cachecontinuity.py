# pyright: strict
"""Pure cache-continuity classification and the stable agent doctrine.

The supervisor owns observation and persistence.  This module deliberately
does no I/O, credential lookup, prompt rendering, or provider calls; that makes
the four proof classes deterministic and keeps provider uncertainty explicit.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from typing import Any, Final, Literal, cast

State = Literal[
    "known_incompatible", "expired_known_entry", "uncertain",
    "compatible_observed",
]

#: READINESS — what the badge renders, as distinct from ``State``, which is
#: what was observed.  User ruling 2026-09-02: compatibility readiness is
#: BINARY in normal operation.  Grey is not a third opinion about the cache;
#: it is reserved for an enumerated fault that prevented an opinion from being
#: formed at all, and every one of those carries a machine-readable cause and
#: a sentence a human can act on.  There is deliberately no catch-all: a cause
#: this table does not know is itself a named state (``internal_error``), so an
#: unclassified condition is loud rather than quietly grey.
Readiness = Literal["ready", "not_ready", "diagnostic", "none"]

#: The closed set.  ⚠ ADDING A BRANCH TO ``classify`` MEANS ADDING A CAUSE
#: HERE — `test_cache_readiness` asserts every emitted cause is in this table
#: and that every entry in this table is reachable, so a new branch that
#: forgets its verdict fails the suite rather than rendering as a silent grey.
READINESS: Final[dict[str, Readiness]] = {
    # GREEN — affirmative evidence of compatibility.  Never a claim that the
    # provider will hit; only that nothing local contradicts the receipt.
    "receipt_valid": "ready",
    "receipt_valid_codex_estimate": "ready",
    # NONE — no cache exists yet. A cache flag is a statement about an existing
    # cache; when there has been no completed turn there is no cache at all, so
    # neither "ready" nor "not ready" is true. The UI renders NO flag at all.
    "no_completed_fingerprint": "none",
    # NONE — a turn is running and the prefix has not moved since it was sent.
    # The entry that turn leaves behind is unobserved until its receipt lands,
    # and every verdict except `prefix_changed` depends on that entry, so there
    # is nothing to claim yet (user ruling 2026-09-03, D-235). Minted at poll
    # time only (`in_flight_row`), never persisted — hence no legacy mapping.
    "turn_in_flight": "none",
    # RED — "not compatibility-ready / not established".  Note the phrasing:
    # with the single exception of an elapsed entry, none of these is proof of
    # an actual provider miss, and the copy must not pretend otherwise.
    "history_unobserved": "not_ready",
    "no_positive_receipt": "not_ready",
    "receipt_prefix_unobserved": "not_ready",
    "prefix_changed": "not_ready",
    "receipt_expired": "not_ready",
    "lane_unobserved": "not_ready",
    "legacy_forecast_unmigrated": "not_ready",
    # GREY — enumerated diagnostics ONLY.  Each names a fault, not a cache
    # state: the provider cannot report, the data would not parse, the clock
    # disagrees with itself, or we failed to classify.
    "unsupported_capability": "diagnostic",
    "receipt_timestamp_unreadable": "diagnostic",
    "clock_anomaly": "diagnostic",
    "internal_error": "diagnostic",
}

#: User-facing explanation per cause.  Every grey MUST be able to say why it
#: is grey, so this is required for a diagnostic and merely useful for the
#: rest.  Kept beside the table so a new cause cannot ship without its copy.
READINESS_DETAIL: Final[dict[str, str]] = {
    "receipt_valid":
        "A positive cache receipt for this exact prefix is still inside the "
        "lane's TTL. A provider hit is likely but never guaranteed.",
    "receipt_valid_codex_estimate":
        "A positive cache receipt for this exact prefix is still inside the "
        "fixed 30-minute Codex subscription estimate. That window is an "
        "estimate, not a reported TTL, and a provider hit is not guaranteed.",
    "no_completed_fingerprint":
        "No completed turn has been observed for this agent yet, so there is "
        "nothing to establish cache readiness from. This is not a miss — it "
        "is the absence of evidence either way.",
    "turn_in_flight":
        "A turn is running and the prefix has not changed since it was sent. "
        "The cache entry that turn leaves behind is not observed until it "
        "ends, so there is nothing to claim yet: this is not a miss and not a "
        "hit, it is the absence of a verdict while the evidence is being "
        "produced.",
    "history_unobserved":
        "Local history continuity could not be observed, so a matching prefix "
        "cannot be established.",
    "no_positive_receipt":
        "The local prefix matches, but no positive cache receipt has been "
        "observed on this lane, so readiness is not established.",
    "receipt_prefix_unobserved":
        "The prefix the cache receipt was observed against could not be "
        "verified locally, so readiness is not established.",
    "prefix_changed":
        "A component of the cached prefix changed — provider, account, lane, "
        "model, session lineage, or the already-sent prompt or history. The "
        "previous entry does not apply to the next turn.",
    "receipt_expired":
        "The observed cache entry has passed its lane boundary. A provider "
        "miss is expected, though not guaranteed.",
    "lane_unobserved":
        "This seat's provider and authentication lane have not been observed "
        "yet, so no cache boundary can be derived. Unlike an unsupported "
        "lane, this is expected to resolve on its own once a turn runs.",
    "legacy_forecast_unmigrated":
        "This forecast was persisted before the readiness classifier existed "
        "and carries no verdict that can be re-derived, so readiness is not "
        "established. It resolves on this agent's next completed turn.",
    "unsupported_capability":
        "This provider and authentication lane publish no cache-readiness "
        "statistic, so readiness cannot be established here for any turn. "
        "This is an accounted provider capability gap, not a fault in this "
        "session and not an unknown: it would resolve only if the provider "
        "began reporting a cache TTL or a positive cache receipt for this "
        "lane, or if the seat moved to a lane that already does.",
    "receipt_timestamp_unreadable":
        "A cache receipt exists for a lane with a known TTL, but its "
        "observation timestamp could not be read, so no boundary can be "
        "derived from it. The next completed turn on this lane writes a fresh "
        "receipt and clears this.",
    "clock_anomaly":
        "The cache receipt is stamped in the future relative to this "
        "backend's clock. Readiness cannot be derived from a boundary that "
        "depends on a clock disagreeing with itself. Check this machine's "
        "clock synchronisation; the state clears once the receipt stamp is no "
        "longer ahead of the backend clock, and a genuinely quantized stamp "
        "is healed automatically on the next read.",
    "internal_error":
        "This condition was not classified. That is a defect in the "
        "readiness classifier itself, not a statement about the cache. It is "
        "logged with the incident detail below for follow-up.",
}

#: Causes whose user-facing text is incomplete without instance evidence.
#: ⚠ ENFORCED, NOT DOCUMENTED: `test_cache_readiness` asserts each of these
#: carries evidence whenever it is emitted, because "grey with an accounted
#: cause" is worth nothing if the account is a constant sentence that never
#: names the provider, the stamp, or the incident that produced it.
EVIDENCE_REQUIRED: Final = (
    "unsupported_capability", "receipt_timestamp_unreadable",
    "clock_anomaly", "internal_error",
)


def readiness_fields(cause: str, *, evidence: str = "") -> dict[str, str]:
    """The three readiness fields for one cause, or the named internal error.

    ⚠ THE UNKNOWN-CAUSE PATH IS THE POINT. A cause this table does not carry
    cannot be rendered as "probably fine" or as a neutral unknown; it collapses
    to ``internal_error``, which is grey, named, explained and logged, and the
    rejected cause is preserved in the evidence so the incident is traceable
    to the branch that produced it. That is what makes "no catch-all
    fallthrough" enforceable rather than aspirational.
    """
    if cause == "no_completed_turn":
        cause = "no_completed_fingerprint"
    readiness = READINESS.get(cause)
    if readiness is None:
        unknown = f"Unclassified readiness cause {cause!r}."
        evidence = f"{unknown} {evidence}".strip()
        cause = "internal_error"
        readiness = READINESS[cause]
    detail = READINESS_DETAIL[cause]
    if evidence:
        detail = f"{detail} {evidence}"
    return {"readiness": readiness, "readiness_cause": cause,
            "readiness_detail": detail}


#: (state, source) → cause, for forecasts persisted BEFORE D-226 existed.
_LEGACY_CAUSE: Final[dict[tuple[str, str], str]] = {
    ("compatible_observed", "authoritative_receipt"): "receipt_valid",
    ("compatible_observed", "codex_subscription_fixed_estimate"):
        "receipt_valid_codex_estimate",
    ("expired_known_entry", "authoritative_receipt"): "receipt_expired",
    ("expired_known_entry", "codex_subscription_fixed_estimate"):
        "receipt_expired",
    ("uncertain", "no_completed_fingerprint"): "no_completed_fingerprint",
    ("uncertain", "no_completed_turn"): "no_completed_fingerprint",
    ("uncertain", "history_unobserved"): "history_unobserved",
    ("uncertain", "no_positive_receipt"): "no_positive_receipt",
    ("uncertain", "receipt_prefix_unobserved"): "receipt_prefix_unobserved",
    ("uncertain", "capability_unsupported"): "unsupported_capability",
    ("uncertain", "clock_skew"): "clock_anomaly",
}


def legacy_readiness(state: str, source: str, lane: str, *,
                     expires_at: Any = None,
                     now: float | None = None) -> dict[str, str]:
    """Re-derive the readiness triple for a row persisted before D-226.

    ⚠ WHY THIS EXISTS RATHER THAN LETTING `public` CALL IT AN INTERNAL ERROR.
    Every forecast persisted before this change lacks the triple. Without this
    function the first poll after deploy would render EVERY idle node grey as
    `internal_error` — and keep doing so until that node's next completed turn
    — while logging an UNCLASSIFIED incident each time. That is a schema
    migration wearing a classifier-defect label: it would slander working code,
    bury a real defect in noise, and strand idle agents on grey indefinitely.

    The mapping is deterministic where the persisted `state`/`source` pair
    already carries the answer, which is the overwhelming majority of rows.
    Where it genuinely does not — `ttl_unobserved` cannot say whether the lane
    was unsupported or the stamp unreadable without the provider, which the
    public row does not carry — the row resolves to RED
    (`legacy_forecast_unmigrated`), never green and never a guessed grey. Red
    is the correct default under the invariant: readiness is not established,
    and it says so honestly instead of inventing a fault that did not happen.

    ⚠ A PERSISTED STATE IS A PAST TENSE, AND `compatible_observed` DECAYS.
    The row records what was true when it was WRITTEN; an entry that was live
    then may have died since. Healing such a row straight to `receipt_valid`
    would manufacture the one thing this system must never invent — a green
    with no live evidence behind it. So when the caller can supply a clock,
    an elapsed expiry demotes the state before it is mapped. Callers that
    cannot supply one get the undecayed answer, which is why every caller
    inside this repo does supply one.
    """
    if state == "compatible_observed" and now is not None:
        expiry = epoch(expires_at)
        if expiry is not None and now >= expiry:   # equality is the boundary
            state = "expired_known_entry"
    cause = _LEGACY_CAUSE.get((state, source))
    if cause is None and source == "ttl_unobserved":
        # The one ambiguous source. Lane resolves the two unambiguous ends of
        # it; anything else is left to the honest red below.
        if lane == "provider_unsupported":
            cause = "unsupported_capability"
        elif lane == "unobserved":
            cause = "lane_unobserved"
    if cause is None and state == "known_incompatible":
        cause = "prefix_changed"       # every known_incompatible source
    if cause is None:
        return readiness_fields(
            "legacy_forecast_unmigrated",
            evidence=f"Persisted as state {state!r}, source {source!r}.")
    if cause in EVIDENCE_REQUIRED:
        return readiness_fields(cause, evidence=(
            f"Re-derived from a pre-D-226 forecast persisted as state "
            f"{state!r}, source {source!r}, lane {lane!r}."))
    return readiness_fields(cause)


def capability_evidence(provider: str, lane: str) -> str:
    """Name the provider, the lane and the missing capability, concretely.

    A grey that says only "unsupported" is the generic unknown the user ruled
    out; this is what makes it accounted for.
    """
    known = ", ".join(f"{p}/{ln}" for p, ln in SUPPORTED_LANES)
    return (f"Provider {provider or 'unknown'} on the "
            f"{lane or 'unobserved'} lane reports no cache TTL. "
            f"Lanes that do: {known}.")

SUBSCRIPTION_TTL_SECONDS: Final = 60 * 60
API_KEY_TTL_SECONDS: Final = 5 * 60
CODEX_SUBSCRIPTION_TTL_SECONDS: Final = 30 * 60

#: The ONLY (provider, lane) pairs with a usable cache-readiness statistic —
#: which here means a real TTL to derive a boundary from. Everything else is
#: `unsupported_capability`, an accounted diagnostic rather than an unknown.
#: ⚠ ONE SOURCE OF TRUTH: `ttl_seconds` reads this table, so a lane cannot be
#: supported for the TTL and unsupported for the badge, or the reverse.
#: Antigravity publishes no such statistic at all, and Codex API-key sessions
#: return no TTL in the app-server usage receipt — neither borrows another
#: lane's number, so neither can establish readiness.
SUPPORTED_LANES: Final[dict[tuple[str, str], int]] = {
    ("claude", "subscription"): SUBSCRIPTION_TTL_SECONDS,
    ("claude", "api_key"): API_KEY_TTL_SECONDS,
    ("openai", "subscription"): CODEX_SUBSCRIPTION_TTL_SECONDS,
    # the OpenRouter lane (2026-09-02): Claude Code against openrouter.ai's
    # Anthropic-compatible endpoint. MEASURED on 2.1.258: every cache write
    # came back as `ephemeral_5m_input_tokens` (the 1h bucket stayed 0) and a
    # resume 40 s later read the whole prefix back — the gateway honours the
    # 5-minute window, never the hour. Its own namespace (another endpoint,
    # another key), never the Claude subscription's.
    ("openrouter", "api_key"): API_KEY_TTL_SECONDS,
}

#: The serialization quantum of durable receipt timestamps. `observed_at` is
#: the microsecond-rounded ISO image of the float clock the same call still
#: holds, and `datetime` rounds to the NEAREST microsecond — so the parsed
#: stamp may sit up to half a quantum ahead of the float it was made from.
#: A skew claim needs more than one whole quantum; anything inside it is the
#: same instant wearing two encodings.
SERIALIZATION_QUANTUM_S: Final = 1e-6

# Stable by construction: no formatting fields, timestamps, account names,
# settings, org state or forecast values may enter this system-prompt block.
CACHE_CONTINUITY_BLOCK: Final = """[CACHE CONTINUITY]
Provider cache continuity is separate from a local warm process. A local process restart or replacement does not by itself prove a provider cache miss.

Always treat a provider, account/auth lane, model, or session-lineage switch as a new cache namespace. A provider switch can also lose provider-specific session/context continuity. Treat a rewrite of the already-sent system/startup prompt, charter, scope, tool or MCP definitions, startup instruction files, or conversation history as a changed prefix. Avoid those changes when they are unnecessary; when they are necessary, surface the cache cost instead of hiding it.

Dynamic turn-envelope facts (org state, mail/notices, usage/status/checkup data, attachments), live process/tool counts, append-only new turns, and an effort-only control change do not invalidate an unchanged earlier prefix by themselves. TTL expiry and provider-side acceptance depend on the actual auth lane and a positive cache receipt: Claude subscription auth uses 60 minutes and Claude API-key auth uses 5 minutes; Codex subscription auth uses a fixed 30-minute estimate from OpenAI's documented gpt-5.6 prompt-cache default. Unsupported or unobserved lanes stay unknown. Even a matching, unexpired local fingerprint is evidence of compatibility, never a guaranteed provider hit.
[END CACHE CONTINUITY]"""

_COMPONENT_ORDER: Final = (
    "provider", "account", "lane", "model", "session", "system", "tools",
    "argv", "env", "startup", "lineage", "mcp_surface", "history",
)

#: Prefix components that are compared ONLY WHEN BOTH SIDES CARRY A VALUE.
#:
#: ⚠ THIS IS THE "UNOBSERVED IS NOT CHANGED" RULE, not a softening of the
#: comparison. The ordinary components are computed from local configuration
#: and always exist, so a missing one really is a difference. `mcp_surface` is
#: an OBSERVATION of what the provider process reported, and an observation can
#: legitimately be absent: before a node's first turn, for a cold node whose
#: process is gone, and — the case that matters most — in every row persisted
#: before this component existed. Treating absence as a change there would
#: report every agent cold on the first poll after deploy, and that false cold
#: is one `_cache_precompact_decision` can ACT on rather than merely display.
#: The same reasoning the history relation already follows, and the same trap
#: `legacy_readiness` and the `_namespace_changed` account carve-out avoid.
_OBSERVED_COMPONENTS: Final = frozenset({"mcp_surface"})


def _component_changed(cur_parts: dict[str, Any], old_parts: dict[str, Any],
                       key: str) -> bool:
    """Did a prefix component MOVE — as opposed to not being observed?"""
    cur = str(cur_parts.get(key) or "")
    old = str(old_parts.get(key) or "")
    if key in _OBSERVED_COMPONENTS and not (cur and old):
        return False
    return cur != old


#: Every prefix component compared by `classify`, in a fixed order.
_PREFIX_COMPONENTS: Final = (
    "system", "tools", "argv", "env", "startup", "lineage", "mcp_surface",
)


def iso(epoch: float) -> str:
    """UTC second-resolution ISO string used by durable evidence."""
    return (dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def iso_us(epoch: float) -> str:
    """UTC microsecond ISO string for computed expiry instants.

    Receipts store microsecond `observed_at`/`expires_at` stamps; a projected
    expiry truncated to whole seconds would disagree with them by up to a
    second and flip displays across the boundary early.
    """
    return (dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
            .isoformat(timespec="microseconds").replace("+00:00", "Z"))


def epoch(value: Any) -> float | None:
    """Defensive timestamp parser.  Invalid and non-positive values are absent."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    try:
        number = parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def digest(value: Any, length: int = 32) -> str:
    """Canonical JSON digest; inputs are local metadata, never prompt text."""
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, default=str).encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()[:length]


def ttl_seconds(provider: str, lane: str) -> int | None:
    """Fixed cache window for an observed auth lane.

    Claude receipts expose the two provider TTL lanes directly. Codex does not
    return a TTL in the app-server usage receipt, so its subscription value is
    the user's fixed estimate: the documented gpt-5.6 Responses API default
    (30m, currently the only supported prompt_cache_options.ttl value).
    Antigravity and Codex API-key sessions remain unknown rather than
    borrowing a lane.
    """
    return SUPPORTED_LANES.get((provider, lane))


def positive_usage(usage: Any) -> tuple[int, int]:
    """Return authoritative cache read/write token counts, defensively."""
    row = usage if isinstance(usage, dict) else {}

    def count(key: str) -> int:
        try:
            value = int(row.get(key) or 0)
        except (TypeError, ValueError, OverflowError):
            return 0
        return max(value, 0)

    return count("cache_read_input_tokens"), count(
        "cache_creation_input_tokens")


def _reason(component: str, text: str, at: str,
            confidence: str = "known") -> dict[str, str]:
    return {"component": component, "reason": text,
            "evidence_at": at, "confidence": confidence}


def _different(current: dict[str, Any], prior: dict[str, Any],
               key: str) -> bool:
    return str(current.get(key) or "") != str(prior.get(key) or "")


#: The main login's account namespace when WHICH account occupies it could not
#: be observed — and the only value carried by rows persisted before the main
#: account was qualified at all.  The supervisor's qualified form is
#: ``primary:<digest>``; see ``supervisor._cache_primary_namespace``.
UNQUALIFIED_PRIMARY: Final = "primary"


def _namespace_changed(current: dict[str, Any], prior: dict[str, Any],
                       key: str) -> bool:
    """Did a namespace component MOVE — as opposed to becoming observable?

    ⚠ THE ACCOUNT CARVE-OUT IS A MIGRATION RULE, NOT A LOOPHOLE. The main
    login is now qualified by its own account digest so that signing in as a
    different person is the namespace change it always was; the bare seat name
    survives in exactly two places, neither of which is a different account:
    a row persisted before that qualification existed, and a login this
    machine currently cannot read. Counting either as a switch would report
    every pre-existing agent's prefix cold on the first poll after this ships
    — the same schema-migration-wearing-a-defect-label mistake
    ``legacy_readiness`` exists to prevent, except that here ``will_compact``
    can ACT on the false cold rather than merely display it. Unobserved is not
    changed; the history relation already follows that rule. Two qualified
    values that differ are a real switch and always report as one.
    """
    if not _different(current, prior, key):
        return False
    if key != "account":
        return True
    cur = str(current.get(key) or "")
    old = str(prior.get(key) or "")
    qualified = UNQUALIFIED_PRIMARY + ":"
    return not ((cur == UNQUALIFIED_PRIMARY and old.startswith(qualified))
                or (old == UNQUALIFIED_PRIMARY and cur.startswith(qualified)))


def classify(current: dict[str, Any], continuity: dict[str, Any] | None,
             now: float) -> dict[str, Any]:
    """Classify the next turn from a current snapshot and durable evidence.

    ``current`` contains secret-safe component digests plus private provider
    lane identifiers.  History relations are prepared by the supervisor from
    prefix hashes: ``same_or_appended``, ``changed`` or ``unobserved``.
    """
    book = continuity if isinstance(continuity, dict) else {}
    last = book.get("last_turn")
    last = cast(dict[str, Any], last) if isinstance(last, dict) else {}
    receipt = book.get("receipt")
    receipt = cast(dict[str, Any], receipt) if isinstance(receipt, dict) else {}
    at = str(current.get("captured_at") or iso(now))
    expected = int(current.get("expected_input_tokens") or 0)

    # A lane that publishes no readiness statistic cannot be made ready by any
    # later turn, so answering it with "no completed fingerprint" or "no
    # positive receipt" would be true but misleading — both read as "not ready
    # YET". The capability gap is the honest answer for those cases.
    #
    # ⚠ BUT IT DOES NOT OUTRANK A KNOWN INCOMPATIBILITY, and the ordering below
    # is load-bearing. A seat that moved TO an unsupported lane has both facts
    # true at once: the prefix changed, and the new lane cannot report. The
    # prefix change is a POSITIVE determination that the next turn is cold,
    # which is strictly more informative than "cannot tell" — and the ruling
    # wants red wherever an opinion can be formed, reserving grey for where one
    # cannot. So capability is consulted only where the alternative would have
    # been an unestablished red, never where it would have been a known red.
    #
    # Only a POSITIVE determination counts as a gap. An empty or unobserved
    # provider/lane is not a capability claim — we simply have not looked yet —
    # so it falls through to `lane_unobserved`, which is red and self-resolving.
    #
    # ⚠ "UNOBSERVED" IS A NON-EMPTY STRING, and the supervisor never writes an
    # empty lane — `_cache_snapshot` writes `lane or "unobserved"`. Until
    # 2026-09-04 (astras-entrance-exam) this predicate tested emptiness only,
    # so every real unobserved lane on a known provider — a Claude token no
    # stored row explains, a Codex auth record naming no account, an
    # OpenRouter tier with no key — was reported as the provider being unable
    # to report, which is the slander the comment above forbids. The sentinel
    # is excluded by name, matching `legacy_readiness`'s own reading of it.
    provider_id = str(current.get("provider") or "")
    lane_id = str(current.get("lane") or "")
    capability_gap = lane_id == "provider_unsupported" or bool(
        provider_id and lane_id and lane_id != "unobserved"
        and (provider_id, lane_id) not in SUPPORTED_LANES)

    def capability_row() -> dict[str, Any]:
        return {
            "state": "uncertain", "source": "capability_unsupported",
            "reason": ("This provider/auth lane publishes no cache-readiness "
                       "statistic."),
            "reasons": [_reason("ttl", "provider lane publishes no cache TTL",
                                at, "unobserved")],
            "observed_at": at, "last_receipt_at": receipt.get("observed_at"),
            "lane": lane_id or "unobserved",
            "ttl_seconds": None, "expires_at": None,
            "confidence": "unobserved", "expected_input_tokens": expected,
            **readiness_fields(
                "unsupported_capability",
                evidence=capability_evidence(provider_id, lane_id)),
        }

    if not last:
        # Nothing to diff against, so no known incompatibility is possible
        # here and capability is the more honest of the two available answers.
        if capability_gap:
            return capability_row()
        return {
            "state": "uncertain", "source": "no_completed_fingerprint",
            "reason": "No completed turn fingerprint has been observed yet.",
            "reasons": [_reason("history", "no completed fingerprint", at,
                                "unobserved")],
            "observed_at": at, "last_receipt_at": None,
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": None, "expires_at": None,
            "confidence": "unobserved",
            # A cache flag is a statement about an existing cache. When there
            # has been no completed turn there is no cache at all, so neither
            # "ready" nor "not ready" is true. Readiness is "none" and no cache
            # flag renders.
            **readiness_fields("no_completed_fingerprint"),
        }

    changed: list[dict[str, str]] = []
    labels = {
        "provider": "provider namespace changed",
        "account": "provider account/auth namespace changed",
        "lane": "provider authentication lane changed",
        "model": "model namespace changed",
        "session": "session lineage changed",
    }
    for key in ("provider", "account", "lane", "model", "session"):
        if _namespace_changed(current, last, key):
            changed.append(_reason(key, labels[key], at))
    cur_parts = current.get("components")
    cur_parts = cast(dict[str, Any], cur_parts) if isinstance(cur_parts, dict) else {}
    old_parts = last.get("components")
    old_parts = cast(dict[str, Any], old_parts) if isinstance(old_parts, dict) else {}
    for key in _PREFIX_COMPONENTS:
        if _component_changed(cur_parts, old_parts, key):
            changed.append(_reason(key, f"{key} prefix component changed", at))
    relation = str(current.get("last_turn_history_relation") or "unobserved")
    if relation == "changed":
        changed.append(_reason("history", "already-sent history was rewritten or truncated",
                               at))
    # A receipt belongs to one namespace and one observed prefix.  Append-only
    # later history preserves that prefix; mutation does not.  Compare it even
    # when the last-turn fingerprint also moved: the UI contract requires
    # EVERY changed component, not merely the first baseline that proves cold.
    receipt_changes: list[dict[str, str]] = []
    receipt_relation = str(current.get("receipt_history_relation") or "unobserved")
    if receipt:
        for key in ("provider", "account", "lane", "model", "session"):
            if _namespace_changed(current, receipt, key):
                receipt_changes.append(_reason(key, labels[key], at))
        receipt_parts = receipt.get("components")
        receipt_parts = (cast(dict[str, Any], receipt_parts)
                         if isinstance(receipt_parts, dict) else {})
        for key in _PREFIX_COMPONENTS:
            if _component_changed(cur_parts, receipt_parts, key):
                receipt_changes.append(_reason(
                    key, f"{key} cache-observed prefix component changed", at))
        if receipt_relation == "changed":
            receipt_changes.append(
                _reason("history", "cache-observed history prefix changed", at))

    # Stable, component-complete union.  A component that differs from both
    # the last completed request and the last positive receipt appears once.
    all_changes: list[dict[str, str]] = []
    changed_components: set[str] = set()
    for item in (*changed, *receipt_changes):
        component = item["component"]
        if component not in changed_components:
            changed_components.add(component)
            all_changes.append(item)
    if all_changes:
        return {
            "state": "known_incompatible",
            "source": ("fingerprint_and_receipt_mismatch"
                       if changed and receipt_changes else
                       "fingerprint_mismatch" if changed else
                       "receipt_prefix_mismatch"),
            "reason": all_changes[0]["reason"],
            "reasons": all_changes,
            "observed_at": at,
            "last_receipt_at": receipt.get("observed_at"),
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": receipt.get("ttl_seconds"),
            "expires_at": receipt.get("expires_at"),
            "confidence": "known", "expected_input_tokens": expected,
            **readiness_fields("prefix_changed"),
        }
    # Past the known-incompatible gate: from here every remaining outcome would
    # be an "unestablished" red, so a lane that can never establish anything is
    # better described by its capability gap than by a red it can never clear.
    if capability_gap:
        return capability_row()
    if relation == "unobserved":
        return {
            "state": "uncertain", "source": "history_unobserved",
            "reason": "Local history continuity could not be observed.",
            "reasons": [_reason("history", "history continuity unobserved", at,
                                "unobserved")],
            "observed_at": at,
            "last_receipt_at": receipt.get("observed_at"),
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": receipt.get("ttl_seconds"),
            "expires_at": receipt.get("expires_at"),
            "confidence": "uncertain", "expected_input_tokens": expected,
            **readiness_fields("history_unobserved"),
        }

    if not receipt:
        return {
            "state": "uncertain", "source": "no_positive_receipt",
            "reason": "The local prefix matches, but no positive cache receipt was observed.",
            "reasons": [_reason("receipt", "positive cache receipt unobserved", at,
                                "unobserved")],
            "observed_at": at, "last_receipt_at": None,
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": None, "expires_at": None,
            "confidence": "uncertain", "expected_input_tokens": expected,
            **readiness_fields("no_positive_receipt"),
        }
    if receipt_relation == "unobserved":
        return {
            "state": "uncertain", "source": "receipt_prefix_unobserved",
            "reason": "The cache-observed history prefix could not be verified locally.",
            "reasons": [_reason("history", "cache-observed prefix unobserved", at,
                                "unobserved")],
            "observed_at": at,
            "last_receipt_at": receipt.get("observed_at"),
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": receipt.get("ttl_seconds"),
            "expires_at": receipt.get("expires_at"),
            "confidence": "uncertain", "expected_input_tokens": expected,
            **readiness_fields("receipt_prefix_unobserved"),
        }

    provider = str(current.get("provider") or "")
    lane = str(current.get("lane") or "")
    ttl = ttl_seconds(provider, lane)
    codex_estimate = provider == "openai" and lane == "subscription"
    observed = epoch(receipt.get("observed_at"))
    if ttl is None or observed is None:
        # ⚠ TWO DIFFERENT FAULTS SHARE THIS SOURCE, and they are not the same
        # colour. A missing TTL here can no longer mean "unsupported provider"
        # — the capability gate above already returned for every positively
        # unsupported pair — so it means the lane was never observed, which is
        # RED and resolves itself once a turn runs. An unreadable receipt
        # STAMP on a lane that does have a TTL is a data fault, which is a
        # named GREY diagnostic. Collapsing the two would either slander a
        # working provider or hide a corrupt receipt.
        unreadable = ttl is not None and observed is None
        return {
            "state": "uncertain", "source": "ttl_unobserved",
            "reason": "A positive cache receipt exists, but this provider/auth lane has no authoritative TTL.",
            "reasons": [_reason("ttl", "authoritative TTL unobserved", at,
                                "unobserved")],
            "observed_at": at, "last_receipt_at": receipt.get("observed_at"),
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": None, "expires_at": None,
            "confidence": "uncertain", "expected_input_tokens": expected,
            **(readiness_fields(
                "receipt_timestamp_unreadable",
                evidence=("Receipt observed_at "
                          f"{str(receipt.get('observed_at') or '(absent)')!r} "
                          f"could not be parsed on the {lane or 'unobserved'} "
                          f"lane, whose TTL is {ttl}s."))
               if unreadable else
               readiness_fields("lane_unobserved")),
        }
    expires = observed + ttl
    if observed - now > SERIALIZATION_QUANTUM_S:
        return {
            "state": "uncertain", "source": "clock_skew",
            "reason": "The receipt timestamp is in the future relative to this backend clock.",
            "reasons": [_reason("clock", "receipt timestamp is in the future", at,
                                "uncertain")],
            "observed_at": at, "last_receipt_at": receipt.get("observed_at"),
            "lane": str(current.get("lane") or "unobserved"),
            "ttl_seconds": ttl, "expires_at": iso_us(expires),
            "confidence": "uncertain", "expected_input_tokens": expected,
            **readiness_fields("clock_anomaly", evidence=(
                f"Receipt stamped {iso_us(observed)}, backend clock "
                f"{iso_us(now)}, ahead by {observed - now:.6f}s (tolerance "
                f"{SERIALIZATION_QUANTUM_S:g}s).")),
        }
    if observed > now:
        now = observed          # inside one quantum: the same instant, clamped
    return _receipt_verdict(
        expired=now >= expires,        # equality is the expiry boundary
        codex_estimate=codex_estimate, at=at,
        last_receipt_at=receipt.get("observed_at"),
        lane=str(current.get("lane") or "unobserved"),
        ttl=ttl, expires=expires, expected=expected)


def _receipt_verdict(*, expired: bool, codex_estimate: bool, at: str,
                     last_receipt_at: Any, lane: str, ttl: int,
                     expires: float, expected: int) -> dict[str, Any]:
    """The two matching-receipt outcomes, shared with legacy-row healing."""
    if expired:
        return {
            "state": "expired_known_entry",
            "source": ("codex_subscription_fixed_estimate" if codex_estimate
                       else "authoritative_receipt"),
            "reason": (
                "The fixed 30-minute Codex subscription cache estimate has "
                "elapsed; a provider miss is expected, not guaranteed."
                if codex_estimate else
                f"The observed {ttl // 60}-minute cache entry has expired."),
            "reasons": [_reason(
                "ttl", ("fixed Codex subscription cache estimate elapsed"
                        if codex_estimate else
                        "authoritative cache entry expired"), at,
                "estimated" if codex_estimate else "known")],
            "observed_at": at, "last_receipt_at": last_receipt_at,
            "lane": lane,
            "ttl_seconds": ttl, "expires_at": iso_us(expires),
            "confidence": ("estimated" if codex_estimate else "known"),
            "expected_input_tokens": expected,
            **readiness_fields("receipt_expired"),
        }
    return {
        "state": "compatible_observed",
        "source": ("codex_subscription_fixed_estimate" if codex_estimate
                   else "authoritative_receipt"),
        "reason": (
            "The local prefix matches a positive receipt inside the fixed "
            "30-minute Codex subscription estimate; a provider hit is not "
            "guaranteed."
            if codex_estimate else
            "The local prefix matches an unexpired positive cache receipt; "
            "a provider hit is still not guaranteed."),
        "reasons": [_reason(
            "receipt", ("matching positive receipt inside fixed Codex "
                        "subscription estimate" if codex_estimate else
                        "matching unexpired positive cache receipt"), at,
            "estimated" if codex_estimate else "observed")],
        "observed_at": at, "last_receipt_at": last_receipt_at,
        "lane": lane,
        "ttl_seconds": ttl, "expires_at": iso_us(expires),
        "confidence": "observed", "expected_input_tokens": expected,
        # The ONLY two green causes in the system. Both require a positive
        # receipt whose prefix still matches and whose boundary has not passed.
        **readiness_fields("receipt_valid_codex_estimate" if codex_estimate
                           else "receipt_valid"),
    }


def heal_quantized_skew(forecast: Any, now: float) -> dict[str, Any] | None:
    """Reclassify one persisted false ``clock_skew`` forecast row, or None.

    The healable artifact is exact: a zero-tolerance comparison of one call's
    float clock against its own microsecond-serialized receipt stamp, provable
    because that call recorded identical ``observed_at`` and
    ``last_receipt_at`` strings. A receipt genuinely observed in the future
    carries a distinct (later) ``last_receipt_at`` and is preserved untouched,
    as is any row this cannot re-derive a verdict for. The verdict follows the
    fixed lane boundary: before the TTL the entry is compatible, after it
    expired. Codex's fixed-estimate labelling is recovered from the lane plus
    the TTL value itself — the fixed TTL table maps them one-to-one.
    """
    row = cast("dict[str, Any]", forecast) if isinstance(forecast, dict) else {}
    if (str(row.get("state") or "") != "uncertain"
            or str(row.get("source") or "") != "clock_skew"):
        return None
    at = str(row.get("observed_at") or "")
    receipt_at: Any = row.get("last_receipt_at")
    if not at or not isinstance(receipt_at, str) or at != receipt_at:
        return None
    observed = epoch(receipt_at)
    ttl_raw: Any = row.get("ttl_seconds")
    if (observed is None or isinstance(ttl_raw, bool)
            or not isinstance(ttl_raw, (int, float)) or ttl_raw <= 0):
        return None
    if observed - now > SERIALIZATION_QUANTUM_S:
        return None            # still genuinely ahead of this clock: keep it
    ttl = int(ttl_raw)
    lane = str(row.get("lane") or "unobserved")
    codex_estimate = (lane == "subscription"
                      and ttl == CODEX_SUBSCRIPTION_TTL_SECONDS)
    try:
        expected = int(row.get("expected_input_tokens") or 0)
    except (TypeError, ValueError, OverflowError):
        expected = 0
    expires = observed + ttl
    return _receipt_verdict(
        expired=max(now, observed) >= expires, codex_estimate=codex_estimate,
        at=at, last_receipt_at=receipt_at, lane=lane, ttl=ttl,
        expires=expires, expected=expected)


def in_flight_row(*, at: str, lane: str, last_receipt_at: Any,
                  expected: int) -> dict[str, Any]:
    """The projection for a node mid-turn whose prefix has not moved since launch.

    ⚠ NOT A `classify` BRANCH, AND NEVER PERSISTED. `classify` answers "what
    will the next request find" from the last completed turn and the last
    positive receipt. Mid-turn that question has a third participant: the
    entry the running turn is writing or refreshing right now, which exists at
    the provider but is unobserved here until the turn's receipt lands. Every
    readiness verdict except `prefix_changed` depends on that entry — green
    and its countdown compare against a receipt the running turn's own calls
    are refreshing; `receipt_expired`, `no_positive_receipt` and the
    unobserved causes describe the launch of the turn in flight — so the
    honest projection while it is in flight is "nothing to claim yet":
    readiness `none`, the same absence-of-a-claim the fresh-node case uses,
    never a red that describes a launch that has already happened and never a
    green counting down to a receipt that is being superseded. The supervisor
    builds this row at poll time (`cache_forecast_public`, against the request
    in flight) and it never enters the durable book, which is why the legacy
    tables carry no mapping for it. Stamped at launch (`at`), not per poll, so
    the row — and its generation — stay stable for the turn's duration.
    """
    return {
        "state": "uncertain", "source": "turn_in_flight",
        "reason": ("A turn is running; the prefix has not changed since it was "
                   "sent, and the entry it leaves behind is not observed until "
                   "it ends."),
        "reasons": [_reason("history", "turn in flight, prefix unchanged since launch",
                            at, "unobserved")],
        "observed_at": at, "last_receipt_at": last_receipt_at,
        "lane": lane, "ttl_seconds": None, "expires_at": None,
        "confidence": "unobserved", "expected_input_tokens": expected,
        **readiness_fields("turn_in_flight"),
    }


def public(forecast: dict[str, Any], *, generation: str,
           precompact_action: str, precompact_reason: str) -> dict[str, Any]:
    """Credential-free, atomic UI/WebSocket forecast projection.

    ⚠ THE COERCIONS BELOW ARE NOT SILENT ANY MORE. This function used to fold
    an unrecognised ``state`` or ``lane`` into "uncertain"/"unobserved" and say
    nothing, which is precisely the catch-all the readiness ruling forbids: a
    classifier bug arrived at the badge wearing the same neutral grey as a
    provider that simply cannot report. Anything unrecognised now ALSO sets the
    readiness triple to ``internal_error``, carrying the rejected value as
    incident detail, so the defect is visible instead of averaged away.
    """
    salvage: list[str] = []
    state = str(forecast.get("state") or "uncertain")
    if state not in ("known_incompatible", "expired_known_entry", "uncertain",
                     "compatible_observed"):
        salvage.append(f"unrecognised state {state!r}")
        state = "uncertain"
    changed_inputs: list[str] = []
    if state == "known_incompatible":
        seen: set[str] = set()
        for row in forecast.get("reasons") or []:
            component = str(row.get("component") or "") \
                if isinstance(row, dict) else ""
            if component in _COMPONENT_ORDER:
                seen.add(component)
        changed_inputs = [component for component in _COMPONENT_ORDER
                          if component in seen]
    lane = str(forecast.get("lane") or "unobserved")
    if lane not in ("subscription", "api_key", "provider_unsupported",
                    "unobserved"):
        salvage.append(f"unrecognised lane {lane!r}")
        lane = "unobserved"
    if precompact_action not in (
            "will_compact", "miss_expected", "not_applicable"):
        salvage.append(f"unrecognised precompact_action {precompact_action!r}")
        precompact_action = "not_applicable"

    # The readiness triple is decided where the evidence is — in `classify` —
    # so this only VALIDATES it. A row without one (a legacy persisted
    # forecast, a caller that built a dict by hand) is not assumed good: an
    # absent or unknown cause resolves to `internal_error` through the same
    # single door every other unknown uses.
    cause = str(forecast.get("readiness_cause") or "")
    if cause and cause not in READINESS:
        salvage.append(f"unrecognised readiness_cause {cause!r}")
    if salvage:
        readiness = readiness_fields("internal_error",
                                     evidence="; ".join(salvage) + ".")
    elif not cause:
        # A row with no triple at all is a PRE-D-226 forecast, not a defect —
        # re-derive it from what was persisted rather than reporting an
        # incident that did not occur. See `legacy_readiness`.
        readiness = legacy_readiness(
            state, str(forecast.get("source") or ""), lane)
    else:
        readiness = readiness_fields(cause)
        detail = str(forecast.get("readiness_detail") or "")
        if detail:
            readiness["readiness_detail"] = detail   # keep instance evidence
    return {
        **readiness,
        "generation": generation,
        "state": state,
        "reason": str(forecast.get("reason") or "Cache continuity is uncertain."),
        "source": str(forecast.get("source") or "unobserved"),
        "observed_at": str(forecast.get("observed_at") or ""),
        "last_receipt_at": forecast.get("last_receipt_at"),
        "expires_at": forecast.get("expires_at"),
        "lane": lane,
        "ttl_seconds": forecast.get("ttl_seconds"),
        "precompact_action": precompact_action,
        "precompact_reason": precompact_reason,
        # Always present, always secret-free.  The UI tooltip can render this
        # without guessing whether absence means "unchanged" or "old server".
        "changed_inputs": changed_inputs,
    }


def generation(current: dict[str, Any], forecast: dict[str, Any], seq: int) -> str:
    """Opaque generation for stale WebSocket-event suppression."""
    return digest({"node_generation": current.get("node_generation"),
                   "fingerprint": current.get("fingerprint"),
                   "state": forecast.get("state"), "seq": seq}, 24)


def component_names() -> tuple[str, ...]:
    """Documentation/test surface; order is stable and provider-neutral."""
    return _COMPONENT_ORDER
