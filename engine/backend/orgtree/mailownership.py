"""Who holds a drained mail batch — decided from evidence, never from mood.

`supervisor._delivery_stages` answers a neighbouring question and answers it
with one node-wide bit: `busy or waiting or responding or proc_control or
leased`.  A token in no carrier at all is then labelled `steer` merely because
the node happens to be answering something else, and an old orphan that nothing
will ever move reads as mail on its way.  For a receipt on a desk that is a
cosmetic error.  For a manual retrieval door it is not: a caller that believes
that answer leaves the very mail it was asked to recover permanently
unavailable, because it declines to take a batch nobody owns.

This module is the shared rule set both later readers — self-inspection and
reclaim — must use instead of re-deriving it.  It is deliberately a leaf:

  * it imports nothing from this package, reads no module or process global,
    takes no lock, loads and saves nothing, opens no transcript, calls no
    provider, and mints no identifier of any kind;
  * every fact it judges arrives inside one frozen `OwnershipSnapshot`,
    including the clock, so the same snapshot classifies identically forever;
  * it has NO production consumer in this slice, and building the snapshot
    from a live node is explicitly NOT part of it.

That last point is a boundary, not an omission.  A real snapshot needs a
current owner/generation/turn identity that is actually bound to the running
turn, and this base has none: `turn_identity()` returns the billing account
string, and `st['mail_attempt_tokens']` is a list with no generation or turn
fence on it.  An adapter that manufactured `CustodyRef` out of the node's
present identity plus that unversioned list would hand this classifier a
forgery and get back a confident answer.  The adapter, the adoption-site
enumeration and the atomic transition are gated behind a separate proposal.

THE THREE ABSENCES ARE NOT ONE.  `Gap.ABSENT` (nobody ever wrote this),
`Gap.UNKNOWN` (the observer looked and could not tell) and `Gap.UNSUPPORTED`
(a value is present and is outside its domain) are distinct inputs with
distinct outcomes, because collapsing present-but-unreadable into absent is
the one bug this family keeps producing: it read a stored counter as unset, a
stamped row as unstamped and a stamped mailbox as legacy, three rounds running.
Absent may be benign.  Unsupported never is.

WHAT COMES BACK.  One `TokenVerdict` per journal batch, carrying four
independent facts rather than one overloaded verdict:

  `disposition`  PROTECTED / ELIGIBLE / UNAVAILABLE — and `reclaimable` is
                 True for ELIGIBLE and nothing else, ever.
  `owner`        PROVEN / UNPROVEN / NONE — whether a complete matching
                 custody tuple actually named the holder.  A bare legacy
                 `drive_lease` flag stops a destructive reclaim without
                 proving whose the batch is; those two facts are different
                 and are reported separately.
  `confirmation` echoed from the evidence supplied, never inferred.  A
                 missing journal row proves neither confirmation nor
                 fold-back, and acknowledgment is not Read.
  `content`      PRESENT, or UNKNOWN when there is no row to read.

The reason codes are INTERNAL.  They are not a wire enum, a UI label or a
delivery stage, and nothing in this module is a public tool surface.
"""

from __future__ import annotations

import dataclasses
import datetime as _dtm
import enum
from collections.abc import Iterable, Mapping, Sequence
from types import MappingProxyType
from typing import Any

__all__ = [
    "DRAIN_GRACE_S",
    "Gap",
    "Disposition",
    "OwnerEvidence",
    "Confirmation",
    "Content",
    "Reason",
    "CustodyRef",
    "MembershipKind",
    "Membership",
    "CarrierKind",
    "CarrierHold",
    "Claim",
    "Lease",
    "RetentionKind",
    "Retention",
    "NodeActivity",
    "JournalBatch",
    "OwnershipSnapshot",
    "TokenVerdict",
    "Classification",
    "Selection",
    "classify",
    "select",
]

#: The drain-stamp hysteresis, in seconds.  This is `supervisor.STRANDED_GRACE_S`
#: restated rather than imported, because importing the supervisor would make
#: this module anything but a leaf.  `tests/test_mail_ownership.py` reads the
#: supervisor's own source text and fails if the two ever drift apart.  It is
#: NOT a new grace: the same ten seconds, measured the same way, from the same
#: stamp.
DRAIN_GRACE_S = 10.0


class Gap(enum.Enum):
    """The three ways a fact can fail to be a fact.  See the module docstring:
    these are never collapsed into each other, and no caller may substitute
    one for another."""

    ABSENT = "absent"            # the key was never written
    UNKNOWN = "unknown"          # present, and the observer could not resolve it
    UNSUPPORTED = "unsupported"  # present, and outside its declared domain


class Disposition(enum.Enum):
    """The only question this module answers about a batch."""

    PROTECTED = "protected"        # something holds it; leave it alone
    ELIGIBLE = "eligible"          # nothing holds it and the grace has passed
    UNAVAILABLE = "unavailable"    # the evidence does not support any conclusion


class OwnerEvidence(enum.Enum):
    PROVEN = "proven"        # a complete matching custody tuple named the holder
    UNPROVEN = "unproven"    # something holds it; which holder is not established
    NONE = "none"            # no holder fact at all


class Confirmation(enum.Enum):
    NONE = "none"                  # no confirmation evidence was supplied
    ACKNOWLEDGED = "acknowledged"  # a receipt only — explicitly NOT Read
    IN_FLIGHT = "in_flight"        # durable confirmation intent, save may have failed
    CONFIRMED = "confirmed"        # positive matched runtime input evidence
    UNKNOWN = "unknown"            # evidence present and unreadable


class Content(enum.Enum):
    PRESENT = "present"    # a journal row carries the batch
    UNKNOWN = "unknown"    # no row; nothing may be inferred from its absence


class Reason(enum.Enum):
    """Internal reason codes.  Every rule that fires is recorded, not just the
    first, so a report says everything that is true about a batch."""

    # --- snapshot- and token-level integrity (rule 6) --------------------
    CURRENT_IDENTITY_UNSUPPORTED = "current_identity_unsupported"
    UNSUPPORTED_TOKEN = "unsupported_token"
    DUPLICATE_TOKEN_RECORDS = "duplicate_token_records"
    NO_JOURNAL_ROW = "no_journal_row"
    AMBIGUOUS_OWNERSHIP = "ambiguous_ownership"
    # --- custody memberships (rule 2) ------------------------------------
    CURRENT_TURN_MEMBERSHIP = "current_turn_membership"
    MANUAL_FETCH_MEMBERSHIP = "manual_fetch_membership"
    OWNER_MEMBERSHIP_STALE = "owner_membership_stale"
    OWNER_MEMBERSHIP_UNSUPPORTED = "owner_membership_unsupported"
    MODE_LABEL_ONLY = "mode_label_only"
    # --- in-memory carriers (rule 3) -------------------------------------
    QUEUE_CARRIER_LIVE = "queue_carrier_live"
    QUEUE_CARRIER_NO_CONSUMER = "queue_carrier_no_consumer"
    STEER_CARRIER_LIVE = "steer_carrier_live"
    STEER_CARRIER_NO_CONSUMER = "steer_carrier_no_consumer"
    STEER_LIMBO_REQUESTED = "steer_limbo_requested"
    LIVE_PUMP = "live_pump"
    CARRIER_LIVENESS_UNKNOWN = "carrier_liveness_unknown"
    # --- durable claims and leases (rules 3, 4) --------------------------
    CLAIM_HELD = "claim_held"
    CLAIM_UNRESOLVED = "claim_unresolved"
    CLAIM_CONFLICT = "claim_conflict"
    LEASE_HELD = "lease_held"
    LEASE_EXPIRED = "lease_expired"
    LEASE_UNRESOLVED = "lease_unresolved"
    LEASE_WITHOUT_TOKEN_MEMBERSHIP = "lease_without_token_membership"
    # --- retained carriers (rule 3) --------------------------------------
    HALT_HELD = "halt_held"
    NATIVE_HELD = "native_held"
    # --- confirmation (rule 7) -------------------------------------------
    CONFIRMATION_IN_FLIGHT = "confirmation_in_flight"
    CONFIRMED_BY_MATCHED_EVIDENCE = "confirmed_by_matched_evidence"
    ACKNOWLEDGED_NOT_CONFIRMED = "acknowledged_not_confirmed"
    CONFIRMATION_UNKNOWN = "confirmation_unknown"
    # --- grace and the residual case (rules 1, 5) ------------------------
    WITHIN_DRAIN_GRACE = "within_drain_grace"
    GRACE_STAMP_ABSENT = "grace_stamp_absent"
    GRACE_STAMP_UNREADABLE = "grace_stamp_unreadable"
    UNOWNED_PAST_GRACE = "unowned_past_grace"


# --------------------------------------------------------------------------
# domains
# --------------------------------------------------------------------------

def _token_key(value: Any) -> str | Gap:
    """A journal token's domain: a non-empty `str`, exactly as `_journal_drain`
    mints it.  Everything else is UNSUPPORTED — including `None`, `0`, `False`
    and the empty string, which `_delivery_stages` skips silently and which a
    reclaim caller must never treat as "no token, so no owner"."""
    if value is None:
        return Gap.ABSENT
    if isinstance(value, str) and value:
        return value
    return Gap.UNSUPPORTED


def _text(value: Any) -> str | Gap:
    if value is None:
        return Gap.ABSENT
    if isinstance(value, Gap):
        return value
    if isinstance(value, str) and value:
        return value
    return Gap.UNSUPPORTED


def _count(value: Any) -> int | Gap:
    """A generation/session counter: a non-negative `int`.  `bool` is rejected
    on purpose — `True` is an `int` in Python and a generation of `True` is a
    corrupt document, not generation 1."""
    if value is None:
        return Gap.ABSENT
    if isinstance(value, Gap):
        return value
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return Gap.UNSUPPORTED
    return value


def _instant(value: Any) -> float | Gap:
    """An ISO-8601 stamp as epoch seconds.

    The domain is a non-empty ISO string and nothing else, because that is
    what `now_iso()` writes on every journal row. A bare number is refused
    rather than read as an epoch: `0` and `False` would otherwise classify as
    1970 — very old, therefore eligible — where `_batch_is_young` calls them
    unreadable, and a lease expiring at `0` would read as expired instead of
    unresolved. Absent and unparseable are kept apart even though
    `_batch_is_young` folds them together: both are still "not young", so the
    characterisation is preserved exactly, but the reason says which happened.
    """
    if value is None:
        return Gap.ABSENT
    if isinstance(value, Gap):
        return value
    if not isinstance(value, str) or not value:
        return Gap.UNSUPPORTED
    try:
        return _dtm.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return Gap.UNSUPPORTED


def _frozen_tokens(values: Iterable[Any] | Gap | None) -> frozenset[str] | Gap:
    """Token membership, keeping unsupported entries out of the set rather than
    coercing them in.  A membership holding one unsupported entry is reported
    UNSUPPORTED as a whole: a carrier whose token list has a `None` in it is
    not a carrier whose tokens are known."""
    if values is None:
        return Gap.ABSENT
    if isinstance(values, Gap):
        return values
    if isinstance(values, (str, bytes)):
        return Gap.UNSUPPORTED
    try:
        items = list(values)
    except TypeError:
        return Gap.UNSUPPORTED
    out: set[str] = set()
    for item in items:
        key = _token_key(item)
        if isinstance(key, Gap):
            return Gap.UNSUPPORTED
        out.add(key)
    return frozenset(out)


# --------------------------------------------------------------------------
# snapshot
# --------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class CustodyRef:
    """The complete matching custody tuple.

    All four parts are required together.  Three of four is not "mostly the
    current turn"; it is an unresolved reference, and the whole point of rule 2
    is that a mode label, a node identity or a token list on its own cannot
    stand in for it.  `resolved()` returns a comparison key or a `Gap`, and
    nothing in this module compares the fields directly."""

    mailbox_id: Any = Gap.ABSENT
    generation: Any = Gap.ABSENT
    session: Any = Gap.ABSENT
    turn_token: Any = Gap.ABSENT

    def resolved(self) -> tuple[str, int, str, str] | Gap:
        mailbox = _text(self.mailbox_id)
        generation = _count(self.generation)
        session = _text(self.session)
        turn = _text(self.turn_token)
        parts = (mailbox, generation, session, turn)
        if any(part is Gap.UNSUPPORTED for part in parts):
            return Gap.UNSUPPORTED
        if any(isinstance(part, Gap) for part in parts):
            return Gap.ABSENT if all(isinstance(p, Gap) for p in parts) else Gap.UNKNOWN
        return (mailbox, generation, session, turn)  # type: ignore[return-value]


class MembershipKind(enum.Enum):
    TURN = "turn"                  # drained by the running turn itself
    MANUAL_FETCH = "manual_fetch"  # handed to a manual fetch, not yet confirmed


@dataclasses.dataclass(frozen=True)
class Membership:
    """A carrier membership that names its holder.

    ⚠ The `owner` here must be a tuple the producer actually observed as one
    unit.  Assembling it from the node's present identity plus a token list
    read at another instant reproduces exactly the staleness this protects
    against, and this module cannot detect that it happened."""

    kind: MembershipKind
    owner: CustodyRef
    tokens: Any = frozenset()


class CarrierKind(enum.Enum):
    QUEUE = "queue"          # st['queue'] — popped at a result boundary
    STEER = "steer"          # st['steer'] — injected at a safe boundary
    LIMBO = "steer_limbo"    # a pump has requested steering, not yet accepted
    PUMP = "pump"            # a live pump holds the text right now


@dataclasses.dataclass(frozen=True)
class CarrierHold:
    """Tokens sitting in an in-memory carrier.

    `live` is the fact that decides whether the carrier protects anything, and
    it is supplied, not derived.  A queued carrier on a node nothing will pop
    is as stranded as one in the steer store — that is the existing
    `_delivery_stages` review-round-2 rule, and it is kept.  What is NOT kept
    is deriving liveness from `busy`: `NodeActivity` is recorded on the
    snapshot and never read (see `OwnershipSnapshot.activity`)."""

    kind: CarrierKind
    tokens: Any = frozenset()
    live: Any = Gap.UNKNOWN


@dataclasses.dataclass(frozen=True)
class Claim:
    """A durable hook claim — `{'delivery_id': ..., 'acked': ...}` as it sits on
    a queue or steer entry."""

    tokens: Any = frozenset()
    delivery_id: Any = Gap.ABSENT
    acked: Any = Gap.ABSENT
    owner: CustodyRef | None = None


@dataclasses.dataclass(frozen=True)
class Lease:
    """A durable admission lease.

    At this base the node's `drive_lease` is a bare truthy flag with neither a
    token list nor an expiry, which is why `tokens=Gap.ABSENT` is a first-class
    input here rather than an error.  Rule 4 governs it: a generic flag is not
    proof of THIS token's owner, and it is also not permission to reclaim the
    token anyway.  Both halves are reported."""

    tokens: Any = Gap.ABSENT
    expires_at: Any = Gap.ABSENT
    owner: CustodyRef | None = None


class RetentionKind(enum.Enum):
    HALT = "halt"      # halt.retain / halt_queue — complete carriers, kept once
    NATIVE = "native"  # native_held_carriers


@dataclasses.dataclass(frozen=True)
class Retention:
    """A retained, self-contained carrier.  `halt.retain` keeps the composed
    carrier WITH its tokens precisely so no cleanup reboxes the same mail
    beside it, so discarding one to make its mail retrievable would duplicate
    the message rather than recover it."""

    kind: RetentionKind
    tokens: Any = frozenset()


@dataclasses.dataclass(frozen=True)
class NodeActivity:
    """The four flags `_delivery_stages` folds into its node-wide `owned` bit.

    They are on the snapshot so a reader can see them arrive and see them
    ignored.  NOTHING in `classify` reads this field; `test_mail_ownership`
    sweeps all sixteen combinations across the whole matrix and fails if any
    verdict moves.  Rule 1 is not a comment here, it is a test."""

    busy: bool = False
    waiting: bool = False
    responding: bool = False
    proc_control: bool = False


@dataclasses.dataclass(frozen=True)
class JournalBatch:
    """One `delivering[nid]` row, as observed.

    The fields are `Any` on purpose: an unsupported token or an unreadable
    stamp must be representable, because refusing to represent it is how it
    ends up silently read as absent."""

    token: Any = Gap.ABSENT
    drained_at: Any = Gap.ABSENT
    mode: Any = Gap.ABSENT
    message_ids: Sequence[Any] = ()


@dataclasses.dataclass(frozen=True)
class OwnershipSnapshot:
    """Everything `classify` is allowed to know.

    `now` is injected epoch seconds.  There is no default: a classifier that
    could reach for a wall clock would be one lock-free read away from
    answering two different things about one document."""

    current: CustodyRef
    now: float
    batches: Sequence[JournalBatch] = ()
    memberships: Sequence[Membership] = ()
    carriers: Sequence[CarrierHold] = ()
    claims: Sequence[Claim] = ()
    leases: Sequence[Lease] = ()
    retentions: Sequence[Retention] = ()
    confirmations: Mapping[Any, Any] = MappingProxyType({})
    activity: NodeActivity = NodeActivity()


# --------------------------------------------------------------------------
# result
# --------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class TokenVerdict:
    token: Any
    disposition: Disposition
    reasons: tuple[Reason, ...]
    owner: OwnerEvidence
    retained_carrier: bool
    confirmation: Confirmation
    content: Content
    grace_remaining: float | None

    @property
    def reclaimable(self) -> bool:
        """ELIGIBLE and nothing else.  Both other dispositions are refusals;
        they differ in what they say, not in what they permit."""
        return self.disposition is Disposition.ELIGIBLE


@dataclasses.dataclass(frozen=True)
class Classification:
    verdicts: tuple[TokenVerdict, ...]
    by_token: Mapping[str, TokenVerdict]

    @property
    def reclaimable_tokens(self) -> frozenset[str]:
        return frozenset(tok for tok, v in self.by_token.items() if v.reclaimable)


@dataclasses.dataclass(frozen=True)
class Selection:
    """The answer to "may I take these messages", which is always answered in
    whole batches.  `partial_batches` names the batches the request reached
    into without naming all of their messages: the caller takes the whole
    batch or takes nothing, and either way a protected sibling keeps its
    protection (rule 8)."""

    requested: tuple[Any, ...]
    verdicts: tuple[TokenVerdict, ...]
    reclaimable_tokens: frozenset[str]
    partial_batches: frozenset[str]
    unresolved_messages: tuple[Any, ...]


# --------------------------------------------------------------------------
# classification
# --------------------------------------------------------------------------

def _membership_facts(snapshot: OwnershipSnapshot,
                      ) -> tuple[dict[str, list[tuple[MembershipKind, Any]]], set[str]]:
    """Index memberships by token, and collect the tokens whose holders
    disagree.  Two complete-but-different holders for one token is not a
    stale membership and not a live one; it is a document that cannot be
    acted on."""
    by_token: dict[str, list[tuple[MembershipKind, Any]]] = {}
    holders: dict[str, set[Any]] = {}
    for member in snapshot.memberships:
        tokens = _frozen_tokens(member.tokens)
        owner = member.owner.resolved() if isinstance(member.owner, CustodyRef) else Gap.UNSUPPORTED
        if isinstance(tokens, Gap):
            # an unreadable token list names no token, so it protects none —
            # but it is reported on every batch, because a carrier whose
            # membership cannot be read is a carrier that might hold any of them
            continue
        for tok in tokens:
            by_token.setdefault(tok, []).append((member.kind, owner))
            if not isinstance(owner, Gap):
                holders.setdefault(tok, set()).add(owner)
    ambiguous = {tok for tok, names in holders.items() if len(names) > 1}
    return by_token, ambiguous


def _unreadable_membership_tokens(snapshot: OwnershipSnapshot) -> bool:
    return any(isinstance(_frozen_tokens(m.tokens), Gap) for m in snapshot.memberships)


def _confirmation_of(snapshot: OwnershipSnapshot, tok: str) -> Confirmation:
    if tok not in snapshot.confirmations:
        return Confirmation.NONE
    value = snapshot.confirmations[tok]
    if isinstance(value, Confirmation):
        return value
    return Confirmation.UNKNOWN


def classify(snapshot: OwnershipSnapshot) -> Classification:
    """Classify every journal batch in `snapshot`.

    Order of decision, strongest first.  Every applicable reason is collected
    whatever the disposition, so a PROTECTED batch still reports that its
    grace had passed and an UNAVAILABLE one still reports that halt holds it.

      1. the node's own identity is unsupported — nothing can be judged;
      2. token integrity: unsupported token, duplicate rows, absent row,
         holders that disagree;
      3. a positive holder: matching custody membership, a live carrier, a
         claim or lease, halt or native retention, confirmation;
      4. unresolved custody evidence — protected without proving a holder;
      5. the drain grace;
      6. and only then: nothing holds this, and it may be taken.
    """
    current = snapshot.current.resolved() if isinstance(snapshot.current, CustodyRef) \
        else Gap.UNSUPPORTED
    identity_broken = isinstance(current, Gap)

    seen: dict[str, int] = {}
    for batch in snapshot.batches:
        key = _token_key(batch.token)
        if not isinstance(key, Gap):
            seen[key] = seen.get(key, 0) + 1
    duplicates = {tok for tok, count in seen.items() if count > 1}

    if identity_broken:
        members: dict[str, list[tuple[MembershipKind, Any]]] = {}
        ambiguous: set[str] = set()
    else:
        members, ambiguous = _membership_facts(snapshot)
    membership_unreadable = _unreadable_membership_tokens(snapshot)

    verdicts: list[TokenVerdict] = []
    by_token: dict[str, TokenVerdict] = {}
    for batch in snapshot.batches:
        verdict = _verdict_for(snapshot, batch, current, duplicates,
                               members, ambiguous, membership_unreadable)
        verdicts.append(verdict)
        key = _token_key(batch.token)
        if not isinstance(key, Gap) and key not in duplicates:
            by_token[key] = verdict
    return Classification(tuple(verdicts), MappingProxyType(dict(by_token)))


def _verdict_for(snapshot: OwnershipSnapshot,
                 batch: JournalBatch,
                 current: tuple[str, int, str, str] | Gap,
                 duplicates: set[str],
                 members: Mapping[str, list[tuple[MembershipKind, Any]]],
                 ambiguous: set[str],
                 membership_unreadable: bool) -> TokenVerdict:
    reasons: list[Reason] = []
    owner = OwnerEvidence.NONE
    retained = False
    unavailable = False
    protected = False

    key = _token_key(batch.token)
    confirmation = Confirmation.NONE if isinstance(key, Gap) \
        else _confirmation_of(snapshot, key)

    # --- 1/2: integrity ---------------------------------------------------
    if isinstance(current, Gap):
        reasons.append(Reason.CURRENT_IDENTITY_UNSUPPORTED)
        unavailable = True
    if isinstance(key, Gap):
        reasons.append(Reason.UNSUPPORTED_TOKEN)
        unavailable = True
    elif key in duplicates:
        reasons.append(Reason.DUPLICATE_TOKEN_RECORDS)
        unavailable = True
    if not isinstance(key, Gap) and key in ambiguous:
        reasons.append(Reason.AMBIGUOUS_OWNERSHIP)
        unavailable = True

    tok = key if not isinstance(key, Gap) else None

    # --- 3: positive holders ----------------------------------------------
    if tok is not None:
        for kind, holder in members.get(tok, ()):
            if isinstance(holder, Gap):
                reasons.append(Reason.OWNER_MEMBERSHIP_UNSUPPORTED)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
            elif holder == current:
                reasons.append(Reason.CURRENT_TURN_MEMBERSHIP
                               if kind is MembershipKind.TURN
                               else Reason.MANUAL_FETCH_MEMBERSHIP)
                protected = True
                owner = OwnerEvidence.PROVEN
            else:
                # a membership from a generation, session or turn that is not
                # the current one.  It is resolved — we know exactly whose it
                # was — and it is over.  An unrelated new turn does not renew it.
                reasons.append(Reason.OWNER_MEMBERSHIP_STALE)

    if membership_unreadable:
        # a carrier whose token list cannot be read might hold this batch
        reasons.append(Reason.OWNER_MEMBERSHIP_UNSUPPORTED)
        protected = True
        owner = _weaker(owner, OwnerEvidence.UNPROVEN)

    if tok is not None:
        for hold in snapshot.carriers:
            tokens = _frozen_tokens(hold.tokens)
            if isinstance(tokens, Gap):
                reasons.append(Reason.CARRIER_LIVENESS_UNKNOWN)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
                continue
            if tok not in tokens:
                continue
            live = hold.live
            if live is True:
                reasons.append(_LIVE_REASON[hold.kind])
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
            elif live is False:
                if hold.kind in _IDLE_REASON:
                    reasons.append(_IDLE_REASON[hold.kind])
            else:
                reasons.append(Reason.CARRIER_LIVENESS_UNKNOWN)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)

        for claim in snapshot.claims:
            tokens = _frozen_tokens(claim.tokens)
            if isinstance(tokens, Gap) or tok not in tokens:
                continue
            delivery = _text(claim.delivery_id)
            if isinstance(delivery, Gap):
                reasons.append(Reason.CLAIM_UNRESOLVED)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
                continue
            reasons.append(Reason.CLAIM_HELD)
            protected = True
            holder = claim.owner.resolved() if isinstance(claim.owner, CustodyRef) else Gap.ABSENT
            owner = OwnerEvidence.PROVEN if not isinstance(holder, Gap) \
                else _weaker(owner, OwnerEvidence.UNPROVEN)

        claim_ids = {_text(c.delivery_id) for c in snapshot.claims
                     if not isinstance(_frozen_tokens(c.tokens), Gap)
                     and tok in _frozen_tokens(c.tokens)}  # type: ignore[operator]
        if len({i for i in claim_ids if not isinstance(i, Gap)}) > 1:
            reasons.append(Reason.CLAIM_CONFLICT)
            unavailable = True

        for lease in snapshot.leases:
            tokens = _frozen_tokens(lease.tokens)
            if isinstance(tokens, Gap):
                if tokens is Gap.ABSENT:
                    # the legacy bare `drive_lease`.  Rule 4, both halves.
                    reasons.append(Reason.LEASE_WITHOUT_TOKEN_MEMBERSHIP)
                else:
                    reasons.append(Reason.LEASE_UNRESOLVED)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
                continue
            if tok not in tokens:
                continue
            expiry = _instant(lease.expires_at)
            if isinstance(expiry, Gap):
                reasons.append(Reason.LEASE_UNRESOLVED)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
            elif snapshot.now < expiry:
                reasons.append(Reason.LEASE_HELD)
                protected = True
                holder = lease.owner.resolved() if isinstance(lease.owner, CustodyRef) else Gap.ABSENT
                owner = OwnerEvidence.PROVEN if not isinstance(holder, Gap) \
                    else _weaker(owner, OwnerEvidence.UNPROVEN)
            else:
                reasons.append(Reason.LEASE_EXPIRED)

        for retention in snapshot.retentions:
            tokens = _frozen_tokens(retention.tokens)
            if isinstance(tokens, Gap):
                reasons.append(Reason.CARRIER_LIVENESS_UNKNOWN)
                protected = True
                owner = _weaker(owner, OwnerEvidence.UNPROVEN)
                continue
            if tok not in tokens:
                continue
            reasons.append(Reason.HALT_HELD if retention.kind is RetentionKind.HALT
                           else Reason.NATIVE_HELD)
            protected = True
            retained = True
            owner = _weaker(owner, OwnerEvidence.UNPROVEN)

    if confirmation is Confirmation.IN_FLIGHT:
        reasons.append(Reason.CONFIRMATION_IN_FLIGHT)
        protected = True
    elif confirmation is Confirmation.CONFIRMED:
        reasons.append(Reason.CONFIRMED_BY_MATCHED_EVIDENCE)
        protected = True
    elif confirmation is Confirmation.ACKNOWLEDGED:
        # a receipt, and nothing more.  It protects nothing and confirms nothing.
        reasons.append(Reason.ACKNOWLEDGED_NOT_CONFIRMED)
    elif confirmation is Confirmation.UNKNOWN:
        reasons.append(Reason.CONFIRMATION_UNKNOWN)
        protected = True

    # --- the batch itself --------------------------------------------------
    content = Content.PRESENT
    stamp = _instant(batch.drained_at)
    grace_remaining: float | None = None
    if stamp is Gap.ABSENT:
        reasons.append(Reason.GRACE_STAMP_ABSENT)
    elif isinstance(stamp, Gap):
        reasons.append(Reason.GRACE_STAMP_UNREADABLE)
    else:
        grace_remaining = DRAIN_GRACE_S - (snapshot.now - stamp)
        if grace_remaining > 0:
            reasons.append(Reason.WITHIN_DRAIN_GRACE)
            protected = True

    if _text(batch.mode) == MembershipKind.MANUAL_FETCH.value and not protected:
        # the label says a manual fetch holds it; no membership says so.  The
        # label is not the fact — this is the old `manual_fetch && responding`
        # rule, named so a reader can see it declined.
        reasons.append(Reason.MODE_LABEL_ONLY)

    if unavailable:
        disposition = Disposition.UNAVAILABLE
    elif protected:
        disposition = Disposition.PROTECTED
    else:
        disposition = Disposition.ELIGIBLE
        reasons.append(Reason.UNOWNED_PAST_GRACE)

    return TokenVerdict(token=batch.token, disposition=disposition,
                        reasons=tuple(reasons), owner=owner,
                        retained_carrier=retained, confirmation=confirmation,
                        content=content, grace_remaining=grace_remaining)


_LIVE_REASON = {
    CarrierKind.QUEUE: Reason.QUEUE_CARRIER_LIVE,
    CarrierKind.STEER: Reason.STEER_CARRIER_LIVE,
    CarrierKind.LIMBO: Reason.STEER_LIMBO_REQUESTED,
    CarrierKind.PUMP: Reason.LIVE_PUMP,
}

_IDLE_REASON = {
    CarrierKind.QUEUE: Reason.QUEUE_CARRIER_NO_CONSUMER,
    CarrierKind.STEER: Reason.STEER_CARRIER_NO_CONSUMER,
}

_OWNER_RANK = {OwnerEvidence.NONE: 0, OwnerEvidence.UNPROVEN: 1, OwnerEvidence.PROVEN: 2}


def _weaker(existing: OwnerEvidence, candidate: OwnerEvidence) -> OwnerEvidence:
    """Keep the strongest owner evidence seen.  A proven holder is not
    downgraded by an unresolved one sitting beside it, and an unresolved one
    is never upgraded by the absence of anything else."""
    return existing if _OWNER_RANK[existing] >= _OWNER_RANK[candidate] else candidate


def select(snapshot: OwnershipSnapshot, message_ids: Iterable[Any]) -> Selection:
    """Resolve a request naming MESSAGES into whole-batch verdicts (rule 8).

    A batch is the ownership unit.  Naming one message of a five-message batch
    reaches the whole batch or nothing, and it cannot make the other four
    reclaimable: the verdict returned for it is the same verdict `classify`
    gives, with no per-message softening anywhere in the path.  Messages that
    resolve to no batch are reported, never dropped — a request for mail whose
    journal row is gone gets an explicit unresolved, not silence that reads
    like a refusal."""
    requested = tuple(message_ids)
    result = classify(snapshot)

    index: dict[Any, list[TokenVerdict]] = {}
    named: dict[str, set[Any]] = {}
    for batch, verdict in zip(snapshot.batches, result.verdicts):
        for mid in batch.message_ids or ():
            index.setdefault(_hashable(mid), []).append(verdict)

    touched: list[TokenVerdict] = []
    unresolved: list[Any] = []
    for mid in requested:
        found = index.get(_hashable(mid))
        if not found:
            unresolved.append(mid)
            continue
        for verdict in found:
            key = _token_key(verdict.token)
            if not isinstance(key, Gap):
                named.setdefault(key, set()).add(_hashable(mid))
            if verdict not in touched:
                touched.append(verdict)

    sizes = {}
    for batch in snapshot.batches:
        key = _token_key(batch.token)
        if not isinstance(key, Gap):
            sizes[key] = {_hashable(m) for m in batch.message_ids or ()}

    partial = frozenset(tok for tok, got in named.items()
                        if sizes.get(tok, set()) - got)
    reclaimable = frozenset(v.token for v in touched
                            if v.reclaimable and isinstance(v.token, str))
    return Selection(requested=requested, verdicts=tuple(touched),
                     reclaimable_tokens=reclaimable, partial_batches=partial,
                     unresolved_messages=tuple(unresolved))


def _hashable(value: Any) -> Any:
    """Message ids arrive as observed, and an unhashable one must not take the
    whole request down with a TypeError."""
    try:
        hash(value)
    except TypeError:
        return repr(value)
    return value
