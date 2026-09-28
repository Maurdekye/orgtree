"""Capture transcript records independently of whether an agent desk is open.

Active conversations are caught up every second and at both turn boundaries.
Existing histories are imported in bounded background slices; projection into
UI messages remains demand-driven. Provider files are retained for CLI resume.

Idle cost (slice C, engine-cpu-per-request-at-n-100): a backfill slice used to
open about five database connections and hash about 12 KB of files for every
node on every pass, even when nothing had changed ("8 agents per second,
forever"). Now a slice that finds the node SETTLED — every source fully
imported, as of a pass whose files had exactly this path, size and mtime — is
skipped with a few stat() calls. File or conversation identity changes make
the next slice run as before. Only ingestion backs off: stat checks keep the
same cadence, so no extra sleep delays a newly appended record. At a stable N,
idle nodes are visited every ceil(N / 8) one-second sleeps plus sweep work;
busy nodes still get one-second capture and both turn-boundary captures.

Cold catch-up (cold-transcript-ingest-at-n1000): active nodes are queued
first from the active index, history waits until every active node settled,
older records come in byte-bounded slices, and while work is pending the
worker works WORK_BUDGET_S and pauses PENDING_PAUSE_S instead of a second.

Shutdown (transcript-capture-loops-on-imported-agents-and): the worker stops
BEFORE the database does. `start()` registers an atexit hook that signals
`stop()` and waits for the thread. launch.py registers the database stop
before the API loads, so earlier, and atexit runs hooks in reverse order: this
one runs first. The worker checks the signal between
captures, so an orderly stop no longer logs one traceback per capture while
PostgreSQL is going down.
"""
from __future__ import annotations

import atexit
import collections
import logging
import os
import threading
import time

_log = logging.getLogger(__name__)
_lock = threading.Lock()
_started = False
_stop = threading.Event()
_thread: threading.Thread | None = None
#: seconds the atexit hook waits for an in-flight capture to finish
STOP_JOIN_S = 10.0
_fresh: set[str] = set()
#: Bounded (slug, nid) -> (settled fingerprint, source keys); durable data is untouched.
_SETTLED_LIMIT = 512
_settled: dict[tuple[str, str], tuple] = collections.OrderedDict()

# Cold catch-up pacing (cold-transcript-ingest-at-n1000, profiled 2026-09-28:
# a first visit costs ~0.1 s, a later slice ~4 ms, and the old fixed 1 s sleep
# was 83% of catch-up time). The worker shares the engine with requests, so
# it works at most WORK_BUDGET_S per tick and then yields: PENDING_PAUSE_S
# while a tick left work unsettled, IDLE_PAUSE_S otherwise, exactly as before.
WORK_BUDGET_S = 0.15
PENDING_PAUSE_S = 0.05
IDLE_PAUSE_S = 1.0
#: Settled nodes re-checked per tick: the old idle cadence of 8 per tick.
IDLE_CHECKS_PER_TICK = 8
#: Older-record bytes one backfill transaction may import per source.
SLICE_BYTES = 256 * 1024
#: Active ids read per bounded query when seeding the active queue.
ACTIVE_PAGE = 256
#: Archived nodes waiting for capture; more are rediscovered next round.
ARCHIVED_PENDING_LIMIT = 64
#: Archived captures allowed per active round while active work is pending,
#: so a node that can never settle cannot starve history for ever.
ARCHIVED_PER_ACTIVE_ROUND = 8
#: A node whose capture keeps raising is retried after 1 s, doubling to 60 s,
#: so a failing node or a database outage costs (and logs) one attempt per
#: backoff step, not one per tick. Bounded; eviction only means an earlier retry.
BACKOFF_BASE_S = 1.0
BACKOFF_MAX_S = 60.0
BACKOFF_LIMIT = 1024


def _remember_settled(key, value):
    # The source database remains authoritative. Eviction only causes another
    # bounded signature/offset check; it never discards transcript records.
    _settled.pop(key, None)
    _settled[key] = value
    while len(_settled) > _SETTLED_LIMIT:
        _settled.pop(next(iter(_settled)))


def _stat(path):
    if not path:
        return None
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return (str(path), None)
    return (str(path), st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_dev, st.st_ino)


def _is_settled(sources, views, fingerprint) -> bool:
    """True when the database holds everything the files had at `fingerprint`:
    each transcript source imported down to byte 0 and (unless the database
    owns it) up to the file's size, and the prompt-view sidecar read to its
    size. A missing file has nothing to import."""
    from . import transcript_records as records
    stats = fingerprint[-2]
    with records.database() as conn:
        for (source, filename), st in zip(sources, stats):
            if not filename or st is None or st[1] is None:
                continue
            meta = conn.execute("SELECT lower_byte, upper_byte FROM transcript_sources WHERE source=?",
                                (source,)).fetchone()
            if meta is None or meta[0] != 0:
                return False
            owned = conn.execute("SELECT 1 FROM transcript_owned WHERE source=?", (source,)).fetchone()
            if not owned and meta[1] != st[1]:
                return False
        vsource, vst = views, fingerprint[-1]
        if vst is not None and vst[1] is not None:
            row = conn.execute("SELECT upper FROM transcript_view_sources WHERE source=?",
                               (vsource,)).fetchone()
            if row is None or row[0] != vst[1]:
                return False
    return True



class _SourceView:
    """Private read-only resolver input; never stored or normalized as Org."""
    _shared_snapshot = True

    def __init__(self, doc):
        self.d = doc
        self.nodes = doc['nodes']

    def node(self, nid):
        return self.nodes[nid]


def _source_view(slug, nid):
    """The capture's source inputs for one node, or None when there is no
    such node.

    transcript-capture-source-view-falls-back-to-a-f: a node whose identity
    was not minted yet (every node's first capture) used to load the whole
    org here, 18.4 CPU-s at N1000. The bounded view serves that case too:
    the mints (records.incarnation -> reply_events.incarnation) read only
    the slug, the org's and the node's reply ids and the node's own
    transcript id, which the view carries from one statement; they persist
    through their own org_tx and never stamp a shared view (_shared_snapshot),
    and capture re-reads the view after minting. A missing `model` or
    `generation` is missing from the whole Org too (no load heal adds them).
    Only a root the bounded read cannot answer at all (the JSON backend, or
    `nodes` stored as one blob) still needs the whole Org."""
    from . import store
    doc = store.read_transcript_source(slug, nid)
    if doc is not None:
        return _SourceView(doc)
    if store.node_row_exists(slug, nid) is False:
        return None
    return store.cached_org(slug)


def capture(slug, nid, *, beginning=False, backfill=False):
    """Capture one node's transcript sources. Returns False only for a
    backfill slice skipped because the node is settled (see module doc)."""
    from . import store, supervisor as sup, transcript_records as records
    from .chat_window import source_key
    from .desktop_import import imported_history_path
    # A database outage can leave durable output in the recovery spool without
    # changing any provider file. Settled-file skips must not starve its replay.
    records._drain_spool()
    # Resolve only source identity/path inputs. Legacy documents still use
    # their existing normalized Org and locked identity initialization.
    org = _source_view(slug, nid)
    if org is None:
        return False            # no such node (removed since it was queued)
    node = org.node(nid)
    if not node.get('session_id'):
        return False
    if not node.get('transcript_incarnation'):
        # Mint the node's identity ONCE, by the same routine and to the same
        # value as before, then re-read the committed view. A shared snapshot
        # is never stamped, so without this every identity lookup below
        # (source_key, its imported twin, views_source) repeated the org_tx
        # mint until the snapshot reloaded: about 12 per node where 2 do.
        records.incarnation(org, nid)
        org = _source_view(slug, nid)
        if org is None:
            return False
        node = org.node(nid)
    path = sup.transcript_path_for_node(org, nid)
    imported = imported_history_path(org, nid) if backfill else None
    vpath = sup._prompt_view_path(slug, node['session_id'])
    fingerprint = None
    if backfill:
        # Check before source_key/views_source: resolving legacy identities can
        # itself open databases. These are their identity inputs, not a second
        # implementation of the source naming/migration rules.
        fingerprint = (str(store.DATA_ROOT), org.d.get('reply_incarnation'),
                       node.get('transcript_incarnation'), node.get('reply_incarnation'),
                       node['session_id'], node.get('model'),
                       (_stat(path), _stat(imported)), _stat(vpath))
        with _lock:
            previous = _settled.get((slug, nid))
            if previous and previous[0] == fingerprint and not any(s in _fresh for s in previous[1]):
                return False
    else:
        with _lock:
            _settled.pop((slug, nid), None)
    key = source_key(org, nid)
    if beginning and not path:
        with _lock:
            _fresh.add(key)
    sources = [(key, path)]
    if backfill:
        sources.append((source_key(org, nid, True), imported))
    vsource = records.views_source(slug, node['session_id'], records.incarnation(org, nid))
    for source, filename in sources:
        if not filename:
            continue
        with _lock:
            fresh = source in _fresh
        count = 1
        max_bytes = None
        if fresh:
            # Registered before the first provider record: capture the entire
            # new file on discovery, then only suffixes on later passes.
            count = 1 << 50
        elif backfill:
            with records.database() as conn:
                meta = conn.execute('SELECT lower_byte FROM transcript_sources WHERE source=?',
                                    (source,)).fetchone()
                # A fully imported source needs signature/suffix checking,
                # not COUNT(*) over all its lifetime records.
                needs_history = not meta or bool(meta[0])
            if not needs_history:
                # A replacement may create a new epoch. Preserve the old
                # backfill window for changed files rather than capturing
                # only their last record after an in-memory cache eviction.
                needs_history = records._ingest_needed(
                    source, str(filename), 1, {'bytes_read': 0}, None)
            if needs_history:
                # A slice is bounded by BYTES, not by +64 records: a file of
                # many small records no longer needs one visit per 64 of them,
                # and one transaction still reads at most SLICE_BYTES of it.
                count, max_bytes = records.UNBOUNDED, SLICE_BYTES
            else:
                count = 1
        records.ingest(source, str(filename), count, {'bytes_read': 0}, max_bytes=max_bytes)
        with _lock:
            _fresh.discard(source)
    records.ingest_prompt_views(vsource, vpath)
    if backfill:
        # the fingerprint was taken BEFORE this pass: a file that grew during
        # it no longer matches, so the next slice runs again
        settled = _is_settled(sources, vsource, fingerprint)
        with _lock:
            if settled:
                _remember_settled((slug, nid), (fingerprint, tuple(s for s, _ in sources)))
            else:
                _settled.pop((slug, nid), None)
    return True


#: capture_safely's result when capture raised. Truthy, like the True it used
#: to return, so callers that only test truth are unchanged; the worker uses it
#: to retry a failing node at the idle cadence rather than as pending work.
CAPTURE_FAILED = 'failed'


def capture_safely(slug, nid, **kwargs):
    try:
        return capture(slug, nid, **kwargs)
    except Exception:
        # Capture must be retried by the worker. Never claim migration complete
        # or discard source files when a database/file read failed.
        _log.exception('Transcript capture failed for %s/%s; source retained for retry', slug, nid)
        with _lock:
            _settled.pop((slug, nid), None)
        return CAPTURE_FAILED


class _SweepState:
    """Active queue plus a bounded, independent historical discovery cursor."""
    def __init__(self):
        self.root = None
        self.orgs = collections.deque()
        self.cursor = ''
        self.round = 0
        self.active = collections.OrderedDict()
        self.hot = collections.deque()
        # Active-first bookkeeping: archived keys wait here (bounded) until
        # a complete active round finds every active node settled.
        self.archived = collections.deque()
        self.filled = False
        self.round_unsettled = False
        self.active_settled = False
        self.archive_allowance = 0
        # Active keys seen settled at least once in this process. A capture of
        # any other active key is catch-up work; once every active key is in
        # here the worker is back on the idle cadence, however slow re-checks
        # of evicted settled nodes are. Pruned with `active`, so bounded by it.
        self.settled_seen = set()
        # (slug, nid) -> (consecutive failures, retry-at clock) for captures
        # that raised: skipped until retry-at, never counted as pending work.
        self.backoff = collections.OrderedDict()
        self.last_busy = None

    def seed_active(self, slugs):
        """Put every active node in the queue at the start of a round, from
        bounded pages of the active index, so capture never waits for
        id-order discovery to walk past history. Orgs without that index
        (SQLite, legacy blobs) keep being found by discovery alone."""
        from . import store
        for slug in slugs:
            if _stop.is_set():
                return
            after = None
            try:
                while True:
                    page = store.read_active_transcript_nodes(slug, after, ACTIVE_PAGE)
                    if page is None:
                        break
                    for nid, _ in page['rows']:
                        self.active[(slug, nid)] = self.round
                    if not page['more'] or not page['rows']:
                        break
                    after = (page['rows'][-1][1], page['rows'][-1][0])
            except Exception:
                # discovery still covers this org; a failure only loses the head start
                _log.exception('Active transcript seeding failed for %s; discovery continues', slug)

    def discover(self):
        from . import store
        root = str(store.DATA_ROOT)
        if self.root != root:
            self.__init__()
            self.root = root
        if not self.orgs:
            self.round += 1
            self.orgs.extend(store.org_slugs())
            self.seed_active(list(self.orgs))
        archived = []
        budget = 8
        while self.orgs and budget and not _stop.is_set():
            slug = self.orgs[0]
            try:
                page = store.read_transcript_nodes_page(slug, self.cursor, budget)
                if page is None:
                    # JSON/old blob compatibility keeps existing normalization.
                    org = store.cached_org(slug)
                    rows = [(nid, org.node(nid).get('state'))
                            for nid in sorted(org.nodes) if nid > self.cursor][:budget + 1]
                    page = {'rows': rows[:budget], 'more': len(rows) > budget}
            except Exception:
                # A deleted/renamed/unreadable org must not pin this cursor
                # forever and starve every later org. Keep known active nodes
                # until the next catalog round, and retry transient failures
                # from the start when that round rediscovers the org.
                _log.exception('Transcript discovery failed for %s; retry next round', slug)
                for key in self.active:
                    if key[0] == slug:
                        self.active[key] = self.round
                self.orgs.popleft()
                self.cursor = ''
                budget -= 1
                continue
            rows = page['rows']
            for nid, state in rows:
                key = (slug, nid)
                if state == 'archived':
                    self.active.pop(key, None)
                    archived.append(key)
                else:
                    self.active[key] = self.round
            budget -= max(1, len(rows))
            if rows:
                self.cursor = rows[-1][0]
            if not page['more']:
                self.orgs.popleft()
                self.cursor = ''
            elif not rows:
                raise RuntimeError('transcript discovery cursor made no progress')
        if not self.orgs:
            for key in [key for key, seen in self.active.items() if seen != self.round]:
                del self.active[key]
            self.settled_seen &= self.active.keys()
        return archived


def _is_settled_now(key):
    with _lock:
        return key in _settled


def _backing_off(state, key, now):
    entry = state.backoff.get(key)
    return entry is not None and now < entry[1]


def _captured(state, key, result, now):
    """Record a capture's outcome in the backoff table; True if it failed."""
    if result is CAPTURE_FAILED:
        fails = state.backoff.pop(key, (0, 0.0))[0] + 1
        state.backoff[key] = (fails, now + min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** (fails - 1)))
        while len(state.backoff) > BACKOFF_LIMIT:
            state.backoff.popitem(last=False)
        return True
    state.backoff.pop(key, None)
    return False


def _sweep(state, *, clock=time.monotonic):
    """Busy capture, active backfill, then bounded historical reconciliation.

    Returns True while catch-up work remains, so the caller pauses briefly
    instead of for a whole second: this tick caught up an active node never
    seen settled, left one unsettled, or active nodes never seen settled (and
    not failing) are still queued. An archived node left unsettled also
    counts. A capture that RAISED is never pending work: the node backs off
    (BACKOFF_BASE_S doubling to BACKOFF_MAX_S, busy, active and archived
    alike), and a failed attempt counts toward IDLE_CHECKS_PER_TICK like a
    settled re-check. So a failing node or a database outage keeps the idle
    cadence and logs one failure per node per backoff step. Once every active
    node has been seen settled, ticks return False (idle cadence).

    Active first: every active node is queued at round start (seed_active),
    and archived nodes are captured only after a complete active round found
    all of them settled, apart from a small per-round allowance so one node
    that can never settle cannot starve history. Backfill work in one tick is
    bounded by WORK_BUDGET_S (checked between captures, so one capture, e.g.
    a first-visit identity mint, can overrun it); settled re-checks by
    IDLE_CHECKS_PER_TICK, the old idle cadence. Busy nodes are captured at
    most once per second, as before, outside the backfill budget. At most
    eight historical node rows are discovered per tick. Settled archived
    sources never enter the active queue, but retain stat/signature checks
    and re-enter ingestion when their slice finds change.
    """
    from . import supervisor as sup, transcript_records as records
    if _stop.is_set():
        return False
    records._drain_spool()
    now = clock()
    if state.last_busy is None or now - state.last_busy >= 1.0:
        # one-second busy capture, however short the pending pauses are
        state.last_busy = now
        with sup._state_lock:
            busy = [key for key, value in sup._state.items() if value.get('busy')]
        for slug, nid in busy:
            if _stop.is_set():
                return False
            if not _backing_off(state, (slug, nid), now):
                _captured(state, (slug, nid), capture_safely(slug, nid), clock())
    for key in state.discover():
        if len(state.archived) < ARCHIVED_PENDING_LIMIT and key not in state.archived:
            state.archived.append(key)
    deadline = clock() + WORK_BUDGET_S
    pending = False
    checks = 0
    refilled = False
    while clock() < deadline and not _stop.is_set():
        if not state.hot:
            if refilled:
                break
            # The previous round (if any) is complete: judge it, start another.
            state.active_settled = state.filled and not state.round_unsettled
            state.filled, state.round_unsettled, refilled = True, False, True
            state.archive_allowance = ARCHIVED_PER_ACTIVE_ROUND
            state.hot.extend(state.active)
            continue
        key = state.hot.popleft()
        if key not in state.active:
            continue
        if _backing_off(state, key, clock()):
            state.round_unsettled = True   # a failing node still holds history back
            continue
        catching_up = key not in state.settled_seen
        if _captured(state, key, capture_safely(*key, backfill=True), clock()):
            # retried after its backoff step; not pending work
            state.round_unsettled = True
            checks += 1
            if checks >= IDLE_CHECKS_PER_TICK:
                break
            continue
        if _is_settled_now(key):
            state.settled_seen.add(key)
            pending = pending or catching_up
            if not catching_up:
                checks += 1
                if checks >= IDLE_CHECKS_PER_TICK:
                    break
        else:
            state.settled_seen.discard(key)
            state.round_unsettled = pending = True
    if not pending and any(key not in state.settled_seen and key not in state.backoff
                           for key in state.hot):
        pending = True   # the tick ended with never-settled active nodes queued
    while state.archived and clock() < deadline and not _stop.is_set() and (
            state.active_settled or state.archive_allowance > 0):
        key = state.archived.popleft()
        if _backing_off(state, key, clock()):
            continue   # rediscovered later; retried once its backoff step passes
        if not state.active_settled:
            state.archive_allowance -= 1
        failed = _captured(state, key, capture_safely(*key, backfill=True), clock())
        # an unfinished archived node continues when discovery next reaches it;
        # a failed one is retried then too, and is not pending work
        pending = pending or (not failed and not _is_settled_now(key))
    return pending


def start():
    global _started, _thread
    with _lock:
        if _started:
            return
        _started = True
        _stop.clear()

    def run():
        from . import transcript_records as records
        queue = _SweepState()
        with records.reuse_database():
            while not _stop.is_set():
                pending = False
                try:
                    pending = _sweep(queue)
                except Exception:
                    if _stop.is_set():
                        break      # the database is going down with the engine
                    _log.exception('Transcript capture sweep failed; retrying')
                _stop.wait(PENDING_PAUSE_S if pending else IDLE_PAUSE_S)

    # Registered after launch.py's database stop, so it runs before it.
    atexit.register(stop, STOP_JOIN_S)
    _thread = threading.Thread(target=run, name='transcript-capture', daemon=True)
    _thread.start()


def stop(timeout: float = 0.0) -> bool:
    """Ask the worker to stop; wait up to `timeout` seconds for it to leave.
    True when no worker thread is still running."""
    global _started
    _stop.set()
    thread = _thread
    if thread is not None and timeout > 0 and thread is not threading.current_thread():
        thread.join(timeout)
    alive = thread is not None and thread.is_alive()
    if not alive:
        with _lock:
            _started = False
    return not alive
