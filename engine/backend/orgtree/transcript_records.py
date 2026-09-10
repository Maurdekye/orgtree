"""Durable transcript records with resumable, bounded JSONL ingestion.

Provider files are import sources. Once committed, records remain readable
without those files. Source replacement starts a new incarnation and never
deletes an earlier incarnation. Each ingestion position commits with its rows.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path

BLOCK = 65536
#: how much of the file tail before the committed upper boundary is hashed as
#: the resume anchor — enough to cover any plausible in-place tail rewrite
#: while costing one bounded read per ingest that has new work
ANCHOR_BYTES = 4096
_schema_lock = threading.Lock()
_initialized = set()
#: serializes every recovery-spool operation (append, replay, truncate) so a
#: concurrent writer cannot slip a record in between replay and truncation
_spool_lock = threading.Lock()
#: reentrancy guard: replay itself calls ingest(), which drains the spool —
#: without this a drain would deadlock on its own non-reentrant lock
_spool_state = threading.local()


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
          CREATE TABLE IF NOT EXISTS transcript_spooled (
            source TEXT NOT NULL, record_id TEXT NOT NULL,
            PRIMARY KEY(source,record_id)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS transcript_anchors (
            source TEXT PRIMARY KEY, upper INTEGER NOT NULL, digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transcript_order_meta (
            source TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS transcript_journal_ids (
            sid TEXT PRIMARY KEY, source TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transcript_view_rows (
            source TEXT NOT NULL, digest TEXT NOT NULL, at TEXT NOT NULL,
            key TEXT NOT NULL, body TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS transcript_view_rows_key
            ON transcript_view_rows(source,digest,at,key);
          CREATE TABLE IF NOT EXISTS transcript_view_sources (
            source TEXT PRIMARY KEY, path TEXT NOT NULL,
            upper INTEGER NOT NULL, anchor TEXT NOT NULL);
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


def _anchor_digest(stream, upto: int, stats: dict | None = None) -> str:
    """sha256 of the last min(ANCHOR_BYTES, upto) bytes ending at `upto` —
    the durable identity of the committed boundary's neighbourhood. Resuming
    at `upto` is legal only while this matches: a file rewritten in place
    under the same first line no longer matches, so it is treated as a
    replacement rather than parsed from a mid-record offset (review F7)."""
    if not upto:
        return ""
    span = min(ANCHOR_BYTES, upto)
    stream.seek(upto - span)
    data = stream.read(span)
    if stats is not None:
        stats["bytes_read"] += len(data)
    return hashlib.sha256(data).hexdigest()


def _available(conn, source: str, before) -> int:
    if before is None:
        return conn.execute("SELECT COUNT(*) FROM transcript_records WHERE source=?", (source,)).fetchone()[0]
    epoch, position = divmod(before, 1 << 40)
    return conn.execute("SELECT COUNT(*) FROM transcript_records WHERE source=? AND (epoch,position)<=(?,?)",
                        (source, epoch, position)).fetchone()[0]


def _ingest_needed(source: str, path: str, count: int, stats: dict, before) -> bool:
    """Read-only answer to "would ingest write anything?" — the common
    steady-state poll (file unchanged, window satisfied) must not take the
    database's single writer lock (review F6). Detection here mirrors the
    write path exactly — size, first-line signature, boundary anchor,
    backfill demand — and any doubt answers True: the write path re-checks
    everything under BEGIN IMMEDIATE and stays authoritative."""
    with database() as conn:
        meta = conn.execute("SELECT path,epoch,signature,lower_byte,upper_byte FROM transcript_sources WHERE source=?",
                            (source,)).fetchone()
        owned = conn.execute("SELECT 1 FROM transcript_owned WHERE source=?", (source,)).fetchone()
        if owned and meta:
            return bool(meta[3] and _available(conn, source, before) < count
                        and Path(path).is_file())
        try:
            size = os.path.getsize(path)
        except OSError:
            return False          # no file: the write path would return too
        if not meta:
            return True
        if size != meta[4] or meta[3] and _available(conn, source, before) < count:
            return True
        anchor = conn.execute("SELECT upper,digest FROM transcript_anchors WHERE source=?",
                              (source,)).fetchone()
        try:
            with open(path, "rb") as stream:
                if meta[2] and _signature(stream, stats) != meta[2]:
                    return True
                if anchor and anchor[0] == meta[4] \
                        and _anchor_digest(stream, anchor[0], stats) != anchor[1]:
                    return True
        except OSError:
            return False
        return False


def ingest(source: str, path: str, count: int, stats: dict, *, before=None):
    """Persist new suffixes and enough older records for this requested window.

    Invalid/torn final lines stay outside the committed cursor, so completion
    on the next append is retried. No persisted data is removed on rotation.
    """
    _drain_spool()
    if not _ingest_needed(source, path, count, stats, before):
        return
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        meta = conn.execute("SELECT path,epoch,signature,lower_byte,upper_byte FROM transcript_sources WHERE source=?",
                            (source,)).fetchone()
        owned = conn.execute("SELECT 1 FROM transcript_owned WHERE source=?", (source,)).fetchone()
        def available():
            return _available(conn, source, before)
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
            # the committed boundary's anchor must still match before the
            # old upper is trusted as a resume offset: a same-first-line,
            # not-smaller in-place rewrite otherwise resumes mid-record and
            # commits a torn seam as durable garbage (review F7)
            anchor = conn.execute("SELECT upper,digest FROM transcript_anchors WHERE source=?",
                                  (source,)).fetchone()
            anchor_broken = bool(
                meta and anchor and anchor[0] == meta[4] and anchor[0] <= size
                and _anchor_digest(stream, anchor[0], stats) != anchor[1])
            epoch = meta[1] if meta else 0
            replacement = meta and (size < meta[4]
                                    or (meta[2] and signature != meta[2])
                                    or anchor_broken)
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
            # written beside the cursor it protects, in the same transaction
            conn.execute("INSERT OR REPLACE INTO transcript_anchors VALUES (?,?,?)",
                         (source, upper, _anchor_digest(stream, upper, stats)))


def tail(source: str, count: int, *, before=None):
    # recovered records must be visible to every read (review F1) — a spool
    # left by a database outage is replayed before the rows are served
    _drain_spool()
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


def _journal_identity(sid, incarnation) -> str | None:
    return (json.dumps([str(incarnation), str(sid)])
            if incarnation else None)


def journal_source(slug, sid, incarnation=None):
    """The durable identity of an app-owned journal.

    SESSION IDS ARE NOT SYSTEM-UNIQUE (identical sids exist across orgs,
    accounts and imported profile copies), and the org slug is MUTABLE
    (rename) — so neither alone may key a journal. The immutable scope is
    `reply_events.incarnation(org, nid)` (org UUID + node UUID, minted
    once, rename/compaction-stable — the same identity the claude
    source_key already uses; the explicit reply-clear endpoint rotates it,
    which starts a fresh source exactly as it does for claude sources).

    Resolution, deterministic given database state:
      1. the alias registered at the journal's FIRST scoped commit;
      2. else ADOPTION: data already committed under the CURRENT slug's
         legacy name is used as-is — keyed by the caller's own slug, so
         two orgs sharing a sid each adopt only their own data;
      3. else the incarnation-scoped name.
    A caller WITHOUT an incarnation gets the legacy slug-keyed name and no
    aliasing at all — sid-only aliasing would unify colliding sids across
    orgs, which is exactly the defect this replaces. With the database
    unavailable the scoped name is the honest fallback; the spool replay
    re-resolves once it recovers."""
    legacy = "journal:" + json.dumps([slug, sid])
    identity = _journal_identity(sid, incarnation)
    if identity is None:
        return legacy
    name = "journal:" + identity
    try:
        with database() as conn:
            row = conn.execute("SELECT source FROM transcript_journal_ids WHERE sid=?",
                               (identity,)).fetchone()
            if row:
                return row[0]
            adopt = conn.execute("SELECT 1 FROM transcript_sources WHERE source=?",
                                 (legacy,)).fetchone()
        return legacy if adopt else name
    except sqlite3.Error:
        return name


def remember_view(source, position, view):
    with database() as conn:
        conn.execute('INSERT OR REPLACE INTO transcript_views VALUES (?,?,?)',
                     (source, position, json.dumps(view, ensure_ascii=False)))


def retained_view(source, position):
    with database() as conn:
        found = conn.execute('SELECT body FROM transcript_views WHERE source=? AND position=?',
                             (source, position)).fetchone()
    return json.loads(found[0]) if found else None


def incarnation(org, nid):
    """Stable transcript identity, independent of deleting retained reply quotes.

    Seed existing conversations from their current identity so adoption does not
    rename committed sources. Once captured, quote-clear cannot rotate it.
    """
    if org.node(nid).get('transcript_incarnation'):
        return org.node(nid)['transcript_incarnation']
    from . import reply_events, store
    identity = reply_events.incarnation(org, nid)
    with store.DOC_LOCK:
        persisted = Path(store.org_path(org.d['slug'])).exists()
        current = store.load_org(org.d['slug']) if persisted else org
        value = current.node(nid).setdefault('transcript_incarnation', identity)
        if persisted:
            store.save_org(current)
        org.node(nid)['transcript_incarnation'] = value
    return value


def views_source(slug, sid, incarnation=None) -> str:
    """The durable prompt-view index's per-conversation key. ONE string for
    all three doors — supervisor._write_prompt_view (append_prompt_view),
    startup/backfill capture (ingest_prompt_views) and display
    (chat_window._views) — so they can never miss each other.

    With an `incarnation` the key is collision-safe across orgs sharing a
    session id and stable across renames; rows already committed under the
    CURRENT slug's legacy key migrate to it once, in place (idempotent —
    the unique row key absorbs any overlap), so committed data survives
    the change of key. Without one, the legacy slug-keyed name is
    returned unchanged."""
    legacy = "views:" + json.dumps([str(slug), str(sid)])
    if not incarnation:
        return legacy
    name = "views:" + json.dumps([str(incarnation), str(sid)])
    try:
        with database() as conn:
            has_new = conn.execute("SELECT 1 FROM transcript_view_sources WHERE source=?",
                                   (name,)).fetchone()
            has_legacy = None if has_new else conn.execute(
                "SELECT 1 FROM transcript_view_sources WHERE source=?",
                (legacy,)).fetchone()
        if has_legacy:
            with database() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("UPDATE OR IGNORE transcript_view_rows SET source=? WHERE source=?",
                             (name, legacy))
                conn.execute("DELETE FROM transcript_view_rows WHERE source=?", (legacy,))
                conn.execute("UPDATE OR IGNORE transcript_view_sources SET source=? WHERE source=?",
                             (name, legacy))
                conn.execute("DELETE FROM transcript_view_sources WHERE source=?", (legacy,))
    except sqlite3.Error:
        pass
    return name


def _insert_view_row(conn, source, row) -> None:
    if not isinstance(row, dict) or not isinstance(row.get("visible"), str):
        return
    digest = str(row.get("sha256") or "")
    if not digest:
        return
    body = json.dumps(row, ensure_ascii=False, sort_keys=True)
    key = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    conn.execute("INSERT OR IGNORE INTO transcript_view_rows VALUES (?,?,?,?,?)",
                 (source, digest, str(row.get("at") or ""), key,
                  json.dumps(row, ensure_ascii=False)))


def append_prompt_view(source: str, row: dict) -> None:
    """Durably index ONE just-written prompt-view row (wire this beside
    supervisor._write_prompt_view). Idempotent: the same row indexes once,
    keyed by (digest, at, body hash) — sidecar loss no longer loses the
    human projection of an unseen prompt."""
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _insert_view_row(conn, source, row)


def ingest_prompt_views(source: str, path: str, stats: dict | None = None) -> None:
    """Bounded, idempotent sidecar capture: new complete lines past the
    committed upper byte only; a rewritten or shrunk sidecar (boundary
    anchor mismatch) is re-read whole, with the unique key deduplicating
    and later insertions winning per occurrence, so corrections land while
    rows pruned from the file stay durably indexed. An unchanged sidecar
    takes no write lock (review F6)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    with database() as conn:
        meta = conn.execute("SELECT upper,anchor FROM transcript_view_sources WHERE source=?",
                            (source,)).fetchone()
    if meta and size == meta[0]:
        try:
            with open(path, "rb") as stream:
                if _anchor_digest(stream, meta[0], stats) == meta[1]:
                    return
        except OSError:
            return
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        meta = conn.execute("SELECT upper,anchor FROM transcript_view_sources WHERE source=?",
                            (source,)).fetchone()
        upper = meta[0] if meta else 0
        try:
            stream = open(path, "rb")
        except OSError:
            return
        with stream:
            rewritten = bool(meta and upper
                             and (size < upper
                                  or _anchor_digest(stream, upper, stats) != meta[1]))
            if rewritten:
                upper = 0
            if size > upper:
                stream.seek(upper)
                while True:
                    line = stream.readline()
                    if stats is not None:
                        stats["bytes_read"] += len(line)
                    if not line or not line.endswith(b"\n"):
                        break
                    upper = stream.tell()
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    _insert_view_row(conn, source, row)
            anchor = _anchor_digest(stream, upper, stats)
        conn.execute("INSERT OR REPLACE INTO transcript_view_sources VALUES (?,?,?,?)",
                     (source, str(path), upper, anchor))


def prompt_views_for(source: str, digest: str) -> list[dict]:
    """Every indexed view for one prompt digest, oldest first; where a
    correction re-imported the same occurrence, the LATEST insertion wins."""
    with database() as conn:
        rows = conn.execute(
            "SELECT body FROM transcript_view_rows WHERE source=? AND digest=? AND rowid IN ("
            " SELECT MAX(rowid) FROM transcript_view_rows WHERE source=? AND digest=? GROUP BY at)"
            " ORDER BY at",
            (source, digest, source, digest)).fetchall()
    return [json.loads(r[0]) for r in rows]


def _spool_path() -> Path:
    from . import store
    return Path(store.DATA_ROOT) / "transcript-records.spool.jsonl"


def _spool(entries) -> None:
    """Durably queue records SQLite would not accept: one JSON line per
    record — `{"source", "path", "id", "rec"}` — appended and fsynced before
    returning, so a record acknowledged to the caller survives a crash. `id`
    is minted once, at append_owned time, and travels with the record: replay
    commits each id at most once however many times it runs."""
    data = b"".join(
        json.dumps(entry, ensure_ascii=False).encode("utf-8") + b"\n"
        for entry in entries)
    with _spool_lock:
        path = _spool_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "ab") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())


def _drain_spool() -> bool:
    """Replay every spooled record into SQLite, exactly once each, in spool
    order; True when the spool is empty afterwards (or was already). Runs
    before every write and every read so recovered records take their place
    AHEAD of anything newer — a caller that cannot drain must keep spooling
    rather than commit records out of order. A parse-torn final line is a
    crash artifact from mid-spool-write: its record was never acknowledged
    (fsync happens before append_owned returns), so it is dropped rather
    than replayed as garbage."""
    if getattr(_spool_state, "draining", False):
        return True
    try:
        path = _spool_path()
        if not path.is_file() or path.stat().st_size == 0:
            return True
    except OSError:
        return False
    _spool_state.draining = True
    try:
        with _spool_lock:
            try:
                raw = path.read_bytes()
            except OSError:
                return False
            entries = []
            for line in raw.split(b"\n"):
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and entry.get("id"):
                    entries.append(entry)
            # group consecutive same-source runs so replay preserves the
            # exact global order records were spooled in
            i = 0
            while i < len(entries):
                j = i + 1
                while (j < len(entries)
                       and entries[j]["source"] == entries[i]["source"]
                       and entries[j].get("path") == entries[i].get("path")):
                    j += 1
                batch = entries[i:j]
                head = batch[0]
                # re-resolve the destination now that the database answers:
                # the name captured during the outage was a blind fallback
                target = (journal_source(head["slug"], head["sid"],
                                         head.get("scope"))
                          if head.get("slug") and head.get("sid")
                          else head["source"])
                try:
                    _commit_owned(target, str(head.get("path") or ""),
                                  [(e["id"], e["rec"]) for e in batch],
                                  identity=_journal_identity(head.get("sid"),
                                                             head.get("scope")))
                except sqlite3.Error:
                    # SQLite is still unavailable: keep the whole spool —
                    # ids already committed are skipped on the next replay
                    return False
                i = j
            try:
                path.unlink()
            except OSError:
                return False    # committed ids protect the next replay
            return True
    finally:
        _spool_state.draining = False


def _commit_owned(source, path, entries, identity=None) -> None:
    """One owned batch into the database: lazy legacy import first, then the
    records at continuing positions. `entries` are (record_id, rec) pairs;
    an id already marked in transcript_spooled is skipped (idempotent
    replay), and marking happens in the same transaction as the insert so a
    crash between them cannot double-commit."""
    if path:
        ingest(source, path, 16, {"bytes_read": 0})
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if identity:
            # rename safety: the first SCOPED commit fixes the journal's
            # name (which may be an adopted legacy name); every later
            # journal_source(any-slug, sid, incarnation) resolves here
            conn.execute("INSERT OR IGNORE INTO transcript_journal_ids VALUES (?,?)",
                         (identity, source))
        meta = conn.execute("SELECT epoch,lower_byte,upper_byte FROM transcript_sources WHERE source=?", (source,)).fetchone()
        epoch, lower, position = meta or (0, 0, 0)
        wrote = False
        for record_id, rec in entries:
            if conn.execute("SELECT 1 FROM transcript_spooled WHERE source=? AND record_id=?",
                            (source, record_id)).fetchone():
                continue
            body = json.dumps(rec, ensure_ascii=False)
            conn.execute("INSERT INTO transcript_records VALUES (?,?,?,?)", (source, epoch, position, body))
            _index_results(conn, source, epoch, position, body)
            conn.execute("INSERT INTO transcript_spooled VALUES (?,?)", (source, record_id))
            position += len((body + "\n").encode("utf-8"))
            wrote = True
        if wrote or meta is None:
            conn.execute("INSERT OR REPLACE INTO transcript_sources VALUES (?,?,?,?,?,?)",
                         (source, path, epoch, "", lower, position))
        conn.execute("INSERT OR IGNORE INTO transcript_owned VALUES (?)", (source,))


def append_owned(slug, sid, path, recs, incarnation=None):
    """Database commit precedes the compatibility JSONL mirror.

    Previously existing JSONL history is imported lazily. After this first
    commit the DB owns the new suffix even if the mirror cannot be written.

    NEVER SILENTLY LOSES A RECORD (review F1): a locked or broken database
    routes the batch to a durable, fsynced recovery spool — stable
    per-record ids, replayed exactly once, in order, ahead of every later
    write and read. HONEST DOUBLE-FAILURE SEMANTICS: if the spool itself
    cannot be written either (disk gone), the OSError SURFACES to the
    caller with nothing half-committed — a storage failure is reported,
    never swallowed into a silent gap. The caller's JSONL mirror write
    still happens after a successful return, whichever path was taken.

    `incarnation` (reply_events.incarnation) is the collision-safe,
    rename-stable scope for the journal's identity — pass it whenever the
    node is at hand; without it the journal keys by the mutable slug and a
    rename starts a fresh source (the pre-existing behaviour)."""
    # drain BEFORE resolving the name: a pending spool may hold this
    # journal's first commit (which registers the rename-stable alias), and
    # resolving first could split one journal across two source names
    drained = _drain_spool()
    source = journal_source(slug, sid, incarnation)
    entries = [(uuid.uuid4().hex, rec) for rec in recs]
    if drained:
        try:
            _commit_owned(source, str(path), entries,
                          identity=_journal_identity(sid, incarnation))
            return
        except sqlite3.Error:
            pass
    _spool([{"source": source, "path": str(path), "id": record_id,
             "rec": rec, "slug": str(slug), "sid": str(sid),
             **({"scope": str(incarnation)} if incarnation else {})}
            for record_id, rec in entries])


def _known_ranks(conn, source, rows) -> dict:
    known = {}
    for row in rows:
        found = conn.execute("SELECT rank FROM transcript_order WHERE source=? AND event=?",
                             (source, row["event_id"])).fetchone()
        if found:
            known[row["event_id"]] = found[0]
    return known


def _order_epoch(conn, source) -> int:
    row = conn.execute("SELECT epoch FROM transcript_order_meta WHERE source=?",
                       (source,)).fetchone()
    return int(row[0]) if row else 0


def _assign_ranks(conn, source, rows, known, *, force=False) -> bool:
    """One assignment pass. New ranks are written only when every one is
    STRICTLY between its neighbours — a float midpoint that lands on a
    neighbour (precision exhausted, review F9) writes nothing and returns
    False so the caller can renumber first. `force` writes regardless: the
    can't-happen fallback after a renumber, kept so ordering degrades to the
    old collision behaviour rather than an exception."""
    i, pending, ok = 0, [], True
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
        prev = left
        for j in range(i, end):
            rank = left + step * (j - i + 1)
            if not (prev < rank and (right is None or rank < right)):
                ok = False
            rows[j]["seq"] = rank
            pending.append((source, rows[j]["event_id"], rank))
            prev = rank
        i = end
    if pending and (ok or force):
        conn.executemany("INSERT INTO transcript_order VALUES (?,?,?)", pending)
    return ok


def _rebalance(conn, source) -> None:
    """Renumber every rank for `source` to a uniform 1024 spacing, keeping
    the exact relative order, and bump the source's order epoch — served in
    the payload as `order_epoch` so a client can tell its held seq values
    no longer compare against fresh ones."""
    ranked = conn.execute("SELECT event FROM transcript_order WHERE source=? ORDER BY rank, event",
                          (source,)).fetchall()
    conn.execute("DELETE FROM transcript_order WHERE source=?", (source,))
    conn.executemany("INSERT INTO transcript_order VALUES (?,?,?)",
                     ((source, event, float((n + 1) * 1024))
                      for n, (event,) in enumerate(ranked)))
    conn.execute("INSERT INTO transcript_order_meta VALUES (?,1) "
                 "ON CONFLICT(source) DO UPDATE SET epoch=epoch+1", (source,))


def order(source: str, rows: list[dict]) -> int:
    """Stable numeric handles, including lazy prepends and late inserted
    mail; returns the source's ORDER EPOCH. All-known rows take no write
    lock (review F6). When repeated insertion between the same neighbours
    exhausts float precision, the source is renumbered once — same relative
    order, fresh gaps — and the epoch increments instead of two rows ever
    sharing a rank (review F9)."""
    if not rows:
        with database() as conn:
            return _order_epoch(conn, source)
    with database() as conn:
        # deferred read transaction: ranks and epoch from one snapshot
        conn.execute("BEGIN")
        known = _known_ranks(conn, source, rows)
        if len(known) == len({row["event_id"] for row in rows}):
            for row in rows:
                row["seq"] = known[row["event_id"]]
            return _order_epoch(conn, source)
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        known = _known_ranks(conn, source, rows)
        if not _assign_ranks(conn, source, rows, known):
            _rebalance(conn, source)
            known = _known_ranks(conn, source, rows)
            _assign_ranks(conn, source, rows, known, force=True)
        return _order_epoch(conn, source)
