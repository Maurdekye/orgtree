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
        # only the first block (L3 converts it) takes DOC_LOCK now: the spend
        # before each dispatch and the finally restore are row transactions
        self.assertEqual(lock.n, 1, f'DOC_LOCK taken {lock.n} times')
        org = store.load_org(self.slug)
        first, second = order
        self.assertNotIn('inflight', org.node(first), 'the dispatched marker was not spent')
        self.assertEqual(org.node(second).get('inflight', {}).get('text'),
                         f'{second} original', 'the undispatched marker was not restored')


if __name__ == '__main__':
    unittest.main()
