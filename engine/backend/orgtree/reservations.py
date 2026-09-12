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
    raw = d.get("reservations")
    if raw is None and create:
        raw = []
        d["reservations"] = raw
    if not isinstance(raw, list):
        raise ReservationError("reservation records are malformed")
    return cast("list[dict[str, Any]]", raw)


def _safe(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return only reservation metadata; never echo arbitrary caller fields."""
    names = ("id", "owner", "item", "resource", "candidate", "base",
             "paths", "state", "created_at", "updated_at", "expires_at",
             "heartbeat_at", "release_receipt", "successor",
             "integration_receipt", "landed_at", "recovered_by",
             "stale_reason")
    return {k: row[k] for k in names if k in row}


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
        out = [_safe(r) for r in rows if (not resource or r.get("resource") == resource)
               and _visible(r, actor, item_reader)]
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
            if not _same_scope(old, candidate, base):
                # A changed candidate/base invalidates a grant, but it does
                # not authorize a competing operation to steal a still-live
                # owner.  First prove the old operation is expired *and* its
                # heartbeat is stale; otherwise leave it untouched and
                # refuse the acquisition.
                old_stale = float(old.get("stale_s") or stale_s)
                if not _expired(old, ts) or _active_heartbeat(
                        old, ts, old_stale):
                    raise ReservationError(
                        "resource is reserved by an active operation; changed "
                        "candidate or base cannot steal it")
                _mark_scope_stale(old, candidate, base, ts)
                continue
            if not _expired(old, ts):
                if str(old.get("owner") or "") == actor:
                    return {"reservation": _safe(old), "replayed": True}
                raise ReservationError("resource is already reserved by an active operation")
            if _active_heartbeat(old, ts, stale_s):
                raise ReservationError("resource lease expired but its heartbeat is active; recovery cannot steal it")
            old["state"] = RECOVERED
            old["recovered_by"] = actor
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
        if not _expired(row, ts):
            raise ReservationError("reservation is still leased; recovery cannot steal an active operation")
        if _active_heartbeat(row, ts, stale_s):
            raise ReservationError("reservation heartbeat is active; recovery cannot steal an active operation")
        row["state"] = RECOVERED
        row["recovered_by"] = actor
        row["updated_ts"] = ts
        row["updated_at"] = _stamp(ts)
        return {"reservation": _safe(row), "recovered": True}

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
