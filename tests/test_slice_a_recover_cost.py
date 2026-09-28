"""Scale slice A: a maildrain recovery pass costs a dict lookup, not an org load.

`maildrain.recover` used to start every seat with `orgtx.org_read`, a fresh
full load of the org (~110 ms at 200 seats on SQLite), and then opened
`reclaim_orphans`' row transaction, which loads the org again and commits the
`_settle` write, even for a BUSY seat that the pass never admits. Now:

  * the lock-free pre-read is the shared, seq-gated `store.cached_org`;
  * a busy seat with no reclaim intent, no publication wait and no eligible
    batch skips the transaction and stays tracked;
  * a busy seat that has an eligible batch or a pending intent still gets
    its transaction, and an idle seat is still admitted.

Run:  python tools/run-python-verification.py tests/test_slice_a_recover_cost.py
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='slice-a-recover-',
                                    ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, mailruntime, mailtx, maildrain, orgtx, store  # noqa: E402
from orgtree import supervisor as sup  # noqa: E402

_N = [0]


class RecoverCost(unittest.TestCase):

    def setUp(self):
        _N[0] += 1
        self.slug = f'slicea{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        store.save_org(org)
        self.st = sup.state(self.slug, 'worker')
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        self.started = []
        self.commits = []
        orgtx.commit_listeners.append(self.commits.append)
        self.addCleanup(orgtx.commit_listeners.remove, self.commits.append)
        for p in (patch.object(sup, '_native_context_hold', return_value=None),
                  patch.object(sup, 'scan_steer_records'),
                  patch.object(sup, '_start_turn_worker',
                               side_effect=lambda s, n, c: self.started.append(c))):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(maildrain._forget, self.slug, 'worker')
        self.addCleanup(store._POOL.close_all, self.slug)
        self.addCleanup(self.st.clear)

    def post(self):
        with mailtx.org_of(self.slug, **mailtx.send_rows('worker')) as o:
            o.post_mail(ledger.USER, 'worker', 'hello', kind='message')
            maildrain.request(o, 'worker')

    def busy(self):
        self.st['busy'] = True

    def mine(self):
        return [c for c in self.commits if c.slug == self.slug]

    def tracked(self):
        with maildrain._pending_lock:
            return (self.slug, 'worker') in maildrain._pending

    def demand(self):
        return orgtx.org_read(self.slug).node('worker').get('mail_drain')

    def loads_during(self, fn):
        """How many fresh full org loads `fn` performs."""
        real = store._load_sqlite_org
        n = [0]

        def counted(*a, **k):
            n[0] += 1
            return real(*a, **k)
        with patch.object(store, '_load_sqlite_org', counted):
            fn()
        return n[0]

    def test_a_busy_seat_with_nothing_to_fold_costs_no_load_and_no_commit(self):
        self.post()
        self.busy()
        store.cached_org(self.slug)          # warm, as the running engine is
        before = self.demand()
        self.commits.clear()
        loads = self.loads_during(
            lambda: self.assertFalse(maildrain.recover(self.slug, 'worker')))
        self.assertEqual(loads, 0, 'recover loaded the org')
        self.assertEqual(self.mine(), [], 'recover committed for a busy seat')
        self.assertEqual(self.started, [])
        self.assertTrue(self.tracked(), 'the busy seat was dropped from the index')
        self.assertEqual(self.demand(), before)

    def test_the_pre_read_is_the_shared_snapshot_not_a_fresh_read(self):
        self.post()
        self.busy()
        with patch.object(orgtx, 'org_read',
                          side_effect=AssertionError('fresh org_read')):
            self.assertFalse(maildrain.recover(self.slug, 'worker'))

    def test_a_busy_seat_with_an_eligible_batch_still_gets_its_transaction(self):
        self.post()
        self.busy()
        calls = []
        real = sup.reclaim_orphans

        def spy(*a, **k):
            calls.append(1)
            return real(*a, **k)
        with patch.object(mailruntime, 'eligible_tokens',
                          side_effect=lambda *a, **k: frozenset({'tok-x'})), \
                patch.object(sup, 'reclaim_orphans', spy):
            maildrain.recover(self.slug, 'worker')
        self.assertEqual(len(calls), 1, 'an eligible batch was never reclaimed')
        self.assertEqual(self.started, [], 'a busy seat was admitted')

    def test_a_pending_reclaim_intent_still_gets_its_transaction(self):
        self.post()
        self.busy()
        self.st['mail_reclaim_intents'] = {'op-1': {'operation': 'op-1',
                                                    'before': []}}
        calls = []
        with patch.object(sup, 'reclaim_orphans',
                          side_effect=lambda *a, **k: calls.append(1) or {}):
            maildrain.recover(self.slug, 'worker')
        self.assertEqual(len(calls), 1, 'the intent was never retried')

    def test_an_idle_seat_is_still_admitted(self):
        self.post()
        self.assertTrue(maildrain.recover(self.slug, 'worker'))
        self.assertEqual(len(self.started), 1)


if __name__ == '__main__':
    unittest.main()
