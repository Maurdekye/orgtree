"""PG-3e-A: the halt points of turn admission and the turn loop, each proven.

Review of 853cbd0 (native-design-review): four halt-ordering claims survived
their mutants in every halt-sensitive module. Each test here fails on one:

  * M1, decision 9: a halt that commits BETWEEN admission's two
    transactions is refused by the second (the drain), before any mail
    leaves the box. The halt is committed from the drain's own row planning,
    which runs after tx1 committed and before tx2 opens.
  * M4, decision 2: `_run_turn`'s per-carrier re-check. A halt that commits
    during one carrier keeps the next carrier (retained whole in the
    halt queue) and never runs it.
  * M5, decision 5: admission holds the killswitch row FOR SHARE. A latch
    (the killswitch row FOR UPDATE) provably WAITS for an admission that is
    inside its transaction (the lock manager's own wait-for table, via
    tests/racekit.py), instead of committing between the admission's gate
    read and its commit.

M3 (the boundary feed's locked re-check) runs against a real provider pipe:
tests/test_claude_pipe_lifecycle.py, test_halt_committed_mid_turn_refuses_the_boundary_feed.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='pg3e-halt-points-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_temp.name, ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1')
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, orgtx, store, supervisor as sup  # noqa: E402
import racekit  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_temp.name).resolve()


class Reached(RuntimeError):
    """Raised by the sentinel just past the drain transaction."""


def commit_halting(slug: str, nid: str) -> None:
    """Commit `halting` on the agent's row the way `halt._halt` does, without
    its kill-and-wait (which would wait on the very worker under test)."""
    with halt.txn(slug, nodes=[nid]) as tx:
        tx.org.node(nid)["halt"] = {"phase": "halting",
                                    "requested_at": ledger.now(),
                                    "by": ledger.USER}


_SEQ = [0]


class _Org(unittest.TestCase):

    def setUp(self):
        _SEQ[0] += 1
        self.slug = f'halt-points-{_SEQ[0]}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 0, 'worker')
        m = org.post_mail(ledger.USER, 'worker', 'hello from the user')
        self.mail_id = str(m['id'])
        store.save_org(org)
        self.reached = 0
        self.patches = [
            patch.object(sup, 'spawn_env', return_value={}),
            patch.object(sup, '_deployment_org_gate'),
            patch.object(sup, '_mail_block', side_effect=self._sentinel),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        store._POOL.close_all(self.slug)

    def _sentinel(self, *a, **kw):
        self.reached += 1
        raise Reached('past the drain transaction')

    def box(self) -> list[str]:
        org = store.load_org(self.slug)
        return [str(m.get('id')) for m in (org.d.get('mail') or {}).get('worker') or []]

    def journal(self) -> list:
        return list((store.load_org(self.slug).d.get('delivering') or {}).get('worker') or [])


class HaltBetweenAdmissionTransactions(_Org):
    """M1: tx2 re-runs the gates on its own locked rows."""

    def run_with_halt_between(self, halt_between: bool) -> int:
        real = sup._admission_rows
        fired = []

        def rows(slug, nid, *, compact=False):
            if not compact:
                # tx1 has committed; tx2 has not opened
                fired.append(True)
                if halt_between:
                    commit_halting(slug, nid)
            return real(slug, nid, compact=compact)
        with patch.object(sup, '_admission_rows', side_effect=rows):
            try:
                sup._run_one_turn_recorded(self.slug, 'worker', 'go')
            except Exception:                                # noqa: BLE001
                pass
        return len(fired)

    def test_control_without_a_halt_the_drain_runs(self):
        self.assertEqual(self.run_with_halt_between(False), 1,
                         'the hook between the transactions never fired')
        self.assertEqual(self.reached, 1, 'the turn never got past the drain')
        self.assertNotIn(self.mail_id, self.box())

    def test_a_halt_committed_between_tx1_and_tx2_refuses_the_drain(self):
        self.assertEqual(self.run_with_halt_between(True), 1,
                         'the hook between the transactions never fired')
        self.assertEqual(self.reached, 0,
                         'the drain ran on an agent whose halt had committed')
        self.assertIn(self.mail_id, self.box(), 'mail left the box of a halted agent')
        self.assertEqual(self.journal(), [])


class HaltBetweenCarriers(_Org):
    """M4: `_run_turn` re-checks the locked row before the next carrier."""

    def run_two_carriers(self, halt_during_first: bool) -> list:
        ran = []

        def one_turn(slug, nid, carrier, **kw):
            ran.append(carrier)
            if len(ran) == 1:
                if halt_during_first:
                    commit_halting(slug, nid)
                return 'second carrier'
            return None
        st = sup.state(self.slug, 'worker')
        st['busy'] = True
        with patch.object(sup, '_run_one_turn', side_effect=one_turn), \
                patch.object(sup, '_cancel_working_cache'), \
                patch.object(sup, '_note_working_activity'), \
                patch.object(sup, '_hold_for_deploy', return_value=True), \
                patch.object(sup, 'notify'):
            sup._run_turn(self.slug, 'worker', 'first carrier')
        return ran

    def test_control_without_a_halt_both_carriers_run(self):
        self.assertEqual(self.run_two_carriers(False),
                         ['first carrier', 'second carrier'])

    def test_a_halt_committed_during_a_carrier_keeps_the_next_one(self):
        self.assertEqual(self.run_two_carriers(True), ['first carrier'],
                         'the next carrier ran on an agent whose halt had committed')
        held = store.load_org(self.slug).node('worker').get('halt_queue') or []
        self.assertIn('second carrier', [c.get('text') for c in held],
                      'the next carrier was not retained for the unhalt')


class KillswitchLatchOrdersAgainstAdmission(_Org):
    """M5: admission holds the killswitch row FOR SHARE, so a latch waits."""

    def setUp(self):
        super().setUp()
        self.fence = orgtx.TRANSITION_FENCE
        # the two racers are converted org_tx paths: with the fence on,
        # DOC_LOCK, not the row locks, would order them (plan decision 19)
        orgtx.TRANSITION_FENCE = False

    def tearDown(self):
        orgtx.TRANSITION_FENCE = self.fence
        super().tearDown()

    def test_a_latch_waits_for_an_admission_inside_its_transaction(self):
        real_gates = sup._admission_gates

        def latch(slug):
            with orgtx.org_tx(slug, sections=[halt.KILLSWITCH]) as tx:
                tx.org.d[halt.KILLSWITCH] = {"by": ledger.USER, "at": ledger.now()}

        with racekit.Race(pair='converted') as race:
            def gates(*a, **kw):
                # inside admission's transaction, its row locks held
                race.mark('gates')
                return real_gates(*a, **kw)
            with patch.object(sup, '_admission_gates', side_effect=gates):
                a = race.actor('A', sup._run_one_turn_recorded, self.slug, 'worker',
                               'go', may_raise=True)
                b = race.actor('B', latch, self.slug)
                held = race.hold(a, 'gates')
                race.start(a)
                race.reached(held)
                race.start(b)
                race.blocked(b)          # the latch waits on admission's lock
                race.release(held)
                race.join(a, b)
        race.expect_order('A.gates', 'B.blocked', 'A.after_commit', 'B.after_lock')


if __name__ == '__main__':
    unittest.main()
