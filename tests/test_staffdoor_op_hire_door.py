"""The operator's hire (`POST /api/orgs/{slug}/ops`, op="hire") on the door,
end to end: the real `api.org_op`, PG-0's SeamBackend org_tx,
ORGTREE_PGDOOR=1, a throwaway SQLite root.

  · top-level, under-a-parent and insert-above hires run on the door (the
    DOC_LOCK cycle `_org_op_locked` is made to explode), commit once, and
    the declaration is complete for each (one run of `_op_hire`);
  · the atomic scope fields (effort) land in the same commit;
  · a refused hire is a 422 and commits nothing;
  · ORGTREE_PGDOOR=0 takes the old DOC_LOCK path, which is REACHED.
The provider gate and harness choice are machine reads, stubbed.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='staffdoor-op-hire-')
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
_N = [0]


class OpHireDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'oh{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'root')
        org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('mid', 'mid', 'luna', 0, 'peer', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.runs = []
        real = api._op_hire

        def counted(*a, **k):
            self.runs.append(1)
            return real(*a, **k)

        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'provider_hire_gate', lambda *a, **k: None),
                  patch.object(api, 'new_hire_harness', lambda *a, **k: None),
                  patch.object(api, '_op_hire', counted),
                  patch.object(api, '_org_op_locked',
                               side_effect=AssertionError('entered the DOC_LOCK cycle'))]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def op(self, **kw):
        return api.org_op(self.slug, api.Op(op='hire', tier='luna', **kw), REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def test_declared_and_routed(self):
        self.assertTrue(pgdoor.routed('hire'))
        self.assertIs(pgdoor.BODIES['hire'], staffdoor.op_hire_body)

    def test_top_level_hire(self):
        r0 = self.rev()
        r = self.op(name='solo', grant=3)
        self.assertEqual(r['node'], 'solo')
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.rev(), r0 + 1)
        self.assertIsNone(store.load_org(self.slug).node('solo')['parent'])

    def test_hire_under_a_parent_with_effort_in_the_same_commit(self):
        r0 = self.rev()
        r = self.op(name='kid', parent='peer', grant=6, charter='c',
                    add_dirs=[], tools=T, org_visibility='full', effort='high')
        self.assertEqual(r['node'], 'kid')
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.rev(), r0 + 1)
        org = store.load_org(self.slug)
        self.assertEqual(org.node('kid')['parent'], 'peer')
        self.assertEqual(org.node('kid')['scope'].get('effort'), 'high')

    def test_insert_above(self):
        r = self.op(name='lead', parent='mid', above='peer', charter='c')
        self.assertEqual(r['node'], 'lead')
        self.assertEqual(len(self.runs), 1)
        org = store.load_org(self.slug)
        self.assertEqual(org.node('peer')['parent'], 'lead')
        self.assertEqual(org.node('lead')['parent'], 'mid')

    def test_refused_is_422_and_commits_nothing(self):
        r0 = self.rev()
        with self.assertRaises(HTTPException) as cm:
            self.op(name='x', parent='nobody', charter='c', add_dirs=[],
                    tools=T, org_visibility='full')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.rev(), r0)
        self.assertNotIn('x', store.load_org(self.slug).nodes)

    def test_switched_off_takes_the_old_path(self):
        entered = []
        self.p[-1].stop()
        real = api._org_op_locked
        try:
            with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}), \
                    patch.object(api, '_org_op_locked',
                                 lambda *a, **k: entered.append(1) or real(*a, **k)), \
                    patch.object(api, '_op_door',
                                 side_effect=AssertionError('door used')):
                r = self.op(name='old', grant=1)
        finally:
            self.p[-1].start()
        self.assertEqual(r['node'], 'old')
        self.assertEqual(entered, [1])


if __name__ == '__main__':
    unittest.main()
