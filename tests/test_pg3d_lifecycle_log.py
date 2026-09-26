"""PG-3d (plan decision 29): the lifecycle ledger is a row log, not one doc row.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * `lifecycle` is stored as `log_l` rows (no `doc` row), a pre-move blob
    loads as it is and converts to rows on the next save;
  * coalescing (same operation + state -> one row, count + 1) survives the
    round trip, and `has_state` / `latest` read it back;
  * the cap is enforced in a batch: 512 rows stay, the 513th write prunes to
    PRUNE_TO, and a sticky decision outlives the prune;
  * two transactions that each record a lifecycle row commit WHILE THE OTHER
    IS OPEN (an append takes no lock) — the reason for the move;
  * a declaration written the old way (`sections=["lifecycle"]`,
    `share_sections=["lifecycle"]`) is refused since S8 (decision 38);
    `logs=["lifecycle"]` declares it.

Run:  python tools/run-python-verification.py tests/test_pg3d_lifecycle_log.py
"""

import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-pg3d-lifecycle-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import lifecycle, orgtx, store  # noqa: E402

# row-lock behaviour; the transition fence would serialize it away
orgtx.TRANSITION_FENCE = False


def tearDownModule() -> None:
    _temp.cleanup()


def _rows(slug: str) -> tuple[list[dict], bool]:
    """(the lifecycle log rows, whether a `doc` row named lifecycle exists)"""
    with store._POOL.acquire(slug) as conn:
        rows = [json.loads(v) for (v,) in conn.execute(
            "SELECT val FROM log_l WHERE sect='lifecycle' ORDER BY seq").fetchall()]
        blob = conn.execute("SELECT 1 FROM doc WHERE key='lifecycle'").fetchone() is not None
    return rows, blob


def _rec(d, op: str, state: str = 'accepted', at: str = 't') -> None:
    lifecycle.record(d, operation_id=op, kind='mail', state=state, at=at)


class LifecycleLog(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(f'lc-{self._testMethodName}'[:58].replace('_', '-'))
        self.slug = org.d['slug']
        store.save_org(org)
        store.save_org(store.load_org(self.slug))

    def test_rows_not_blob_and_coalescing_round_trips(self) -> None:
        org = store.load_org(self.slug)
        _rec(org.d, 'mail:1')
        _rec(org.d, 'mail:1')
        _rec(org.d, 'mail:2', 'delay_reported')
        store.save_org(org)
        rows, blob = _rows(self.slug)
        self.assertFalse(blob)
        self.assertEqual([(r['operation_id'], r['count']) for r in rows],
                         [('mail:1', 2), ('mail:2', 1)])
        d = store.load_org(self.slug).d
        self.assertEqual(lifecycle.latest(d, 'mail:1')['count'], 2)
        self.assertTrue(lifecycle.has_state(d, 'mail:2', 'delay_reported'))
        # S8 (lead decision 8): a STORED row is never edited any more — another
        # transaction may hold it. The repeat in a new cycle is a new row
        # (coalescing is per transaction); latest/has_state read the same.
        org = store.load_org(self.slug)
        _rec(org.d, 'mail:1')
        store.save_org(org)
        self.assertEqual([r['count'] for r in _rows(self.slug)[0]], [2, 1, 1])
        self.assertEqual(lifecycle.latest(store.load_org(self.slug).d, 'mail:1')['count'], 1)

    def test_pre_move_blob_loads_and_converts(self) -> None:
        blob = [{'operation_id': 'old:1', 'kind': 'mail', 'state': 'accepted',
                 'at': 't0', 'count': 1}]
        with store._POOL.acquire(self.slug) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM log_l WHERE sect='lifecycle'")
            conn.execute("INSERT INTO doc(key,val) VALUES('lifecycle',?) "
                         "ON CONFLICT(key) DO UPDATE SET val=excluded.val", (json.dumps(blob),))
            conn.execute("COMMIT")
        store._resident.pop(self.slug, None)
        store._publish_changes_unknown(self.slug)
        org = store.load_org(self.slug)
        self.assertEqual(lifecycle.latest(org.d, 'old:1')['state'], 'accepted')
        _rec(org.d, 'new:1')
        store.save_org(org)
        rows, blob_left = _rows(self.slug)
        self.assertFalse(blob_left)
        self.assertEqual([r['operation_id'] for r in rows], ['old:1', 'new:1'])

    def test_cap_prunes_in_a_batch_and_keeps_sticky(self) -> None:
        doc: dict = {}
        _rec(doc, 'delivery:stuck', 'delay_reported')
        for i in range(lifecycle.MAX_RECORDS - 1):
            _rec(doc, f'mail:{i}')
        self.assertEqual(len(doc['lifecycle']), lifecycle.MAX_RECORDS)   # at the cap: no prune
        _rec(doc, 'mail:over')
        self.assertEqual(len(doc['lifecycle']), lifecycle.PRUNE_TO)      # one batch
        self.assertTrue(lifecycle.has_state(doc, 'delivery:stuck', 'delay_reported'))
        self.assertEqual(doc['lifecycle'][-1]['operation_id'], 'mail:over')
        for i in range(lifecycle.MAX_RECORDS - lifecycle.PRUNE_TO):
            _rec(doc, f'more:{i}')
        self.assertEqual(len(doc['lifecycle']), lifecycle.MAX_RECORDS)   # no prune until over

    def test_two_transactions_record_in_parallel(self) -> None:
        inside = threading.Event()
        release = threading.Event()
        errors: list[BaseException] = []

        def holder() -> None:
            try:
                with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
                    _rec(tx.d, 'held:1')
                    inside.set()
                    release.wait(10)
            except BaseException as e:           # pragma: no cover - reported below
                errors.append(e)

        t = threading.Thread(target=holder, daemon=True)
        t.start()
        self.assertTrue(inside.wait(5), 'holder never entered its transaction')
        try:
            with orgtx.org_tx(self.slug, logs=['lifecycle'], lock_timeout=2, retries=0) as tx:
                _rec(tx.d, 'parallel:1')
            parallel_committed = True
        finally:
            release.set()
            t.join(10)
        self.assertEqual(errors, [])
        self.assertTrue(parallel_committed)
        ops = {r['operation_id'] for r in _rows(self.slug)[0]}
        self.assertEqual(ops, {'held:1', 'parallel:1'})

    def test_old_spelling_is_refused_and_logs_declares_it(self) -> None:
        # S8 (decision 38): the MOVED_TO_LOGS compatibility for `lifecycle`
        # is gone, so the old spelling is refused like any log section
        for kw in ({'sections': ['lifecycle']}, {'share_sections': ['lifecycle']}):
            with self.assertRaises(ValueError, msg=kw):
                with orgtx.org_tx(self.slug, **kw):
                    pass
        with orgtx.org_tx(self.slug, logs=['lifecycle']) as tx:
            _rec(tx.d, 'legacy:1')
        self.assertIn('lifecycle', tx.logs)
        self.assertEqual([r['operation_id'] for r in _rows(self.slug)[0]], ['legacy:1'])
        # CONTROL: undeclared, the same write is refused
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug) as tx:
                _rec(tx.d, 'undeclared:1')
        self.assertEqual([r['operation_id'] for r in _rows(self.slug)[0]], ['legacy:1'])


if __name__ == '__main__':
    unittest.main()
