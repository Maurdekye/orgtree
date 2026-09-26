"""Durable import admission and explicit operator resolution of uncertainty."""
import contextlib
import uuid
from . import orgtx, supervisor
from .ledger import LedgerError, now

SETTLED = {'admitted', 'handled'}
# Touched only inside an org_tx that holds this slug's `desktop_import` row
# FOR UPDATE (keys are (slug, nid)); restart intentionally clears it.
_dispatching = set()

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
    # An ARCHIVED seat runs nothing, so its retained intent can never be
    # dispatched and no operator decision can ever settle it. Left open, one
    # such row pinned `recovery_pending` for the WHOLE org permanently — on
    # the user's own org it had stood since the 2026-09-08 import, two of the
    # three imported agents being archived — and everything that consults
    # that flag stayed switched off with it (user report 2026-09-14).
    for nid,row in records.items():
        if row['phase'] in SETTLED: continue
        node=org.nodes.get(nid)
        if node is not None and node.get('state')!='archived': continue
        row['phase']='handled'
        row['resolution']={'action':'mark-handled','by':'system','note':
            'the seat is archived and can never dispatch its retained import intent'}
    return records

def _settle(org):
    meta=org.d['desktop_import']
    pending=[r for r in meta.get('recovery_attempts',{}).values() if r['phase'] not in SETTLED]
    meta['recovery_pending']=bool(pending)
    meta['recovery_phase']=('uncertain' if any(r['phase'] in {'uncertain','dispatching'} for r in pending)
                            else 'held' if pending else 'resolved')

def _seats(d):
    meta=d.get('desktop_import') or {}
    return set(meta.get('active_nodes') or []) | set((meta.get('recovery_attempts') or {}).keys())

@contextlib.contextmanager
def _tx(slug, write_nodes=()):
    """PG-3f: one org_tx on the `desktop_import` section, with the imported
    seats' node rows FOR SHARE (their generation/session/state/inflight are
    the decision inputs) and `write_nodes` FOR UPDATE. Never DOC_LOCK.
    The seat list is read first; if it grew before the lock was taken the
    call refuses rather than decide on a seat it did not lock."""
    seats=_seats(orgtx.org_read(slug, sections=()).d)
    with orgtx.org_tx(slug, sections=['desktop_import'], nodes=list(write_nodes),
                      share_nodes=sorted(seats-set(write_nodes))) as tx:
        if not _seats(tx.d) <= seats|set(write_nodes):
            raise LedgerError('Recovery seats changed; refresh and retry')
        yield tx.org

def status(slug):
    with _tx(slug) as org:
        if not org.d.get('desktop_import'): return {'pending':False,'phase':'none','nodes':[]}
        rows=_records(org)
        result=[dict(row,phase='uncertain' if row['phase']=='dispatching' else row['phase']) for row in rows.values()]
        _settle(org)
        return {'pending':any(r['phase'] not in SETTLED for r in result),
                'phase':org.d['desktop_import'].get('recovery_phase','none'),'nodes':result}

def _result_phase(result):
    if not isinstance(result,dict): return 'uncertain'
    if any(result.get(k) for k in ('frozen','limit_locked','remote','deferred','parked','not_idle','error')): return 'held'
    return 'admitted' if result.get('accepted') is True else 'held'

@contextlib.contextmanager
def _claiming_tx(slug, key, write_nodes=()):
    """`_tx` whose body may claim `key` in `_dispatching` (the yielded
    `claim()`). The claim is taken under the row lock, so no other resolve can
    pass the check in between, and undone if the transaction does not commit:
    a failed COMMIT must not leave the seat 'currently executing' until
    restart (PG-3f review N5)."""
    claimed=[]
    def claim():
        if key not in _dispatching:
            _dispatching.add(key); claimed.append(key)
    try:
        with _tx(slug, write_nodes) as org:
            yield org, claim
    except BaseException:
        for k in claimed: _dispatching.discard(k)
        raise

def _observe(slug,nid,stage,result=None):
    with _claiming_tx(slug, (slug,nid)) as (org, claim):
        row=_records(org)[nid]
        if stage=='before':
            if row['phase'] not in {'not-dispatched','held'} or row['identity'] != _identity(org.node(nid)):
                raise LedgerError('Recovery identity or phase changed before admission')
            row['phase']='dispatching'
            claim()
        else:
            _dispatching.discard((slug,nid))
            row['phase']='uncertain' if stage=='error' else _result_phase(result)
            if row['identity'] != _identity(org.node(nid)):
                row['phase']='uncertain'
            row['result']=result if isinstance(result,dict) else {'outcome':'unknown'}
        _settle(org)

def resume_import(slug):
    with _tx(slug) as org:
        meta=org.d.get('desktop_import') or {}
        if not meta.get('recovery_pending'): return {'selected':[],'pending':[],'already_reconciled':True}
        rows=_records(org)
        if any(row['phase'] not in {'not-dispatched','held'} and row['phase'] not in SETTLED
               for row in rows.values()):
            raise RuntimeError('Previous recovery admission is uncertain; explicit operator resolution required')
        selected=list(rows); _settle(org)
    marked=supervisor.reconcile(slug,active_only=True,
        recovery_observer=lambda nid,stage,result=None: _observe(slug,nid,stage,result))
    with _tx(slug) as org:
        rows=_records(org); _settle(org)
        pending=[nid for nid,row in rows.items() if row['phase'] not in SETTLED]
    if pending: raise RuntimeError('Imported active work remains held or uncertain; recovery intent retained')
    return {'selected':selected,'pending':pending,'unrecoverable':marked}

def _peek(slug,nid):
    """The row as a read sees it (seeding included, never saved)."""
    return _records(orgtx.org_read(slug)).get(nid)

def resolve_import(slug,nodes,action,acknowledged,note=''):
    if action not in {'retry','continue','mark-handled'} or not acknowledged or not isinstance(nodes,list) or not nodes:
        raise LedgerError('Choose a recovery action and acknowledge possible duplicate work')
    if action=='continue' and not str(note).strip(): raise LedgerError('Reviewed continuation requires a note')
    results=[]
    for choice in nodes:
        nid=str(choice.get('node') or '') if isinstance(choice,dict) else ''
        try:
            with _claiming_tx(slug, (slug,nid), write_nodes=[nid] if nid else []) as (org, claim):
                row=_records(org).get(nid)
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
                intent=dict(row['intent']); org.node(nid).pop('inflight',None); _settle(org)
                if action!='mark-handled': claim()
            if action!='mark-handled':
                try:
                    outcome=supervisor.send_message(slug,nid,
                        '[IMPORT RECOVERY: operator requested continuation; reconcile uncertain prior effects.]\n\n'+str(intent.get('text') or ''),
                        view=str(intent.get('view') or intent.get('text') or ''))
                    _observe(slug,nid,'result',outcome)
                except Exception: _observe(slug,nid,'error')
            row=_peek(slug,nid)
            results.append({'node':nid,'attempt':row['attempt'],'phase':row['phase']})
        except LedgerError as exc:
            row=_peek(slug,nid) or {}
            results.append({'node':nid,'attempt':row.get('attempt'),
                            'phase':row.get('phase','missing'),'error':str(exc)})
    return {'pending':status(slug)['pending'],'results':results}
