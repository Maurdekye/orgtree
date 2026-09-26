"""S8 (lead decision 7, superseding 5): the lifecycle ledger stays lock-free
for writers and still loses nothing.

`lifecycle.record` used to COALESCE onto any matching row and EVICT at the
cap, which is only safe while every writer is serialized. On the row store it
now coalesces only onto a row appended in its OWN transaction, and eviction
is one serialized pruner (`lifecycle.prune`, PRUNE_LOCK FOR UPDATE).

What these prove, on the SeamBackend fake over a throwaway SQLite root
(fence off, row compare-and-set on):
  * two transactions recording the SAME operation+state concurrently both
    commit, and no observation is lost (rows' counts add up);
  * inside one transaction a repeated state still coalesces into one row;
  * the pruner, held open while other transactions append, removes only
    rows of the committed set it loaded: every concurrent append survives,
    and it prunes to PRUNE_TO, keeping the sticky decision;
  * enough row-store appends make a prune due, and it runs after the next
    commit on that org;
  * the plain-dict (whole-document) path keeps the old in-place behaviour.

Run:  python tools/run-python-verification.py tests/test_lifecycle_lockfree.py
"""

import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-lc-lockfree-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1', ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import lifecycle, orgtx, store  # noqa: E402

orgtx.TRANSITION_FENCE = False


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    _temp.cleanup()


def _rows(slug: str) -> list[dict]:
    with store._POOL.acquire(slug) as conn:
        return [json.loads(v) for (v,) in conn.execute(
            "SELECT val FROM log_l WHERE sect='lifecycle' ORDER BY seq").fetchall()]


def _rec(d, op: str, state: str = 'accepted', at: str = 't') -> dict:
    return lifecycle.record(d, operation_id=op, kind='mail', state=state, at=at)


class LockFreeLedger(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        orgtx.set_pause_hook(None)
        org = store.create_org(f'lf-{self._testMethodName}'[:58].replace('_', '-'))
        self.slug = org.d['slug']
        store.save_org(org)
        store.save_org(store.load_org(self.slug))
        with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:    # a committed row
            _rec(tx.d, 'op:1')

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    def test_concurrent_coalescers_lose_nothing(self) -> None:
        inside, release = threading.Event(), threading.Event()
        errors: list[BaseException] = []

        def holder() -> None:
            try:
                with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
                    _rec(tx.d, 'op:1')
                    inside.set()
                    release.wait(10)
            except BaseException as e:                         # noqa: BLE001
                errors.append(e)
        t = threading.Thread(target=holder)
        t.start()
        self.assertTrue(inside.wait(5))
        try:
            with orgtx.org_tx(self.slug, logs=['lifecycle'], lock_timeout=2, retries=0) as tx:
                _rec(tx.d, 'op:1')                 # commits while the holder is open
        finally:
            release.set()
            t.join(10)
        self.assertEqual(errors, [])
        rows = [r for r in _rows(self.slug) if r['operation_id'] == 'op:1']
        # p01 (1): two concurrent records of the same (operation, state) are
        # two new rows, and no write is lost
        self.assertEqual([r['count'] for r in rows], [1, 1, 1], rows)

    def test_a_repeat_inside_one_transaction_still_coalesces(self) -> None:
        with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
            _rec(tx.d, 'op:2')
            _rec(tx.d, 'op:2', at='t2')
            self.assertTrue(lifecycle.has_state(tx.d, 'op:1', 'accepted'))  # materializes
            _rec(tx.d, 'op:2', at='t3')            # fresh row found by row identity
            _rec(tx.d, 'op:1')                     # the committed op:1 row is NOT edited
        rows = _rows(self.slug)
        self.assertEqual([(r['operation_id'], r['count']) for r in rows],
                         [('op:1', 1), ('op:2', 3), ('op:1', 1)])
        self.assertEqual(lifecycle.latest(store.load_org(self.slug).d, 'op:2')['last_at'], 't3')

    def test_the_pruner_never_drops_a_concurrent_append(self) -> None:
        with patch.object(lifecycle, 'PRUNE_EVERY', 10 ** 9):   # no automatic prune here
            with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
                _rec(tx.d, 'stuck', 'delay_reported')
                for i in range(lifecycle.MAX_RECORDS + 4):
                    _rec(tx.d, f'old:{i}')
        lifecycle._due.discard(self.slug)
        before = len(_rows(self.slug))
        self.assertGreater(before, lifecycle.MAX_RECORDS)
        at_commit, go = threading.Event(), threading.Event()

        def hold_the_pruner(point: str, tx: orgtx.OrgTx) -> None:
            if point == 'before_commit' and lifecycle.PRUNE_LOCK in tx.lock_sections:
                at_commit.set()
                go.wait(10)
        orgtx.set_pause_hook(hold_the_pruner)
        out: list[int] = []
        t = threading.Thread(target=lambda: out.append(lifecycle.prune(self.slug)))
        t.start()
        self.assertTrue(at_commit.wait(10), 'the pruner never reached its commit')
        for i in range(5):                         # appends while the pruner is open
            with orgtx.org_tx(self.slug, logs=['lifecycle'], lock_timeout=2, retries=0) as tx:
                _rec(tx.d, f'new:{i}')
        go.set()
        t.join(10)
        orgtx.set_pause_hook(None)
        rows = _rows(self.slug)
        ops = [r['operation_id'] for r in rows]
        self.assertEqual(out, [before - lifecycle.PRUNE_TO])
        self.assertEqual(ops[-5:], [f'new:{i}' for i in range(5)])   # every one survives
        self.assertEqual(len(rows), lifecycle.PRUNE_TO + 5)
        self.assertIn('stuck', ops)                                    # sticky kept
        self.assertNotIn('op:1', ops)                                  # oldest ordinary gone

    def test_a_due_prune_runs_after_the_next_commit(self) -> None:
        with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
            for i in range(lifecycle.MAX_RECORDS + 1):
                _rec(tx.d, f'bulk:{i}')
        # that tx's own appends made it due; after its commit the pruner
        # THREAD (not the committing one) pruned it
        self.assertTrue(lifecycle.idle.wait(10), 'the pruner thread never went idle')
        self.assertEqual(len(_rows(self.slug)), lifecycle.PRUNE_TO)
        self.assertEqual(lifecycle._worker.name, 'lifecycle-pruner')

    def test_a_commit_never_waits_for_a_prune(self) -> None:
        # p01 (3): the prune runs off the request path. Hold a prune open on
        # PRUNE_LOCK, make the org due, and time an ordinary commit
        at_commit, go = threading.Event(), threading.Event()

        def hold(point: str, tx: orgtx.OrgTx) -> None:
            if point == 'before_commit' and lifecycle.PRUNE_LOCK in tx.lock_sections \
                    and not at_commit.is_set():
                at_commit.set()
                go.wait(10)
        orgtx.set_pause_hook(hold)
        t = threading.Thread(target=lambda: lifecycle.prune(self.slug), daemon=True)
        t.start()
        done = threading.Event()

        def commit() -> None:
            with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
                _rec(tx.d, 'quick')
            done.set()                             # set only once the call has returned
        try:
            self.assertTrue(at_commit.wait(10))
            lifecycle._due.add(self.slug)
            c = threading.Thread(target=commit, daemon=True)
            c.start()
            finished = done.wait(2.0)
        finally:
            go.set()
            t.join(15)
            orgtx.set_pause_hook(None)
        c.join(15)
        self.assertTrue(finished, 'a commit waited for a prune on the request path')
        self.assertTrue(lifecycle.idle.wait(15))

    def test_the_plain_dict_path_is_unchanged(self) -> None:
        doc: dict = {}
        _rec(doc, 'x')
        _rec(doc, 'x')
        self.assertEqual([r['count'] for r in doc['lifecycle']], [2])
        for i in range(lifecycle.MAX_RECORDS):     # 1 + 512 rows: one over the cap
            _rec(doc, f'y:{i}')
        self.assertEqual(len(doc['lifecycle']), lifecycle.PRUNE_TO)


if __name__ == '__main__':
    unittest.main()
