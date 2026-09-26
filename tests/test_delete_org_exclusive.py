"""S8 (p01 design approval, 2026-09-26): store.delete_org excludes every
org_tx on the org with orgtx.org_exclusive(slug) — the transition fence
while it is on, then the org pseudo-row EXCLUSIVE — and loads/saves nothing.
With the fence off it takes no DOC_LOCK.

What these prove, over a throwaway SQLite root (SeamBackend):
  (i)   a transaction that loaded before the delete and commits after it
        cannot straddle the rename: the delete waits for its commit, and the
        trash copy holds the committed state;
  (ii)  a transaction queued behind a delete finds the org gone ("no such
        org"), does NOT re-create orgs/<slug>.db, and org_read and cached_org
        (a warm resident copy) raise too;
  (iii) with ORGTREE_ORGTX_FENCE=0 the delete takes no DOC_LOCK (a lock that
        raises on acquire stands in for it) — and with the fence on it does,
        so the test can fail;
  (iv)  org_exclusive refuses to nest inside an org_tx on the same org.
Mutant (run by hand): org_exclusive yielding without the exclusive lock
fails (i) and (ii).

Run:  python tools/run-python-verification.py tests/test_delete_org_exclusive.py
"""

import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-delete-excl-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_FENCE='0',
                  ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

WAIT = 10.0


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    _temp.cleanup()


class _RaisingLock:
    """Stands in for DOC_LOCK: any acquisition is the failure under test."""

    def acquire(self, *_a, **_k) -> bool:
        raise AssertionError('DOC_LOCK acquired')

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, *_exc) -> bool:
        return False

    def release(self) -> None:
        pass

    def _is_owned(self) -> bool:
        return False


def _trash_docs(slug: str) -> list[Path]:
    return sorted((data / 'deleted').glob(f'{slug}-*{store.db_ext()}'))


class DeleteOrgExclusive(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(f'dx-{self._testMethodName}'[:60])
        self.slug = org.d['slug']
        org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:     # settle load-heals
            tx.d['nodes']['a']['name'] = 'a0'
        self.db = Path(store._db_path(self.slug))
        self.assertTrue(self.db.exists())
        self._fence = orgtx.TRANSITION_FENCE
        self.errors: list[BaseException] = []

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)
        orgtx.TRANSITION_FENCE = self._fence

    def _thread(self, fn) -> threading.Thread:
        def run() -> None:
            try:
                fn()
            except BaseException as e:            # noqa: BLE001  reported by the test
                self.errors.append(e)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return t

    def test_i_tx_in_flight_blocks_the_delete(self) -> None:
        loaded, go = threading.Event(), threading.Event()

        def hook(point: str, tx) -> None:
            if point == 'after_lock' and tx.slug == self.slug:
                loaded.set()
                self.assertTrue(go.wait(WAIT))

        orgtx.set_pause_hook(hook)

        def write() -> None:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'committed-late'

        w = self._thread(write)
        self.assertTrue(loaded.wait(WAIT))
        deleted = threading.Event()
        d = self._thread(lambda: (store.delete_org(self.slug), deleted.set()))
        time.sleep(0.3)
        self.assertFalse(deleted.is_set(), 'delete ran while a transaction held the org')
        self.assertTrue(self.db.exists())
        go.set()
        w.join(WAIT)
        d.join(WAIT)
        orgtx.set_pause_hook(None)
        self.assertEqual(self.errors, [])
        self.assertTrue(deleted.is_set())
        self.assertFalse(self.db.exists(), 'the late save re-created the org')
        docs = _trash_docs(self.slug)
        self.assertEqual(len(docs), 1)
        import sqlite3
        with sqlite3.connect(docs[0]) as c:
            dump = '\n'.join(str(r) for r in c.execute('SELECT * FROM nodes'))
        self.assertIn('committed-late', dump, 'the trash copy lacks the committed write')

    def test_ii_delete_blocks_a_new_tx_which_then_finds_no_org(self) -> None:
        in_delete, go = threading.Event(), threading.Event()
        real = store._ensure_migrated

        def slow_ensure(slug: str) -> None:
            if threading.current_thread().name == 'deleter':
                in_delete.set()
                self.assertTrue(go.wait(WAIT))
            return real(slug)

        queued = threading.Event()

        def hook(point: str, tx) -> None:
            if point == 'before_lock' and tx.slug == self.slug:
                queued.set()

        store.cached_org(self.slug)                 # warm the resident copy
        orgtx.set_pause_hook(hook)
        with patch.object(store, '_ensure_migrated', slow_ensure):
            d = threading.Thread(target=lambda: store.delete_org(self.slug),
                                 name='deleter', daemon=True)
            d.start()
            self.assertTrue(in_delete.wait(WAIT))

            def write() -> None:
                with orgtx.org_tx(self.slug, nodes=['a'], lock_timeout=WAIT) as tx:
                    tx.d['nodes']['a']['name'] = 'resurrected'

            w = self._thread(write)
            self.assertTrue(queued.wait(WAIT))
            time.sleep(0.3)                     # the writer is now waiting on org:*
            go.set()
            d.join(WAIT)
            w.join(WAIT)
        self.assertFalse(d.is_alive())
        self.assertEqual(len(self.errors), 1, self.errors)
        self.assertIsInstance(self.errors[0], LedgerError)
        self.assertIn('no such org', str(self.errors[0]))
        self.assertFalse(self.db.exists(), 'the queued transaction re-created the org')
        self.assertEqual(len(_trash_docs(self.slug)), 1)
        with self.assertRaises(LedgerError):
            orgtx.org_read(self.slug)
        with self.assertRaises(LedgerError):         # the resident copy died too
            store.cached_org(self.slug)

    def test_iii_fence_off_takes_no_doc_lock(self) -> None:
        orgtx.TRANSITION_FENCE = False
        with patch.object(store, 'DOC_LOCK', _RaisingLock()):
            store.delete_org(self.slug)
        self.assertFalse(self.db.exists())

    def test_iii_fence_on_takes_doc_lock(self) -> None:
        orgtx.TRANSITION_FENCE = True
        with patch.object(store, 'DOC_LOCK', _RaisingLock()), \
                patch.object(store, 'FENCE', _RaisingLock()):
            with self.assertRaises(AssertionError):
                store.delete_org(self.slug)
        self.assertTrue(self.db.exists())

    def test_iv_not_inside_an_org_tx_on_the_same_org(self) -> None:
        with orgtx.org_tx(self.slug, nodes=['a']):
            with self.assertRaises(orgtx.NestedTx):
                with orgtx.org_exclusive(self.slug):
                    pass


if __name__ == '__main__':
    unittest.main()
