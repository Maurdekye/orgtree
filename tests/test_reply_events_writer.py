"""reply_events' stream writers reuse one connection per thread.

`remember_ident` / `annotate_ident` run once per streamed frame. They keep
the old contract -- the row is committed (synchronous FULL) before the event
id is returned -- while no longer paying connect + schema + PRAGMA + close
per frame. Each test pins one way a cached connection could break it. The
data roots are temporary directories; nothing touches a real data root.
"""
import gc
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

fixture = tempfile.TemporaryDirectory(prefix="orgtree-reply-writer-")
os.environ["ORGTREE_DATA"] = str(Path(fixture.name) / "data")
Path(os.environ["ORGTREE_DATA"]).mkdir()
os.environ["ORGTREE_V2_TOKEN"] = "reply-writer-test-only"

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import reply_events, store, transcript_records  # noqa: E402


def tearDownModule():
    transcript_records.close_all()
    fixture.cleanup()


def closed(conn):
    try:
        conn.execute("SELECT 1")
    except sqlite3.ProgrammingError:
        return True
    return False


def write(text, nid="agent"):
    return reply_events.remember_ident("org", nid, "scope", 1, "src", "delta", text)


def annotate(text):
    return reply_events.annotate_ident("org", "agent", "scope", 1,
                                       {"messages": [{"role": "assistant", "text": text, "event_id": "m1"}]})


def stored(root=None):
    path = Path(root or store.DATA_ROOT) / "reply-events.sqlite3"
    fresh = sqlite3.connect(path)
    try:
        return {r[0] for r in fresh.execute("SELECT text FROM events")}
    finally:
        fresh.close()


class WriterTests(unittest.TestCase):
    def tearDown(self):
        reply_events.close_all()

    def held(self):
        return reply_events._writer_state.held

    def test_frames_reuse_one_connection_and_commit_before_returning(self):
        real = sqlite3.connect
        opened = []

        def counting(*a, **k):
            if "factory" in k:        # the writer's, not this test's reads
                opened.append(a[0])
            return real(*a, **k)
        with mock.patch.object(reply_events.sqlite3, "connect", side_effect=counting):
            for i in range(5):
                write(f"frame {i}")
                # visible to an independent connection: committed, not buffered
                self.assertIn(f"frame {i}", stored())
            annotate("annotated frame")
        self.assertEqual(len(opened), 1)
        self.assertIn("annotated frame", stored())
        conn = self.held().conn
        self.assertEqual(conn.execute("PRAGMA synchronous").fetchone()[0], 2)
        self.assertFalse(conn.in_transaction)

    def test_same_rows_as_before(self):
        eid = write("same")
        expected = reply_events._eid("scope", "src", "delta", "same")
        self.assertEqual(eid, expected)
        fresh = sqlite3.connect(Path(store.DATA_ROOT) / "reply-events.sqlite3")
        try:
            row = fresh.execute("SELECT org,agent,generation,id,text,scope FROM events "
                                "WHERE id=?", (eid,)).fetchone()
        finally:
            fresh.close()
        self.assertEqual(row, ("org", "agent", 1, expected, "same", "scope"))

    def test_error_closes_the_writer_and_leaves_no_transaction(self):
        write("before error")
        first = self.held().conn
        with self.assertRaises(RuntimeError):
            with reply_events._writer() as conn:
                conn.execute("INSERT OR IGNORE INTO events VALUES ('o','a',1,'x','rolled back','s')")
                raise RuntimeError("boom")
        self.assertTrue(closed(first))
        self.assertNotIn("rolled back", stored())
        write("after error")
        self.assertIsNot(self.held().conn, first)
        self.assertIn("after error", stored())

    def test_root_change_writes_to_the_new_root(self):
        write("old root")
        first = self.held().conn
        other = tempfile.TemporaryDirectory(prefix="orgtree-reply-writer-2-")
        try:
            with mock.patch.object(store, "DATA_ROOT", other.name):
                write("new root")
                self.assertIn("new root", stored(other.name))
                reply_events.close_all()
        finally:
            other.cleanup()          # would fail on Windows with a handle open
        self.assertTrue(closed(first))
        self.assertNotIn("new root", stored())

    def test_threads_get_their_own_connection(self):
        write("main")
        mine = self.held().conn
        seen, errors = [], []

        def worker():
            try:
                write("thread")
                seen.append(reply_events._writer_state.held.conn)
            except BaseException as exc:
                errors.append(exc)
        t = threading.Thread(target=worker)
        t.start()
        t.join(10)
        self.assertEqual(errors, [])
        self.assertIsNot(seen[0], mine)
        self.assertIn("thread", stored())
        other = seen.pop()
        gc.collect()
        self.assertTrue(closed(other), "a finished thread's writer stays open")

    def test_root_change_releases_other_threads_idle_writers(self):
        parked, go, done = threading.Event(), threading.Event(), threading.Event()
        seen = []

        def worker():
            write("worker old root")
            seen.append(reply_events._writer_state.held.conn)
            parked.set()
            go.wait(10)          # the thread lives on, idle, holding its writer
            done.set()
        t = threading.Thread(target=worker)
        t.start()
        self.assertTrue(parked.wait(10))
        other = tempfile.TemporaryDirectory(prefix="orgtree-reply-writer-3-")
        try:
            with mock.patch.object(store, "DATA_ROOT", other.name):
                write("main new root")
                self.assertTrue(closed(seen[0]), "old-root handle of an idle thread")
                reply_events.close_all()
        finally:
            go.set()
            t.join(10)
            other.cleanup()
        write("back on the first root")   # switching back works too
        self.assertIn("back on the first root", stored())

    def test_transcript_records_close_all_releases_writers(self):
        write("x")
        conn = self.held().conn
        transcript_records.close_all()
        self.assertTrue(closed(conn))
        self.assertIsNone(self.held().conn)

    def test_busy_writer_is_deferred_then_closed(self):
        with reply_events._writer() as conn:
            self.assertEqual(reply_events.close_all(), 1)
            self.assertFalse(closed(conn))
        self.assertTrue(closed(conn))


if __name__ == "__main__":
    unittest.main()
