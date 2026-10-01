"""Versioned PostgreSQL work-item rows; no database or backend side effects."""
from __future__ import annotations
import hashlib
import json
from collections.abc import Mapping
from typing import Any

SECTION = "work_items"
PREFIX = SECTION + "\x1f"
FORMAT = "orgtree.work-items/v1"


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def slug_of(item: Any) -> str:
    if not isinstance(item, dict):
        raise ValueError("work item must be an object")
    slug = item.get("slug")
    if not isinstance(slug, str) or not slug or "\x1f" in slug or "\x00" in slug:
        raise ValueError("work item needs a nonempty, unambiguous slug")
    return slug


def header(ids: list[str]) -> str:
    return dumps({"format": FORMAT, "ids": ids})


def ids_from_header(text: str) -> list[str]:
    value = json.loads(text)
    if not isinstance(value, dict) or set(value) != {"format", "ids"} or value["format"] != FORMAT:
        raise ValueError("unknown work-items layout")
    ids = value["ids"]
    if not isinstance(ids, list):
        raise ValueError("work-items header ids must be a list")
    for slug in ids:
        slug_of({"slug": slug})
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate work-item slug")
    return ids


def split(items: Any) -> dict[str, str]:
    if not isinstance(items, list):
        raise ValueError("work_items must be a list")
    ids = [slug_of(item) for item in items]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate work-item slug")
    return {SECTION: header(ids), **{PREFIX + slug: dumps(item) for slug, item in zip(ids, items)}}


def assemble(rows: Mapping[str, str]) -> list[dict[str, Any]]:
    ids = ids_from_header(rows[SECTION])
    if set(rows) != {SECTION, *(PREFIX + slug for slug in ids)}:
        raise ValueError("work-items header/row count or identity mismatch")
    result = []
    for slug in ids:
        item = json.loads(rows[PREFIX + slug])
        if slug_of(item) != slug:
            raise ValueError("work-item key disagrees with stored slug")
        result.append(item)
    return result


def checksum(items: list[dict[str, Any]]) -> dict[str, Any]:
    # Preserve list order and numeric/boolean type distinctions; JSON object
    # order and whitespace are not part of the logical content checksum.
    text = json.dumps(items, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {"count": len(items), "sha256": hashlib.sha256(text.encode()).hexdigest()}


def transform(doc: Mapping[str, str]) -> tuple[dict[str, str], dict[str, Any] | None]:
    """Source -> PG rows, with independent reconstructed-content verification."""
    owned = {k: v for k, v in doc.items() if k == SECTION or k.startswith(PREFIX)}
    if not owned:
        return dict(doc), None
    if SECTION not in owned:
        raise ValueError("orphaned work-item rows")
    value = json.loads(owned[SECTION])
    if not isinstance(value, list):
        # Only the exact current header is understood; mixed layouts refuse.
        value = assemble(owned)
    elif len(owned) != 1:
        raise ValueError("mixed work-items blob and item rows")
    target = split(value)
    before, after = checksum(value), checksum(assemble(target))
    if before != after:
        raise ValueError("work-items migration count/checksum mismatch")
    return {**{k: v for k, v in doc.items() if k not in owned}, **target}, before
