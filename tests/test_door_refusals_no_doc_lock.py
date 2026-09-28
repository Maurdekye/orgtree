"""S9 (plan decision 44 (2)): with the door on, the refusals that used to
be answered inside the DOC_LOCK cycle are answered before it.

Through the real `api.agent_call` / `api.org_op` (throwaway SQLite root,
ORGTREE_PGDOOR=1) under the DOC_LOCK tripwire in RAISE mode, so any
DOC_LOCK acquisition or legacy save raises DocLockTripped:

  * agent_call, an unknown tool -> 422 "unknown orgtree tool ...";
  * agent_call, orgtree_staff with a malformed staff_mode -> the staff_mode 422;
  * org_op, an undeclared op -> 422 "unknown op ...", and on a missing org
    the 404 first, as the locked branch answers.

Each answer is compared with the door-OFF answer (the cycle's), which must
be the same status and the same words.

Run:  python tools/run-python-verification.py tests/test_door_refusals_no_doc_lock.py
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='door-refusals-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


class DoorRefusals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.slug = 'refusals'
        org = store.create_org(cls.slug)
        org.hire(ledger.USER, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)

    @classmethod
    def tearDownClass(cls):
        store.arm_doc_lock_tripwire('off')
        store._POOL.close_all(cls.slug)

    def setUp(self):
        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def _answer(self, fn, door: bool):
        env = {'ORGTREE_PGDOOR': '1' if door else '0'}
        with patch.dict(os.environ, env):
            self.assertEqual(pgdoor.enabled(), door)
            if door:
                with store.doc_lock_tripwire(raising=True) as counts:
                    with self.assertRaises(HTTPException) as cm:
                        fn()
                    self.assertEqual((counts['legacy'], counts['save']), ({}, {}))
            else:
                with self.assertRaises(HTTPException) as cm:
                    fn()
        return cm.exception.status_code, str(cm.exception.detail)

    def _same_as_cycle(self, fn, status: int, words: str):
        on = self._answer(fn, door=True)
        self.assertEqual(on[0], status, on)
        self.assertIn(words, on[1])
        self.assertEqual(on, self._answer(fn, door=False))

    def _agent(self, tool, args):
        return lambda: api.agent_call(api.AgentCall(
            org=self.slug, node='worker', tool=tool, args=args), REQUEST)

    def test_unknown_tool(self):
        self._same_as_cycle(self._agent('orgtree_no_such_tool', {}),
                            422, "unknown orgtree tool 'orgtree_no_such_tool'")

    def test_malformed_staff_mode(self):
        self._same_as_cycle(self._agent('orgtree_staff', {'staff_mode': 'sideways'}),
                            422, 'staff_mode must be hire or rehire')

    def test_undeclared_operator_op(self):
        self._same_as_cycle(lambda: api.org_op(self.slug, api.Op(op='no_such_op'), REQUEST),
                            422, "unknown op 'no_such_op'")

    def test_undeclared_operator_op_on_a_missing_org(self):
        on = self._answer(lambda: api.org_op('no-such-org', api.Op(op='no_such_op'), REQUEST),
                          door=True)
        self.assertEqual(on[0], 404, on)
        self.assertEqual(on, self._answer(
            lambda: api.org_op('no-such-org', api.Op(op='no_such_op'), REQUEST), door=False))


if __name__ == '__main__':
    unittest.main()
