"""The auto-resume tick's no-freeze shortcut must never skip the invariant
sweep riding the same per-org tick (perf-review round 3: the `continue`
composition disabled dead remote-control and invalid-parent repair for
every freeze-free org). One controlled tick, no real thread, no provider."""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-resume-sweep-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store, supervisor as s   # noqa: E402


class StopLoop(BaseException):
    """BaseException so the loop's survive-anything except cannot eat it."""


class InlineThread:
    def __init__(self, target, **_kw):
        self._target = target

    def start(self):
        try:
            self._target()
        except StopLoop:
            pass


class AutoResumeSweepTests(unittest.TestCase):
    def _run_one_tick(self, snap):
        ticks = [0]

        def sleep(_):
            ticks[0] += 1
            if ticks[0] > 1:
                raise StopLoop()

        calls = {'resume': [], 'sweep': []}
        with patch.object(s, '_auto_resume_started', False), \
             patch.object(s.threading, 'Thread', InlineThread), \
             patch.object(s.time, 'sleep', sleep), \
             patch.object(store, 'cached_list',
                          return_value=[{'slug': 'probe'}]), \
             patch.object(store, 'cached_org', return_value=snap), \
             patch.object(s, '_auto_resume_org',
                          side_effect=lambda slug, **k:
                          calls['resume'].append(slug)), \
             patch.object(s, '_invariant_sweep_org',
                          side_effect=lambda slug: calls['sweep'].append(slug)):
            s.start_auto_resume_loop()
        return calls

    def test_no_freeze_org_still_gets_the_invariant_sweep(self):
        snap = types.SimpleNamespace(
            d={}, nodes={'alpha': {'state': 'live',
                                   'remote_controlled': {'pid': 999}}})
        calls = self._run_one_tick(snap)
        self.assertEqual(calls['resume'], [],
                         'no freeze -> the resume scheduler is a provable no-op')
        self.assertEqual(calls['sweep'], ['probe'],
                         'the sweep must run every tick regardless of freezes')

    def test_frozen_org_gets_both(self):
        snap = types.SimpleNamespace(
            d={}, nodes={'alpha': {'frozen': {'kind': 'connection'}}})
        calls = self._run_one_tick(snap)
        self.assertEqual(calls['resume'], ['probe'])
        self.assertEqual(calls['sweep'], ['probe'])

    def test_spend_frozen_org_resumes(self):
        snap = types.SimpleNamespace(d={'spend_frozen': True}, nodes={})
        calls = self._run_one_tick(snap)
        self.assertEqual(calls['resume'], ['probe'])
        self.assertEqual(calls['sweep'], ['probe'])


if __name__ == '__main__':
    unittest.main()
