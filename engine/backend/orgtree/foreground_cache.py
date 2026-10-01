"""Bounded foreground responses, validated in a fresh committed snapshot.

No complete Org, history rows, raw node bodies or database connections survive
in this cache. The status shortcut needs both a complete published change set
and unchanged signatures for precisely the selected changed nodes. Unknown
history, direct writes, runtime changes and non-status edits rebuild only the
selected foreground through the ordinary projector.
"""
from __future__ import annotations

from collections import OrderedDict
import gzip
import hashlib
import json
import threading
import time
import weakref

from . import foreground_store as storage, foreground_view as view
from . import pgfeed, store, tree_changes, tree_delta, tree_fast

MAX_ENTRIES = 8
#: versions kept per entry as delta bases. Unchanged rows share their bytes
#: across versions, so an extra version costs its changed rows, not a copy of
#: the tree. Several windows re-reading one busy tree each need their own base
#: still here (N1000 attempt 9: 3 versions and 4 windows meant a full 7.7 MB
#: answer for almost every read).
MAX_VERSIONS = 16
MAX_BYTES = 32 * 1024 * 1024
#: entries that keep a reusable projection (a whole context: O(selected
#: nodes) in memory); older entries drop it and rebuild on their next change
MAX_SAVED = 2
IDLE_S = 60.0
_lock = threading.RLock()
_cache: OrderedDict = OrderedDict()
_builders: weakref.WeakValueDictionary = weakref.WeakValueDictionary()
_sweeper: threading.Timer | None = None


def _sweep():
    global _sweeper
    with _lock:
        now = time.monotonic()
        for key, entry in list(_cache.items()):
            if now - entry['used'] >= IDLE_S:
                del _cache[key]
        _sweeper = None
        if _cache:
            _arm_sweep()


def _arm_sweep():
    global _sweeper
    if _sweeper is None:
        _sweeper = threading.Timer(IDLE_S, _sweep)
        _sweeper.daemon = True
        _sweeper.start()


def _wire(payload):
    body = tree_delta.encode(payload)
    return body, gzip.compress(body, compresslevel=1, mtime=0)


def _version(payload, previous=None, same=None):
    """Encoded rows and hashes of a payload. `previous` = (version, rows) of
    the version this one replaces: a node whose projected dict compares equal
    keeps its bytes and hash instead of being encoded and hashed again
    (foreground-tree F3b-3). Python equality treats True/1/1.0 and 0.0/-0.0 as
    equal; such a type-only flip keeps the previous spelling until that node
    changes otherwise (the decoded value is the same). `same` = a version
    whose byte-identical rows are shared instead of kept twice (a full
    rebuild after a change the cache could not prove)."""
    old, rows = previous if previous is not None else (None, {})
    nodes, hashes = {}, {}
    for nid, row in payload['nodes'].items():
        if old is not None and nid in old['nodes'] and rows.get(nid) == row:
            nodes[nid], hashes[nid] = old['nodes'][nid], old['hashes'][nid]
        else:
            nodes[nid] = tree_delta.encode(row)
            kept = same['nodes'].get(nid) if same is not None else None
            if kept is not None and kept == nodes[nid]:
                nodes[nid], hashes[nid] = kept, same['hashes'][nid]
            else:
                hashes[nid] = hashlib.sha256(nodes[nid]).hexdigest()
    return {'top': tree_delta.encode({k: v for k, v in payload.items() if k != 'nodes'}),
            'nodes': nodes, 'hashes': hashes, 'wire': None}


def _token(version):
    top = json.loads(version['top'])
    for key in ('org_rev', 'sync_rev', 'revision'):
        top.pop(key, None)
    return hashlib.sha256(tree_delta.encode([top, sorted(version['hashes'].items())])).hexdigest()[:32]


def _tag(token):
    return 'W/"foreground-' + token + '"'


def _base(tag):
    return tag[14:-1] if tag.startswith('W/"foreground-') and tag.endswith('"') else ''


def _full(version, token):
    if version['wire'] is None:
        version['wire'] = _wire({**json.loads(version['top']), 'revision': token,
            'nodes': {nid: json.loads(row) for nid, row in version['nodes'].items()}})
    return version['wire']


def _delta(before, after, base, token, watermarks):
    old, new = json.loads(before['top']), json.loads(after['top'])
    nodes = {}
    for nid, body in after['nodes'].items():
        previous = before['nodes'].get(nid)
        if previous != body:
            change = tree_delta.changed(json.loads(previous) if previous else {}, json.loads(body))
            nodes[nid] = {'set': change['set'], 'unset': change['remove']}
    header = tree_delta.changed(old['header'], new['header'])
    return _wire({'format': view.FORMAT, 'kind': 'delta', 'base': base, 'revision': token,
        **watermarks, 'catalog_revision': new['catalog_revision'], 'roots': new['roots'],
        'missing_requested': new['missing_requested'],
        'header': {'set': header['set'], 'unset': header['remove']}, 'nodes': nodes,
        'removed': [nid for nid in before['nodes'] if nid not in after['nodes']]})


def _size(entry):
    """Bytes the entry retains. Versions share unchanged rows (the same bytes
    object), so each object counts once: counting it once per version made
    three versions of an N1000 tree exceed MAX_BYTES and evicted the only
    entry, so the next read rebuilt from nothing and sent the whole tree."""
    seen = set()
    total = 0
    def count(blob):
        nonlocal total
        if id(blob) not in seen:
            seen.add(id(blob))
            total += len(blob)
    for version in entry['versions'].values():
        count(version['top'])
        for blob in version['nodes'].values():
            count(blob)
        for blob in version['wire'] or ():
            count(blob)
    for wire in entry['deltas'].values():
        for blob in wire:
            count(blob)
    return total


def _shed(entry):
    """Drop an entry's cached deltas and oldest bases (never its current
    version) until it fits the byte budget on its own."""
    versions = entry['versions']
    entry['deltas'] = {}
    while len(versions) > 1 and _size(entry) > MAX_BYTES:
        oldest = next(iter(versions))
        if oldest == entry['token']:
            versions.move_to_end(oldest)
        else:
            del versions[oldest]
    entry['bytes'] = _size(entry)


def _db(stamp):
    """The committed-content part of a snapshot stamp (`seq` is this process's
    journal position, pinned with the snapshot, not content)."""
    return {k: v for k, v in stamp.items() if k != 'seq'}


def _changes(raw, slug, entry, stamp, feed):
    """What changed since the entry's snapshot, when that is provable, else None:
    {'rows': fresh rows of exactly the changed nodes,
     'status': {nid: fields} when only status fields of live nodes changed and
               nothing else the projection reads moved, else None}."""
    previous = entry['stamp']
    state = entry['fast']
    if state is None:
        return None
    if any(previous[k] != stamp[k] for k in ('org_id', 'catalog_revision')):
        return None
    if not pgfeed.snapshot_changes_published(feed, slug, previous['org_revision'], stamp['org_revision']):
        return None
    # Both positions were pinned with their snapshots (foreground_store
    # ._snapshot), so this is exactly the set of local changes between them.
    change = tree_changes.since_detail(store.DATA_ROOT, slug, state['seq'], stamp['seq'])
    if change is None or change['structural']:
        return None
    ids = change['nodes']
    # Direct SQL node writes also advance node_revision, but not the local
    # journal: the counts agree only when every node row written since is one
    # of `ids`. Unchanged rows are reused, so this proof is what keeps them.
    if stamp['node_revision'] - previous['node_revision'] != change['node_writes']:
        return None
    if not ids <= state['hashes'].keys():
        return None
    rows = storage._rows(raw, list(ids))
    status = None
    if previous['view_revision'] == stamp['view_revision'] and not change['keys'] - {'nodes', 'log'}:
        status = {}
        for nid, row in rows.items():
            if row['meta']['state'] != 'live' or tree_fast.signature(row['node']) != state['hashes'][nid]:
                status = None
                break
            status[nid] = {'last_status': row['node'].get('last_status')}
    return {'rows': rows, 'status': status}


def _patch_status(entry, changes):
    """The cached version with only these status fields changed."""
    old = entry['versions'][entry['token']]
    version = {**old, 'nodes': dict(old['nodes']), 'hashes': dict(old['hashes']), 'wire': None}
    for nid, change in changes.items():
        body = tree_delta.encode({**json.loads(version['nodes'][nid]), **change})
        version['nodes'][nid] = body
        version['hashes'][nid] = hashlib.sha256(body).hexdigest()
    return version


def _patch_saved(saved, changes):
    """Keep a reusable projection's inputs in step with a status patch, so a
    later reprojection can never bring back a pre-change field."""
    for nid, change in changes.items():
        saved['graph']['rows'][nid]['node'].update(change)
        saved['context'].nodes[nid].update(change)


def read(slug, public, since, *, include=(), runtime, sync_revision, build,
         compressed=False, feed=None, reproject=None, advance=None, piles=None):
    """build(raw, graph) returns an annotated/scrubbed foreground snapshot, or
    (snapshot, saved) when reproject(saved) can repeat its in-memory
    projection (context, header, annotation) without reading storage, and
    advance(raw, saved, stamp, rows) moves saved to a newer snapshot given the
    fresh rows of exactly the nodes that changed.

    ``piles`` (saved fronts) also selects every visible retired pile's edge
    rows. They move only with ``catalog_revision``, and a changed catalog
    already rebuilds (`_changes`), so the delta paths below stay exact."""
    selected = tuple(sorted(storage._wanted(include)))
    fronts = None if piles is None else storage._fronts(dict(piles))
    key = (str(store.DATA_ROOT), slug, public, selected, fronts)
    with _lock:
        builder = _builders.setdefault(key, threading.RLock())
    with builder:
        now = time.monotonic()
        with _lock:
            entry = _cache.get(key)
            if entry is not None and now - entry['used'] >= IDLE_S:
                entry = None
        # Runtime evidence is read BEFORE the DB snapshot: if it moves during
        # assembly, the next read sees a different value and reprojects.
        run = runtime()
        sync = sync_revision()
        def refresh(raw, stamp):
            nonlocal entry
            watermarks = {'org_rev': stamp['org_revision'], 'sync_rev': sync}
            db = _db(stamp)
            if entry is None or entry['stamp'] != db or entry['runtime'] != run:
                saved = entry.get('saved') if entry else None
                if saved is not None and not saved.get('valid', lambda: True)():
                    saved = None
                    changes = None                  # past a clock deadline: build afresh
                elif entry is None:
                    changes = None
                elif entry['stamp'] == db:
                    changes = {'rows': {}, 'status': {}}      # nothing committed
                else:
                    changes = _changes(raw, slug, entry, stamp, feed)
                hashes = dict(entry['fast']['hashes']) if changes is not None else None
                reusable = (changes is not None and saved is not None and reproject is not None
                            and (changes['status'] is not None or advance is not None))
                if changes is not None and changes['status'] is not None and entry['runtime'] == run:
                    version = _patch_status(entry, changes['status'])
                    if saved is not None:
                        _patch_saved(saved, changes['status'])
                    rows = entry.get('rows')
                    if rows is not None:
                        rows = {**rows, **{nid: json.loads(version['nodes'][nid]) for nid in changes['status']}}
                elif reusable:
                    if changes['status'] is not None:
                        _patch_saved(saved, changes['status'])
                    else:
                        saved = advance(raw, saved, stamp, changes['rows'])
                        hashes.update({nid: tree_fast.signature(row['node'])
                                       for nid, row in changes['rows'].items()})
                    payload = reproject(saved)
                    payload.update(watermarks)
                    rows = entry.get('rows')
                    version = _version(payload, (entry['versions'][entry['token']], rows)
                                       if rows is not None else None)
                    rows = payload['nodes']
                else:
                    graph = storage.select_foreground(raw, stamp, selected, piles=fronts)
                    built = build(raw, graph)
                    payload, saved = built if isinstance(built, tuple) else (built, None)
                    payload.update(watermarks)
                    version = _version(payload, same=entry['versions'][entry['token']] if entry else None)
                    rows = payload['nodes']
                    hashes = {nid: tree_fast.signature(row['node']) for nid, row in graph['rows'].items()}
                version['top'] = tree_delta.encode({**json.loads(version['top']), **watermarks})
                token = _token(version)
                versions = OrderedDict(entry['versions']) if entry else OrderedDict()
                versions[token] = version
                versions.move_to_end(token)
                while len(versions) > MAX_VERSIONS:
                    versions.popitem(last=False)
                # Only the current version is ever sent whole; an older base
                # answers with a delta, so its full body is dead weight.
                for other, kept in list(versions.items()):
                    if other != token and kept['wire'] is not None:
                        versions[other] = {**kept, 'wire': None}
                entry = {'stamp': db, 'runtime': run, 'token': token, 'rows': rows,
                         'versions': versions, 'deltas': {}, 'used': now, 'saved': saved,
                         'fast': {'seq': stamp['seq'], 'hashes': hashes}}
            entry['used'] = now
            token = entry['token']
            current = entry['versions'][token]
            base = _base(since)
            result = None
            if base != token:
                if base in entry['versions']:
                    if base not in entry['deltas']:
                        patch = _delta(entry['versions'][base], current, base, token, watermarks)
                        full_size = len(current['top']) + sum(map(len, current['nodes'].values()))
                        entry['deltas'][base] = patch if len(patch[0]) < full_size else _full(current, token)
                    wire = entry['deltas'][base]
                else:
                    wire = _full(current, token)
                result = wire[1 if compressed else 0]
            headers = {'X-Orgtree-Org-Rev': str(watermarks['org_rev']),
                       'X-Orgtree-Sync-Rev': str(watermarks['sync_rev']),
                       'X-Orgtree-Catalog-Rev': f"{stamp['org_id']}:{stamp['catalog_revision']}"}
            return _tag(token), result, headers
        result = storage.read_snapshot(slug, refresh)
        entry['bytes'] = _size(entry)
        with _lock:
            _cache[key] = entry
            _cache.move_to_end(key)
            for older in list(_cache.values())[:-MAX_SAVED]:
                older['saved'] = None
            # The entry just served is the newest and is never evicted by its
            # own read: older entries go first, then its own oldest bases.
            while len(_cache) > MAX_ENTRIES or sum(e['bytes'] for e in _cache.values()) > MAX_BYTES:
                if len(_cache) == 1:
                    _shed(entry)
                    break
                _cache.popitem(last=False)
            if _cache:
                _arm_sweep()
        return result
