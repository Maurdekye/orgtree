"""S8 (FENCE-OFF-PLAN): the DOC_LOCK tripwire in store.py.

The transition fence can be switched off only when no live code writes
through the legacy whole-document cycle after startup. The tripwire turns
that into a measurement. Armed, it counts per call site:
  * `legacy` — an outermost DOC_LOCK acquisition that is not the fence;
  * `fence`  — DOC_LOCK taken as the transition fence (store.FENCE);
  * `save`   — save_org with no org_tx open on the thread.
Armed to raise, a legacy or save event raises `DocLockTripped`; a fence
event never does. The gate is legacy_total == save_total == 0 with the
fence ON (p01 review, 13:30Z).

What these prove, over a throwaway SQLite root:
  * a site is `file:function:line <- file:function:line` — the first frame
    outside the lock/save machinery (store.write_org included) and its
    caller; a re-entrant acquire and a Condition.wait re-acquire are not
    counted;
  * raise mode refuses a legacy acquire before taking the lock, and a save
    outside an org_tx before writing; a save inside an org_tx is not counted;
  * BOTH DIRECTIONS: a converted route (api.document_dismiss) runs under
    raise mode with the fence ON without tripping — its DOC_LOCK is booked
    as `fence`, attributed to the route — and a deliberately legacy call
    trips with the expected site string;
  * with the fence OFF a converted org_tx records nothing at all;
  * the env arming defaults, the test context manager's restore, and the
    state-access diagnostics report.

Run:  python tools/run-python-verification.py tests/test_doc_lock_tripwire.py
"""

import os
from pathlib import Path
import re
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

SITE = re.compile(r'^[\w.]+:\w+:\d+ <- [\w.]+:\w+:\d+$')
ME = 'test_doc_lock_tripwire.py'


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


def _legacy_save(slug: str) -> None:
    store.save_org(store.load_org(slug))


def _only(bucket: dict) -> tuple[str, int]:
    items = list(bucket.items())
    assert len(items) == 1, bucket
    return items[0]


class Tripwire(unittest.TestCase):
    def setUp(self) -> None:
        store.arm_doc_lock_tripwire('off')
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = store.create_org(f'tw-{self._testMethodName}'[:60]).d['slug']
        org = store.load_org(self.slug)
        org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:     # settle load-heals first
            tx.d['nodes']['a']['name'] = 'a0'
        self._fence = orgtx.TRANSITION_FENCE

    def tearDown(self) -> None:
        store.arm_doc_lock_tripwire('off')
        orgtx.TRANSITION_FENCE = self._fence

    def test_legacy_count_names_the_site_and_its_caller(self) -> None:
        with store.doc_lock_tripwire(raising=False) as counts:
            _legacy_writer()
            _legacy_writer()
        site, n = _only(counts['legacy'])
        self.assertEqual(n, 2)
        self.assertRegex(site, SITE)
        self.assertTrue(site.startswith(f'{ME}:_legacy_writer:'), site)
        self.assertIn(f' <- {ME}:test_legacy_count_names_the_site_and_its_caller:', site)
        self.assertEqual((counts['fence'], counts['save']), ({}, {}))

    def test_write_org_is_attributed_to_its_caller(self) -> None:
        with store.doc_lock_tripwire(raising=False) as counts:
            _write_org_caller(self.slug)
        site, n = _only(counts['legacy'])
        self.assertEqual(n, 1)
        self.assertTrue(site.startswith(f'{ME}:_write_org_caller:'), site)

    def test_condition_wait_reacquire_is_not_counted(self) -> None:
        cond = threading.Condition(store.DOC_LOCK)
        with store.doc_lock_tripwire(raising=False) as counts:
            with cond:
                cond.wait(0.05)
        self.assertEqual(sum(counts['legacy'].values()), 1, counts)

    def test_raise_mode_refuses_a_legacy_acquire_before_taking_the_lock(self) -> None:
        with store.doc_lock_tripwire() as counts:
            with self.assertRaises(store.DocLockTripped) as cm:
                _legacy_writer()
        self.assertEqual(cm.exception.kind, 'legacy')
        self.assertTrue(cm.exception.site.startswith(f'{ME}:_legacy_writer:'))
        self.assertEqual(sum(counts['legacy'].values()), 1)
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

    def test_a_save_outside_an_org_tx_is_counted_and_refused(self) -> None:
        with store.doc_lock_tripwire(raising=False) as counts:
            _legacy_save(self.slug)
            orgtx.TRANSITION_FENCE = False
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:  # a save INSIDE: not counted
                tx.d['nodes']['a']['name'] = 'in-tx'
        site, n = _only(counts['save'])
        self.assertEqual(n, 1)
        self.assertRegex(site, SITE)
        self.assertTrue(site.startswith(f'{ME}:_legacy_save:'), site)
        before = store.load_org(self.slug).d['nodes']['a']['name']
        with store.doc_lock_tripwire():
            org = store.load_org(self.slug)
            org.d['nodes']['a']['name'] = 'never-written'
            with self.assertRaises(store.DocLockTripped) as cm:
                store.save_org(org)
        self.assertEqual(cm.exception.kind, 'save')
        self.assertEqual(store.load_org(self.slug).d['nodes']['a']['name'], before)

    def test_converted_route_fence_on_does_not_trip(self) -> None:
        # DIRECTION 1: a converted route under raise mode, fence ON — its
        # DOC_LOCK is the fence, booked as such and attributed to the route
        from orgtree import api
        org = store.load_org(self.slug)
        org.d.setdefault('documents', []).append(
            {'id': 'd1', 'node': 'a', 'title': 'T', 'body': 'B', 'at': '2026-09-26T00:00:00Z'})
        store.save_org(org)
        orgtx.TRANSITION_FENCE = True
        with store.doc_lock_tripwire() as counts:
            with patch.object(api, 'hub_changed'):
                out = api.document_dismiss(self.slug, 'd1')
        self.assertEqual(out, {'ok': True, 'node': 'a'})
        self.assertEqual((counts['legacy'], counts['save']), ({}, {}), counts)
        site, n = _only(counts['fence'])
        self.assertEqual(n, 1)
        self.assertRegex(site, SITE)
        self.assertTrue(site.startswith('api.py:document_dismiss:'), site)

    def test_legacy_call_trips_with_its_site(self) -> None:
        # DIRECTION 2: a deliberately legacy call trips, naming itself
        with store.doc_lock_tripwire():
            with self.assertRaises(store.DocLockTripped) as cm:
                _write_org_caller(self.slug)
        self.assertRegex(cm.exception.site, SITE)
        self.assertTrue(cm.exception.site.startswith(f'{ME}:_write_org_caller:'))
        self.assertIn(f' <- {ME}:test_legacy_call_trips_with_its_site:', cm.exception.site)

    def test_fence_off_org_tx_records_nothing(self) -> None:
        orgtx.TRANSITION_FENCE = False
        with store.doc_lock_tripwire() as counts:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'a2'
        self.assertEqual(counts, {'legacy': {}, 'fence': {}, 'save': {}})
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
        self.assertEqual((rep['mode'], rep['legacy_total']), ('count', 1))

    def test_state_access_diagnostics_serve_the_report(self) -> None:
        from orgtree import api
        store.arm_doc_lock_tripwire('count')
        _legacy_writer()
        _legacy_save(self.slug)
        rep = api.state_access_diagnostics()['doc_lock_tripwire']
        self.assertEqual((rep['mode'], rep['legacy_total'], rep['save_total'], rep['total']),
                         ('count', 1, 1, 2))
        self.assertTrue(next(iter(rep['sites']['legacy'])).startswith(f'{ME}:'))


if __name__ == '__main__':
    unittest.main()
