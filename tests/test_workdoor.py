"""PG-3w: `orgtree_work` on the shared door (workdoor.py), end to end.

Through the real `api.agent_call` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1), with `store.write_org` made to explode so any call
that falls back into the resident DOC_LOCK cycle fails loudly:

  * a docket update commits on the door, holding the caller's node row;
  * an assignment mails the new owner once, drives it once AFTER the commit,
    and calls `mail_notify` for it (the legacy branch's two effects);
  * a new participant gets the door tail's participation notice, not a drive;
  * a halted caller is refused — by agent_call's pre-check (409) and, for a
    halt that commits after it, by the door's gate on the locked row (422) —
    and nothing is written;
  * the archive move is deferred inside the door body, and the NEXT call's
    `before` step sweeps it in its own transaction (plan decision 13);
  * ORGTREE_PGDOOR=0 takes the legacy cycle.

Run:  python tools/run-python-verification.py tests/test_workdoor.py
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-workdoor-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, store, supervisor, workdoor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


def _explode(*a, **k):
    raise AssertionError('orgtree_work fell into the DOC_LOCK cycle')


class WorkDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'wdoor{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        for nid in ('sub', 'peer'):
            org.hire('boss', 'boss', 'luna', 0, nid, add_dirs=[], tools=T,
                     org_visibility='full', charter='c')
        org.work_create('boss', 'Door fixture item',
                        objective='Problem: docket on DOC_LOCK. Solution: the door.')
        store.save_org(org)
        self.wid = store.load_org(self.slug).d['work_items'][-1]['slug']
        pgdoor.use_org_tx(None)
        self.assertTrue(pgdoor.routed(workdoor.TOOL, {'action': 'update'}),
                        'orgtree_work is not declared on the door')
        self.sent, self.notified, self.locked = [], [], []
        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(
                                   (t, k.get('wake', True))) or {}),
                  patch.object(api, 'mail_notify',
                               lambda s, actor, n: self.notified.append(n)),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(store, 'write_org', _explode)]
        for x in self.p:
            x.start()
        self.sections = []
        orgtx.set_pause_hook(lambda p, tx: (
            self.locked.append(set(tx.lock_nodes)),
            self.sections.append(set(tx.lock_sections)))
            if p == 'after_lock' else None)

    def tearDown(self):
        orgtx.set_pause_hook(None)
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def call(self, node, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node=node,
                                            tool=workdoor.TOOL, args=a), REQUEST)

    def item(self):
        org = store.load_org(self.slug)
        for key in ('work_items', 'work_items_archive'):
            for it in org.d[key]:
                if it['slug'] == self.wid:
                    return it, key == 'work_items_archive'
        raise KeyError(self.wid)

    def test_update_commits_on_the_door_with_the_caller_row_held(self):
        r0 = int(self.item()[0]['rev'])
        self.call('boss', action='update', slug=self.wid,
                  done_so_far=['via door'], working_on_next=['next'])
        it, _ = self.item()
        self.assertEqual(it['done_so_far'], ['via door'])
        self.assertEqual(int(it['rev']), r0 + 1)
        self.assertIn('boss', self.locked[-1], 'the caller row must be held')

    def test_assign_mails_notifies_and_drives_the_new_owner_once(self):
        self.call('boss', action='assign', slug=self.wid, owner='sub')
        self.assertEqual(self.item()[0]['owner']['node'], 'sub')
        box = store.load_org(self.slug).d['mail'].get('sub') or []
        self.assertEqual(sum(1 for m in box if self.wid in str(m)), 1)
        self.assertEqual(self.notified.count('sub'), 1)
        self.assertEqual([t for t, wake in self.sent if wake], ['sub'])

    def test_assign_on_the_door_locks_only_the_new_owners_mail_box(self):
        self.call('boss', action='assign', slug=self.wid, owner='sub')
        self.assertIn('mail\x1fsub', self.sections[-1])
        self.assertNotIn('mail', self.sections[-1],
                         "the door call locked every agent's mail")

    def test_new_participant_is_noticed_not_driven(self):
        self.call('boss', action='participants', slug=self.wid, add=['peer'])
        self.assertIn('peer', self.notified)
        self.assertIn(('peer', False), self.sent)
        self.assertNotIn(('peer', True), self.sent)

    def test_halted_caller_is_refused_and_nothing_is_written(self):
        org = store.load_org(self.slug)
        org.d['nodes']['boss']['halt'] = {'at': 'now'}
        store.save_org(org)
        before = self.item()[0]
        # agent_call's own pre-check (the same 409 the legacy path gives)
        with self.assertRaises(HTTPException) as cm:
            self.call('boss', action='update', slug=self.wid,
                      done_so_far=['no'], working_on_next=['no'])
        self.assertEqual(cm.exception.status_code, 409)
        # a halt that commits AFTER that unlocked pre-check: the door's gate
        # on the LOCKED caller row refuses it, and the whole tx rolls back
        with patch.object(supervisor.halt, 'blocked', lambda *a, **k: None):
            with self.assertRaises(HTTPException) as cm:
                self.call('boss', action='update', slug=self.wid,
                          done_so_far=['no'], working_on_next=['no'])
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('halted', str(cm.exception.detail))
        self.assertEqual(self.item()[0], before)

    def test_archive_deferred_in_the_body_and_swept_by_the_next_before(self):
        self.call('boss', action='update', slug=self.wid, done_so_far=['x'],
                  working_on_next=['y'], status='dropped',
                  dropped_reason='Cancelled by the test; nothing to resume.')
        self.assertFalse(self.item()[1])
        # the door body WITHOUT its before-step must not archive it: the
        # ledger's head-of-call sweep is deferred inside the door (agent_tx
        # runs the declared before-step itself, so take it away for this call)
        call = SimpleNamespace(tool=workdoor.TOOL, org=self.slug, node='boss',
                               op_key=None)
        a = {'action': 'create', 'title': 'Unswept call',
             'objective': 'Problem: a. Solution: b.'}
        with patch.dict(pgdoor.BEFORE):
            pgdoor.BEFORE.pop(workdoor.TOOL, None)
            pgdoor.agent_tx(call, a, pgdoor.BODIES[workdoor.TOOL],
                            admit=lambda o, b, x: None, file=lambda *x: None,
                            spec=workdoor.spec(None, call, a))
        self.assertFalse(self.item()[1], 'the door body archived (deferral lost)')
        self.call('boss', action='create', title='Another item',
                  objective='Problem: a. Solution: b.')
        self.assertTrue(self.item()[1], "the next call's before-step archives it")

    def test_door_off_takes_the_legacy_cycle(self):
        with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}):
            with self.assertRaises(AssertionError) as cm:
                self.call('boss', action='update', slug=self.wid,
                          done_so_far=['x'], working_on_next=['y'])
        self.assertIn('DOC_LOCK cycle', str(cm.exception))


if __name__ == '__main__':
    unittest.main()
