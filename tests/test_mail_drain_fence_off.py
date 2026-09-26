"""fence-off S2: the mail drain works with the transition fence OFF and never
takes DOC_LOCK.

`maildrain.recover` used to run under one DOC_LOCK hold, and the drain
worker's release took DOC_LOCK around a RAM-only step. Both are gone: the
recovery reads lock-free and writes in row transactions, and the release
takes `_state_lock` only. What the old lock guaranteed has to hold anyway:

  1. no DOC_LOCK is taken at all (a DOC_LOCK that raises proves it);
  2. the admission gate is re-decided on the LOCKED Org: a seat frozen after
     the lock-free read is not admitted, and stays tracked for the retry
     (p01's review condition b);
  3. the reclaim transaction holds the gate sections FOR SHARE, so a spend
     stop cannot commit while it decides (racekit, lock-manager proof);
  4. a send that queues its carrier in RAM while its demand is still
     uncommitted, racing the worker's release and a recovery pass, is
     delivered exactly once and never stranded on an idle node (p01's
     condition a; racekit holds the send at before_commit). A control run
     without the release proves the test can see the claim.

Run:  python tools/run-python-verification.py tests/test_mail_drain_fence_off.py
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='mail-drain-fence-off-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import store, ledger, orgtx, supervisor as sup, maildrain  # noqa: E402
import racekit  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class _NoDocLock:
    """Stands in for store.DOC_LOCK: any acquisition fails the test."""
    def _boom(self, *a, **k):
        raise AssertionError('DOC_LOCK was taken')
    acquire = __enter__ = _boom

    def __exit__(self, *a):
        return False

    def release(self):
        raise AssertionError('DOC_LOCK was released without being taken')

    def _is_owned(self):
        return False


class Base(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:60]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        store.save_org(org)
        self.st = sup.state(self.slug, 'worker')
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        self.started = []
        for p in (patch.object(sup, '_native_context_hold', return_value=None),
                  patch.object(sup, '_cancel_working_cache'),
                  patch.object(sup, '_note_working_activity'),
                  patch.object(sup, '_hold_for_deploy', return_value=True),
                  patch.object(sup, 'scan_steer_records'),
                  patch.object(sup, '_phantom_log'),
                  patch.object(sup, '_start_turn_worker',
                               side_effect=lambda s, n, c: self.started.append(c))):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(maildrain._forget, self.slug, 'worker')
        self.addCleanup(store._POOL.close_all, self.slug)

    def post(self, text='one'):
        """Committed mail and its drain demand, as a send leaves them."""
        with orgtx.org_tx(self.slug, nodes=['worker'],
                          sections=[('mail', 'worker')],
                          logs=[('mail_log', 'worker'), 'events']) as tx:
            m = tx.org.post_mail(ledger.USER, 'worker', text, kind='message')
            maildrain.request(tx.org, 'worker')
        return m

    def tracked(self):
        with maildrain._pending_lock:
            return (self.slug, 'worker') in maildrain._pending

    def demand(self):
        return orgtx.org_read(self.slug).node('worker').get('mail_drain')


class NoDocLock(Base):
    def test_recover_admits_without_doc_lock(self):
        self.post()
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            self.assertTrue(maildrain.recover(self.slug, 'worker'))
        self.assertEqual(len(self.started), 1)
        self.assertTrue(self.st['busy'])

    def test_inspect_mail_ownership_without_doc_lock(self):
        self.post()
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            sup.inspect_mail_ownership(self.slug, 'worker')

    def test_worker_release_without_doc_lock(self):
        with sup._state_lock:
            self.st['busy'] = True
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            maildrain.worker(lambda slug, nid: None)(self.slug, 'worker')
        self.assertFalse(self.st['busy'])
        self.assertNotIn('mail_drain_owner', self.st)


class LockedGate(Base):
    def test_a_freeze_after_the_snapshot_is_refused_inside_the_tx(self):
        """The lock-free read says live; the seat is frozen before the
        reclaim transaction locks it. It must not be admitted, its demand
        must be untouched, and it must stay tracked for the retry."""
        self.post()
        snap = orgtx.org_read(self.slug)
        with orgtx.org_tx(self.slug, nodes=['worker']) as tx:
            tx.org.node('worker')['frozen'] = True
        before = self.demand()
        maildrain._track(self.slug, 'worker')
        real = orgtx.org_read
        calls = []

        def read(slug):
            calls.append(slug)
            return copy.deepcopy(snap) if len(calls) == 1 else real(slug)
        with patch.object(orgtx, 'org_read', side_effect=read):
            self.assertFalse(maildrain.recover(self.slug, 'worker'))
        self.assertEqual(calls[:1], [self.slug], 'the snapshot was never served')
        self.assertEqual(self.started, [], 'a frozen seat was admitted')
        self.assertEqual(self.demand(), before)
        self.assertTrue(self.tracked(), 'a refused seat was dropped from the index')

    def test_the_gate_sections_are_held_while_the_reclaim_decides(self):
        """A spend stop cannot commit while the reclaim transaction holds
        its locks: the lock manager shows it waiting, and it lands after."""
        self.post()

        def spend_stop():
            with orgtx.org_tx(self.slug, sections=['spend_frozen']) as tx:
                tx.d['spend_frozen'] = True
        with racekit.Race(pair='converted') as race:
            a = race.actor('A', maildrain.recover, self.slug, 'worker')
            b = race.actor('B', spend_stop)
            ga = race.hold(a, 'after_lock')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.blocked(b)
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.blocked', 'A.after_commit', 'B.after_lock')
        self.assertEqual(len(self.started), 1)


class ReleaseRace(Base):
    def _race(self, release: bool):
        """A worker owns the seat. A send finds it busy, queues its carrier
        in RAM, and is held before its admission commits. Meanwhile the
        worker releases (or, in the control, does not) and a recovery pass
        runs. Then the send commits and the drain sweeps once more."""
        self.post('first')                      # committed mail, box non-empty
        with orgtx.org_tx(self.slug, nodes=['worker']) as tx:
            tx.org.node('worker').pop('mail_drain', None)   # no demand yet
        with sup._state_lock:
            self.st['busy'] = True
        with racekit.Race(pair='converted') as race:
            s = race.actor('S', sup.send_message, self.slug, 'worker',
                           'mail pointer', mail_ping=True)
            gs = race.hold(s, 'before_commit')
            race.start(s)
            race.reached(gs)
            with sup._state_lock:
                queued = list(self.st['queue'])
            self.assertTrue(queued, 'the send did not queue its carrier before commit')
            if release:
                maildrain.worker(lambda slug, nid: None)(self.slug, 'worker')
            maildrain.recover(self.slug, 'worker')
            race.release(gs)
            race.join(s)
        maildrain.sweep()

    def test_a_send_racing_the_release_is_delivered_once(self):
        self._race(release=True)
        self.assertEqual(len(self.started), 1, f'admissions: {self.started}')
        with sup._state_lock:
            stranded = [c for c in self.st['queue']]
        self.assertTrue(self.st['busy'])
        self.assertEqual(stranded, [], 'a carrier was left queued')

    def test_control_without_the_release_nothing_is_admitted(self):
        """The negative control: without the release the claim still holds,
        so the same sequence must admit nothing. If this passed with an
        admission, the test above could not see the release at all."""
        self._race(release=False)
        self.assertEqual(self.started, [])
        with sup._state_lock:
            self.assertTrue(self.st['queue'])


if __name__ == '__main__':
    unittest.main()
