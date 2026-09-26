"""S6: the runtime tools run on the row-transaction door (runtimedoor.py).

Through the real `api.agent_call` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1). The resident DOC_LOCK cycle is made to explode
(`store.write_org`), so a tool that still entered it fails the test. Every
external effect — `interrupt_turn`, `launch_self_restart`, the primed-restart
and restart-wake sidecars, the unstick resume mail — is replaced by a
recorder that notes whether an org_tx was still open when it ran: each must
run exactly once, AFTER the commit, and never when the call rolls back.
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='s6-runtime-door-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import (api, ledger, orgtx, pgdoor, restart_wake,  # noqa: E402
                     runtimedoor, store, supervisor)

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


class RuntimeDoor(unittest.TestCase):

    def setUp(self):
        _N[0] += 1
        self.slug = f's6rt{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 5, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('worker', 'worker', 'luna', 0, 'sub', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.effects: list[tuple] = []
        self.sent: list[tuple] = []

        def rec(name, ret=None):
            def f(*a, **k):
                self.effects.append((name, a, orgtx.current_tx(self.slug)))
                return dict(ret or {'effect': name})
            return f

        def boom(*_a, **_k):
            raise AssertionError('a runtime tool entered the DOC_LOCK cycle')

        self.p = [
            patch.object(store, 'write_org', boom),
            patch.object(supervisor, 'interrupt_turn', rec('interrupt')),
            patch.object(supervisor, 'launch_self_restart', rec('launch')),
            patch.object(supervisor, 'arm_prime_restart', rec('prime_arm')),
            patch.object(supervisor, 'cancel_prime_restart',
                         rec('prime_cancel')),
            patch.object(restart_wake, 'arm_restart_wake', rec('wake_arm')),
            patch.object(restart_wake, 'cancel_restart_wake',
                         rec('wake_cancel')),
            patch.object(restart_wake, 'status_restart_wake',
                         rec('wake_status')),
            patch.object(supervisor, 'send_message',
                         lambda slug, t, text, **k: self.sent.append(
                             (t, text, orgtx.current_tx(slug))) or {}),
            patch.object(supervisor, 'notify', lambda *a, **k: None),
            patch.object(api, 'hub_changed', lambda *a, **k: None),
        ]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def call(self, caller, tool, **args):
        return api.agent_call(api.AgentCall(org=self.slug, node=caller,
                                            tool=tool, args=args), REQUEST)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def after_commit(self, name):
        """Exactly one `name` effect, run with no transaction open."""
        got = [e for e in self.effects if e[0] == name]
        self.assertEqual(len(got), 1, self.effects)
        self.assertIsNone(got[0][2], f'{name} ran inside the transaction')
        return got[0]

    # ------------------------------------------------------------ routing

    def test_every_runtime_tool_is_routed_onto_the_door(self):
        for tool in runtimedoor.TOOLS:
            self.assertTrue(pgdoor.routed(tool, {}), tool)

    # ---------------------------------------------------------- interrupt

    def test_interrupt_signals_after_the_commit(self):
        r0 = self.rev()
        out = self.call('boss', 'orgtree_interrupt', node='worker')
        _, args, _ = self.after_commit('interrupt')
        self.assertEqual(args, (self.slug, 'worker'))
        self.assertEqual(out.get('effect'), 'interrupt')
        self.assertGreaterEqual(self.rev(), r0)

    def test_interrupt_refuses_upward_and_signals_nothing(self):
        with self.assertRaises(HTTPException) as cm:
            self.call('worker', 'orgtree_interrupt', node='boss')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.effects, [])

    def test_a_rolled_back_interrupt_signals_nothing(self):
        # the door's own in-transaction step after the body refuses: the
        # transaction rolls back, and the queued effect must not run
        with patch.object(supervisor, 'kiosk_cfg',
                          lambda org: {'credits': 1}), \
                patch.object(api, '_kiosk_cap_check',
                             side_effect=ledger.LedgerError('cap')):
            with self.assertRaises(HTTPException):
                self.call('boss', 'orgtree_interrupt', node='worker')
        self.assertEqual(self.effects, [])

    # ------------------------------------------------------------ unstick

    def _freeze(self, nid, texts):
        org = store.load_org(self.slug)
        org.node(nid)['frozen'] = {'at': 'x', 'resume_texts': texts,
                                   'resume_views': texts}
        store.save_org(org)

    def test_unstick_commits_then_resumes(self):
        self._freeze('worker', ['carry on'])
        out = self.call('boss', 'orgtree_unstick', node='worker')
        self.assertTrue(out.get('released'))
        self.assertNotIn('frozen', store.load_org(self.slug).node('worker'))
        self.assertEqual([(t, x) for t, x, _ in self.sent],
                         [('worker', 'carry on')])
        self.assertIsNone(self.sent[0][2], 'resume mail sent inside the tx')

    def test_unstick_clears_fable_lock_only_for_its_last_holder(self):
        org = store.load_org(self.slug)
        # no_reset: a timeless lock is otherwise healed away on load
        org.d['fable_lock'] = {'at': 'x', 'no_reset': True}
        org.node('worker')['limit_locked'] = True
        org.node('sub')['limit_locked'] = True
        store.save_org(org)
        self.call('boss', 'orgtree_unstick', node='worker')
        self.assertIsNotNone(store.load_org(self.slug).d.get('fable_lock'))
        self.call('boss', 'orgtree_unstick', node='sub')
        self.assertIsNone(store.load_org(self.slug).d.get('fable_lock'))

    def test_unstick_refuses_upward(self):
        self._freeze('boss', ['x'])
        with self.assertRaises(HTTPException) as cm:
            self.call('worker', 'orgtree_unstick', node='boss')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('frozen', store.load_org(self.slug).node('boss'))
        self.assertEqual(self.sent, [])

    # ------------------------------------------------------- restart wake

    def test_restart_wake_arm_writes_the_sidecar_after_the_commit(self):
        out = self.call('worker', 'orgtree_restart_wake', target='sub',
                        reason='r')
        _, args, _ = self.after_commit('wake_arm')
        self.assertEqual(args, (self.slug, 'sub', 'worker'))
        self.assertEqual(out.get('effect'), 'wake_arm')

    def test_restart_wake_for_a_non_subordinate_is_403(self):
        with self.assertRaises(HTTPException) as cm:
            self.call('sub', 'orgtree_restart_wake', target='worker')
        self.assertEqual(cm.exception.status_code, 403)
        self.assertEqual(self.effects, [])

    # ------------------------------------------------------- self restart

    def test_self_restart_logs_then_launches(self):
        self.call('boss', 'orgtree_self_restart')
        _, args, _ = self.after_commit('launch')
        self.assertEqual(args[:3], (self.slug, 'boss', 'org'))
        ev = [e for e in store.load_org(self.slug).d.get('events') or []
              if e.get('op') == 'self_restart']
        self.assertEqual(len(ev), 1)

    def test_self_restart_without_authority_launches_nothing(self):
        with self.assertRaises(HTTPException) as cm:
            self.call('worker', 'orgtree_self_restart')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.effects, [])

    # ----------------------------------------------------- primed restart

    def test_prime_restart_arm_and_cancel_after_the_commit(self):
        self.call('boss', 'orgtree_prime_restart', action='arm', reason='r')
        self.after_commit('prime_arm')
        self.call('boss', 'orgtree_prime_restart', action='cancel')
        self.after_commit('prime_cancel')
        ops = [e.get('op') for e in
               store.load_org(self.slug).d.get('events') or []]
        self.assertIn('prime_restart_arm', ops)
        self.assertIn('prime_restart_cancel', ops)

    def test_prime_restart_status_is_a_read(self):
        with patch.object(supervisor, 'primed_restart', lambda: None):
            out = self.call('worker', 'orgtree_prime_restart',
                            action='status')
        self.assertIsNone(out['primed'])
        self.assertEqual(self.effects, [])


if __name__ == '__main__':
    unittest.main()
