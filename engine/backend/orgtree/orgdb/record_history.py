"""Subscribed agent history: one generated union window and one snapshot."""
from __future__ import annotations

from . import codec, record_derivations as D
from .compat import rows as R
from .mappers import records as specs
from .record_registry import Registry, ScopeResult, WindowKind

WINDOW = D.Window('history_name', 80, (
    D.Stream('event_refs', 'r.ref', "'event:'||r.event_id", ('r.win_at', '0', 'r.event_id')),
    D.Stream('notice_log', 'r.win_node', "'notice:'||r.id", ('r.win_at', '1', 'r.id')),
))
TABLES = {section.key: section.t for section in specs.sections()
          if section.key in ('events', 'notice_log')}


def dependencies(base):
    result = dict(base)
    def add(table, *names):
        result[table] = D.Source((*result[table].names, *names))
    add('event_warnings', D.scope('history_event', 'r.events_id'))
    add('agents', D.scope('history_identity', 'r.id', changed=('name', 'tombstone')))
    return result


# event_refs capture already covers event insert/delete/update and both old/new
# names. Child warning edits need only fan out the body, never window membership.
BEFORE = """
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'history_name:'||r.ref,'event:'||r.event_id
    FROM orgtree.changes c JOIN orgtree.event_refs r
      ON r.event_id=substring(c.entity_id FROM length('history_event:')+1)::bigint
    WHERE c.xid=pg_current_xact_id() AND c.entity='~scope'
      AND c.entity_id LIKE 'history_event:%' ON CONFLICT DO NOTHING;
"""
AFTER = """
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'agent_history:'||a.id,c.entity_id
    FROM orgtree.changes c JOIN orgtree.agents a
      ON a.name=substring(c.entity FROM length('history_name:')+1) AND NOT a.tombstone
    WHERE c.xid=pg_current_xact_id() AND c.entity LIKE 'history_name:%'
    ON CONFLICT DO NOTHING;
"""


def validate(arguments):
    key = arguments.get('agent')
    if (set(arguments) != {'kind', 'agent'} or not isinstance(key,str)
            or not key.isascii() or not key.isdigit() or not 0 < int(key) < 2**63
            or str(int(key)) != key):
        raise ValueError('agent history requires a positive database ID')
    return arguments


def members(state, arguments):
    row = state.raw.execute('SELECT name FROM orgtree.agents WHERE id=%s AND NOT tombstone',
                            (int(arguments['agent']),)).fetchone()
    if row is None:
        return frozenset()
    streams = []
    for stream in WINDOW.streams:
        keys = ','.join(f'{value} AS k{i}' for i,value in enumerate(stream.order))
        streams.append(f'(SELECT {stream.id} AS id,{keys} FROM orgtree.{stream.table} r '
            f'WHERE ({stream.partition})::text=%s ORDER BY k0 DESC NULLS LAST,k1 DESC,k2 DESC '
            f'LIMIT {WINDOW.size})')
    rows = state.raw.execute('SELECT id FROM ('+' UNION ALL '.join(streams)+') q '
        'ORDER BY k0 DESC NULLS LAST,k1 DESC,k2 DESC LIMIT %s',
        (*((row[0],)*len(streams)),WINDOW.size))
    return frozenset(str(row[0]) for row in rows)


def bodies(state, ids):
    result = {}
    for kind, section in (('event','events'),('notice','notice_log')):
        keys = [int(key.partition(':')[2]) for key in ids if key.startswith(kind+':')]
        if not keys:
            continue
        table = TABLES[section]
        rows, children = R.fetch(state.raw,table,'id=ANY(%s::bigint[])',(keys,))
        for row in rows:
            value = codec.decode(table.spec,row,children,(row['id'],))
            if kind == 'event':
                body = dict(at=value['at'],kind=value['op'],actor=value['actor'],
                    detail={k:v if isinstance(v,(str,int,float)) else [str(x) for x in v]
                            for k,v in value.get('detail',{}).items()
                            if isinstance(v,(str,int,float,list))},
                    warnings=[str(w) for w in value.get('warnings') or []])
            else:
                from ..api import _row_out
                decoded = _row_out(value)
                body = dict(at=value['at'],kind='notice',actor='system',detail={'text':value['text']},
                    **{k:decoded[k] for k in ('ev','ev_raw','ev_error') if k in decoded})
            result[f'{kind}:{row["id"]}'] = body
    return result


def identity_changes(state, roots, selected):
    entities = {'agent_history:'+root for root in roots}
    return ScopeResult(replacements=frozenset(name for name,members in selected.items()
        if name != 'shared' and entities.intersection(members)))


def register(registry: Registry) -> Registry:
    registry.register_window(WindowKind('agent_history',validate,
        lambda state,args:'agent_history:'+args['agent'],members,bodies))
    registry.register_scope('history_identity',identity_changes)
    return registry
