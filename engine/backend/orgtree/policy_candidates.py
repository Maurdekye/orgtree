"""Exact periodic-policy candidates and their required node relationships.

This graph is a read input, not an Org or a writable transaction. In particular,
ancestors and predecessors must not become action candidates merely because
they are present. Callers retain their existing locked revalidation before any
action. A missing index or legacy node blob requests the entire legacy reader.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable

from . import store


# Keep identical to 0010's partial-index predicate. Match Python bool on JSON,
# including malformed-but-truthy freezes which the invariant loop quarantines.
PREDICATE = """val::jsonb->>'state'='live' OR
 coalesce(val::jsonb->'frozen','null'::jsonb) NOT IN
 ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)"""

QUERY = """WITH RECURSIVE candidates AS MATERIALIZED (
 SELECT id,ord FROM nodes WHERE """ + PREDICATE + """ ORDER BY ord,id
), needed(id) AS (
 SELECT id FROM candidates
 UNION
 SELECT link.id FROM needed r
 CROSS JOIN LATERAL (SELECT val FROM nodes WHERE id=r.id LIMIT 1) n
 CROSS JOIN LATERAL (VALUES (n.val::jsonb->>'parent'),
                           (n.val::jsonb->>'predecessor')) link(id)
 WHERE link.id IS NOT NULL AND link.id<>''
)
SELECT n.id,n.ord,n.val,(c.id IS NOT NULL) FROM needed r
CROSS JOIN LATERAL (SELECT id,ord,val FROM nodes WHERE id=r.id LIMIT 1) n
LEFT JOIN candidates c ON c.id=n.id ORDER BY n.ord,n.id
"""


@dataclass(frozen=True)
class Graph:
    nodes: dict[str, dict]
    candidates: tuple[str, ...]
    ordinals: dict[str, int]


def read(slug: str, project: Callable[[Any, Graph], Any] | None = None):
    """Read graph and optional policy inputs in one repeatable-read snapshot.

    The callback must finish its reads before returning; no live connection or
    mutable Org may escape. None means use the exact full-reader fallback.
    """
    if store.STORE_BACKEND != 'postgres':
        return None

    def body(conn):
        conn.execute('SET TRANSACTION READ ONLY')
        if conn.execute("SELECT 1 FROM doc WHERE key='nodes'").fetchone():
            return None
        if not conn.execute('SELECT to_regclass(?)',
                            (f'org_{conn.org_id}.ix_policy_candidates',)).fetchone()[0]:
            return None
        nodes, ordinals, candidates = {}, {}, []
        for nid, ordinal, value, selected in conn.execute(QUERY).fetchall():
            row = json.loads(value)
            if not isinstance(row, dict):
                return None
            nodes[nid], ordinals[nid] = row, ordinal
            if selected:
                candidates.append(nid)
        graph = Graph(nodes, tuple(candidates), ordinals)
        return graph if project is None else project(conn, graph)

    return store._bounded_read(slug, body)
