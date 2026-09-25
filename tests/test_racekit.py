"""PG-5: the race harness (tests/racekit.py) on PG-0's in-process fake.

What these prove, over a throwaway SQLite root:
  * it FORCES an order: A holds a node row, B is proven (by the lock
    manager's own wait-for table) to wait on it, and B only takes the row
    after A commits — and no update is lost;
  * a writer of ANOTHER row is not blocked, and finishes first;
  * a forced order can expose a real lost update (an unlocked
    read-modify-write held between its read and its write);
  * it FAILS instead of passing when the forcing did not happen: an
    expected order that was not achieved, a gate that never fired, a
    `blocked()` on an actor that never waits, an actor that raised, an
    actor never started;
  * it refuses to arm without the hook switch or outside a temp data root.

Run:  python tools/run-python-verification.py tests/test_racekit.py
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-racekit-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1',
                  ORGTREE_ORGTX_TEST_HOOKS='1')
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402
import racekit  # noqa: E402


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in ('a', 'b'):
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None,
                               'children': [], 'n': 0}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _n(slug: str, nid: str) -> int:
    return store.load_org(slug).d['nodes'][nid]['n']


class RaceKit(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'rk-{self._testMethodName}')

    def bump(self, nid: str) -> None:
        with orgtx.org_tx(self.slug, nodes=[nid]) as tx:
            tx.d['nodes'][nid]['n'] += 1

    def test_isolation_facts(self) -> None:
        with racekit.Race() as race:
            pass
        self.assertEqual(Path(race.facts['data_root']), data.resolve())
        self.assertEqual(race.facts['backend'], 'sqlite')

    def test_forces_same_row_order_and_loses_nothing(self) -> None:
        with racekit.Race() as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'a')
            ga = race.hold(a, 'after_lock')
            race.start(a)
            race.reached(ga)
            race.start(b)
            how = race.blocked(b)
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.before_lock', 'B.blocked',
                              'A.after_commit', 'B.after_lock', 'B.after_commit')
        self.assertIn('RowLocks', how)
        self.assertEqual(_n(self.slug, 'a'), 2)

    def test_other_row_is_not_blocked(self) -> None:
        with racekit.Race() as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'b')
            ga = race.hold(a, 'after_lock')
            gb = race.hold(b, 'after_commit')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.not_blocked(b, gb)
            race.release(gb)
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.after_commit', 'A.after_commit')
        self.assertEqual((_n(self.slug, 'a'), _n(self.slug, 'b')), (1, 1))

    def test_forced_order_exposes_an_unlocked_lost_update(self) -> None:
        box = {'n': 0}

        def unlocked_bump(race: racekit.Race) -> None:
            seen = box['n']
            race.mark('read')
            box['n'] = seen + 1

        with racekit.Race() as race:
            a = race.actor('A', unlocked_bump, race)
            b = race.actor('B', unlocked_bump, race)
            ga = race.hold(a, 'read')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.join(b)
            race.release(ga)
            race.join(a)
            race.expect_order('A.read', 'B.read', 'B.done', 'A.done')
        self.assertEqual(box['n'], 1, 'the forced order must lose one update')

    # --------------------------------------------- negative controls
    def test_unachieved_order_fails(self) -> None:
        with racekit.Race() as race:
            a = race.actor('A', self.bump, 'a')
            race.start(a)
            race.join(a)
            with self.assertRaises(racekit.RaceFailure):
                race.expect_order('A.after_commit', 'A.after_lock')
            with self.assertRaises(racekit.RaceFailure):
                race.expect_order('A.after_lock#2')

    def test_gate_that_never_fires_fails(self) -> None:
        with self.assertRaisesRegex(racekit.RaceFailure, 'did not fire exactly once'):
            with racekit.Race() as race:
                a = race.actor('A', self.bump, 'a')
                race.hold(a, 'before_commit', nth=2)
                race.start(a)
                race.join(a)

    def test_blocked_on_a_free_row_fails(self) -> None:
        with racekit.Race(wait=0.5) as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'b')
            ga = race.hold(a, 'after_lock')
            gb = race.hold(b, 'after_lock')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.reached(gb)
            with self.assertRaisesRegex(racekit.RaceFailure, 'never seen waiting'):
                race.blocked(b)
            race.release(ga)
            race.release(gb)
            race.join(a, b)

    def test_actor_error_fails_unless_allowed(self) -> None:
        def boom() -> None:
            raise ValueError('boom')
        with racekit.Race() as race:
            a = race.actor('A', boom)
            race.start(a)
            with self.assertRaisesRegex(racekit.RaceFailure, 'boom'):
                race.join(a)
            ok = race.actor('B', boom, may_raise=True)
            race.start(ok)
            race.join(ok)
            self.assertIsInstance(ok.error, ValueError)
            a.may_raise = True       # already reported; let the exit check pass

    def test_unraised_actor_error_fails_at_exit(self) -> None:
        with self.assertRaisesRegex(racekit.RaceFailure, 'raised'):
            with racekit.Race() as race:
                a = race.actor('A', lambda: 1 / 0)
                race.start(a)
                a.thread.join(2)

    def test_actor_never_started_fails(self) -> None:
        with self.assertRaisesRegex(racekit.RaceFailure, 'never started'):
            with racekit.Race() as race:
                race.actor('A', self.bump, 'a')

    def test_refuses_without_hook_switch(self) -> None:
        with patch.dict(os.environ, {'ORGTREE_ORGTX_TEST_HOOKS': ''}):
            with self.assertRaisesRegex(racekit.RaceFailure, 'TEST_HOOKS'):
                racekit.Race().__enter__()

    def test_refuses_a_data_root_outside_temp(self) -> None:
        # outside temp by construction (review f1: a checkout may itself live
        # under %TEMP%), and the temp folder itself
        tmp = Path(tempfile.gettempdir()).resolve()
        for outside in (str(tmp.parent), str(tmp)):
            with patch.object(store, 'DATA_ROOT', outside):
                with self.assertRaisesRegex(racekit.RaceFailure, 'not a throwaway'):
                    racekit.Race().__enter__()

    def test_disposable_pg_refuses_a_non_loopback_server(self) -> None:
        with self.assertRaisesRegex(ValueError, 'loopback'):
            racekit.disposable_pg('postgresql://admin@db.example.com:5432/postgres', 'orgtree_x')

    def test_row_wait_events_are_only_org_tx_lock_waits(self) -> None:
        self.assertEqual(racekit.ROW_WAIT_EVENTS, {'advisory', 'transactionid', 'tuple'})

    def test_refuses_an_undeclared_postgres(self) -> None:
        with patch.object(store, 'STORE_BACKEND', 'postgres'), \
             patch.dict(os.environ, {'ORGTREE_PG_URL': 'postgresql://x@127.0.0.1/live'}):
            with self.assertRaisesRegex(racekit.RaceFailure, 'disposable_pg'):
                racekit.Race().__enter__()

    def test_refuses_a_conninfo_that_would_bypass_the_url(self) -> None:
        with patch.object(store, 'STORE_BACKEND', 'postgres'),              patch.dict(os.environ, {'ORGTREE_PG_CONNINFO': 'host=127.0.0.1 dbname=live'}):
            with self.assertRaisesRegex(racekit.RaceFailure, 'CONNINFO'):
                racekit.Race().__enter__()

    def test_fence_state_is_recorded(self) -> None:
        with racekit.Race(pair='converted') as race:
            pass
        self.assertIn(race.facts['transition_fence'], ('absent', 'off'))
        self.assertEqual(race.facts['pair'], 'converted')

    def test_converted_pair_refuses_with_the_fence_on(self) -> None:
        with patch.object(orgtx, 'TRANSITION_FENCE', True, create=True):
            with self.assertRaisesRegex(racekit.RaceFailure, 'TRANSITION_FENCE'):
                racekit.Race(pair='converted').__enter__()
            with racekit.Race(pair='unconverted') as race:
                pass
            self.assertEqual(race.facts['transition_fence'], 'on')
        with self.assertRaises(ValueError):
            racekit.Race(pair='both')

    def test_hook_is_cleared_and_probe_unwrapped_after(self) -> None:
        b = orgtx.backend()
        with racekit.Race():
            self.assertIn('acquire', vars(b.locks))
        self.assertNotIn('acquire', vars(b.locks))
        self.assertIsNone(orgtx._pause_hook)


if __name__ == '__main__':
    unittest.main()
