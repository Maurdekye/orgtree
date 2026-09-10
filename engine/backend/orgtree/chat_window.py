"""Demand-sized native transcript projection, without a cold full-file parse.

Read JSONL backwards in fixed blocks. Only complete records in the requested
tail are projected. The established projector still owns tool/result pairing,
thinking grouping and message metadata. A byte offset identifies occurrences
independently of how much older history this particular viewer requested.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import datetime as dt
from pathlib import Path
from typing import Any, Iterator

BLOCK = 64 * 1024


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


def _views(path: str, records: list[tuple[int, str, dict]], stats: dict[str, int]):
    """Read only the sidecar suffix needed by the selected prompt occurrences."""
    needed: dict[str, list[float | None]] = {}
    stamps = [_stamp(rec.get('timestamp')) for _, _, rec in records]
    earliest = min((s for s in stamps if s is not None), default=None)
    for _, _, rec in reversed(records):
        prompt = _prompt(rec)
        if prompt is not None:
            digest = hashlib.sha256(prompt.encode()).hexdigest()
            needed.setdefault(digest, []).append(_stamp(rec.get('timestamp')))
    found: dict[str, list[dict]] = {}
    if not needed or not Path(path).is_file():
        return found
    for _, line in reverse_lines(path, stats):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict) or not isinstance(row.get("visible"), str):
            continue
        stamp = _stamp(row.get('at'))
        if earliest is not None and stamp is not None and stamp < earliest - 300:
            break
        digest = row.get("sha256")
        events = needed.get(digest, [])
        # Sidecars are written BEFORE provider echoes. A later queued copy of
        # identical text must not replace an older occurrence already on disk.
        match = next((i for i, event in enumerate(events)
                      if event is None or stamp is None or 0 <= event - stamp <= 300), None)
        if match is not None:
            events.pop(match)
            found.setdefault(digest, []).append(row)
            if not any(needed.values()):
                break
    return {key: list(reversed(rows)) for key, rows in found.items()}



def _project_tail(org, nid: str, path: str, want: int, stats: dict[str, int], *, imported=False):
    from . import supervisor as sup
    records: list[tuple[int, str, dict]] = []
    source = None
    dynamic = None
    exhausted = False
    target = max(8, want * 2)
    iterator = reverse_lines(path, stats)
    while True:
        while len(records) < target:
            try:
                offset, line = next(iterator)
            except StopIteration:
                exhausted = True
                break
            try:
                rec = json.loads(line)
                stats["records_parsed"] += 1
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                records.append((offset, line, rec))
        chronological = list(reversed(records))
        views = {} if imported else _views(sup._prompt_view_path(
            org.d["slug"], org.node(nid)["session_id"]), chronological, stats)
        built = sup._read_chat_source(org, nid,
            _lines=(row[1] for row in chronological),
            _record_offsets=(row[0] for row in chronological),
            _source_namespace=hashlib.sha256(str(path).encode()).hexdigest()[:16],
            _prompt_views=views, _source_only=True, _path=Path(path))
        source, dynamic = built["source"], built["out"]
        sup._source_metadata(source)
        # Extra projected rows protect the first visible row's predecessor
        # (thinking duration/merge and tool-result context) at the cut.
        if exhausted or len(source["messages"]) >= want + 2:
            break
        target *= 2
    iterator.close()
    return dynamic, source, not exhausted


def project_tail(org, nid: str, path: str, want: int, stats: dict[str, int], *, imported=False):
    """SQLite rows are a rebuildable UI index, separate from provider history.

    Each request reads an indexed suffix. A changed source invalidates its
    projection; rebuilding only visits the demanded tail, never all history.
    Older ranges enter the index when a viewer explicitly requests them.
    """
    from . import store, supervisor as sup
    node = org.node(nid)
    key = json.dumps([org.d['slug'], nid, node.get('generation'), path, imported])
    sidecar = sup._prompt_view_path(org.d['slug'], node['session_id'])
    def version():
        return json.dumps([sup._file_version(path), None if imported else sup._file_version(sidecar),
                           sup.context_window(node, org.d.get('models'))])
    before = version()
    database = Path(store.DATA_ROOT) / 'chat-window-index.sqlite3'
    with sqlite3.connect(database, timeout=10) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, version TEXT, more INTEGER, state TEXT)')
        conn.execute('CREATE TABLE IF NOT EXISTS rows (source TEXT, ordinal INTEGER, body TEXT, PRIMARY KEY(source,ordinal)) WITHOUT ROWID')
        meta = conn.execute('SELECT version,more,state FROM sources WHERE key=?', (key,)).fetchone()
        if meta and meta[0] == before:
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
        dynamic, source, more = _project_tail(org,nid,path,want,stats,imported=imported)
        if version() == before:
            conn.execute('DELETE FROM rows WHERE source=?',(key,))
            conn.executemany('INSERT INTO rows VALUES (?,?,?)',
                             ((key,i,json.dumps(row,ensure_ascii=False)) for i,row in enumerate(source['messages'])))
            cached = {'fill': source['fill'].__dict__, 'context_cap': source['context_cap']}
            conn.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?)',
                         (key,before,int(more),json.dumps(cached)))
        return dynamic, source, more


def read_window(org, nid: str, want: int, *, hold_back=True):
    from . import supervisor as sup, reply_events
    from .desktop_import import imported_history_path
    want = max(1, min(int(want), 1_000_000))
    node = org.node(nid)
    path = sup.transcript_path(node["session_id"], sup._transcript_root(org))
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
    for row in out["messages"]:
        # Numeric row handles support the existing user-turn pin map. They
        # are stable identities, explicitly NOT transcript ordinals.
        row["seq"] = int(hashlib.sha256(row['event_id'].encode()).hexdigest()[:13], 16)
    out.update(has_older=more or visible_count > want, windowed=True,
               window_read=stats)
    st = sup.state(org.d["slug"], nid)
    with sup._state_lock:
        if not st["busy"]:
            for group in ("draft", "thinking", "starting"):
                st.get("reply_transient", {}).pop(group, None)
        out["transient"] = list(st.get("reply_transient", {}).values())
    return reply_events.annotate(org, nid, out)
