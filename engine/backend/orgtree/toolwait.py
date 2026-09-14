"""Yield long managed calls without cancelling or repeating their effects.

The operation journal has its own SQLite lock: a tool holding DOC_LOCK must
not also prevent its HTTP caller from reaching the ten-second boundary.
Only the original worker executes the call. Recovery reports an unknown
outcome; it NEVER runs stored arguments (indeed none are stored here).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path

from . import ledger, maildrain, store
from .mcptool import MANAGED_WAIT_TOOLS as TOOLS

WAIT_S = 10.0
MAX_RUNNING = 8
MAX_PUBLISH_FAILURES = 8
MAX_PUBLISH_AGE_S = 3600
# Read/control/mail calls stay short and retain their existing response path.
# These operations can wait on processes, files, provider discovery or smoke runs.
_slots = threading.BoundedSemaphore(MAX_RUNNING)
_lock = threading.RLock()
_publish_lock = threading.Lock()
_live: dict[str, dict] = {}
_started = False
_cursor = 0


def _db():
    path = Path(store.DATA_ROOT) / 'tool-waits.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=2)
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS operations '
               '(id TEXT PRIMARY KEY, record TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS dead_letters '
               '(id TEXT PRIMARY KEY, record TEXT NOT NULL)')
    return db


def _save(row):
    with closing(_db()) as db, db:
        db.execute('INSERT OR REPLACE INTO operations VALUES (?, ?)',
                   (row['id'], json.dumps(row)))


def _delete(oid):
    with closing(_db()) as db, db:
        db.execute('DELETE FROM operations WHERE id=?', (oid,))


def records():
    with closing(_db()) as db:
        rows = [json.loads(r[0]) for r in db.execute(
            'SELECT record FROM operations ORDER BY rowid')]
    return rows


def dead_letters():
    """Retained diagnostic evidence, outside the active admission bound."""
    with closing(_db()) as db:
        return [json.loads(r[0]) for r in db.execute(
            'SELECT record FROM dead_letters ORDER BY rowid')]


def _dead_letter(row, reason):
    archived = dict(row, delivery_failure=reason, retired_at=time.time())
    # Keep the entire result before freeing its slot, in ONE transaction.
    with closing(_db()) as db, db:
        db.execute('INSERT OR REPLACE INTO dead_letters VALUES (?, ?)',
                   (row['id'], json.dumps(archived)))
        db.execute('DELETE FROM operations WHERE id=?', (row['id'],))
    print(f"[orgtree] managed tool {row['id']} for {row['org']}/{row['node']}: "
          f"{reason}; result retained in tool-waits.db dead_letters")


class _DestinationGone(Exception):
    pass


def tool_name(body):
    name = body.args.get('tool', '') if body.tool == 'orgtree_op_call' else body.tool
    return name if isinstance(name, str) else ''


def _destination(org, row):
    # seat_id survives compaction/session replacement and rename. A later hire
    # with the same spelling must never inherit this caller's private result.
    candidates = [(nid, n) for nid, n in org.nodes.items()
                  if n.get('seat_id') == row['seat'] and not n.get('successor')]
    return max(candidates, key=lambda p: int(p[1].get('generation', 0)))[0] if candidates else None


def _publish(row):
    """Bounded publication retries; permanently unavailable results retain evidence."""
    from . import halt, supervisor as sup
    with _publish_lock:
        # Use the current durable row, including any publication checkpoint.
        row = next((r for r in records() if r['id'] == row['id']), None)
        if row is None or row.get('retry_at', 0) > time.time():
            return
        try:
            with store.DOC_LOCK:
                org = store.load_org(row['org'])
                nid = _destination(org, row)
                if not nid:
                    raise _DestinationGone('recipient seat no longer exists')
                receipts = org.d.setdefault('tool_result_receipts', {})
                if not row.get('published'):
                    if row['id'] not in receipts:
                        body = (f"[ORGTREE TOOL RESULT {row['id']}]\n"
                                f"Tool: {row['tool']}\nState: {row['state']}\n"
                                + json.dumps(row['result'], ensure_ascii=False)
                                + '\nDo not repeat the original operation. This is its result, '
                                  'not a request to run it again.')
                        msg = org.post_mail(ledger.SYSTEM, nid, body)
                        receipts[row['id']] = msg['id']
                        maildrain.request(org, nid)
                        if halt.blocked(row['org'], nid):
                            maildrain.suspend(org, nid)
                        store.save_org(org)
                    # Checkpoint before removing the org marker. Recovery can
                    # now finish cleanup without recreating the message, even
                    # if the marker was cleared and the final delete failed.
                    row['published'] = True
                    _save(row)
                receipts.pop(row['id'], None)
                store.save_org(org)
                _delete(row['id'])
        except Exception as exc:
            gone = (isinstance(exc, _DestinationGone) or
                    isinstance(exc, ledger.LedgerError) and str(exc).startswith('no such org:'))
            now = time.time()
            row['publish_failures'] = int(row.get('publish_failures', 0)) + 1
            row.setdefault('first_publish_failure_at', now)
            if (gone or row['publish_failures'] >= MAX_PUBLISH_FAILURES or
                    now - row['first_publish_failure_at'] >= MAX_PUBLISH_AGE_S):
                _dead_letter(row, str(exc))
            else:
                row['retry_at'] = now + min(60, 2 ** row['publish_failures'])
                row['last_publish_error'] = str(exc)
                _save(row)
            return
        # Normal admission checks holds. The durable drain already owns a wake
        # if this immediate delivery attempt fails or the process exits here.
        sup.send_message(row['org'], nid, 'A managed tool result is ready.',
                         mail_ping=True)


def _finish(oid):
    with _lock:
        job = _live.get(oid)
        if not job or not job.get('finished') or job.get('publishing'):
            return
        row = job['row']
        row.update(state=job['state'], result=job['result'])
        if not job.get('persisted') or job.get('saved_yielded') != row['yielded']:
            _save(row)  # retry this write, never the operation
            job.update(persisted=True, saved_yielded=row['yielded'])
        job['ready'].set()
        publish = row['yielded']
        job['publishing'] = publish
    if publish:
        try:
            _publish(dict(row))
            with _lock:
                _live.pop(oid, None)
        finally:
            with _lock:
                job['publishing'] = False


def invoke(body, caller, run, *, wait_s=WAIT_S):
    """The authenticated route's managed-call adapter; execution gates stay in run."""
    from fastapi import HTTPException
    if not caller.get('seat_id'):
        raise HTTPException(409, 'caller has no durable seat identity; this call was not executed')
    if not _slots.acquire(blocking=False):
        raise HTTPException(503, 'managed tool capacity is full; this call was not executed')
    oid = uuid.uuid4().hex
    row = {'id': oid, 'org': body.org, 'node': body.node,
           'seat': caller['seat_id'], 'tool': tool_name(body),
           'at': time.time(), 'state': 'running', 'yielded': False}
    job = {'row': row, 'ready': threading.Event()}
    try:
        with _lock:
            if len(records()) >= 64:
                raise HTTPException(503, 'unresolved managed tool limit reached; this call was not executed')
            _save(row)  # no worker may execute before identity is durable
            _live[oid] = job

        def worker():
            try:
                from fastapi.encoders import jsonable_encoder
                result, state = jsonable_encoder(run()), 'completed'
            except HTTPException as exc:
                result, state = {'detail': exc.detail, 'status_code': exc.status_code}, 'refused'
            except BaseException as exc:
                result, state = {'error': str(exc), 'outcome': 'unknown',
                                 'instruction': 'Check the org before repeating any effect.'}, 'unknown'
            finally:
                _slots.release()
            with _lock:
                job.update(result=result, state=state, finished=True)
            try:
                _finish(oid)
            except Exception:
                pass  # the recovery thread retries result persistence/publication

        threading.Thread(target=worker, daemon=True,
                         name=f'tool-wait-{oid[:8]}').start()
    except Exception:
        with _lock:
            _live.pop(oid, None)
        try:
            _delete(oid)
        finally:
            _slots.release()
        raise
    job['ready'].wait(wait_s)
    with _lock:
        if job['ready'].is_set():
            _delete(oid)
            _live.pop(oid, None)
            if job['state'] == 'refused':
                raise HTTPException(job['result']['status_code'], job['result']['detail'])
            return job['result']
        row['yielded'] = True
        try:
            _save(row)
            job['saved_yielded'] = True
        except Exception:
            pass  # the pre-execution identity is durable; completion retries this flag
    return {'state': 'running', 'operation_id': oid,
            'status': 'The original tool operation is still running. This result creates '
                      'a safe mail-delivery boundary; it does not mean the operation completed. '
                      'Continue handling incoming mail. Its result will arrive automatically '
                      'as durable mail, even if this turn ends. Do not repeat the operation.'}


def sweep():
    """Bounded completion retry and restart recovery. No stored call is executed."""
    global _cursor
    with _lock:
        live = list(_live)
        offset = _cursor
        _cursor += 32
    if live:
        live = live[offset % len(live):] + live[:offset % len(live)]
    for oid in live[:32]:
        try:
            _finish(oid)
        except Exception:
            pass
    pending = records()
    if pending:
        pending = pending[offset % len(pending):] + pending[:offset % len(pending)]
    for row in pending[:32]:
        with _lock:
            if row['id'] in _live:
                continue
            # Recheck after obtaining the owner lock. A synchronous caller may
            # have retired this snapshot meanwhile; never resurrect its row.
            row = next((r for r in records() if r['id'] == row['id']), None)
            if row is None:
                continue
            if row['state'] == 'running':
                row.update(state='unknown', yielded=True, result={
                    'error': 'The backend restarted before the tool outcome was durably recorded.',
                    'instruction': 'The operation may have applied. It was NOT restarted. '
                                   'Inspect the org and its operation receipts before repeating it.'})
                _save(row)
            # A completed synchronous call does not require another mail copy.
            if not row['yielded']:
                _delete(row['id'])
                continue
        if row['yielded']:
            try:
                _publish(row)
            except Exception:
                pass


def start():
    global _started
    if _started:
        return
    _started = True
    from . import startup

    def recover():
        while not startup.recovery.cancelled.is_set():
            try:
                sweep()
            except Exception:
                pass
            startup.recovery.cancelled.wait(1)
    threading.Thread(target=recover, daemon=True, name='tool-result-recovery').start()
