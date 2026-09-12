"""Read-only, metadata-only diagnostics for one authorized organization.

The helpers in this module deliberately accept an already loaded document.
They never save, mutate, or return a source record.  ``aggregate_document``
is also useful for fixture tests: its byte totals are the UTF-8 size of each
source row's compact JSON representation, not the size of the response.
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from . import store
from .ledger import LedgerError

router = APIRouter()

# Only collections with a stable row model are exposed.  This is a positive
# allowlist: a newly added top-level key cannot become diagnostic output by
# accident, and prompt/configuration keys are never traversed.
COLLECTION_FIELDS: dict[str, str] = {
    "nodes": "nodes",
    "events": "events",
    "org_inbox": "org_inbox",
    "notice_log": "notice_log",
    "documents": "documents",
    "user_mail_log": "user_mail_log",
    "user_outbox": "user_outbox",
    "work_items": "work_items",
    "watchdog_history": "watchdog_history",
    "mail_log": "mail_log",
    "steered_log": "steered_log",
    "turn_error_log": "turn_error_log",
    "steer_attempts": "steer_attempts",
    "op_receipts": "op_receipts",
    "work_items_archive": "work_items_archive",
}


def _row_values(value: Any) -> Iterable[Any]:
    """Yield collection rows without exposing the collection itself.

    Dict-backed collections use each value as the row payload.  Their keys
    are routing/owner metadata and are intentionally excluded from byte totals
    so a credential-like key cannot be echoed through diagnostics.
    """
    if isinstance(value, Mapping):
        for row in value.values():
            if isinstance(row, list):
                yield from row
            else:
                yield row
    elif isinstance(value, (list, tuple)):
        yield from value
    elif value is not None:
        yield value


def _row_bytes(row: Any) -> int:
    """Return deterministic source-row bytes, never the row itself."""
    try:
        return len(json.dumps(row, ensure_ascii=False, separators=(",", ":"))
                     .encode("utf-8"))
    except (TypeError, ValueError):
        # Malformed legacy rows still get a bounded, honest count.  The
        # diagnostic must not become a second failure path for a read route.
        return 0


def aggregate_document(document: Mapping[str, Any],
                       collections: Iterable[str] | None = None
                       ) -> dict[str, Any]:
    """Build counts and byte totals for an allowlisted document projection.

    ``document`` is read only.  The result contains collection names and two
    integers per collection; no source row, key, body, header, token, prompt,
    mail, or credential value is copied into it.
    """
    names = tuple(collections) if collections is not None else tuple(COLLECTION_FIELDS)
    unknown = sorted(set(names) - set(COLLECTION_FIELDS))
    if unknown:
        raise ValueError(f"unsupported diagnostic collection(s): {unknown!r}")
    result: dict[str, dict[str, int]] = {}
    total_rows = 0
    total_bytes = 0
    for name in names:
        rows = _row_values(document.get(COLLECTION_FIELDS[name]))
        row_count = 0
        size = 0
        for row in rows:
            row_count += 1
            size += _row_bytes(row)
        result[name] = {"rows": row_count, "bytes": size}
        total_rows += row_count
        total_bytes += size
    return {"collections": result,
            "totals": {"rows": total_rows, "bytes": total_bytes}}


def _operator_only(request: Request) -> None:
    """Reject kiosk and bridge callers; desktop-token callers are operators."""
    state = request.scope.get("state") or {}
    if state.get("public_slug") or state.get("bridge_slug"):
        raise HTTPException(403, "diagnostics are available only to the host operator")


@router.get("/api/orgs/{slug}/diagnostics/aggregates",
            dependencies=[Depends(_operator_only)])
def aggregates(slug: str, request: Request, collections: str = "") -> dict[str, Any]:
    """Return metadata-only counts for exactly one operator-authorized org.

    ``collections`` is an optional comma-separated allowlist selection.  No
    free-form document path or cross-organization selector is accepted.
    """
    del request  # dependency performs the authority check
    selected = tuple(part.strip() for part in collections.split(",") if part.strip()) or None
    try:
        org = store.load_org(slug)
    except LedgerError as exc:
        raise HTTPException(404, str(exc)) from exc
    try:
        body = aggregate_document(org.d, selected)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"org": slug, **body}


@router.get("/api/diagnostics/aggregates",
            dependencies=[Depends(_operator_only)])
def aggregates_unscoped(request: Request, org: str, collections: str = "") -> dict[str, Any]:
    """Compatibility shape for tooling that keeps the org in query data.

    ``org`` is still mandatory and is the only organization read; this is not
    a machine-wide aggregate endpoint.  The path-scoped form above is the
    preferred browser-facing route because its authorization scope is visible
    in the URL.
    """
    return aggregates(org, request, collections)
