# pyright: strict
"""Durable, scoped resource reservations (W09).

This module is deliberately document-only.  Callers hold ``store.DOC_LOCK``
while invoking it, so acquisition and release are one load/mutate/save
transaction.  Declared paths are metadata used for overlap reports; they are
never resolved or opened and therefore never grant filesystem access.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, cast

from . import workevidence

MAX_RESERVATIONS = 512
MAX_PATHS = 128
MAX_PATH_LENGTH = 512
MAX_RESOURCE_LENGTH = 200
MAX_ITEM_LENGTH = 96
MAX_LEASE_S = 24 * 60 * 60
DEFAULT_LEASE_S = 15 * 60
DEFAULT_STALE_S = 5 * 60

HELD = "held"
RELEASED = "released"
RECOVERED = "recovered"
STALE = "stale"
LANDED = "landed"
TERMINAL = frozenset({RELEASED, RECOVERED, STALE, LANDED})


class ReservationError(ValueError):
    """A reservation precondition failed."""


def _now() -> float:
    return time.time()


def _stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any, name: str, limit: int) -> str:
    if value is None:
        raise ReservationError(f"{name} is required")
    s = str(value).strip()
    if not s:
        raise ReservationError(f"{name} is required")
    if "\x00" in s:
        raise ReservationError(f"{name} contains a NUL")
    if len(s) > limit:
        raise ReservationError(f"{name} is limited to {limit} characters")
    return s


def _paths(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReservationError("paths must be a list of declared path strings")
    if len(value) > MAX_PATHS:
        raise ReservationError(f"paths is limited to {MAX_PATHS} entries")
    out: list[str] = []
    for i, raw in enumerate(cast("list[Any]", value)):
        p = _text(raw, f"paths[{i}]", MAX_PATH_LENGTH)
        # Normalize separators for comparison only.  In particular, do not
        # call realpath/abspath: this is not a capability check or file read.
        p = p.replace("\\", "/")
        while "//" in p:
            p = p.replace("//", "/")
        p = p.rstrip("/") or "/"
        if p not in out:
            out.append(p)
    return out


def _sha(value: Any, name: str) -> str:
    try:
        return workevidence.validate_sha(value)
    except ValueError as e:
        raise ReservationError(f"{name} must be a commit SHA: {e}") from None


def _rows(d: dict[str, Any], create: bool = False) -> list[dict[str, Any]]:
    """The reservation records, or an empty store.

    An ABSENT ``reservations`` key is an EMPTY store, not a damaged one, and
    the difference matters more than it looks.  Until 2.1.7 every read action
    (list, landing, overlap, invalidate) fell through the ``create`` branch
    with ``raw`` still ``None`` and reported "reservation records are
    malformed" — so an org that had simply never taken a reservation was told
    its store was corrupt.  `list` is the first thing anyone runs, so that was
    the first thing anyone saw, and five agents independently concluded the
    tool was unusable and went back to coordinating landings by mail.  Nothing
    was ever wrong with the data; there was no data.

    A non-list value is still a genuine defect and still refuses, and now says
    what it actually found so the next reader is not sent the same way.
    """
    raw = d.get("reservations")
    if raw is None:
        if not create:
            return []
        raw = []
        d["reservations"] = raw
    if not isinstance(raw, list):
        raise ReservationError(
            "reservation records are malformed: expected a list, found "
            f"{type(raw).__name__}")
    return cast("list[dict[str, Any]]", raw)


def _safe(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return only reservation metadata; never echo arbitrary caller fields."""
    names = ("id", "owner", "item", "resource", "candidate", "base",
             "paths", "state", "created_at", "updated_at", "expires_at",
             "heartbeat_at", "release_receipt", "successor",
             "integration_receipt", "landed_at", "recovered_by",
             "recovered_reason", "stale_reason")
    return {k: row[k] for k in names if k in row}


#: The contention view.  A reservation on a SHARED resource is inherently a
#: public claim: you cannot serialize access to something without telling the
#: other claimants that it is taken, and a refusal that will not say who holds
#: the slot sends the loser back to asking around by mail.  This projection
#: carries the holder and the lease facts a contender needs in order to wait
#: for the right thing — and nothing else.  Deliberately absent: `paths` and
#: `item` (which describe the holder's private work), and every receipt and
#: integration key (which are capabilities, not status).
_CONTENTION_NAMES = ("id", "owner", "resource", "candidate", "base", "state",
                     "created_at", "updated_at", "expires_at", "heartbeat_at")


def _contention(row: Mapping[str, Any]) -> dict[str, Any]:
    out = {k: row[k] for k in _CONTENTION_NAMES if k in row}
    out["view"] = "contention"
    return out


def _owner_live(row: Mapping[str, Any],
                node_exists: Callable[[str], bool] | None) -> bool:
    """Whether this row's holder is still a live agent.

    With no way to ask, assume live: absence of proof that a holder is gone is
    never proof that it is gone, and this answer gates a takeover.
    """
    if node_exists is None:
        return True
    return bool(node_exists(str(row.get("owner") or "")))


def _recoverable(row: Mapping[str, Any], now_ts: float, stale_s: float,
                 node_exists: Callable[[str], bool] | None) -> bool:
    """Whether a held row may be taken over by someone else.

    Two independent ways for a holder to have stopped: its lease ran out, or
    it is no longer a live agent (retired, dissolved, or dead).  Either one
    opens the door — waiting out a full lease for an agent the org already
    knows is gone is how a slot gets stranded — but a QUIET HEARTBEAT is
    required in both cases.  Retirement interrupts a running turn and a tool
    call already in flight can still finish and touch disk, so "no longer
    live" is not by itself proof that nothing is being pushed right now; the
    heartbeat is.
    """
    if _active_heartbeat(row, now_ts, stale_s):
        return False
    return _expired(row, now_ts) or not _owner_live(row, node_exists)


def _held_by(row: Mapping[str, Any], resource: str, now_ts: float,
             suffix: str = "") -> str:
    """The refusal a losing contender reads: who holds it, and until when."""
    holder = str(row.get("owner") or "?")
    if not _expired(row, now_ts):
        why = "is already reserved by an active operation"
    else:
        # An expired lease with a live heartbeat is still an active
        # operation — say which of the two guards actually fired, because
        # "wait for the lease" and "wait for the holder to go quiet" are
        # different waits.
        why = ("lease expired but its heartbeat is active, so it is still an "
               "active operation and recovery cannot steal it")
    return (f"{resource} {why}{suffix}: held by {holder} since "
            f"{row.get('created_at')} (reservation {row.get('id')}, base "
            f"{row.get('base')}, candidate {row.get('candidate')}, lease "
            f"expires {row.get('expires_at')}, last heartbeat "
            f"{row.get('heartbeat_at')}). Wait for {holder} to release it, or "
            f"recover it once its lease has expired and its heartbeat is "
            f"quiet.")


def _find(rows: list[dict[str, Any]], rid: str) -> dict[str, Any]:
    for row in rows:
        if row.get("id") == rid:
            return row
    raise ReservationError("no such reservation")


def _same_scope(row: Mapping[str, Any], candidate: str, base: str) -> bool:
    return str(row.get("candidate") or "") == candidate and str(row.get("base") or "") == base


def _expired(row: Mapping[str, Any], now_ts: float) -> bool:
    try:
        return float(row.get("expires_ts") or 0) <= now_ts
    except (TypeError, ValueError):
        return True


def _active_heartbeat(row: Mapping[str, Any], now_ts: float,
                      stale_s: float) -> bool:
    try:
        return now_ts - float(row.get("heartbeat_ts") or 0) <= stale_s
    except (TypeError, ValueError):
        return False


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:20]}"


def _receipt(kind: str, rid: str, actor: str, ts: float,
             successor: str = "") -> str:
    # A receipt is an opaque identifier, not a hash of a path or any caller
    # content.  It is enough to bind the durable state transition uniquely.
    return f"{kind}:{rid}:{hashlib.sha256(f'{actor}:{ts}:{uuid.uuid4().hex}'.encode()).hexdigest()[:16]}"


def _visible(row: Mapping[str, Any], actor: str,
             item_reader: Callable[[str], bool] | None) -> bool:
    owner = str(row.get("owner") or "")
    if actor == owner:
        return True
    item = str(row.get("item") or "")
    return bool(item and item_reader and item_reader(item))


def _authorize(row: Mapping[str, Any], actor: str,
               item_reader: Callable[[str], bool] | None,
               *, owner_only: bool = False) -> None:
    if owner_only:
        if actor != str(row.get("owner") or ""):
            raise ReservationError("only the reservation owner may perform this action")
        return
    if not _visible(row, actor, item_reader):
        raise ReservationError("reservation is not visible to this collaborator")


def _mark_scope_stale(row: dict[str, Any], candidate: str, base: str,
                      ts: float) -> None:
    if row.get("state") in TERMINAL:
        return
    if not _same_scope(row, candidate, base):
        row["state"] = STALE
        row["stale_reason"] = "candidate_or_base_changed"
        row["updated_at"] = _stamp(ts)
        row["updated_ts"] = ts


def execute(d: dict[str, Any], actor: str, args: Mapping[str, Any],
            *, item_reader: Callable[[str], bool] | None = None,
            node_exists: Callable[[str], bool] | None = None,
            successor_allowed: Callable[[str, str], bool] | None = None,
            now_ts: float | None = None) -> dict[str, Any]:
    """Apply one reservation action to ``d``; caller owns lock and save.

    ``item_reader`` must answer visibility for a docket item without returning
    its contents.  This keeps reservation metadata from creating a second
    authorization implementation and keeps hidden item names indistinguishable
    from nonexistent ones at the API boundary.
    """
    ts = _now() if now_ts is None else float(now_ts)
    action = str(args.get("action") or "").strip().lower()
    if action not in {"acquire", "renew", "recover", "release", "overlap",
                      "land", "list", "landing", "invalidate"}:
        raise ReservationError("action must be acquire|renew|recover|release|overlap|land|list|landing|invalidate")
    rows = _rows(d, create=action in {"acquire", "land", "release", "renew", "recover"})

    if action == "list":
        resource = str(args.get("resource") or "").strip()
        expected_candidate = expected_base = ""
        if args.get("candidate") is not None or args.get("base") is not None:
            expected_candidate = _sha(args.get("candidate"), "candidate")
            expected_base = _sha(args.get("base"), "base")
        stale: list[str] = []
        if expected_candidate and expected_base:
            for old in rows:
                if (not resource or old.get("resource") == resource) and \
                        _visible(old, actor, item_reader):
                    before = old.get("state")
                    if (old.get("state") == HELD
                            and not _same_scope(old, expected_candidate,
                                                expected_base)
                            and (not _expired(old, ts)
                                 or _active_heartbeat(
                                     old, ts, float(old.get("stale_s")
                                                    or DEFAULT_STALE_S)))):
                        # Reporting a changed scope never grants permission
                        # to steal an active operation; leave this row held
                        # until its owner releases it or its heartbeat goes
                        # stale.
                        continue
                    _mark_scope_stale(old, expected_candidate, expected_base, ts)
                    if old.get("state") != before:
                        stale.append(str(old.get("id") or ""))
        # Scope-staling above stays gated on full visibility: naming a
        # resource lets you SEE a claim on it, never mutate somebody else's
        # row.  Only the projection below is widened.
        out: list[dict[str, Any]] = []
        for r in rows:
            if resource and r.get("resource") != resource:
                continue
            if _visible(r, actor, item_reader):
                out.append(_safe(r))
            elif resource and r.get("state") == HELD:
                # You asked about one named resource and something is holding
                # it right now.  That claim is against you, so you get to see
                # whose it is and when it runs out — this is the whole point
                # of a lease being a mechanism rather than a convention.
                # Requiring the explicit `resource` keeps an unfiltered list
                # from becoming an org-wide directory of private reservations,
                # and HELD-only keeps it to claims that still bind anyone.
                out.append(_contention(r))
        return {"reservations": out, "count": len(out), "stale": stale}

    if action == "landing":
        item = _text(args.get("item"), "item", MAX_ITEM_LENGTH)
        out = [_safe(r) for r in rows if r.get("item") == item
               and r.get("state") == LANDED and _visible(r, actor, item_reader)]
        if not out and item_reader and not item_reader(item):
            raise ReservationError("reservation is not visible to this collaborator")
        return {"landed": out, "count": len(out)}

    if action == "acquire":
        resource = _text(args.get("resource"), "resource", MAX_RESOURCE_LENGTH)
        candidate = _sha(args.get("candidate"), "candidate")
        base = _sha(args.get("base"), "base")
        item = _text(args.get("item"), "item", MAX_ITEM_LENGTH) if args.get("item") else ""
        if item and item_reader and not item_reader(item):
            raise ReservationError("reservation is not visible to this collaborator")
        paths = _paths(args.get("paths"))
        integration_key = str(args.get("integration_key") or "").strip()
        if len(integration_key) > 200:
            raise ReservationError("integration_key is limited to 200 characters")
        lease = float(args.get("lease_s") or DEFAULT_LEASE_S)
        stale_s = float(args.get("stale_s") or DEFAULT_STALE_S)
        if lease <= 0 or lease > MAX_LEASE_S or stale_s <= 0 or stale_s > MAX_LEASE_S:
            raise ReservationError("lease_s and stale_s must be positive and bounded")
        # Integration keys are idempotency keys, not permission keys. A key
        # belonging to another scope is a conflict, never a replay.
        if integration_key:
            for old in rows:
                if old.get("integration_key") == integration_key:
                    if not (old.get("resource") == resource and _same_scope(old, candidate, base)):
                        raise ReservationError("integration_key already identifies a different reservation")
                    _authorize(old, actor, item_reader)
                    return {"reservation": _safe(old), "replayed": True}
        if len(rows) >= MAX_RESERVATIONS:
            raise ReservationError(f"reservation store is limited to {MAX_RESERVATIONS} records")
        for old in rows:
            if old.get("resource") != resource or old.get("state") not in (HELD,):
                continue
            same = _same_scope(old, candidate, base)
            if same and not _expired(old, ts) and \
                    str(old.get("owner") or "") == actor:
                return {"reservation": _safe(old), "replayed": True}
            # A changed candidate/base invalidates a grant, but it does not
            # authorize a competing operation to steal a still-live owner, and
            # neither does an expired lease on its own.  Prove the holder has
            # stopped first; otherwise leave the row untouched and refuse,
            # naming the holder so the loser knows who to wait for instead of
            # going back to asking around.
            old_stale = float(old.get("stale_s") or stale_s)
            if not _recoverable(old, ts, old_stale, node_exists):
                raise ReservationError(_held_by(
                    old, resource, ts,
                    "" if same else "; a changed candidate or base cannot "
                    "steal it either"))
            if not same:
                _mark_scope_stale(old, candidate, base, ts)
                continue
            old["state"] = RECOVERED
            old["recovered_by"] = actor
            old["recovered_reason"] = ("lease_expired" if _expired(old, ts)
                                       else "owner_not_live")
            old["updated_at"] = _stamp(ts)
            old["updated_ts"] = ts
        rid = _id("res")
        row: dict[str, Any] = {
            "id": rid, "owner": actor, "item": item, "resource": resource,
            "candidate": candidate, "base": base, "paths": paths,
            "state": HELD, "created_at": _stamp(ts), "updated_at": _stamp(ts),
            "created_ts": ts, "updated_ts": ts, "expires_ts": ts + lease,
            "expires_at": _stamp(ts + lease), "heartbeat_ts": ts,
            "heartbeat_at": _stamp(ts), "stale_s": stale_s,
        }
        if integration_key:
            row["integration_key"] = integration_key
        rows.append(row)
        return {"reservation": _safe(row), "replayed": False}

    # overlap is a scoped metadata query and has no reservation id. Keep it
    # before the id-bearing mutation actions so malformed ids cannot turn a
    # harmless query into a misleading refusal.
    if action == "overlap":
        paths = _paths(args.get("paths"))
        item = _text(args.get("item"), "item", MAX_ITEM_LENGTH)
        if item_reader and not item_reader(item):
            raise ReservationError("reservation is not visible to this collaborator")
        resource = str(args.get("resource") or "").strip()

        def overlaps(a: str, b: str) -> bool:
            aa, bb = a.rstrip("/"), b.rstrip("/")
            return aa == bb or aa.startswith(bb + "/") or bb.startswith(aa + "/")

        matches: list[dict[str, Any]] = []
        for old in rows:
            if old.get("item") != item or (resource and old.get("resource") != resource):
                continue
            if not _visible(old, actor, item_reader):
                continue
            hit = [p for p in paths if any(overlaps(p, q) for q in old.get("paths") or [])]
            if hit:
                matches.append({"reservation": _safe(old), "overlap": hit})
        return {"overlaps": matches, "count": len(matches)}

    rid = _text(args.get("reservation"), "reservation", 80)
    row = _find(rows, rid)
    seen = _visible(row, actor, item_reader)
    if action == "recover" and row.get("state") == HELD:
        # Recovery is guarded by STATE, not by acquaintance.  It already
        # requires a quiet heartbeat plus either an expired lease or a holder
        # that is no longer live, and `acquire` performs exactly this recovery
        # inline with no visibility check at all — so gating the explicit,
        # auditable route on item visibility only blocked the contender who
        # most needs it (two agents queueing for `main` share no docket item)
        # while leaving the implicit route wide open.  A HELD claim on a shared
        # resource is public by nature; whoever is contending for that resource
        # may clear a dead one.  A non-acquainted caller still sees only the
        # contention projection of the result, never paths or the item.
        pass
    else:
        _authorize(row, actor, item_reader,
                   owner_only=action in {"renew", "release", "land"})

    if action == "invalidate":
        candidate = _sha(args.get("candidate"), "candidate")
        base = _sha(args.get("base"), "base")
        if row.get("state") != HELD:
            return {"reservation": _safe(row), "replayed": True}
        if _same_scope(row, candidate, base):
            raise ReservationError("candidate and base are unchanged")
        if not _expired(row, ts) or _active_heartbeat(
                row, ts, float(row.get("stale_s") or DEFAULT_STALE_S)):
            raise ReservationError(
                "reservation is active; changed candidate or base cannot steal it")
        _mark_scope_stale(row, candidate, base, ts)
        return {"reservation": _safe(row), "stale": True}

    if action == "renew":
        if row.get("state") != HELD:
            raise ReservationError("only a held reservation can be renewed")
        lease = float(args.get("lease_s") or DEFAULT_LEASE_S)
        if lease <= 0 or lease > MAX_LEASE_S:
            raise ReservationError("lease_s must be positive and bounded")
        row["expires_ts"] = ts + lease
        row["expires_at"] = _stamp(ts + lease)
        row["heartbeat_ts"] = ts
        row["heartbeat_at"] = _stamp(ts)
        row["updated_ts"] = ts
        row["updated_at"] = _stamp(ts)
        return {"reservation": _safe(row), "renewed": True}

    if action == "recover":
        if row.get("state") != HELD:
            raise ReservationError("only a held reservation can be recovered")
        # Recovery uses the threshold captured with the lease.  Allowing a
        # caller to supply a shorter threshold would let it steal an expired
        # lease while the owner's recorded heartbeat is still active.
        stale_s = float(row.get("stale_s") or DEFAULT_STALE_S)
        if _active_heartbeat(row, ts, stale_s):
            raise ReservationError("reservation heartbeat is active; recovery cannot steal an active operation")
        # A holder the org knows is gone does not get to keep the slot for the
        # rest of its lease.  This is not a forced break: nobody judges whether
        # a LIVE agent looks stuck, and the quiet heartbeat above is still
        # required, so an in-flight push is never interrupted.
        live = _owner_live(row, node_exists)
        if not _expired(row, ts) and live:
            raise ReservationError("reservation is still leased; recovery cannot steal an active operation")
        row["state"] = RECOVERED
        row["recovered_by"] = actor
        row["recovered_reason"] = ("lease_expired" if _expired(row, ts)
                                   else "owner_not_live")
        row["updated_ts"] = ts
        row["updated_at"] = _stamp(ts)
        return {"reservation": _safe(row) if seen else _contention(row),
                "recovered": True}

    if action == "release":
        if row.get("state") not in (HELD,):
            if row.get("state") == RELEASED:
                return {"reservation": _safe(row), "replayed": True, "notified": None}
            raise ReservationError("only a held reservation can be released")
        successor = str(args.get("successor") or "").strip()
        if successor and node_exists and not node_exists(successor):
            raise ReservationError("successor is not a live collaborator")
        if successor and successor_allowed and not successor_allowed(
                successor, str(row.get("item") or "")):
            raise ReservationError("successor is not a live collaborator")
        receipt = _receipt("release", rid, actor, ts, successor)
        row["state"] = RELEASED
        row["release_receipt"] = receipt
        row["successor"] = successor or None
        row["updated_ts"] = ts
        row["updated_at"] = _stamp(ts)
        out: dict[str, Any] = {"reservation": _safe(row), "released": True,
                               "release_receipt": receipt, "notified": successor or None}
        return out

    if action == "land":
        if row.get("state") != HELD:
            if row.get("state") == LANDED:
                return {"reservation": _safe(row), "replayed": True}
            raise ReservationError("only a held reservation can record a landing")
        candidate = _sha(args.get("candidate") or row.get("candidate"), "candidate")
        base = _sha(args.get("base") or row.get("base"), "base")
        if not _same_scope(row, candidate, base):
            _mark_scope_stale(row, candidate, base, ts)
            raise ReservationError("candidate or base changed; reservation is stale")
        key = str(args.get("integration_key") or row.get("integration_key") or "").strip()
        if key:
            for old in rows:
                if old is row or old.get("integration_key") != key:
                    continue
                if old.get("state") == LANDED:
                    return {"reservation": _safe(old), "replayed": True}
                raise ReservationError(
                    "integration_key already identifies a different reservation")
        receipt = _receipt("land", rid, actor, ts)
        row["state"] = LANDED
        row["integration_receipt"] = receipt
        row["integration_key"] = key or row.get("integration_key")
        row["landed_at"] = _stamp(ts)
        row["updated_ts"] = ts
        row["updated_at"] = _stamp(ts)
        return {"reservation": _safe(row), "integration_receipt": receipt, "landed": True}
