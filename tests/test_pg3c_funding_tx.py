"""PG-3c race test RT1 — the last credit — on the shared door (pgdoor.agent_tx)
over PG-0's SeamBackend fake (orgtx), with the REAL ledger (`Org.reallocate`).

The race: `boss` has free credit for exactly ONE of two spends. Two threads
each reallocate that amount from `boss` to a different child. They write
different child rows, so nothing but the declaration's lock on the PAYER's
row (rcdoor.reallocate_rows: the target's chain up to the actor) makes the
second spend see the first.

  * RT1: exactly one spend commits, the other is refused, and `free(boss)`
    never goes negative.
  * RT1 CONTROL (payer lock removed from the declaration): both spends
    commit and `free(boss)` goes negative — the double-spend the lock
    prevents. The control records that both threads really read the same
    state (both reached `after_lock` together) before it is allowed to count.

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
    """The pause hook: every transaction that reaches `after_lock` (locks
    held, state loaded) waits up to `hold` seconds for a second one to get
    there too. With the payer locked, the second thread is parked on the
    payer row, so nobody meets and the first proceeds after `hold`. Without
    it, both meet — `met` records that the stale-read interleaving really
    happened."""

    def __init__(self, hold: float = 1.5) -> None:
        self.hold = hold
        self.c = threading.Condition()
        self.arrived = 0
        self.met = False

    def __call__(self, point, tx) -> None:
        if point != 'after_lock':
            return
        with self.c:
            self.arrived += 1
            if self.arrived >= 2:
                self.met = True
                self.c.notify_all()
            else:
                self.c.wait_for(lambda: self.arrived >= 2, self.hold)


class LastCredit(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(_seam, lambda e: isinstance(e, orgtx.Retryable),
                          snapshot=lambda s: orgtx.org_read(s))
        LastCredit.n += 1
        self.slug = f'pg3cfund{LastCredit.n}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 4, 'boss')
        for name in ('a', 'b'):
            org.hire('boss', 'boss', 'haiku', 0, name, add_dirs=[], tools=TOOLS,
                     org_visibility='self', charter='a test child')
        store.save_org(org)
        f = store.load_org(self.slug).free('boss')
        self.assertGreaterEqual(f, 1, f'fixture: boss must have a free credit, has {f}')
        # one spend fits, two do not: d <= f < 2d
        self.d = math.floor(f)
        self.assertTrue(self.d <= f < 2 * self.d, (f, self.d))

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    def _spend(self, target: str, spec_fn, out: dict) -> None:
        body = types.SimpleNamespace(org=self.slug, node='boss', tool='orgtree_reallocate',
                                     op_key=None)
        a = {'node': target, 'delta': self.d}

        def fn(tx):
            rcdoor.require(tx.spec, spec_fn(tx.org, 'boss', target))
            return tx.org.reallocate('boss', target, self.d)

        try:
            out[target] = pgdoor.agent_tx(body, a, fn, admit=_no_admit, file=_no_file,
                                          spec=spec_fn(orgtx.org_read(self.slug), 'boss', target))
        except LedgerError as e:
            out[target] = e

    def _race(self, spec_fn) -> tuple[dict, Rendezvous]:
        rv = Rendezvous()
        orgtx.set_pause_hook(rv)
        out: dict = {}
        ts = [threading.Thread(target=self._spend, args=(t, spec_fn, out)) for t in ('a', 'b')]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
        self.assertFalse(any(t.is_alive() for t in ts), 'a spend hung')
        self.assertEqual(rv.arrived, 2, 'both spends must have reached their locks')
        return out, rv

    def test_rt1_one_spend_wins_and_free_never_goes_negative(self) -> None:
        out, rv = self._race(rcdoor.reallocate_rows)
        self.assertFalse(rv.met, 'the second spend read before the first committed: the payer was not locked')
        wins = [k for k, v in out.items() if not isinstance(v, BaseException)]
        losses = [k for k, v in out.items() if isinstance(v, LedgerError)]
        self.assertEqual(len(wins), 1, out)
        self.assertEqual(len(losses), 1, out)
        org = store.load_org(self.slug)
        self.assertGreaterEqual(org.free('boss'), 0)
        self.assertEqual(org.node(wins[0])['grant'], self.d)
        self.assertEqual(org.node(losses[0])['grant'], 0)

    def test_rt1_control_without_the_payer_lock_double_spends(self) -> None:
        def no_payer(org, actor, nid):
            s = rcdoor.reallocate_rows(org, actor, nid)
            no_payer.ran = True
            return pgdoor.TxSpec(nodes=tuple(n for n in s.nodes if n != actor),
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
        self.assertLess(org.free('boss'), 0, 'CONTROL FAILED AS DESIGNED: expected a double-spend')

    def test_reallocate_writes_only_declared_rows(self) -> None:
        # a deep raise bubbles: the declaration must cover every row it writes
        org = store.load_org(self.slug)
        org.hire('a', 'a', 'haiku', 0, 'c', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='grandchild')
        store.save_org(org)
        body = types.SimpleNamespace(org=self.slug, node='boss', tool='orgtree_reallocate',
                                     op_key=None)

        def fn(tx):
            rcdoor.require(tx.spec, rcdoor.reallocate_rows(tx.org, 'boss', 'c'))
            return tx.org.reallocate('boss', 'c', 1)

        r = pgdoor.agent_tx(body, {'node': 'c', 'delta': 1}, fn, admit=_no_admit, file=_no_file,
                            spec=rcdoor.reallocate_rows(orgtx.org_read(self.slug), 'boss', 'c'))
        self.assertEqual(r['grant'], 1)
        org = store.load_org(self.slug)
        self.assertGreaterEqual(org.free('boss'), 0)
        self.assertGreaterEqual(org.free('a'), 0)


if __name__ == '__main__':
    unittest.main()
