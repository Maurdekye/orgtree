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


if __name__ == "__main__":
    unittest.main()
