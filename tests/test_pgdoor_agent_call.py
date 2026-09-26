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
        # TOOL is a REAL tool name, and its family (PG-3c) registers more
        # than LOCKS/BODIES for it — its kiosk exemption, `when`, `before` —
        # so every door registry is saved here and restored in tearDown
        self.saved = (dict(pgdoor.LOCKS), dict(pgdoor.BODIES),
                      set(pgdoor.KIOSK_EXEMPT), dict(pgdoor.WHEN),
                      dict(pgdoor.BEFORE))
        self.sent, self.thens, self.runs, self.hub = [], [], 0, []
        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(t) or {}),
                  patch.object(api, 'hub_changed',
                               lambda *a, **k: self.hub.append(1))]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        pgdoor.LOCKS.clear()
        pgdoor.LOCKS.update(self.saved[0])
        pgdoor.BODIES.clear()
        pgdoor.BODIES.update(self.saved[1])
        pgdoor.KIOSK_EXEMPT.clear()
        pgdoor.KIOSK_EXEMPT.update(self.saved[2])
        pgdoor.WHEN.clear()
        pgdoor.WHEN.update(self.saved[3])
        pgdoor.BEFORE.clear()
        pgdoor.BEFORE.update(self.saved[4])
        store._POOL.close_all(self.slug)

    def declare(self, body):
        # the test's own declaration, and nothing of the real family's
        pgdoor.LOCKS.pop(TOOL, None)
        pgdoor.BODIES.pop(TOOL, None)
        pgdoor.KIOSK_EXEMPT.discard(TOOL)
        pgdoor.WHEN.pop(TOOL, None)
        pgdoor.BEFORE.pop(TOOL, None)
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

    # ---------------------------------------------------------------- D1
    # Review D1 / plan decision 26: no code path may ACQUIRE DOC_LOCK while it
    # holds org_tx row locks. A body that leaves an `_account_selection` makes
    # the door bind the account inside its transaction — through
    # supervisor.assign_account, which took `with store.DOC_LOCK`.

    def _account_tool(self):
        from orgtree import registry
        row = registry.create_account(
            'claude', 't', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'acct-{self.slug}')})
        org = store.load_org(self.slug)
        org.node('worker')['model'] = 'opus'
        store.save_org(org)

        def body(tx):
            self.runs += 1
            return {'ok': True,
                    '_account_selection': ('worker', row['id'], 'manual')}
        pgdoor.LOCKS.pop(TOOL, None)
        pgdoor.BODIES.pop(TOOL, None)
        pgdoor.declare(TOOL, pgdoor.TxSpec(logs=('events',)), body=body)
        return row['id']

    def test_account_binding_takes_no_doc_lock_inside_the_transaction(self):
        rid = self._account_tool()
        real, inside = store.DOC_LOCK, []

        class Probe:
            """DOC_LOCK, recording every acquisition made while a door
            transaction is open on this context."""
            def _mark(self):
                if pgdoor._CURRENT.get() is not None:
                    inside.append(1)

            def __enter__(self):
                self._mark()
                return real.__enter__()

            def __exit__(self, *e):
                return real.__exit__(*e)

            def acquire(self, *a, **k):
                self._mark()
                return real.acquire(*a, **k)

            def release(self):
                return real.release()

        with patch.object(store, 'DOC_LOCK', Probe()):
            r = self.call()
        self.assertEqual(r['account'], rid)
        self.assertEqual(store.load_org(self.slug).node('worker').get('account'), rid)
        self.assertEqual(self.runs, 1)
        self.assertEqual(inside, [], 'DOC_LOCK acquired under the row locks')

    def test_account_binding_does_not_wait_for_a_doc_lock_holder(self):
        """The deadlock's mechanism (review P7), deterministic: another thread
        holds DOC_LOCK. A door call that needs it would block until release —
        and a legacy holder waiting on the door's row would never release."""
        import threading
        fence = getattr(orgtx, 'TRANSITION_FENCE', None)
        if fence is not None:
            orgtx.TRANSITION_FENCE = False       # the fence takes it BEFORE rows
            self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        rid = self._account_tool()
        held, release, done, out = (threading.Event(), threading.Event(),
                                    threading.Event(), {})

        def holder():
            with store.DOC_LOCK:
                held.set()
                release.wait(10)

        def caller():
            try:
                out['r'] = self.call()
            except BaseException as e:      # noqa: BLE001
                out['e'] = e
            done.set()

        h = threading.Thread(target=holder, daemon=True)
        h.start()
        self.assertTrue(held.wait(5))
        c = threading.Thread(target=caller, daemon=True)
        c.start()
        finished = done.wait(3)
        release.set()
        c.join(10)
        h.join(10)
        self.assertTrue(finished, 'the door call waited for DOC_LOCK')
        self.assertNotIn('e', out, out.get('e'))
        self.assertEqual(out['r']['account'], rid)

    # ---------------------------------------------------------- F1 / F2
    # Plan decision 27.

    def test_a_raising_after_step_keeps_the_committed_write(self):
        """F2: an `after.then` that raises is AFTER the commit — the row is
        committed, the call succeeds and the failure is a warning."""
        def boom(result):
            raise RuntimeError('then broke')

        def body(tx):
            self.good(tx)
            tx.after.then.append(boom)
            return {'ok': True}
        self.declare(body)
        r0 = self.rev()
        r = self.call()
        self.assertTrue(r['ok'])
        self.assertEqual(self.rev(), r0 + 1)
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'],
                         'via-door')
        self.assertEqual(r['warnings'], [{'step': 'then:boom',
                                          'error': 'RuntimeError: then broke'}])
        self.assertEqual(self.hub, [1])          # the rest of the tail still ran

    def test_a_raising_wake_is_a_warning_and_the_tail_goes_on(self):
        def send(slug, target, *a, **k):
            raise OSError('pipe gone')
        self.declare(self.good)
        with patch.object(supervisor, 'send_message', send):
            r = self.call()
        self.assertTrue(r['ok'])
        self.assertEqual([w['step'] for w in r['warnings']], ['drive:boss'])
        self.assertEqual(len(self.thens), 1)
        self.assertEqual(self.hub, [1])

    def test_before_runs_once_outside_the_transaction_and_feeds_pre(self):
        seen, bodies = [], []

        def before(call, a):
            seen.append((pgdoor.current(self.slug), call.node))
            return {'resolved': 'acct-x'}

        def body(tx):
            bodies.append(tx.pre.get('resolved'))
            if len(bodies) == 1:
                raise pgdoor.Widen(nodes=['boss'])     # one re-run
            return {'ok': True}
        pgdoor.LOCKS.pop(TOOL, None)
        pgdoor.BODIES.pop(TOOL, None)
        pgdoor.declare(TOOL, pgdoor.TxSpec(), body=body, before=before)
        self.assertTrue(self.call()['ok'])
        self.assertEqual(seen, [(None, 'worker')])     # once, no tx open
        self.assertEqual(bodies, ['acct-x', 'acct-x'])

    def test_when_routes_only_the_calls_it_accepts(self):
        pgdoor.LOCKS.pop(TOOL, None)
        pgdoor.BODIES.pop(TOOL, None)
        pgdoor.declare(TOOL, pgdoor.TxSpec(), body=self.good,
                       when=lambda a: a.get('mode') == 'door')
        self.assertTrue(pgdoor.routed(TOOL, {'mode': 'door'}))
        self.assertFalse(pgdoor.routed(TOOL, {'mode': 'cycle'}))
        self.assertFalse(pgdoor.routed(TOOL))          # no args: not routed
        api.agent_call(api.AgentCall(org=self.slug, node='worker', tool=TOOL,
                                     args={'mode': 'cycle'}), REQUEST)
        self.assertEqual(self.runs, 0)                  # the cycle took it
        api.agent_call(api.AgentCall(org=self.slug, node='worker', tool=TOOL,
                                     args={'mode': 'door'}), REQUEST)
        self.assertEqual(self.runs, 1)

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

    def test_replay_runs_no_tail_and_saves_nothing(self):
        """A replayed key: the cycle returns the receipt BEFORE its epilogue,
        so the door must too — no drive, no hub fan-out, no then, no save."""
        self.declare(self.good)
        # PG-0's SeamBackend heals an org with one plain save on its FIRST
        # transaction in the process (orgtx._heal); take that first
        pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)
        r0 = self.rev()
        saves = []
        real_save = store.save_org
        with patch.object(api, '_op_admit', lambda org, body, a: {
                    'replay': {'replayed': True, 'receipt': {'id': 'r1'}}}), \
                patch.object(store, 'save_org',
                             lambda *a, **k: saves.append(1) or real_save(*a, **k)):
            r = self.call()
        self.assertTrue(r['replayed'])
        self.assertEqual(self.runs, 0)
        self.assertEqual((self.sent, self.thens, self.hub, saves), ([], [], [], []))
        self.assertEqual(self.rev(), r0)

    def test_kiosk_cap_is_checked_unless_the_tool_is_exempt(self):
        org = store.load_org(self.slug)
        org.d['kiosk'] = {'credits': 1}            # holdings (20) exceed it
        store.save_org(org)
        self.declare(self.good)
        with self.assertRaises(HTTPException) as cm:
            self.call()
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('kiosk credit cap', cm.exception.detail)
        pgdoor.LOCKS.pop(TOOL)
        pgdoor.BODIES.pop(TOOL)
        pgdoor.declare(TOOL, pgdoor.TxSpec(), body=self.good, kiosk_exempt=True)
        try:
            self.assertTrue(self.call()['ok'])
        finally:
            pgdoor.KIOSK_EXEMPT.discard(TOOL)

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
