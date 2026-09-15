"""Retryable file snapshots, scoped by authenticated org and durable seat.

The filesystem rename commits the bytes; the SQLite receipt commits the reply.
A crash between them recovers the same path, never a second suffixed copy.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import threading
from contextlib import closing
from . import store
from .ledger import LedgerError

_lock = threading.Lock()


def snapshot(org, nid, args, *, max_bytes):
    from . import api, sandbox
    key = str(args.get('delivery_id') or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{16,128}', key):
        raise LedgerError('delivery_id must be 16-128 letters, digits, hyphens or underscores; reuse it only for this delivery')
    seat = org.node(nid).get('seat_id')
    if not seat:
        raise LedgerError('live seat identity is not initialized; reconnect through the authenticated agent gateway')
    raw = api._no_nul(str(args.get('path') or '')).strip()
    src, scratch, _, _ = api._node_reachable_file(org, nid, raw, verb='send')
    size = os.path.getsize(src)
    if not size or max_bytes is not None and size > max_bytes:
        raise LedgerError('file is empty or exceeds the direct-delivery size limit')
    if org.d.get('storage_blocked'):
        raise LedgerError('the org is over its storage limit; file delivery is paused')
    identity = hashlib.sha256(f'{org.d["slug"]}:{seat}:{key}'.encode()).hexdigest()
    fingerprint = json.dumps([os.path.normcase(src), str(args.get('note') or '')])
    outdir = Path(scratch) / 'outbox'
    safe = re.sub(r'[^\w .()+\-]', '_', Path(src).name).strip(' .') or 'file.bin'
    relative = f'delivery-{identity}/{safe}'
    target = outdir / relative
    with _lock:
        database = Path(store.DATA_ROOT) / 'file-deliveries.db'
        with closing(sqlite3.connect(database, timeout=10)) as db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)')
            row = db.execute('SELECT fingerprint,result FROM deliveries WHERE id=?', (identity,)).fetchone()
            if row and row[0] != fingerprint:
                raise LedgerError('delivery_id already belongs to a different file or caption; use a new ID for a new delivery')
            if not row:
                with db:
                    db.execute('INSERT INTO deliveries VALUES (?,?,NULL)', (identity, fingerprint))
            # Validate even a replay: neither changed grants nor a substituted
            # outbox symlink may bypass the existing containment boundary.
            resolved = os.path.realpath(target)
            if not os.path.normcase(resolved).startswith(os.path.normcase(os.path.realpath(scratch)).rstrip('\\/') + os.sep):
                raise LedgerError('delivery destination escapes the agent scratch folder')
            if row and row[1]:
                sent = json.loads(row[1])
                if not target.is_file() or _hash(target) != sent['sha256']:
                    raise LedgerError('delivered snapshot is missing or changed; inspect it and use a new delivery_id to send again')
                return sent
            target.parent.mkdir(parents=True, exist_ok=True)
            sandbox.chown_agent(org, nid)
            if not target.exists():
                temporary = target.with_name(target.name + '.part')
                # Exclusive creation refuses a link planted at the partial
                # filename. Unlink removes only our prior partial or its link.
                temporary.unlink(missing_ok=True)
                with open(src, 'rb') as source, open(temporary, 'xb') as dest:
                    shutil.copyfileobj(source, dest)
                    dest.flush()
                    os.fsync(dest.fileno())
                os.replace(temporary, target)
                sandbox.chown_agent(org, nid)
            sent = {'name': safe, 'path': 'outbox/' + relative,
                    'bytes': target.stat().st_size, 'delivery_id': identity,
                    'sha256': _hash(target)}
            with db:
                db.execute('UPDATE deliveries SET result=? WHERE id=?', (json.dumps(sent), identity))
            return sent


def _hash(path):
    with open(path, 'rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def unique_cards(payload):
    """One visible card per delivery in a chat window, including replay results."""
    seen = set()
    messages = []
    for message in payload.get('messages', []):
        tools = []
        for tool in message.get('tools', []):
            if not isinstance(tool, dict):
                tools.append(tool)
                continue
            item = dict(tool)
            key = (item.get('file') or {}).get('delivery_id')
            if key and key in seen:
                item.pop('file', None)
            if key:
                seen.add(key)
            tools.append(item)
        messages.append({**message, 'tools': tools})
    return {**payload, 'messages': messages}
