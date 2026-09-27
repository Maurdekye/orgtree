"""Bounded content revisions and lossless conditional transport for the tree.

The old endpoint remains available to legacy clients. Opted-in clients get the
same complete view, a field delta from an exact cached base, or a 304. A changed
input stamp may rebuild the projection; it cannot force a full wire body when
the displayed content did not change.
"""
from __future__ import annotations

from collections import OrderedDict
import gzip
import hashlib
import json
import threading
import time
from typing import Any, Callable
import weakref

from . import pgfeed, pgstore, store, tree_delta

MAX_ORGS = 8
MAX_VERSIONS = 3
MAX_BYTES = 32 * 1024 * 1024
IDLE_S = 60.0
_lock = threading.RLock()
_cache: OrderedDict = OrderedDict()
_build_locks: weakref.WeakValueDictionary = weakref.WeakValueDictionary()
_sweeper: threading.Timer | None = None


def _sweep() -> None:
    global _sweeper
    with _lock:
        now = time.monotonic()
        for key, entry in list(_cache.items()):
            if now - entry['used'] >= IDLE_S:
                del _cache[key]
        _sweeper = None
        if _cache:
            _arm_sweep()


def _arm_sweep() -> None:
    global _sweeper
    if _sweeper is None:
        _sweeper = threading.Timer(IDLE_S, _sweep)
        _sweeper.daemon = True
        _sweeper.start()


def _committed(slug: str) -> tuple[int, int] | None:
    if store.STORE_BACKEND != 'postgres':
        return None
    return store._bounded_read(slug, lambda conn: (int(conn.org_id), pgstore.revision(conn)))


def _bytes(value: Any) -> tuple[bytes, bytes]:
    body = tree_delta.encode(value)
    # Compress once per representation, at the cheapest zlib level. Browser
    # content decoding is standard; the reconstructed tree loses no fields.
    return body, gzip.compress(body, compresslevel=1, mtime=0)


def _size(entry: dict[str, Any]) -> int:
    return sum(len(v['top']) + sum(map(len, v['nodes'].values())) +
               (sum(map(len, v['wire'])) if v['wire'] else 0)
               for v in entry['versions'].values()) \
        + sum(sum(map(len, value)) for value in entry['deltas'].values())


def _revision(version):
    top = json.loads(version['top'])
    for key in tree_delta.WATERMARKS:
        top.pop(key, None)
    # Hash the short per-node digests, not every unchanged charter/turn again.
    return hashlib.sha256(tree_delta.encode([top, sorted(version['hashes'].items())])).hexdigest()[:32]


def _version(tree):
    nodes = {nid:tree_delta.encode(row) for nid,row in tree_delta.flatten(tree).items()}
    return {'top':tree_delta.encode({**tree, 'roots':[n['id'] for n in tree['roots']]}),
            'nodes':nodes, 'hashes':{nid:hashlib.sha256(row).hexdigest() for nid,row in nodes.items()},
            'wire':None}


def _status_version(before, changed, watermarks):
    version = {**before, 'nodes':dict(before['nodes']), 'hashes':dict(before['hashes']), 'wire':None}
    for nid, values in changed.items():
        if nid not in version['nodes']:
            return None
        row = json.loads(version['nodes'][nid])
        row.update(values)
        body = tree_delta.encode(row)
        version['nodes'][nid] = body
        version['hashes'][nid] = hashlib.sha256(body).hexdigest()
    version['top'] = tree_delta.encode({**json.loads(before['top']), **watermarks})
    return version


def _full(version, token):
    if version['wire'] is None:
        rows = {nid:json.loads(body) for nid,body in version['nodes'].items()}
        def build(nid):
            row = rows[nid]
            return {**row, 'children':[build(child) for child in row['children']]}
        top = json.loads(version['top'])
        tree = {**top, 'roots':[build(nid) for nid in top['roots']]}
        version['wire'] = _bytes(tree_delta.full(tree, token))
    return version['wire']


def _delta(before, after, base, token, watermarks):
    nodes = {}
    for nid, body in after['nodes'].items():
        old = before['nodes'].get(nid)
        if old != body:
            nodes[nid] = tree_delta.changed(json.loads(old) if old else {}, json.loads(body))
    return _bytes({'format':tree_delta.FORMAT, 'base':base, 'revision':token,
        'top':tree_delta.changed(json.loads(before['top']), {**json.loads(after['top']), **watermarks}),
        'nodes':nodes, 'removed':[nid for nid in before['nodes'] if nid not in after['nodes']]})


def _tag(token: str) -> str:
    # Weak: gzip and identity share a semantic validator, as do snapshots
    # differing only in conservative replay watermarks.
    return 'W/"tree-' + token + '"'


def _token(tag: str) -> str:
    return tag[8:-1] if tag.startswith('W/"tree-') and tag.endswith('"') else ''


def read(slug: str, public: bool, since: str, *, stamp: Callable[[], str],
         build: Callable[[], dict[str, Any]], feed: pgfeed.RevisionFeed | None = None,
         compressed: bool = False, fast=None) -> tuple[str, bytes | None, dict[str, str]]:
    key = (str(store.DATA_ROOT), slug, public)
    with _lock:
        build_lock = _build_locks.setdefault(key, threading.RLock())
    with build_lock:
        now = time.monotonic()
        with _lock:
            entry = _cache.get(key)
            if entry and now - entry['used'] >= IDLE_S:
                entry = None
        committed = _committed(slug)
        if committed is not None:
            previous = entry.get('committed') if entry else None
            after = previous[1] if previous and previous[0] == committed[0] else None
            if not pgfeed.snapshot_changes_published(feed, slug, after, committed[1]):
                # The commit is newer than the delivered feed/local evidence.
                # Publish unknown BEFORE cached_org can serve this request.
                store.external_change(slug)
        current = (committed, stamp())  # read before build, never afterwards
        if entry is None or entry['stamp'] != current:
            mark = fast.mark() if fast else None
            update = fast.update(entry.get('fast'), mark) if fast and entry else None
            version = _status_version(entry['versions'][entry['token']], update[0], update[1]) if update else None
            if version is not None:
                watermarks = update[1]
                fast_state = update[2]
            else:
                tree = build()
                version = _version(tree)
                watermarks = {k:tree[k] for k in tree_delta.WATERMARKS if k in tree}
                fast_state = fast.capture(mark) if fast else None
            if committed is not None:
                # Read-before-build: safe even if a later feed frame arrived.
                watermarks = {**watermarks, 'org_rev':committed[1]}
            token = _revision(version)
            versions = OrderedDict(entry['versions']) if entry else OrderedDict()
            if token not in versions:
                versions[token] = version
            versions.move_to_end(token)
            while len(versions) > MAX_VERSIONS:
                versions.popitem(last=False)
            entry = {'stamp': current, 'committed': committed, 'token': token,
                     'versions': versions, 'watermarks': watermarks,
                     'deltas': {}, 'used': now, 'fast':fast_state}
        entry['used'] = now
        token = entry['token']
        headers = {('X-Orgtree-Sync-Rev' if k == 'sync_rev' else 'X-Orgtree-Org-Rev'): str(v)
                   for k, v in entry['watermarks'].items()}
        base = _token(since)
        result = None
        if base != token:
            current_version = entry['versions'][token]
            if base in entry['versions']:
                if base not in entry['deltas']:
                    patch = _delta(entry['versions'][base], current_version, base, token, entry['watermarks'])
                    # A topology overhaul can be cheaper as a full snapshot.
                    size = len(current_version['top']) + sum(map(len, current_version['nodes'].values()))
                    entry['deltas'][base] = patch if len(patch[0]) < size else _full(current_version, token)
                wire = entry['deltas'][base]
            else:
                wire = _full(current_version, token)
            result = wire[1 if compressed else 0]
        with _lock:
            _cache[key] = entry
            _cache.move_to_end(key)
            while len(_cache) > MAX_ORGS or sum(_size(e) for e in _cache.values()) > MAX_BYTES:
                _cache.popitem(last=False)
            if _cache:
                _arm_sweep()
        return _tag(token), result, headers


def accepts_gzip(header: str) -> bool:
    # Respect an explicit q=0; do not enable compression from a substring.
    values: dict[str, float] = {}
    for part in header.lower().split(','):
        bits = [v.strip() for v in part.split(';')]
        quality = 1.0
        for parameter in bits[1:]:
            if parameter.startswith('q='):
                try:
                    quality = float(parameter[2:])
                except ValueError:
                    quality = 0.0
        values[bits[0]] = quality
    return values.get('gzip', values.get('*', 0)) > 0
