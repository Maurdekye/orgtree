"""Committed, indexed node discovery. These are INTERNAL storage projections.

No Org construction, cache/feed dependence, mail/docket history or public API
authorization lives here. A caller must project/scrub nodes before serving them.
Each call releases its repeatable-read snapshot before returning. The old full
tree remains the compatibility reader on other backends.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
import base64
import hashlib
import json
import os
import re
from typing import Any, Callable, Iterator

from . import store
from .ledger import ASK_HISTORY_KEEP, LedgerError

MAX_PAGE = 100
MAX_INCLUDE = 128
ASK_SECTIONS = ('asks', 'credit_requests', 'scope_requests')
Projector = Callable[[Any, dict], Any]


class CursorReset(ValueError):
    """The catalog changed; the caller must explicitly restart this page set."""

    def __init__(self, message: str, catalog: str):
        super().__init__(message)
        self.catalog = catalog


class OrgNotFound(LedgerError):
    """The organization itself is absent, unlike an inconsistent index."""


def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _filter(value: Any) -> str:
    return hashlib.sha256(_encode(value).encode()).hexdigest()[:24]


def _cursor(stamp: dict, kind: str, filters: Any, after: Any) -> str:
    payload = [1, stamp['org_id'], stamp['catalog_revision'], kind, _filter(filters), after]
    return base64.urlsafe_b64encode(_encode(payload).encode()).decode().rstrip('=')


def _after(cursor: str | None, stamp: dict, kind: str, filters: Any) -> Any:
    if not cursor:
        return None
    try:
        if len(cursor) > 4096:
            raise ValueError('cursor too long')
        value = json.loads(base64.b64decode(cursor + '=' * (-len(cursor) % 4),
                                         altchars=b'-_', validate=True))
        if not isinstance(value, list) or len(value) != 6 or value[0] != 1:
            raise ValueError('unknown cursor')
        if value[3:5] != [kind, _filter(filters)]:
            raise ValueError('cursor belongs to another query')
        if value[1] != stamp['org_id'] or value[2] != stamp['catalog_revision']:
            raise CursorReset('catalog changed; restart pagination',
                              f"{stamp['org_id']}:{stamp['catalog_revision']}")
        return value[5]
    except CursorReset:
        raise
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ValueError('invalid foreground cursor') from exc


def _limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE:
        raise ValueError(f'limit must be between 1 and {MAX_PAGE}')
    return limit


def _child_order(after: Any) -> list:
    """Validate an untrusted keyset before PostgreSQL casts or adapts it."""
    if not isinstance(after, list) or len(after) != 4:
        raise ValueError('invalid child ordering cursor')
    order, created, ordinal, nid = after
    if isinstance(order, bool) or not isinstance(order, (str, int, float)):
        raise ValueError('invalid child ordering cursor')
    order = str(order)
    if not re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', order):
        raise ValueError('invalid child ordering cursor')
    try:
        number = Decimal(order)
        # PostgreSQL unconstrained numeric has these integer/scale limits.
        # Reject oversized exponents before sending an otherwise finite value.
        if not number.is_finite() or number.adjusted() > 131071 or number.as_tuple().exponent < -16383:
            raise ValueError('invalid child ordering cursor')
    except InvalidOperation as error:
        raise ValueError('invalid child ordering cursor') from error
    if type(ordinal) is not int or not -(2**63) <= ordinal < 2**63:
        raise ValueError('invalid child ordering cursor')
    for value in (created, nid):
        if not isinstance(value, str) or '\x00' in value:
            raise ValueError('invalid child ordering cursor')
        try:
            value.encode('utf-8')
        except UnicodeError as error:
            raise ValueError('invalid child ordering cursor') from error
    return [order, created, ordinal, nid]


@contextmanager
def _snapshot(slug: str) -> Iterator[tuple[Any, dict]]:
    if store.STORE_BACKEND != 'postgres':
        raise NotImplementedError('foreground index requires PostgreSQL')
    slug = store._safe_slug(slug)
    store._ensure_migrated(slug)
    if not os.path.exists(store._db_path(slug)):
        raise OrgNotFound(f'no such org: {slug!r}')
    with store._POOL.acquire(slug) as conn:
        if conn.in_transaction:
            # A deferred index is a COMMITTED reader contract. Reusing a
            # writer's uncommitted nodes with its old index would violate it.
            raise RuntimeError('foreground reads cannot reuse a writer transaction')
        conn.use()
        conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            row = conn.raw.execute(
                'SELECT o.org_id,o.revision,f.node_revision,f.catalog_revision,'
                'f.node_count,f.retired_axis_count,f.cost,f.cost_unknown,f.view_revision '
                'FROM public.orgs o CROSS JOIN foreground_meta f '
                'WHERE o.org_id=%s AND f.singleton=1', (conn.org_id,)).fetchone()
            if row is None:
                raise LedgerError('foreground index is incomplete')
            names = ('org_id', 'org_revision', 'node_revision', 'catalog_revision',
                     'node_count', 'retired_axis_count', 'cost', 'cost_unknown', 'view_revision')
            stamp = dict(zip(names, row))
            stamp['cost'] = str(stamp['cost'])  # exact decimal across cursor/JSON boundaries
            yield conn.raw, stamp
        finally:
            conn.raw.execute('ROLLBACK')


def _wanted(values) -> tuple[str, ...]:
    values = tuple(dict.fromkeys(values))
    if len(values) > MAX_INCLUDE or any(not isinstance(v, str) or not v for v in values):
        raise ValueError(f'include must contain at most {MAX_INCLUDE} nonempty IDs')
    return values


def _rows(raw: Any, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = raw.execute(
        'SELECT i.id,i.ord,i.meta,i.lineage_count,i.consult_id,c.meta,n.val '
        'FROM node_index i JOIN nodes n ON n.id=i.id '
        'LEFT JOIN node_index c ON c.id=i.consult_id '
        'WHERE i.id=ANY(%s) ORDER BY i.ord,i.id', (ids,)).fetchall()
    if len(rows) != len(set(ids)):
        raise LedgerError('foreground index and node rows disagree')
    return {nid: {'node': json.loads(value), 'meta': meta, 'ordinal': ordinal,
                  'lineage_count': count,
                  'consultable_predecessor': ({'id': consult, 'generation': cm['generation']}
                                             if consult is not None else None)}
            for nid, ordinal, meta, count, consult, cm, value in rows}


def _ancestors(raw: Any, ids: list[str]) -> list[str]:
    # UNION (not UNION ALL) makes a corrupt parent cycle finite. The route
    # still detects/reports a cycle when constructing the graph.
    return [row[0] for row in raw.execute(
        'WITH RECURSIVE selected(id,parent) AS ('
        "SELECT id,meta->>'parent' FROM node_index WHERE id=ANY(%s) UNION "
        "SELECT p.id,p.meta->>'parent' FROM node_index p "
        'JOIN selected c ON p.id=c.parent) SELECT id FROM selected', (ids,)).fetchall()]


def _graph(raw: Any, stamp: dict, ids: list[str], requested: tuple[str, ...] = ()) -> dict:
    included = _ancestors(raw, ids)
    rows = _rows(raw, included)
    parents = ['', *included]
    hidden = dict(raw.execute(
        'SELECT parent,retired_children FROM foreground_parents WHERE parent=ANY(%s)',
        (parents,)).fetchall())
    for row in rows.values():
        meta = row['meta']
        if meta['state'] == 'archived' and not meta['successor']:
            parent = meta['parent']
            hidden[parent] = hidden.get(parent, 0) - 1
    if any(count < 0 for count in hidden.values()):
        raise LedgerError('foreground child counts disagree with indexed nodes')
    missing_parents = sorted({row['meta']['parent'] for row in rows.values()
                              if row['meta']['parent'] and row['meta']['parent'] not in rows})
    return {'stamp': stamp, 'rows': rows,
            'hidden_retired_children': {p: hidden.get(p, 0) for p in parents},
            'missing': [nid for nid in requested if nid not in rows],
            'missing_ancestors': missing_parents}


def read_card_windows(raw: Any, ids: list[str], *, header: bool = False) -> dict:
    """Read the existing visible ask/document windows from the caller's snapshot.

    The returned ask lists preserve source order. They contain every open row,
    the header's newest resolved rows, and each selected node's most recent
    resolved row per section. Org.node_ask still decides batching and linger;
    storage must not duplicate its time/boot or withdrawn-card rules.
    """
    rows: dict[tuple[str, int], tuple] = {}
    for row in raw.execute(
            "SELECT sect,ord,val FROM foreground_asks WHERE status IN ('open','pending') "
            'AND (%s OR node=ANY(%s))', (header, ids)).fetchall():
        rows[row[:2]] = row
    for section in ASK_SECTIONS:
        visible = " AND status<>'withdrawn'" if section != 'asks' else ''
        if header:
            # At most ASK_HISTORY_KEEP per section suffice for the shared ledger
            # header cap; its order is asks, credits, scope, each in source order.
            for row in raw.execute(
                    'SELECT sect,ord,val FROM foreground_asks WHERE sect=%s '
                    "AND status NOT IN ('open','pending')" + visible +
                    ' ORDER BY ord DESC LIMIT %s', (section, ASK_HISTORY_KEEP)).fetchall():
                rows[row[:2]] = row
        for row in raw.execute(
                'SELECT q.sect,q.ord,q.val FROM unnest(%s::text[]) node(id) '
                'CROSS JOIN LATERAL (SELECT sect,ord,val FROM foreground_asks '
                'WHERE node=node.id AND sect=%s' + visible +
                ' ORDER BY stamp DESC,ord LIMIT 1) q', (ids, section)).fetchall():
            rows[row[:2]] = row
    asks = {section: [json.loads(row[2]) for row in sorted(rows.values(), key=lambda r: r[1])
                      if row[0] == section] for section in ASK_SECTIONS}
    # A pre-rowed documents blob takes precedence, exactly as LazyDoc does.
    source = int(raw.execute("SELECT EXISTS(SELECT 1 FROM doc WHERE key='documents')").fetchone()[0])
    counts = dict(raw.execute(
        "SELECT owner,total FROM foreground_counts WHERE source=%s AND sect='documents' AND owner=ANY(%s)",
        (source, ids)).fetchall())
    documents = {nid: [] for nid in ids}
    for nid, seq, meta in raw.execute(
            'SELECT node.id,q.seq,q.meta FROM unnest(%s::text[]) node(id) '
            'CROSS JOIN LATERAL (SELECT seq,meta FROM foreground_documents '
            'WHERE source=%s AND foreground_documents.node=node.id ORDER BY seq DESC LIMIT 10) q '
            'ORDER BY node.id,q.seq', (ids, source)).fetchall():
        documents[nid].append(meta)
    return {'asks': asks, 'documents': documents,
            'document_counts': {nid: counts.get(nid, 0) for nid in ids}}


def read_org_inbox_window(raw: Any) -> dict:
    """Exact log-coordinate counts and the existing three-entry preview.

    This only reads the caller's already-open committed snapshot. In particular,
    acknowledgements use total, never the length of the preview.
    """
    blob = raw.execute("SELECT val FROM foreground_blobs WHERE key='org_inbox'").fetchone()
    if blob is not None:
        total, entries = blob[0]['total'], blob[0]['entries']
    else:
        count = raw.execute("SELECT total FROM foreground_counts WHERE source=0 AND sect='org_inbox' AND owner=''").fetchone()
        total = count[0] if count else 0
        entries = [json.loads(row[0]) for row in reversed(raw.execute(
            "SELECT val FROM log_l WHERE sect='org_inbox' ORDER BY seq DESC LIMIT 3").fetchall())]
    ack = raw.execute("SELECT val FROM doc WHERE key='org_inbox_read'").fetchone()
    read = int(json.loads(ack[0]) or 0) if ack else 0
    return {'total': total, 'unread': max(0, total - read), 'entries': entries}


def read_funding(raw: Any) -> list[dict]:
    """All funded seats, not just the selected graph (unrecoverable included).

    Raw missing grant/model values remain visible to the context normalizer.
    It must apply the existing legacy rules or refuse the bounded context;
    this reader must not invent a zero budget for an incomplete record.
    """
    return [{'id': nid, **{key: meta[key] for key in ('parent', 'state', 'model', 'grant')}}
            for nid, meta in raw.execute(
                "SELECT id,meta FROM node_index WHERE meta->>'state'<>'archived' ORDER BY ord,id").fetchall()]


def _project(raw: Any, graph: dict, project: Projector | None) -> Any:
    # Assembly stays INSIDE the graph snapshot. Never pass a connection out
    # of the context manager or reopen one for headers/authority/funding.
    return project(raw, graph) if project is not None else graph


def read_snapshot(slug: str, read: Callable[[Any, dict], Any]) -> Any:
    """Run a bounded view/cache decision inside one committed snapshot."""
    with _snapshot(slug) as (raw, stamp):
        return read(raw, stamp)


def select_foreground(raw: Any, stamp: dict, include=()) -> dict:
    """Select the foreground using an already-open snapshot, e.g. on cache miss."""
    wanted = _wanted(include)
    ids = [row[0] for row in raw.execute(
        "SELECT id FROM node_index WHERE meta->>'state'<>'archived' ORDER BY ord,id").fetchall()]
    ids.extend(wanted)
    return _graph(raw, stamp, ids, wanted)


def read_foreground(slug: str, include=(), *, project: Projector | None = None) -> Any:
    wanted = _wanted(include)
    with _snapshot(slug) as (raw, stamp):
        # This predicate has its own partial index. It must never be replaced
        # by a full-row scan followed by a Python filter.
        return _project(raw, select_foreground(raw, stamp, wanted), project)


def read_exact(slug: str, nid: str, *, project: Projector | None = None) -> Any:
    wanted = _wanted([nid])
    with _snapshot(slug) as (raw, stamp):
        return _project(raw, _graph(raw, stamp, list(wanted), wanted), project)


def read_references(slug: str, include=(), *, project: Projector | None = None) -> Any:
    """Exact identity facts only, with neither node bodies nor ancestor walks.

    Both sides of the node/index join are checked so index corruption cannot
    be reported as authoritative absence. Every returned field is public tree
    identity data; never return the index metadata object (it holds secrets).
    """
    values = tuple(include)
    if len(values) > MAX_INCLUDE or any(not isinstance(nid, str) or not nid or '\x00' in nid
                                         for nid in values):
        raise ValueError(f'include must contain at most {MAX_INCLUDE} nonempty IDs')
    try:
        for nid in values:
            nid.encode('utf-8')
    except UnicodeError as error:
        raise ValueError('invalid reference identity') from error
    wanted = tuple(dict.fromkeys(values))
    with _snapshot(slug) as (raw, stamp):
        rows = raw.execute(
            "SELECT wanted.id,n.id,i.id,i.meta->>'model',i.meta->>'state',"
            "i.meta->'generation',i.meta->>'successor' "
            'FROM unnest(%s::text[]) wanted(id) '
            'LEFT JOIN nodes n ON n.id=wanted.id '
            'LEFT JOIN node_index i ON i.id=wanted.id', (list(wanted),)).fetchall()
        references = {}
        for nid, node_id, index_id, model, state, generation, successor in rows:
            if node_id != index_id:
                raise LedgerError('foreground reference index and nodes disagree')
            if node_id is not None:
                references[nid] = {'id': nid, 'tier': model or None,
                    'state': state, 'generation': generation,
                    'axis': 'lineage' if state == 'archived' and successor else 'org',
                    'successor': successor or None}
        result = {'stamp': stamp, 'references': references,
                  'missing': [nid for nid in wanted if nid not in references]}
        return _project(raw, result, project)


def read_retired_children(slug: str, parent: str = '', *, limit: int = 50,
                          cursor: str | None = None, edge: str | None = None,
                          project: Projector | None = None) -> Any:
    limit = _limit(limit)
    if edge not in (None, 'last'):
        raise ValueError('unknown retired child edge')
    if edge == 'last' and (limit != 1 or cursor is not None):
        raise ValueError('last retired child requires limit=1 and no cursor')
    with _snapshot(slug) as (raw, stamp):
        after = _after(cursor, stamp, 'children', parent)
        params: list = [parent]
        suffix = ''
        if after is not None:
            after = _child_order(after)
            suffix = " AND ((meta->>'order')::numeric,meta->>'created',ord,id)>(%s::numeric,%s,%s,%s)"
            params.extend(after)
        # A retired pile defaults to its last canonical sibling. Reading the
        # same child index backward avoids walking every ascending page.
        order = (("(meta->>'order')::numeric DESC,meta->>'created' DESC,ord DESC,id DESC")
                 if edge == 'last' else "(meta->>'order')::numeric,meta->>'created',ord,id")
        params.append(1 if edge == 'last' else limit + 1)
        page = raw.execute(
            "SELECT id,meta->>'order',meta->>'created',ord FROM node_index "
            "WHERE meta->>'parent'=%s AND meta->>'state'='archived' AND meta->>'successor'=''" +
            suffix + " ORDER BY " + order + " LIMIT %s",
            params).fetchall()
        more, page = len(page) > limit, page[:limit]
        result = _graph(raw, stamp, [row[0] for row in page])
        result['matches'] = [row[0] for row in page]
        result['next_cursor'] = (_cursor(stamp, 'children', parent,
            [page[-1][1], page[-1][2], page[-1][3], page[-1][0]]) if more else None)
        return _project(raw, result, project)


def search(slug: str, query: str, *, state: str | None = None, limit: int = 50,
           cursor: str | None = None, project: Projector | None = None) -> Any:
    limit = _limit(limit)
    query = query.strip().lower()
    if not query or len(query) > 256:
        raise ValueError('search needs 1 to 256 characters')
    if state not in (None, 'live', 'archived', 'unrecoverable'):
        raise ValueError('unknown state filter')
    filters = [query, state]
    with _snapshot(slug) as (raw, stamp):
        after = _after(cursor, stamp, 'search', filters)
        if after is not None and not isinstance(after, str):
            raise ValueError('invalid search cursor')
        page = raw.execute(
            'SELECT id FROM node_index '
            'WHERE public.orgtree_id_grams(id) @> public.orgtree_id_grams(%s) '
            'AND strpos(lower(id),%s)>0 '
            "AND NOT(meta->>'state'='archived' AND meta->>'successor'<>'') "
            "AND (%s::text IS NULL OR meta->>'state'=%s) "
            'AND (%s::text IS NULL OR id COLLATE "C">%s COLLATE "C") '
            'ORDER BY id COLLATE "C" LIMIT %s',
            (query, query, state, state, after, after, limit + 1)).fetchall()
        more, page = len(page) > limit, page[:limit]
        result = _graph(raw, stamp, [row[0] for row in page])
        result['matches'] = [row[0] for row in page]
        result['next_cursor'] = _cursor(stamp, 'search', filters, page[-1][0]) if more else None
        return _project(raw, result, project)


def discover(slug: str, *, state: str = 'live', limit: int = 100,
             cursor: str | None = None) -> dict:
    """Bounded scheduler identity pages, with no transcript/node body load."""
    limit = _limit(limit)
    if state not in ('live', 'archived', 'unrecoverable'):
        raise ValueError('unknown discovery state')
    with _snapshot(slug) as (raw, stamp):
        after = _after(cursor, stamp, 'discovery', state)
        if after is not None and not isinstance(after, str):
            raise ValueError('invalid discovery cursor')
        page = raw.execute(
            "SELECT id,meta FROM node_index WHERE meta->>'state'=%s "
            'AND (%s::text IS NULL OR id COLLATE "C">%s COLLATE "C") '
            'ORDER BY id COLLATE "C" LIMIT %s', (state, after, after, limit + 1)).fetchall()
        more, page = len(page) > limit, page[:limit]
        names = ('state', 'model', 'generation', 'session_id', 'transcript_incarnation', 'reply_incarnation')
        return {'stamp': stamp, 'nodes': [{'id': nid, **{k: meta[k] for k in names}} for nid, meta in page],
                'next_cursor': _cursor(stamp, 'discovery', state, page[-1][0]) if more else None}
