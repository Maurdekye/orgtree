"""Capture transcript records independently of whether an agent desk is open.

Active conversations are caught up every second and at both turn boundaries.
Existing histories are imported in bounded background slices; projection into
UI messages remains demand-driven. Provider files are retained for CLI resume.
"""
from __future__ import annotations

import collections
import logging
import threading
import time

_log = logging.getLogger(__name__)
_lock = threading.Lock()
_started = False
_fresh: set[str] = set()


def capture(slug, nid, *, beginning=False, backfill=False):
    from . import store, supervisor as sup, transcript_records as records
    from .chat_window import source_key
    from .desktop_import import imported_history_path
    org = store.load_org(slug)
    node = org.node(nid)
    if not node.get('session_id'):
        return
    key = source_key(org, nid)
    path = sup.transcript_path(node['session_id'], sup._transcript_root(org, nid))
    if beginning and not path:
        with _lock:
            _fresh.add(key)
    sources = [(key, path)]
    if backfill:
        sources.append((source_key(org, nid, True), imported_history_path(org, nid)))
    for source, filename in sources:
        if not filename:
            continue
        with _lock:
            fresh = source in _fresh
        count = 1
        if fresh:
            # Registered before the first provider record: capture the entire
            # new file on discovery, then only suffixes on later passes.
            count = 1 << 50
        elif backfill:
            with records.database() as conn:
                have = conn.execute('SELECT COUNT(*) FROM transcript_records WHERE source=?', (source,)).fetchone()[0]
            count = have + 64
        records.ingest(source, str(filename), count, {'bytes_read': 0})
        with _lock:
            _fresh.discard(source)
    views = getattr(records, 'ingest_prompt_views', None)
    if views is not None:
        views(key, sup._prompt_view_path(slug, node['session_id']))


def capture_safely(slug, nid, **kwargs):
    try:
        capture(slug, nid, **kwargs)
    except Exception:
        # Capture must be retried by the worker. Never claim migration complete
        # or discard source files when a database/file read failed.
        _log.exception('Transcript capture failed for %s/%s; source retained for retry', slug, nid)


def start():
    global _started
    with _lock:
        if _started:
            return
        _started = True

    def run():
        from . import store, supervisor as sup
        queue = collections.deque()
        refreshed = 0.0
        while True:
            try:
                now = time.monotonic()
                if not queue or now - refreshed > 60:
                    queue.clear()
                    for row in store.list_orgs():
                        org = store.load_org(row['slug'])
                        queue.extend((row['slug'], nid) for nid in org.nodes)
                    refreshed = now
                with sup._state_lock:
                    active = [key for key, state in sup._state.items() if state.get('busy')]
                for slug, nid in active:
                    capture_safely(slug, nid)
                # Round-robin older ranges so one long transcript cannot starve
                # another. No complete projection/parser or UI mounting occurs.
                for _ in range(min(8, len(queue))):
                    slug, nid = queue.popleft()
                    capture_safely(slug, nid, backfill=True)
            except Exception:
                _log.exception('Transcript capture sweep failed; retrying')
            time.sleep(1)

    threading.Thread(target=run, name='transcript-capture', daemon=True).start()
