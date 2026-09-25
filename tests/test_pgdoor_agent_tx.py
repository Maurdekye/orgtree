"""pgdoor.agent_tx — the shared agent-tool prologue on a row transaction.

Runs against an in-memory FAKE `org_tx` that takes real per-row locks
(FOR UPDATE = exclusive, FOR SHARE = shared), loads the rows only AFTER it
holds them, and commits all changed rows at once on a clean exit or discards
them on an exception — the contract PG-0's `pgstore.org_tx` publishes. No
PostgreSQL, no data root touched beyond the throwaway one.

What each test guards (the mutation harness in the author's scratch,
`pgdoor-mutants.py`, removes one guarantee at a time and shows the named test
fails):
  · test_halt_committed_while_waiting_refuses  — halt checked ON the locked row
  · test_receipt_failure_rolls_back_the_effect — receipt filed in the SAME tx
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix='pgdoor-agent-tx-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from orgtree import opreceipts, pgdoor  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

SLUG = 'o'
W, P = 'worker', 'parent'


class _RW:
    """A reader-writer lock: many FOR SHARE holders, or one FOR UPDATE."""

    def __init__(self):
        self._c = threading.Condition()
        self._readers = 0
        self._writer = False

    def acquire(self, share):
        with self._c:
            if share:
                self._c.wait_for(lambda: not self._writer)
                self._readers += 1
            else:
                self._c.wait_for(lambda: not self._writer and not self._readers)
                self._writer = True

    def release(self, share):
        with self._c:
            if share:
                self._readers -= 1
            else:
                self._writer = False
            self._c.notify_all()


class FakeOrg:
    def __init__(self, d, nodes):
        self.d, self.nodes = d, nodes

    def node(self, nid):
        if nid not in self.nodes:
            raise LedgerError(f'no such node {nid}')
        return self.nodes[nid]


class FakeStore:
    """The committed state plus row locks. `waiting` holds every lock
    request not yet granted, so a test can wait until a thread is PARKED on a
    row rather than sleeping and hoping."""

    def __init__(self, d, nodes):
        self.d, self.nodes = d, nodes
        self.locks = {}
        self.commits = 0
        self.waiting = []
        self._g = threading.Lock()

    def _lock(self, key):
        with self._g:
            return self.locks.setdefault(key, _RW())

    def org_tx(self, slug, *, nodes=(), sections=(), share_sections=(), logs=()):
        store = self
        want = ([(('n', n), False) for n in nodes]
                + [(('s', s), True) for s in share_sections]
                + [(('s', s), False) for s in sections])

        class _Tx:
            def __enter__(self):
                self.held = []
                for key, share in want:
                    lk = store._lock(key)
                    store.waiting.append(key)
                    lk.acquire(share)
                    store.waiting.remove(key)
                    self.held.append((lk, share))
                # load AFTER the locks, like SELECT ... FOR UPDATE
                self.org = FakeOrg(copy.deepcopy(store.d),
                                   copy.deepcopy(store.nodes))
                return self.org

            def __exit__(self, et, e, tb):
                try:
                    if et is None:
                        # write back ONLY the rows held FOR UPDATE, as a row
                        # store does — never the whole document
                        for n in nodes:
                            if n in self.org.nodes:
                                store.nodes[n] = self.org.nodes[n]
                        for s_ in sections:
                            if s_ in self.org.d:
                                store.d[s_] = self.org.d[s_]
                        store.commits += 1
                finally:
                    for lk, share in reversed(self.held):
                        lk.release(share)
                return False

        return _Tx()

    def wait_parked(self, key, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if key in self.waiting:
                return True
            time.sleep(0.005)
        return False


class Body:
    def __init__(self, node=W, tool='orgtree_hire', op_key=None):
        self.org, self.node, self.tool, self.op_key = SLUG, node, tool, op_key


def _admit(org, body, a):
    if not body.op_key:
        return None
    for r in org.d.get(opreceipts.SECTION, []):
        if r['key'] == body.op_key:
            return {'replay': {'replayed': True, 'receipt': r}}
    return {'gen': 1}


def _file(org, body, a, ctx, result):
    org.d.setdefault(opreceipts.SECTION, []).append(
        {'key': body.op_key, 'result': result})


class AgentTxTest(unittest.TestCase):
    def setUp(self):
        self.fs = FakeStore({}, {W: {'id': W, 'n': 0}, P: {'id': P, 'n': 0}})
        pgdoor.use_org_tx(self.fs.org_tx)
        self.ran = 0

    def tearDown(self):
        pgdoor.use_org_tx(None)

    def _body_fn(self, tx):
        self.ran += 1
        tx.org.node(tx.node)['n'] += 1
        return {'ok': True}

    def n(self, nid=W):
        return self.fs.nodes[nid]['n']

    def call(self, body=None, **kw):
        kw.setdefault('admit', _admit)
        kw.setdefault('file', _file)
        return pgdoor.agent_tx(body or Body(), {}, kw.pop('fn', self._body_fn), **kw)

    # ---------------------------------------------------------------- rows
    def test_rows_caller_first_killswitch_shared_receipts_when_keyed(self):
        r = pgdoor.rows(Body(op_key='k'), {}, nodes=[P, W, P], sections=['tiers', 'killswitch'])
        self.assertEqual(r['nodes'], [W, P])
        self.assertEqual(r['share_sections'], ['killswitch'])
        self.assertNotIn('killswitch', r['sections'])
        self.assertIn(opreceipts.SECTION, r['sections'])
        self.assertIn(opreceipts.META, r['sections'])
        r0 = pgdoor.rows(Body(), {}, sections=['tiers'])
        self.assertEqual(r0['sections'], ['tiers'])

    # ------------------------------------------------------- the halt rule
    def test_halted_refuses_and_runs_nothing(self):
        self.fs.nodes[W]['halt'] = True
        with self.assertRaisesRegex(LedgerError, 'halted'):
            self.call()
        self.assertEqual((self.ran, self.n(), self.fs.commits), (0, 0, 0))

    def test_killswitch_refuses_and_runs_nothing(self):
        self.fs.d['killswitch'] = {'at': 't', 'by': 'user'}
        with self.assertRaisesRegex(LedgerError, 'killswitch'):
            self.call()
        self.assertEqual((self.ran, self.n()), (0, 0))

    def test_halt_committed_while_waiting_refuses(self):
        """A halter holds the worker's row FOR UPDATE; the tool call parks on
        it; the halter commits `halt`. The tool must be REFUSED — a check made
        before the lock would have seen no halt and applied the tool after
        the halt committed."""
        entered, go = threading.Event(), threading.Event()
        out = {}

        def halter():
            with self.fs.org_tx(SLUG, nodes=[W]) as org:
                entered.set()
                go.wait(5)
                org.node(W)['halt'] = True

        def tool():
            try:
                out['r'] = self.call()
            except LedgerError as e:
                out['e'] = str(e)

        h = threading.Thread(target=halter)
        h.start()
        self.assertTrue(entered.wait(5))
        t = threading.Thread(target=tool)
        t.start()
        self.assertTrue(self.fs.wait_parked(('n', W)), 'tool never parked on the row')
        go.set()
        h.join(5)
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertIn('halted', out.get('e', ''), out)
        self.assertEqual((self.ran, self.n()), (0, 0))
        self.assertEqual(self.fs.commits, 1)        # the halter's, only

    def test_latch_waits_for_inflight_tool_but_tools_share(self):
        """Tools hold the killswitch FOR SHARE: two tools overlap, and a latch
        (FOR UPDATE) parks until both are done."""
        inside = threading.Barrier(3, timeout=5)
        release = threading.Event()

        def slow(tx):
            inside.wait()
            release.wait(5)
            return self._body_fn(tx)

        ts = [threading.Thread(target=lambda n=n: self.call(Body(node=n), fn=slow))
              for n in (W, P)]
        for t in ts:
            t.start()
        inside.wait()                    # BOTH tools are inside at once
        latched = {}

        def latch():
            with self.fs.org_tx(SLUG, sections=['killswitch']) as org:
                latched['x_seen'] = org.node(W)['n'] + org.node(P)['n']
                org.d['killswitch'] = {'at': 't'}

        lt = threading.Thread(target=latch)
        lt.start()
        self.assertTrue(self.fs.wait_parked(('s', 'killswitch')))
        release.set()
        for t in ts + [lt]:
            t.join(5)
        self.assertEqual(latched['x_seen'], 2)       # latch ran after both
        with self.assertRaisesRegex(LedgerError, 'killswitch'):
            self.call()

    # ------------------------------------------------------- the receipts
    def test_keyed_call_commits_effect_and_receipt_together(self):
        r = self.call(Body(op_key='k1'))
        self.assertEqual(r, {'ok': True})
        self.assertEqual(self.n(), 1)
        self.assertEqual([x['key'] for x in self.fs.d[opreceipts.SECTION]], ['k1'])
        self.assertEqual(self.fs.commits, 1)

    def test_replay_returns_receipt_and_runs_nothing(self):
        self.call(Body(op_key='k1'))
        r = self.call(Body(op_key='k1'))
        self.assertTrue(r['replayed'])
        self.assertEqual((self.ran, self.n()), (1, 1))

    def test_receipt_failure_rolls_back_the_effect(self):
        """If filing the receipt fails, the effect must not commit: one
        transaction, both or neither. A receipt filed in a separate, later
        transaction leaves an applied effect with no receipt."""
        def bad_file(*_a):
            raise LedgerError('receipt write failed')

        with self.assertRaisesRegex(LedgerError, 'receipt write failed'):
            self.call(Body(op_key='k1'), file=bad_file)
        self.assertEqual(self.n(), 0)
        self.assertNotIn(opreceipts.SECTION, self.fs.d)
        self.assertEqual(self.fs.commits, 0)

    def test_body_refusal_rolls_back(self):
        def refuse(tx):
            tx.org.node(W)['n'] = 99
            raise LedgerError('nope')

        with self.assertRaisesRegex(LedgerError, 'nope'):
            self.call(Body(op_key='k1'), fn=refuse)
        self.assertEqual(self.n(), 0)
        self.assertNotIn(opreceipts.SECTION, self.fs.d)

    # ------------------------------------------------------------- retry
    def test_retryable_failure_reruns_and_commit_hook_runs_once(self):
        class Serial(Exception):
            pass

        pgdoor.use_org_tx(self.fs.org_tx, lambda e: isinstance(e, Serial))
        tries, hooks = [], []

        def flaky(tx):
            tries.append(1)
            tx.org.node(W)['n'] += 1
            if len(tries) < 3:
                raise Serial()
            return 'done'

        r = self.call(Body(op_key='k1'), fn=flaky,
                      on_commit=lambda org, rc: hooks.append(rc))
        self.assertEqual(r, 'done')
        self.assertEqual(len(tries), 3)
        self.assertEqual(self.n(), 1)          # only the winning attempt
        self.assertEqual(len(hooks), 1)
        self.assertIsNotNone(hooks[0])

    def test_non_retryable_is_not_rerun(self):
        tries = []

        def boom(tx):
            tries.append(1)
            raise RuntimeError('x')

        with self.assertRaises(RuntimeError):
            self.call(fn=boom)
        self.assertEqual(len(tries), 1)


if __name__ == '__main__':
    unittest.main()
