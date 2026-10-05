"""Mailbox snapshot readers, preserving the compatibility endpoint's ordering.

The record envelope carries folder/order information; ``mail`` is the endpoint
row. Delivery stages are supplied later by the ordered host runtime overlay.
"""
from __future__ import annotations

from . import codec
from .compat import rows as R, sql as C
from .mappers import records as specs
from .record_history import validate
from .record_registry import Registry, WindowKind, ScopeResult

KEEP = 50
TABLES = {section.key:section.t for section in specs.sections()
          if section.key in ('mail','delivering','mail_log','user_inbox','user_mail_log')}


def decoded(state, section, where, params, *, order='id', limit=None):
    table = TABLES[section]
    rows, children = R.fetch(state.raw,table,where,params,order=order,limit=limit)
    return [(row,codec.decode(table.spec,row,children,(row['id'],))) for row in rows]


def delivery_rows(batch):
    """The durable part of supervisor.delivering_rows; no memory read in a snapshot."""
    turn = batch.get('via','steer') == 'turn'
    delivery = dict(mode=str(batch.get('mode') or batch.get('via') or 'steer'),
        via='turn' if turn else 'steer', attempt=int(batch.get('attempt') or 1),
        at=str(batch.get('at') or ''))
    return [{**mail,'delivering':True,'delivery':delivery,**({'via':'turn'} if turn else {})}
            for mail in batch.get('mail') or []]


def select(state, aid):
    cache_key = 'mailbox:'+aid
    if cache_key in state.cache:
        return state.cache[cache_key]
    found = state.raw.execute('SELECT name FROM orgtree.agents WHERE id=%s AND NOT tombstone',
                              (int(aid),)).fetchone()
    if found is None:
        result = ({},[])
        state.cache[cache_key] = result
        return result
    name = found[0]
    from ..api import _mail_refs, _sent_refs
    result = {}
    waiting = []
    batches = decoded(state,'delivering','agent_id=%s',(int(aid),),order='idx')
    for source,batch in batches:
        for index,mail in enumerate(delivery_rows(batch)):
            waiting.append(mail)
            result[f'pending:delivery:{source["id"]}:{index}'] = dict(folder='pending',
                order=[mail.get('at') or '',0,source['idx'],index],
                mail=_mail_refs(state.slug,'node',[mail],name)[0],batch=str(batch.get('tok') or ''))
    for source,mail in decoded(state,'mail','agent_id=%s',(int(aid),),order='idx'):
        waiting.append(mail)
        result[f'pending:mail:{source["id"]}'] = dict(folder='pending',
            order=[mail.get('at') or '',1,source['idx']],
            mail=_mail_refs(state.slug,'node',[mail],name)[0])
    pending_keys = {(m['at'],m['from'],m['body']) for m in waiting}
    cap = KEEP+40+len(waiting)  # exactly store._mail_tails' duplicate allowance
    delivered = [(source,mail) for source,mail in decoded(state,'mail_log',
        'agent_id=%s',(int(aid),),order='idx DESC',limit=cap)
        if (mail['at'],mail['from'],mail['body']) not in pending_keys][:KEEP]
    for source,mail in delivered:
        result[f'delivered:mail_log:{source["id"]}'] = dict(folder='delivered',
            order=[source['idx']],mail=_mail_refs(state.slug,'node',[mail],name)[0])
    ids = C._sent_ids(state.raw,'orgtree.mail_log',name,KEEP)
    sent = []
    if ids:
        owners = {int(owner):(recipient,int(first)) for owner,recipient,first in state.raw.execute(
            'SELECT a.id,a.name,f.id FROM orgtree.agents a CROSS JOIN LATERAL '
            '(SELECT id FROM orgtree.mail_log WHERE agent_id>=a.id ORDER BY agent_id,id LIMIT 1) f '
            'WHERE a.id IN (SELECT agent_id FROM orgtree.mail_log WHERE id=ANY(%s::bigint[]))',(ids,))}
        for source,mail in decoded(state,'mail_log','id=ANY(%s::bigint[])',(ids,)):
            recipient,first = owners[source['agent_id']]
            sent.append((f'sent:mail_log:{source["id"]}',dict(folder='sent',
                order=[mail.get('at') or '',0,str(first).zfill(20),str(source['id']).zfill(20)],
                mail=_sent_refs(state.slug,[{**mail,'to':recipient}])[0])))
    # User pending is a state set. Its authored list order breaks timestamp
    # ties before the user's delivered log, just as the existing endpoint.
    for section,group in (('user_inbox',1),('user_mail_log',2)):
        if section == 'user_inbox':
            rows = decoded(state,section,'true',(),order='id')
            rows = [(source,mail) for source,mail in rows if mail.get('from') == name]
        else:
            ids = C._window_ids(state.raw,section,'win_from',name,KEEP)
            rows = decoded(state,section,'id=ANY(%s::bigint[])',(ids,)) if ids else []
        for source,mail in rows:
            sent.append((f'sent:{section}:{source["id"]}',dict(folder='sent',
                order=[mail.get('at') or '',group,str(source['id']).zfill(20)],
                mail=_sent_refs(state.slug,[{**mail,'to':'@user'}])[0])))
    result.update(sorted(sent,key=lambda pair:pair[1]['order'])[-KEEP:])
    answer = (result,[batch for _,batch in batches])
    state.cache[cache_key] = answer
    return answer


def members(state, args):
    return frozenset(select(state,args['agent'])[0])


def bodies(state, ids):
    # Body IDs are scoped by an entity, but the generic builder receives only
    # IDs. Include the agent in each ID so two overlapping subscriptions cannot
    # mistake the same Sent source for the recipient's Delivered record.
    result = {}
    groups = {}
    for key in ids:
        aid,_,local = key.partition('/')
        groups.setdefault(aid,[]).append((key,local))
    for aid,keys in groups.items():
        selected,_ = select(state,aid)
        result.update((key,selected[local]) for key,local in keys if local in selected)
    return result


def register(registry: Registry) -> Registry:
    registry.register_scope('mail_identity', lambda state,roots,selected: ScopeResult(
        replacements=frozenset(name for name,entities in selected.items() if name != 'shared'
            and {'agent_mail:'+root for root in roots}.intersection(entities))))
    registry.register_window(WindowKind('agent_mail',validate,
        lambda state,args:'agent_mail:'+args['agent'],
        lambda state,args:frozenset(args['agent']+'/'+key for key in members(state,args)),bodies))
    return registry
