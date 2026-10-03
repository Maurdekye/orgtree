"""Native A1 reads in one committed snapshot of an org's own database.

Queries select typed identities and windows. The shared exact decoder assembles
only selected records; legacy SQL and the whole-org compatibility view are not
used. Display normalization remains in the existing request-local contexts.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal
import json
from typing import Any

from . import codec, reader_rows as R, registry
from .mappers import agents as M
from .. import store
from ..ledger import ASK_HISTORY_KEEP, LedgerError


def _dicts(raw, sql, params=()):
    from psycopg.rows import dict_row   # noqa: PLC0415
    with raw.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def _hot(raw, where, params=()):
    """Small metadata from hot rows only; decode rare preserved misfits exactly."""
    rows = _dicts(raw, 'SELECT a.*,p.name AS parent_name,b.name AS predecessor_name,'
        's.name AS successor_name FROM orgtree.agents a '
        'LEFT JOIN orgtree.agents p ON p.id=a.parent_id '
        'LEFT JOIN orgtree.agents b ON b.id=a.predecessor_id '
        'LEFT JOIN orgtree.agents s ON s.id=a.successor_id WHERE NOT a.tombstone AND ' + where, params)
    children = codec.Children({}, M.AGENTS.layout())
    result = {}
    for row in rows:
        body = codec.decode(M.HOT, row, children, (row['id'],))
        for ref in M.REFS:
            if row[ref + '_id'] is not None:
                body[ref] = row[ref + '_name']
        result[row['name']] = (row['ord'], meta(body))
    return result


def meta(body):
    """The legacy foreground_meta semantics, after exact scalar decoding."""
    def text(key, default=''):
        value = body.get(key)
        if value is None:
            return default
        return value if isinstance(value, str) else json.dumps(value, separators=(',', ':'))
    def number(key):
        value = body.get(key)
        return value if type(value) in (int, float) else 0
    return {'parent': text('parent'), 'state': text('state', 'live'),
        'title': text('title'), 'model': text('model'), 'grant': body.get('grant'),
        'order': number('ui_order'), 'created': text('created'),
        'predecessor': text('predecessor'), 'successor': text('successor'),
        'generation': number('generation'), 'bearer_state': body.get('bearer_state'),
        'session_id': body.get('session_id'), 'transcript_incarnation': body.get('transcript_incarnation'),
        'reply_incarnation': body.get('reply_incarnation'), 'cost': number('cost_usd'),
        'cost_unknown': body.get('cost_usd_unknown', False)}


def stamp(raw, org_id, seq):
    row = raw.execute('SELECT r.rev,r.node_rev,r.catalog_rev,r.view_rev,'
        'i.org_uuid::text,i.incarnation::text FROM orgtree.org_revision r '
        'CROSS JOIN orgtree.org_identity i').fetchone()
    totals = raw.execute("SELECT count(*),count(*) FILTER (WHERE state='archived' "
        'AND successor_id IS NULL),coalesce(sum(cost_usd),0),'
        'count(*) FILTER (WHERE cost_usd_unknown) FROM orgtree.agents WHERE NOT tombstone').fetchone()
    if row is None:
        raise LedgerError('foreground revision is incomplete')
    cost = totals[2]
    unknown = totals[3]
    # Misfits remain exactly in extra; typed numeric values never parse JSON.
    # Read only candidate hot rows, then use the same meta/sum rule as legacy.
    for row_ in _dicts(raw, 'SELECT id,cost_usd,cost_usd_unknown,extra FROM orgtree.agents '
                       'WHERE NOT tombstone AND extra IS NOT NULL '
                       'AND (cost_usd IS NULL OR cost_usd_unknown IS NULL)'):
        extra = row_['extra'] or {}
        value = extra.get('cost_usd')
        if row_['cost_usd'] is None and type(value) in (int, float):
            cost += Decimal(str(value))
        unknown_value = extra.get('cost_usd_unknown')
        if row_['cost_usd_unknown'] is None and (unknown_value is True or
                (isinstance(unknown_value, str) and unknown_value == 'true')):
            unknown += 1
    return dict(org_id=org_id, org_revision=row[0], node_revision=row[1],
        catalog_revision=row[2], view_revision=row[3], org_uuid=row[4], incarnation=row[5],
        node_count=totals[0], retired_axis_count=totals[1], cost=str(cost), cost_unknown=unknown, seq=seq)


@contextmanager
def snapshot(slug):
    from ..foreground_store import OrgNotFound   # noqa: PLC0415
    slug = store._safe_slug(slug)
    found = registry.lookup(slug)
    if found is None or found[2] != 'active':
        raise OrgNotFound(f'no such org: {slug!r}')
    org_id, database, _, uuid = found
    raw = registry.checkout(slug, database, uuid)
    try:
        with store._snap_gate(slug):
            seq = store.org_seq(slug)
            raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            state = stamp(raw, org_id, seq)
        yield raw, state
    finally:
        if not raw.closed:
            raw.execute('ROLLBACK')
        registry.release(raw, database)


def ancestors(raw, ids):
    return [r[0] for r in raw.execute(
        'WITH RECURSIVE wanted(id,parent_id) AS ('
        'SELECT id,parent_id FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone UNION '
        'SELECT p.id,p.parent_id FROM orgtree.agents p JOIN wanted c ON p.id=c.parent_id '
        'WHERE NOT p.tombstone) SELECT a.name FROM wanted w JOIN orgtree.agents a ON a.id=w.id',
        (ids,)).fetchall()]


def rows(raw, ids):
    metadata = _hot(raw, 'a.name=ANY(%s)', (ids,))
    bodies = R.read_agents(raw, metadata, recent_turns_limit=8)
    chains = raw.execute(
        'WITH RECURSIVE chain(origin,id,depth,path) AS ('
        'SELECT a.id,p.id,1,ARRAY[a.id,p.id] FROM orgtree.agents a '
        'JOIN orgtree.agents p ON p.id=a.predecessor_id AND NOT p.tombstone '
        'WHERE a.name=ANY(%s) AND NOT a.tombstone AND a.id<>p.id UNION ALL '
        'SELECT c.origin,p.id,c.depth+1,c.path||p.id FROM chain c '
        'JOIN orgtree.agents a ON a.id=c.id JOIN orgtree.agents p ON p.id=a.predecessor_id '
        'WHERE NOT p.tombstone AND NOT p.id=ANY(c.path)) '
        'SELECT a.name,p.name,p.generation,p.state,p.bearer_state,c.depth '
        'FROM chain c JOIN orgtree.agents a ON a.id=c.origin JOIN orgtree.agents p ON p.id=c.id',
        (ids,)).fetchall()
    by_origin = {}
    for name, pred, generation, state, bearer, depth in chains:
        by_origin.setdefault(name, []).append((pred, generation or 0, state, bearer, depth))
    result = {}
    for name, (ordinal, value) in metadata.items():
        chain = by_origin.get(name, [])
        eligible = [c for c in chain if c[2]=='archived' and c[3]!='lost']
        predecessor = max(eligible, key=lambda c: (c[1], -c[4])) if eligible else None
        result[name] = dict(node=bodies[name], meta=value, ordinal=ordinal, lineage_count=len(chain),
            consultable_predecessor=({'id': predecessor[0], 'generation': predecessor[1]} if predecessor else None))
    return result


def retired_counts(raw, parents):
    return dict(raw.execute("SELECT coalesce(p.name,''),count(*) FROM orgtree.agents a "
        'LEFT JOIN orgtree.agents p ON p.id=a.parent_id WHERE NOT a.tombstone '
        "AND a.state='archived' AND a.successor_id IS NULL AND coalesce(p.name,'')=ANY(%s) "
        'GROUP BY p.name', (parents,)).fetchall())


def foreground_ids(raw):
    return [r[0] for r in raw.execute("SELECT name FROM orgtree.agents WHERE NOT tombstone "
        "AND coalesce(state,'live')<>'archived' ORDER BY ord,name").fetchall()]


def funding(raw):
    return [dict(id=name, parent=value['parent'], state=value['state'], model=value['model'],
                 grant=value['grant']) for name, (ordinal, value) in sorted(
        _hot(raw, "coalesce(a.state,'live')<>'archived'").items(), key=lambda pair: (pair[1][0],pair[0]))]


def child_page(raw, parent, limit, after=None, last=False):
    # Native typed index for normal order values; rare extra candidates are
    # decoded and merged before the keyset/limit so none is silently misordered.
    base = "NOT a.tombstone AND a.state='archived' AND a.successor_id IS NULL"
    parent_sql = (" AND a.parent_id IS NULL" if not parent else
        " AND a.parent_id=(SELECT id FROM orgtree.agents WHERE name=%s AND NOT tombstone)")
    params = [] if not parent else [parent]
    direction = ' DESC' if last else ''
    suffix = ''
    if after is not None:
        suffix = ' AND (coalesce(a.ui_order,0),coalesce(a.created_text,\'\'),a.ord,a.name)>(%s::numeric,%s,%s,%s)'
        params.extend(after)
    typed = raw.execute('SELECT a.name,coalesce(a.ui_order,0)::text,coalesce(a.created_text,\'\'),a.ord '
        'FROM orgtree.agents a WHERE ' + base + parent_sql + suffix +
        ' ORDER BY coalesce(a.ui_order,0)' + direction + ',coalesce(a.created_text,\'\')' + direction +
        ',a.ord' + direction + ',a.name' + direction + ' LIMIT %s', (*params, limit)).fetchall()
    candidates = {row[0]: row for row in typed}
    for name, (ordinal, value) in _hot(raw, base + parent_sql + ' AND a.extra IS NOT NULL',
                                      [] if not parent else [parent]).items():
        candidate = (name, str(value['order']), value['created'], ordinal)
        key = (Decimal(candidate[1]), candidate[2], ordinal, name)
        if after is None or key > (Decimal(after[0]), *after[1:]):
            candidates[name] = candidate
        else:
            candidates.pop(name, None)
    ordered = sorted(candidates.values(), key=lambda r: (Decimal(r[1]),r[2],r[3],r[0]), reverse=last)
    return ordered[:limit]


def pile_edges(raw, ids, fronts):
    from ..foreground_store import _visible_parents   # noqa: PLC0415
    selected, counts, extra, resolved = {}, {}, [], set()
    new = ancestors(raw, ids)
    while True:
        selected.update({name: dict(meta=value, ordinal=ordinal)
                         for name, (ordinal, value) in _hot(raw, 'a.name=ANY(%s)', (new,)).items()})
        wanted = [p for p in ['', *new] if p not in counts]
        counts.update({p: 0 for p in wanted})
        counts.update(retired_counts(raw, wanted))
        hidden = dict(counts)
        for row in selected.values():
            value = row['meta']
            if value['state']=='archived' and not value['successor']:
                hidden[value['parent']] -= 1
        parents = [p for p in _visible_parents(selected, hidden, fronts) if p not in resolved]
        if not parents:
            return extra
        resolved.update(parents)
        new = []
        for parent in parents:
            saved = selected.get(fronts.get(parent,''))
            last = saved is None or saved['meta']['state']!='archived' or bool(
                saved['meta']['successor']) or saved['meta']['parent']!=parent
            edges = child_page(raw,parent,1) + (child_page(raw,parent,1,last=True) if last else [])
            new.extend(r[0] for r in edges if r[0] not in selected)
        new = list(dict.fromkeys(new))
        extra.extend(new)


def references(raw, wanted):
    return {name: dict(id=name,tier=value['model'] or None,state=value['state'],
        generation=value['generation'],axis='lineage' if value['state']=='archived' and
        value['successor'] else 'org',successor=value['successor'] or None)
        for name, (ordinal, value) in _hot(raw,'a.name=ANY(%s)',(list(wanted),)).items()}


def search_page(raw, query, state, after, limit):
    return raw.execute('SELECT name FROM orgtree.agents WHERE NOT tombstone '
        'AND orgtree.agent_name_grams(name) @> orgtree.agent_name_grams(%s) '
        'AND strpos(lower(name),%s)>0 '
        "AND NOT(coalesce(state,'live')='archived' AND successor_id IS NOT NULL) "
        "AND (%s::text IS NULL OR coalesce(state,'live')=%s) "
        'AND (%s::text IS NULL OR name COLLATE "C">%s COLLATE "C") '
        'ORDER BY name COLLATE "C" LIMIT %s',(query,query,state,state,after,after,limit)).fetchall()


def discovery(raw, state, after, limit):
    ids = [row[0] for row in raw.execute("SELECT name FROM orgtree.agents WHERE NOT tombstone "
        "AND coalesce(state,'live')=%s AND (%s::text IS NULL OR name COLLATE \"C\">%s COLLATE \"C\") "
        'ORDER BY name COLLATE "C" LIMIT %s', (state,after,after,limit)).fetchall()]
    metadata = _hot(raw,'a.name=ANY(%s)',(ids,))
    return sorted(((name,value) for name, (ordinal,value) in metadata.items()), key=lambda pair: pair[0])[:limit]


def identity(raw, slug, nid):
    from ..identity_context import IdentityContext   # noqa: PLC0415
    from ..foreground_context import SETTINGS, CompatibilityRequired   # noqa: PLC0415
    settings = R.read_sections(raw,SETTINGS)
    if settings.get('slug')!=slug:
        raise CompatibilityRequired('organization identity changed')
    settings['audiences'] = [dict(grantee=nid,grantor=grantor) for grantor, in raw.execute(
        "SELECT DISTINCT grantor FROM orgtree.audience_grants WHERE grantee=%s AND grantor=ANY(%s)",
        (nid,['user','extern'])).fetchall()]
    names = [r[0] for r in raw.execute('WITH RECURSIVE wanted(id,parent_id) AS ('
        'SELECT id,parent_id FROM orgtree.agents WHERE NOT tombstone AND (name=%s OR id=('
        'SELECT predecessor_id FROM orgtree.agents WHERE name=%s AND NOT tombstone)) UNION '
        'SELECT p.id,p.parent_id FROM orgtree.agents p JOIN wanted c ON p.id=c.parent_id '
        'WHERE NOT p.tombstone) SELECT a.name FROM wanted w JOIN orgtree.agents a ON a.id=w.id',
        (nid,nid)).fetchall()]
    bodies = R.read_agents(raw,names)
    ordinals = dict(raw.execute('SELECT name,ord FROM orgtree.agents WHERE NOT tombstone AND name=ANY(%s)',
                               (names,)).fetchall())
    return IdentityContext(settings,[(name,ordinals[name],body) for name,body in bodies.items()],nid)


def card_windows(raw, ids, header=False):
    asks = {}
    for key in ('asks','credit_requests','scope_requests'):
        clock = "coalesce(resolved_at_text,at_text,'')" if key!='credit_requests' else "coalesce(at_text,'')"
        visible = " AND coalesce(status,'')<>'withdrawn'" if key!='asks' else ''
        picked = dict(raw.execute(f'SELECT id,ord FROM orgtree.{key} WHERE '
            "status IN ('open','pending') AND (%s OR node=ANY(%s))",(header,ids)).fetchall())
        if header:
            picked.update(raw.execute(f'SELECT id,ord FROM orgtree.{key} WHERE '
                "coalesce(status,'') NOT IN ('open','pending')" + visible +
                f' ORDER BY {clock} DESC,ord DESC LIMIT %s',(ASK_HISTORY_KEEP,)).fetchall())
        picked.update(raw.execute('SELECT q.id,q.ord FROM unnest(%s::text[]) selected(node) '
            f'CROSS JOIN LATERAL (SELECT id,ord FROM orgtree.{key} WHERE node=selected.node'+visible+
            f' ORDER BY {clock} DESC,ord LIMIT 1) q',(ids,)).fetchall())
        asks[key] = R.read_records(raw,key,sorted(picked,key=picked.__getitem__))
    documents = {nid: [] for nid in ids}
    counts = dict(raw.execute('SELECT node,count(*) FROM orgtree.documents WHERE node=ANY(%s) '
                              'GROUP BY node',(ids,)).fetchall())
    for nid,pid,title,at,fmt,ordinal in raw.execute('SELECT selected.node,q.public_id,q.title,q.at_text,q.format,q.ord '
        'FROM unnest(%s::text[]) selected(node) CROSS JOIN LATERAL ('
        'SELECT public_id,title,at_text,format,ord FROM orgtree.documents WHERE node=selected.node '
        'ORDER BY ord DESC LIMIT 10) q ORDER BY selected.node,q.ord',(ids,)).fetchall():
        documents[nid].append(dict(id=pid,title=title,at=at,format=fmt or 'markdown'))
    return dict(asks=asks,documents=documents,document_counts={nid: counts.get(nid,0) for nid in ids})


def inbox_window(raw):
    total = raw.execute('SELECT count(*) FROM orgtree.org_inbox').fetchone()[0]
    ids = [r[0] for r in raw.execute('SELECT id FROM orgtree.org_inbox ORDER BY ord DESC LIMIT 3').fetchall()]
    entries = R.read_records(raw,'org_inbox',reversed(ids))
    read = int(R.read_sections(raw,['org_inbox_read']).get('org_inbox_read') or 0)
    return dict(total=total,unread=max(0,total-read),entries=entries)
