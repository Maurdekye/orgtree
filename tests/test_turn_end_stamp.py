"""A REAL turn, ending normally, leaves `turn_ended` on its own node.

WHY THIS SUITE EXISTS, AND IT IS A MUTATION FINDING, NOT A HUNCH.  The
absent-marker probe covers what `reconcile` DOES with the stamp, and it covers
it from five angles.  It cannot cover who WRITES the stamp, because it has no
real turn in it: it ends its simulated turn by calling
`supervisor._mark_turn_ended` itself.  So mutant M13 -- delete the call from
the turn's own `finally` and leave the helper untouched -- SURVIVED that probe.
The absence would have gone straight back to being unreadable, every
started-and-finished seat would have replayed its stale turn again, and the
five-arm probe would have stayed green throughout.

So this measures the one line that probe cannot reach: a real turn, over real
pipes, ending normally, and the stamp it leaves behind on disk.

  §1  the turn writes its own marker, ends, and leaves a `turn_ended` whose
      `at` is THAT TURN'S start stamp -- the same value the marker carried,
      because that is what makes it comparable with an interrupted turn's.
  §2  CONTROL: the marker is gone afterwards. A stamp written while the
      marker survived would mean the pop and the stamp had come apart, and
      reconcile would then see a marker AND a stamp for the same live turn.

⚠ THE HARNESS IS THE ONE FROM `test_restart_replay_turnlog.py` §2, deliberately
and with its child script, because that file already established the way to run
a turn end-to-end here: a stub CLI over real pipes with the provider launch
patched out.  What is NOT patched is the turn's `finally`, which is the entire
point -- everything from `_run_one_turn` down is production code.

    python -B tests/test_turn_end_stamp.py
"""
import contextlib
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='turn-end-stamp-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'turn-end-stamp-only'
os.environ['ORGTREE_WARM'] = '0'
for _k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                  # noqa: E402
load_app()
from orgtree import store, ledger, supervisor as sup, warmpool      # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    store.DATA_ROOT

_CHILD = r'''
import json,os,sys
from pathlib import Path
marker=sys.argv[1]
def emit(event):print(json.dumps(event),flush=True)
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':[]})
sys.stdin.readline()
Path(marker).write_text(str(os.getpid()))
emit({'type':'assistant','message':{'id':'a','role':'assistant',
     'content':[{'type':'text','text':'ok'}],'usage':{'output_tokens':1}}})
emit({'type':'result','subtype':'success','is_error':False,
     'total_cost_usd':0,'usage':{'output_tokens':1}})
for line in sys.stdin:pass
'''


def eventually(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.02)
    return bool(predicate())


class ARealTurnStampsItsOwnEnd(unittest.TestCase):

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'turn-end-stamp-{self.seq}'
        self.nid = 'worker'
        self.dir = Path(os.environ['ORGTREE_DATA']) / self.slug
        self.dir.mkdir(parents=True, exist_ok=True)
        self.script = self.dir / 'child.py'
        self.script.write_text(_CHILD, encoding='utf-8')
        self.marker = self.dir / 'child.pid'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 0, self.nid)
        org.node(self.nid)['session_id'] = 'fixture-session'
        store.save_org(org)
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True, exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st['busy'] = True
        self.procs = []
        self.thread = None
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(store._POOL.close_all, self.slug)
        keep = ('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP')
        self.stack.enter_context(patch.object(
            sup, 'spawn_env', return_value={k: v for k, v in os.environ.items()
                                            if k.upper() in keep}))
        self.stack.enter_context(patch.object(sup, '_leash'))
        self.stack.enter_context(patch.object(
            sup, '_mcp_infrastructure_fingerprint', return_value='fixture'))
        self.stack.enter_context(patch.object(sup, '_record_prompt_view'))
        self.stack.enter_context(patch.object(sup, 'cli_diagnosis', return_value=None))
        self.stack.enter_context(patch.object(warmpool, 'poke'))
        self.stack.enter_context(patch.object(
            warmpool, 'warm_decision', return_value=(False, False)))
        self.stack.enter_context(patch.object(
            warmpool, 'eligible', return_value=(False, 'fixture')))
        self.stack.enter_context(patch.object(
            sup.appsettings, 'wait_for_mcp_tools_enabled', return_value=False))
        self.stack.enter_context(patch('orgtree.transcript_ingest.capture_safely'))
        popen = subprocess.Popen

        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get('stdin') == subprocess.PIPE:
                self.procs.append(p)
            return p
        self.stack.enter_context(patch.object(subprocess, 'Popen', side_effect=spawn))

    def tearDown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            with contextlib.suppress(Exception):
                proc.wait(timeout=5)
        if self.thread is not None:
            self.thread.join(10)
        for proc in self.procs:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    with contextlib.suppress(Exception):
                        stream.close()

    def run_turn(self, carrier):
        cmd = [sys.executable, str(self.script), str(self.marker)]
        self.stack.enter_context(patch.object(sup, '_build_cmd', return_value=cmd))
        self.thread = threading.Thread(
            target=lambda: sup._run_one_turn(self.slug, self.nid, carrier),
            daemon=True)
        self.thread.start()
        eventually(self.marker.exists)
        self.thread.join(15)
        self.assertFalse(self.thread.is_alive(), 'the turn runner must settle')

    # ----------------------------------------------------------------- §1
    def test_1_a_completed_turn_leaves_a_stamp_naming_its_own_start(self):
        """§1 THE LINE THE ABSENT-MARKER PROBE CANNOT REACH.

        The turn writes its own `inflight` at the start and pops it in the
        `finally`; this asserts the pop is accompanied by the stamp, and that
        the stamp carries the TURN'S OWN START STAMP rather than the wall
        clock at the end. Those are different values and only the first is
        comparable with an interrupted marker's `at`, which is the whole
        comparison `_newer_turn_ended` performs.
        """
        # the marker `at` the turn writes for itself is not knowable in
        # advance, so it is captured from the doc WHILE the turn runs.
        seen = {}
        real_mark = sup._mark_turn_ended

        def capture(n, popped):
            seen['popped_at'] = (popped or {}).get('at')
            return real_mark(n, popped)

        self.stack.enter_context(patch.object(sup, '_mark_turn_ended', capture))
        self.run_turn('drive the turn')

        node = store.load_org(self.slug).node(self.nid)
        stamp = node.get('turn_ended')
        self.assertIsInstance(
            stamp, dict,
            'a completed turn left no `turn_ended`: the startup reconcile '
            'cannot then tell this seat from one whose marker went missing, '
            'and every started-and-finished seat replays its stale turn')
        self.assertTrue(stamp.get('at'), 'the stamp must name a turn')
        self.assertEqual(
            stamp['at'], seen.get('popped_at'),
            'the stamp must carry the ENDED TURN\'S OWN start stamp, not the '
            'time it ended -- otherwise it is not comparable with the `at` on '
            'an interrupted marker')
        self.assertTrue(stamp.get('ended'), 'the stamp records when it ended')

    # ----------------------------------------------------------------- §2
    def test_2_CONTROL_the_marker_is_gone_once_the_turn_has_ended(self):
        """§2 The stamp does not REPLACE the pop, it accompanies it. If the
        marker survived alongside a stamp, reconcile would read a live turn
        and a finished one on the same seat at the same moment."""
        self.run_turn('drive the turn')
        node = store.load_org(self.slug).node(self.nid)
        self.assertIsNone(
            node.get('inflight'),
            'the turn ended but its marker is still on disk -- the pop and '
            'the stamp have come apart')


if __name__ == '__main__':
    unittest.main(verbosity=2)
