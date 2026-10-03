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


def statuses(raw: Any) -> list[Any] | None:
    if raw.execute(UNREADABLE_STATUS_SQL).fetchone() is not None:
        return None
    result: list[Any] = []
    for (key,) in raw.execute(STATUSES_SQL).fetchall():
        value = json.loads(key)
        # JSON objects/arrays and numeric spelling can differ yet decode to
        # equal Python values. Preserve the value, never SQL ->> text coercion.
        if value not in result:
            result.append(value)
    return result
