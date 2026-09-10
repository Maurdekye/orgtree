"""Durable transcript records with resumable, bounded JSONL ingestion.

Provider files are import sources. Once committed, records remain readable
without those files. Source replacement starts a new incarnation and never
deletes an earlier incarnation. Each ingestion position commits with its rows.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
import threading
from pathlib import Path

BLOCK = 65536
_schema_lock = threading.Lock()
_initialized = set()


@contextlib.contextmanager
def database():
    from . import store
    path = Path(store.DATA_ROOT) / "transcript-records.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    try:
        conn.execute("PRAGMA synchronous=FULL")
        with _schema_lock:
            if str(path) not in _initialized:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript("""
          CREATE TABLE IF NOT EXISTS transcript_sources (
            source TEXT PRIMARY KEY, path TEXT NOT NULL, epoch INTEGER NOT NULL,
            signature TEXT, lower_byte INTEGER NOT NULL, upper_byte INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS transcript_records (
            source TEXT NOT NULL, epoch INTEGER NOT NULL, position INTEGER NOT NULL,
            body TEXT NOT NULL, PRIMARY KEY(source,epoch,position)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS transcript_order (
            source TEXT NOT NULL, event TEXT NOT NULL, rank REAL NOT NULL,
            PRIMARY KEY(source,event)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS transcript_owned (source TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS transcript_views (
            source TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(source,position)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS transcript_tool_results (
            source TEXT NOT NULL, tool TEXT NOT NULL, epoch INTEGER NOT NULL,
            position INTEGER NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(source,tool)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS transcript_native_rows (
            source TEXT NOT NULL, identity TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY(source,identity,digest)) WITHOUT ROWID;
                """)
                _initialized.add(str(path))
        with conn:
            yield conn
    finally:
        conn.close()


def _signature(stream, stats):
    """Identity of the first complete record, stable across ordinary appends."""
    stream.seek(0)
    first = stream.readline()
    stats["bytes_read"] += len(first)
    return hashlib.sha256(first).hexdigest() if first.endswith(b"\n") else ""


def _tail(stream, end, count, stats):
    """Return complete lines ending before end, newest first, and lower bound."""
    pos, carry, found = end, b"", []
    while pos and len(found) < count:
        start = max(0, pos - BLOCK)
        stream.seek(start)
        part = stream.read(pos - start)
        stats["bytes_read"] += len(part)
        data = part + carry
        stop = len(data)
        # end is always a complete line boundary.
        if data.endswith(b"\n"):
            stop -= 1
        while len(found) < count:
            split = data.rfind(b"\n", 0, stop)
            if split < 0:
                break
            found.append((start + split + 1, data[split + 1:stop]))
            stop = split
        carry, pos = data[:stop], start
    if not pos and carry and len(found) < count:
        found.append((0, carry))
    lower = found[-1][0] if found else end
    return found, lower


def _insert(conn, source, epoch, rows):
    rows = list(rows)
    conn.executemany("INSERT OR IGNORE INTO transcript_records VALUES (?,?,?,?)",
                     ((source, epoch, offset, line.decode("utf-8", errors="replace"))
                      for offset, line in rows))
    for offset, line in rows:
        _index_results(conn, source, epoch, offset, line.decode('utf-8', errors='replace'))


def _index_results(conn, source, epoch, offset, body):
    try:
        rec = json.loads(body)
    except json.JSONDecodeError:
        return
    content = rec.get('message', {}).get('content') if isinstance(rec, dict) and isinstance(rec.get('message'), dict) else None
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id'):
            # Preserve only the result block here, not unrelated user text
            # from that same provider record outside the requested page.
            result = dict(rec, message={**rec['message'], 'content': [block]})
            conn.execute('''INSERT INTO transcript_tool_results VALUES (?,?,?,?,?)
                            ON CONFLICT(source,tool) DO UPDATE SET epoch=excluded.epoch,
                            position=excluded.position,body=excluded.body
                            WHERE (excluded.epoch,excluded.position)>=(epoch,position)''',
                         (source, str(block['tool_use_id']), epoch, offset, json.dumps(result, ensure_ascii=False)))


def results_for(source, tool_ids):
    with database() as conn:
        found = []
        for identity in tool_ids:
            row = conn.execute('SELECT epoch,position,body FROM transcript_tool_results WHERE source=? AND tool=?',
                               (source, identity)).fetchone()
            if row:
                found.append(row)
        return found


def _native_key(row):
    identity = row.get('native_event_id')
    if not identity:
        return None
    body = json.dumps({key: row.get(key) for key in
                      ('role','text','tools','thinking','thinking_sealed','ts')}, sort_keys=True, default=str)
    return str(identity), hashlib.sha256(body.encode()).hexdigest()


def native_rows(source, rows, *, remember=False):
    with database() as conn:
        result = []
        for row in rows:
            key = _native_key(row)
            if key and remember:
                conn.execute('INSERT OR IGNORE INTO transcript_native_rows VALUES (?,?,?)', (source, *key))
            if remember or key is None or not conn.execute('SELECT 1 FROM transcript_native_rows WHERE source=? AND identity=? AND digest=?',
                                                          (source, *key)).fetchone():
                result.append(row)
        return result


def ingest(source: str, path: str, count: int, stats: dict, *, before=None):
    """Persist new suffixes and enough older records for this requested window.

    Invalid/torn final lines stay outside the committed cursor, so completion
    on the next append is retried. No persisted data is removed on rotation.
    """
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        meta = conn.execute("SELECT path,epoch,signature,lower_byte,upper_byte FROM transcript_sources WHERE source=?",
                            (source,)).fetchone()
        owned = conn.execute("SELECT 1 FROM transcript_owned WHERE source=?", (source,)).fetchone()
        def available():
            if before is None:
                return conn.execute("SELECT COUNT(*) FROM transcript_records WHERE source=?", (source,)).fetchone()[0]
            epoch, position = divmod(before, 1 << 40)
            return conn.execute("SELECT COUNT(*) FROM transcript_records WHERE source=? AND (epoch,position)<=(?,?)",
                                (source, epoch, position)).fetchone()[0]
        if owned and meta:
            # The DB writer owns all new records. The old file is consulted
            # only for older ranges predating the changeover.
            have = available()
            if meta[3] and have < count and Path(path).is_file():
                with open(path, 'rb') as stream:
                    rows, lower = _tail(stream, meta[3], count - have, stats)
                _insert(conn, source, meta[1], rows)
                conn.execute("UPDATE transcript_sources SET lower_byte=? WHERE source=?", (lower, source))
            return
        try:
            stream = open(path, "rb")
        except FileNotFoundError:
            return
        with stream:
            stream.seek(0, 2)
            size = stream.tell()
            signature = _signature(stream, stats)
            epoch = meta[1] if meta else 0
            replacement = meta and (size < meta[4] or (meta[2] and signature != meta[2]))
            if replacement:
                epoch += 1
            lower, upper = (size, size) if not meta or replacement else (meta[3], meta[4])
            if not meta or replacement:
                # Exclude a partial final record from both import and cursor.
                stream.seek(max(0, size - BLOCK))
                suffix = stream.read()
                stats["bytes_read"] += len(suffix)
                last = suffix.rfind(b"\n")
                upper = max(0, size - len(suffix) + last + 1) if last >= 0 else 0
                rows, lower = _tail(stream, upper, count, stats)
                _insert(conn, source, epoch, rows)
            elif size > upper:
                stream.seek(upper)
                while True:
                    offset = stream.tell()
                    line = stream.readline()
                    stats["bytes_read"] += len(line)
                    if not line or not line.endswith(b"\n"):
                        break
                    _insert(conn, source, epoch, [(offset, line.rstrip(b"\r\n"))])
                    upper = stream.tell()
            have = available()
            if lower and have < count:
                rows, lower = _tail(stream, lower, count - have, stats)
                _insert(conn, source, epoch, rows)
            conn.execute("INSERT OR REPLACE INTO transcript_sources VALUES (?,?,?,?,?,?)",
                         (source, path, epoch, signature, lower, upper))


def tail(source: str, count: int, *, before=None):
    with database() as conn:
        condition = "source=?"
        args = [source]
        if before is not None:
            epoch, position = divmod(before, 1 << 40)
            condition += " AND (epoch,position)<=(?,?)"
            args.extend([epoch, position])
        rows = conn.execute("SELECT epoch,position,body FROM transcript_records WHERE " + condition + " ORDER BY epoch DESC,position DESC LIMIT ?",
                            (*args, count)).fetchall()
        meta = conn.execute("SELECT lower_byte FROM transcript_sources WHERE source=?", (source,)).fetchone()
        total = conn.execute("SELECT COUNT(*) FROM transcript_records WHERE " + condition, args).fetchone()[0]
    return list(reversed(rows)), bool(meta and meta[0]) or total > len(rows)


def append(source: str, records: list[dict]):
    """Commit app-owned records directly; no provider file is required."""
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        last = conn.execute("SELECT COALESCE(MAX(position),-1) FROM transcript_records WHERE source=? AND epoch=0",
                            (source,)).fetchone()[0]
        conn.executemany("INSERT INTO transcript_records VALUES (?,0,?,?)",
                         ((source, last + i + 1, json.dumps(rec, ensure_ascii=False))
                          for i, rec in enumerate(records)))


def journal_source(slug, sid):
    return "journal:" + json.dumps([slug, sid])


def remember_view(source, position, view):
    with database() as conn:
        conn.execute('INSERT OR REPLACE INTO transcript_views VALUES (?,?,?)',
                     (source, position, json.dumps(view, ensure_ascii=False)))


def retained_view(source, position):
    with database() as conn:
        found = conn.execute('SELECT body FROM transcript_views WHERE source=? AND position=?',
                             (source, position)).fetchone()
    return json.loads(found[0]) if found else None


def append_owned(slug, sid, path, recs):
    """Database commit precedes the compatibility JSONL mirror.

    Previously existing JSONL history is imported lazily. After this first
    commit the DB owns the new suffix even if the mirror cannot be written.
    """
    source = journal_source(slug, sid)
    ingest(source, str(path), 16, {"bytes_read": 0})
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        meta = conn.execute("SELECT epoch,lower_byte,upper_byte FROM transcript_sources WHERE source=?", (source,)).fetchone()
        epoch, lower, position = meta or (0, 0, 0)
        for rec in recs:
            body = json.dumps(rec, ensure_ascii=False)
            conn.execute("INSERT INTO transcript_records VALUES (?,?,?,?)", (source, epoch, position, body))
            _index_results(conn, source, epoch, position, body)
            position += len((body + "\n").encode("utf-8"))
        conn.execute("INSERT OR REPLACE INTO transcript_sources VALUES (?,?,?,?,?,?)",
                     (source, str(path), epoch, "", lower, position))
        conn.execute("INSERT OR IGNORE INTO transcript_owned VALUES (?)", (source,))


def order(source: str, rows: list[dict]):
    """Stable numeric handles, including lazy prepends and late inserted mail."""
    if not rows:
        return
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        known = {}
        for row in rows:
            found = conn.execute("SELECT rank FROM transcript_order WHERE source=? AND event=?",
                                 (source, row["event_id"])).fetchone()
            if found:
                known[row["event_id"]] = found[0]
        i = 0
        while i < len(rows):
            identity = rows[i]["event_id"]
            if identity in known:
                rows[i]["seq"] = known[identity]
                i += 1
                continue
            end = i + 1
            while end < len(rows) and rows[end]["event_id"] not in known:
                end += 1
            left = rows[i - 1]["seq"] if i else None
            right = known[rows[end]["event_id"]] if end < len(rows) else None
            count = end - i
            if left is None:
                left = (right if right is not None else 0) - 1024 * (count + 1)
            step = (right - left) / (count + 1) if right is not None else 1024
            for j in range(i, end):
                rank = left + step * (j - i + 1)
                rows[j]["seq"] = rank
                conn.execute("INSERT INTO transcript_order VALUES (?,?,?)",
                             (source, rows[j]["event_id"], rank))
            i = end
