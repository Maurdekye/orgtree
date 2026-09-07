"""Durable import admission and explicit operator resolution of uncertainty."""
import uuid
from . import store, supervisor
from .ledger import LedgerError, now

SETTLED = {'admitted', 'handled'}
_dispatching = set()  # DOC_LOCK protected; restart intentionally clears it.

def _identity(node):
    return {'generation':int(node.get('generation') or 0), 'session_id':node.get('session_id')}

def _records(org):
    meta=org.d.setdefault('desktop_import', {})
    records=meta.setdefault('recovery_attempts', {})
    intents=meta.setdefault('recovery_intents', {})
    for nid in meta.get('active_nodes', []):
        if nid not in org.nodes or nid in records: continue
        intent=intents.get(nid) or org.nodes[nid].get('inflight')
        missing=not bool(intent)
        intent=intent or {'text':'','view':''}
        intents[nid]=dict(intent)
        records[nid]={'node':nid,'attempt':uuid.uuid4().hex,
            'phase':'uncertain' if missing or meta.get('recovery_phase') in {'admitting','uncertain'} else 'not-dispatched',
            'identity':_identity(org.node(nid)), 'intent':dict(intent), 'at':now()}
    return records

def _save(org):
    meta=org.d['desktop_import']
    pending=[r for r in meta.get('recovery_attempts',{}).values() if r['phase'] not in SETTLED]
    meta['recovery_pending']=bool(pending)
    meta['recovery_phase']=('uncertain' if any(r['phase'] in {'uncertain','dispatching'} for r in pending)
                            else 'held' if pending else 'resolved')
    store.save_org(org)

def status(slug):
    with store.DOC_LOCK:
        org=store.load_org(slug)
        if not org.d.get('desktop_import'): return {'pending':False,'phase':'none','nodes':[]}
        rows=_records(org)
        result=[dict(row,phase='uncertain' if row['phase']=='dispatching' else row['phase']) for row in rows.values()]
        store.save_org(org)
        return {'pending':any(r['phase'] not in SETTLED for r in result),
                'phase':org.d['desktop_import'].get('recovery_phase','none'),'nodes':result}

def _result_phase(result):
    if not isinstance(result,dict): return 'uncertain'
    if any(result.get(k) for k in ('frozen','limit_locked','remote','deferred','parked','not_idle','error')): return 'held'
    return 'admitted' if result.get('accepted') is True else 'held'

def _observe(slug,nid,stage,result=None):
    with store.DOC_LOCK:
        org=store.load_org(slug); row=_records(org)[nid]
        if stage=='before':
            if row['phase'] not in {'not-dispatched','held'} or row['identity'] != _identity(org.node(nid)):
                raise LedgerError('Recovery identity or phase changed before admission')
            row['phase']='dispatching'
            _dispatching.add((slug,nid))
        else:
            _dispatching.discard((slug,nid))
            row['phase']='uncertain' if stage=='error' else _result_phase(result)
            if row['identity'] != _identity(org.node(nid)):
                row['phase']='uncertain'
            row['result']=result if isinstance(result,dict) else {'outcome':'unknown'}
        _save(org)

def resume_import(slug):
    with store.DOC_LOCK:
        org=store.load_org(slug); meta=org.d.get('desktop_import') or {}
        if not meta.get('recovery_pending'): return {'selected':[],'pending':[],'already_reconciled':True}
        rows=_records(org)
        if any(row['phase'] not in {'not-dispatched','held'} for row in rows.values()):
            raise RuntimeError('Previous recovery admission is uncertain; explicit operator resolution required')
        selected=list(rows); _save(org)
    marked=supervisor.reconcile(slug,active_only=True,
        recovery_observer=lambda nid,stage,result=None: _observe(slug,nid,stage,result))
    with store.DOC_LOCK:
        org=store.load_org(slug); rows=_records(org); _save(org)
        pending=[nid for nid,row in rows.items() if row['phase'] not in SETTLED]
    if pending: raise RuntimeError('Imported active work remains held or uncertain; recovery intent retained')
    return {'selected':selected,'pending':pending,'unrecoverable':marked}

def resolve_import(slug,nodes,action,acknowledged,note=''):
    if action not in {'retry','continue','mark-handled'} or not acknowledged or not isinstance(nodes,list) or not nodes:
        raise LedgerError('Choose a recovery action and acknowledge possible duplicate work')
    if action=='continue' and not str(note).strip(): raise LedgerError('Reviewed continuation requires a note')
    results=[]
    for choice in nodes:
        nid=str(choice.get('node') or '') if isinstance(choice,dict) else ''
        try:
            with store.DOC_LOCK:
                org=store.load_org(slug); row=_records(org).get(nid)
                if not row: raise LedgerError('No retained recovery intent')
                key={'attempt':choice.get('attempt'),'phase':choice.get('expected_phase'),'action':action}
                if row.get('resolution_of')==key:
                    results.append({'node':nid,'attempt':row['attempt'],'phase':row['phase']}); continue
                expected='uncertain' if row['phase']=='dispatching' else row['phase']
                if choice.get('attempt')!=row['attempt'] or choice.get('expected_phase')!=expected:
                    raise LedgerError('Recovery attempt changed; refresh before acting')
                if row['identity']!=_identity(org.node(nid)): raise LedgerError('Agent generation or session changed')
                if (slug,nid) in _dispatching: raise LedgerError('Recovery admission is currently executing')
                st=supervisor.state(slug,nid)
                if st.get('busy') or st.get('waiting') or st.get('queue'): raise LedgerError('Agent is active or queued')
                if row['phase'] in SETTLED: raise LedgerError('Recovery is already settled')
                if action=='retry' and expected not in {'held','not-dispatched'}:
                    raise LedgerError('Unknown admission requires reviewed continuation')
                if action=='continue' and expected!='uncertain': raise LedgerError('Continuation applies only to uncertain admission')
                row.update(attempt=uuid.uuid4().hex,resolution_of=key,actor='user',note=str(note)[:4000],
                           phase='handled' if action=='mark-handled' else 'dispatching',at=now())
                intent=dict(row['intent']); org.node(nid).pop('inflight',None); _save(org)
                if action!='mark-handled': _dispatching.add((slug,nid))
            if action!='mark-handled':
                try:
                    outcome=supervisor.send_message(slug,nid,
                        '[IMPORT RECOVERY: operator requested continuation; reconcile uncertain prior effects.]\n\n'+str(intent.get('text') or ''),
                        view=str(intent.get('view') or intent.get('text') or ''))
                    _observe(slug,nid,'result',outcome)
                except Exception: _observe(slug,nid,'error')
            with store.DOC_LOCK:
                row=_records(store.load_org(slug))[nid]
                results.append({'node':nid,'attempt':row['attempt'],'phase':row['phase']})
        except LedgerError as exc:
            with store.DOC_LOCK:
                row=_records(store.load_org(slug)).get(nid,{})
            results.append({'node':nid,'attempt':row.get('attempt'),
                            'phase':row.get('phase','missing'),'error':str(exc)})
    return {'pending':status(slug)['pending'],'results':results}
