"""Internal ownership snapshots and atomic reclaim receipts.

Inspection copies recorded evidence without minting mailbox identities or
combining a current node identity with an old token list. A live attempt uses
its registration's immutable identity; durable custody stamps protect mailbox
and generation boundaries. Missing or malformed stamps stay unproven.

Callers collect state under DOC_LOCK then _state_lock. Every actual carrier
source and publication boundary must participate before reclaim is safe. A
source-name checklist only checks an adapter input contract; it cannot prove
that an unregistered local carrier does not exist.

Reclaim receipts belong to the same document transaction as the fold. Only a
matching durable receipt proves a lost-response commit. Failed outcome reads
retain runtime intents and fences; journal absence alone proves nothing.
Completed-token tombstones are not evicted by an arbitrary count while paused
publishers might still reference them.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from . import mailownership as own

__all__ = [
    "CUSTODY_TURN",
    "CUSTODY_MANUAL_FETCH",
    "IDLE_ATTEMPT",
    "STATE_SOURCES",
    "CALLER_SOURCES",
    "IncompleteEvidence",
    "stamp_for",
    "register",
    "adopt",
    "release",
    "registrations",
    "fence",
    "unfence",
    "fenced",
    "note_reclaimed",
    "reclaimed",
    "surviving_toks",
    "runtime_facts",
    "snapshot",
    "classify",
    "eligible_tokens",
    "revalidate",
]

CUSTODY_TURN = "turn"
CUSTODY_MANUAL_FETCH = "manual_fetch"

_KINDS = {CUSTODY_TURN: own.MembershipKind.TURN,
          CUSTODY_MANUAL_FETCH: own.MembershipKind.MANUAL_FETCH}

#: the in-memory registry, the in-flight fence and the completed-reclaim set
_REGISTRY = "mail_custody"
_FENCE = "mail_reclaiming"
_RECLAIMED = "mail_reclaimed"

# Completed tokens stay protected for the lifetime of this runtime state.

#: The turn token used when NO attempt is running. It must be a value no real
#: lifecycle operation id can equal, because its whole job is to complete the
#: current tuple — so classification can proceed on an idle node — while
#: matching no registration at all. `lifecycle.new_operation` mints hex ids;
#: this is not one, and `_text` accepts it as a non-empty string.
IDLE_ATTEMPT = "\x00no-attempt"


# --------------------------------------------------------------------------
# reading identity, without creating any
# --------------------------------------------------------------------------

def _node_identity(org: Any, nid: str) -> tuple[Any, Any, Any]:
    """`(mailbox_id, generation, session_id)` as the document HAS them.

    ⚠ `n.get("mailbox_id")`, never `org.mailbox_identity(nid)`: that helper
    MINTS an identity when the field is absent and leaves it in the document
    (`ledger.py:2282-2284`). Minting from an inspection would make looking at a
    mailbox change it, and would hand the classifier an identity that was true
    only because it asked. Absent stays absent, and the classifier already
    knows what to do with that.
    """
    node = (getattr(org, "nodes", None) or {}).get(nid)
    if not isinstance(node, Mapping):
        return (own.Gap.ABSENT, own.Gap.ABSENT, own.Gap.ABSENT)
    return (node.get("mailbox_id", own.Gap.ABSENT),
            node.get("generation", own.Gap.ABSENT),
            node.get("session_id", own.Gap.ABSENT))


def stamp_for(org: Any, nid: str) -> dict[str, Any]:
    """The durable provenance stamp `_journal_drain` puts on a new row.

    Absent fields are OMITTED rather than written as null, so a row from a node
    that genuinely has no mailbox identity is distinguishable from one that was
    stamped with a broken value. `revalidate` treats a missing stamp as a row
    predating this mechanism and refuses to conclude anything from it.
    """
    mailbox, generation, session = _node_identity(org, nid)
    out: dict[str, Any] = {}
    if not isinstance(mailbox, own.Gap):
        out["mailbox"] = mailbox
    if not isinstance(generation, own.Gap):
        out["generation"] = generation
    if not isinstance(session, own.Gap):
        out["session"] = session
    return out


#: Journal-row field listing every engine process (pid) that drained, fed or
#: steered the row. A restart may fold uncertain or unstamped rows back only
#: when every one of these, and the engine that last owned the data root, is
#: provably gone together with every child it could have handed input to.
ENGINES = "engines"


def note_engine(row: dict[str, Any], pids: Iterable[int] = ()) -> None:
    """Add this engine (and any `pids`) to the row's owner list. Normal write
    boundary only: drain, input write, steer attempt, unsettled restart."""
    import os
    have = row.get(ENGINES)
    have = [p for p in have if isinstance(p, int)] if isinstance(have, list) else []
    for pid in (os.getpid(), *pids):
        if isinstance(pid, int) and pid > 0 and pid not in have:
            have.append(pid)
    row[ENGINES] = have


def row_engines(row: Mapping[str, Any]) -> frozenset[int] | None:
    """The recorded owner engines; None when the field is malformed."""
    value = row.get(ENGINES, [])
    if not isinstance(value, list) or not all(
            isinstance(p, int) and not isinstance(p, bool) and p > 0 for p in value):
        return None
    return frozenset(value)


def restart_uncertain(row: Mapping[str, Any]) -> bool:
    """Would this row still be protected at restart only by its own history?

    True for input written to a provider (`input_attempt`), a steer whose
    outcome was unknown, and a legacy row with no custody stamp. Exactly these
    may return to the mailbox at restart once their owners are proven gone
    (decision33); claims, retention, manual custody, identity changes and
    malformed stamps are never in this set.
    """
    attempt = row.get("attempt")
    return bool("input_attempt" in row
                or (isinstance(attempt, Mapping) and attempt.get("outcome") == "unknown")
                or "custody" not in row)


def _ref(mailbox: Any, generation: Any, session: Any,
         attempt: Any) -> own.CustodyRef:
    return own.CustodyRef(mailbox_id=mailbox, generation=generation,
                          session=session, turn_token=attempt)


# --------------------------------------------------------------------------
# the registry.  every function here expects the caller to hold `_state_lock`
# --------------------------------------------------------------------------

def register(st: dict[str, Any], org: Any, nid: str, *,
             attempt: Any, toks: Iterable[Any],
             kind: str = CUSTODY_TURN) -> dict[str, Any]:
    """Record that `attempt` has taken custody of `toks`. CALL UNDER `_state_lock`.

    This is the replacement for `st['mail_attempt_tokens'] = toks`, and the
    difference is the whole point: the four identity parts are captured
    TOGETHER, in one take, with the token list, so nothing downstream can pair
    a current identity with an old list and call the result custody.

    Registering the same attempt twice REPLACES its record rather than adding a
    second one — a turn that drains again (the launch drain prepends to tokens
    it already owns) has one custody, not two.
    """
    mailbox, generation, session = _node_identity(org, nid)
    record = {"kind": kind, "mailbox": mailbox, "generation": generation,
              "session": session, "attempt": attempt,
              "toks": [t for t in toks]}
    rows = [r for r in (st.get(_REGISTRY) or [])
            if not (r.get("attempt") == attempt and r.get("kind") == kind)]
    rows.append(record)
    st[_REGISTRY] = rows
    return record


def adopt(st: dict[str, Any], *, attempt: Any, toks: Iterable[Any],
          kind: str = CUSTODY_TURN) -> bool:
    """A live carrier took MORE tokens under an existing custody. UNDER `_state_lock`.

    Adoption extends; it never creates. A carrier adopting tokens for an
    attempt that holds no custody is a carrier whose holder was never
    established, and inventing a registration for it here would manufacture
    exactly the evidence this module exists to refuse. False says nothing was
    recorded, and the tokens stay unowned — which leaves them PROTECTED by the
    carrier hold itself, not eligible.
    """
    add = [t for t in toks]
    if not add:
        return False
    for row in st.get(_REGISTRY) or []:
        if row.get("attempt") == attempt and row.get("kind") == kind:
            have = row["toks"]
            have.extend(t for t in add if t not in have)
            return True
    return False


def release(st: dict[str, Any], *, attempt: Any, kind: str | None = None) -> None:
    """The attempt is over: drop its custody. CALL UNDER `_state_lock`.

    Releasing does NOT mean the tokens are reclaimable. It means this attempt
    no longer asserts anything about them; a queued carrier, a halt hold or a
    pending confirmation still protects them on its own evidence. That
    separation is why release can be unconditional in a `finally` — it removes
    a claim, it never grants permission.
    """
    st[_REGISTRY] = [r for r in (st.get(_REGISTRY) or [])
                     if not (r.get("attempt") == attempt
                             and (kind is None or r.get("kind") == kind))]


def registrations(st: Mapping[str, Any]) -> list[dict[str, Any]]:
    import copy
    rows = st.get(_REGISTRY, [])
    if not isinstance(rows, (list, tuple)):
        return [{"toks": own.Gap.UNSUPPORTED}]
    return [copy.deepcopy(dict(row)) if isinstance(row, Mapping)
            else {"toks": own.Gap.UNSUPPORTED} for row in rows]


# --------------------------------------------------------------------------
# the fence
# --------------------------------------------------------------------------

def fence(st: dict[str, Any], toks: Iterable[Any]) -> None:
    """Mark tokens as mid-reclaim. CALL UNDER `_state_lock`.

    Published in the SAME take that reads the carriers, so there is no instant
    at which a classification has been made and the fence is not yet up."""
    st.setdefault(_FENCE, set()).update(toks)


def unfence(st: dict[str, Any], toks: Iterable[Any]) -> None:
    """Release the fence. CALL UNDER `_state_lock`, from a `finally`."""
    held = st.get(_FENCE)
    if isinstance(held, set):
        held.difference_update(toks)
        if not held:
            st.pop(_FENCE, None)


def fenced(st: Mapping[str, Any], toks: Iterable[Any]) -> bool:
    """Is any of `toks` mid-reclaim? Every adoption site asks this before
    publishing a carrier, so a batch cannot acquire an owner between the
    classification that called it unowned and the save that moves it."""
    held = st.get(_FENCE)
    return bool(isinstance(held, set) and held.intersection(toks))


def note_reclaimed(st: dict[str, Any], toks: Iterable[Any]) -> None:
    """Record tokens a COMPLETED reclaim moved back. CALL UNDER `_state_lock`.

    This is the second half of the fence, and it exists because the first half
    cannot reach far enough. A carrier composed before the transaction holds
    its tokens in a local variable; no lock taken during the fold excludes the
    thread that is carrying it, so that carrier can be published after the save
    has already put its mail back in the mailbox. Delivering it then would hand
    the agent mail that the mailbox also still holds — a duplicate produced by
    the very mechanism meant to prevent loss.

    No count-based eviction: a paused publisher has no proven time bound.
    """
    seen = st.get(_RECLAIMED)
    if not isinstance(seen, dict):
        seen = {}
    for tok in toks:
        seen.pop(tok, None)
        seen[tok] = None
    st[_RECLAIMED] = seen


def reclaimed(st: Mapping[str, Any], toks: Iterable[Any]) -> frozenset[Any]:
    """Which of `toks` a completed reclaim already moved back."""
    seen = st.get(_RECLAIMED)
    if not isinstance(seen, dict):
        return frozenset()
    return frozenset(t for t in toks if t in seen)


def surviving_toks(st: Mapping[str, Any], toks: Iterable[Any]) -> list[Any]:
    """`toks` minus anything already reclaimed or currently being reclaimed.

    The filter a publication site applies to a carrier it is about to publish.
    An empty result means the carrier is holding nothing that is still its to
    hold, and the caller drops it instead of delivering folded mail."""
    gone = set(reclaimed(st, toks))
    held = st.get(_FENCE)
    if isinstance(held, set):
        gone |= held.intersection(toks)
    return [t for t in toks if t not in gone]


# --------------------------------------------------------------------------
# building the snapshot
# --------------------------------------------------------------------------

#: The in-memory carrier sources `runtime_facts` collects. `snapshot` requires
#: every one of them to be present in the facts it is given, so a source that
#: is added to the runtime and not collected here cannot silently read as an
#: absence of holders.
STATE_SOURCES: frozenset[str] = frozenset({"queue", "steer", "limbo",
                                           "registry", "confirmed", "pending_worker", "legacy_attempt", "pump_carriers", "handoffs", "publication_wait"})

#: The sources that do NOT live in `st` and must be supplied by the caller.
#: `pump` has no state key — a live pump holds the text in a local frame — so
#: there is nothing for `runtime_facts` to read and the caller must state it.
CALLER_SOURCES: frozenset[str] = frozenset({"pump"})


class IncompleteEvidence(RuntimeError):
    """A snapshot was requested without stating every carrier source.

    Raised rather than defaulted. A default here would be a decision that the
    unstated source holds nothing, made by the module least able to know."""


def runtime_facts(st: Mapping[str, Any]) -> dict[str, Any]:
    """Copy every currently integrated state source under the state lock.

    Invalid collections or memberships stay explicit unknown evidence. Source
    names check this adapter's contract; they cannot prove that a new runtime
    publication site has been audited.
    """
    import copy
    def carriers(entries: Any) -> list[dict[str, Any]]:
        if not isinstance(entries, (list, tuple)):
            return [{"toks": own.Gap.UNSUPPORTED}]
        result = []
        for entry in entries:
            if isinstance(entry, Mapping):
                result.append(copy.deepcopy(dict(entry)))
            elif not isinstance(entry, str):
                result.append({"toks": own.Gap.UNSUPPORTED})
        return result

    limbo = []
    entries = st.get("steer_limbo", [])
    if not isinstance(entries, (list, tuple)):
        limbo = [{"toks": own.Gap.UNSUPPORTED}]
    else:
        for entry in entries:
            limbo.extend(carriers(entry.get("carriers", own.Gap.ABSENT))
                         if isinstance(entry, Mapping)
                         else [{"toks": own.Gap.UNSUPPORTED}])
    return {"queue": carriers(st.get("queue", [])),
            "steer": carriers(st.get("steer", [])), "limbo": limbo,
            "registry": registrations(st),
            "pump_carriers": (carriers(st.get("halt_steering_carriers", []))
                              + carriers(st.get("halt_aux_carriers", []))),
            "handoffs": carriers(st.get("mail_handoffs", [])),
            "publication_wait": carriers(st.get("mail_publication_wait", [])),
            "pending_worker": carriers([st["halt_pending_carrier"]])
                if "halt_pending_carrier" in st else [],
            "legacy_attempt": _token_membership(st.get("mail_attempt_tokens", ())),
            "attempt": copy.deepcopy(st.get("lifecycle_operation_id")),
            "busy": bool(st.get("busy")), "waiting": bool(st.get("waiting")),
            "responding": bool(st.get("responding")),
            "proc_control": bool(st.get("proc_control")),
            "confirmed": _token_membership(st.get("mail_confirmed", ())),
            "fenced": _token_membership(st.get(_FENCE, ())),
            "sources": set(STATE_SOURCES)}


def _live_attempt(facts: Mapping[str, Any]) -> Any:
    """The attempt that is running RIGHT NOW, or None.

    A turn is running when the lifecycle has published its operation id AND one
    of the runtime flags says a turn exists to publish it for. The flags are
    NOT ownership — `mailownership` ignores them entirely and a sweep proves it
    — but they are exactly the right evidence for "is this recorded attempt
    still the live one", which is a question about the PROCESS, not about a
    batch. Without them a finished attempt's id would linger and keep granting
    custody to a turn that ended.
    """
    attempt = facts.get("attempt")
    if not attempt:
        return None
    if facts.get("busy") or facts.get("responding") or facts.get("proc_control"):
        return attempt
    return None


def _carrier_holds(facts: Mapping[str, Any]) -> list[own.CarrierHold]:
    # A concrete carrier may still be popped or restored. Node activity is not
    # evidence that it was discarded. Release requires the actual movement.
    result = []
    for source, kind in (("queue", own.CarrierKind.QUEUE),
                         ("steer", own.CarrierKind.STEER),
                         ("limbo", own.CarrierKind.LIMBO)):
        for entry in facts[source]:
            result.append(own.CarrierHold(kind=kind,
                tokens=_token_membership(entry.get("toks", ())), live=True))
    return result


def _claims(facts: Mapping[str, Any]) -> list[own.Claim]:
    result = []
    for source in ("queue", "steer", "limbo"):
        for entry in facts[source]:
            if "claim" not in entry:
                continue
            claim = entry["claim"]
            if not isinstance(claim, Mapping):
                claim = {}
            result.append(own.Claim(tokens=_token_membership(entry.get("toks", own.Gap.ABSENT)),
                                   delivery_id=claim.get("delivery_id", own.Gap.ABSENT),
                                   acked=claim.get("acked", own.Gap.ABSENT)))
    return result


def _memberships(facts: Mapping[str, Any]
                 ) -> tuple[list[own.Membership], own.CustodyRef | None]:
    live = _live_attempt(facts)
    members = []
    current = None
    for row in facts["registry"]:
        kind = _KINDS.get(row.get("kind")) if isinstance(row.get("kind"), str) else None
        ref = _ref(row.get("mailbox", own.Gap.ABSENT),
                   row.get("generation", own.Gap.ABSENT),
                   row.get("session", own.Gap.ABSENT),
                   row.get("attempt", own.Gap.ABSENT))
        members.append(own.Membership(kind=kind or own.MembershipKind.TURN,
                                      owner=ref if kind else None,
                                      tokens=_token_membership(row.get("toks", own.Gap.ABSENT))))
        if live is not None and kind is not None and row.get("attempt") == live:
            current = ref
    return members, current


def snapshot(org: Any, nid: str, facts: Mapping[str, Any], *,
             now: float, pump_toks: Any,
             owners_gone: Any = None) -> own.OwnershipSnapshot:
    """Pure ownership evidence. Unknown data is represented, never discarded.

    `owners_gone(row) -> bool` is supplied ONLY by restart reconciliation. For
    a `restart_uncertain` row whose owners it proves gone, the row's own
    uncertainty (input, unknown steer, missing stamp) no longer protects it;
    every other holder still does."""
    missing = set(STATE_SOURCES) - set(facts.get("sources") or ())
    if missing:
        raise IncompleteEvidence(f"missing carrier sources {sorted(missing)}")
    node = (getattr(org, "nodes", None) or {}).get(nid)
    members, current = _memberships(facts)
    if current is None:
        mailbox, generation, session = _node_identity(org, nid)
        current = _ref(mailbox, generation, session, IDLE_ATTEMPT)
    batches = []
    durable_claims = []
    rows = (org.d.get("delivering") or {}).get(nid) or []
    for row in rows:
        if not isinstance(row, Mapping):
            batches.append(own.JournalBatch(token=own.Gap.UNSUPPORTED))
            continue
        mail = row.get("mail", [])
        identities = tuple(m.get("id", own.Gap.ABSENT)
                           if isinstance(m, Mapping) else own.Gap.UNSUPPORTED
                           for m in mail) if isinstance(mail, (list, tuple))             else (own.Gap.UNSUPPORTED,)
        tok = row.get("tok", own.Gap.ABSENT)
        batches.append(own.JournalBatch(token=tok,
            drained_at=row.get("at", own.Gap.ABSENT),
            mode=row.get("mode", own.Gap.ABSENT), message_ids=identities))
        if "claim" in row:
            claim = row["claim"] if isinstance(row["claim"], Mapping) else {}
            durable_claims.append(own.Claim(tokens=(tok,),
                delivery_id=claim.get("delivery_id", own.Gap.ABSENT),
                acked=claim.get("acked", own.Gap.ABSENT)))
        released = bool(owners_gone is not None and restart_uncertain(row)
                        and owners_gone(row))
        attempt = row.get("attempt")
        if not released and (isinstance(attempt, Mapping)
                             and attempt.get("outcome") == "unknown"
                             or "input_attempt" in row):
            # A request may have reached a provider before the process died.
            # RAM disappearance is not evidence that it was never consumed.
            members.append(own.Membership(kind=own.MembershipKind.TURN,
                                          owner=None, tokens=(tok,)))
        # Durable unconfirmed manual custody cannot disappear with RAM.
        if row.get("mode") == CUSTODY_MANUAL_FETCH:
            members.append(own.Membership(kind=own.MembershipKind.MANUAL_FETCH,
                                          owner=None, tokens=(tok,)))
        problem = _custody_problem(org, nid, row)
        if problem is not None and not (released and problem == "custody_unproven"):
            members.append(own.Membership(kind=own.MembershipKind.TURN,
                                          owner=None, tokens=(tok,)))

    carriers = _carrier_holds(facts)
    members.append(own.Membership(kind=own.MembershipKind.TURN, owner=None,
                                  tokens=facts["legacy_attempt"]))
    for carrier in (facts["pending_worker"] + facts["pump_carriers"]
                    + facts["handoffs"] + facts["publication_wait"]):
        carriers.append(own.CarrierHold(kind=own.CarrierKind.PUMP,
            tokens=_token_membership(carrier.get("toks", ())), live=True))
    carriers.append(own.CarrierHold(kind=own.CarrierKind.PUMP,
                                    tokens=pump_toks, live=True))
    carriers.append(own.CarrierHold(kind=own.CarrierKind.PUMP,
                                    tokens=facts["fenced"], live=True))
    confirmed = facts["confirmed"]
    if isinstance(confirmed, own.Gap):
        carriers.append(own.CarrierHold(kind=own.CarrierKind.PUMP,
                                        tokens=confirmed, live=True))
        confirmed = ()
    leases = []
    retentions = []
    if isinstance(node, Mapping):
        if "drive_lease" in node and node["drive_lease"] is not False:
            leases.append(own.Lease(tokens=own.Gap.ABSENT,
                                    expires_at=own.Gap.ABSENT))
        for key, kind in (("halt_queue", own.RetentionKind.HALT),
                          ("native_held_carriers", own.RetentionKind.NATIVE)):
            entries = node.get(key, [])
            if not isinstance(entries, (list, tuple)):
                retentions.append(own.Retention(kind=kind, tokens=own.Gap.UNSUPPORTED))
                continue
            for entry in entries:
                if isinstance(entry, Mapping):
                    retentions.append(own.Retention(kind=kind, tokens=_token_membership(entry.get("toks", ()))))
                elif not isinstance(entry, str):
                    retentions.append(own.Retention(kind=kind, tokens=own.Gap.UNSUPPORTED))
    attempts = (org.d.get("steer_attempts") or {}).get(nid, {})
    if not isinstance(attempts, Mapping):
        durable_claims.append(own.Claim(tokens=own.Gap.UNSUPPORTED))
    else:
        for did, attempt in attempts.items():
            if not isinstance(attempt, Mapping):
                durable_claims.append(own.Claim(tokens=own.Gap.UNSUPPORTED))
            elif not attempt.get("recorded_at") and not attempt.get("resolved"):
                durable_claims.append(own.Claim(
                    tokens=_token_membership(attempt.get("toks", own.Gap.ABSENT)),
                    delivery_id=did, acked=attempt.get("acked", own.Gap.ABSENT)))
    return own.OwnershipSnapshot(current=current, now=now, batches=batches,
        memberships=members, carriers=carriers, claims=_claims(facts) + durable_claims, leases=leases,
        retentions=retentions, confirmations={t: own.Confirmation.IN_FLIGHT for t in confirmed},
        activity=own.NodeActivity(busy=bool(facts.get("busy")),
            waiting=bool(facts.get("waiting")), responding=bool(facts.get("responding")),
            proc_control=bool(facts.get("proc_control"))))


def classify(org: Any, nid: str, facts: Mapping[str, Any], *,
             now: float, pump_toks: Any, owners_gone: Any = None,
             ) -> tuple[own.Classification, own.OwnershipSnapshot]:
    snap = snapshot(org, nid, facts, now=now, pump_toks=pump_toks,
                    owners_gone=owners_gone)
    return own.classify(snap), snap


def eligible_tokens(org: Any, nid: str, facts: Mapping[str, Any], *,
                    now: float, pump_toks: Any,
                    owners_gone: Any = None) -> frozenset[str]:
    """The tokens this node may reclaim, and nothing else.

    A token under the reclaim fence is excluded even when the classifier calls
    it eligible: another transaction is already moving it, and two folds of one
    batch is the duplicate the whole protocol exists to avoid.
    """
    result, _ = classify(org, nid, facts, now=now, pump_toks=pump_toks,
                         owners_gone=owners_gone)
    return result.reclaimable_tokens  # fences are represented in the same snapshot


# --------------------------------------------------------------------------
# the mutation guard
# --------------------------------------------------------------------------

def revalidate(org: Any, nid: str, toks: Iterable[str], *,
               owners_gone: Any = None
               ) -> tuple[frozenset[str], dict[str, str]]:
    safe = set()
    refused = {}
    rows = (org.d.get("delivering") or {}).get(nid) or []
    for tok in toks:
        matching = [r for r in rows if isinstance(r, Mapping) and r.get("tok") == tok]
        if len(matching) != 1:
            refused[tok] = "journal_membership_changed"
            continue
        problem = _custody_problem(org, nid, matching[0])
        if (problem == "custody_unproven" and owners_gone is not None
                and owners_gone(matching[0])):
            problem = None  # legacy row, owners proven gone (restart only)
        if problem:
            refused[tok] = problem
        else:
            safe.add(tok)
    return frozenset(safe), refused


def _custody_problem(org: Any, nid: str, row: Mapping[str, Any]) -> str | None:
    node = (getattr(org, "nodes", None) or {}).get(nid)
    if not isinstance(node, Mapping):
        return "node_absent"
    # ABSENT stamp = a row from a build before stamping (legacy, "unproven");
    # a PRESENT stamp that is not a mapping is malformed ("unsupported"). Only
    # the first may ever be released by a restart owner proof (decision33).
    if "custody" not in row:
        return "custody_unproven"
    stamp = row["custody"]
    if not isinstance(stamp, Mapping):
        return "custody_unsupported"
    ref = _ref(stamp.get("mailbox", own.Gap.ABSENT),
               stamp.get("generation", own.Gap.ABSENT),
               stamp.get("session", own.Gap.ABSENT), IDLE_ATTEMPT)
    if isinstance(ref.resolved(), own.Gap):
        return "custody_unsupported"
    if stamp["mailbox"] != node.get("mailbox_id"):
        return "mailbox_changed"
    if stamp["generation"] != node.get("generation"):
        return "generation_changed"
    return None


# Positive receipts are written in the SAME document transaction as the fold.
# Keep them while a delayed publisher or a lost response can still name the
# token. Retention/compaction is a separate protocol, not an arbitrary cap.
def _journal_fingerprint(row: Mapping[str, Any]) -> str:
    import hashlib
    import json
    return hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False)
                          .encode("utf-8")).hexdigest()


def reclaim_receipt(org: Any, nid: str, toks: Iterable[str], *,
                    operation: str) -> dict[str, Any]:
    """Capture the exact pre-fold rows; no mutation or identity allocation."""
    wanted = frozenset(toks)
    rows = (org.d.get("delivering") or {}).get(nid) or []
    selected = [r for r in rows if isinstance(r, Mapping)
                and r.get("tok") in wanted]
    if len(selected) != len(wanted):
        raise ValueError("reclaim needs exactly one journal row for each token")
    if {r["tok"] for r in selected} != wanted:
        raise ValueError("reclaim journal identity is ambiguous")
    return {"operation": operation, "outcome": "reclaimed", "node": nid,
            "identity": list(_node_identity(org, nid)),
            "before": {r["tok"]: _journal_fingerprint(r) for r in selected}}


def write_reclaim_receipt(org: Any, receipt: Mapping[str, Any]) -> None:
    import copy
    org.d.setdefault("mail_transitions", {}).setdefault(receipt["node"], {})[
        receipt["operation"]] = copy.deepcopy(dict(receipt))


def reclaim_outcome(org: Any, receipt: Mapping[str, Any]) -> str:
    """Resolve a save from fresh durable evidence, never journal absence alone.

    `committed` requires the exact positive receipt and no contradictory row.
    `unchanged` requires every original journal row and the same node identity.
    Everything else remains ambiguous and keeps its runtime fence.
    """
    nid = receipt["node"]
    durable = (org.d.get("mail_transitions") or {}).get(nid) or {}
    rows = (org.d.get("delivering") or {}).get(nid) or []
    wanted = set(receipt["before"])
    selected = [r for r in rows if isinstance(r, Mapping)
                and isinstance(r.get("tok"), str) and r["tok"] in wanted]
    saved = durable.get(receipt["operation"])
    if saved == receipt and not selected:
        return "committed"
    if saved is not None or len(selected) != len(wanted):
        return "ambiguous"
    if list(_node_identity(org, nid)) != receipt["identity"]:
        return "ambiguous"
    try:
        observed = {r["tok"]: _journal_fingerprint(r) for r in selected}
    except (TypeError, ValueError):
        return "ambiguous"
    return "unchanged" if observed == receipt["before"] else "ambiguous"


def resolve_reclaims(org: Any, st: dict[str, Any], *, nid: str | None = None) -> dict[str, str]:
    """Settle retained intents against a fresh document. Under both locks."""
    if nid is not None:
        # Reconstruct settled carrier tokens after state loss. A positive
        # receipt, not journal absence, permits removing generated input.
        note_reclaimed(st, settled_tokens(org, nid, outcomes={"confirmed", "reclaimed"}))
    pending = st.get("mail_reclaim_intents") or {}
    outcomes = {}
    for operation, receipt in list(pending.items()):
        outcome = reclaim_outcome(org, receipt)
        outcomes[operation] = outcome
        if outcome == "ambiguous":
            continue
        toks = receipt["before"]
        if outcome == "committed":
            note_reclaimed(st, toks)
        unfence(st, toks)
        pending.pop(operation, None)
    return outcomes


def _token_membership(value: Any) -> frozenset[str] | own.Gap:
    # The runtime stores collections, not arbitrary iterables. A mapping is
    # corrupt membership, never a set of its keys (including an empty dict).
    if isinstance(value, Mapping):
        return own.Gap.UNSUPPORTED
    return own._frozen_tokens(value)


def settled_tokens(org: Any, nid: str, *, outcomes: set[str]) -> frozenset[str]:
    records = (org.d.get("mail_transitions") or {}).get(nid) or {}
    if not isinstance(records, Mapping):
        return frozenset()
    rows = (org.d.get("delivering") or {}).get(nid) or []
    remaining = {row["tok"] for row in rows if isinstance(row, Mapping)
                 and isinstance(row.get("tok"), str)}
    proven = set()
    for receipt in records.values():
        if (isinstance(receipt, Mapping) and receipt.get("node") == nid
                and isinstance(receipt.get("outcome"), str)
                and receipt["outcome"] in outcomes
                and isinstance(receipt.get("before"), Mapping)):
            proven.update(t for t, digest in receipt["before"].items()
                          if isinstance(t, str) and t and isinstance(digest, str)
                          and len(digest) == 64 and t not in remaining)
    return frozenset(proven)


def confirmed_tokens(org: Any, nid: str) -> frozenset[str]:
    """Positive consumption receipts whose tokens no longer have journal rows."""
    return settled_tokens(org, nid, outcomes={"confirmed"})


def journal_tokens(org: Any, nid: str) -> frozenset[str]:
    rows = (org.d.get("delivering") or {}).get(nid) or []
    return frozenset(r["tok"] for r in rows if isinstance(r, Mapping)
                     and isinstance(r.get("tok"), str))


def confirmation_receipt(org: Any, nid: str, toks: Iterable[str], *,
                         operation: str) -> dict[str, Any] | None:
    """Prepare only unconfirmed JOURNALED tokens; a missing journal is never success.

    A token with no journal row gets no receipt at all: there is nothing to
    confirm and nothing to remove, and writing one would turn absence into
    evidence. `release_rowless` handles its runtime side.
    """
    wanted = (frozenset(toks) - confirmed_tokens(org, nid)) & journal_tokens(org, nid)
    if not wanted:
        return None
    receipt = reclaim_receipt(org, nid, wanted, operation=operation)
    receipt["outcome"] = "confirmed"
    return receipt


def release_rowless(org: Any, st: dict[str, Any], nid: str,
                    toks: Iterable[str]) -> frozenset[str]:
    """Stop protecting journal rows that do not exist. UNDER `_state_lock`.

    `mail_confirmed` exists to keep a consumed batch from being folded back
    while its receipt is being saved. A token whose row is absent from this
    fresh document has no batch left to protect, so holding it would only
    block recovery (`maildrain.recover` waits for the set to drain) without
    guarding anything. Nothing is concluded about delivery: no receipt is
    written, and a row that reappears is protected again by the next caller.
    """
    gone = frozenset(toks) - journal_tokens(org, nid)
    pending = st.get("mail_confirmed")
    if isinstance(pending, set):
        pending.difference_update(gone)
    return gone


def compact_receipts(org: Any, st: dict[str, Any], nid: str, *,
                     keep: Iterable[str] = ()) -> int:
    """Drop settled receipts nothing can still ask about. UNDER both locks.

    The caller owns the fresh document and saves it. Without this every
    confirmed batch adds a permanent receipt to the org document. A receipt
    stays while its operation is an unresolved runtime intent or in `keep`
    (the transaction writing it), while any of its tokens still has a journal
    row, and while any durable record of this node still names one of its
    tokens: the node record (halt and native retention, the inflight replay
    marker) or its steer attempts. The token scan is textual and therefore
    conservative; a false match only keeps a receipt. Before a receipt goes,
    its tokens become runtime tombstones, so a carrier paused in this process
    is still filtered exactly as the receipt would have filtered it; after a
    restart only the durable records above can name a token at all.
    """
    import json
    records = (org.d.get("mail_transitions") or {}).get(nid)
    if not isinstance(records, dict) or not records:
        return 0
    pending = set(st.get("mail_reclaim_intents") or {}) | set(keep)
    live = journal_tokens(org, nid)
    try:
        durable = json.dumps([org.nodes.get(nid),
                              (org.d.get("steer_attempts") or {}).get(nid)],
                             sort_keys=True, default=str)
    except (TypeError, ValueError):
        return 0
    drop = []
    for operation, receipt in records.items():
        if operation in pending or not isinstance(receipt, Mapping):
            continue
        before = receipt.get("before")
        if (receipt.get("node") != nid or not isinstance(before, Mapping)
                or receipt.get("outcome") not in ("confirmed", "reclaimed")):
            continue
        toks = [t for t in before if isinstance(t, str) and t]
        if not toks or len(toks) != len(before):
            continue
        if any(t in live or t in durable for t in toks):
            continue
        drop.append(operation)
    for operation in drop:
        receipt = records.pop(operation)
        note_reclaimed(st, receipt["before"])
        if receipt["outcome"] == "confirmed":
            release = st.get("mail_confirmed")
            if isinstance(release, set):
                release.difference_update(receipt["before"])
    if not records:
        org.d["mail_transitions"].pop(nid, None)
    return len(drop)


def settle_confirmation(org: Any, st: dict[str, Any], nid: str) -> frozenset[str]:
    """Clear pending RAM evidence only when a fresh document proves consumption."""
    proven = confirmed_tokens(org, nid)
    st.get("mail_confirmed", set()).difference_update(proven)
    return proven


def hold_handoff(st: dict[str, Any], carrier: Any) -> Any:
    """Keep a complete carrier visible while its next consumer is in a local frame."""
    if isinstance(carrier, Mapping) and carrier.get("toks"):
        entries = st.setdefault("mail_handoffs", [])
        if not any(c is carrier for c in entries):
            entries.append(carrier)
            st.setdefault("mail_handoff_owners", {})[id(carrier)] = st.get("lifecycle_operation_id")
    return carrier


def drop_handoff(st: dict[str, Any], carrier: Any) -> None:
    """The consumer took THIS carrier object: release its local hold. UNDER `_state_lock`.

    Called at admission whatever `_publishable` decided. A ready carrier is
    then held by the attempt's registration, a retained one by its
    publication-wait copy; the original must not linger beside either, or a
    projection that dropped a reclaimed chunk would leave the unprojected
    original holding stale text that a halt capture could later replay.
    """
    entries = st.get("mail_handoffs") or []
    keep = [c for c in entries if c is not carrier]
    if len(keep) != len(entries):
        st["mail_handoffs"] = keep
        st.get("mail_handoff_owners", {}).pop(id(carrier), None)


def adopt_handoffs(st: dict[str, Any], toks: Iterable[str]) -> None:
    """Release local handoff holds only after a real attempt owns the whole carrier."""
    adopted = frozenset(toks)
    def keep(carrier):
        membership = _token_membership(carrier.get("toks", own.Gap.ABSENT))
        return isinstance(membership, own.Gap) or not membership.issubset(adopted)
    st["mail_handoffs"] = [c for c in st.get("mail_handoffs", []) if keep(c)]
    remaining = {id(c) for c in st["mail_handoffs"]}
    st["mail_handoff_owners"] = {key: value for key, value in
        st.get("mail_handoff_owners", {}).items() if key in remaining}


def project_carrier(st: Mapping[str, Any], carrier: Any) -> tuple[Any, str]:
    """Remove only explicitly recorded generated chunks after a proven reclaim.

    Unknown composition is held whole. A pending fence is not a completed fold
    and can never justify deleting tokens or text. The caller retains a held
    carrier, including authored, command and replay payload, until resolution.
    """
    if not isinstance(carrier, Mapping) or "toks" not in carrier:
        return carrier, "ready"
    toks = _token_membership(carrier["toks"])
    if isinstance(toks, own.Gap):
        return carrier, "membership_unproven"
    if fenced(st, toks):
        return carrier, "reclaim_pending"
    gone = reclaimed(st, toks)
    if not gone:
        return carrier, "ready"
    proof = carrier.get("mail_projection")
    if not isinstance(proof, Mapping):
        return carrier, "composition_unproven"
    base, chunks = proof.get("base"), proof.get("chunks")
    if (not isinstance(base, Mapping) or not isinstance(chunks, (list, tuple))
            or not isinstance(base.get("text"), str) or not isinstance(base.get("view"), str)):
        return carrier, "composition_unproven"
    if any(not isinstance(c, Mapping) or not isinstance(c.get("tok"), str)
           or not isinstance(c.get("text"), str) or not isinstance(c.get("view"), str)
           for c in chunks):
        return carrier, "composition_unproven"
    if (len({c["tok"] for c in chunks}) != len(chunks)
            or {c["tok"] for c in chunks} != toks
            or ''.join(c["text"] for c in chunks) + base["text"] != carrier.get("text")
            or ''.join(c["view"] for c in chunks) + base["view"] != carrier.get("view", "")):
        return carrier, "composition_unproven"
    import copy
    remaining = [copy.deepcopy(c) for c in chunks if c["tok"] not in gone]
    result = copy.deepcopy(dict(carrier))
    result.update(copy.deepcopy(dict(base)))
    result["toks"] = [c["tok"] for c in remaining]
    result["text"] = ''.join(c["text"] for c in remaining) + base["text"]
    result["view"] = ''.join(c["view"] for c in remaining) + base["view"]
    result["mail_projection"] = {"base": copy.deepcopy(dict(base)), "chunks": remaining}
    result.pop("claim", None)
    return result, "ready"


def retain_publication(st: dict[str, Any], carrier: Any) -> None:
    import copy
    pending = st.setdefault("mail_publication_wait", [])
    if carrier not in pending:
        pending.append(copy.deepcopy(carrier))


def return_handoffs(st: dict[str, Any], *, attempt: str) -> None:
    """An exceptional finalizer did not return its local follow-up. Queue it whole."""
    owners = st.get("mail_handoff_owners", {})
    keep = []
    for carrier in st.get("mail_handoffs", []):
        if owners.get(id(carrier)) != attempt:
            keep.append(carrier)
            continue
        if not any(c is carrier for c in st.get("queue", [])):
            st.setdefault("queue", []).append(carrier)
        owners.pop(id(carrier), None)
    st["mail_handoffs"] = keep


def replay_base(carrier: Any) -> dict[str, Any] | None:
    """Capture authored/replay bytes before adding new generated mail.

    Existing mail-bearing composition must prove its own boundaries. No text
    marker or event-looking prose is parsed to infer authorship.
    """
    import copy
    if isinstance(carrier, str):
        return {"text": carrier, "view": carrier}
    if not isinstance(carrier, Mapping) or not isinstance(carrier.get("text"), str):
        return None
    toks = _token_membership(carrier.get("toks", ()))
    if isinstance(toks, own.Gap):
        return None
    if toks:
        # Reuse the exact composer's structural proof, without consulting
        # delivery state or claiming those tokens were actually reclaimed.
        projected, outcome = project_carrier({_RECLAIMED: dict.fromkeys(toks)}, carrier)
        if outcome != "ready":
            return None
        carrier = projected
    return {"text": carrier["text"], "view": carrier.get("view", ""),
            **({"segments": copy.deepcopy(carrier["segs"])} if "segs" in carrier else {})}


def record_input(org: Any, nid: str, toks: Iterable[str], *, attempt: str,
                 base: Mapping[str, Any] | None, marker: dict[str, Any]) -> None:
    """Write input uncertainty with the launch marker, before provider handoff."""
    import copy
    wanted = frozenset(toks)
    if not wanted:
        return
    rows = (org.d.get("delivering") or {}).get(nid) or []
    selected = [r for r in rows if isinstance(r, Mapping) and r.get("tok") in wanted]
    if len(selected) != len(wanted) or {r["tok"] for r in selected} != wanted:
        raise ValueError("input journal membership is unproven")
    for row in selected:
        row["input_attempt"] = attempt
        note_engine(row)
    marker["mail_input"] = {"attempt": attempt, "tokens": sorted(wanted),
                            "base": copy.deepcopy(base)}


def replay_ready(org: Any, nid: str, marker: Mapping[str, Any]) -> dict[str, Any] | None:
    """Old markers keep their old behavior; new mail input needs positive proof.

    Uncertain input remains held with its complete original marker. Once every
    token is positively confirmed or durably folded back, replay contains only
    the recorded base.
    """
    import copy
    if "mail_input" not in marker:
        return copy.deepcopy(dict(marker))
    evidence = marker["mail_input"]
    if not isinstance(evidence, Mapping):
        return None
    toks = _token_membership(evidence.get("tokens", own.Gap.ABSENT))
    base = evidence.get("base")
    # Consumed (confirmed) or returned to the mailbox (reclaimed, e.g. by a
    # restart fold): either way the generated mail must not be replayed.
    settled = settled_tokens(org, nid, outcomes={"confirmed", "reclaimed"})
    if (isinstance(toks, own.Gap) or not toks or not toks.issubset(settled)
            or not isinstance(base, Mapping) or not isinstance(base.get("text"), str)
            or not isinstance(base.get("view"), str)):
        return None
    result = copy.deepcopy(dict(marker))
    result["text"], result["view"] = base["text"], base["view"]
    result.pop("segments", None)
    if "segments" in base:
        result["segments"] = copy.deepcopy(base["segments"])
    return result


def settle_replay(org: Any, nid: str) -> bool:
    node = org.nodes.get(nid)
    marker = node.get("inflight") if node is not None else None
    if not isinstance(marker, Mapping) or "mail_input" not in marker:
        return False
    ready = replay_ready(org, nid, marker)
    if ready is None or ready == marker:
        return False
    node["inflight"] = ready
    return True
