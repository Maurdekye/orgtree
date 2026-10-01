"""PG-4: the per-org commit revision feed (LISTEN org_rev), with missed-NOTIFY detection.

THE TWO REVISIONS. The screen feed already stamps every state-bearing websocket
frame with a per-org frame ``rev`` (api.py, the 2026-09-19 base+patch protocol),
and the renderer refetches on a frame-rev gap. That counter counts FRAMES in
this process: ``hub_changed`` coalesces 0.4 s of saves into one ``changed``
frame, and ``node_stream`` frames carry no commit at all. ``org_rev`` is a
different number: PostgreSQL's per-org COMMIT counter, bumped inside every
``org_tx`` (PG-0) and announced with ``NOTIFY org_rev, '<slug>:<revision>'``.
It cannot replace the frame rev. This module turns commits into the existing
``changed`` broadcast and records the latest revision seen per org.

WHY A GAP CAN HAPPEN. PostgreSQL delivers NOTIFY only to sessions LISTENing at
commit time; nothing is queued for a listener whose connection dropped. So a
commit made while this process's listener was reconnecting is never announced.
The feed therefore does not trust the notification stream alone:
- after every (re)connect it reads every org's revision (catch-up);
- every ``poll_s``, on a fixed schedule, it reads them again (safety net);
- a notification whose revision is not ``last_seen + 1`` is also a gap.
A gap is answered exactly like a commit: ``on_change(org, revision, gap=True)``,
which the engine wires to cache invalidation plus ``hub_changed`` (one full
refetch in the renderer covers every missed commit). Revisions only move
forward: an older or equal revision is ignored.

The connection is reached through ``Conn`` (a few methods), so the logic is
testable without a database; ``psycopg_conn`` adapts psycopg 3.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import threading
import time
from typing import Callable, Iterable, Protocol

CHANNEL = "org_rev"
#: every org's current revision. PG-0 (pypg/pg-0-storage a8b0ad6) keeps it in
#: ``orgs(org_id, slug UNIQUE, revision)`` and announces ``'<slug>:<revision>'``:
#: routes, caches and the store all key by slug, so the feed does too
REVISIONS_SQL = "SELECT slug, revision FROM orgs"


class Conn(Protocol):
    def listen(self, channel: str) -> None: ...
    def revisions(self) -> Iterable[tuple[str, int]]: ...
    def notifications(self, timeout: float) -> Iterable[str]: ...
    def close(self) -> None: ...


def parse(payload: str) -> "tuple[str, int] | None":
    """``'<org>:<revision>'`` -> (org, revision); anything else is None (and
    counted, never guessed)."""
    org, sep, rev = payload.rpartition(":")
    if not sep or not org or not rev.isdigit():
        return None
    return org, int(rev)


@dataclass
class Stats:
    notifications: int = 0
    malformed: int = 0
    gaps: int = 0
    #: gaps whose every revision was this process's own commit, so the
    #: callback was given the last one as an ordinary change (N1000 #4)
    gaps_local: int = 0
    catchups: int = 0
    polls: int = 0
    reconnects: int = 0
    changes: int = 0
    errors: list[str] = field(default_factory=list)


class RevisionFeed:
    """One per engine process. ``on_change(org, revision, gap)`` is called with
    no lock held, once per forward move of an org's revision."""

    def __init__(self, connect: Callable[[], Conn],
                 on_change: Callable[[str, int, bool], None], *,
                 poll_s: float = 5.0, retry_s: float = 1.0) -> None:
        self._connect = connect
        self._on_change = on_change
        self.poll_s = poll_s
        self.retry_s = retry_s
        self._last: dict[str, int] = {}
        # Tree readers distinguish receipt of a revision from completion of
        # its invalidation callback. The initial catch-up is only a baseline:
        # it does not prove that a snapshot built BEFORE it was refreshed.
        self._baseline: dict[str, int] = {}
        self._applied: dict[str, int] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.stats = Stats()
        #: test hook: when False, catch-up and poll reads are skipped (RT9's
        #: negative control must show a missed NOTIFY then goes unnoticed)
        self.catch_up_enabled = True

    # ------------------------------------------------------------ state
    def last_seen(self, org: str) -> "int | None":
        with self._lock:
            return self._last.get(org)

    def applied_since(self, org: str, after: int) -> int:
        """A contiguous observed range whose callbacks have finished."""
        with self._lock:
            if self._baseline.get(org, after + 1) > after:
                return after
            return max(after, self._applied.get(org, after))

    def observe(self, org: str, revision: int, *, source: str) -> bool:
        """Record ``revision`` for ``org``; True if it moved forward. A gap is a
        forward move that skipped revisions, or any forward move found by a
        read (catch-up/poll) rather than by a notification."""
        with self._lock:
            last = self._last.get(org)
            if last is not None and revision <= last:
                return False
            self._last[org] = revision
            if last is None:
                self._baseline[org] = revision
                # first sight of this org: the baseline, not a change, unless it
                # came from a notification (then it is a real commit)
                gap = False
                changed = source == "notify"
            else:
                gap = source != "notify" or revision != last + 1
                changed = True
            if gap:
                self.stats.gaps += 1
            if changed:
                self.stats.changes += 1
        if gap and last is not None and _gap_is_local(org, last, revision):
            # a poll that read a revision before its NOTIFY was drained, or a
            # reconnect across commits made HERE: nothing foreign was missed
            with self._lock:
                self.stats.gaps_local += 1
            gap = False
        if changed:
            self._on_change(org, revision, gap)
        with self._lock:
            # Concurrent observe callers may complete out of order. Refusing
            # to advance across an unfinished callback is conservative; the
            # tree reader then does a committed refresh instead of trusting it.
            if last is None or self._applied.get(org) == last:
                self._applied[org] = revision
        return changed

    # ------------------------------------------------------------- loop
    def _read_all(self, conn: Conn, source: str) -> None:
        if not self.catch_up_enabled:
            return
        for org, rev in conn.revisions():
            self.observe(str(org), int(rev), source=source)

    def run_once(self, conn: Conn, until: float) -> None:
        """Serve one connected session until ``until`` (monotonic) or stop.
        Raises whatever the connection raises; ``run`` reconnects."""
        conn.listen(CHANNEL)
        # LISTEN first, then read: a commit between the two is seen by the read
        # AND announced; ``observe`` ignores the duplicate
        self.stats.catchups += 1
        self._read_all(conn, "catchup")
        # the poll runs on a FIXED schedule, not after a quiet spell: steady
        # notifications for other orgs must not starve the read that finds
        # this org's lost last notification
        next_poll = time.monotonic() + self.poll_s
        while not self._stop.is_set() and time.monotonic() < until:
            wait = max(0.0, min(next_poll, until) - time.monotonic())
            for payload in conn.notifications(wait):
                self.stats.notifications += 1
                parsed = parse(payload)
                if parsed is None:
                    self.stats.malformed += 1
                    continue
                self.observe(parsed[0], parsed[1], source="notify")
            if time.monotonic() >= next_poll:
                self.stats.polls += 1
                self._read_all(conn, "poll")
                next_poll = time.monotonic() + self.poll_s

    def run(self) -> None:
        while not self._stop.is_set():
            conn = None
            try:
                conn = self._connect()
                self.run_once(conn, until=float("inf"))
            except Exception as e:          # the loop must outlive any one session
                self.stats.errors.append(f"{type(e).__name__}: {e}"[:300])
                del self.stats.errors[:-20]
                self.stats.reconnects += 1
                self._stop.wait(self.retry_s)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self.run, name="pgfeed", daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)


# ------------------------------------------------------ this process's commits
#
# A commit made HERE already refreshed the shared snapshot (store publishes its
# change set, org_tx through the same path) and scheduled the `changed`
# broadcast. The feed must not answer it again with a full reload: that would
# throw away the section-granular refresh on every write. So each process
# records the revisions it committed, AFTER the commit succeeded (a rolled-back
# bump frees its number for the next committer, possibly another process), and
# the engine callback acts only on revisions it did not make, or on a gap.
#
# It keeps the exact SET of revisions made here, not only the newest: another
# process can commit N, and this process commit N+1 and note it, before the
# listener has drained N's NOTIFY. A "<= newest local" test would then take the
# foreign N for ours and leave the sections it changed stale in the shared
# snapshot (PG-4 review f1). The feed only moves forward, so each callback
# prunes every entry at or below the revision it was called for; the cap bounds
# a set whose revisions the feed never reaches (for example, a stopped feed).
#
# IN FLIGHT. PostgreSQL delivers the NOTIFY at COMMIT, and the listener can
# drain it before the committing thread gets COMMIT's answer back, let alone
# runs org_tx's commit listeners (after the deferred save hooks: a median 68 ms
# later at N=100, when EVERY org_tx commit was taken for foreign). So a save
# registers its bumped revision with `begin_local` BEFORE its COMMIT, the
# connection answers `confirm_local` the moment the server answers COMMIT, or
# `abort_local` on rollback. A callback that meets an in-flight revision waits
# for that answer, bounded per call AND by a rolling budget, so a backlog never
# stalls the feed for long. An answer still missing when the wait ends is NOT
# taken for foreign any more (N1000 #4): under GIL load the committing thread
# routinely needs longer than the wait to run again, every such commit cost a
# ~21 MB full reload at N1000, and each reload's parse starved the next
# committer in turn. The revision is left UNDECIDED instead, and its own answer
# decides it: `confirm_local` means ours (nothing to do), `abort_local` means
# the number was freed and may have been committed by another process, so the
# abort publishes the unknown change set and the broadcast then (`_on_undecided_abort`).
# Until it is answered `snapshot_changes_published` refuses every range that
# covers it. The confirmation only tells THE FEED the commit
# was ours (`_committed`); it does NOT publish anything: `_local`/`_local_set`,
# which `snapshot_changes_published` and `known_revision` read, are still fed
# by `note_local` AFTER the committer published its change set, so a stamp is
# never newer than the snapshot content. The orgs row lock serializes revision
# numbers, so no other process can commit that number until ours commits or
# rolls back: a rolled-back number reused by another process is still in
# flight here only until our rollback releases it (or the wait expires).
_LOCAL_CAP = 1024
_local: dict[str, int] = {}                 # the newest revision made here
_local_set: dict[str, set[int]] = {}        # every revision made here, not yet passed
_inflight: dict[str, set[int]] = {}         # bumped here, COMMIT not yet answered
_committed: dict[str, set[int]] = {}        # COMMIT answered here, not yet passed by the feed
_undecided: dict[str, set[int]] = {}        # notified while in flight, wait expired, unanswered
#: what an undecided revision's abort does: the engine callback's reload and
#: broadcast (set by `engine_callback`; None until one exists)
_on_undecided_abort: "Callable[[str], None] | None" = None
#: why the engine callback marked a snapshot unknown, by cause (plus
#: "undecided_evicted": unanswered revisions dropped at the cap)
causes: dict[str, int] = {}
#: most unanswered revisions one org has held at once. While one is pending,
#: every tree read covering it does a full reload, so a revision whose answer
#: never comes shows here as a peak that keeps climbing (N1000 #4 review N2)
undecided_peak = 0
_local_lock = threading.Lock()
_answered = threading.Condition(_local_lock)
#: longest one callback waits for a commit's answer
INFLIGHT_WAIT_S = 0.1
#: most the feed thread waits in total per rolling BUDGET_WINDOW_S
INFLIGHT_BUDGET_S = 0.25
BUDGET_WINDOW_S = 1.0
_budget = {"window": 0.0, "spent": 0.0}


def begin_local(slug: str, revision: int) -> None:
    """Just before COMMIT: this process bumped ``revision``."""
    with _local_lock:
        _inflight.setdefault(slug, set()).add(revision)


def confirm_local(slug: str, revision: int) -> None:
    """The server answered COMMIT for ``revision``: the feed may take it for
    ours. Publication (and so the published/known predicates) is note_local's."""
    with _answered:
        undecided = _undecided.get(slug)
        if undecided is not None and revision in undecided:
            # its NOTIFY was already passed: the verdict is all it needed
            undecided.discard(revision)
        else:
            revs = _committed.setdefault(slug, set())
            revs.add(revision)
            if len(revs) > _LOCAL_CAP:
                revs.discard(min(revs))
        pending = _inflight.get(slug)
        if pending is not None:
            pending.discard(revision)
        _answered.notify_all()


def abort_local(slug: str, revision: int) -> None:
    """The transaction that bumped ``revision`` did not commit."""
    with _answered:
        revs = _inflight.get(slug)
        if revs is not None:
            revs.discard(revision)
        late = revision in _undecided.get(slug, ())
        act = _on_undecided_abort
        _answered.notify_all()
    if not late:
        return
    try:
        if act is not None:
            # the feed already passed this revision believing it might be ours;
            # it was not, so whatever committed that number is foreign
            _count("undecided_abort")
            act(slug)
    finally:
        # only now: until the unknown change set is published, a tree read
        # must keep refusing the range (`snapshot_changes_published`), or it
        # could trust the snapshot from before the foreign commit
        with _answered:
            undecided = _undecided.get(slug)
            if undecided is not None:
                undecided.discard(revision)


def _count(cause: str) -> None:
    with _local_lock:
        causes[cause] = causes.get(cause, 0) + 1


def note_local(slug: str, revision: int) -> None:
    with _answered:
        if revision > _local.get(slug, 0):
            _local[slug] = revision
        revs = _local_set.setdefault(slug, set())
        revs.add(revision)
        if len(revs) > _LOCAL_CAP:
            revs.discard(min(revs))
        pending = _inflight.get(slug)
        if pending is not None:
            pending.discard(revision)
        _answered.notify_all()


def undecided_pending() -> int:
    """Unanswered revisions right now, all orgs (0 once every save answered)."""
    with _local_lock:
        return sum(len(revs) for revs in _undecided.values())


def local_revision(slug: str) -> int:
    with _local_lock:
        return _local.get(slug, 0)


def snapshot_changes_published(feed: "RevisionFeed | None", slug: str,
                               after: int | None, through: int) -> bool:
    """Can a tree safely use cached_org up to this committed revision?

    Exact local revision membership closes the foreign-N/local-N+1 hole.
    Missing/pruned evidence costs a refresh; it never establishes freshness.
    """
    if after is None or through < after:
        return False
    with _local_lock:
        if any(r <= through for r in _undecided.get(slug, ())):
            return False
    applied = feed.applied_since(slug, after) if feed is not None else after
    if applied >= through:
        return True
    if through - applied > _LOCAL_CAP:
        return False
    with _local_lock:
        local = _local_set.get(slug, set())
        return all(rev in local for rev in range(applied + 1, through + 1))


def _wait_answered(slug: str, revision: int) -> None:
    """Under _answered: wait, bounded, while ``revision`` is in flight here."""
    if revision not in _inflight.get(slug, ()):
        return
    now = time.monotonic()
    if now - _budget["window"] >= BUDGET_WINDOW_S:
        _budget["window"], _budget["spent"] = now, 0.0
    deadline = now + min(INFLIGHT_WAIT_S, max(0.0, INFLIGHT_BUDGET_S - _budget["spent"]))
    while revision in _inflight.get(slug, ()):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        _answered.wait(left)
    _budget["spent"] += time.monotonic() - now


def _take_local(slug: str, revision: int) -> "bool | None":
    """Was ``revision`` made by this process? Waits (bounded) for an in-flight
    commit's answer, then prunes every recorded revision at or below it: the
    feed never calls back for those again. Still unanswered after the wait:
    None, and the revision is left UNDECIDED for its own answer to settle."""
    global undecided_peak
    with _answered:
        _wait_answered(slug, revision)
        pending = revision in _inflight.get(slug, ())
        mine = any(revision in state.get(slug, ()) for state in (_committed, _local_set))
        for state in (_inflight, _committed, _local_set):
            revs = state.get(slug)
            if revs:
                revs.difference_update([r for r in revs if r <= revision])
        if pending and not mine:
            undecided = _undecided.setdefault(slug, set())
            undecided.add(revision)
            if len(undecided) > _LOCAL_CAP:
                # More than _LOCAL_CAP unanswered commits on one org: the
                # oldest is forgotten and from then on counts as trusted, even
                # though its answer never came. Every exit of a save answers
                # (confirm or abort), so this needs a leak or a stuck
                # committer; the count makes it visible in a scale run.
                undecided.discard(min(undecided))
                causes["undecided_evicted"] = causes.get("undecided_evicted", 0) + 1
            undecided_peak = max(undecided_peak, len(undecided))
            return None
        return mine


def _gap_is_local(slug: str, last: int, revision: int) -> bool:
    """Were ALL of the revisions a gap skipped, (last, revision), made here,
    and is ``revision`` itself made here or in flight here? Then no foreign
    commit hides in the gap, and ``revision`` can be judged like any NOTIFY.
    The skipped ones are settled (and pruned) now, by the same exact
    membership test, an in-flight one left undecided for its own answer; any
    one not made here keeps the gap."""
    if revision - last - 1 > _LOCAL_CAP:
        return False
    with _local_lock:
        if not any(revision in state.get(slug, ())
                   for state in (_inflight, _committed, _local_set)):
            return False
    for r in range(last + 1, revision):
        if _take_local(slug, r) is False:
            return False
    return True


def engine_callback(publish_unknown: Callable[[str], None],
                    broadcast: Callable[[str], None]) -> Callable[[str, int, bool], None]:
    """``on_change`` for the engine: a revision this process did not commit,
    or any gap, drops trust in the shared snapshot's accumulated change set
    (the next read does one full reload) and schedules the ordinary coalesced
    ``changed`` broadcast, which the renderer answers with a refetch."""
    global _on_undecided_abort

    def act(slug: str) -> None:
        publish_unknown(slug)
        broadcast(slug)

    def on_change(slug: str, revision: int, gap: bool) -> None:
        mine = _take_local(slug, revision)
        if not gap:
            if mine:
                return
            if mine is None:
                # still in flight here: its own answer decides (abort acts)
                _count("undecided")
                return
        _count("gap" if gap else "foreign")
        act(slug)
    _on_undecided_abort = act
    return on_change


def known_revision(feed: "RevisionFeed | None", slug: str) -> int:
    """The newest revision this process knows is committed: a stamp for a
    payload, read BEFORE its snapshot (so it is never newer than the content,
    the same rule as the frame protocol's ``sync_rev``)."""
    seen = feed.last_seen(slug) if feed is not None else None
    return max(local_revision(slug), seen or 0)


def psycopg_conn(conninfo: str) -> Conn:
    """A ``Conn`` over psycopg 3 (autocommit, its own session: LISTEN must not
    share a pooled connection)."""
    import psycopg  # noqa: PLC0415 - optional until PG-0 lands the dependency

    class _P:
        def __init__(self) -> None:
            self.c = psycopg.connect(conninfo, autocommit=True)

        def listen(self, channel: str) -> None:
            self.c.execute(f"LISTEN {channel}")

        def revisions(self) -> list[tuple[str, int]]:
            return [(str(o), int(r)) for o, r in self.c.execute(REVISIONS_SQL).fetchall()]

        def notifications(self, timeout: float) -> Iterable[str]:
            # a generator, NOT a list: each notification is handled as it
            # arrives rather than after the whole timeout has elapsed
            return (n.payload for n in self.c.notifies(timeout=timeout))

        def close(self) -> None:
            self.c.close()

    return _P()
