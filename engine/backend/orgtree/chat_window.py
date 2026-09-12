"""Demand-sized native transcript projection, without a cold full-file parse.

Read JSONL backwards in fixed blocks. Only complete records in the requested
tail are projected. The established projector still owns tool/result pairing,
thinking grouping and message metadata. A byte offset identifies occurrences
independently of how much older history this particular viewer requested.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import sqlite3
import datetime as dt
from pathlib import Path
from typing import Any, Iterator

BLOCK = 64 * 1024
#: chat-window-index paths already switched to WAL this process (review F6)
_index_wal: set[str] = set()


def reverse_lines(path: str, stats: dict[str, int]) -> Iterator[tuple[int, str]]:
    with open(path, "rb") as stream:
        stream.seek(0, 2)
        pos = stream.tell()
        tail = b""
        while pos:
            start = max(0, pos - BLOCK)
            stream.seek(start)
            part = stream.read(pos - start)
            stats["bytes_read"] += len(part)
            data = part + tail
            end = len(data)
            while True:
                split = data.rfind(b"\n", 0, end)
                if split < 0:
                    break
                line = data[split + 1:end]
                if line:
                    yield start + split + 1, line.decode("utf-8", errors="replace")
                end = split
            tail = data[:end]
            pos = start
        if tail:
            yield 0, tail.decode("utf-8", errors="replace")


def _prompt(rec: dict[str, Any]) -> str | None:
    if rec.get("type") != "user":
        return None
    msg = rec.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return next((b["text"] for b in content if isinstance(b, dict)
                     and b.get("type") == "text" and isinstance(b.get("text"), str)), None)
    return None


def _stamp(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return None


def _views(path: str, records: list[tuple[int, str, dict]], stats: dict[str, int], *,
           key=None, view_source: str | None = None):
    """Match only the displayed prompt occurrences, using the nearest timestamp.

    Existing sidecars are searched backwards just far enough to cover this
    window. Whole-file import belongs to the bounded background capture.
    Provider timestamps may precede our write clock; both projection matchers
    allow the same symmetric five-minute tolerance.
    """
    from . import transcript_records
    key = key or path
    needed = []
    for offset, _, rec in records:
        prompt = _prompt(rec)
        if prompt is not None:
            needed.append((hashlib.sha256(prompt.encode()).hexdigest(),
                           _stamp(rec.get('timestamp')), offset))
    if not needed:
        return {}
    candidates = {}
    def add(row):
        if isinstance(row, dict) and isinstance(row.get('visible'), str):
            digest = row.get('sha256')
            if any(digest == item[0] for item in needed):
                # Same occurrence rewritten in a sidecar: last file row wins.
                at = str(row.get('at') or '')
                identity = at or json.dumps(row, sort_keys=True)
                candidates.setdefault(digest, {}).setdefault(identity, row)

    times = [stamp for _, stamp, _ in needed if stamp is not None]
    earliest = min(times) if times else None
    lines = reverse_lines(path, stats) if Path(path).is_file() else ()
    for _, line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        stamp = _stamp(row.get('at'))
        if earliest is not None and stamp is not None and stamp < earliest - 300:
            break
        add(row)
        # Once all events have candidates and this descending scan is older
        # than every candidate's lower distance bound, no unseen older row
        # can be closer. Repeated identical text still gets separate rows.
        bounds = []
        for digest, event, _ in needed:
            rows = list(candidates.get(digest, {}).values())
            distances = [abs(event - at) for r in rows
                         if event is not None and (at := _stamp(r.get('at'))) is not None]
            if not distances or min(distances) > 300:
                break
            bounds.append(event - min(distances))
        if len(bounds) == len(needed) and stamp is not None and stamp <= min(bounds):
            break
    if view_source is not None:
        for digest in {item[0] for item in needed}:
            for row in reversed(transcript_records.prompt_views_for(view_source, digest,
                    earliest=min(times)-300 if times else None,
                    latest=max(times)+300 if times else None)):
                add(row)
    # Assign the closest pairs first. Otherwise an earlier unmatched event
    # can steal a later event's exact match merely because it was visited first.
    pairs = []
    for digest, event, offset in needed:
        for identity, row in candidates.get(digest, {}).items():
            at = _stamp(row.get('at'))
            distance = abs(event-at) if event is not None and at is not None else 0
            if distance <= 300:
                pairs.append((distance, at is not None and event is not None and at > event,
                              offset, digest, identity, row))
    assigned, used = {}, set()
    for _, _, offset, digest, identity, row in sorted(pairs, key=lambda x: x[:5]):
        if offset not in assigned and (digest, identity) not in used:
            assigned[offset] = row
            used.add((digest, identity))
    found = {}
    for digest, _, offset in needed:
        row = assigned.get(offset)
        if row is not None:
            transcript_records.remember_view(key, offset, row)
            if view_source is not None:
                transcript_records.append_prompt_view(view_source, row)
        else:
            row = transcript_records.retained_view(key, offset)
        if row is not None:
            found.setdefault(digest, []).append(row)
    return {digest: sorted(rows, key=lambda row: str(row.get('at') or ''))
            for digest, rows in found.items()}



def _project_tail(org, nid: str, path: str, want: int, stats: dict[str, int], *, imported=False, before=None):
    from . import supervisor as sup
    from . import reply_events, transcript_records
    key = source_key(org, nid, imported)
    target = max(8, want * 2)
    while True:
        transcript_records.ingest(key, path, target, stats, before=before)
        stored, more = transcript_records.tail(key, target, before=before)
        chronological = []
        for epoch, offset, line in stored:
            try:
                rec = json.loads(line)
                stats["records_parsed"] += 1
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                chronological.append((epoch * (1 << 40) + offset, line, rec))
        # A Claude response may span several records. Start before that
        # response so its text-block ordinals do not change with page size.
        if more and chronological:
            first_record = chronological[0][2]
            first_message = first_record.get('message') or {}
            if (first_record.get('type') == 'assistant'
                    and isinstance(first_message, dict) and first_message.get('id')
                    and not first_record.get('assistant_id') and Path(path).is_file()):
                boundary = next((i for i, (_, _, rec) in enumerate(chronological)
                    if rec.get('type') == 'user' or
                    (rec.get('type') == 'assistant' and isinstance(rec.get('message'), dict)
                     and rec['message'].get('id') != first_message['id'])), None)
                if boundary is None:
                    target *= 2
                    continue
                chronological = chronological[boundary:]
        if before is not None:
            calls = []
            for _, _, rec in chronological:
                content = rec.get('message', {}).get('content') if isinstance(rec.get('message'), dict) else None
                if isinstance(content, list):
                    calls.extend(str(block['id']) for block in content if isinstance(block, dict)
                                 and block.get('type') == 'tool_use' and block.get('id'))
            for epoch, offset, body in transcript_records.results_for(key, calls):
                position = epoch * (1 << 40) + offset
                if position > before:
                    chronological.append((position, body, json.loads(body)))
        views = {} if imported else _views(
            sup._prompt_view_path(org.d["slug"], org.node(nid)["session_id"]),
            chronological, stats, key=key,
            view_source=transcript_records.views_source(
                org.d["slug"], org.node(nid)["session_id"],
                transcript_records.incarnation(org, nid)))
        built = sup._read_chat_source(org, nid,
            _lines=(row[1] for row in chronological),
            _record_offsets=(row[0] for row in chronological),
            _source_namespace=hashlib.sha256(key.encode()).hexdigest()[:16],
            _prompt_views=views, _source_only=True, _path=Path(path))
        source, dynamic = built["source"], built["out"]
        source['messages'] = transcript_records.native_rows(source_key(org, nid), source['messages'], remember=not imported)
        sup._source_metadata(source)
        if not more or len(source["messages"]) >= want + 2:
            return dynamic, source, more
        # If the provider file disappeared, older unimported rows are no
        # longer available. Preserve the committed range and report it.
        if not Path(path).is_file() and len(stored) < target:
            return dynamic, source, False
        target *= 2


def source_key(org, nid, imported=False):
    from . import providers, transcript_records, reply_events
    node = org.node(nid)
    if not imported and providers.provider_of(str(node.get('model') or '')) != 'claude':
        # scoped by the same immutable incarnation the claude branch below
        # uses: session ids are NOT unique across orgs/accounts/imported
        # copies, and the slug is mutable — neither may key the journal
        return transcript_records.journal_source(
            org.d['slug'], node.get('session_id'),
            transcript_records.incarnation(org, nid))
    return json.dumps([transcript_records.incarnation(org, nid),
                       node.get('session_id'), bool(imported)])


def _cursor(org, nid, rows, raw):
    if not rows:
        return None
    first = rows[0]
    identity = first.get('row_id') or first.get('event_id')
    from . import supervisor as sup
    anchor = next((r for r in raw if sup._stable_event_id(org, nid, r) == identity), None)
    if anchor is None:
        anchor = next((r for r in raw if str(r.get('ts') or '') >= str(first.get('ts') or '')), None)
    position = anchor.get('_byte_offset') if anchor else None
    if anchor is None and raw:
        # A retained partial can follow the latest native record. Include
        # that record on the next page rather than making history unreachable.
        last_position = raw[-1].get('_byte_offset')
        if last_position is not None:
            position = last_position + 1
    payload = {'scope': source_key(org, nid), 'id': identity, 'ts': first.get('ts'),
               'position': position,
               'imported': bool(anchor and anchor.get('imported_history'))}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def read_page(org, nid, want, before):
    """Read an older range without sweeping or replacing the current live tail."""
    from . import supervisor as sup, transcript_records, reply_events
    from .desktop_import import imported_history_path
    cursor = json.loads(base64.urlsafe_b64decode(before))
    if cursor.get('scope') != source_key(org, nid):
        raise ValueError('Transcript cursor belongs to a different conversation')
    want = max(1, min(int(want), 1000))
    phase = bool(cursor.get('imported'))
    stats = {'bytes_read': 0, 'records_parsed': 0}
    node = org.node(nid)
    history = imported_history_path(org, nid)
    path = history if phase else sup.transcript_path_for_node(org, nid)
    if not path:
        with transcript_records.database() as conn:
            retained = conn.execute('SELECT path FROM transcript_sources WHERE source=?',
                                    (source_key(org, nid, phase),)).fetchone()
        path = retained[0] if retained else None
    raw, more = [], False
    projected = False
    if path and cursor.get('position') is not None:
        projected = True
        _, source, more = project_tail(org, nid, path, want + 2, stats,
                                      imported=phase, before=int(cursor['position']))
        withheld = sup._visible_unresolved(source, org, nid, True)
        raw = [row for i, row in enumerate(source['messages']) if i not in withheld]
        for row in raw:
            if phase:
                row['imported_history'] = True
        from . import assistant_messages
        raw = assistant_messages.reconcile(assistant_messages.scope(org, nid), raw)
        # The boundary record is included for tool/thinking context, then
        # removed together with every row at or after the visible cursor.
        cut = next((i for i, row in enumerate(raw)
                    if sup._stable_event_id(org, nid, row) == cursor['id']), None)
        raw = raw[:cut] if cut is not None else [row for row in raw if
              (str(row.get('ts') or '') < str(cursor.get('ts') or '')
               if row.get('assistant_pending') else
               row.get('_byte_offset', -1) < cursor['position'])]
    if not projected:
        from . import assistant_messages
        raw = assistant_messages.reconcile(assistant_messages.scope(org, nid), [])
        cut = next((i for i, row in enumerate(raw)
                    if sup._stable_event_id(org, nid, row) == cursor['id']), None)
        raw = raw[:cut] if cut is not None else [row for row in raw
            if str(row.get('ts') or '') < str(cursor.get('ts') or '')]
    if not phase and history and not more and len(raw) < want + 2:
        _, archive, more = project_tail(org, nid, history, want - len(raw) + 2, stats, imported=True)
        for row in archive['messages']:
            row['imported_history'] = True
        raw = archive['messages'] + raw
    synthetic = sup._synthetic_chat_rows(org, nid)
    cut = next((i for i, row in enumerate(synthetic)
                if sup._stable_event_id(org, nid, row) == cursor['id']), None)
    synthetic = synthetic[:cut] if cut is not None else [row for row in synthetic if
                str(row.get('ts') or '') < str(cursor.get('ts') or '')]
    if more and raw:
        synthetic = [row for row in synthetic if str(row.get('ts') or '') >= str(raw[0].get('ts') or '')]
    selected = list(raw)
    for row in synthetic:
        index = next((i for i, existing in enumerate(selected)
                      if str(existing.get('ts') or '') > str(row.get('ts') or '')), len(selected))
        selected.insert(index, row)
    more = more or len(selected) > want
    selected = selected[-want:]
    rows = [{**sup._public_row(row), 'event_id': sup._stable_event_id(org, nid, row)} for row in selected]
    # The existing boundary provides a stable right-hand ordering anchor.
    anchor = {'event_id': cursor['id']}
    order_epoch = transcript_records.order(source_key(org, nid), rows + [anchor])
    for row in rows:
        row['row_id'] = row['event_id']
    out = {'messages': rows, 'has_older': more, 'windowed': True, 'window_read': stats,
           # bumps only when a rank rebalance ran (review F9): held client
           # seq values stop comparing against fresh ones at that moment
           'order_epoch': order_epoch,
           'before': _cursor(org, nid, rows, raw) if more else None}
    return reply_events.annotate(org, nid, out)


def project_tail(org, nid: str, path: str, want: int, stats: dict[str, int], *, imported=False, before=None):
    """Cache the visible projection of canonical SQLite transcript records.

    Only this derived presentation can be rebuilt. Its durable input records
    live in transcript-records.sqlite3 and survive provider-file removal.
    """
    from . import store, supervisor as sup
    node = org.node(nid)
    raw_key = source_key(org, nid, imported)
    key = json.dumps([raw_key, before])
    sidecar = sup._prompt_view_path(org.d['slug'], node['session_id'])
    def version():
        from . import transcript_records
        with transcript_records.database() as conn:
            persisted = conn.execute('SELECT epoch,lower_byte,upper_byte FROM transcript_sources WHERE source=?', (raw_key,)).fetchone()
            native_count = conn.execute('SELECT COUNT(*) FROM transcript_native_rows WHERE source=?',
                                        (source_key(org, nid),)).fetchone()[0] if imported else None
        return json.dumps([sup._file_version(path), None if imported else sup._file_version(sidecar),
                           sup.context_window(node, org.d.get('models')), persisted, native_count,
                           'assistant-identity-v1'])
    # Ingest BEFORE the version snapshot: the projection's own lazy import
    # legitimately advances the persisted cursor, and taking the snapshot
    # first would make every COLD read invalidate its own cache write (the
    # snapshot is what the cache is stored under — review F2). A further
    # advance during projection (a concurrent append, or the demand loop
    # doubling its target) leaves the cache stored under a version that no
    # longer matches, which costs one rebuild and never serves stale rows.
    from . import transcript_records
    transcript_records.ingest(raw_key, path, max(8, want * 2), stats,
                              before=before)
    version_before = version()
    database = Path(store.DATA_ROOT) / 'chat-window-index.sqlite3'
    with contextlib.closing(sqlite3.connect(database, timeout=10)) as conn, conn:
        if str(database) not in _index_wal:
            # WAL so a projection being cached never blocks another desk's
            # cache READ of a different conversation (review F6); the pragma
            # is persistent in the file, re-issued once per process
            conn.execute('PRAGMA journal_mode=WAL')
            _index_wal.add(str(database))
        conn.execute('CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, version TEXT, more INTEGER, state TEXT)')
        conn.execute('CREATE TABLE IF NOT EXISTS rows (source TEXT, ordinal INTEGER, body TEXT, PRIMARY KEY(source,ordinal)) WITHOUT ROWID')
        meta = conn.execute('SELECT version,more,state FROM sources WHERE key=?', (key,)).fetchone()
        if meta and meta[0] == version_before:
            rows = conn.execute('SELECT body FROM rows WHERE source=? ORDER BY ordinal DESC LIMIT ?',
                                (key,want + 2)).fetchall()
            if len(rows) >= want + 2 or not meta[1]:
                cached = json.loads(meta[2])
                fill = sup._OccTracker(cached['context_cap']); fill.__dict__.update(cached['fill'])
                source = dict(cached, fill=fill, messages=[json.loads(r[0]) for r in reversed(rows)])
                sup._source_metadata(source)
                dynamic = sup._read_chat_source(org,nid,_lines=(),_prompt_views={},
                                                _source_only=True,_path=Path(path))['out']
                stats['index_hit'] = 1
                count = conn.execute('SELECT COUNT(*) FROM rows WHERE source=?', (key,)).fetchone()[0]
                return dynamic, source, bool(meta[1]) or count > len(rows)
        dynamic, source, more = _project_tail(org,nid,path,want,stats,imported=imported,before=before)
        after = version()
        if json.loads(after)[:3] == json.loads(version_before)[:3]:
            conn.execute('DELETE FROM rows WHERE source=?',(key,))
            conn.executemany('INSERT INTO rows VALUES (?,?,?)',
                             ((key,i,json.dumps(row,ensure_ascii=False)) for i,row in enumerate(source['messages'])))
            cached = {'fill': source['fill'].__dict__, 'context_cap': source['context_cap']}
            # ⚠ CACHED UNDER version_before, NEVER `after` (review F2): the
            # rows describe the state that was READ. A record committed
            # DURING projection advances `after`'s persisted cursor — the
            # [:3] guard above deliberately ignores it — and caching under
            # `after` would pin those rows as current, hiding the appended
            # record until some unrelated later mutation. Under
            # version_before the very next read sees a version mismatch and
            # rebuilds — stale is stored, stale is never served.
            conn.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?)',
                         (key,version_before,int(more),json.dumps(cached)))
        return dynamic, source, more


def read_window(org, nid: str, want: int, *, hold_back=True):
    from . import supervisor as sup, reply_events
    from .desktop_import import imported_history_path
    want = max(1, min(int(want), 1_000_000))
    node = org.node(nid)
    path = sup.transcript_path_for_node(org, nid)
    if not path:
        from . import transcript_records
        with transcript_records.database() as conn:
            retained = conn.execute('SELECT path FROM transcript_sources WHERE source=?',
                                    (source_key(org, nid),)).fetchone()
        if retained:
            path = retained[0]
    history = imported_history_path(org, nid)
    stats = {"bytes_read": 0, "records_parsed": 0}
    imported_only = not path and bool(history)
    if imported_only:
        path, history = history, None
    if path:
        dynamic, source, more = project_tail(org, nid, path, want, stats, imported=imported_only)
    else:
        # A virtual path makes the canonical projector assemble live/synthetic
        # rows even before the provider has created its first transcript file.
        built = sup._read_chat_source(org, nid, _lines=(), _prompt_views={},
                                      _source_only=True, _path=Path('__empty_session__'))
        dynamic, source, more = built["out"], built["source"], False
        sup._source_metadata(source)
    base = source["messages"]
    if imported_only:
        for row in base:
            row['imported_history'] = True
    if history and len(base) < want + 2 and not more:
        _, archived, archive_more = project_tail(org, nid, history, want - len(base) + 2, stats, imported=True)
        archive_rows = archived["messages"]
        def native_key(row):
            identity = row.get('native_event_id')
            if not identity:
                return None
            return (identity, json.dumps({key: row.get(key) for key in
                    ('role', 'text', 'tools', 'thinking', 'thinking_sealed', 'ts')},
                    sort_keys=True, default=str))
        identities = {native_key(row) for row in archive_rows} - {None}
        for row in archive_rows:
            row['imported_history'] = True
        source["messages"] = archive_rows + [row for row in base if native_key(row) not in identities]
        base = source["messages"]
        more = archive_more
        sup._source_metadata(source)
    elif history:
        more = True
    # Assemble the bounded projection before slicing, so withheld prompts do
    # not count as older visible rows and create an endless load-older loop.
    out = sup._assemble_chat(org, nid, None, hold_back, dynamic, source)
    visible_count = len(out['messages'])
    out['messages'] = out['messages'][-want:]
    from . import transcript_records
    order_epoch = transcript_records.order(source_key(org, nid), out['messages'])
    for row in out['messages']:
        # reply_events annotates event_id with an immutable quote revision;
        # row_id continues to identify the mutable conversation occurrence.
        row['row_id'] = row['event_id']
    out.update(has_older=more or visible_count > want, windowed=True,
               window_read=stats, order_epoch=order_epoch)
    out['before'] = _cursor(org, nid, out['messages'], base) if out['has_older'] else None
    st = sup.state(org.d["slug"], nid)
    with sup._state_lock:
        if not st["busy"]:
            for group in ("draft", "thinking", "starting"):
                st.get("reply_transient", {}).pop(group, None)
        out["transient"] = list(st.get("reply_transient", {}).values())
    return reply_events.annotate(org, nid, out)
