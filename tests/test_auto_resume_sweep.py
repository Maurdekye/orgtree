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

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

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


class _OnlyThese(dict):
    """A node mapping that refuses a whole-org walk and any node not named."""

    def __init__(self, nodes, allowed):
        super().__init__(nodes)
        self.allowed = set(allowed)

    def items(self):
        raise AssertionError('readiness walked every node of the org')

    def __getitem__(self, k):
        if k not in self.allowed:
            raise AssertionError(f'readiness read unplanned node {k!r}')
        return super().__getitem__(k)


class ReadinessReadsOnlyPlannedNodes(unittest.TestCase):
    """Item 3-2-0-engine-transactions-stay-open-for-10-17-s: `_auto_resume_org`
    held its transaction 3.6 s (median, alpha.4) while `auto_resume_ready`
    decoded every node of the org; only the planned frozen nodes can be
    ready, so with `only` it reads just those and answers the same."""

    def test_only_reads_the_planned_nodes_and_answers_the_same(self):
        now = 1_000_000.0
        frozen = {'state': 'live', 'model': 'haiku',
                  'frozen': {'connection': True, 'until_ts': now - 5}}
        nodes = {'f1': dict(frozen), 'f2': dict(frozen, frozen={'connection': True,
                                                           'until_ts': now + 500}),
                 'idle': {'state': 'live', 'model': 'haiku'}}
        full = s.auto_resume_ready(types.SimpleNamespace(d={}, nodes=dict(nodes)), now)
        guarded = types.SimpleNamespace(d={}, nodes=_OnlyThese(nodes, ['f1', 'f2']))
        self.assertEqual(full, {'f1'})
        self.assertEqual(s.auto_resume_ready(guarded, now, only=['f1', 'f2', 'gone']),
                         full)
        with self.assertRaises(AssertionError):
            s.auto_resume_ready(guarded, now)


if __name__ == '__main__':
    unittest.main()
