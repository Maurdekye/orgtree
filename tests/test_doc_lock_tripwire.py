"""S8 (FENCE-OFF-PLAN): the DOC_LOCK tripwire in store.py.

The transition fence can be switched off only when nothing live takes
DOC_LOCK after startup. The tripwire turns that into a measurement: armed,
every OUTERMOST DOC_LOCK acquisition is counted against its call site, or
raises `DocLockTripped` when armed to raise (tests).

What these prove, over a throwaway SQLite root:
  * count mode counts one hit per outermost acquisition, at the caller's
    file:function:line — not at the lock machinery, contextlib or the
    store.write_org helper; a re-entrant acquire and a Condition.wait
    re-acquire are not counted;
  * raise mode raises before taking the lock (nothing is left held);
  * an org_tx with the fence ON is counted at orgtx's fence; with the fence
    OFF a row-only org_tx takes no DOC_LOCK at all;
  * the env arming defaults (off on SQLite, count on PostgreSQL) and the
    test context manager restore the previous state;
  * the state-access diagnostics serve the report.

Run:  python tools/run-python-verification.py tests/test_doc_lock_tripwire.py
"""

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-tripwire-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
os.environ.pop('ORGTREE_DOC_LOCK_TRIPWIRE', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402


def tearDownModule() -> None:
    store.arm_doc_lock_tripwire('off')
    _temp.cleanup()


def _legacy_writer() -> None:
    with store.DOC_LOCK:
        with store.DOC_LOCK:                 # re-entrant: not a second hit
            pass


def _write_org_caller(slug: str) -> None:
    with store.write_org(slug):
        pass


def _only(counts: dict) -> tuple[str, int]:
    self_items = list(counts.items())
    assert len(self_items) == 1, counts
    return self_items[0]


class Tripwire(unittest.TestCase):
    def setUp(self) -> None:
        store.arm_doc_lock_tripwire('off')
        self.slug = store.create_org(f'tw-{self._testMethodName}'[:60]).d['slug']

    def tearDown(self) -> None:
        store.arm_doc_lock_tripwire('off')
        orgtx.TRANSITION_FENCE = True

    def test_count_mode_counts_the_caller_once(self) -> None:
        with store.doc_lock_tripwire(raising=False) as counts:
            _legacy_writer()
            _legacy_writer()
        site, n = _only(counts)
        self.assertEqual(n, 2)
        self.assertTrue(site.startswith('test_doc_lock_tripwire.py:_legacy_writer:'), site)

    def test_write_org_is_attributed_to_its_caller(self) -> None:
        with store.doc_lock_tripwire(raising=False) as counts:
            _write_org_caller(self.slug)
        site, n = _only(counts)
        self.assertEqual(n, 1)
        self.assertTrue(site.startswith('test_doc_lock_tripwire.py:_write_org_caller:'), site)

    def test_condition_wait_reacquire_is_not_counted(self) -> None:
        cond = threading.Condition(store.DOC_LOCK)
        with store.doc_lock_tripwire(raising=False) as counts:
            with cond:
                cond.wait(0.05)
        self.assertEqual(sum(counts.values()), 1, counts)

    def test_raise_mode_refuses_before_taking_the_lock(self) -> None:
        with store.doc_lock_tripwire() as counts:
            with self.assertRaises(store.DocLockTripped) as cm:
                _legacy_writer()
        self.assertIn('_legacy_writer', cm.exception.site)
        self.assertEqual(sum(counts.values()), 1)
        self.assertFalse(store.DOC_LOCK._is_owned())
        got: list[bool] = []

        def other() -> None:
            got.append(store.DOC_LOCK.acquire(timeout=1))
            if got[-1]:
                store.DOC_LOCK.release()
        t = threading.Thread(target=other)
        t.start()
        t.join(5)
        self.assertEqual(got, [True])

    def test_org_tx_fence_on_is_counted_fence_off_is_clean(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.load_org(self.slug)
        org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:     # settle load-heals first
            tx.d['nodes']['a']['name'] = 'a0'
        orgtx.TRANSITION_FENCE = True
        with store.doc_lock_tripwire(raising=False) as counts:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'a1'
        site, n = _only(counts)
        self.assertEqual(n, 1)
        self.assertTrue(site.startswith('orgtx.py:_run:'), site)
        orgtx.TRANSITION_FENCE = False
        with store.doc_lock_tripwire():                      # raises on any DOC_LOCK
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'a2'
        self.assertEqual(store.load_org(self.slug).d['nodes']['a']['name'], 'a2')

    def test_env_arming_defaults(self) -> None:
        self.assertEqual(store.arm_doc_lock_tripwire_from_env(), 'off')
        with patch.object(store, 'STORE_BACKEND', 'postgres'):
            self.assertEqual(store.arm_doc_lock_tripwire_from_env(), 'count')
        with patch.dict(os.environ, {'ORGTREE_DOC_LOCK_TRIPWIRE': 'raise'}):
            self.assertEqual(store.arm_doc_lock_tripwire_from_env(), 'raise')
        with patch.dict(os.environ, {'ORGTREE_DOC_LOCK_TRIPWIRE': 'loud'}):
            with self.assertRaises(ValueError):
                store.arm_doc_lock_tripwire_from_env()
        store.arm_doc_lock_tripwire('off')
        _legacy_writer()
        self.assertEqual(store.doc_lock_tripwire_report()['total'], 0)

    def test_context_manager_restores_the_previous_state(self) -> None:
        store.arm_doc_lock_tripwire('count')
        _legacy_writer()
        with store.doc_lock_tripwire():
            pass
        rep = store.doc_lock_tripwire_report()
        self.assertEqual((rep['mode'], rep['total']), ('count', 1))

    def test_state_access_diagnostics_serve_the_report(self) -> None:
        from orgtree import api
        store.arm_doc_lock_tripwire('count')
        _legacy_writer()
        rep = api.state_access_diagnostics()['doc_lock_tripwire']
        self.assertEqual((rep['mode'], rep['total']), ('count', 1))
        self.assertTrue(next(iter(rep['sites'])).startswith('test_doc_lock_tripwire.py:'))


if __name__ == '__main__':
    unittest.main()
