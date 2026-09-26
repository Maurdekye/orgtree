"""PG-3c race test RT8 — overlapping reservations — on the shared door
(pgdoor.agent_tx) over PG-0's SeamBackend fake (orgtx), with the REAL
`reservations.execute`.

The race: two live agents acquire the SAME resource at the same moment. All
reservation state is the one `reservations` doc row, and rcdoor declares it
FOR UPDATE, so the second acquire runs only after the first commits and sees
its HELD row.

  * RT8: exactly one HELD row for the resource; the loser is refused with the
    holder named; the store holds exactly one row.
  * The interleaving is PROVEN, not assumed: both acquires are started and
    the second one is observed parked on the `reservations` row lock while
    the first sits in `before_commit`.
  * CONTROL (the `reservations` row declared FOR SHARE instead of FOR
    UPDATE — an acquire that reads the row without the right to write it):
    the write is refused (UnlockedWrite) and NOTHING lands. On org_tx a
    reservation cannot be written without the row lock at all, so the
    lost-update interleaving is not constructible; this control proves the
    guard that makes it so actually fires for this family.

Run:  python tools/run-python-verification.py tests/test_pg3c_reservations_tx.py
"""

import os
from pathlib import Path
import tempfile
import threading
import types
import unittest

root = tempfile.TemporaryDirectory(prefix='v3-pg3c-resv-', ignore_cleanup_errors=True)
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
from orgtree import ledger, orgtx, pgdoor, rcdoor, reservations, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SHA_C, SHA_B = 'a' * 40, 'b' * 40


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    root.cleanup()


def _no_admit(org, body, a):
    return None


def _no_file(org, body, a, rcpt, result):
    return None


class HoldFirstCommit:
    """Pause hook: the FIRST transaction to reach `before_commit` waits there
    until `release` is set, so a test can observe the second one parked on
    the row lock before letting the first commit."""

    def __init__(self) -> None:
        self.first_in = threading.Event()
        self.release = threading.Event()
        self._c = threading.Lock()
        self.count = 0
        # every transaction attempt passes before_lock once: two acquires
        # declared exactly right make exactly two attempts. A declaration
        # that is short a row still ends right — pgdoor widens and re-runs a
        # refused write — so the attempt count is what exposes it.
        self.attempts = 0

    def __call__(self, point, tx) -> None:
        if point == 'before_lock':
            with self._c:
                self.attempts += 1
            return
        if point != 'before_commit':
            return
        with self._c:
            self.count += 1
            first = self.count == 1
        if first:
            self.first_in.set()
            self.release.wait(20)


def acquire(slug: str, actor: str, spec: pgdoor.TxSpec | None = None):
    body = types.SimpleNamespace(org=slug, node=actor, tool='orgtree_reservation', op_key=None)
    a = {'action': 'acquire', 'resource': 'landing:main', 'candidate': SHA_C, 'base': SHA_B}

    def fn(tx):
        org = tx.org
        org._require_live(actor)

        def live(node: str) -> bool:
            try:
                return org.node(node).get('state') == 'live'
            except LedgerError:
                return False

        try:
            return reservations.execute(org.d, actor, a, item_reader=None, node_exists=live)
        except reservations.ReservationError as e:
            raise LedgerError(str(e)) from e

    return pgdoor.agent_tx(body, a, fn, admit=_no_admit, file=_no_file,
                           spec=spec if spec is not None else rcdoor.reservation_rows())


class OverlappingReservations(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        # a converted-vs-converted race runs with PG-0b's transition fence OFF
        # (plan decision 19; racekit refuses it on): with the fence on, every
        # org_tx queues on DOC_LOCK first and never reaches the row locks
        # these tests are about
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
        orgtx.TRANSITION_FENCE = False
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)   # PG-0's orgtx.org_tx, pgdoor's own retry/widen rules
        OverlappingReservations.n += 1
        self.slug = f'pg3cresv{OverlappingReservations.n}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 6, 'boss')
        for name in ('x', 'y'):
            org.hire('boss', 'boss', 'haiku', 0, name, add_dirs=[], tools=TOOLS,
                     org_visibility='self', charter='a test agent')
        store.save_org(org)

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    def _rows(self):
        return store.load_org(self.slug).d.get('reservations') or []

    def test_rt8_two_acquires_one_holder(self) -> None:
        hook = HoldFirstCommit()
        orgtx.set_pause_hook(hook)
        out: dict = {}

        def run(actor: str) -> None:
            try:
                out[actor] = acquire(self.slug, actor)
            except LedgerError as e:
                out[actor] = e

        t1 = threading.Thread(target=run, args=('x',))
        t1.start()
        self.assertTrue(hook.first_in.wait(10), 'the first acquire never reached its commit')
        t2 = threading.Thread(target=run, args=('y',))
        t2.start()
        # PROVE the interleaving: while the first sits in before_commit
        # holding its rows, the second is WAITING in the row-lock table (it
        # is the only other transaction, so any waiter is it) and has not
        # finished
        locks = orgtx.backend().locks
        parked = False
        for _ in range(250):
            with locks._cv:
                parked = bool(locks._waits)
            if parked:
                break
            threading.Event().wait(0.02)
        self.assertTrue(parked, 'the second acquire never waited on a row lock')
        self.assertNotIn('y', out, 'the second acquire finished while the first held the row')
        hook.release.set()
        t1.join(20)
        t2.join(20)
        self.assertFalse(t1.is_alive() or t2.is_alive(), 'an acquire hung')
        self.assertFalse(isinstance(out['x'], BaseException), out)
        self.assertIsInstance(out['y'], LedgerError, out)
        self.assertIn('x', str(out['y']), 'the loser must be told who holds it')
        rows = self._rows()
        held = [r for r in rows if r.get('resource') == 'landing:main' and r.get('state') == 'held']
        self.assertEqual([r['owner'] for r in held], ['x'])
        self.assertEqual(len(rows), 1)
        self.assertEqual(hook.attempts, 2, 'a declaration short of a row needed a widening re-run')

    def test_rt8_control_share_locked_row_cannot_be_written(self) -> None:
        under = pgdoor.TxSpec(share_sections=('reservations', 'work_items'))
        # pgdoor turns a refused write into a widening (the safety net); the
        # control switches that off to prove the guard itself fires
        pgdoor.use_org_tx(orgtx.org_tx, refused=lambda e: None)
        self.addCleanup(pgdoor.use_org_tx, None)
        with self.assertRaises(orgtx.UnlockedWrite):
            acquire(self.slug, 'x', spec=under)
        self.assertEqual(self._rows(), [], 'CONTROL FAILED AS DESIGNED: nothing may land')

    def test_the_512_cap_is_unchanged(self) -> None:
        org = store.load_org(self.slug)
        org.d['reservations'] = [{'id': f'res-old{i}', 'owner': 'x', 'resource': f'r{i}',
                                  'state': 'released'} for i in range(reservations.MAX_RESERVATIONS)]
        store.save_org(org)
        with self.assertRaises(LedgerError) as cm:
            acquire(self.slug, 'y')
        self.assertIn(str(reservations.MAX_RESERVATIONS), str(cm.exception))


if __name__ == '__main__':
    unittest.main()
