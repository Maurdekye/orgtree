"""Slice C: transcript_records.database() reuses one connection per thread.

The contract it keeps is the old one — every call is a `with conn:` that
commits on success and rolls back on error — so each test pins one place a
cached connection could break it: a nested call, an error, a DATA_ROOT
change, another thread, and a thread that exits. The data roots are
temporary directories; nothing here touches a real data root.
"""
import gc
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

fixture = tempfile.TemporaryDirectory(prefix="orgtree-transcript-conn-cache-")
os.environ["ORGTREE_DATA"] = str(Path(fixture.name) / "data")
Path(os.environ["ORGTREE_DATA"]).mkdir()
os.environ["ORGTREE_V2_TOKEN"] = "transcript-conn-cache-test-only"

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store, transcript_records as records  # noqa: E402


def closed(conn):
    try:
        conn.execute("SELECT 1")
    except sqlite3.ProgrammingError:
        return True
    return False


class ConnectionCacheTests(unittest.TestCase):
    def setUp(self):
        with records.database() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS cache_probe (k TEXT PRIMARY KEY)")
            conn.execute("DELETE FROM cache_probe")

    def keys(self):
        with records.database() as conn:
            return sorted(r[0] for r in conn.execute("SELECT k FROM cache_probe"))

    def test_sequential_calls_on_one_thread_reuse_one_connection(self):
        with records.database() as first:
            pass
        with records.database() as second:
            self.assertEqual(second.execute("PRAGMA synchronous").fetchone()[0], 2)
        self.assertIs(first, second)
        self.assertFalse(closed(first))

    def test_a_nested_call_gets_its_own_connection_and_cannot_commit_the_outer(self):
        with self.assertRaises(RuntimeError):
            with records.database() as outer:
                outer.execute("INSERT INTO cache_probe VALUES ('outer')")
                # The outer block holds the write lock, so the inner one only
                # reads (a fresh connection could not write here either).
                with records.database() as inner:
                    self.assertIsNot(inner, outer)
                    self.assertEqual(inner.execute("PRAGMA synchronous").fetchone()[0], 2)
                    self.assertEqual(inner.execute("SELECT k FROM cache_probe").fetchall(), [])
                self.assertTrue(closed(inner), "the nested connection was not closed")
                self.assertTrue(outer.in_transaction, "the inner block ended the outer transaction")
                raise RuntimeError("abort the outer block")
        self.assertEqual(self.keys(), [], "the outer block's insert survived its rollback")

    def test_an_error_rolls_back_and_the_next_call_opens_a_new_connection(self):
        with records.database() as before:
            pass
        with self.assertRaises(RuntimeError):
            with records.database() as conn:
                self.assertIs(conn, before)
                conn.execute("INSERT INTO cache_probe VALUES ('lost')")
                raise RuntimeError("boom")
        self.assertTrue(closed(before), "a connection that saw an error stayed cached")
        with records.database() as after:
            self.assertIsNot(after, before)
        self.assertEqual(self.keys(), [])

    def test_a_committed_block_is_visible_to_a_fresh_connection(self):
        with records.database() as conn:
            conn.execute("INSERT INTO cache_probe VALUES ('kept')")
        path = Path(store.DATA_ROOT) / "transcript-records.sqlite3"
        with sqlite3.connect(path) as other:
            self.assertEqual(other.execute("SELECT k FROM cache_probe").fetchall(), [("kept",)])
        other.close()

    def test_a_data_root_change_replaces_the_cached_connection(self):
        old_root = store.DATA_ROOT
        with records.database() as old:
            pass
        with tempfile.TemporaryDirectory(dir=fixture.name) as new_root:
            store.DATA_ROOT = new_root
            try:
                with records.database() as new:
                    self.assertIsNot(new, old)
                    self.assertEqual(new.execute("PRAGMA database_list").fetchone()[2],
                                     str(Path(new_root) / "transcript-records.sqlite3"))
                self.assertTrue(closed(old), "the old root's connection stayed open")
            finally:
                store.DATA_ROOT = old_root
                with records.database():
                    pass  # back on the old root: releases new_root's file
        self.assertTrue(closed(new))

    def test_a_data_root_change_closes_other_threads_idle_connections(self):
        old_root = store.DATA_ROOT
        cached, go, done, leave = [], threading.Event(), threading.Event(), threading.Event()

        def worker():
            with records.database() as conn:
                cached.append(conn)
            go.wait(30)
            with records.database() as again:
                cached.append(again)
            done.set()
            # stay alive: a thread's exit closes its connection, and two
            # threads must never touch one connection at once
            leave.wait(30)
        thread = threading.Thread(target=worker)
        thread.start()
        try:
            for _ in range(300):
                if cached:
                    break
                threading.Event().wait(0.1)
            self.assertEqual(len(cached), 1, "the worker did not cache a connection")
            with tempfile.TemporaryDirectory(dir=fixture.name) as new_root:
                store.DATA_ROOT = new_root
                try:
                    with records.database():
                        pass
                    self.assertTrue(closed(cached[0]), "an idle thread kept the old root open")
                    go.set()
                    self.assertTrue(done.wait(30))
                    self.assertFalse(closed(cached[1]))
                    self.assertEqual(cached[1].execute("PRAGMA database_list").fetchone()[2],
                                     str(Path(new_root) / "transcript-records.sqlite3"))
                finally:
                    store.DATA_ROOT = old_root
                    with records.database():
                        pass  # closes the worker's and this thread's new_root files
        finally:
            go.set()
            leave.set()
            thread.join(30)

    def test_each_thread_has_its_own_connection_and_it_closes_with_the_thread(self):
        with records.database() as mine:
            pass
        seen = []

        def worker():
            with records.database() as conn:
                conn.execute("INSERT INTO cache_probe VALUES ('thread')")
                seen.append(conn)
            with records.database() as again:
                seen.append(again)
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
        self.assertEqual(len(seen), 2, "the worker did not run")
        self.assertIs(seen[0], seen[1])
        self.assertIsNot(seen[0], mine)
        self.assertEqual(self.keys(), ["thread"])
        conn = seen[0]
        seen.clear()
        gc.collect()
        self.assertTrue(closed(conn), "a finished thread's connection stayed open")


if __name__ == "__main__":
    unittest.main()
