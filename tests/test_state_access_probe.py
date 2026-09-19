"""Phase 0 of the state-access rearchitecture: the storage-boundary probe.

Three properties, each of which the later phases build on and none of which
may regress silently:

1. `store.DOC_LOCK` is still a reentrant lock and still interoperates with
   `threading.Condition` (halt.py builds one on it) after becoming the
   instrumented wrapper — including depth restoration across
   `Condition.wait`, which uses the RLock `_release_save`/`_acquire_restore`
   protocol.
2. The differ's change record (`stateprobe.SaveChanges`) is EXACT: a save
   reports precisely the doc keys, node ids and log sections it wrote and
   nothing else. Phase A invalidates the shared read snapshot from this
   record, so over-reporting costs performance and under-reporting serves
   readers stale data — the test refuses both directions.
3. The probe itself can never break the operation it measures: recording
   with a poisoned aggregate state must not raise, and a disabled probe
   records nothing.
"""
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

fixture = tempfile.TemporaryDirectory(prefix='orgtree-state-access-probe-')
os.environ['ORGTREE_DATA'] = fixture.name
os.environ.setdefault('ORGTREE_STORE', 'sqlite')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import stateprobe, store
from orgtree.ledger import USER


def _mk_org(slug: str):
    org = store.create_org(slug)
    org.hire(USER, None, 'haiku', 5, 'alpha', charter='probe fixture a')
    org.hire(USER, None, 'haiku', 5, 'beta', charter='probe fixture b')
    store.save_org(org)
    return store.load_org(slug)


class DocLockSemantics(unittest.TestCase):
    def test_reentrant(self):
        with store.DOC_LOCK:
            with store.DOC_LOCK:
                self.assertTrue(store.DOC_LOCK._is_owned())
        self.assertFalse(store.DOC_LOCK._is_owned())

    def test_nonblocking_acquire_refused_while_held_elsewhere(self):
        grabbed = threading.Event()
        release = threading.Event()

        def holder():
            store.DOC_LOCK.acquire()
            grabbed.set()
            release.wait(5)
            store.DOC_LOCK.release()

        t = threading.Thread(target=holder, daemon=True)
        t.start()
        self.assertTrue(grabbed.wait(5))
        self.assertFalse(store.DOC_LOCK.acquire(blocking=False))
        release.set()
        t.join(5)
        # and once free, a non-blocking acquire succeeds and releases cleanly
        self.assertTrue(store.DOC_LOCK.acquire(blocking=False))
        store.DOC_LOCK.release()

    def test_condition_interop_and_depth_restore(self):
        """The halt.py shape: Condition(store.DOC_LOCK), wait under a nested
        hold, notify from another thread. Failure modes this pins: wait
        never waking (broken _release_save), and the depth counter coming
        back wrong (release() after the wait would underflow or leak)."""
        cond = threading.Condition(store.DOC_LOCK)
        flag: list[str] = []

        def waiter():
            with store.DOC_LOCK:            # depth 1
                with cond:                  # depth 2, same lock
                    flag.append('waiting')
                    ok = cond.wait(timeout=5)
                    flag.append('woke' if ok else 'timeout')
            flag.append('released')

        t = threading.Thread(target=waiter, daemon=True)
        t.start()
        for _ in range(500):
            if 'waiting' in flag:
                break
            threading.Event().wait(0.01)
        # the waiter is parked inside cond.wait: the lock must be FREE here
        with store.DOC_LOCK:
            pass
        with cond:
            cond.notify_all()
        t.join(5)
        self.assertEqual(flag, ['waiting', 'woke', 'released'])
        self.assertFalse(store.DOC_LOCK._is_owned())


class SaveChangeRecord(unittest.TestCase):
    """The record is read from the probe's recent ring, through the same
    labelled path production uses."""

    def _last_change(self):
        recent = [r for r in stateprobe.snapshot()['recent']
                  if r.get('metric') == 'save_doc' and 'changed' in r]
        self.assertTrue(recent, 'no save_doc record with changes reached the probe')
        return recent[-1]['changed']

    def test_single_node_save_reports_exactly_that_node(self):
        org = _mk_org('probe-node')
        with stateprobe.operation('test:one-node'):
            with store.DOC_LOCK:
                org.node('alpha')['state'] = 'working'
                store.save_org(org)
        ch = self._last_change()
        self.assertEqual(ch['node_updates'], ['alpha'])
        self.assertEqual(ch['node_inserts'], [])
        self.assertEqual(ch['node_deletes'], [])
        self.assertEqual(ch['doc_upserts'], [])
        # events may legitimately ride along only if something appended one —
        # a bare field write appends nothing
        self.assertEqual(ch['log_sections'], [])

    def test_log_append_reports_section_and_row(self):
        org = _mk_org('probe-log')
        with stateprobe.operation('test:log-append'):
            with store.DOC_LOCK:
                store.log_append(org.d, 'events',
                                 {'op': 'probe', 'at': '2026-09-19T00:00:00Z'})
                store.save_org(org)
        ch = self._last_change()
        self.assertEqual(ch['log_sections'], ['events'])
        self.assertEqual(ch['log_rows'], 1)
        self.assertEqual(ch['node_updates'], [])

    def test_doc_key_change_reports_exactly_that_key(self):
        org = _mk_org('probe-doc')
        with stateprobe.operation('test:doc-key'):
            with store.DOC_LOCK:
                org.d['compact_at'] = 0.5
                store.save_org(org)
        ch = self._last_change()
        self.assertEqual(ch['doc_upserts'], ['compact_at'])
        self.assertEqual(ch['node_updates'], [])

    def test_unchanged_save_reports_empty(self):
        org = _mk_org('probe-noop')
        with stateprobe.operation('test:noop'):
            with store.DOC_LOCK:
                store.save_org(org)     # nothing mutated since load
        recent = [r for r in stateprobe.snapshot()['recent']
                  if r.get('metric') == 'save_doc' and 'changed' in r
                  and 'probe-noop' not in str(r)]
        # an empty change set is recorded WITHOUT a detail row (the ring is
        # for changes); the aggregate still counts the save
        ops = stateprobe.snapshot()['operations']
        self.assertIn('test:noop', ops)
        self.assertGreaterEqual(ops['test:noop']['save_doc']['n'], 1)
        for r in recent:
            self.assertNotEqual(r.get('op'), 'test:noop')


class ProbeSafety(unittest.TestCase):
    def test_disabled_probe_records_nothing(self):
        stateprobe.set_enabled(False)
        try:
            before = stateprobe.snapshot()['operations'].get('test:disabled')
            with stateprobe.operation('test:disabled'):
                stateprobe.record('load_doc', ms=1.0, nbytes=10)
            after = stateprobe.snapshot()['operations'].get('test:disabled')
            self.assertEqual(before, after)
        finally:
            stateprobe.set_enabled(True)

    def test_record_never_raises(self):
        # a label resolver that explodes must degrade to the unlabelled
        # bucket, not to a failed operation
        stateprobe.label_deferred(lambda: 1 / 0)
        try:
            stateprobe.record('load_doc', ms=1.0, nbytes=10)
            self.assertIn('(unlabelled)',
                          stateprobe.snapshot()['operations'])
        finally:
            stateprobe.refine('(unlabelled)')

    def test_refine_overrides_deferred_label(self):
        stateprobe.label_deferred(lambda: 'HTTP GET /x')
        stateprobe.refine('tool:orgtree_message')
        try:
            self.assertEqual(stateprobe.current_op(), 'tool:orgtree_message')
        finally:
            stateprobe.refine('(unlabelled)')


if __name__ == '__main__':
    unittest.main()
