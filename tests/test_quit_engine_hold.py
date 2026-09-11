"""The engine half of `stop-the-engine-when-orgtree-quits`.

Two facts, both measured on 2026-09-11 from a live machine whose desktop was
ATTACHED to a boot-host engine:

  1. `desktop_maintenance._acknowledge` clears `supervisor._deploy_done` so
     nothing starts a turn into the restart it has just authorised, and the
     only thing that normally releases that hold is the restart KILLING THIS
     PROCESS. When the native side restarts something other than this engine
     it reports no failure, so nothing releases it at all.
  2. Every turn that starts afterwards parks in `_hold_for_deploy` with
     `busy` set and no turn activity — which the desk draws as "starting…" —
     and the pause button could not touch it, because a parked turn has no
     provider process, no codex/antigravity turn and no admission wait.

Every leg here carries its own positive control: an assertion that the hold
was really taken, or that the harness can really see a turn start.
"""
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v2-quit-hold-', ignore_cleanup_errors=True)
_data = Path(_temp.name) / 'data'
_home = Path(_temp.name) / 'home'
_data.mkdir(); _home.mkdir()
# ⚠ BEFORE the first import of anything that reaches `store`: DATA_ROOT binds
# at import time, and an unset ORGTREE_DATA binds the operator's live root.
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='quit-hold-test')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine import launch                                       # noqa: E402
launch.load_app()
from orgtree import ledger, store, supervisor                   # noqa: E402
from orgtree import desktop_maintenance as maintenance          # noqa: E402

_canon = lambda p: os.path.normcase(os.path.realpath(str(p)))
assert _canon(store.DATA_ROOT) == _canon(_data), (store.DATA_ROOT, _data)


def tearDownModule():
    store._POOL.close_all('quit-hold')
    _temp.cleanup()


def _settle_everything():
    supervisor._force_hold_settle(maintenance._accepted_hold, release=True)
    maintenance._accepted_hold = None
    supervisor._deploy_done.set()
    # The request RECORD too: a leg that leaves one 'acknowledged' would make
    # every later `request` return already_armed and every later acknowledge
    # refuse, which reads as a broken fix rather than a dirty fixture.
    maintenance._path().unlink(missing_ok=True)
    with supervisor._state_lock:
        supervisor._state.clear()


class MaintenanceHoldExpiryTests(unittest.TestCase):
    def setUp(self):
        _settle_everything()
        self.addCleanup(_settle_everything)

    def _acknowledged(self, window):
        record = maintenance.request('quit-fixture', 'node')['maintenance']
        with patch.object(maintenance, 'MAINTENANCE_HOLD_MAX_S', window):
            self.assertTrue(maintenance.acknowledge(record['id'])['accepted'])
        # POSITIVE CONTROL for every assertion below: the hold really was
        # taken, so an expiry that never fired would be visible as a machine
        # still held, not as a test that passes either way.
        self.assertFalse(supervisor._deploy_done.is_set(),
                         'acknowledging must hold the machine in the first place')
        return record

    def test_an_acknowledged_restart_that_never_restarts_us_releases_the_machine(self):
        record = self._acknowledged(0.4)
        deadline = time.monotonic() + 10
        while not supervisor._deploy_done.is_set() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(supervisor._deploy_done.is_set(),
                        'a restart that never came must not hold turns for ever')
        self.assertEqual(maintenance.status()['state'], 'failed')
        self.assertEqual(maintenance.status()['id'], record['id'])
        self.assertIsNone(maintenance._accepted_hold)

    def test_the_hold_stands_while_its_window_is_open(self):
        # The inverse control: without this, an expiry that released
        # IMMEDIATELY — i.e. one that never held anything at all — would pass
        # the test above.
        self._acknowledged(60.0)
        time.sleep(0.6)
        self.assertFalse(supervisor._deploy_done.is_set(),
                         'the hold must survive its own window')
        self.assertEqual(maintenance.status()['state'], 'acknowledged')

    def test_a_reported_native_failure_settles_the_hold_and_no_later_one(self):
        first = self._acknowledged(0.4)
        self.assertTrue(maintenance.execution_failed(first['id'])['released'])
        self.assertTrue(supervisor._deploy_done.is_set())
        self.assertIsNone(maintenance._accepted_hold)
        # ⚠ THE WINDOWS ARE THE POINT: the first request's expiry is about to
        # fire while a SECOND request holds the machine on a window of its
        # own. An expiry that settled "whatever hold is open" instead of the
        # one it took would readmit turns into a restart that is still coming,
        # and nothing else in this file would notice.
        second = maintenance.request('quit-fixture', 'node')['maintenance']
        with patch.object(maintenance, 'MAINTENANCE_HOLD_MAX_S', 60.0):
            self.assertTrue(maintenance.acknowledge(second['id'])['accepted'])
        self.assertFalse(supervisor._deploy_done.is_set(),
                         'positive control: the second request really holds the machine')
        time.sleep(1.5)                     # well past the first window
        self.assertFalse(supervisor._deploy_done.is_set(),
                         'a spent expiry must never settle a newer hold')
        self.assertIsNotNone(maintenance._accepted_hold)
        self.assertEqual(maintenance.status()['state'], 'acknowledged')
        self.assertEqual(maintenance.status()['id'], second['id'])


class HeldTurnInterruptTests(unittest.TestCase):
    def setUp(self):
        _settle_everything()
        self.addCleanup(_settle_everything)

    def _park(self, slug='held-org', nid='worker'):
        """Start a real `_hold_for_deploy` park and wait until it is parked."""
        supervisor._deploy_done.clear()
        out = []
        thread = threading.Thread(
            target=lambda: out.append(supervisor._hold_for_deploy(slug, nid)),
            daemon=True)
        thread.start()
        st = supervisor.state(slug, nid)
        deadline = time.monotonic() + 5
        while not st.get('deploy_hold_waiting') and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(st.get('deploy_hold_waiting'),
                        'the turn must actually be parked before it is interrupted')
        return thread, out, st

    def test_a_turn_held_for_a_restart_can_be_interrupted(self):
        thread, out, st = self._park()
        answer = supervisor.interrupt_turn('held-org', 'worker')
        self.assertTrue(answer.get('interrupted'), answer)
        self.assertIn('restart', str(answer.get('reason')))
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(out, [False], 'the park must report that it was cancelled')
        self.assertFalse(st.get('deploy_hold_waiting'))
        self.assertNotIn('deploy_hold_cancel', st)

    def test_a_park_nobody_interrupts_still_ends_when_the_deploy_does(self):
        # Positive control for the leg above: the same park, released the
        # ordinary way, reports True — so "False" there means cancelled and
        # not merely "this function returns False".
        thread, out, st = self._park(nid='patient')
        supervisor._deploy_done.set()
        thread.join(timeout=5)
        self.assertEqual(out, [True])
        self.assertFalse(st.get('deploy_hold_waiting'))

    def test_an_interrupt_landing_as_the_deploy_releases_still_stops_the_turn(self):
        """THE FORCED BOUNDARY (coordinator review). The ⏸ lands in the same
        instant the deploy releases — after the park's own cancel check, as
        it is about to proceed. Before `_retire_deploy_hold` read and cleared
        under one lock, the park returned True and ran the turn while
        `interrupt_turn` had already told the user it was stopped."""
        slug, nid = 'held-org', 'boundary'
        supervisor._deploy_done.clear()
        answers = []
        real_wait = supervisor._deploy_done.wait

        def release_and_interrupt(timeout=None):
            if not answers:
                answers.append(supervisor.interrupt_turn(slug, nid))
                return True                 # the deploy finished right now
            return real_wait(timeout)

        with patch.object(supervisor._deploy_done, 'wait', release_and_interrupt):
            proceeded = supervisor._hold_for_deploy(slug, nid)
        self.assertTrue(answers and answers[0].get('interrupted'), answers)
        self.assertFalse(proceeded, 'a turn reported interrupted must never then run')

    def test_the_same_boundary_without_an_interrupt_proceeds(self):
        # POSITIVE CONTROL for the leg above: the identical seam, minus the
        # ⏸, proceeds — so "False" there is the cancel and not the seam.
        supervisor._deploy_done.clear()
        seen = []
        with patch.object(supervisor._deploy_done, 'wait',
                          lambda timeout=None: seen.append(1) or True):
            proceeded = supervisor._hold_for_deploy('held-org', 'boundary-ok')
        self.assertTrue(seen, 'the park must actually have waited')
        self.assertTrue(proceeded)

    def test_the_retirement_answers_the_ordering_both_ways(self):
        """`_retire_deploy_hold` is the one place cancelled-vs-proceed is
        decided, and both orderings must agree with what the user was told."""
        st = supervisor.state('held-org', 'ordering')
        token = object()
        with supervisor._state_lock:
            st['deploy_hold_waiting'] = True
            st['deploy_hold_token'] = token
        # ⏸ BEFORE the retirement: it wins, and the flags are left clean.
        self.assertTrue(supervisor.interrupt_turn('held-org', 'ordering')['interrupted'])
        self.assertFalse(supervisor._retire_deploy_hold(st, token))
        self.assertFalse(st.get('deploy_hold_waiting'))
        self.assertNotIn('deploy_hold_cancel', st)
        self.assertNotIn('deploy_hold_token', st)
        # ⏸ AFTER it: there is nothing parked any more, and the answer says so
        # rather than claiming a turn was stopped.
        with supervisor._state_lock:
            st['deploy_hold_waiting'] = True
            st['deploy_hold_token'] = token
        self.assertTrue(supervisor._retire_deploy_hold(st, token))
        answer = supervisor.interrupt_turn('held-org', 'ordering')
        self.assertFalse(answer.get('interrupted'), answer)
        self.assertIn('no provider call is active', str(answer.get('reason')))

    def test_interrupt_still_says_nothing_is_active_when_nothing_is(self):
        # The new branch must not answer for turns it does not own.
        answer = supervisor.interrupt_turn('held-org', 'idle-one')
        self.assertFalse(answer.get('interrupted'))
        self.assertIn('no provider call is active', str(answer.get('reason')))


class HeldTurnAbandonsCleanlyTests(unittest.TestCase):
    """`_run_turn`'s own handling of a cancelled park: the turn never starts,
    nothing is dequeued, and the node stops being busy."""

    def setUp(self):
        _settle_everything()
        self.addCleanup(_settle_everything)

    @classmethod
    def setUpClass(cls):
        # A REAL org and a REAL live node: `_run_turn`'s loop loads the
        # document straight after the park, so a fixture that skipped it
        # would make the positive control below unreachable and the negative
        # one vacuous.
        org = store.create_org('held-org')
        cls.nid = org.hire(ledger.USER, None, 'sonnet', 0, 'abandon')['node']
        cls.other = org.hire(ledger.USER, None, 'sonnet', 0, 'ordinary')['node']
        store.save_org(org)

    def _drive(self, slug, nid, *, hold):
        started, notes = [], []
        st = supervisor.state(slug, nid)
        with supervisor._state_lock:
            st['busy'] = True
            st['queue'].clear()
        if hold:
            supervisor._deploy_done.clear()
        patches = [
            patch.object(supervisor, '_cancel_working_cache', lambda *a, **k: None),
            patch.object(supervisor, '_note_working_activity', lambda *a, **k: None),
            patch.object(supervisor, '_run_one_turn',
                         lambda *a, **k: started.append(a[2]) or None),
            patch.object(supervisor, 'notify',
                         lambda s, n, kind, *a, **k: notes.append(kind)),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)
        thread = threading.Thread(
            target=supervisor._run_turn, args=(slug, nid, {'text': 'drive me'}),
            daemon=True)
        thread.start()
        return thread, started, notes, st

    def test_an_interrupted_park_never_starts_the_turn_and_frees_the_node(self):
        thread, started, notes, st = self._drive('held-org', self.nid, hold=True)
        deadline = time.monotonic() + 5
        while not st.get('deploy_hold_waiting') and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(st.get('deploy_hold_waiting'), 'the turn must reach the park')
        with supervisor._state_lock:
            st['queue'].append({'text': 'queued behind the park'})
        supervisor.interrupt_turn('held-org', self.nid)
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(started, [], 'no turn may begin after the park is cancelled')
        self.assertFalse(st['busy'], 'the node must stop being busy')
        self.assertEqual(st['queue'], [], 'nothing may chain a turn behind the hold')
        self.assertIn('turn_done', notes)

    def test_the_same_drive_runs_the_turn_when_no_deploy_is_holding(self):
        # POSITIVE CONTROL: proves this harness can see a turn start at all,
        # so the empty `started` above is evidence and not an artefact.
        thread, started, _notes, _st = self._drive('held-org', self.other, hold=False)
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual([c.get('text') for c in started], ['drive me'])


if __name__ == '__main__':
    unittest.main()
