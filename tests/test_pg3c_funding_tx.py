"""PG-3c race test RT1 — the last credit — on the shared door (pgdoor.agent_tx)
over PG-0's SeamBackend fake (orgtx), with the REAL ledger (`Org.reallocate`).

The race: `p` has free credit for exactly ONE of two spends (cost bubbling
is off, so only `p` may pay). Two DIFFERENT actors spend it at once:
`boss` raises `c1` (its chain c1 -> p -> boss) and `p` raises `c2` (its own
child). They write different child rows and hold different caller rows, so
nothing but the declaration's lock on the PAYER's row (rcdoor.reallocate_rows:
the target's chain up to the actor) makes the second spend see the first.

  * RT1: exactly one spend commits, the other is refused, and `free(p)` never
    goes negative.
  * RT1 CONTROL (the payer `p` removed from boss's declaration): both spends
    commit and `free(p)` goes negative — the double-spend the lock prevents.
    The control only counts if both transactions had DECIDED before either
    committed (both were inside `before_commit` at once).

Run:  python tools/run-python-verification.py tests/test_pg3c_funding_tx.py
"""

import contextlib
import math
import os
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-pg3c-funding-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from orgtree import ledger, orgtx, pgdoor, rcdoor, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    root.cleanup()


@contextlib.contextmanager
def _seam(slug, **rows):
    with orgtx.org_tx(slug, **rows) as tx:
        yield tx.org


def _no_admit(org, body, a):
    return None


def _no_file(org, body, a, rcpt, result):
    return None


class Rendezvous:
    """The pause hook at `before_commit` (the body has read and decided, and
    nothing is committed yet): a transaction waits up to `hold` seconds for
    another one to be there AT THE SAME TIME. `met` is set only when two are
    inside together, i.e. both decided on the same state. With the payer
    locked the second is parked on the payer row, so they never meet."""

    def __init__(self, hold: float = 1.5) -> None:
        self.hold = hold
        self.c = threading.Condition()
        self.inside = 0
        self.arrived = 0
        self.met = False

    def __call__(self, point, tx) -> None:
        if point != 'before_commit':
            return
        with self.c:
            self.arrived += 1
            self.inside += 1
            if self.inside >= 2:
                self.met = True
                self.c.notify_all()
            else:
                self.c.wait_for(lambda: self.met, self.hold)
            self.inside -= 1


class LastCredit(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(_seam, lambda e: isinstance(e, orgtx.Retryable),
                          snapshot=lambda s: orgtx.org_read(s))
        LastCredit.n += 1
        self.slug = f'pg3cfund{LastCredit.n}'
        org = store.create_org(self.slug)
        org.d['cascade_alloc'] = False
        org.hire(ledger.USER, None, 'haiku', 8, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'p', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='the payer')
        for name in ('c1', 'c2'):
            org.hire('boss', 'p', 'haiku', 0, name, add_dirs=[], tools=TOOLS,
                     org_visibility='self', charter='a test child')
        store.save_org(org)
        org = store.load_org(self.slug)
        f = org.free('p')
        if f < 1:
            org.reallocate('boss', 'p', math.ceil(1 - f))
            store.save_org(org)
            f = store.load_org(self.slug).free('p')
        self.assertGreaterEqual(f, 1, f'fixture: p must have a free credit, has {f}')
        # one spend fits, two do not: d <= f < 2d
        self.d = math.floor(f)
        self.assertTrue(self.d <= f < 2 * self.d, (f, self.d))

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    ACTOR = {'c1': 'boss', 'c2': 'p'}

    def _spend(self, target: str, spec_fn, out: dict) -> None:
        actor = self.ACTOR[target]
        body = types.SimpleNamespace(org=self.slug, node=actor, tool='orgtree_reallocate',
                                     op_key=None)
        a = {'node': target, 'delta': self.d}

        def fn(tx):
            rcdoor.require(tx.spec, spec_fn(tx.org, actor, target))
            return tx.org.reallocate(actor, target, self.d)

        try:
            out[target] = pgdoor.agent_tx(body, a, fn, admit=_no_admit, file=_no_file,
                                          spec=spec_fn(orgtx.org_read(self.slug), actor, target))
        except LedgerError as e:
            out[target] = e

    def _race(self, spec_fn, notices: bool = False) -> tuple[dict, Rendezvous]:
        """`notices=False` takes the org-wide `notices` row out of the race:
        both spends write it (the grant-change notice), so on today's layout
        that one row serialises them by accident and would hide whether the
        PAYER lock does the work. PG-3d splits notices per owner (plan
        decision 15), after which the two spends share no notice row — this
        mode is that layout: the notice is not written and not declared."""
        if not notices:
            inner = spec_fn

            def spec_fn(org, actor, nid, _f=inner):
                s = _f(org, actor, nid)
                return pgdoor.TxSpec(nodes=s.nodes,
                                     sections=tuple(x for x in s.sections if x != 'notices'),
                                     share_nodes=s.share_nodes,
                                     share_sections=s.share_sections, logs=s.logs)
        rv = Rendezvous()
        orgtx.set_pause_hook(rv)
        out: dict = {}
        ts = [threading.Thread(target=self._spend, args=(t, spec_fn, out)) for t in ('c1', 'c2')]
        with contextlib.ExitStack() as st:
            if not notices:
                st.enter_context(patch.object(ledger.Org, '_notify_ev', lambda self, nids, ev: None))
            for t in ts:
                t.start()
            for t in ts:
                t.join(30)
        self.assertFalse(any(t.is_alive() for t in ts), 'a spend hung')
        self.assertGreaterEqual(rv.arrived, 1, 'no spend reached its commit')
        return out, rv

    def test_rt1_one_spend_wins_and_free_never_goes_negative(self) -> None:
        out, rv = self._race(rcdoor.reallocate_rows)
        self.assertFalse(rv.met, 'the second spend read before the first committed: the payer was not locked')
        wins = [k for k, v in out.items() if not isinstance(v, BaseException)]
        losses = [k for k, v in out.items() if isinstance(v, LedgerError)]
        self.assertEqual(len(wins), 1, out)
        self.assertEqual(len(losses), 1, out)
        org = store.load_org(self.slug)
        self.assertGreaterEqual(org.free('p'), 0)
        self.assertEqual(org.node(wins[0])['grant'], self.d)
        self.assertEqual(org.node(losses[0])['grant'], 0)

    def test_rt1_with_the_full_declaration_one_spend_wins(self) -> None:
        # today's layout, notices row included: same outcome
        out, rv = self._race(rcdoor.reallocate_rows, notices=True)
        wins = [k for k, v in out.items() if not isinstance(v, BaseException)]
        self.assertEqual(len(wins), 1, out)
        self.assertGreaterEqual(store.load_org(self.slug).free('p'), 0)

    def test_rt1_control_without_the_payer_lock_double_spends(self) -> None:
        def no_payer(org, actor, nid):
            s = rcdoor.reallocate_rows(org, actor, nid)
            no_payer.ran = True
            return pgdoor.TxSpec(nodes=tuple(n for n in s.nodes if n != 'p' or actor == 'p'),
                                 sections=s.sections, share_nodes=s.share_nodes,
                                 share_sections=s.share_sections, logs=s.logs)

        no_payer.ran = False
        # the body's own re-check must not widen the payer back in
        with patch.object(rcdoor, 'require', lambda held, need: None):
            out, rv = self._race(no_payer)
        self.assertTrue(no_payer.ran, 'the control declaration never ran')
        self.assertTrue(rv.met, 'CONTROL DID NOT INTERLEAVE: both spends must read the same state')
        self.assertFalse(any(isinstance(v, BaseException) for v in out.values()),
                         f'control: both spends commit without the payer lock: {out}')
        org = store.load_org(self.slug)
        self.assertLess(org.free('p'), 0, 'CONTROL FAILED AS DESIGNED: expected a double-spend')

    def test_a_bubbling_raise_writes_only_declared_rows(self) -> None:
        # cascade ON and p already spent: boss's raise of c1 bubbles, writing
        # p's grant too; the declaration must hold every row it writes
        # (org_tx refuses UnlockedWrite otherwise)
        org = store.load_org(self.slug)
        org.d['cascade_alloc'] = True
        org.reallocate('p', 'c2', self.d)
        store.save_org(org)
        body = types.SimpleNamespace(org=self.slug, node='boss', tool='orgtree_reallocate',
                                     op_key=None)

        def fn(tx):
            rcdoor.require(tx.spec, rcdoor.reallocate_rows(tx.org, 'boss', 'c1'))
            return tx.org.reallocate('boss', 'c1', 1)

        before = store.load_org(self.slug).node('p')['grant']
        r = pgdoor.agent_tx(body, {'node': 'c1', 'delta': 1}, fn, admit=_no_admit, file=_no_file,
                            spec=rcdoor.reallocate_rows(orgtx.org_read(self.slug), 'boss', 'c1'))
        self.assertEqual(r['grant'], 1)
        org = store.load_org(self.slug)
        self.assertGreater(org.node('p')['grant'], before, 'the raise must have bubbled through p')
        self.assertGreaterEqual(org.free('p'), 0)
        self.assertGreaterEqual(org.free('boss'), 0)


if __name__ == '__main__':
    unittest.main()
