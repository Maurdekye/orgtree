"""`orgtree_hire` on the door, end to end: the real `api.agent_call`, PG-0's
real SeamBackend org_tx, ORGTREE_PGDOOR=1, a throwaway SQLite root.

  · the hire never enters the DOC_LOCK cycle, commits exactly once, and the
    kickoff wakes the new agent after the commit;
  · the declaration is COMPLETE for the real hire: the body runs once — a
    missing row would have been refused by PG-0 at commit (UnlockedWrite)
    and shown up as a second, widened run;
  · a hire into the chain (grants inflate up the path) is also one run;
  · a refused hire (unknown target) is a 422 and commits nothing.
The provider gate and harness choice are machine reads outside the
transaction; they are stubbed.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='staffdoor-hire-door-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, staffdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
ARGS = {'tier': 'luna', 'tools': T, 'add_dirs': [], 'org_visibility': 'full',
        'charter': 'c', 'kickoff': 'go', 'permission_mode': 'plan'}
_N = [0]


class HireDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'hd{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'root')
        org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('mid', 'mid', 'luna', 0, 'peer', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.sent, self.runs = [], []
        real = api._hire_seat

        def counted(*a, **k):
            self.runs.append(1)
            return real(*a, **k)

        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(t) or {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'provider_hire_gate', lambda *a, **k: None),
                  patch.object(api, 'new_hire_harness', lambda *a, **k: None),
                  patch.object(api, '_hire_seat', counted),
                  patch.object(store, 'write_org',
                               side_effect=AssertionError('entered the DOC_LOCK cycle'))]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def hire(self, actor, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node=actor,
                                            tool='orgtree_hire',
                                            args=dict(ARGS, **a)), REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def test_the_hire_is_declared_and_routed(self):
        self.assertTrue(pgdoor.routed('orgtree_hire'))
        self.assertIs(pgdoor.BODIES['orgtree_hire'], staffdoor.hire_body)

    def test_plain_hire_with_kickoff_one_run_one_commit(self):
        r0 = self.rev()
        r = self.hire('mid', name='kid', grant=1)
        self.assertEqual(r['node'], 'kid')
        self.assertEqual(len(self.runs), 1)           # no widened re-run
        self.assertEqual(self.rev(), r0 + 1)
        org = store.load_org(self.slug)
        self.assertEqual(org.node('kid')['parent'], 'mid')
        self.assertIn('kid', self.sent)               # kickoff drive, after

    def test_hire_into_the_chain_one_run(self):
        before = store.load_org(self.slug).node('mid')['grant']
        r = self.hire('root', name='kid2', grant=6, target='peer')
        self.assertEqual(r['node'], 'kid2')
        self.assertEqual(len(self.runs), 1)
        self.assertGreater(store.load_org(self.slug).node('mid')['grant'], before)

    def test_name_taken_after_the_snapshot_widens_not_refuses(self):
        """The spec is computed from an UNLOCKED snapshot. Hand the door a
        snapshot from before a racing hire took the name: the locked
        document gives the new seat `kid-2`, which the spec did not name.
        The body must widen and succeed — not refuse a legitimate hire."""
        stale = store.load_org(self.slug)
        org = store.load_org(self.slug)
        org.hire('mid', 'mid', 'luna', 0, 'kid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')       # the racer
        self.p[-1].stop()                                  # allow this save
        store.save_org(org)
        self.p[-1].start()
        pgdoor.use_org_tx(None, snapshot=lambda slug: stale)
        try:
            r = self.hire('mid', name='kid')
        finally:
            pgdoor.use_org_tx(None)
        self.assertEqual(r['node'], 'kid-2')
        # the re-derivation widened BEFORE the hire ran: the hire itself ran
        # once, on the widened rows (without it: hire, then check_created
        # refuses a row the tx does not hold — a 422 for a legitimate hire)
        self.assertEqual(len(self.runs), 1)

    def test_refused_hire_is_422_and_commits_nothing(self):
        r0 = self.rev()
        with self.assertRaises(HTTPException) as cm:
            self.hire('mid', name='x', target='nobody')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.rev(), r0)
        self.assertNotIn('x', store.load_org(self.slug).nodes)
        self.assertEqual(self.sent, [])


    # ---- f1 (review of 3ebb57b): a hire that writes the docket

    def seed(self, fn):
        """Write the org outside the door (the DOC_LOCK guard lifted)."""
        org = store.load_org(self.slug)
        out = fn(org)
        self.p[-1].stop()
        store.save_org(org)
        self.p[-1].start()
        return out

    def owner(self, wid):
        o = store.load_org(self.slug)._work_find(wid)[0].get('owner')
        return o.get('node') if isinstance(o, dict) else o

    def committed(self, fn):
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            return fn(), seen
        finally:
            orgtx.commit_listeners.remove(seen.append)

    def test_hire_with_a_work_item_is_one_run(self):
        # the docket row and the item's previous owner (sent the handover
        # notice) are declared: without them the first run is refused at
        # commit and a widened second run does the hire
        wid = self.seed(lambda o: o.work_create(
            'mid', 'Item', 'Problem. Fix.', owner='peer')['created'])
        r = self.hire('mid', name='kid', work_item=wid)
        self.assertEqual(r['node'], 'kid')
        self.assertEqual(len(self.runs), 1)           # no widened re-run
        self.assertEqual(self.owner(wid), 'kid')

    def test_hire_with_review_items_is_one_run(self):
        wid = self.seed(lambda o: o.work_create(
            'mid', 'Item', 'Problem. Fix.', owner='mid')['created'])
        r = self.hire('mid', name='rev', review_items=[wid])
        self.assertEqual(r['node'], 'rev')
        self.assertEqual(r.get('review_items'), [wid])
        self.assertEqual(len(self.runs), 1)

    def test_a_docket_writing_hire_sweeps_the_archive_first(self):
        # PG-3w decision 13, as staff / quick staff take it: the archive move
        # is its OWN org_tx before the hire, and the hire defers the move,
        # so it never writes (or widens into) the archive
        def expired(o):
            # the drop is the LAST docket write here: any later one would
            # already sweep the dropped item inline
            wid = o.work_create('mid', 'Item', 'Problem. Fix.',
                                owner='peer')['created']
            old = o.work_create('mid', 'Old item', 'Problem. Fix.',
                                owner='peer')['created']
            o.work_update('peer', old, done_so_far=['x'],
                          working_on_next=['y'], status='dropped',
                          dropped_reason='Cancelled by the test; nothing to resume.')
            return old, wid
        old, wid = self.seed(expired)
        self.assertFalse(store.load_org(self.slug)._work_find(old)[1])
        _r, seen = self.committed(
            lambda: self.hire('mid', name='kid', work_item=wid))
        self.assertTrue(store.load_org(self.slug)._work_find(old)[1])
        self.assertEqual(len(self.runs), 1)           # no widening re-run
        self.assertEqual(len(seen), 2, seen)          # the sweep, then the hire
        self.assertIn('work_items_archive', seen[0].changes.log_sections)
        self.assertNotIn('work_items_archive', seen[-1].changes.log_sections)

    def test_a_plain_hire_takes_no_sweep_transaction(self):
        _r, seen = self.committed(lambda: self.hire('mid', name='kid'))
        self.assertEqual(len(seen), 1, seen)
        self.assertNotIn('work_items',
                         staffdoor.hire_spec(store.load_org(self.slug),
                                             SimpleNamespace(node='mid'),
                                             {'name': 'k2'}).sections)


if __name__ == '__main__':
    unittest.main()
