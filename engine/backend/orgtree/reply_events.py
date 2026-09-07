"""Immutable reply snapshots: references never relocate to another event."""
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
from . import store


def _connect():
    path = Path(store.DATA_ROOT) / 'reply-events.sqlite3'
    connection = sqlite3.connect(path, timeout=15)
    connection.execute('CREATE TABLE IF NOT EXISTS events (org TEXT, agent TEXT, generation INTEGER, id TEXT, text TEXT, scope TEXT, PRIMARY KEY(org,agent,generation,id))')
    return connection


def remember(org, nid, source, kind, text, *, connection=None):
    generation = int(org.node(nid).get('generation') or 0)
    quote = str(text or '')[:4000]
    identity = json.dumps([incarnation(org, nid), str(source), kind, quote], ensure_ascii=False)
    eid = 'reply_' + hashlib.sha256(identity.encode()).hexdigest()
    owned = connection is None
    connection = connection or _connect()
    try:
        connection.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)',
                           (org.d['slug'], nid, generation, eid, quote, incarnation(org,nid)))
        if owned:
            connection.commit()
    finally:
        if owned:
            connection.close()
    return eid


def incarnation(org, nid):
    """Persist independent identity across rename/compaction, never recreation."""
    if org.d.get('reply_incarnation') and org.node(nid).get('reply_incarnation'):
        return org.d['reply_incarnation'] + ':' + org.node(nid)['reply_incarnation']
    with store.DOC_LOCK:
        persisted = Path(store.org_path(org.d['slug'])).exists()
        current = store.load_org(org.d['slug']) if persisted else org
        current.d.setdefault('reply_incarnation', uuid.uuid4().hex)
        current.node(nid).setdefault('reply_incarnation', uuid.uuid4().hex)
        if persisted:
            store.save_org(current)
        org.d['reply_incarnation'] = current.d['reply_incarnation']
        org.node(nid)['reply_incarnation'] = current.node(nid)['reply_incarnation']
    return org.d['reply_incarnation'] + ':' + org.node(nid)['reply_incarnation']


def lookup(slug, nid, generation, eid, scope):
    with _connect() as connection:
        row = connection.execute('SELECT text FROM events WHERE org=? AND agent=? AND generation=? AND id=? AND scope=?',
                                 (slug, nid, generation, eid, scope)).fetchone()
    connection.close()
    return row[0] if row is not None else None


def clear(org, nid):
    with _connect() as connection:
        deleted = connection.execute('DELETE FROM events WHERE org=? AND agent=?', (org.d['slug'],nid)).rowcount
    connection.close()
    org.node(nid)['reply_incarnation'] = uuid.uuid4().hex
    store.save_org(org)
    return deleted


def annotate(org, nid, chat):
    incarnation(org,nid)
    with _connect() as connection:
        result = _annotate(org, nid, chat, connection)
    connection.close()
    return result


def _annotate(org, nid, chat, connection):
    def save(source, kind, text):
        return remember(org, nid, source, kind, text, connection=connection)
    result = dict(chat)
    for field in ('messages', 'live', 'transient'):
        rows = []
        for original in chat.get(field) or []:
            row = dict(original)
            source = row.get('event_id')
            if source:
                if field == 'transient' and str(source).startswith('reply_'):
                    row['reply_quote'] = row.get('text') or ''
                    rows.append(row)
                    continue
                row['event_id'] = save(source, 'row', row.get('text') or row.get('body') or row.get('cmd_out'))
                if row.get('thinking') is not None:
                    row['thinking_event_id'] = save(source, 'thinking', row['thinking'])
                tools = []
                for index, original_tool in enumerate(row.get('tools') or []):
                    if not isinstance(original_tool, dict):
                        tools.append(original_tool)
                        continue
                    tool = dict(original_tool)
                    tool_source = str(source) + ':tool:' + str(tool.get('id') or index)
                    tool['event_id'] = save(tool_source, 'call',
                        str(tool.get('name') or '') + ' ' + str(tool.get('input') or tool.get('arg') or ''))
                    if 'result' in tool:
                        tool['result_event_id'] = save(tool_source, 'result', tool['result'])
                    tools.append(tool)
                row['tools'] = tools
            rows.append(row)
        result[field] = rows
    return result
