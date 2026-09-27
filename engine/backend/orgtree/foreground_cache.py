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
MAX_VERSIONS = 3
MAX_BYTES = 32 * 1024 * 1024
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


def _version(payload):
    nodes = {nid: tree_delta.encode(row) for nid, row in payload['nodes'].items()}
    return {'top': tree_delta.encode({k: v for k, v in payload.items() if k != 'nodes'}),
            'nodes': nodes, 'hashes': {nid: hashlib.sha256(row).hexdigest() for nid, row in nodes.items()},
            'wire': None}


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
    # Conservative double-counting of shared byte rows keeps the cap strict.
    return sum(len(v['top']) + sum(map(len, v['nodes'].values())) +
               (sum(map(len, v['wire'])) if v['wire'] else 0)
               for v in entry['versions'].values()) + \
        sum(sum(map(len, wire)) for wire in entry['deltas'].values())


def _status(raw, slug, entry, stamp, mark, feed):
    previous = entry['stamp']
    state = entry['fast']
    if state is None or state['mark'][1] != mark[1]:
        return None
    if any(previous[k] != stamp[k] for k in ('org_id', 'catalog_revision', 'view_revision')):
        return None
    if not pgfeed.snapshot_changes_published(feed, slug, previous['org_revision'], stamp['org_revision']):
        return None
    change = tree_changes.since(store.DATA_ROOT, slug, state['mark'][0], mark[0])
    if change is None:
        return None
    keys, ids, structural = change
    if structural or keys - {'nodes', 'log'}:
        return None
    # Direct SQL node changes also advance the index, but not the local
    # journal. Any extra write makes this proof incomplete. Repeated writes
    # to one node may fall back unnecessarily; they can never conceal a row.
    if stamp['node_revision'] - previous['node_revision'] != len(ids):
        return None
    if not ids <= state['hashes'].keys():
        return None
    rows = storage._rows(raw, list(ids))
    changes = {}
    for nid, row in rows.items():
        if row['meta']['state'] != 'live' or tree_fast.signature(row['node']) != state['hashes'][nid]:
            return None
        changes[nid] = {'last_status': row['node'].get('last_status')}
    old = entry['versions'][entry['token']]
    version = {**old, 'nodes': dict(old['nodes']), 'hashes': dict(old['hashes']), 'wire': None}
    for nid, change in changes.items():
        body = tree_delta.encode({**json.loads(version['nodes'][nid]), **change})
        version['nodes'][nid] = body
        version['hashes'][nid] = hashlib.sha256(body).hexdigest()
    return version, state['hashes']


def read(slug, public, since, *, include=(), runtime, sync_revision, build,
         compressed=False, feed=None):
    """build(raw, graph) returns an annotated/scrubbed foreground snapshot."""
    selected = tuple(sorted(storage._wanted(include)))
    key = (str(store.DATA_ROOT), slug, public, selected)
    with _lock:
        builder = _builders.setdefault(key, threading.RLock())
    with builder:
        now = time.monotonic()
        with _lock:
            entry = _cache.get(key)
            if entry is not None and now - entry['used'] >= IDLE_S:
                entry = None
        # Read replay/runtime evidence BEFORE the DB snapshot. If they move
        # during assembly the result stays coherent, but loses fast-path trust.
        mark = (store.org_seq(slug), runtime())
        sync = sync_revision()
        def refresh(raw, stamp):
            nonlocal entry
            watermarks = {'org_rev': stamp['org_revision'], 'sync_rev': sync}
            if entry is None or entry['stamp'] != stamp or entry['runtime'] != mark[1]:
                fast = _status(raw, slug, entry, stamp, mark, feed) if entry else None
                if fast is None:
                    graph = storage.select_foreground(raw, stamp, selected)
                    payload = build(raw, graph)
                    payload.update(watermarks)
                    version = _version(payload)
                    hashes = {nid: tree_fast.signature(row['node']) for nid, row in graph['rows'].items()}
                else:
                    version, hashes = fast
                version['top'] = tree_delta.encode({**json.loads(version['top']), **watermarks})
                token = _token(version)
                versions = OrderedDict(entry['versions']) if entry else OrderedDict()
                versions[token] = version
                versions.move_to_end(token)
                while len(versions) > MAX_VERSIONS:
                    versions.popitem(last=False)
                # A racing save/runtime change prevents trusting this journal
                # baseline on the next read. The DB stamp is never restamped.
                stable = mark == (store.org_seq(slug), runtime())
                entry = {'stamp': stamp, 'runtime': mark[1], 'token': token,
                         'versions': versions, 'deltas': {}, 'used': now,
                         'fast': {'mark': mark, 'hashes': hashes} if stable else None}
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
        with _lock:
            _cache[key] = entry
            _cache.move_to_end(key)
            while len(_cache) > MAX_ENTRIES or sum(_size(e) for e in _cache.values()) > MAX_BYTES:
                _cache.popitem(last=False)
            if _cache:
                _arm_sweep()
        return result
