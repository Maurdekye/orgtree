"""Native A1 reads in one committed snapshot of an org's own database.

Queries select typed identities and windows. The shared exact decoder assembles
only selected records; legacy SQL and the whole-org compatibility view are not
used. Display normalization remains in the existing request-local contexts.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal, localcontext
import json
from typing import Any

from . import codec, reader_rows as R, registry
from .mappers import agents as M
from .mappers.records import DOCUMENTS
from .. import store
from ..ledger import ASK_HISTORY_KEEP, EXTERN, USER, LedgerError

_AXIS = "coalesce((SELECT name FROM orgtree.agents s WHERE s.id=a.successor_id),'')=''"
_CREATED = 'orgtree.foreground_time(a.created,a.created_text)'
_RARE_AXIS = '(a.extra IS NOT NULL AND (a.parent_id IS NULL OR a.successor_id IS NULL))'
_RARE_SEARCH = '(a.extra IS NOT NULL AND (a.state IS NULL OR a.successor_id IS NULL))'
_DOCUMENT_META = codec.Spec('documents',tuple(f for f in DOCUMENTS.fields if f.key in ('id','title','at','format')))


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


def _json_text(value, *, nested=False):
    """PostgreSQL jsonb's text form for a preserved scalar or container.

    Metadata's old ->> projection uses spaces, UTF-8 key length/order and
    expanded decimal numbers. Decode rare values in Python, without casting
    JSON in a query or changing the exact record body.
    """
    if isinstance(value,str):
        return json.dumps(value,ensure_ascii=False) if nested else value
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if type(value) is int:
        return str(value)
    if type(value) is float:
        number=Decimal(repr(value))
        return format(abs(number) if not number else number,'f')
    if isinstance(value,list):
        return '['+', '.join(_json_text(v,nested=True) for v in value)+']'
    if isinstance(value,dict):
        keys=sorted(value,key=lambda k:(len(k.encode('utf-8')),k.encode('utf-8')))
        return '{'+', '.join(_json_text(k,nested=True)+': '+_json_text(value[k],nested=True)
                            for k in keys)+'}'
    raise TypeError('metadata is not a JSON value')


def meta(body):
    """The legacy foreground_meta semantics, after exact scalar decoding."""
    def text(key, default=''):
        value = body.get(key)
        if value is None:
            return default
        return _json_text(value)
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
    totals = raw.execute("SELECT count(*),count(*) FILTER (WHERE state='archived' AND " + _AXIS +
        '),coalesce(sum(cost_usd),0),count(*) FILTER (WHERE cost_usd_unknown) '
        'FROM orgtree.agents a WHERE NOT tombstone').fetchone()
    if row is None:
        raise LedgerError('foreground revision is incomplete')
    cost = totals[2]
    unknown = totals[3]
    retired = totals[1] - sum(bool(value['successor']) for ordinal,value in _hot(raw,
        "a.state='archived' AND a.extra IS NOT NULL AND a.successor_id IS NULL").values())
    # Misfits remain exactly in extra; typed numeric values never parse JSON.
    # Read only candidate hot rows, then use the same meta/sum rule as legacy.
    for row_ in _dicts(raw, 'SELECT id,cost_usd,cost_usd_unknown,extra FROM orgtree.agents '
                       'WHERE NOT tombstone AND extra IS NOT NULL '
                       'AND (cost_usd IS NULL OR cost_usd_unknown IS NULL)'):
        extra = row_['extra'] or {}
        value = extra.get('cost_usd')
        if row_['cost_usd'] is None and type(value) in (int, float):
            with localcontext() as arithmetic:
                arithmetic.prec=max(1000,len(cost.as_tuple().digits)+abs(cost.as_tuple().exponent)+2)
                cost += Decimal(str(value))
        unknown_value = extra.get('cost_usd_unknown')
        if row_['cost_usd_unknown'] is None and (unknown_value is True or
                (isinstance(unknown_value, str) and unknown_value == 'true')):
            unknown += 1
    return dict(org_id=org_id, org_revision=row[0], node_revision=row[1],
        catalog_revision=row[2], view_revision=row[3], org_uuid=row[4], incarnation=row[5],
        node_count=totals[0], retired_axis_count=retired, cost=str(cost), cost_unknown=unknown, seq=seq)


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


def _ref_closure(raw, ids, ref):
    """Indexed closure, extending only selected rare links after exact decoding.

    A preserved non-string reference has no typed FK, but its legacy text can
    still name an agent. Resolve that boundary with another named query. Both
    normal cycles and rare cycles are finite; missing names are attempted once.
    """
    assert ref in ('parent','predecessor')
    found, attempted = set(), set()
    pending = set(ids)
    while pending:
        attempted.update(pending)
        selected = raw.execute(
            f'WITH RECURSIVE wanted(id,ref_id) AS ('
            f'SELECT id,{ref}_id FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone UNION '
            f'SELECT p.id,p.{ref}_id FROM orgtree.agents p JOIN wanted c ON p.id=c.ref_id '
            'WHERE NOT p.tombstone) SELECT a.name,a.extra IS NOT NULL AND w.ref_id IS NULL '
            'FROM wanted w JOIN orgtree.agents a ON a.id=w.id', (list(pending),)).fetchall()
        found.update(name for name,rare in selected)
        rare = _hot(raw,'a.name=ANY(%s)',([name for name,rare in selected if rare],))
        pending = {value[ref] for ordinal,value in rare.values() if value[ref]} - found - attempted
    return list(found)


def ancestors(raw, ids):
    return _ref_closure(raw, ids, 'parent')


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
        'SELECT a.name,p.name,p.generation,p.state,p.bearer_state,c.depth,p.extra IS NOT NULL '
        'FROM chain c JOIN orgtree.agents a ON a.id=c.origin JOIN orgtree.agents p ON p.id=c.id',
        (ids,)).fetchall()
    by_origin = {}
    rare=_hot(raw,'a.name=ANY(%s)',(list({row[1] for row in chains if row[6]}),))
    for name, pred, generation, state, bearer, depth, has_extra in chains:
        if pred in rare:
            value=rare[pred][1]
            generation,state,bearer=value['generation'],value['state'],value['bearer_state']
        by_origin.setdefault(name, []).append((pred, generation or 0, state, bearer, depth))
    # Keep the normal recursive SQL path. Only an origin whose selected chain
    # reaches a preserved reference needs exact metadata and a Python walk.
    boundaries = _hot(raw,'a.name=ANY(%s) AND a.predecessor_id IS NULL AND a.extra IS NOT NULL',
                      (list(set(metadata) | {r[1] for r in chains}),))
    links = {name for name,(_,value) in boundaries.items() if value['predecessor']}
    affected = [name for name in metadata if name in links or
                any(c[0] in links for c in by_origin.get(name,[]))]
    if affected:
        exact = _hot(raw,'a.name=ANY(%s)',(_ref_closure(raw,affected,'predecessor'),))
        for name in affected:
            seen, chain, current = {name}, [], name
            while True:
                pred = exact[current][1]['predecessor']
                if pred not in exact or pred in seen:
                    break
                seen.add(pred)
                value = exact[pred][1]
                chain.append((pred,value['generation'],value['state'],value['bearer_state'],len(chain)+1))
                current = pred
            by_origin[name] = chain
    result = {}
    for name, (ordinal, value) in metadata.items():
        chain = by_origin.get(name, [])
        eligible = [c for c in chain if c[2]=='archived' and c[3]!='lost']
        predecessor = max(eligible, key=lambda c: (c[1], -c[4])) if eligible else None
        result[name] = dict(node=bodies[name], meta=value, ordinal=ordinal, lineage_count=len(chain),
            consultable_predecessor=({'id': predecessor[0], 'generation': predecessor[1]} if predecessor else None))
    return result


def retired_counts(raw, parents):
    result = dict(raw.execute("SELECT coalesce(p.name,''),count(*) FROM orgtree.agents a "
        'LEFT JOIN orgtree.agents p ON p.id=a.parent_id WHERE NOT a.tombstone '
        "AND a.state='archived' AND " + _AXIS + " AND coalesce(p.name,'')=ANY(%s) "
        'GROUP BY p.name', (parents,)).fetchall())
    candidates = raw.execute("SELECT a.name,coalesce(p.name,''),coalesce(s.name,'') "
        'FROM orgtree.agents a LEFT JOIN orgtree.agents p ON p.id=a.parent_id '
        'LEFT JOIN orgtree.agents s ON s.id=a.successor_id WHERE NOT a.tombstone '
        "AND a.state='archived' AND "+_RARE_AXIS).fetchall()
    metadata=_hot(raw,'a.name=ANY(%s)',([r[0] for r in candidates],))
    for name,parent,successor in candidates:
        value=metadata[name][1]
        if not successor and parent in parents:
            result[parent]=result.get(parent,0)-1
        if not value['successor'] and value['parent'] in parents:
            result[value['parent']]=result.get(value['parent'],0)+1
    return result


def live_count(raw):
    total=raw.execute("SELECT count(*) FROM orgtree.agents WHERE NOT tombstone "
                      "AND coalesce(state,'live')='live'").fetchone()[0]
    return total-sum(value['state']!='live' for ordinal,value in _hot(raw,
        'a.state IS NULL AND a.extra IS NOT NULL').values())


def summary_compatible(raw):
    # Match the existing legacy summary cost refusal: truthy non-numeric
    # costs need Org.cost_total's conversion, rather than the numeric stamp.
    for extra, in raw.execute('SELECT extra FROM orgtree.agents WHERE NOT tombstone '
                             'AND cost_usd IS NULL AND extra IS NOT NULL').fetchall():
        value=(extra or {}).get('cost_usd')
        if value and type(value) not in (int,float):
            return False
    return True


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
    base = "NOT a.tombstone AND a.state='archived' AND " + _AXIS
    parent_sql = (" AND coalesce((SELECT name FROM orgtree.agents p WHERE p.id=a.parent_id),'')=''" if not parent else
        " AND a.parent_id IN (SELECT id FROM orgtree.agents WHERE name=%s)")
    params = [] if not parent else [parent]
    direction = ' DESC' if last else ''
    suffix = ''
    if after is not None:
        suffix = ' AND (coalesce(a.ui_order,0),' + _CREATED + ',a.ord,a.name)>(%s::numeric,%s,%s,%s)'
        params.extend(after)
    typed = raw.execute('SELECT a.name,coalesce(a.ui_order,0)::text,' + _CREATED + ',a.ord '
        'FROM orgtree.agents a WHERE ' + base + parent_sql +
        ' AND a.ui_order IS NOT NULL AND a.created IS NOT NULL AND NOT '+_RARE_AXIS + suffix +
        ' ORDER BY coalesce(a.ui_order,0)' + direction + ',' + _CREATED + direction +
        ',a.ord' + direction + ',a.name' + direction + ' LIMIT %s', (*params, limit)).fetchall()
    candidates = {row[0]: row for row in typed}
    rare="a.state='archived' AND ("+_RARE_AXIS+' OR ((a.ui_order IS NULL OR a.created IS NULL) AND '+_AXIS+parent_sql+'))'
    for name, (ordinal, value) in _hot(raw, rare,
                                      [] if not parent else [parent]).items():
        if value['successor'] or value['parent']!=parent:
            continue
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
    match='orgtree.agent_name_grams(a.name) @> orgtree.agent_name_grams(%s) '+\
        'AND strpos(lower(a.name),%s)>0 '
    match+='AND (%s::text IS NULL OR a.name COLLATE "C">%s COLLATE "C") '
    found=raw.execute('SELECT a.name FROM orgtree.agents a WHERE NOT tombstone AND '+match+
        'AND NOT '+_RARE_SEARCH+' '+
        "AND NOT(coalesce(state,'live')='archived' AND NOT(" + _AXIS + ")) "
        "AND (%s::text IS NULL OR coalesce(state,'live')=%s) "
        'ORDER BY name COLLATE "C" LIMIT %s',(query,query,after,after,state,state,limit)).fetchall()
    names={row[0] for row in found}
    for name,(ordinal,value) in _hot(raw,match+'AND '+_RARE_SEARCH,(query,query,after,after)).items():
        if (state is None or value['state']==state) and not(value['state']=='archived' and value['successor']):
            names.add(name)
    return [(name,) for name in sorted(names)[:limit]]


def discovery(raw, state, after, limit):
    ids = [row[0] for row in raw.execute("SELECT name FROM orgtree.agents a WHERE NOT tombstone "
        "AND coalesce(state,'live')=%s AND (%s::text IS NULL OR name COLLATE \"C\">%s COLLATE \"C\") "
        'AND NOT(a.state IS NULL AND a.extra IS NOT NULL) '
        'ORDER BY name COLLATE "C" LIMIT %s', (state,after,after,limit)).fetchall()]
    metadata = _hot(raw,'a.name=ANY(%s)',(ids,))
    metadata.update({name:row for name,row in _hot(raw,
        'a.state IS NULL AND a.extra IS NOT NULL AND (%s::text IS NULL OR a.name COLLATE "C">%s COLLATE "C")',
        (after,after)).items() if row[1]['state']==state})
    return sorted(((name,value) for name, (ordinal,value) in metadata.items()), key=lambda pair: pair[0])[:limit]


def identity(raw, slug, nid):
    from ..identity_context import IdentityContext   # noqa: PLC0415
    from ..foreground_context import SETTINGS, CompatibilityRequired   # noqa: PLC0415
    settings = R.read_sections(raw,SETTINGS)
    if settings.get('slug')!=slug:
        raise CompatibilityRequired('organization identity changed')
    settings['audiences'] = [dict(grantee=nid,grantor=grantor) for grantor, in raw.execute(
        "SELECT DISTINCT grantor FROM orgtree.audience_grants WHERE grantee=%s AND grantor=ANY(%s)",
        (nid,[USER,EXTERN])).fetchall()]
    selected = _hot(raw,'a.name=%s',(nid,))
    predecessor = selected.get(nid,(0,{}))[1].get('predecessor')
    names = ancestors(raw,[nid]+([predecessor] if predecessor else []))
    bodies = R.read_agents(raw,names)
    ordinals = dict(raw.execute('SELECT name,ord FROM orgtree.agents WHERE NOT tombstone AND name=ANY(%s)',
                               (names,)).fetchall())
    return IdentityContext(settings,[(name,ordinals[name],body) for name,body in bodies.items()],nid)


def card_windows(raw, ids, header=False):
    asks = {}
    for key in ('asks','credit_requests','scope_requests'):
        clock = ('orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text)'
                 if key!='credit_requests' else 'orgtree.foreground_time(at,at_text)')
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
    for row in _dicts(raw,'SELECT selected.node AS owner,q.* '
        'FROM unnest(%s::text[]) selected(node) CROSS JOIN LATERAL ('
        'SELECT id,public_id,title,at,at_text,format,extra,ord FROM orgtree.documents WHERE node=selected.node '
        'ORDER BY ord DESC LIMIT 10) q ORDER BY selected.node,q.ord',(ids,)):
        body=codec.decode(_DOCUMENT_META,row,codec.Children({},{}),(row['id'],))
        fmt=body.get('format')
        if fmt is not None and not isinstance(fmt,str):
            fmt=_json_text(fmt)
        documents[row['owner']].append(dict(id=body.get('id'),title=body.get('title'),
            at=body.get('at'),format=fmt or 'markdown'))
    return dict(asks=asks,documents=documents,document_counts={nid: counts.get(nid,0) for nid in ids})


def inbox_window(raw):
    total = raw.execute('SELECT count(*) FROM orgtree.org_inbox').fetchone()[0]
    ids = [r[0] for r in raw.execute('SELECT id FROM orgtree.org_inbox ORDER BY ord DESC LIMIT 3').fetchall()]
    entries = R.read_records(raw,'org_inbox',reversed(ids))
    read = int(R.read_sections(raw,['org_inbox_read']).get('org_inbox_read') or 0)
    return dict(total=total,unread=max(0,total-read),entries=entries)
