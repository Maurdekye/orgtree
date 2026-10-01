"""Lossless codec for authoritative per-owner custody receipts.

This module does not open a database or select a backend. Conversion callers
must publish the new storage marker only after verify() succeeds in the same
transaction. An unsupported source is retained on the compatibility path.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

SECTION = "mail_transitions"
FORMAT = "orgtree.mail-transitions/v1"


class Unsupported(ValueError):
    """The source cannot safely be represented by the current row format."""


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise Unsupported("duplicate JSON object key")
        out[key] = value
    return out


def loads(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(Unsupported("nonfinite JSON value")))
    except (TypeError, ValueError) as exc:
        raise Unsupported("invalid or ambiguous receipt JSON") from exc


def _key(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise Unsupported(f"invalid {label}")
    return value


def validate_receipt(owner: str, operation: str, value: Any) -> dict[str, Any]:
    _key(owner, "owner"); _key(operation, "operation token")
    if not isinstance(value, dict):
        raise Unsupported("receipt must be an object")
    if value.get("node") != owner or value.get("operation") != operation:
        raise Unsupported("receipt owner or operation disagrees with row key")
    if value.get("outcome") not in ("confirmed", "reclaimed"):
        raise Unsupported("unknown receipt outcome")
    identity = value.get("identity")
    if not isinstance(identity, list) or len(identity) != 3:
        raise Unsupported("unknown receipt identity")
    before = value.get("before")
    if not isinstance(before, dict):
        raise Unsupported("receipt token fingerprints must be an object")
    for token, digest in before.items():
        _key(token, "carrier token")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise Unsupported("unknown receipt fingerprint")
    # Extension fields are preserved, not interpreted or silently dropped.
    try:
        dumps(value)
    except (TypeError, ValueError) as exc:
        raise Unsupported("receipt is not finite JSON") from exc
    return value


@dataclass(frozen=True)
class Converted:
    present: bool
    owners: tuple[tuple[str, int], ...]
    receipts: tuple[tuple[str, str, int, str], ...]
    carriers: tuple[tuple[str, str, str], ...]
    checksum: str


def checksum(present: bool, value: dict[str, Any]) -> str:
    # Include absence separately from an explicitly empty container. Canonical
    # JSON retains numeric/boolean distinctions and every extension field.
    text = json.dumps([present, value], sort_keys=True, ensure_ascii=True,
                      separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split(source: str | None) -> Converted:
    """None means absent; JSON null is an unsupported source, never empty."""
    present = source is not None
    value = loads(source) if present else {}
    if not isinstance(value, dict):
        raise Unsupported("mail_transitions must be an object")
    owners: list[tuple[str, int]] = []
    receipts: list[tuple[str, str, int, str]] = []
    carriers: list[tuple[str, str, str]] = []
    for ordinal, (owner, entries) in enumerate(value.items()):
        _key(owner, "owner")
        if not isinstance(entries, dict):
            raise Unsupported("receipt owner must contain an object")
        owners.append((owner, ordinal))
        for position, (operation, receipt) in enumerate(entries.items()):
            validate_receipt(owner, operation, receipt)
            receipts.append((owner, operation, position, dumps(receipt)))
            carriers.extend((owner, token, operation) for token in receipt["before"])
    result = Converted(present, tuple(owners), tuple(receipts), tuple(carriers), checksum(present, value))
    verify(result)
    return result


def assemble(converted: Converted) -> dict[str, Any]:
    """Refuse missing, duplicate, cross-owner or misordered rows before export."""
    if not converted.present and (converted.owners or converted.receipts or converted.carriers):
        raise Unsupported("absent section contains rows")
    value: dict[str, Any] = {}
    previous_owner_ordinal = -1
    positions: dict[str, int] = {}
    for owner, ordinal in sorted(converted.owners, key=lambda row: row[1]):
        _key(owner, "owner")
        if not isinstance(ordinal, int) or ordinal <= previous_owner_ordinal or owner in value:
            raise Unsupported("duplicate or invalid owner ordinal")
        previous_owner_ordinal = ordinal
        value[owner] = {}
        positions[owner] = -1
    for owner, operation, ordinal, text in sorted(converted.receipts, key=lambda row: (row[0], row[2])):
        if (owner not in value or not isinstance(ordinal, int)
                or ordinal <= positions[owner] or operation in value[owner]):
            raise Unsupported("orphaned, duplicate or invalid receipt row")
        positions[owner] = ordinal
        value[owner][operation] = validate_receipt(owner, operation, loads(text))
    expected_carriers = {(owner, token, operation) for owner, entries in value.items()
                         for operation, receipt in entries.items() for token in receipt["before"]}
    if len(set(converted.carriers)) != len(converted.carriers) or set(converted.carriers) != expected_carriers:
        raise Unsupported("receipt carrier index mismatch")
    return value


def verify(converted: Converted) -> dict[str, Any]:
    value = assemble(converted)
    if checksum(converted.present, value) != converted.checksum:
        raise Unsupported("receipt conversion checksum mismatch")
    return {"format": FORMAT, "present": converted.present,
            "owners": len(converted.owners), "receipts": len(converted.receipts),
            "carriers": len(converted.carriers), "sha256": converted.checksum}
