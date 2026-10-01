"""`orgtree_staff` in REHIRE mode on the door, end to end: the real
`api.agent_call`, PG-0's SeamBackend org_tx, ORGTREE_PGDOOR=1, a throwaway
SQLite root. The rows come from PG-3a's `lifecycle_door.rehire_rows` plus
the docket (staffdoor.staff_rows).

  · create/update: the archived seat comes back and holds the item, in ONE
    commit and one run of `_staff_call`, and the DOC_LOCK cycle is never
    entered;
  · parity: the same call with the door off leaves the same seat and item;
  · a pre-lock rename followed by a refusal says the rename stands ONCE
    (api._agent_door applies it; the body must not wrap it again), word for
    word as the cycle does;
  · the declared rows cover every row `rehire_rows` names (audiences and an
    account rebind included), plus the docket and the item's current owner;
  · drift: rehire shares PG-3b's hire settings less fable_lock, which it writes.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='staffdoor-rehire-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import (api, ledger, lifecycle_door, orgtx, pgdoor,  # noqa: E402
                     staffdoor, store, supervisor)

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
STANDS = 'The RENAME already happened'
_N = [0]


def owner(it):
    o = it.get('owner')
    return o.get('node') if isinstance(o, dict) else o


def make_org(slug):
    org = store.create_org(slug)
    org.hire(U, None, 'luna', 20, 'root')
    org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    org.hire('mid', 'mid', 'luna', 0, 'peer', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    org.hire('mid', 'mid', 'luna', 0, 'x', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    existing = org.work_create('mid', 'Existing item', 'Problem. Fix.',
                               owner='peer')['created']
    store.save_org(org)
    org = store.load_org(slug)
    org.retire('mid', 'x')
    store.save_org(org)
    return existing


class _Base(unittest.TestCase):
    STRICT = True       # the DOC_LOCK cycle (store.write_org) is a failure

    def setUp(self):
        _N[0] += 1
        self.slug = f'sr{_N[0]}'
        self.existing = make_org(self.slug)
        pgdoor.use_org_tx(None)
        self.runs = []
        real = api._staff_call

        def counted(*a, **k):
            self.runs.append(1)
            return real(*a, **k)

        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'provider_hire_gate', lambda *a, **k: None),
                  patch.object(api, 'new_hire_harness', lambda *a, **k: None),
                  patch.object(api, '_staff_call', counted)]
        if self.STRICT:
            self.p.append(patch.object(
                store, 'write_org',
                side_effect=AssertionError('entered the DOC_LOCK cycle')))
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def staff(self, org=None, **a):
        return api.agent_call(api.AgentCall(org=org or self.slug, node='mid',
                                            tool='orgtree_staff',
                                            args=dict({'node': 'x'}, **a)),
                              REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def item(self, wid, slug=None):
        return store.load_org(slug or self.slug)._work_find(wid)[0]


class StaffRehireDoor(_Base):
    def test_rehire_mode_is_routed(self):
        self.assertTrue(pgdoor.routed('orgtree_staff',
                                      {'node': 'x', 'staff_mode': 'rehire'}))
        self.assertTrue(pgdoor.routed('orgtree_staff', {'node': 'x'}))

    def test_create_brings_the_seat_back_holding_the_item_in_one_commit(self):
        r0 = self.rev()
        r = self.staff(title='New thing', objective='Problem. Fix.')
        self.assertEqual(r['node'], 'x')
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.rev(), r0 + 1)
        self.assertEqual(store.load_org(self.slug).nodes['x']['state'], 'live')
        self.assertEqual(owner(self.item(r['item'])), 'x')

    def test_update_hands_the_item_over_in_one_run(self):
        self.staff(slug=self.existing, done_so_far=['a'], working_on_next=['b'])
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(owner(self.item(self.existing)), 'x')

    def test_refusal_is_422_and_commits_nothing(self):
        r0 = self.rev()
        with self.assertRaises(HTTPException) as cm:
            self.staff(action='delete', title='t', objective='o')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.rev(), r0)
        self.assertEqual(store.load_org(self.slug).nodes['x']['state'], 'archived')


class StaffRehireRows(_Base):
    def test_rows_cover_rehire_rows_and_the_docket(self):
        org = store.load_org(self.slug)
        a = {'node': 'x', 'audiences': ['user'], 'account': 'primary',
             'slug': self.existing}
        got = staffdoor.staff_rows(org, 'mid', a)
        want = lifecycle_door.rehire_rows(org, 'mid', a)
        gap = got.covers(want)
        self.assertFalse(gap.nodes or gap.share_nodes, gap)
        self.assertLessEqual(set(want.sections), set(got.sections))
        self.assertLessEqual(set(want.logs), set(got.logs))
        self.assertLessEqual(set(want.share_sections),
                             set(got.sections) | set(got.share_sections))
        self.assertIn('work_items', got.sections)
        self.assertIn('peer', got.nodes)                 # the item's owner
        for s in ('audience_requests', 'user_inbox'):
            self.assertIn(s, got.sections)
        self.assertIn('user_mail_log', got.logs)
        self.assertLessEqual(set(supervisor._ASSIGN_SECTIONS), set(got.sections))
        self.assertEqual(len(got.sections), len(set(got.sections)))

    def test_hire_mode_rows_are_unchanged(self):
        org = store.load_org(self.slug)
        a = {'name': 'kid', 'tier': 'luna', 'staff_mode': 'hire'}
        got = staffdoor.staff_rows(org, 'mid', a)
        h = staffdoor.hire_rows(org, 'mid', a)
        self.assertEqual(set(got.sections), set(h.sections) | {'work_items'})
        self.assertEqual(set(got.nodes), set(h.nodes))

    def test_rehire_shares_the_hire_settings_less_fable_lock(self):
        self.assertEqual(set(lifecycle_door.REHIRE_SHARE),
                         set(staffdoor.HIRE_SETTINGS) - {'fable_lock'})
        self.assertIn('fable_lock', lifecycle_door.REHIRE_SECTIONS)
        self.assertEqual(set(lifecycle_door.REHIRE_LOGS),
                         set(staffdoor.HIRE_LOGS))


class StaffRehireParity(_Base):
    STRICT = False      # the legacy arm runs the cycle; the rename is pre-lock

    def setUp(self):
        super().setUp()
        self.other = f'{self.slug}b'
        make_org(self.other)

    def tearDown(self):
        super().tearDown()
        store._POOL.close_all(self.other)

    def test_same_seat_and_item_as_the_cycle(self):
        mine = self.staff(title='New thing', objective='Problem. Fix.')
        with patch.object(pgdoor, 'enabled', lambda: False):
            self.assertFalse(pgdoor.routed('orgtree_staff', {'node': 'x'}))
            legacy = self.staff(org=self.other, title='New thing',
                                objective='Problem. Fix.')
        self.assertEqual(mine['node'], legacy['node'])
        self.assertEqual(mine['assigned_to'], legacy['assigned_to'])
        self.assertEqual(sorted(k for k in mine if k != 'ref'),
                         sorted(k for k in legacy if k != 'ref'))
        a, b = store.load_org(self.slug), store.load_org(self.other)
        self.assertEqual(a.nodes['x']['state'], b.nodes['x']['state'])
        self.assertEqual(owner(self.item(mine['item'])),
                         owner(self.item(legacy['item'], self.other)))

    def test_rename_then_refusal_says_the_rename_stands_once(self):
        args = {'name': 'xx', 'target': 'nobody', 'title': 'T',
                'objective': 'Problem. Fix.'}
        with self.assertRaises(HTTPException) as d:
            self.staff(**args)
        with patch.object(pgdoor, 'enabled', lambda: False):
            with self.assertRaises(HTTPException) as c:
                self.staff(org=self.other, **args)
        self.assertEqual(d.exception.detail.count(STANDS), 1, d.exception.detail)
        self.assertEqual(d.exception.detail, c.exception.detail)

    def test_a_malformed_mode_is_a_422_with_the_door_on(self):
        # review f3: routed() runs outside any 422 wrapper, so _staff_on_door
        # must answer "not routed" and let the cycle state the refusal
        self.assertTrue(pgdoor.enabled())
        for extra, words in (({'staff_mode': 'bogus'},
                              'staff_mode must be hire or rehire'),
                             ({'staff_mode': 'hire'}, 'does not take `node`')):
            with self.subTest(**extra):
                r0 = self.rev()
                with self.assertRaises(HTTPException) as cm:
                    self.staff(title='T', objective='Problem. Fix.', **extra)
                self.assertEqual(cm.exception.status_code, 422)
                self.assertIn(words, str(cm.exception.detail))
                self.assertEqual(self.rev(), r0)
        self.assertEqual(store.load_org(self.slug).nodes['x']['state'], 'archived')

    def test_rename_then_rehire_on_the_door(self):
        r = self.staff(name='xx', title='T', objective='Problem. Fix.')
        self.assertEqual(r['node'], 'xx')
        self.assertEqual(r.get('renamed_to'), 'xx')
        self.assertEqual(store.load_org(self.slug).nodes['xx']['state'], 'live')
        self.assertEqual(owner(self.item(r['item'])), 'xx')


if __name__ == '__main__':
    unittest.main()
