"""PG-4: the commit revision feed turns commits into changes and CATCHES missed NOTIFYs.

Runs against an in-memory fake of the PostgreSQL side (``_Server``): revisions
per org, NOTIFY delivered only to sessions LISTENing at commit time (as
PostgreSQL does), and a kill that drops a session. RT9 (missed NOTIFY -> gap ->
refetch) is proved here at the logic level with its negative control; the same
scenario against a real PostgreSQL waits for PG-0's org_rev table and psycopg.
"""
from __future__ import annotations

from pathlib import Path
import queue
import sys
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgfeed  # noqa: E402


class _Server:
    def __init__(self) -> None:
        self.revs: dict[str, int] = {}
        self.sessions: list["_Session"] = []
        self.lock = threading.Lock()

    def commit(self, org: str, *, notify: bool = True) -> int:
        with self.lock:
            self.revs[org] = self.revs.get(org, 0) + 1
            rev = self.revs[org]
            if notify:
                for s in self.sessions:
                    if s.listening and not s.dead:
                        s.q.put(f"{org}:{rev}")
        return rev

    def connect(self) -> "_Session":
        s = _Session(self)
        with self.lock:
            self.sessions.append(s)
        return s

    def kill_all(self) -> None:
        with self.lock:
            for s in self.sessions:
                s.dead = True


class _Session:
    def __init__(self, server: _Server) -> None:
        self.server = server
        self.q: "queue.Queue[str]" = queue.Queue()
        self.listening = False
        self.dead = False

    def _alive(self) -> None:
        if self.dead:
            raise ConnectionError("terminating connection due to administrator command")

    def listen(self, channel: str) -> None:
        self._alive()
        assert channel == pgfeed.CHANNEL
        self.listening = True

    def revisions(self):
        self._alive()
        with self.server.lock:
            return list(self.server.revs.items())

    def notifications(self, timeout: float):
        end = time.monotonic() + timeout
        while True:
            self._alive()
            left = end - time.monotonic()
            if left <= 0:
                return
            try:
                yield self.q.get(timeout=min(left, 0.01))
            except queue.Empty:
                pass

    def close(self) -> None:
        self.dead = True


def _wait(cond, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


class Observe(unittest.TestCase):
    def setUp(self) -> None:
        self.calls: list[tuple[str, int, bool]] = []
        self.feed = pgfeed.RevisionFeed(lambda: None, lambda o, r, g: self.calls.append((o, r, g)))

    def test_the_first_read_is_a_baseline_not_a_change(self) -> None:
        self.assertFalse(self.feed.observe("a", 7, source="catchup"))
        self.assertEqual((self.calls, self.feed.last_seen("a")), ([], 7))

    def test_the_next_notification_is_a_change_without_a_gap(self) -> None:
        self.feed.observe("a", 7, source="catchup")
        self.assertTrue(self.feed.observe("a", 8, source="notify"))
        self.assertEqual(self.calls, [("a", 8, False)])

    def test_a_skipped_revision_is_a_gap(self) -> None:
        self.feed.observe("a", 7, source="catchup")
        self.feed.observe("a", 9, source="notify")
        self.assertEqual(self.calls, [("a", 9, True)])
        self.assertEqual(self.feed.stats.gaps, 1)

    def test_a_forward_move_found_by_a_read_is_a_gap(self) -> None:
        self.feed.observe("a", 7, source="notify")
        self.feed.observe("a", 8, source="poll")
        self.assertEqual(self.calls, [("a", 7, False), ("a", 8, True)])

    def test_old_and_repeated_revisions_are_ignored(self) -> None:
        self.feed.observe("a", 7, source="notify")
        self.assertFalse(self.feed.observe("a", 7, source="notify"))
        self.assertFalse(self.feed.observe("a", 3, source="poll"))
        self.assertEqual(self.calls, [("a", 7, False)])

    def test_payloads_are_parsed_strictly(self) -> None:
        self.assertEqual(pgfeed.parse("org:1:42"), ("org:1", 42))
        for bad in ("", "a", "a:", ":3", "a:x", "a:-1", "a:1.5"):
            self.assertIsNone(pgfeed.parse(bad), bad)


class Rt9(unittest.TestCase):
    """RT9: a missed NOTIFY is detected as a gap and answered with a change."""

    def feed(self, server: _Server, *, catch_up: bool = True, poll_s: float = 0.5):
        calls: list[tuple[str, int, bool]] = []
        f = pgfeed.RevisionFeed(server.connect, lambda o, r, g: calls.append((o, r, g)),
                                poll_s=poll_s, retry_s=0.02)
        f.catch_up_enabled = catch_up
        f.start()
        self.addCleanup(f.stop)
        self.addCleanup(server.kill_all)     # runs first: wakes a long wait
        return f, calls

    def _missed_while_down(self, catch_up: bool):
        server = _Server()
        server.commit("a")                       # rev 1 before the feed starts
        # a poll far beyond the test: only the reconnect catch-up can find 3, 4
        feed, calls = self.feed(server, catch_up=catch_up, poll_s=60.0)
        self.assertTrue(_wait(lambda: any(s.listening for s in server.sessions)))
        if catch_up:
            self.assertTrue(_wait(lambda: feed.last_seen("a") == 1))
        server.commit("a")                       # rev 2, announced
        self.assertTrue(_wait(lambda: ("a", 2, False) in calls), calls)
        reconnects = feed.stats.reconnects
        server.kill_all()                        # the listener's session drops ...
        server.commit("a")                       # ... rev 3 and 4 are never announced
        server.commit("a")
        self.assertTrue(_wait(lambda: feed.stats.reconnects > reconnects))
        self.assertTrue(_wait(lambda: sum(1 for s in server.sessions
                                          if s.listening and not s.dead) == 1))
        time.sleep(0.1)
        return feed, calls

    def test_a_notify_missed_during_a_reconnect_is_caught_up(self) -> None:
        feed, calls = self._missed_while_down(catch_up=True)
        self.assertTrue(_wait(lambda: feed.last_seen("a") == 4), feed.last_seen("a"))
        self.assertEqual(calls, [("a", 2, False), ("a", 4, True)])
        self.assertEqual(feed.stats.polls, 0)

    def test_control_without_catch_up_the_missed_notify_goes_unnoticed(self) -> None:
        feed, calls = self._missed_while_down(catch_up=False)
        # the control did its work: the feed saw rev 2 and reconnected ...
        self.assertEqual(calls, [("a", 2, False)])
        self.assertGreaterEqual(feed.stats.reconnects, 1)
        # ... and never learned of 3 and 4: this is the failure RT9 guards against
        self.assertEqual(feed.last_seen("a"), 2)

    def test_a_suppressed_notify_on_a_live_connection_is_found_by_the_poll(self) -> None:
        server = _Server()
        feed, calls = self.feed(server, poll_s=0.1)
        self.assertTrue(_wait(lambda: any(s.listening for s in server.sessions)))
        server.commit("a")
        self.assertTrue(_wait(lambda: ("a", 1, False) in calls))
        server.commit("a", notify=False)         # committed, never announced
        self.assertTrue(_wait(lambda: ("a", 2, True) in calls), calls)
        self.assertEqual(feed.stats.reconnects, 0)

    def test_the_poll_is_not_starved_by_other_orgs_notifications(self) -> None:
        server = _Server()
        feed, calls = self.feed(server, poll_s=0.15)
        self.assertTrue(_wait(lambda: any(s.listening for s in server.sessions)))
        server.commit("a", notify=False)
        stop = threading.Event()

        def chatter() -> None:
            while not stop.is_set():
                server.commit("b")
                time.sleep(0.02)
        t = threading.Thread(target=chatter)
        t.start()
        try:
            self.assertTrue(_wait(lambda: feed.last_seen("a") == 1, timeout=2.0),
                            "a steady stream for org b starved the poll")
        finally:
            stop.set()
            t.join()

    def test_control_without_catch_up_a_suppressed_notify_is_missed(self) -> None:
        server = _Server()
        feed, calls = self.feed(server, poll_s=0.05, catch_up=False)
        self.assertTrue(_wait(lambda: any(s.listening for s in server.sessions)))
        server.commit("a")
        self.assertTrue(_wait(lambda: ("a", 1, False) in calls))
        server.commit("a", notify=False)
        self.assertTrue(_wait(lambda: feed.stats.polls >= 3))   # polls ran (skipped reads)
        self.assertEqual(feed.last_seen("a"), 1)



class EngineCallback(unittest.TestCase):
    """A commit this process made is already published locally; the feed acts
    only on revisions it did not make, and on gaps."""

    def setUp(self) -> None:
        pgfeed._local.clear()
        pgfeed._local_set.clear()
        self.addCleanup(pgfeed._local.clear)
        self.addCleanup(pgfeed._local_set.clear)
        self.unknown: list[str] = []
        self.sent: list[str] = []
        self.cb = pgfeed.engine_callback(self.unknown.append, self.sent.append)

    def test_a_local_commit_is_not_answered_again(self) -> None:
        pgfeed.note_local("a", 5)
        self.cb("a", 5, False)
        self.assertEqual((self.unknown, self.sent), ([], []))

    def test_a_foreign_commit_reloads_and_broadcasts(self) -> None:
        pgfeed.note_local("a", 5)
        self.cb("a", 6, False)
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))

    def test_a_gap_always_reloads_even_below_the_local_revision(self) -> None:
        pgfeed.note_local("a", 9)
        self.cb("a", 7, True)
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))

    def test_local_revisions_only_move_forward_per_org(self) -> None:
        pgfeed.note_local("a", 5)
        pgfeed.note_local("a", 3)
        pgfeed.note_local("b", 1)
        self.assertEqual((pgfeed.local_revision("a"), pgfeed.local_revision("b"),
                          pgfeed.local_revision("c")), (5, 1, 0))

    def test_known_revision_is_the_newest_of_local_and_seen(self) -> None:
        feed = pgfeed.RevisionFeed(lambda: None, lambda *a: None)
        pgfeed.note_local("a", 4)
        self.assertEqual(pgfeed.known_revision(feed, "a"), 4)
        feed.observe("a", 6, source="notify")
        self.assertEqual(pgfeed.known_revision(feed, "a"), 6)
        self.assertEqual(pgfeed.known_revision(None, "a"), 4)

    def test_a_foreign_commit_drained_after_our_newer_one_still_reloads(self) -> None:
        """Review f1: another process commits 5; this process commits 6 and
        notes it BEFORE the listener drains 5's NOTIFY. 5 is last+1 (no gap) and
        below our newest local revision, yet it is foreign: it must reload."""
        acted: list[int] = []
        cb = pgfeed.engine_callback(self.unknown.append, self.sent.append)

        def on_change(o: str, r: int, g: bool) -> None:
            before = len(self.unknown)
            cb(o, r, g)
            if len(self.unknown) > before:
                acted.append(r)
        feed = pgfeed.RevisionFeed(lambda: None, on_change)
        feed.observe("a", 4, source="catchup")        # baseline
        pgfeed.note_local("a", 6)                     # ours, committed after the foreign 5
        feed.observe("a", 5, source="notify")         # foreign, drained late
        feed.observe("a", 6, source="notify")         # ours
        self.assertEqual(feed.stats.gaps, 0)          # neither was a gap: the set decided
        self.assertEqual(acted, [5])
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))

    def test_passed_local_revisions_are_pruned(self) -> None:
        for r in (3, 5, 8):
            pgfeed.note_local("a", r)
        self.cb("a", 5, False)                        # ours: no action; 3 and 5 pass
        self.assertEqual(self.unknown, [])
        self.assertEqual(pgfeed._local_set["a"], {8})
        self.cb("a", 9, True)                         # a gap past 8 prunes it too
        self.assertEqual(pgfeed._local_set["a"], set())
        self.assertEqual(pgfeed.local_revision("a"), 8)   # the stamp's newest is kept

    def test_the_local_set_is_bounded(self) -> None:
        for r in range(1, pgfeed._LOCAL_CAP + 11):
            pgfeed.note_local("a", r)
        revs = pgfeed._local_set["a"]
        self.assertEqual(len(revs), pgfeed._LOCAL_CAP)
        self.assertEqual(min(revs), 11)               # the oldest were dropped


class InFlight(unittest.TestCase):
    """A commit this process is still making must not be taken for foreign
    because its NOTIFY outran COMMIT's answer (foreground-tree F3-0)."""

    def setUp(self) -> None:
        for state in (pgfeed._local, pgfeed._local_set, pgfeed._inflight, pgfeed._committed):
            state.clear()
            self.addCleanup(state.clear)
        pgfeed._budget.update(window=0.0, spent=0.0)
        self.addCleanup(pgfeed._budget.update, window=0.0, spent=0.0)
        self.unknown: list[str] = []
        self.sent: list[str] = []
        self.cb = pgfeed.engine_callback(self.unknown.append, self.sent.append)

    def timed(self, revision: int) -> float:
        started = time.monotonic()
        self.cb("a", revision, False)
        return time.monotonic() - started

    def test_a_commit_answered_after_its_notify_is_still_local(self) -> None:
        pgfeed.begin_local("a", 7)
        answer = threading.Timer(0.03, pgfeed.confirm_local, ("a", 7))
        answer.start()
        self.addCleanup(answer.cancel)
        elapsed = self.timed(7)
        self.assertEqual((self.unknown, self.sent), ([], []))
        self.assertGreaterEqual(elapsed, 0.02)            # it really waited for the answer
        self.assertEqual(pgfeed._inflight["a"], set())

    def test_control_without_registration_the_same_commit_is_foreign(self) -> None:
        answer = threading.Timer(0.03, pgfeed.confirm_local, ("a", 7))
        answer.start()
        self.addCleanup(answer.cancel)
        self.assertLess(self.timed(7), 0.02)              # nothing to wait for
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))

    def test_a_rolled_back_number_committed_by_another_process_is_foreign(self) -> None:
        pgfeed.begin_local("a", 7)
        pgfeed.abort_local("a", 7)
        self.assertLess(self.timed(7), 0.02)              # the abort answered at once
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))

    def test_an_unanswered_commit_is_foreign_after_a_bounded_wait(self) -> None:
        pgfeed.begin_local("a", 7)
        elapsed = self.timed(7)
        self.assertEqual((self.unknown, self.sent), (["a"], ["a"]))
        self.assertLess(elapsed, pgfeed.INFLIGHT_WAIT_S + 0.05)
        self.assertGreaterEqual(elapsed, pgfeed.INFLIGHT_WAIT_S - 0.01)
        self.assertEqual(pgfeed._inflight["a"], set())    # no stale entry is kept
        pgfeed.confirm_local("a", 7)                      # its late confirmation
        self.cb("a", 8, False)                            # does not make 8 local
        self.assertEqual(self.unknown, ["a", "a"])

    def test_the_feed_waits_at_most_its_budget_across_a_backlog(self) -> None:
        for r in range(1, 11):
            pgfeed.begin_local("a", r)
        started = time.monotonic()
        for r in range(1, 11):
            self.cb("a", r, False)
        elapsed = time.monotonic() - started
        self.assertEqual(len(self.unknown), 10)
        self.assertLess(elapsed, pgfeed.INFLIGHT_BUDGET_S + 0.1)
        self.assertGreater(10 * pgfeed.INFLIGHT_WAIT_S, pgfeed.INFLIGHT_BUDGET_S + 0.1)

    def test_a_confirmation_is_not_a_publication(self) -> None:
        """review f2: the COMMIT answer tells the feed the commit was ours; the
        published/known predicates move only with note_local, after the
        committer published its change set."""
        pgfeed.begin_local("a", 7)
        pgfeed.confirm_local("a", 7)
        self.assertFalse(pgfeed.snapshot_changes_published(None, "a", 6, 7))
        self.assertEqual(pgfeed.known_revision(None, "a"), 0)
        pgfeed.note_local("a", 7)
        self.assertTrue(pgfeed.snapshot_changes_published(None, "a", 6, 7))
        self.cb("a", 7, False)
        self.assertEqual(self.unknown, [])

    def test_a_gap_is_never_local_even_when_in_flight(self) -> None:
        pgfeed.begin_local("a", 7)
        pgfeed.note_local("a", 7)
        self.cb("a", 7, True)
        self.assertEqual(self.unknown, ["a"])


class _Raw:
    """Just enough of a psycopg session for PgConn.execute's COMMIT/ROLLBACK."""

    def __init__(self, fail: bool = False, answer: str | None = None) -> None:
        self.fail, self.ran, self.answer = fail, [], answer
        self.closed, self.close_calls = False, 0

    def execute(self, sql, params=None):
        self.ran.append(sql)
        if self.fail:
            raise RuntimeError("commit refused")
        from types import SimpleNamespace
        return SimpleNamespace(statusmessage=self.answer or sql)

    def close(self) -> None:
        self.close_calls += 1


class SessionAnswers(unittest.TestCase):
    def setUp(self) -> None:
        from orgtree import pgstore
        self.pgstore = pgstore
        for state in (pgfeed._local, pgfeed._local_set, pgfeed._inflight, pgfeed._committed):
            state.clear()
            self.addCleanup(state.clear)

    def conn(self, raw: _Raw):
        pgfeed.begin_local("a", 7)
        raw._ot_pending = [("a", 7)]
        return self.pgstore.PgConn(raw, "a", 1)

    def test_a_successful_commit_confirms_but_does_not_publish(self) -> None:
        raw = _Raw()
        self.conn(raw).execute("COMMIT")
        self.assertEqual((pgfeed._committed["a"], pgfeed._inflight["a"], raw._ot_pending),
                         ({7}, set(), []))
        self.assertEqual(pgfeed._local_set.get("a", set()), set())   # note_local's job

    def test_a_commit_the_server_answers_with_rollback_confirms_nothing(self) -> None:
        raw = _Raw(answer="ROLLBACK")                    # COMMIT of an aborted transaction
        self.conn(raw).execute("COMMIT")
        self.assertEqual((pgfeed._committed.get("a", set()), pgfeed._inflight["a"]), (set(), set()))

    def test_a_session_closed_by_release_never_confirms_it(self) -> None:
        raw = _Raw()
        raw.closed = True                                # not reusable: _release closes it
        raw._ot_pending = [("a", 7)]
        pgfeed.begin_local("a", 7)
        self.pgstore._release(raw)
        self.assertEqual((pgfeed._committed.get("a", set()), pgfeed._inflight["a"], raw._ot_pending),
                         (set(), set(), []))

    def test_a_rollback_releases_its_revisions_as_not_ours(self) -> None:
        raw = _Raw()
        self.conn(raw).execute("ROLLBACK")
        self.assertEqual((pgfeed._committed.get("a", set()), pgfeed._inflight["a"]), (set(), set()))

    def test_a_failed_commit_releases_its_revisions_as_not_ours(self) -> None:
        raw = _Raw(fail=True)
        with self.assertRaises(RuntimeError):
            self.conn(raw).execute("COMMIT")
        self.assertEqual((pgfeed._committed.get("a", set()), pgfeed._inflight["a"]), (set(), set()))

    def test_a_pinned_commit_that_does_not_reach_the_server_confirms_nothing(self) -> None:
        raw = _Raw()
        conn = self.conn(raw)
        conn.pinned = True                               # an org_tx's earlier save
        conn.execute("COMMIT")
        self.assertEqual((raw.ran, pgfeed._inflight["a"]), ([], {7}))

    def test_a_session_returned_to_the_pool_never_confirms_it_later(self) -> None:
        raw = _Raw()
        raw._ot_pending = [("a", 7)]
        pgfeed.begin_local("a", 7)
        self.pgstore._settle_revisions(raw, False)       # what _release/_checkout do
        self.pgstore.PgConn(raw, "a", 1).execute("COMMIT")   # an unrelated later commit
        self.assertEqual((pgfeed._committed.get("a", set()), pgfeed._inflight["a"]), (set(), set()))


if __name__ == "__main__":
    unittest.main()
