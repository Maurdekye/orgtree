"""PG-3w: `orgtree_work` through WS3a's pgdoor over PG-0's org_tx (workdoor.py).

Runs the REAL api body (`api._work_identity_ready` + `api._work_mutate`)
through `pgdoor.agent_tx`, over PG-0's SeamBackend fake on a throwaway SQLite
root, with `workdoor.orgtx_seam()` as pgdoor's storage primitive. Proves:
  * a docket write commits through the door, once, with the caller's node
    row held (pgdoor's prologue) and the docket rows named by the declaration;
  * the seam: PG-0's commit-time UnlockedWrite becomes pgdoor's Widen, so a
    declaration that misses the mailed owner re-runs and the assignment mail
    lands EXACTLY once;
  * the halt gate on the locked caller row refuses and writes nothing;
  * the archive move stays deferred inside the door and `call`'s sweep does
    it in its own transaction (decision 13).

Run:  python tools/run-python-verification.py tests/test_workdoor.py
"""

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-workdoor-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import events, events_render  # noqa: E402,F401
from orgtree import api, orgtx, pgdoor, store, workdoor  # noqa: E402
from orgtree.ledger import USER, LedgerError  # noqa: E402

_n = 0


def fixture():
    global _n
    _n += 1
    org = store.create_org(f'wdoor-{_n}')
    slug = org.d['slug']
    for nid in ('own', 'peer'):
        org.hire(USER, None, 'haiku', 0, nid)
    org.hire(USER, 'own', 'haiku', 0, 'sub')
    org.work_create('own', 'Door fixture item',
                    objective='Problem: docket on DOC_LOCK. Solution: the door.',
                    participants=['peer'])
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug, store.load_org(slug).d['work_items'][-1]['slug']


def item(slug, wid):
    org = store.load_org(slug)
    for key, archived in (('work_items', False), ('work_items_archive', True)):
        for it in org.d[key]:
            if it['slug'] == wid:
                return it, archived
    raise KeyError(wid)


BODY = workdoor.body(api._work_identity_ready, api._work_mutate)


def door(slug, node, a, spec=None):
    call = SimpleNamespace(tool=workdoor.TOOL, org=slug, node=node, op_key=None)
    if spec is not None:
        return pgdoor.agent_tx(call, a, BODY, admit=lambda o, b, x: None,
                               file=lambda *x: None, spec=spec)
    return workdoor.call(call, a, BODY, admit=lambda o, b, x: None,
                         file=lambda *x: None)


class WorkDoor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workdoor.orgtx_seam()
        workdoor.declare()

    def setUp(self):
        orgtx.use_backend(orgtx.SeamBackend())
        orgtx.set_pause_hook(None)
        self.slug, self.wid = fixture()
        self.attempts = []
        orgtx.set_pause_hook(lambda p, tx: self.attempts.append(
            (tx.lock_nodes, tx.lock_sections)) if p == 'after_lock' else None)

    def tearDown(self):
        orgtx.set_pause_hook(None)

    def test_update_commits_through_the_door_with_the_caller_row_held(self):
        r0 = int(item(self.slug, self.wid)[0]['rev'])
        door(self.slug, 'own', {'action': 'update', 'slug': self.wid,
                                'done_so_far': ['via door'], 'working_on_next': ['next']})
        it, _ = item(self.slug, self.wid)
        self.assertEqual(it['done_so_far'], ['via door'])
        self.assertEqual(int(it['rev']), r0 + 1)
        # the door's tx (the last one; the sweep ran first on its own)
        nodes, sections = self.attempts[-1]
        self.assertIn('own', nodes, 'pgdoor must hold the caller row FOR UPDATE')
        self.assertTrue({'work_items', 'asks'} <= sections)

    def test_seam_widens_a_missed_mail_recipient_and_mails_once(self):
        thin = pgdoor.TxSpec(sections=('asks', 'work_items'), logs=('events',))
        door(self.slug, 'own', {'action': 'assign', 'slug': self.wid, 'owner': 'sub'},
             spec=thin)
        it, _ = item(self.slug, self.wid)
        self.assertEqual(it['owner']['node'], 'sub')
        self.assertGreaterEqual(len(self.attempts), 2, 'the thin spec should have widened')
        self.assertIn('sub', self.attempts[-1][0])
        box = store.load_org(self.slug).d['mail'].get('sub') or []
        self.assertEqual(sum(1 for m in box if self.wid in str(m)), 1)

    def test_predicted_assign_needs_no_widening(self):
        door(self.slug, 'own', {'action': 'assign', 'slug': self.wid, 'owner': 'sub'})
        # one sweep tx + ONE door tx
        self.assertEqual(len(self.attempts), 2)

    def test_halted_caller_is_refused_and_nothing_is_written(self):
        org = store.load_org(self.slug)
        org.d['nodes']['own']['halt'] = {'at': 'now'}
        store.save_org(org)
        before = item(self.slug, self.wid)[0]
        with self.assertRaises(LedgerError):
            door(self.slug, 'own', {'action': 'update', 'slug': self.wid,
                                    'done_so_far': ['no'], 'working_on_next': ['no']})
        self.assertEqual(item(self.slug, self.wid)[0], before)

    def test_archive_is_deferred_in_the_door_and_swept_before_the_next_call(self):
        door(self.slug, 'own', {'action': 'update', 'slug': self.wid,
                                'done_so_far': ['x'], 'working_on_next': ['y'],
                                'status': 'dropped',
                                'dropped_reason': 'Cancelled by the test; nothing to resume.'})
        self.assertFalse(item(self.slug, self.wid)[1])
        # a door call WITHOUT the preceding sweep must not archive it: the
        # ledger's head-of-call sweep is deferred inside the door
        a = {'action': 'create', 'title': 'Unswept call',
             'objective': 'Problem: a. Solution: b.'}
        door(self.slug, 'own', a, spec=workdoor.spec(None, None, a))
        self.assertFalse(item(self.slug, self.wid)[1],
                         'the door body archived another item (deferral lost)')
        door(self.slug, 'own', {'action': 'create', 'title': 'Another item',
                                'objective': 'Problem: a. Solution: b.'})
        self.assertTrue(item(self.slug, self.wid)[1],
                        'the next call\'s own sweep transaction archives it')


if __name__ == '__main__':
    unittest.main()
