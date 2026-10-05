"""Small native clock inputs on the publisher's explicit connection.

Request pools use existing per-node latest/open indexes and the indexed rare
metadata path. No historical request bodies, authored text, agent child lists
or org document are loaded. The calculators keep today's Python display rules.
"""
from __future__ import annotations

from . import agents, codec, reader_rows, record_time as T
from .mappers import agents as M
from .mappers.records import WATCHDOG_TOMBS


def _metadata(raw, spec, identity, where='true', params=(), *, extra_keys=None):
    columns = ','.join('a.'+codec.quote(c) for c,_ in codec.columns(spec))
    rows = agents._dicts(raw, f'SELECT a.{identity} AS record_id,{columns},'
        '(SELECT json_object_agg(e.key,e.value) FROM json_each(a.extra) e '
        f'WHERE e.key=ANY(%s)) AS extra FROM orgtree.{spec.table} a WHERE '+where,
        ([f.key for f in spec.fields] if extra_keys is None else extra_keys,*params))
    return [(row['record_id'],codec.decode(spec,row,None)) for row in rows]


def _requests(raw, key, names):
    """Open batches plus one latest eligible row per node, including misfits."""
    clock = ('orgtree.foreground_request_time(resolved_at,resolved_at_text,at,at_text)'
             if key != 'credit_requests' else 'orgtree.foreground_time(at,at_text)')
    visible = " AND coalesce(status,'')<>'withdrawn'" if key != 'asks' else ''
    rare = agents._REQUEST_MISFITS
    picked = {rid for rid, in raw.execute(f'SELECT id FROM orgtree.{key} WHERE NOT '+rare+
        " AND status IN ('open','pending') AND node=ANY(%s)",(names,)).fetchall()}
    picked.update(rid for rid, in raw.execute(
        'SELECT q.id FROM unnest(%s::text[]) selected(node) CROSS JOIN LATERAL '
        f'(SELECT id FROM orgtree.{key} WHERE NOT '+rare+' AND node=selected.node'+visible+
        f' ORDER BY {clock} DESC,ord LIMIT 1) q',(names,)).fetchall())
    spec = agents._REQUEST_META[key]
    # The credit mapper has no resolved_at field, but old records can carry it
    # in extra. The existing exact metadata helper preserves that named value.
    selected = _metadata(raw,spec,'id',f'(a.id=ANY(%s) OR {rare}) ORDER BY a.ord',
                         (sorted(picked),),extra_keys=['node','status','at','resolved_at'])
    # Latest ties use original pool order, as node_ask does.
    return [body for key,body in selected
            if body.get('node') in names]


def boundaries(raw):
    # Identity name is a physical key beside HOT, not a HOT body field.
    hot = codec.Spec('agents',(codec.Field('name','text'),M.HOT.field('session_began_at')))
    nodes = _metadata(raw,hot,'id','NOT a.tombstone')
    ids = {body['name']:key for key,body in nodes}
    sessions = {body['name']:body.get('session_began_at') for key,body in nodes}
    requests = []
    for key,kind in (('asks','ask'),('credit_requests','credit'),('scope_requests','scope')):
        requests.extend(dict(body,kind=kind) for body in _requests(raw,key,list(ids)))
    candidates = T.asks(requests,ids,sessions)
    tomb = codec.Spec('watchdog_tombs',tuple(f for f in WATCHDOG_TOMBS.fields if f.key=='spent_at'))
    candidates.extend(T.tombs(body for key,body in _metadata(raw,tomb,'id')))
    frozen = codec.Spec('agent_runtime',tuple(f for f in M.RUNTIME.fields if f.key=='frozen'))
    candidates.extend(T.freezes((key,body.get('frozen')) for key,body in
        _metadata(raw,frozen,'agent_id','a.agent_id IN '
                  '(SELECT id FROM orgtree.agents WHERE NOT tombstone AND is_frozen)')))
    settings = reader_rows.read_sections(raw,('fable_lock',))
    candidates.extend(T.fable(settings.get('fable_lock')))
    deadlines = raw.execute(
        "SELECT i.id,i.docket_deadline FROM orgtree.work_items i WHERE i.list_key='active' "
        'AND i.docket_deadline IS NOT NULL AND NOT i.docket_manual AND NOT EXISTS '
        '(SELECT 1 FROM orgtree.docket_question_links q WHERE q.item_slug=i.slug)').fetchall()
    candidates.extend(T.docket((key,T.instant(at)) for key,at in deadlines))
    return candidates
