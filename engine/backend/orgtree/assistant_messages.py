"""Identity and retained snapshots for assistant prose, independent of reply quotes.

An id names a provider text occurrence, never its words or arrival time. Native
records and streamed snapshots use the same id. A record containing several
text blocks owns all their ids; its first block keeps the row's position.
"""
from __future__ import annotations

import json
import threading
import uuid

from . import transcript_records


def scope(org, nid, *, session_id=None):
    return json.dumps([transcript_records.incarnation(org, nid),
                       session_id or org.node(nid).get('session_id')], separators=(',', ':'))


def identity(source: str, provider: str, item: str, part=0) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL,
        json.dumps([source, provider, item, part], separators=(',', ':'))))


def native_scope(source, epoch):
    return source if not epoch else f'{source}:native:{epoch}'


def current_native_scope(org, nid):
    from .chat_window import source_key
    with transcript_records.database() as conn:
        row = conn.execute('SELECT epoch FROM transcript_sources WHERE source=?',
                           (source_key(org, nid),)).fetchone()
    return native_scope(scope(org, nid), row[0] if row else 0)


def ids(row):
    aliases = row.get('assistant_ids')
    aliases = aliases if isinstance(aliases, list) else []
    return list(dict.fromkeys(x for x in
        [row.get('assistant_id'), *aliases]
        if isinstance(x, str) and x))


def record_ids(source, record, counts, known):
    """Assign text-block occurrences in native record order.

    Claude can write several records with one message.id. The text ordinal,
    including empty text blocks, distinguishes them; a repeated record uuid
    reuses its assignment. Owned journals carry the assignment explicitly.
    """
    explicit = ids(record)
    if explicit:
        return explicit
    rid = record.get('uuid')
    record_key = (source, rid)
    # JSON-cache-safe keys: the incremental parser persists these maps.
    record_key = json.dumps(record_key)
    if rid and record_key in known:
        return known[record_key]
    message = record.get('message') or {}
    message = message if isinstance(message, dict) else {}
    mid = message.get('id')
    count_key = json.dumps([source, mid])
    content = message.get('content')
    blocks = content if isinstance(content, list) else []
    result = []
    for block in blocks:
        if not isinstance(block, dict) or block.get('type') != 'text':
            continue
        part = counts.get(count_key, 0)
        if mid:
            counts[count_key] = part + 1
        if str(block.get('text') or '').strip():
            if mid:
                result.append(identity(source, 'claude', str(mid), part))
            elif rid:
                result.append(identity(source, 'record', str(rid)))
    if not result and isinstance(content, str) and content.strip() and rid:
        result = [identity(source, 'record', str(rid))]
    if rid:
        known[record_key] = result
    return result


class ClaudeIdentity:
    """Pair text deltas and assistant frames using provider message/block identity."""
    def __init__(self, source):
        self.source = source
        self.message = uuid.uuid4().hex
        self.part = 0
        self.active = None
        self.counts = {}
        self.known = {}

    def event(self, event):
        if event.get('type') == 'message_start':
            self.message = str((event.get('message') or {}).get('id') or uuid.uuid4())
            self.part = 0
            self.active = None
        if event.get('type') == 'content_block_start':
            self.active = None
            if (event.get('content_block') or {}).get('type') == 'text':
                self.active = identity(self.source, 'claude', self.message, self.part)
                self.part += 1
        return self.active

    def frame(self, record):
        return record_ids(self.source, record, self.counts, self.known)


class TextBatcher:
    """Batch text without losing the item that owns each fragment."""
    def __init__(self, emit):
        self.emit = emit
        self.lock = threading.RLock()
        self.pending = []
        self.timer = None
        self.size = 0

    def add(self, text, mid):
        with self.lock:
            self.pending.append((mid, text))
            self.size += len(text)
            if self.size >= 400:
                self.flush()
            elif self.timer is None:
                self.timer = threading.Timer(.12, self.flush)
                self.timer.daemon = True
                self.timer.start()

    def flush(self):
        # Extraction and emission are ordered against completion. The final
        # callback cannot overtake a timer that has already taken its text.
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.timer = None
            pending, self.pending = self.pending, []
            self.size = 0
            groups = []
            for mid, text in pending:
                if groups and groups[-1][0] == mid:
                    groups[-1][1] += text
                else:
                    groups.append([mid, text])
            for mid, text in groups:
                for start in range(0, len(text), 2000):
                    self.emit(mid, text[start:start + 2000])


def observe(source: str, mid: str, text: str, at: str, *, complete=False,
            append=False, native_id=None, owned=None):
    """Commit a revision before publishing it. Completion is monotonic.

    Late deltas cannot reopen a completed message. Provider adapters suppress
    duplicate native events before append; transport carries full snapshots,
    so websocket retries and reversed deliveries never append text twice.
    """
    with transcript_records.database() as conn:
        conn.execute('BEGIN IMMEDIATE')
        found = conn.execute('SELECT body,ordinal,materialized FROM assistant_messages WHERE scope=? AND id=?',
                             (source, mid)).fetchone()
        prior = json.loads(found[0]) if found else None
        if prior:
            prior['assistant_order'] = found[1]
            if found[2]:
                prior['assistant_materialized'] = True
        if prior and prior['assistant_state'] == 'complete':
            return prior
        body = (str(prior['text']) if prior and append else '') + text
        row = {'role': 'assistant', 'text': body,
               'ts': prior['ts'] if prior else at,
               'assistant_id': mid, 'assistant_ids': owned or [mid],
               'assistant_scope': source,
               'row_id': mid, 'event_id': mid,
               'assistant_revision': (prior['assistant_revision'] if prior else 0) + 1,
               'assistant_state': 'complete' if complete else 'partial',
               'assistant_pending': True}
        if native_id:
            row['native_event_id'] = native_id
        conn.execute('INSERT INTO assistant_messages(scope,id,body) VALUES (?,?,?) '
                     'ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body',
                     (source, mid, json.dumps(row, ensure_ascii=False)))
        conn.execute('UPDATE assistant_messages SET materialized=1 WHERE scope=? AND id=? '
                     'AND EXISTS(SELECT 1 FROM assistant_receipts WHERE scope=? AND id=?)',
                     (source, mid, source, mid))
        if complete and owned:
            conn.executemany('UPDATE assistant_messages SET materialized=1 WHERE scope=? AND id=?',
                             ((source, other) for other in owned if other != mid))
        row['assistant_order'] = conn.execute(
            'SELECT ordinal FROM assistant_messages WHERE scope=? AND id=?', (source, mid)).fetchone()[0]
        if conn.execute('SELECT 1 FROM assistant_receipts WHERE scope=? AND id=?',
                        (source, mid)).fetchone():
            row['assistant_materialized'] = True
        return row


def reconcile(source: str, rows: list[dict], *, include_pending=True):
    """Replace retained snapshots only with their native records, atomically.

    The record itself is the receipt. A turn ending, a newer timestamp or equal
    words are never receipts. Materialized receipts survive paging/restarts.
    """
    with transcript_records.database() as conn:
        pending = {mid: {**json.loads(body), 'assistant_order': ordinal} for mid, body, ordinal in conn.execute(
            'SELECT id,body,ordinal FROM assistant_messages WHERE scope=? AND materialized=0 '
            'ORDER BY ordinal', (source,))}
        anchors = {}
        received = set()
        wanted = list(dict.fromkeys(mid for row in rows for mid in ids(row)))
        for start in range(0, len(wanted), 400):
            chunk = wanted[start:start + 400]
            marks = ','.join('?' for _ in chunk)
            for mid, at, ordinal in conn.execute(
                f"SELECT id,json_extract(body,'$.ts'),ordinal FROM assistant_messages WHERE scope=? AND id IN ({marks})",
                    (source, *chunk)):
                anchors[mid] = (at, ordinal)
            received.update(mid for mid, in conn.execute(
                f'SELECT id FROM assistant_receipts WHERE scope=? AND id IN ({marks})',
                (source, *chunk)))
        claimed = set()
        result = []
        positions = {}
        for original in rows:
            row = dict(original)
            owned = ids(row)
            if owned and not row.get('assistant_pending'):
                claimed.update(owned)
                row['assistant_state'] = 'complete'
                observed = [anchors[mid] for mid in owned if mid in anchors]
                if observed:
                    row['ts'], row['assistant_order'] = min(observed)
                for mid in owned:
                    prior = pending.get(mid)
                    if prior:
                        row['assistant_revision'] = max(row.get('assistant_revision', 0),
                                                        prior['assistant_revision'] + 1)
                # Provider replay can write the same record twice. Use its
                # identity while retaining two distinct identical messages.
                key = row['assistant_id']
                if key in positions:
                    result[positions[key]] = row
                    continue
                positions[key] = len(result)
            result.append(row)
        landed = claimed.intersection(pending)
        if claimed - received:
            conn.executemany('INSERT OR IGNORE INTO assistant_receipts VALUES (?,?)',
                             ((source, mid) for mid in claimed - received))
        if landed:
            conn.executemany('UPDATE assistant_messages SET materialized=1 WHERE scope=? AND id=?',
                             ((source, mid) for mid in landed))
        if include_pending:
            for mid, row in pending.items():
                if mid in claimed:
                    continue
                at = str(row.get('ts') or '')
                index = next((i for i, existing in enumerate(result)
                              if str(existing.get('ts') or '') > at), len(result))
                result.insert(index, row)
        # Completion order need not be generation order. Retain the first
        # observation's place when concurrent provider items complete reversed.
        anchored = [row for row in result if row.get('assistant_order') is not None]
        result = [row for row in result if row.get('assistant_order') is None]
        for row in sorted(anchored, key=lambda r: (str(r.get('ts') or ''), r['assistant_order'])):
            at = str(row.get('ts') or '')
            index = next((i for i, existing in enumerate(result)
                          if str(existing.get('ts') or '') > at), len(result))
            result.insert(index, row)
        return result
