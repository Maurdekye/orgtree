"""Stream commits must not depend on a sampler releasing Python frames."""
import concurrent.futures
import gc
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='reply-cursor-lifetime-')
os.environ['ORGTREE_DATA'] = _root.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import reply_events, store


def tearDownModule():
    gc.collect()
    _root.cleanup()


class ReplyCursorLifetime(unittest.TestCase):
    def test_commit_with_setup_cursor_frame_retained_by_another_thread(self):
        entered, resume = threading.Event(), threading.Event()
        connect = reply_events.sqlite3.connect
        opened, errors, results = [], [], []

        def traced_connect(*args, **kwargs):
            conn = connect(*args, **kwargs)
            opened.append(conn)

            def trace(sql):
                if sql.upper() == 'PRAGMA JOURNAL_MODE=WAL':
                    entered.set()
                    resume.wait(5)

            conn.set_trace_callback(trace)
            return conn

        def writer():
            try:
                results.append(reply_events.annotate_ident(
                    'sampled', 'agent', 'scope', 0,
                    {'messages': [{'event_id': 'source', 'text': 'durable marker'}]}))
            except BaseException as error:
                errors.append(error)
            finally:
                # Clean up even on the deliberately broken base/mutants.
                for conn in opened:
                    conn.close()

        sampled = None
        with patch.object(reply_events.sqlite3, 'connect', traced_connect):
            thread = threading.Thread(target=writer)
            thread.start()
            try:
                self.assertTrue(entered.wait(5), 'PRAGMA gate was not exercised')
                sampled = sys._current_frames()[thread.ident]
                frame = sampled
                cursor_frame = False
                while frame:
                    if frame.f_code.co_name == 'execute' and 'census_contacts' in frame.f_code.co_filename:
                        cursor_frame = True
                    frame = frame.f_back
                self.assertTrue(cursor_frame, 'sampler must retain the actual cursor execute frame')
                resume.set()
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(len(results), 1)
            finally:
                resume.set()
                thread.join(5)
                sampled = None
                gc.collect()

        row = results[0]['messages'][0]
        # Read from an independent connection, so a skipped commit cannot pass.
        self.assertEqual(reply_events.lookup('sampled', 'agent', 0, row['event_id'], 'scope'),
                         'durable marker')

    def test_concurrent_annotations_keep_every_snapshot(self):
        reply_events.annotate_ident('parallel', 'warm', 'scope', 0, {})
        start = threading.Barrier(4)

        def worker(n):
            start.wait(timeout=5)
            for i in range(20):
                text = f'marker {n}-{i}'
                result = reply_events.annotate_ident('parallel', str(n), 'scope', 0,
                    {'messages': [{'event_id': f'{n}-{i}', 'text': text}]})
                eid = result['messages'][0]['event_id']
                self.assertEqual(reply_events.lookup('parallel', str(n), 0, eid, 'scope'), text)

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(worker, range(4)))
        self.assertEqual(sum(reply_events.count('parallel', str(n)) for n in range(4)), 80)


if __name__ == '__main__':
    unittest.main()
