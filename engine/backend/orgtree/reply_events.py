"""Immutable reply snapshots: references never relocate to another event."""
import hashlib
import json
import threading
from pathlib import Path
import sqlite3
import uuid
from . import store


def _connect():
    path = Path(store.DATA_ROOT) / 'reply-events.sqlite3'
    connection = sqlite3.connect(path, timeout=15)
    connection.execute('CREATE TABLE IF NOT EXISTS events (org TEXT, agent TEXT, generation INTEGER, id TEXT, text TEXT, scope TEXT, PRIMARY KEY(org,agent,generation,id))')
    # WAL so a commit is one WAL append instead of a rollback-journal
    # create/fsync/delete pair. synchronous stays FULL: a quoted
    # INTERMEDIATE stream snapshot is not reconstructible from the final
    # row (perf-review round 3 — dropping one leaves its quoted id
    # unresolved forever), so these commits keep the durability the plain
    # journal gave them; the win here is the journal-churn removal only.
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA synchronous=FULL')
    return connection


def _eid(scope, source, kind, quote):
    identity = json.dumps([scope, str(source), kind, quote], ensure_ascii=False)
    return 'reply_' + hashlib.sha256(identity.encode()).hexdigest()


def remember(org, nid, source, kind, text, *, connection=None):
    generation = int(org.node(nid).get('generation') or 0)
    quote = str(text or '')[:4000]
    scope = incarnation(org, nid)
    eid = _eid(scope, source, kind, quote)
    owned = connection is None
    connection = connection or _connect()
    try:
        connection.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)',
                           (org.d['slug'], nid, generation, eid, quote, scope))
        if owned:
            connection.commit()
    finally:
        if owned:
            connection.close()
    return eid


def remember_ident(slug, nid, scope, generation, source, kind, text):
    """`remember` for a caller that resolved identity via `identity()` —
    the stream hot path, which must not load the org document per delta.
    The connect-per-call is deliberate: WAL+NORMAL above already removed the
    per-commit fsync pain, and a cached cross-thread handle outlives its
    thread (it held test teardown hostage on Windows for exactly that)."""
    quote = str(text or '')[:4000]
    eid = _eid(scope, source, kind, quote)
    connection = _connect()
    try:
        connection.execute('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)',
                           (slug, nid, generation, eid, quote, scope))
        connection.commit()
    finally:
        connection.close()
    return eid


# ---------------------------------------------------------- identity cache
# (slug, nid) → (org_seq at population, scope, generation). The incarnation
# pair is immutable once minted, and generation only changes through ops that
# save the document — so "the org's save seq is unchanged" proves the cached
# values are exactly current. This is what lets capture_reply_stream shed the
# DOC_LOCK + full load_org it used to pay per streamed delta (67 ms at 449
# nodes, measured; REPORT.md #1).
_ident_lock = threading.Lock()
_ident_cache = {}


def _ident_forget(slug=None):
    """Test seam / delete hook: drop cached identities (one org or all)."""
    with _ident_lock:
        if slug is None:
            _ident_cache.clear()
        else:
            for key in [k for k in _ident_cache if k[0] == slug]:
                _ident_cache.pop(key, None)


def identity(slug, nid):
    """(scope, generation) without DOC_LOCK and — once cached — without a
    document load. Raises LedgerError if the node does not exist, exactly as
    the load-based path did.

    ⚠ SCOPE AND GENERATION COME FROM ONE READ (perf-review round 2). The
    first draft read generation off the object it loaded BEFORE the mint;
    `incarnation` copies only the incarnation fields back onto that object,
    so a save that advanced the generation between our load and the mint
    left us caching the OLD generation under the CURRENT seq — a stale
    label no later seq check could ever catch. After a mint, everything is
    re-resolved from a fresh load, and the seq the cache entry is stored
    under is read BEFORE that load, so any save landing mid-read fails the
    final unchanged-guard and simply costs one more load next call."""
    key = (slug, nid)
    seq = store.org_seq(slug)
    with _ident_lock:
        hit = _ident_cache.get(key)
    if hit is not None and hit[0] == seq:
        return hit[1], hit[2]
    org = store.load_org(slug)          # read-only: DOC_LOCK is for cycles
    if not (org.d.get('reply_incarnation')
            and org.node(nid).get('reply_incarnation')):
        incarnation(org, nid)           # mints under DOC_LOCK and saves
        seq = store.org_seq(slug)       # the mint's save bumped it…
        org = store.load_org(slug)      # …and ONLY a fresh read is coherent
    scope = org.d['reply_incarnation'] + ':' + org.node(nid)['reply_incarnation']
    generation = int(org.node(nid).get('generation') or 0)
    if store.org_seq(slug) == seq:
        # unchanged across our read — scope and generation describe the
        # document as of `seq`, so the entry is safe to remember under it
        with _ident_lock:
            _ident_cache[key] = (seq, scope, generation)
    return scope, generation


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


def count(slug, nid):
    path = Path(store.DATA_ROOT) / 'reply-events.sqlite3'
    if not path.exists():
        return 0
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=15)
    try:
        return connection.execute('SELECT COUNT(*) FROM events WHERE org=? AND agent=?', (slug, nid)).fetchone()[0]
    finally:
        connection.close()


def clear(org, nid):
    with _connect() as connection:
        deleted = connection.execute('DELETE FROM events WHERE org=? AND agent=?', (org.d['slug'],nid)).rowcount
    connection.close()
    org.node(nid)['reply_incarnation'] = uuid.uuid4().hex
    store.save_org(org)
    return deleted


def clear_org(slug):
    if not (Path(store.DATA_ROOT) / 'reply-events.sqlite3').exists():
        return 0
    with _connect() as connection:
        removed = connection.execute('DELETE FROM events WHERE org=?', (slug,)).rowcount
    connection.close()
    return removed


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
                    row['reply_quote'] = str(row.get('text') or '')[:4000]
                    rows.append(row)
                    continue
                row['reply_quote'] = str(row.get('text') or row.get('body') or row.get('cmd_out') or '')[:4000]
                # THE DURABLE ID SURVIVES THIS REWRITE (user ruling
                # 2026-09-11: "live rows and transcript rows need a singular
                # durable id that can cross-identify them").
                #
                # `event_id` does not leave here intact: every row's is
                # replaced by a reply snapshot id hashed over the incarnation,
                # the source AND the quoted text. A live row and its durable
                # twin therefore cannot match on it even when the emitter gave
                # them one source id — their quotes differ, because the live
                # copy is the capped one.
                #
                # A transcript row already carries its source record's uuid as
                # `native_event_id` (read_chat stamps it) and nothing here
                # touches that. A live row had no such field, so the id its
                # emitter supplied was erased at this line and the two sides
                # arrived at the client mutually unidentifiable. Carrying it
                # across gives both sides the SAME field holding the SAME
                # value, which is the whole point.
                #
                # Only a genuinely durable source: the `live:<boot>:...` form
                # is this server's own per-row counter, matches no record, and
                # would just be noise on the wire.
                if field == 'live' and not str(source).startswith('live:'):
                    row['native_event_id'] = str(source)
                row['event_id'] = save(source, 'row', row['reply_quote'])
                if row.get('thinking') is not None:
                    row['thinking_reply_quote'] = str(row['thinking'] or '')[:4000]
                    row['thinking_event_id'] = save(source, 'thinking', row['thinking_reply_quote'])
                tools = []
                for index, original_tool in enumerate(row.get('tools') or []):
                    if not isinstance(original_tool, dict):
                        tools.append(original_tool)
                        continue
                    tool = dict(original_tool)
                    tool_source = str(source) + ':tool:' + str(tool.get('id') or index)
                    tool['reply_quote'] = (str(tool.get('name') or '') + ' ' +
                        str(tool.get('input') or tool.get('arg') or ''))[:4000]
                    tool['event_id'] = save(tool_source, 'call', tool['reply_quote'])
                    if 'result' in tool:
                        tool['result_reply_quote'] = str(tool['result'] or '')[:4000]
                        tool['result_event_id'] = save(tool_source, 'result', tool['result_reply_quote'])
                    tools.append(tool)
                row['tools'] = tools
            rows.append(row)
        result[field] = rows
    return result
