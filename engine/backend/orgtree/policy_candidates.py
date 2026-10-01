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

PAGE_SIZE = 128
QUERY = 'SELECT id,ord FROM nodes WHERE (' + PREDICATE + ')'
FIRST_PAGE = QUERY + ' ORDER BY ord,id LIMIT 128'
NEXT_PAGE = QUERY + ' AND (ord,id)>(?,?) ORDER BY ord,id LIMIT 128'

# Materialized, bounded key selection prevents the planner from scanning all
# source bodies to discover membership. Relationships use primary-key probes.
GRAPH_QUERY = """WITH RECURSIVE candidates AS MATERIALIZED (
 SELECT unnest(?::text[]) AS id
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

# Same exclusions as the warm keeper's fingerprint. Split-owner/item bodies
# are separate reads; indexing this scalar namespace avoids walking their keys.
SETTINGS_PREDICATE = """strpos(key,chr(31))=0 AND key NOT IN (
 'nodes','work_items','mail','delivering','notices','mail_log','steered_log',
 'turn_error_log','steer_attempts','work_scope_log','events','org_inbox',
 'notice_log','user_mail_log','user_outbox','documents','watchdog_history',
 'op_receipts','work_items_archive','lifecycle','watchdogs','watchdog_tombs',
 'reservations','credit_requests')"""


def settings(conn):
    """All stored scalar policy settings, including custom identity inputs."""
    base = 'SELECT key,val FROM doc WHERE (' + SETTINGS_PREDICATE + ')'
    page = conn.execute(base + ' ORDER BY key LIMIT 128').fetchall()
    result = {}
    while page:
        result.update((key, json.loads(value)) for key, value in page)
        if len(page) < PAGE_SIZE:
            break
        page = conn.execute(base + ' AND key>? ORDER BY key LIMIT 128',
                            (page[-1][0],)).fetchall()
    return result


@dataclass(frozen=True)
class Graph:
    nodes: dict[str, dict]
    candidates: tuple[str, ...]
    ordinals: dict[str, int]
    # True only for a graph read() decoded for this one call: nobody else holds
    # its node dicts, so a consumer may adopt them instead of deep-copying
    # (keeper GIL stalls at N1000). Any other graph is shared and is copied.
    private: bool = False


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
        selected_ids = []
        page = conn.execute(FIRST_PAGE).fetchall()
        while page:
            selected_ids.extend(nid for nid, _ in page)
            if len(page) < PAGE_SIZE:
                break
            nid, ordinal = page[-1]
            page = conn.execute(NEXT_PAGE, (ordinal, nid)).fetchall()
        nodes, ordinals, candidates = {}, {}, []
        for nid, ordinal, value, selected in conn.execute(GRAPH_QUERY, (selected_ids,)).fetchall():
            row = json.loads(value)
            if not isinstance(row, dict):
                return None
            nodes[nid], ordinals[nid] = row, ordinal
            if selected:
                candidates.append(nid)
        # Private only while it goes straight to `project`; a graph returned
        # to the caller is the caller's, so it stays shared.
        graph = Graph(nodes, tuple(candidates), ordinals, private=project is not None)
        return graph if project is None else project(conn, graph)

    return store._bounded_read(slug, body)
