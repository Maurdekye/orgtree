"""S-D: the docket's archive sweep opens its transaction only when due.

`worktx.sweep` used to open an `org_tx` at the head of EVERY docket write; on
PostgreSQL each one pays a full org load. It now asks `worktx.due` on the
lock-free snapshot first. What these prove, on PG-0's SeamBackend fake over a
throwaway SQLite root:
  * nothing due: no transaction opens and nothing moves;
  * a dropped item (at once) and a done item over an hour old (by `now_ts`)
    are still moved, by a transaction;
  * an eligible item that holds attention is not due (the sweep would move
    nothing), so no transaction opens;
  * an unreadable snapshot sweeps unconditionally, as before;
  * the door's before-step passes the door's own snapshot through.

Run:  python tools/run-python-verification.py tests/test_worktx_sweep_due.py
"""

import os
from pathlib import Path
import tempfile
import time
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-worktx-due-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, pgdoor, store, workdoor, worktx  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

_n = 0
HOUR = 3600.0


def tearDownModule() -> None:
    _temp.cleanup()


def fixture():
    global _n
    _n += 1
    org = store.create_org(f'wtx-due-{_n}')
    slug = org.d['slug']
    org.hire(USER, None, 'haiku', 0, 'own')
    org.work_create('own', 'Sweep fixture item',
                    objective='Problem: a sweep on every call. Solution: sweep when due.',
                    acceptance=['It holds.'])
    store.save_org(org)
    store.save_org(store.load_org(slug))
    item = store.load_org(slug).d['work_items'][-1]['slug']
    return slug, item


def archived(slug, item):
    org = store.load_org(slug)
    return any(it['slug'] == item for it in (org.d.get('work_items_archive') or []))


class SweepWhenDue(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
        orgtx.TRANSITION_FENCE = False
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug, self.item = fixture()
        # count the sweep's transactions: `sweep` opens exactly one `tx`
        self.txs = 0
        orig = worktx.tx

        def counted(*a, **k):
            self.txs += 1
            return orig(*a, **k)
        worktx.tx = counted
        self.addCleanup(setattr, worktx, 'tx', orig)

    def _set(self, **kw):
        worktx.run(self.slug, lambda o: o.work_update(
            'own', self.item, done_so_far=['x'], working_on_next=['y'], **kw))
        self.txs = 0

    def test_nothing_due_opens_no_transaction(self):
        self.assertEqual(worktx.sweep(self.slug), [])
        self.assertEqual(self.txs, 0)
        self.assertFalse(archived(self.slug, self.item))

    def test_dropped_is_swept_at_once(self):
        self._set(status='dropped', dropped_reason='Cancelled by the test; nothing to resume.')
        self.assertTrue(worktx.due(store.cached_org(self.slug)))
        self.assertEqual(worktx.sweep(self.slug), [self.item])
        self.assertEqual(self.txs, 1)
        self.assertTrue(archived(self.slug, self.item))
        # moved: nothing is due any more, so the next sweep opens nothing
        self.assertEqual(worktx.sweep(self.slug), [])
        self.assertEqual(self.txs, 1)

    def test_done_is_swept_only_after_the_hour(self):
        self._set(status='done')
        self.assertEqual(worktx.sweep(self.slug), [])     # not yet an hour old
        self.assertEqual(self.txs, 0)
        later = time.time() + HOUR + 60
        self.assertEqual(worktx.sweep(self.slug, later), [self.item])
        self.assertEqual(self.txs, 1)
        self.assertTrue(archived(self.slug, self.item))

    def test_attention_holds_the_row_and_opens_no_transaction(self):
        self._set(status='done', attention=True,
                  attention_reason='The test holds this row with a manual flag.')
        later = time.time() + HOUR + 60
        self.assertFalse(worktx.due(store.cached_org(self.slug), later))
        self.assertEqual(worktx.sweep(self.slug, later), [])
        self.assertEqual(self.txs, 0)
        self.assertFalse(archived(self.slug, self.item))

    def test_unreadable_snapshot_sweeps_unconditionally(self):
        self._set(status='dropped', dropped_reason='Cancelled by the test; nothing to resume.')
        orig = store.cached_org

        def broken(slug):
            raise RuntimeError('snapshot unavailable')
        store.cached_org = broken
        try:
            moved = worktx.sweep(self.slug)
        finally:
            store.cached_org = orig
        self.assertEqual(moved, [self.item])
        self.assertEqual(self.txs, 1)

    def test_door_before_step_uses_the_door_snapshot(self):
        seen = []

        def snap(slug):
            seen.append(slug)
            return store.cached_org(slug)
        self.addCleanup(setattr, pgdoor._SEAM, 'snapshot', pgdoor._SEAM.snapshot)
        pgdoor._SEAM.snapshot = snap

        class Call:
            org = self.slug
        workdoor.before(Call(), {})
        self.assertEqual(seen, [self.slug])
        self.assertEqual(self.txs, 0)                    # nothing due


if __name__ == '__main__':
    unittest.main()
