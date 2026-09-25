"""RT3 — staffing at the cap (PYPG-PLAN §2, race test 3; owner PG-3b).

Two agent hires under ONE parent that sits one report below
`max_children`, through the real `api.agent_call` on the row-transaction
door (ORGTREE_PGDOOR=1, PG-0's org_tx), FORCED to overlap with PG-5's
racekit:

  A is held at `after_lock` — it provably holds its rows, including the
  parent's node row FOR UPDATE — while B starts and is PROVEN (from the lock
  manager itself) to be waiting on a row lock. Then A is released.

Expected, and checked:
  · exactly ONE new seat; the parent ends exactly AT the cap;
  · B is refused with the cap message (a 422), having counted the children
    only after A committed;
  · the achieved order is A.after_lock → B.blocked → A.after_commit →
    B.after_lock;
  · the same-NAME variant: one seat, and the loser is refused by the cap
    rather than creating a duplicate or a suffixed second seat.

Why it holds: hire declares its destination FOR UPDATE (staffdoor.hire_rows),
so the second hire's children count waits for the first one's commit. A hire
that only SHARE-locked the destination would let both count the same
children and both commit (neither writes the parent row itself, so nothing
would refuse it) — the mutation harness in the author's scratch shows this
test failing on exactly that.

Runs on the fake (SeamBackend). The PostgreSQL arm is racekit's
`disposable_pg()` + ORGTREE_STORE=postgres, not armed here.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='rt3-staffing-cap-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
import racekit  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
ARGS = {'tier': 'luna', 'tools': T, 'add_dirs': [], 'org_visibility': 'full',
        'charter': 'c'}
CAP = 3
_N = [0]


class RT3StaffingAtTheCap(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'rt3x{_N[0]}'
        org = store.create_org(self.slug)
        org.d['max_children'] = CAP
        org.hire(U, None, 'luna', 20, 'root')
        org.hire('root', 'root', 'luna', 8, 'mid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        for i in range(CAP - 1):                     # one below the cap
            org.hire('mid', 'mid', 'luna', 0, f'k{i}', add_dirs=[], tools=T,
                     org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.assertTrue(pgdoor.routed('orgtree_hire'))
        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'provider_hire_gate', lambda *a, **k: None),
                  patch.object(api, 'new_hire_harness', lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def hire(self, name):
        return api.agent_call(api.AgentCall(org=self.slug, node='mid',
                                            tool='orgtree_hire',
                                            args=dict(ARGS, name=name)), REQUEST)

    def kids(self):
        org = store.load_org(self.slug)
        return sorted(org.org_children('mid'))

    def race_two(self, name_a, name_b):
        with racekit.Race(pair='converted') as race:
            a = race.actor('A', self.hire, name_a)
            b = race.actor('B', self.hire, name_b, may_raise=True)
            ga = race.hold(a, 'after_lock')
            race.start(a)
            race.reached(ga)                 # A holds mid's row FOR UPDATE
            race.start(b)
            how = race.blocked(b)            # the lock manager says B waits
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.blocked', 'A.after_commit',
                              'B.after_lock')
        return a, b, how

    def test_two_hires_one_below_the_cap(self):
        self.assertEqual(len(self.kids()), CAP - 1)
        a, b, how = self.race_two('alpha', 'beta')
        self.assertIn('row lock', how)
        self.assertEqual(a.result['node'], 'alpha')
        self.assertIsInstance(b.error, HTTPException)
        self.assertEqual(b.error.status_code, 422)
        self.assertIn(f'already has {CAP} reports (cap)', b.error.detail)
        kids = self.kids()
        self.assertEqual(len(kids), CAP)             # AT the cap, not over
        self.assertIn('alpha', kids)
        self.assertNotIn('beta', kids)

    def test_same_name_one_seat_no_duplicate(self):
        a, b, _how = self.race_two('twin', 'twin')
        self.assertEqual(a.result['node'], 'twin')
        self.assertIsInstance(b.error, HTTPException)
        self.assertIn('(cap)', b.error.detail)
        kids = self.kids()
        self.assertEqual(len(kids), CAP)
        self.assertEqual([k for k in kids if k.startswith('twin')], ['twin'])


if __name__ == '__main__':
    unittest.main()
