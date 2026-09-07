"""Durable, authorized maintenance requests consumed by the native shell."""
import json
from pathlib import Path
import os
import threading
import uuid
from . import store, supervisor
from .ledger import LedgerError, now

_lock = threading.RLock()


def _path():
    return Path(store.DATA_ROOT) / 'desktop-maintenance.json'


def _read():
    try:
        return json.loads(_path().read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None


def _write(value):
    temporary = _path().with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temporary, _path())


def pending():
    with _lock:
        value = _read()
        return value if value and value.get('state') == 'pending' else None


def request(slug, nid, target='org', reason=None, *, action='restart', **kwargs):
    if target not in {'org','mailhub','both'} or action not in {'restart','update'}:
        raise LedgerError('invalid desktop maintenance target/action')
    with _lock:
        current = pending()
        if current:
            return {'armed':True, 'already_armed':True, 'maintenance':current}
        value = {'id':uuid.uuid4().hex, 'action':action, 'target':target,
                 'reason':str(reason or 'agent requested desktop maintenance')[:1000],
                 'by_org':slug, 'by_node':nid, 'at':now(), 'state':'pending'}
        _write(value)
        return {'armed':True, 'maintenance':value,
                'note':'Native shell performs maintenance only after engine and OS idle; all targets restart the managed engine, never V1 update scripts.'}


def prime(slug, nid, target, reason=None, deadline_minutes=None):
    if deadline_minutes is not None:
        raise LedgerError('Desktop maintenance never forces busy turns; omit deadline_minutes')
    return request(slug,nid,target,reason)


def cancel(slug, nid):
    with _lock:
        current = pending()
        if current:
            _write({**current,'state':'cancelled','cancelled_by':{'org':slug,'node':nid}})
        return {'cancelled':bool(current)}


def acknowledge(request_id, outcome='execute'):
    with _lock:
        current = pending()
        if not current or current['id'] != request_id:
            return {'accepted':False}
        if outcome == 'up-to-date' and current['action'] == 'update':
            _write({**current,'state':'up-to-date'})
            return {'accepted':True}
        if outcome != 'execute':
            return {'accepted':False}
        hold = supervisor._force_hold_take()
        if hold is None:
            return {'accepted':False}
        with supervisor._state_lock:
            busy = any(s.get('busy') or s.get('waiting') or s.get('queue')
                       for s in supervisor._state.values())
        if busy:
            supervisor._force_hold_settle(hold, release=True)
            return {'accepted':False}
        try:
            _write({**current,'state':'acknowledged'})
        except BaseException:
            supervisor._force_hold_settle(hold, release=True)
            raise
        return {'accepted':True}


def install():
    # Existing API dispatch retains org gates, actor audit and operation receipts.
    supervisor.launch_self_restart = request
    supervisor.arm_prime_restart = prime
    supervisor.cancel_prime_restart = cancel
    supervisor.primed_restart = pending
    supervisor.start_prime_restart_engine = lambda: None
