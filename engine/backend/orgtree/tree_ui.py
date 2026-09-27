"""Bounded content revisions and lossless conditional transport for the tree.

The old endpoint remains available to legacy clients. Opted-in clients get the
same complete view, a field delta from an exact cached base, or a 304. A changed
input stamp may rebuild the projection; it cannot force a full wire body when
the displayed content did not change.
"""
from __future__ import annotations

from collections import OrderedDict
import gzip
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
    return sum(len(v['body']) + sum(map(len, v['wire'])) for v in entry['versions'].values()) \
        + sum(sum(map(len, value)) for value in entry['deltas'].values())


def _tag(token: str) -> str:
    # Weak: gzip and identity share a semantic validator, as do snapshots
    # differing only in conservative replay watermarks.
    return 'W/"tree-' + token + '"'


def _token(tag: str) -> str:
    return tag[8:-1] if tag.startswith('W/"tree-') and tag.endswith('"') else ''


def read(slug: str, public: bool, since: str, *, stamp: Callable[[], str],
         build: Callable[[], dict[str, Any]], feed: pgfeed.RevisionFeed | None = None,
         compressed: bool = False) -> tuple[str, bytes | None, dict[str, str]]:
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
            tree = build()
            if committed is not None:
                # A concurrently received feed event may name a later revision
                # than this build's validation. Keep the replay stamp honest.
                tree = {**tree, 'org_rev': committed[1]}
            token = tree_delta.revision(tree)
            versions = OrderedDict(entry['versions']) if entry else OrderedDict()
            if token not in versions:
                # Retain immutable bytes, not mutable supervisor/doc structures.
                versions[token] = {'body': tree_delta.encode(tree),
                                   'wire': _bytes(tree_delta.full(tree, token))}
            versions.move_to_end(token)
            while len(versions) > MAX_VERSIONS:
                versions.popitem(last=False)
            watermarks = {k: tree[k] for k in tree_delta.WATERMARKS if k in tree}
            entry = {'stamp': current, 'committed': committed, 'token': token,
                     'versions': versions, 'watermarks': watermarks,
                     'deltas': {}, 'used': now}
        entry['used'] = now
        token = entry['token']
        headers = {('X-Orgtree-Sync-Rev' if k == 'sync_rev' else 'X-Orgtree-Org-Rev'): str(v)
                   for k, v in entry['watermarks'].items()}
        base = _token(since)
        result = None
        if base != token:
            current_version = entry['versions'][token]
            wire = current_version['wire']
            if base in entry['versions']:
                if base not in entry['deltas']:
                    before = json.loads(entry['versions'][base]['body'])
                    after_tree = {**json.loads(current_version['body']), **entry['watermarks']}
                    patch = _bytes(tree_delta.delta(before, after_tree, base, token))
                    # A topology overhaul may be smaller as a full snapshot.
                    entry['deltas'][base] = patch if len(patch[0]) < len(wire[0]) else wire
                wire = entry['deltas'][base]
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
