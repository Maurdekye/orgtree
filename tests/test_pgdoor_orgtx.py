"""pgdoor over PG-0's REAL org_tx (SeamBackend: in-process row locks over the
SQLite seam, a throwaway data root). The fake-backed suite
(test_pgdoor_agent_tx.py) proves the door's own logic; this one proves it
against the primitive every family will actually run on:

  · the handle: bodies get `tx.org`, and the commit bumps the org revision;
  · a write to a row the spec did not lock is refused by PG-0 at commit
    (UnlockedWrite) and the door widens and re-runs — the refused attempt
    commits NOTHING and the effect lands exactly once;
  · the halt rule on real row locks: a tool call parked on the caller's row
    while a halter holds it is refused once the halter commits `halt`
    (the wait is PROVEN from the lock manager, not slept for);
  · join: a writer inside a door body uses the open transaction, and asking
    for a row the door does not hold widens instead of nesting.
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix='pgdoor-orgtx-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from orgtree import ledger, orgtx, pgdoor, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


class Body:
    def __init__(self, slug, node, tool='orgtree_pgdoor_test', op_key=None):
        self.org, self.node, self.tool, self.op_key = slug, node, tool, op_key


def _admit(org, body, a):
    return None


def _file(*_a):
    raise AssertionError('no receipt rides these calls')


class DoorOnOrgTx(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'door{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('boss', 'boss', 'luna', 0, 'other', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)                  # PG-0's real org_tx
        self._locks = dict(pgdoor.LOCKS)

    def tearDown(self):
        pgdoor.LOCKS.clear()
        pgdoor.LOCKS.update(self._locks)
        store._POOL.close_all(self.slug)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def call(self, fn, spec, node='worker'):
        return pgdoor.agent_tx(Body(self.slug, node), {}, fn, admit=_admit,
                               file=_file, spec=spec)

    def test_body_gets_the_org_and_the_commit_bumps_the_revision(self):
        r0 = self.rev()

        def body(tx):
            tx.org.node('worker')['charter'] = 'changed'
            return 'ok'

        self.assertEqual(self.call(body, pgdoor.TxSpec()), 'ok')
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'],
                         'changed')
        self.assertEqual(self.rev(), r0 + 1)

    def test_unlocked_write_widens_and_the_effect_lands_once(self):
        runs, r0 = [], self.rev()

        def body(tx):
            runs.append(tx.spec.nodes)
            tx.org.node('other')['charter'] = tx.org.node('other')['charter'] + '+'
            return 'ok'

        self.assertEqual(self.call(body, pgdoor.TxSpec()), 'ok')
        self.assertEqual(len(runs), 2, runs)             # refused, then widened
        self.assertNotIn('other', runs[0])
        self.assertIn('other', runs[1])
        self.assertEqual(store.load_org(self.slug).node('other')['charter'], 'c+')
        self.assertEqual(self.rev(), r0 + 1)             # ONE commit

    def test_refusal_of_a_row_already_held_is_not_retried(self):
        with self.assertRaises(LedgerError):
            self.call(lambda tx: (_ for _ in ()).throw(pgdoor.Widen(nodes=['worker'])),
                      pgdoor.TxSpec())

    def test_halt_committed_while_the_tool_is_parked_refuses_it(self):
        entered, go, out, ran = threading.Event(), threading.Event(), {}, []

        def halter():
            with orgtx.org_tx(self.slug, nodes=['worker']) as h:
                entered.set()
                go.wait(10)
                h.org.node('worker')['halt'] = {'phase': 'halting'}

        def tool():
            try:
                out['r'] = self.call(lambda tx: ran.append(1), pgdoor.TxSpec())
            except LedgerError as e:
                out['e'] = str(e)

        th = threading.Thread(target=halter)
        th.start()
        self.assertTrue(entered.wait(10))
        tt = threading.Thread(target=tool)
        tt.start()
        locks = orgtx.backend().locks
        end = time.monotonic() + 10
        while time.monotonic() < end and not locks._waits:
            time.sleep(0.005)
        self.assertTrue(locks._waits, 'the tool never parked on a row lock')
        go.set()
        th.join(10)
        tt.join(10)
        self.assertIn('halted', out.get('e', ''), out)
        self.assertEqual(ran, [])
        self.assertTrue(store.load_org(self.slug).node('worker').get('halt'))

    def test_join_uses_the_open_tx_and_widens_for_a_missing_row(self):
        runs = []

        def writer(slug):
            # a lifecycle writer that does not know it is inside a door
            with pgdoor.join(slug, nodes=['other']) as h:
                h.org.node('other')['charter'] = 'joined'

        def body(tx):
            runs.append(tx.spec.nodes)
            self.assertIs(pgdoor.current(self.slug), tx.tx)
            writer(self.slug)
            return 'ok'

        self.assertEqual(self.call(body, pgdoor.TxSpec()), 'ok')
        self.assertEqual(len(runs), 2)                   # widened by join
        self.assertEqual(store.load_org(self.slug).node('other')['charter'],
                         'joined')
        self.assertIsNone(pgdoor.current(self.slug))

    def test_join_widens_for_a_decision_read_it_does_not_hold(self):
        """A read-for-decision is never refused at commit (PG-0 lets unlocked
        rows be READ), so only join's own coverage check can get it locked."""
        runs = []

        def body(tx):
            runs.append(tx.spec.share_nodes)
            with pgdoor.join(self.slug, share_nodes=['other']) as h:
                return h.org.node('other')['state']

        self.assertEqual(self.call(body, pgdoor.TxSpec()), 'live')
        self.assertEqual(len(runs), 2)
        self.assertIn('other', runs[1])

    def test_nesting_is_refused_rather_than_deadlocking(self):
        def body(tx):
            pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)

        with self.assertRaisesRegex(LedgerError, 'already open'):
            self.call(body, pgdoor.TxSpec())

    def test_join_uses_an_org_tx_opened_outside_the_door(self):
        """WS3b: a writer called inside a halt.txn (any org_tx this thread
        opened) joins it; a row outside it is refused by org_tx itself."""
        with self.assertRaises(LedgerError):
            with pgdoor.join(self.slug):
                pass                            # nothing open: nothing to join
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['worker']) as h:
                self.assertIs(pgdoor.current(self.slug), h)
                with pgdoor.join(self.slug) as j:
                    self.assertIs(j, h)
                    j.org.node('worker')['charter'] = 'joined'
                    j.org.node('boss')['charter'] = 'not held'
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'], 'c')
        with orgtx.org_tx(self.slug, nodes=['worker']) as h:
            with pgdoor.join(self.slug) as j:
                j.org.node('worker')['charter'] = 'joined'
        self.assertEqual(store.load_org(self.slug).node('worker')['charter'],
                         'joined')
        self.assertIsNone(pgdoor.current(self.slug))


if __name__ == '__main__':
    unittest.main()
