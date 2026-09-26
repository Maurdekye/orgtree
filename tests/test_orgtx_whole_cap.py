"""Memory cap on concurrent whole-org transactions (orgtx.MAX_CONCURRENT).

Every org_tx attempt loads a WHOLE Org and holds it until commit; at N=100
agents about 24 were in flight at once (mem-leak-probe). The cap bounds how
many attempts per process hold one; the rest wait BEFORE loading anything.

On the SeamBackend over a throwaway SQLite root, fence off:
  * cap 2, six writers of different rows parked inside their bodies: exactly
    two are inside, and the live Org objects grew by at most two; all six
    commit once released;
  * cap 0 is unbounded (all six inside at once);
  * a slot wait longer than the lock timeout is a LockTimeout that leaves
    nothing behind: the next org_tx on this thread runs normally;
  * a nested org_tx on ANOTHER org from inside a body at cap 1 does not wait
    for a second slot;
  * an `orgtx.uncapped` function runs while the cap is full, and the
    operator's controls (halt, unhalt, killswitch latch/release) are uncapped.

Run:  python tools/run-python-verification.py tests/test_orgtx_whole_cap.py
"""
import gc
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-whole-cap-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402

from orgtree import ledger, orgtx, store  # noqa: E402

orgtx.TRANSITION_FENCE = False
NODES = [f'n{i}' for i in range(6)]


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in NODES:
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _live_orgs() -> int:
    gc.collect()
    return sum(1 for o in gc.get_objects() if isinstance(o, ledger.Org))


class WholeCap(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.saved_cap = orgtx.MAX_CONCURRENT
        self.slug = _fresh_org(f'cap-{self._testMethodName}'[:58].replace('_', '-'))

    def tearDown(self) -> None:
        orgtx.MAX_CONCURRENT = self.saved_cap

    def _park(self, n: int):
        inside: list[str] = []
        mu = threading.Lock()
        release = threading.Event()
        errors: list[BaseException] = []

        def writer(nid: str) -> None:
            try:
                with orgtx.org_tx(self.slug, nodes=[nid], lock_timeout=20) as tx:
                    with mu:
                        inside.append(nid)
                    release.wait(20)
                    tx.d['nodes'][nid]['name'] = f'w-{nid}'
            except BaseException as e:            # noqa: BLE001  asserted below
                errors.append(e)
        ts = [threading.Thread(target=writer, args=(nid,), daemon=True) for nid in NODES[:n]]
        for t in ts:
            t.start()
        return inside, release, errors, ts

    def _settle(self, inside, want: int) -> None:
        deadline = time.monotonic() + 5
        while len(inside) < want and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.3)                         # would anyone else get in?

    def test_the_cap_bounds_bodies_and_live_orgs(self) -> None:
        orgtx.MAX_CONCURRENT = 2
        base = _live_orgs()
        inside, release, errors, ts = self._park(6)
        try:
            self._settle(inside, 2)
            self.assertEqual(len(inside), 2, inside)
            grew = _live_orgs() - base
            self.assertGreaterEqual(grew, 1)
            self.assertLessEqual(grew, 2, f'{grew} whole Orgs alive with a cap of 2')
        finally:
            release.set()
            for t in ts:
                t.join(30)
        self.assertEqual(errors, [])
        org = store.load_org(self.slug)
        self.assertEqual([org.d['nodes'][n]['name'] for n in NODES],
                         [f'w-{n}' for n in NODES])

    def test_cap_zero_is_unbounded(self) -> None:
        orgtx.MAX_CONCURRENT = 0
        inside, release, errors, ts = self._park(6)
        try:
            self._settle(inside, 6)
            self.assertEqual(len(inside), 6)
        finally:
            release.set()
            for t in ts:
                t.join(30)
        self.assertEqual(errors, [])

    def test_a_slot_timeout_leaves_nothing_behind(self) -> None:
        orgtx.MAX_CONCURRENT = 1
        # this thread has run an org_tx before, so its open-org set is the
        # shared thread-local one (a fresh thread's is a throwaway local, and
        # a mark leaked into it would go unnoticed)
        with orgtx.org_tx(self.slug, nodes=['n4'], lock_timeout=2) as tx:
            tx.d['nodes']['n4']['name'] = 'warm'
        inside, release, errors, ts = self._park(1)
        try:
            self._settle(inside, 1)
            with self.assertRaises(orgtx.LockTimeout):
                with orgtx.org_tx(self.slug, nodes=['n5'], lock_timeout=0.3):
                    self.fail('ran without a slot')
        finally:
            release.set()
            for t in ts:
                t.join(30)
        self.assertEqual(errors, [])
        # no leaked slot and no stale open-org mark on this thread
        with orgtx.org_tx(self.slug, nodes=['n5'], lock_timeout=2) as tx:
            tx.d['nodes']['n5']['name'] = 'after'
        self.assertEqual(store.load_org(self.slug).d['nodes']['n5']['name'], 'after')

    def test_a_nested_tx_on_another_org_takes_no_second_slot(self) -> None:
        orgtx.MAX_CONCURRENT = 1
        other = _fresh_org(f'cap-other-{self._testMethodName}'[:58].replace('_', '-'))
        with orgtx.org_tx(self.slug, nodes=['n0'], lock_timeout=2) as tx:
            tx.d['nodes']['n0']['name'] = 'outer'
            with orgtx.org_tx(other, nodes=['n0'], lock_timeout=1) as inner:
                inner.d['nodes']['n0']['name'] = 'inner'
        self.assertEqual(store.load_org(other).d['nodes']['n0']['name'], 'inner')
        self.assertEqual(store.load_org(self.slug).d['nodes']['n0']['name'], 'outer')

    def test_an_uncapped_control_runs_while_the_cap_is_full(self) -> None:
        orgtx.MAX_CONCURRENT = 1
        inside, release, errors, ts = self._park(1)

        @orgtx.uncapped
        def control() -> None:
            with orgtx.org_tx(self.slug, nodes=['n5'], lock_timeout=1) as tx:
                tx.d['nodes']['n5']['name'] = 'control'
        try:
            self._settle(inside, 1)
            control()                           # a LockTimeout here = queued
        finally:
            release.set()
            for t in ts:
                t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(store.load_org(self.slug).d['nodes']['n5']['name'], 'control')

    def test_the_operator_controls_are_uncapped(self) -> None:
        from orgtree import halt
        marker = orgtx.uncapped(lambda: None).__code__
        for fn in (halt.halt, halt.unhalt, halt.killswitch_latch, halt.killswitch_release):
            with self.subTest(fn.__name__):
                self.assertIs(fn.__code__, marker, f'{fn.__name__} queues behind the cap')


if __name__ == '__main__':
    unittest.main()
