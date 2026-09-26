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
from types import SimpleNamespace
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
        self.specs = []
        self._g = threading.Lock()

    def _lock(self, key):
        with self._g:
            return self.locks.setdefault(key, _RW())

    def org_tx(self, slug, *, nodes=(), sections=(), share_nodes=(),
               share_sections=(), logs=()):
        store = self
        self.specs.append((tuple(nodes), tuple(sections), tuple(share_nodes),
                           tuple(share_sections)))
        want = ([(('n', n), False) for n in nodes]
                + [(('n', n), True) for n in share_nodes]
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
                return SimpleNamespace(org=self.org)   # a HANDLE, like orgtx

            def __exit__(self, et, e, tb):
                try:
                    if et is None:
                        # write back ONLY the rows held FOR UPDATE (and the
                        # declared append logs), as a row store does — never
                        # the whole document
                        for n in nodes:
                            if n in self.org.nodes:
                                store.nodes[n] = self.org.nodes[n]
                        for s_ in tuple(sections) + tuple(logs):
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
        pgdoor.use_org_tx(self.fs.org_tx, snapshot=lambda slug: FakeOrg(
            copy.deepcopy(self.fs.d), copy.deepcopy(self.fs.nodes)))
        self._saved_locks = dict(pgdoor.LOCKS)
        pgdoor.LOCKS.clear()
        pgdoor.declare('orgtree_hire', pgdoor.TxSpec(nodes=(P,)))
        self.ran = 0

    def tearDown(self):
        pgdoor.use_org_tx(None)
        pgdoor.LOCKS.clear()
        pgdoor.LOCKS.update(self._saved_locks)

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
    def test_per_owner_mail_sections_sort_beside_named_sections(self):
        # PG-3d's per-owner mail split: mailtx.send_rows names ("mail", owner)
        # tuples beside plain section names. The door's canonical sort must
        # take both, on the declared spec AND on a widening (was a TypeError,
        # an HTTP 500 on every mail-sending door call).
        pgdoor.declare('orgtree_mailer', pgdoor.TxSpec(
            nodes=(P,), sections=('work_items', ('mail', P)),
            share_sections=(('mail', W), 'kiosk')))
        tries = []

        def fn(tx):
            tries.append(1)
            if len(tries) == 1:
                raise pgdoor.Widen(sections=[('mail', 'x')])
            return self._body_fn(tx)

        self.call(Body(tool='orgtree_mailer'), fn=fn)
        self.assertEqual((len(tries), self.ran, self.n()), (2, 1, 1))
        first, last = self.fs.specs[0], self.fs.specs[-1]
        self.assertIn(('mail', P), first[1])
        self.assertIn('work_items', first[1])
        self.assertEqual(set(first[3]) & {('mail', W), 'kiosk'},
                         {('mail', W), 'kiosk'})
        self.assertIn(('mail', 'x'), last[1])

    def test_rows_caller_first_killswitch_shared_receipts_when_keyed(self):
        r = pgdoor.agent_spec(Body(op_key='k'), {}, pgdoor.TxSpec(
            nodes=(P, W, P), sections=('tiers',), share_nodes=(W, 'x')))
        self.assertEqual(r.nodes, tuple(sorted((W, P))))   # ascending ids
        self.assertEqual(r.share_sections, ('killswitch',))
        self.assertEqual(r.share_nodes, ('x',))          # W is FOR UPDATE
        self.assertIn(opreceipts.SECTION, r.logs)       # appended, not locked
        self.assertIn(opreceipts.META, r.sections)
        r0 = pgdoor.agent_spec(Body(), {}, pgdoor.TxSpec(sections=('tiers',)))
        self.assertEqual(r0.sections, ('tiers',))
        # a tool that itself holds the killswitch FOR UPDATE keeps that
        r1 = pgdoor.agent_spec(Body(), {}, pgdoor.TxSpec(sections=('killswitch',)))
        self.assertEqual((r1.sections, r1.share_sections), (('killswitch',), ()))
        # the call actually opened org_tx on that set
        self.call(Body(op_key='k'))
        self.assertEqual(self.fs.specs[-1][0], tuple(sorted((W, P))))
        self.assertEqual(self.fs.specs[-1][3], ('killswitch',))

    # --------------------------------------------------- the declarations
    def test_undeclared_tool_is_refused_and_opens_nothing(self):
        with self.assertRaisesRegex(LedgerError, 'no lock declaration'):
            self.call(Body(tool='orgtree_message'))
        self.assertEqual(self.fs.specs, [])
        self.assertTrue(pgdoor.declared('orgtree_hire'))
        self.assertFalse(pgdoor.declared('orgtree_message'))

    def test_redeclare_with_different_spec_is_refused(self):
        pgdoor.declare('orgtree_hire', pgdoor.TxSpec(nodes=(P,)))   # same: fine
        with self.assertRaises(ValueError):
            pgdoor.declare('orgtree_hire', pgdoor.TxSpec(nodes=('other',)))

    def test_callable_spec_reads_the_snapshot(self):
        seen = {}

        def spec(snap, body, a):
            seen['parent_n'] = snap.node(P)['n']
            return pgdoor.TxSpec(nodes=(a['to'],))

        pgdoor.LOCKS['orgtree_hire'] = spec
        pgdoor.agent_tx(Body(), {'to': P}, self._body_fn, admit=_admit, file=_file)
        self.assertEqual(seen, {'parent_n': 0})
        self.assertEqual(self.fs.specs[-1][0], tuple(sorted((W, P))))

    def test_widen_reruns_with_the_extra_rows_and_discards_the_first_run(self):
        runs = []

        def body(tx):
            runs.append(1)
            tx.org.node(W)['n'] += 1
            if 'extra' not in [n for n in self.fs.specs[-1][0]]:
                raise pgdoor.Widen(nodes=['extra'])
            return 'ok'

        self.fs.nodes['extra'] = {'id': 'extra'}
        self.assertEqual(self.call(fn=body), 'ok')
        self.assertEqual(len(runs), 2)
        self.assertEqual(self.n(), 1)                  # first run rolled back
        self.assertEqual(self.fs.specs[-1][0], tuple(sorted((W, P, 'extra'))))
        self.assertEqual(self.fs.commits, 1)

    def test_runaway_widening_is_refused_with_nothing_applied(self):
        k = iter(range(100))

        def body(tx):
            tx.org.node(W)['n'] += 1
            raise pgdoor.Widen(nodes=[f'n{next(k)}'])

        with self.assertRaisesRegex(LedgerError, 'kept growing'):
            self.call(fn=body)
        self.assertEqual((self.n(), self.fs.commits), (0, 0))

    # ------------------------------------------------------------ op_tx
    def test_op_tx_has_no_halt_gate_and_locks_only_declared_rows(self):
        self.fs.nodes[W]['halt'] = True
        self.fs.d['killswitch'] = {'at': 't'}
        pgdoor.declare('unhalt', pgdoor.TxSpec(nodes=(W,)))

        def unhalt(tx):
            tx.org.node(W)['halt'] = False
            self.assertEqual((tx.slug, tx.pre), (SLUG, {'x': 1}))
            return tx.op

        self.assertEqual(pgdoor.op_tx(SLUG, 'unhalt', None, {}, unhalt,
                                      pre={'x': 1}), 'unhalt')
        self.assertFalse(self.fs.nodes[W]['halt'])
        self.assertEqual(self.fs.specs[-1], ((W,), (), (), ()))
        with self.assertRaisesRegex(LedgerError, 'no lock declaration'):
            pgdoor.op_tx(SLUG, 'hire', None, {}, unhalt)

    # ------------------------------------------- op_tx after-commit (S3)
    def _op_with_after(self, fail_first=0, widen_first=False, refuse=False,
                       then_raises=False):
        """An op whose body registers an after-commit callable on EVERY
        attempt; returns (result, calls, order)."""
        class Serial(Exception):
            pass

        pgdoor.use_org_tx(self.fs.org_tx, lambda e: isinstance(e, Serial))
        pgdoor.declare('op_after', pgdoor.TxSpec(nodes=(W,)))
        tries, calls, order = [], [], []

        def body(tx):
            tries.append(1)
            tx.org.node(W)['n'] += 1

            def then(res, _attempt=len(tries)):
                order.append('then')
                calls.append((_attempt, res))
                if then_raises:
                    raise OSError('disk full')
            tx.after.then.append(then)
            if refuse:
                raise LedgerError('refused')
            if len(tries) <= fail_first:
                raise Serial()
            if widen_first and 'extra' not in self.fs.specs[-1][0]:
                raise pgdoor.Widen(nodes=['extra'])
            return {'ok': True, 'attempt': len(tries)}

        self.fs.nodes['extra'] = {'id': 'extra'}
        self._calls = calls
        r = pgdoor.op_tx(SLUG, 'op_after', None, {}, body,
                         on_commit=lambda org: order.append('on_commit'))
        return r, calls, order

    def test_op_tx_after_runs_once_for_the_committed_attempt_after_retries(self):
        r, calls, order = self._op_with_after(fail_first=2)
        self.assertEqual(r['attempt'], 3)
        self.assertEqual(calls, [(3, r)])       # only the committed attempt's
        self.assertEqual(order, ['then', 'on_commit'])
        self.assertEqual(self.n(), 1)

    def test_op_tx_after_runs_once_after_a_widened_rerun(self):
        r, calls, _ = self._op_with_after(widen_first=True)
        self.assertEqual(calls, [(2, r)])
        self.assertEqual(self.fs.commits, 1)

    def test_op_tx_after_never_runs_on_a_rollback(self):
        with self.assertRaisesRegex(LedgerError, 'refused'):
            self._op_with_after(refuse=True)
        self.assertEqual(self._calls, [])
        self.assertEqual(self.fs.commits, 0)
        self.assertEqual(self.n(), 0)

    def test_op_tx_after_failure_is_a_warning_and_the_op_stands(self):
        r, calls, order = self._op_with_after(then_raises=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.fs.commits, 1)
        self.assertEqual([w['step'] for w in r.get('warnings') or []],
                         ['then:then'])
        self.assertEqual(order, ['then', 'on_commit'])

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
            with self.fs.org_tx(SLUG, nodes=[W]) as h:
                org = h.org
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

        errs = []

        def tool(n):
            # record, never print: a thread traceback interleaves with the
            # runner's summary and can hide which test failed
            try:
                self.call(Body(node=n), fn=slow, spec=pgdoor.TxSpec())
            except Exception as e:
                errs.append(e)

        ts = [threading.Thread(target=tool, args=(n,)) for n in (W, P)]
        for t in ts:
            t.start()
        try:
            inside.wait()                # BOTH tools are inside at once
        except threading.BrokenBarrierError:
            release.set()
            for t in ts:
                t.join(5)
            self.fail(f'the two tools never overlapped: they queued on a '
                      f'shared row (tool errors: {errs!r})')
        latched = {}

        def latch():
            with self.fs.org_tx(SLUG, sections=['killswitch']) as h:
                org = h.org
                latched['x_seen'] = org.node(W)['n'] + org.node(P)['n']
                org.d['killswitch'] = {'at': 't'}

        lt = threading.Thread(target=latch)
        lt.start()
        self.assertTrue(self.fs.wait_parked(('s', 'killswitch')))
        release.set()
        for t in ts + [lt]:
            t.join(5)
        self.assertEqual(errs, [])
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
        commits = self.fs.commits
        after = pgdoor.After()
        after.drive.append('stale')           # must not survive the replay
        r = self.call(Body(op_key='k1'), after=after)
        self.assertTrue(r['replayed'])
        self.assertEqual((self.ran, self.n()), (1, 1))
        self.assertEqual(self.fs.commits, commits)   # rolled back, NOT saved
        self.assertTrue(after.replayed)
        self.assertEqual(after.drive, [])

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
