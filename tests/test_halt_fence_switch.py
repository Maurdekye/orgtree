"""S8 (lead, 2026-09-26): ONE fence switch. halt's transition fence used to be
hard-coded on (`halt._FENCE = True`), so with ORGTREE_ORGTX_FENCE=0 every
halt transaction still took DOC_LOCK and a "fence-off" run measured half a
fence. halt._fence() now follows orgtx.TRANSITION_FENCE at call time.

What these prove, over a throwaway SQLite root started with
ORGTREE_ORGTX_FENCE=0:
  * the env switch reaches orgtx.TRANSITION_FENCE, and halt.txn then takes
    NO DOC_LOCK: DOC_LOCK is replaced by a lock that raises on any acquire;
  * flipping orgtx.TRANSITION_FENCE on at run time makes the same halt.txn
    take DOC_LOCK again (the raising lock fires), so the test can fail;
  * the test-only override `halt._FENCE` still wins when set.

Run:  python tools/run-python-verification.py tests/test_halt_fence_switch.py
"""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-halt-fence-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_FENCE='0')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, orgtx, store  # noqa: E402


def tearDownModule() -> None:
    _temp.cleanup()


class _RaisingLock:
    """Stands in for DOC_LOCK: any acquisition is the failure under test."""

    def __init__(self) -> None:
        self.tries = 0

    def acquire(self, *_a, **_k) -> bool:
        self.tries += 1
        raise AssertionError('DOC_LOCK acquired')

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, *_exc) -> bool:
        return False

    def release(self) -> None:
        pass

    def _is_owned(self) -> bool:
        return False


class HaltFenceSwitch(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(f'hf-{self._testMethodName}'[:60])
        self.slug = org.d['slug']
        org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
        store.save_org(org)
        store.save_org(store.load_org(self.slug))
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:     # settle load-heals
            tx.d['nodes']['a']['name'] = 'a0'
        self._saved = (orgtx.TRANSITION_FENCE, halt._FENCE)

    def tearDown(self) -> None:
        orgtx.TRANSITION_FENCE, halt._FENCE = self._saved

    def _halt_txn(self) -> _RaisingLock:
        lock = _RaisingLock()
        with patch.object(store, 'DOC_LOCK', lock):
            with halt.txn(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'in-halt-txn'
        return lock

    def test_env_fence_off_halt_txn_takes_no_doc_lock(self) -> None:
        self.assertFalse(orgtx.TRANSITION_FENCE, 'ORGTREE_ORGTX_FENCE=0 did not reach org_tx')
        self.assertIsNone(halt._FENCE, 'halt must follow org_tx by default')
        lock = self._halt_txn()
        self.assertEqual(lock.tries, 0)
        self.assertEqual(store.load_org(self.slug).d['nodes']['a']['name'], 'in-halt-txn')

    def test_fence_on_at_run_time_halt_txn_takes_doc_lock(self) -> None:
        orgtx.TRANSITION_FENCE = True
        with self.assertRaisesRegex(AssertionError, 'DOC_LOCK acquired'):
            self._halt_txn()

    def test_test_only_override_wins(self) -> None:
        halt._FENCE = True                           # fence on, org_tx fence off
        with self.assertRaisesRegex(AssertionError, 'DOC_LOCK acquired'):
            self._halt_txn()
        orgtx.TRANSITION_FENCE, halt._FENCE = True, False
        self.assertIs(type(halt._fence()).__name__, 'nullcontext')


if __name__ == '__main__':
    unittest.main()
