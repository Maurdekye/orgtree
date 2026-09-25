"""The ONE agent_call hook: a declared tool runs on pgdoor, not the cycle.

Through the real `api.agent_call` (throwaway SQLite root, PG-0's real
SeamBackend org_tx, ORGTREE_PGDOOR=1), with a toy body declared for
`orgtree_status` — a verb nothing handles before the cycle:

  · a declared tool never enters the resident DOC_LOCK cycle
    (`store.write_org` is made to explode) and commits exactly once;
  · the body's `after.drive` is woken AFTER the commit, once per agent, and
    its `after.then` runs with the result;
  · a LedgerError from the body is a 422 and commits nothing;
  · ORGTREE_PGDOOR=0, or a tool with no declaration, takes the old cycle.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='pgdoor-agent-call-')
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
TOOL = 'orgtree_status'
_N = [0]


class Hook(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'hook{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.saved = (dict(pgdoor.LOCKS), dict(pgdoor.BODIES))
        self.sent, self.thens, self.runs = [], [], 0
        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(t) or {}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        pgdoor.LOCKS.clear()
        pgdoor.LOCKS.update(self.saved[0])
        pgdoor.BODIES.clear()
        pgdoor.BODIES.update(self.saved[1])
        store._POOL.close_all(self.slug)

    def declare(self, body):
        pgdoor.LOCKS.pop(TOOL, None)
        pgdoor.BODIES.pop(TOOL, None)
        pgdoor.declare(TOOL, pgdoor.TxSpec(), body=body)

    def good(self, tx):
        self.runs += 1
        tx.org.node(tx.node)['charter'] = 'via-door'
        tx.after.drive.extend(['boss', 'boss'])
        tx.after.then.append(self.thens.append)
        return {'ok': True}

    def call(self):
        return api.agent_call(api.AgentCall(org=self.slug, node='worker',
                                            tool=TOOL, args={}), REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def test_declared_tool_runs_on_the_door_not_the_cycle(self):
        self.declare(self.good)
        r0 = self.rev()
        with patch.object(store, 'write_org',
                          side_effect=AssertionError('entered the DOC_LOCK cycle')):
            r = self.call()
        self.assertTrue(r['ok'])
        self.assertEqual(self.runs, 1)
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'],
                         'via-door')
        self.assertEqual(self.rev(), r0 + 1)
        self.assertEqual(self.sent, ['boss'])          # driven once, after
        self.assertEqual(len(self.thens), 1)
        self.assertIs(self.thens[0], r)

    def test_refusal_is_422_and_commits_nothing(self):
        def bad(tx):
            tx.org.node(tx.node)['charter'] = 'nope'
            tx.after.drive.append('boss')
            raise ledger.LedgerError('refused by the family')

        self.declare(bad)
        r0 = self.rev()
        with self.assertRaises(HTTPException) as cm:
            self.call()
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'], 'c')
        self.assertEqual(self.rev(), r0)
        self.assertEqual(self.sent, [])                # nothing woken

    def test_switched_off_or_undeclared_takes_the_old_cycle(self):
        """The old cycle must actually be REACHED (counted), or this would
        pass on a call refused before the hook."""
        real, entered = store.write_org, []

        def counting(slug, *a, **k):
            entered.append(slug)
            return real(slug, *a, **k)

        self.declare(self.good)
        for env, keep in (({'ORGTREE_PGDOOR': '0'}, True), ({}, False)):
            if not keep:
                pgdoor.LOCKS.pop(TOOL)
                pgdoor.BODIES.pop(TOOL)
            entered.clear()
            with patch.dict(os.environ, env), \
                    patch.object(store, 'write_org', counting), \
                    patch.object(api, '_agent_door',
                                 side_effect=AssertionError('door used')):
                try:
                    self.call()
                except HTTPException:
                    pass           # the cycle's own answer is not ours
            self.assertEqual(entered, [self.slug], env)
        self.assertEqual(self.runs, 0)


if __name__ == '__main__':
    unittest.main()
