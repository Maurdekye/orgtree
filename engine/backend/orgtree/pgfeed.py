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
        if changed:
            self._on_change(org, revision, gap)
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
_local: dict[str, int] = {}
_local_lock = threading.Lock()


def note_local(slug: str, revision: int) -> None:
    with _local_lock:
        if revision > _local.get(slug, 0):
            _local[slug] = revision


def local_revision(slug: str) -> int:
    with _local_lock:
        return _local.get(slug, 0)


def engine_callback(publish_unknown: Callable[[str], None],
                    broadcast: Callable[[str], None]) -> Callable[[str, int, bool], None]:
    """``on_change`` for the engine: a revision this process did not commit,
    or any gap, drops trust in the shared snapshot's accumulated change set
    (the next read does one full reload) and schedules the ordinary coalesced
    ``changed`` broadcast, which the renderer answers with a refetch."""
    def on_change(slug: str, revision: int, gap: bool) -> None:
        if not gap and revision <= local_revision(slug):
            return
        publish_unknown(slug)
        broadcast(slug)
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
