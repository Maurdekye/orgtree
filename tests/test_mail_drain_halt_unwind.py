"""fence-off S2, lead condition C4 (halt-during-unwind variant, S9 gate step 4):
with the transition fence OFF, a halt that lands while the mail drain's turn
worker is unwinding never releases a carrier twice and never strands one.

The worker is built as production builds `_run_turn`:
`maildrain.worker(halt.worker(_run_turn))`. It runs with input carrier C1 (its
S11 pending slot) and blocks in its body. A send finds the seat busy and
queues mail-ping carrier C2; C2's mail is committed in the durable box with
its drain demand. Then a halt lands while the worker unwinds — the inner
`halt.worker` exit, then `maildrain.worker`'s release (owner, busy,
`_fold_steer`) and its `wake()`, whose recovery pass the test runs where the
sweeper would.

  ORDER A — the unwind runs INSIDE the halt's first transaction, held at
  `before_commit`: `_capture` has already read every S11 pending slot into
  the transaction, then the worker retires C1's slot before the commit
  (the interleaving pg-supervisor-a asked to pin). C1 must still be durable.
  The recovery pass the unwind triggers is proven (lock manager) to wait on
  the halt's node row.

  ORDER A0 — the same, held at `after_lock`, before the capture runs: the
  turn ends and drops C1's slot first, which is 'the turn ended, then the
  halt', so C1 is spent and only C2 is retained.

  ORDER B — the unwind runs during the halt's SETTLE poll: `halting` has
  committed (C1 and C2 captured), then the body returns and the unwinding
  worker, now gated, captures again.

In both: the halt settles (halted=True); nothing is admitted while halted (the
recovery is refused on the locked `halting` row); every carrier is in the
durable `halt_queue` exactly once by `_halt_id` and in no runtime queue or
slot (not released twice); after unhalt `merge_pending` puts each back in the
runtime queue exactly once, starts nothing, and C2's mail is still waiting in
the durable box, never journaled (not stranded).

Run:  python tools/run-python-verification.py tests/test_mail_drain_halt_unwind.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='mail-drain-halt-unwind-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, maildrain, mailtx, orgtx, store, supervisor as sup, warmpool  # noqa: E402
import racekit  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
NID = 'worker'


def setUpModule():
    global _saved
    _saved = (halt._FENCE, orgtx.TRANSITION_FENCE)
    halt._FENCE = False
    orgtx.TRANSITION_FENCE = False


def tearDownModule():
    halt._FENCE, orgtx.TRANSITION_FENCE = _saved


class HaltDuringUnwind(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:60]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'boss')
        org.hire(ledger.USER, 'boss', 'luna', 0, NID)
        store.save_org(org)
        self.st = sup.state(self.slug, NID)
        self.started = []
        for p in (patch.object(sup, '_native_context_hold', return_value=None),
                  patch.object(sup, '_cancel_working_cache'),
                  patch.object(sup, '_note_working_activity'),
                  patch.object(sup, '_hold_for_deploy', return_value=True),
                  patch.object(sup, 'scan_steer_records'),
                  patch.object(sup, '_phantom_log'),
                  patch.object(sup, 'notify'),
                  patch.object(warmpool, 'kill_node'),
                  patch.object(warmpool, 'poke'),
                  patch.object(sup, '_start_turn_worker',
                               side_effect=lambda s, n, c: self.started.append(c))):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(maildrain._forget, self.slug, NID)
        self.addCleanup(store._POOL.close_all, self.slug)
        self.entered, self.leave = threading.Event(), threading.Event()

        test = self

        # the production stack; the name makes `halt.worker` treat it as a
        # turn worker (it owns an S11 pending slot for its input)
        @maildrain.worker
        @halt.worker
        def _run_turn(slug, nid, carrier):
            with sup._state_lock:
                test.st['busy'] = True
            test.entered.set()
            test.leave.wait(10)          # the turn ends WITHOUT a provider ack
        self.turn = _run_turn

    # -- fixture -------------------------------------------------------------
    def post(self, text):
        """Committed mail and its drain demand, as a send leaves them."""
        with mailtx.org_of(self.slug, **mailtx.send_rows(NID)) as o:
            m = o.post_mail(ledger.USER, NID, text, kind='message')
            maildrain.request(o, NID)
        return m

    def running_worker_with_a_queued_send(self):
        """C1 is the running turn's input; C2 is a send's pointer queued
        behind it. Returns the worker thread and both carriers."""
        c1 = {'text': 'the running turn'}
        th = threading.Thread(target=self.turn, args=(self.slug, NID, c1), daemon=True)
        th.start()
        self.assertTrue(self.entered.wait(5), 'the turn worker never entered its body')
        self.mail = self.post('waiting mail')
        sup.send_message(self.slug, NID, 'mail pointer', mail_ping=True)
        with sup._state_lock:
            queued = list(self.st['queue'])
            slots = list((self.st.get('halt_pending_carriers') or {}).values())
        self.assertEqual(len(queued), 1, f'the send did not queue its pointer: {queued}')
        self.assertEqual(slots, [c1], 'the turn worker does not own C1 in its slot')
        return th, c1, queued[0]

    def runtime_carriers(self):
        with sup._state_lock:
            return (list(self.st.get('queue') or []) + list(self.st.get('steer') or [])
                    + halt.pending_carriers(self.st))

    def check_halted(self, result, expect):
        """`expect`: the carriers that must be durable, exactly once each."""
        self.assertTrue(result.get('halted'), result)
        self.assertEqual(self.started, [], f'admitted while halted: {self.started}')
        org = orgtx.org_read(self.slug)
        held = org.node(NID).get('halt_queue') or []
        ids = [c.get('_halt_id') for c in held]
        self.assertEqual(len(ids), len(set(ids)), f'a carrier is held twice: {held}')
        texts = sorted(c.get('text') for c in held)
        self.assertEqual(texts, sorted(c['text'] for c in expect), held)
        self.assertEqual(self.runtime_carriers(), [],
                         'a captured carrier is still live in the runtime')
        self.assertFalse(self.st.get('busy'), 'the unwind did not release the seat')
        self.assertNotIn('mail_drain_owner', self.st)
        return ids

    def check_unhalted(self, ids):
        r = halt.unhalt(self.slug, NID)
        self.assertTrue(r['unhalted'], r)
        self.assertFalse(r['delivery'].get('started'))
        with sup._state_lock:
            back = [c.get('_halt_id') for c in self.st['queue']]
        self.assertEqual(sorted(back), sorted(ids), 'unhalt did not restore each carrier once')
        self.assertEqual(self.started, [], 'unhalt started a turn')
        org = orgtx.org_read(self.slug)
        box = [m.get('id') for m in (org.d.get('mail') or {}).get(NID) or []]
        self.assertIn(self.mail['id'], box, "C2's mail left the durable box")
        journal = [m.get('id') for b in (org.d.get('delivering') or {}).get(NID) or []
                   for m in b.get('mail') or []]
        self.assertNotIn(self.mail['id'], journal, "C2's mail was journaled while halted")

    # -- the orders ----------------------------------------------------------
    def _unwind_inside_the_halt(self, point):
        """Hold the halt's first transaction (begin) at `point` on the node
        row, uncommitted; let the turn end so the whole unwind runs; run the
        recovery its wake() asks for and prove it waits on that row."""
        th, c1, c2 = self.running_worker_with_a_queued_send()
        with racekit.Race(pair='converted') as race:
            h = race.actor('H', halt.halt, self.slug, NID)
            r = race.actor('R', maildrain.recover, self.slug, NID)
            gh = race.hold(h, point)
            race.start(h)
            race.reached(gh)             # the halt holds the node row, uncommitted
            self.leave.set()             # the turn ends: the whole unwind runs now
            th.join(10)
            self.assertFalse(th.is_alive(), 'the unwind waited on the halt')
            with sup._state_lock:
                self.assertEqual(halt.pending_carriers(self.st), [],
                                 'the unwinding worker kept its slot')
            race.start(r)                # the recovery the unwind's wake() asks for
            race.blocked(r)              # ... provably waits on the halt's row
            race.release(gh)
            race.join(h, r)
            race.expect_order(f'H.{point}', 'R.blocked', 'H.after_commit', 'R.after_lock')
        self.assertFalse(r.result, 'the recovery admitted a halted seat')
        maildrain.sweep()
        return h.result, c1, c2

    def test_a_slot_retired_between_the_capture_and_its_commit(self):
        """ORDER A (pg-supervisor-a's S11 case): begin's `_capture` has read
        every pending slot into the transaction; the worker retires C1's slot
        before that transaction commits. C1 must still be durable, once."""
        result, c1, c2 = self._unwind_inside_the_halt('before_commit')
        ids = self.check_halted(result, [c1, c2])
        self.check_unhalted(ids)

    def test_a0_unwind_before_the_capture_runs(self):
        """ORDER A0: the halt holds its row but has not captured yet; the
        turn ends and drops C1's slot first. Linearized as 'the turn ended,
        then the halt', so C1 is spent, not retained; C2 is captured once."""
        result, c1, c2 = self._unwind_inside_the_halt('after_lock')
        ids = self.check_halted(result, [c2])
        self.check_unhalted(ids)

    def test_b_unwind_during_the_settle_poll(self):
        th, c1, c2 = self.running_worker_with_a_queued_send()
        out = []
        hl = threading.Thread(target=lambda: out.append(halt.halt(self.slug, NID)),
                              daemon=True)
        hl.start()
        # `halting` commits and captures both while the worker still runs
        for _ in range(500):
            n = orgtx.org_read(self.slug).node(NID)
            if n.get('halt') and len(n.get('halt_queue') or []) == 2:
                break
            threading.Event().wait(0.01)
        else:
            self.fail('the halt never committed halting with both carriers')
        self.assertTrue(hl.is_alive(), 'the halt settled while the worker still ran')
        self.leave.set()                 # now the worker unwinds, gated
        th.join(10)
        self.assertFalse(th.is_alive(), 'the unwind never finished')
        self.assertFalse(maildrain.recover(self.slug, NID),
                         'the recovery admitted a halted seat')
        hl.join(10)
        self.assertFalse(hl.is_alive(), 'the halt never settled')
        maildrain.sweep()
        ids = self.check_halted(out[0], [c1, c2])
        self.check_unhalted(ids)


if __name__ == '__main__':
    unittest.main()
