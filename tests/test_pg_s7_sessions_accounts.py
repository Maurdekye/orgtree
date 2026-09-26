"""Fence-off S7, landing L1 (S7-LOCK-PLAN.md, reviewed by p01 2026-09-26 13:39Z):
the account and scope writers that still took DOC_LOCK, onto row transactions.

  * orgtree_request_scope runs on the door (accountdoor): it never enters the
    DOC_LOCK cycle, it does not wait for a DOC_LOCK holder, and its row plan
    names the superior's mail rows exactly when the request routes;
  * orgtree_account_mark's two windows are a lock-free admission read and one
    row transaction: a keyed replay is answered from the new window 1 (p01's
    required pin), and a clear does not wait for a DOC_LOCK holder;
  * reconcile's per-marker spend and its `finally` restore commit as row
    transactions: the only DOC_LOCK the pass still takes is its first block
    (converted in L3, on org_tx(whole=True)).

The DOC_LOCK-holder tests run with PG-0b's transition fence OFF (plan decision
19): with it on, every org_tx takes DOC_LOCK first by design.

Run:  python tools/run-python-verification.py tests/test_pg_s7_sessions_accounts.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='pg-s7-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import (accountdoor, api, ledger, mailtx, opreceipts, orgtx,  # noqa: E402
                     pgdoor, registry, store, supervisor)

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


def tearDownModule() -> None:
    _root.cleanup()


def _slug(stem: str) -> str:
    _N[0] += 1
    return f'{stem}{_N[0]}'


def _fence_off(case: unittest.TestCase) -> None:
    case.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
    orgtx.TRANSITION_FENCE = False


def _while_doc_lock_held(case: unittest.TestCase, fn, limit: float = 5.0):
    """Run `fn` on a thread while ANOTHER thread holds DOC_LOCK. Returns its
    result; fails if it did not finish within `limit` seconds (it waited for
    DOC_LOCK) or raised."""
    held, release, done, out = (threading.Event(), threading.Event(),
                                threading.Event(), {})

    def holder():
        with store.DOC_LOCK:
            held.set()
            release.wait(30)

    def caller():
        try:
            out['r'] = fn()
        except BaseException as e:        # noqa: BLE001
            out['e'] = e
        done.set()

    h = threading.Thread(target=holder, daemon=True)
    h.start()
    case.assertTrue(held.wait(5))
    c = threading.Thread(target=caller, daemon=True)
    c.start()
    finished = done.wait(limit)
    release.set()
    c.join(30)
    h.join(30)
    case.assertTrue(finished, 'the call waited for a DOC_LOCK holder')
    if 'e' in out:
        raise out['e']
    return out['r']


class _NoCycle:
    """store.write_org made to explode: the DOC_LOCK cycle must not run."""

    def __enter__(self):
        self.p = patch.object(store, 'write_org', side_effect=AssertionError(
            'entered the DOC_LOCK cycle'))
        self.p.start()

    def __exit__(self, *e):
        self.p.stop()


# ─────────────────────────────────────────────────────────── request_scope

class RequestScopeDoor(unittest.TestCase):
    def setUp(self):
        self.slug = _slug('s7scope')
        org = store.create_org(self.slug)
        org.hire(U, None, 'opus', 20, 'boss')
        org.hire('boss', 'boss', 'opus', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.sent = []
        self.p = patch.object(supervisor, 'send_message',
                              lambda slug, t, *a, **k: self.sent.append(t) or {})
        self.p.start()

    def tearDown(self):
        self.p.stop()
        store._POOL.close_all(self.slug)

    # a folder nobody holds: a top-level hire already holds every tool
    ITEMS = ({'kind': 'dir', 'path': 'C:/s7-not-held', 'mode': 'ro'},)

    def call(self, node, items=ITEMS):
        return api.agent_call(api.AgentCall(
            org=self.slug, node=node, tool='orgtree_request_scope',
            args={'items': list(items), 'reason': 'need it'}), REQUEST)

    def test_it_is_declared_on_the_door(self):
        self.assertTrue(pgdoor.routed('orgtree_request_scope', {}))

    def test_rows_name_the_superior_mail_exactly_when_the_request_routes(self):
        org = store.load_org(self.slug)
        top = accountdoor.request_scope_rows(org, 'boss')
        deep = accountdoor.request_scope_rows(org, 'worker')
        mail = mailtx.send_rows('boss')
        for spec in (top, deep):
            self.assertIn('scope_requests', spec.sections)
            self.assertIn('headless', spec.share_sections)
            self.assertIn('audiences', spec.share_sections)
            self.assertIn('events', spec.logs)
        self.assertNotIn('boss', top.nodes)          # top-level: no routing
        self.assertIn('boss', deep.nodes)            # routed to its superior
        for s in mail['sections']:
            self.assertIn(s, deep.sections)
        for lg in mail['logs']:
            self.assertIn(lg, deep.logs)
        # a user audience stops the routing: back to the plain filing rows
        org.d['audiences'].append({'grantee': 'worker', 'grantor': U})
        self.assertTrue(org._has_audience('worker', U))
        self.assertNotIn('boss', accountdoor.request_scope_rows(org, 'worker').nodes)

    def test_a_top_level_request_files_on_the_door_not_the_cycle(self):
        with _NoCycle():
            r = self.call('boss')
        self.assertIn('requested', r)
        reqs = store.load_org(self.slug).d.get('scope_requests') or []
        self.assertEqual([(q['node'], q['status']) for q in reqs],
                         [('boss', 'pending')])

    def test_a_deep_request_routes_to_the_superior_and_drives_it_once(self):
        with _NoCycle():
            r = self.call('worker')
        self.assertEqual(r.get('routed'), 'boss')
        org = store.load_org(self.slug)
        self.assertFalse(org.d.get('scope_requests'))
        box = (org.d.get('mail') or {}).get('boss') or []
        self.assertTrue(any(m.get('kind') == 'request' for m in box), box)
        self.assertEqual(self.sent, ['boss'])

    def test_it_does_not_wait_for_a_doc_lock_holder(self):
        _fence_off(self)
        r = _while_doc_lock_held(self, lambda: self.call('worker'))
        self.assertEqual(r.get('routed'), 'boss')


# ──────────────────────────────────────────────────────────── account_mark

class AccountMarkWindows(unittest.TestCase):
    def setUp(self):
        for p in (registry.registry_path(),):
            if os.path.exists(p):
                os.unlink(p)
        self.acct = registry.create_account(
            'claude', 'm', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'acct{_N[0]}')})
        self.slug = _slug('s7mark')
        org = store.create_org(self.slug)
        org.hire(U, None, 'opus', 0, 'boss')
        store.save_org(org)
        self.assertTrue(registry.record_mark(
            self.acct['id'], 'opus', time.time() + 7200, window='weekly',
            provenance='observed'))

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def call(self, tool, args, **kw):
        return api.agent_call(api.AgentCall(org=self.slug, node='boss',
                                            tool=tool, args=args, **kw), REQUEST)

    def _clear_args(self):
        got = self.call('orgtree_account_mark',
                        {'action': 'inspect', 'account': self.acct['id']})
        e = next(m for m in got['marks'] if m['pool'] == 'pooled')
        return {'action': 'clear', 'account': e['account'], 'source': e['source'],
                'pool': e['pool'], 'expected': e['expected'], 'reason': 'ok'}

    def _cleared_rows(self):
        return [r for r in store.load_org(self.slug).d.get('events') or []
                if r.get('op') == 'account_mark_cleared']

    def test_a_keyed_replay_is_answered_by_the_admission_read(self):
        epoch = self.call(opreceipts.OP_EPOCH, {})['epoch']
        call = {'tool': 'orgtree_account_mark', 'args': self._clear_args(),
                'op_key': opreceipts.mint_key(), 'op_epoch': epoch}
        first = self.call(opreceipts.OP_CALL, call)
        self.assertEqual(first['result'], 'cleared')
        from orgtree import markclear
        with patch.object(markclear, 'clear',
                          side_effect=AssertionError('cleared twice')):
            again = self.call(opreceipts.OP_CALL, call)
        self.assertTrue(again['replayed'], again)
        self.assertEqual(len(self._cleared_rows()), 1)

    def test_a_clear_does_not_wait_for_a_doc_lock_holder(self):
        _fence_off(self)
        args = self._clear_args()
        r = _while_doc_lock_held(
            self, lambda: self.call('orgtree_account_mark', args))
        self.assertEqual(r['result'], 'cleared')
        self.assertEqual(len(self._cleared_rows()), 1)


# ─────────────────────────────────────────────────────────────── reconcile

class _CountingDocLock:
    """DOC_LOCK, counting acquisitions made by THIS thread."""

    def __init__(self, real):
        self.real, self.n, self.me = real, 0, threading.get_ident()

    def _mark(self):
        if threading.get_ident() == self.me:
            self.n += 1

    def __enter__(self):
        self._mark()
        return self.real.__enter__()

    def __exit__(self, *e):
        return self.real.__exit__(*e)

    def acquire(self, *a, **k):
        self._mark()
        return self.real.acquire(*a, **k)

    def release(self):
        return self.real.release()


class ReconcileSmallBlocks(unittest.TestCase):
    def setUp(self):
        _fence_off(self)
        self.slug = _slug('s7rec')
        org = store.create_org(self.slug)
        for nid in ('a', 'b'):
            org.hire(U, None, 'haiku', 0, nid)
            org.node(nid)['inflight'] = {'at': f'2026-09-26T10:00:0{len(nid)}Z',
                                         'text': f'{nid} original',
                                         'view': f'{nid} view'}
        store.save_org(org)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def test_spend_and_restore_take_no_doc_lock(self):
        order = []

        def send(slug, nid, *a, **k):
            order.append(nid)
            if len(order) == 2:
                raise RuntimeError('backend died mid-dispatch')
            return {}

        lock = _CountingDocLock(store.DOC_LOCK)
        with patch.object(store, 'DOC_LOCK', lock), \
                patch.object(supervisor, 'send_message', side_effect=send), \
                patch.object(supervisor, '_condemnable', return_value=False):
            with self.assertRaises(RuntimeError):
                supervisor.reconcile(self.slug)
        # the first block is one org_tx(whole=True) (L3); the spend before
        # each dispatch and the finally restore are row transactions: the
        # pass takes DOC_LOCK nowhere
        self.assertEqual(lock.n, 0, f'DOC_LOCK taken {lock.n} times')
        org = store.load_org(self.slug)
        first, second = order
        self.assertNotIn('inflight', org.node(first), 'the dispatched marker was not spent')
        self.assertEqual(org.node(second).get('inflight', {}).get('text'),
                         f'{second} original', 'the undispatched marker was not restored')



class ReconcileOneWholeTransaction(unittest.TestCase):
    """L3 (plan decision 23): reconcile's first block is ONE
    org_tx(whole=True). A failing step leaves exactly what the legacy pass had
    saved when it raised (p01, S7 Q5 (b)); the FR-01 kill precedes the pop for
    every flag present when the pass starts (Q4)."""

    def setUp(self):
        _fence_off(self)
        self.slug = _slug('s7whole')
        org = store.create_org(self.slug)
        for nid in ('cmd', 'rc', 'sw'):
            org.hire(U, None, 'haiku', 0, nid)
        # step 4 drops a COMMAND marker; step 3 pops a remote-control flag;
        # step 5 applies a queued switch
        org.node('cmd')['inflight'] = {'at': '2026-09-26T10:00:00Z', 'text': '/x',
                                       'view': '/x', 'cmd': '/x'}
        org.node('rc')['remote_controlled'] = {'pid': 424242}
        org.node('sw')['pending_switch'] = {'tier': 'sonnet', 'seq': 1}
        store.save_org(org)
        self.kills = []
        self.p = [patch.object(supervisor, '_condemnable', return_value=False),
                  patch.object(supervisor, '_reconcile_kill', self._kill),
                  patch.object(supervisor, 'send_message', return_value={}),
                  # the switch itself is not under test: a no-op apply
                  patch.object(supervisor, '_apply_pending_switch_locked')]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def _kill(self, pid):
        # what is on disk at the moment of the kill
        self.kills.append((pid, 'remote_controlled' in store.load_org(self.slug).node('rc')))

    def test_a_failing_step_keeps_the_steps_before_it_and_none_of_itself(self):
        def boom(org, slug, nid, **kw):
            org.node(nid)['half_applied'] = True        # a partial write, then
            raise RuntimeError('switch apply died')     # the step raises

        with patch.object(supervisor, '_apply_pending_switch_locked', boom):
            with self.assertRaisesRegex(RuntimeError, 'switch apply died'):
                supervisor.reconcile(self.slug)
        org = store.load_org(self.slug)
        self.assertNotIn('remote_controlled', org.node('rc'), 'step 3 was not committed')
        self.assertNotIn('inflight', org.node('cmd'), 'step 4 was not committed')
        self.assertNotIn('half_applied', org.node('sw'), "step 5's partial write committed")
        self.assertIn('pending_switch', org.node('sw'))

    def test_a_failing_replay_still_raises_the_original_error(self):
        # p01's review N2: step 5 fails, and then the replay of steps 1-4
        # fails too (halt recovery raises the second time it runs)
        calls = []

        def boom(org, slug, nid, **kw):
            raise RuntimeError('switch apply died')

        def recover(org):
            calls.append(1)
            if len(calls) > 1:
                raise KeyError('replay died')
            return False

        with patch.object(supervisor, '_apply_pending_switch_locked', boom), \
                patch.object(supervisor.halt, 'recover', recover):
            with self.assertRaisesRegex(RuntimeError, 'switch apply died') as cm:
                supervisor.reconcile(self.slug)
        self.assertIsInstance(cm.exception.__cause__, KeyError)
        self.assertEqual(len(calls), 2, 'the replay never ran')
        org = store.load_org(self.slug)
        self.assertIn('remote_controlled', org.node('rc'), 'something committed')
        self.assertIn('inflight', org.node('cmd'), 'something committed')

    def test_a_failing_first_step_commits_nothing(self):
        def boom(org):
            org.node('rc').pop('remote_controlled', None)
            raise RuntimeError('halt recovery died')

        with patch.object(supervisor.halt, 'recover', boom):
            with self.assertRaisesRegex(RuntimeError, 'halt recovery died'):
                supervisor.reconcile(self.slug)
        org = store.load_org(self.slug)
        self.assertIn('remote_controlled', org.node('rc'))
        self.assertIn('inflight', org.node('cmd'))

    def test_the_kill_precedes_the_pop(self):
        supervisor.reconcile(self.slug)
        self.assertEqual(self.kills, [(424242, True)])
        self.assertNotIn('remote_controlled', store.load_org(self.slug).node('rc'))

    def test_a_flag_written_after_the_read_is_killed_after_the_commit(self):
        with patch.object(supervisor, '_reconcile_remote_pids', return_value={}):
            supervisor.reconcile(self.slug)
        self.assertEqual(self.kills, [(424242, False)])

    def test_the_block_runs_in_one_whole_transaction(self):
        seen = []
        real = orgtx.org_tx_call

        def spy(slug, fn, **kw):
            seen.append(kw)
            return real(slug, fn, **kw)

        with patch.object(orgtx, 'org_tx_call', spy):
            supervisor.reconcile(self.slug)
        self.assertEqual(seen, [{'whole': True}])



# ─────────────────────────────────────────────── L2: account_assign on the door

class AccountAssignDoor(unittest.TestCase):
    def setUp(self):
        self.slug = _slug('s7assign')
        self.acct = registry.create_account(
            'claude', 'a', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'assign{_N[0]}')})
        org = store.create_org(self.slug)
        org.hire(U, None, 'opus', 40, 'boss')
        org.hire('boss', 'boss', 'opus', 10, 'mid', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('mid', 'mid', 'opus', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire(U, None, 'opus', 0, 'stranger')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.p = [patch.object(supervisor, 'send_message', return_value={}),
                  patch.object(supervisor, 'notify')]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def call(self, actor, node):
        return api.agent_call(api.AgentCall(
            org=self.slug, node=actor, tool='orgtree_account_assign',
            args={'node': node, 'account': self.acct['id']}), REQUEST)

    def test_it_is_declared_on_the_door(self):
        self.assertTrue(pgdoor.routed('orgtree_account_assign', {}))

    def test_rows_are_the_rebind_rows_and_the_authority_chain(self):
        org = store.load_org(self.slug)
        gen = int(org.node('worker').get('generation') or 0)
        spec = accountdoor.account_assign_rows(org, 'boss', 'worker')
        self.assertEqual(set(spec.nodes), {'worker', f'worker@{gen}'})
        self.assertEqual(set(spec.share_nodes), {'mid', 'boss'})
        for s in supervisor._ASSIGN_SECTIONS:
            self.assertIn(s, spec.sections)
        for s in supervisor._ASSIGN_SHARE:
            self.assertIn(s, spec.share_sections)
        for lg in supervisor._ASSIGN_LOGS:
            self.assertIn(lg, spec.logs)

    def test_a_superior_rebinds_on_the_door_not_the_cycle(self):
        with _NoCycle():
            r = self.call('boss', 'worker')
        self.assertIn('previous_account', r)       # the rebind's disclosure
        self.assertEqual(store.load_org(self.slug).node('worker').get('account'),
                         self.acct['id'])
        supervisor.notify.assert_called_with(self.slug, 'worker', 'account')

    def test_authority_refusals_keep_their_codes(self):
        for actor, node, code in (('worker', 'worker', 403),
                                  ('stranger', 'worker', 403),
                                  ('boss', '', 422)):
            with self.assertRaises(HTTPException) as cm:
                self.call(actor, node)
            self.assertEqual(cm.exception.status_code, code, (actor, node))
        self.assertIsNone(store.load_org(self.slug).node('worker').get('account'))

    def test_it_does_not_wait_for_a_doc_lock_holder(self):
        _fence_off(self)
        r = _while_doc_lock_held(self, lambda: self.call('boss', 'worker'))
        self.assertIn('previous_account', r)       # the rebind's disclosure

    def test_a_session_boundary_exports_after_the_commit(self):
        org = store.load_org(self.slug)
        org.node('worker')['codex_thread'] = 'thr-1'      # a session that ran
        org.node('worker').pop('session_unrun', None)
        store.save_org(org)
        gen0 = int(org.node('worker').get('generation') or 0)
        seen = []

        def export(slug, o, nid, old_sid, reason):
            # at the moment of the copy the rebind is already on disk
            seen.append((nid, reason, int(store.load_org(slug).node(nid)
                                          .get('generation') or 0)))
        with patch.object(supervisor, 'export_after_commit', export), \
                patch.object(supervisor, 'export_predecessor_transcript',
                             side_effect=AssertionError('copied under the locks')):
            self.call('boss', 'worker')
        self.assertEqual(seen, [('worker', 'account_assign', gen0 + 1)])


# ─────────────────────────────── L2: resume_frozen's fallback sweep, off DOC_LOCK

class ResumeFrozenFallback(unittest.TestCase):
    def setUp(self):
        _fence_off(self)
        self.slug = _slug('s7fallback')
        self.acct = registry.create_account(
            'claude', 'f', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'fb{_N[0]}')})
        org = store.create_org(self.slug)
        org.hire(U, None, 'opus', 0, 'worker')
        n = org.node('worker')
        n['codex_thread'] = 'thr-1'
        n.pop('session_unrun', None)
        n['frozen'] = {'at': '2026-09-26T10:00:00Z', 'limit': True,
                       'provider': 'claude', 'resume_texts': ['carry on']}
        store.save_org(org)
        self.gen0 = int(n.get('generation') or 0)
        self.exported = []
        self.p = [patch.object(supervisor, 'send_message', return_value={}),
                  patch.object(supervisor, '_run_turn'),
                  patch.object(supervisor, 'notify'),
                  patch.object(supervisor, 'export_after_commit', self._export),
                  patch.object(supervisor, 'export_predecessor_transcript',
                               side_effect=AssertionError('copied under the locks'))]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def _export(self, slug, org, nid, old_sid, reason):
        self.exported.append((nid, reason, int(store.load_org(slug).node(nid)
                                               .get('generation') or 0)))

    def _apply(self, org, nid, plan, *, exports=None):
        # account_fallback.apply's effect (its plan checks are provider IO
        # this test does not stage): the REAL rebind on the transaction's org
        out = supervisor.assign_account(
            org.d['slug'], nid, self.acct['id'], actor='@system', org=org,
            via='limit_fallback', allow_frozen=True, export=exports is None)
        sid = out.pop('_export_old_sid', None)
        if sid and exports is not None:
            exports.append((nid, str(sid), 'account_assign'))
        return True

    def test_the_sweep_takes_no_doc_lock_and_exports_after_the_commit(self):
        from orgtree import account_fallback
        lock = _CountingDocLock(store.DOC_LOCK)
        with patch.object(store, 'DOC_LOCK', lock), \
                patch.object(account_fallback, 'apply', self._apply):
            got = supervisor.resume_frozen(self.slug, only=['worker'],
                                           account_fallbacks={'worker': {}})
        self.assertEqual(got, ['worker'])
        self.assertEqual(lock.n, 0, f'DOC_LOCK taken {lock.n} times')
        n = store.load_org(self.slug).node('worker')
        self.assertEqual(n.get('account'), self.acct['id'])
        self.assertNotIn('frozen', n)
        self.assertEqual(self.exported, [('worker', 'account_assign', self.gen0 + 1)])

    def test_a_rolled_back_sweep_exports_nothing(self):
        from orgtree import account_fallback
        with patch.object(account_fallback, 'apply', self._apply), \
                patch.object(supervisor, '_retry_replay',
                             side_effect=RuntimeError('died after the rebind')):
            with self.assertRaises(RuntimeError):
                supervisor.resume_frozen(self.slug, only=['worker'],
                                         account_fallbacks={'worker': {}})
        n = store.load_org(self.slug).node('worker')
        self.assertIsNone(n.get('account'))
        self.assertIn('frozen', n)
        self.assertEqual(self.exported, [])

    def test_a_split_since_the_plan_leaves_the_node_unwritten(self):
        from orgtree import account_fallback
        real_rows = supervisor._resume_rows

        def stale_rows(slug, pick, **kw):
            rows = real_rows(slug, pick, **kw)
            # the plan saw an older generation than the locked row carries
            rows['nodes'] = [x.split('@')[0] + f"@{int(x.split('@')[1]) + 5}"
                             if '@' in x else x for x in rows['nodes']]
            return rows
        with patch.object(supervisor, '_resume_rows', stale_rows), \
                patch.object(account_fallback, 'apply', self._apply):
            got = supervisor.resume_frozen(self.slug, only=['worker'],
                                           account_fallbacks={'worker': {}})
        self.assertEqual(got, [])
        n = store.load_org(self.slug).node('worker')
        self.assertIsNone(n.get('account'))
        self.assertIn('frozen', n)


# ─────────────────────────────────── L2: account removal's exports after the commit

class AccountRemovalExports(unittest.TestCase):
    def test_a_session_boundary_rebind_exports_in_announce(self):
        from orgtree import account_removal
        row = registry.create_account(
            'openai', 'r', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'rm{_N[0]}')})
        slug = _slug('s7remove')
        org = ledger.Org.create(slug)
        org.nodes['root'] = {'state': 'live', 'parent': None, 'generation': 1,
                             'model': 'astra', 'grant': 50, 'free': 50,
                             'session_id': 'sid-0', 'scope': {},
                             'account': row['id'], 'codex_thread': 'thr-1',
                             'codex_account': row['id']}
        store.save_org(org)
        seen = []
        with patch.object(supervisor, 'export_after_commit',
                          lambda s, o, nid, sid, why: seen.append((s, nid, why))), \
                patch.object(supervisor, 'export_predecessor_transcript',
                             side_effect=AssertionError('copied under the locks')), \
                patch.object(supervisor, 'notify'):
            out = account_removal.remove_account_rebinding_agents(row['id'],
                                                                  actor='USER')
            self.assertEqual(seen, [], 'exported before announce')
            self.assertEqual([(s, n) for s, _o, n, _sid in out['exports']],
                             [(slug, 'root')])
            account_removal.announce(out['wakes'], out['rebound'], out['exports'])
        self.assertEqual(seen, [(slug, 'root', 'account_assign')])
        store._POOL.close_all(slug)

if __name__ == '__main__':
    unittest.main()
