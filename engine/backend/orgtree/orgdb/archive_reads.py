"""Archive facts in the compatibility caller's own org transaction.

Identity returns every narrow header, including duplicate slugs in a deferred
transaction. Statuses use one indexed point probe per distinct stored value.
Neither query reads a record body, extra payload, or a child table. Migration
0014 projects exact headers at writes; an unindexable header explicitly refuses
so the unchanged caller takes its ordinary decode.
"""
from __future__ import annotations

import json
from typing import Any


IDENTITY_SQL = """SELECT archive_identity_slug, archive_legacy_identity
 FROM orgtree.work_items WHERE list_key='archive' ORDER BY ord"""
RECORD_IDENTITY_SQL = """SELECT id, archive_identity_slug, archive_legacy_identity
 FROM orgtree.work_items WHERE list_key IN ('active','archive') ORDER BY list_key,ord"""
UNREADABLE_STATUS_SQL = """SELECT 1 FROM orgtree.work_items
 WHERE list_key='archive' AND archive_status_key IS NULL LIMIT 1"""
STATUSES_SQL = """WITH RECURSIVE distinct_status(key) AS (
 SELECT (SELECT archive_status_key FROM orgtree.work_items
         WHERE list_key='archive' AND archive_status_key IS NOT NULL
         ORDER BY archive_status_key COLLATE "C" LIMIT 1)
 UNION ALL
 SELECT (SELECT archive_status_key FROM orgtree.work_items
         WHERE list_key='archive' AND archive_status_key COLLATE "C" > previous.key COLLATE "C"
         ORDER BY archive_status_key COLLATE "C" LIMIT 1)
 FROM distinct_status previous WHERE previous.key IS NOT NULL
) SELECT key FROM distinct_status WHERE key IS NOT NULL"""


def identity(raw: Any) -> list[tuple[str, bool]] | None:
    rows = raw.execute(IDENTITY_SQL).fetchall()
    if any(slug is None for slug, _ in rows):
        return None
    return [(slug, bool(old_id)) for slug, old_id in rows]


def current_identity(raw: Any) -> bool:
    """The ledger's record-derived identity, including empty and unusual names.

    Normal names come from covering headers. Only headers that cannot fit that
    index need a primary-key read of their stored scalar projection. Its Python
    coercion is exactly ledger.work_identity_state's str(value or ''). No item
    body, child record or durable identity marker participates in this check.
    """
    rows = raw.execute(RECORD_IDENTITY_SQL).fetchall()
    if any(old_id for _, _, old_id in rows):
        return False
    unusual = [rid for rid, name, _ in rows if name is None]
    values = {}
    if unusual:
        values = {rid: str(json.loads(value) or '') for rid, value in raw.execute(
            'SELECT id,work_identity_slug_value FROM orgtree.work_items WHERE id=ANY(%s)',
            (unusual,)).fetchall()}
    names = set()
    for rid, name, _ in rows:
        if name is None:
            name = values[rid]
        if not name or name in names:
            return False
        names.add(name)
    return True


def statuses(raw: Any) -> list[Any] | None:
    if raw.execute(UNREADABLE_STATUS_SQL).fetchone() is not None:
        return None
    result: list[Any] = []
    seen = set()
    for (key,) in raw.execute(STATUSES_SQL).fetchall():
        value = json.loads(key)
        # Keep JSON booleans and numbers distinct; Python equality alone would
        # silently discard True beside 1. Object key order is not identity.
        canonical = json.dumps(value, sort_keys=True, ensure_ascii=True,
                               separators=(',', ':'))
        if canonical not in seen:
            seen.add(canonical)
            result.append(value)
    return result
