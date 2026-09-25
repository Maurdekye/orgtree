"""`orgtree_staff` (HIRE mode) on the door, end to end: the real
`api.agent_call`, PG-0's SeamBackend org_tx, ORGTREE_PGDOOR=1, a throwaway
SQLite root.

  · create: the seat and the docket item (owned by the seat) in ONE commit,
    one run of `_staff_call` (the declaration is complete), the new agent
    driven after the commit; the DOC_LOCK cycle is never entered;
  · update: the item passes from its owner to the new seat in one run — the
    previous owner's row (its handover notice) is declared from the snapshot;
  · only hire mode is routed: a rehire-mode call keeps the DOC_LOCK cycle;
  · a refused call is a 422 and commits nothing.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='staffdoor-staff-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SEAT = {'tier': 'luna', 'tools': T, 'add_dirs': [], 'org_visibility': 'full',
        'charter': 'c', 'staff_mode': 'hire'}
_N = [0]


def owner(it):
    o = it.get('owner')
    return o.get('node') if isinstance(o, dict) else o


class StaffDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'sd{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'root')
        org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('mid', 'mid', 'luna', 0, 'peer', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        self.existing = org.work_create('mid', 'Existing item', 'Problem. Fix.',
                                        owner='peer')['created']
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.sent, self.runs = [], []
        real = api._staff_call

        def counted(*a, **k):
            self.runs.append(1)
            return real(*a, **k)

        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(t) or {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'provider_hire_gate', lambda *a, **k: None),
                  patch.object(api, 'new_hire_harness', lambda *a, **k: None),
                  patch.object(api, '_staff_call', counted),
                  patch.object(store, 'write_org',
                               side_effect=AssertionError('entered the DOC_LOCK cycle'))]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def staff(self, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node='mid',
                                            tool='orgtree_staff',
                                            args=dict(SEAT, **a)), REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def item(self, slug):
        return store.load_org(self.slug)._work_find(slug)[0]

    def test_create_seat_and_item_in_one_commit(self):
        r0 = self.rev()
        r = self.staff(name='kid', title='New thing', objective='Problem. Fix.')
        self.assertEqual(r['node'], 'kid')
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.rev(), r0 + 1)
        self.assertEqual(owner(self.item(r['item'])), 'kid')
        self.assertIn('kid', self.sent)

    def test_update_hands_the_item_over_in_one_run(self):
        r = self.staff(name='kid2', slug=self.existing, done_so_far=['x'],
                       working_on_next=['y'])
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(owner(self.item(self.existing)), 'kid2')

    def test_only_hire_mode_is_routed(self):
        self.assertTrue(pgdoor.routed('orgtree_staff', dict(SEAT)))
        self.assertFalse(pgdoor.routed('orgtree_staff',
                                       {'node': 'peer', 'staff_mode': 'rehire'}))

    def test_refusal_is_422_and_commits_nothing(self):
        r0 = self.rev()
        with self.assertRaises(HTTPException) as cm:
            self.staff(name='x', action='delete', title='t', objective='o')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.rev(), r0)
        self.assertNotIn('x', store.load_org(self.slug).nodes)


if __name__ == '__main__':
    unittest.main()
