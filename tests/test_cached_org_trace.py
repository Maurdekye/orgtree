"""Bounded disposable caller/wait diagnostics, without a live engine."""
import importlib.util
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

spec = importlib.util.spec_from_file_location('cache_trace_under_test',
    Path(__file__).resolve().parents[1]/'tools/scale/cached_org_trace.py')
trace_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace_module)


class CacheTraceControls(unittest.TestCase):
    def fixture(self):
        lock = threading.Lock()
        store = SimpleNamespace(_rebuild_mutex=lambda slug: lock,
            _assemble_snapshot=lambda slug: None, _load_pinned=lambda slug: 'loaded')
        def cached(slug):
            with store._rebuild_mutex(slug):
                store._assemble_snapshot(slug)
                return store._load_pinned(slug)
        store.cached_org = cached
        return store, lock

    def test_real_mutex_wait_is_attributed_to_caller(self):
        store, lock = self.fixture()
        trace = trace_module.install(store)
        entered = threading.Event()
        result = []
        def caller():
            entered.set()
            result.append(store.cached_org('not-retained'))
        lock.acquire()
        thread = threading.Thread(target=caller)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            time.sleep(0.03)
            self.assertTrue(thread.is_alive(), 'negative control must really block')
        finally:
            lock.release()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ['loaded'])
        rows = trace.snapshot()['rows']
        waits = [row for row in rows if row['phase']=='mutex_acquire']
        self.assertEqual(len(waits), 1)
        self.assertTrue(waits[0]['caller'].endswith(':caller'))
        self.assertGreater(waits[0]['wall_ns'], 10_000_000)
        self.assertIn('_load_pinned', {row['phase'] for row in rows})
        self.assertNotIn('not-retained', str(rows))

    def test_cardinality_is_bounded_and_overflow_is_reported(self):
        trace = trace_module.CacheTrace(limit=3)
        for i in range(10):
            trace.record(str(i), 'total', 1, 1)
        result = trace.snapshot()
        self.assertEqual(len(result['rows']), 3)
        self.assertEqual(result['dropped'], 7)

    def test_exception_keeps_original_result_and_restores_thread_context(self):
        store, lock = self.fixture()
        def fail(slug):
            raise ValueError('original')
        store._load_pinned = fail
        trace = trace_module.install(store)
        with self.assertRaisesRegex(ValueError, 'original'):
            store.cached_org('x')
        self.assertIsNone(trace.local.caller)
        self.assertFalse(lock.locked())
        self.assertEqual({row['phase'] for row in trace.snapshot()['rows']},
                         {'total','mutex_acquire','_assemble_snapshot','_load_pinned'})


if __name__ == '__main__':
    unittest.main()
