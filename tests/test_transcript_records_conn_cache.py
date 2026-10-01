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


def tearDownModule():
    records.close_all()
    fixture.cleanup()


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

    def test_a_sweep_never_closes_a_connection_another_thread_is_using(self):
        old_root = store.DATA_ROOT
        inside, leave, result = threading.Event(), threading.Event(), []

        def worker():
            with records.database() as conn:
                inside.set()
                leave.wait(30)
                # still usable after the other thread's root change swept
                result.append(conn.execute("SELECT count(*) FROM cache_probe").fetchone()[0])
        thread = threading.Thread(target=worker)
        thread.start()
        try:
            self.assertTrue(inside.wait(30))
            with tempfile.TemporaryDirectory(dir=fixture.name) as new_root:
                store.DATA_ROOT = new_root
                try:
                    with records.database():
                        pass  # sweeps every idle connection to the old root
                finally:
                    store.DATA_ROOT = old_root
                    with records.database():
                        pass
        finally:
            leave.set()
            thread.join(30)
        self.assertEqual(result, [0], "the busy connection was closed under its thread")

    def test_explicit_disposal_allows_deleting_a_data_root(self):
        old_root = store.DATA_ROOT
        cached, leave = [], threading.Event()

        def worker():
            with records.database() as conn:
                cached.append(conn)
            leave.wait(30)
        new_root = tempfile.mkdtemp(dir=fixture.name)
        thread = threading.Thread(target=worker)
        # the store may hold the long spelling while the deleter holds the
        # temp folder's 8.3 short one (C:\Users\NCOLA_~1 on this machine)
        store.DATA_ROOT = os.path.realpath(new_root)
        try:
            with records.database() as mine:
                pass
            thread.start()
            for _ in range(300):
                if cached:
                    break
                threading.Event().wait(0.1)
            self.assertEqual(len(cached), 1, "the worker did not cache a connection")
            self.assertFalse(closed(mine))
            import shutil
            self.assertEqual(records.close_all(), 0)
            shutil.rmtree(new_root)
            self.assertFalse(os.path.exists(new_root))
            self.assertTrue(closed(mine))
            self.assertTrue(closed(cached[0]))
        finally:
            leave.set()
            thread.join(30)
            store.DATA_ROOT = old_root
            with records.database():
                pass

    def test_explicit_disposal_allows_removing_the_database_file(self):
        old_root = store.DATA_ROOT
        new_root = tempfile.mkdtemp(dir=fixture.name)
        store.DATA_ROOT = os.path.realpath(new_root)
        try:
            with records.database() as mine:
                pass
            db = Path(new_root) / "transcript-records.sqlite3"  # the short spelling
            self.assertEqual(records.close_all(), 0)
            os.remove(os.fsencode(db))
            self.assertTrue(closed(mine))
            # closing the last connection removed the WAL companions too
            for gone in (db, Path(str(db) + "-wal"), Path(str(db) + "-shm")):
                self.assertFalse(gone.exists(), gone.name)
        finally:
            store.DATA_ROOT = old_root
            with records.database():
                pass

    def test_fresh_thread_root_switch_closes_old_idle_handles(self):
        old_root = store.DATA_ROOT
        cached, ready, leave = [], threading.Event(), threading.Event()

        def old_worker():
            with records.database() as conn:
                cached.append(conn)
            ready.set()
            leave.wait(10)

        def fresh_worker():
            with records.database() as conn:
                cached.append(conn)

        worker = threading.Thread(target=old_worker)
        worker.start()
        try:
            self.assertTrue(ready.wait(10))
            with tempfile.TemporaryDirectory(dir=fixture.name) as new_root:
                store.DATA_ROOT = new_root
                try:
                    fresh = threading.Thread(target=fresh_worker)
                    fresh.start()
                    fresh.join(10)
                    self.assertFalse(fresh.is_alive())
                    self.assertEqual(len(cached), 2)
                    self.assertTrue(closed(cached[0]), "fresh thread missed the old idle cache")
                finally:
                    store.DATA_ROOT = old_root
                    records.close_all()
        finally:
            leave.set()
            worker.join(10)

    def test_disposal_defers_busy_handle_until_context_exit(self):
        with records.database() as conn:
            conn.execute("INSERT INTO cache_probe VALUES ('busy')")
            self.assertEqual(records.close_all(), 1)
            self.assertFalse(closed(conn))
            self.assertEqual(records.close_all(), 1, "repeated disposal must stay safe")
            self.assertTrue(conn.in_transaction)
        self.assertTrue(closed(conn), "busy handle must close on release")
        self.assertEqual(self.keys(), ['busy'], "disposal must allow the owner to commit")

    def test_busy_old_root_handle_closes_on_release_while_thread_stays_alive(self):
        old_root = store.DATA_ROOT
        inside, release, released, leave = (threading.Event() for _ in range(4))
        seen = []

        def worker():
            with records.database() as conn:
                seen.append(conn)
                inside.set()
                release.wait(10)
                conn.execute("INSERT INTO cache_probe VALUES ('old-root')")
            released.set()
            leave.wait(10)

        thread = threading.Thread(target=worker)
        thread.start()
        try:
            self.assertTrue(inside.wait(10))
            with tempfile.TemporaryDirectory(dir=fixture.name) as new_root:
                store.DATA_ROOT = new_root
                try:
                    with records.database():
                        pass
                    release.set()
                    self.assertTrue(released.wait(10))
                    self.assertTrue(closed(seen[0]))
                finally:
                    records.close_all()
                    store.DATA_ROOT = old_root
        finally:
            release.set()
            leave.set()
            thread.join(10)
        self.assertEqual(self.keys(), ['old-root'])

    def test_explicit_close_allows_root_folder_rename(self):
        old_root = store.DATA_ROOT
        with tempfile.TemporaryDirectory(dir=fixture.name) as parent:
            source, target = Path(parent) / 'source', Path(parent) / 'target'
            store.DATA_ROOT = str(source)
            try:
                with records.database() as conn:
                    conn.execute("INSERT INTO transcript_owned VALUES ('survives-rename')")
                self.assertEqual(records.close_all(), 0)
                self.assertTrue(closed(conn))
                source.rename(target)  # also exercised on Windows, which locks open databases
                store.DATA_ROOT = str(target)
                with records.database() as moved:
                    self.assertEqual(moved.execute("SELECT source FROM transcript_owned").fetchall(),
                                     [('survives-rename',)])
            finally:
                records.close_all()
                store.DATA_ROOT = old_root

    def test_disposal_during_connection_preparation_does_not_leave_a_cached_handle(self):
        from unittest.mock import patch
        records.close_all()
        prepare = records._prepare

        def disposing_prepare(conn, path):
            prepare(conn, path)
            records.close_all()

        with patch.object(records, '_prepare', side_effect=disposing_prepare):
            with records.database() as conn:
                self.assertEqual(conn.execute('SELECT 1').fetchone(), (1,))
        self.assertTrue(closed(conn))

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
