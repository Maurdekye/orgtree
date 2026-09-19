"""The turn record says, in one field, whether a turn is a RESTART REPLAY.

WHY THIS FIELD EXISTS. The 2026-09-18 stranding investigation had to answer
"which agents did the startup pass actually replay?" and the durable turn
record could not say. The nearest field, `resumed`, is set from
`bool(retry_payload)` (supervisor.py, `_run_one_turn_recorded`) and means "a
retry of a FAILED ATTEMPT" — so it was correctly False on all twenty-six rows,
including every obvious replay. The replay table had to be reconstructed from
timing and from rows that were ABSENT, which is the weakest evidence in the
whole investigation and the reason this suite exists. `restart_replay` answers
the question directly and is deliberately NOT a rename of `resumed`: both are
recorded, independently.

WHAT IS UNDER TEST, and it is the whole hop, not one end of it:

  §1  the real `reconcile` -> real `send_message` -> real `_admit_message`
      path stamps the flag on the carrier it hands to the turn worker. The
      seam is `_start_turn_worker` (no provider launches), everything above
      it is production code.
  §2  a REAL TURN over REAL PIPES, carrier in, record on disk out: the header
      of the turnlog record reads `restart_replay: true`, and `resumed` is
      still false on that same row — which is the exact pair the
      investigation needed and did not have.
  §3  the schema half: the field is declared, typed as a boolean, and cannot
      carry prose.

EVERY SECTION HAS ITS CONTROL, because a flag that is simply always true is
indistinguishable from a working one on the positive case alone: §1b an
ordinary send carries no flag, §2b an ordinary turn records it false, §3b a
command carrier is never stamped.

    python -B tests/test_restart_replay_turnlog.py
"""
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='restart-replay-turnlog-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'restart-replay-turnlog-only'
os.environ['ORGTREE_WARM'] = '0'
os.environ['ORGTREE_TURNLOG'] = '1'
for _k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import (ledger, store,                  # noqa: E402
                     supervisor as sup, turnread, warmpool)

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'


#: A stand-in CLI that carries one turn: announce, read stdin, answer, exit.
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


# ------------------------------------------------------- §1 the carrier hop


class ReconcileStampsTheCarrier(unittest.TestCase):
    """§1 From the startup pass to the turn worker, through production code."""

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'replay-carrier-{self.seq}'
        self.nid = 'worker'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, self.nid)
        org.node(self.nid)['inflight'] = {'at': '2026-09-18T21:41:00.000Z',
                                          'text': 'the interrupted turn',
                                          'view': 'the interrupted view'}
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, self.slug)

    def carriers(self, run):
        """Capture what `_admit_message` hands the turn worker. The seam is
        the LAUNCH, so admission, the mail drain and the envelope are all the
        real code on both the replay and the ordinary path."""
        seen = []
        with patch.object(sup, '_start_turn_worker',
                          side_effect=lambda s, n, carrier: seen.append(carrier)), \
             patch.object(sup, '_transcript_evidence', return_value=set()), \
             patch.object(sup, '_reconcile_steer_records'):
            run()
        return seen

    def test_1a_a_replayed_turn_reaches_the_worker_marked_as_one(self):
        """§1a THE POSITIVE. `reconcile` is the only caller that sets it, and
        it must survive every hop between that call and the launch."""
        seen = self.carriers(
            lambda: sup.reconcile(self.slug, active_only=True))
        self.assertEqual(1, len(seen), f'expected one launch, got {seen}')
        carrier = seen[0]
        self.assertIsInstance(carrier, dict,
                              'a replay always composes a view, so the carrier '
                              'is never the bare-string shape')
        self.assertIs(carrier.get('restart_replay'), True, carrier)

    def test_1b_CONTROL_an_ordinary_send_carries_no_such_flag(self):
        """§1b THE CONTROL for §1a. Without this, a `restart_replay` key that
        the door stamped onto EVERY carrier would pass §1a perfectly."""
        store.save_org(self._cleared())
        seen = self.carriers(
            lambda: sup.send_message(self.slug, self.nid, 'an ordinary nudge',
                                     view='an ordinary view'))
        self.assertEqual(1, len(seen), f'expected one launch, got {seen}')
        self.assertNotIn('restart_replay', seen[0],
                         'an ordinary turn must not read as a restart replay')

    def _cleared(self):
        org = store.load_org(self.slug)
        org.node(self.nid).pop('inflight', None)
        return org


# --------------------------------------------------------- §2 the record


class TheRecordAnswersTheQuestion(unittest.TestCase):
    """§2 A real turn over real pipes, and the durable row it leaves."""

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'replay-record-{self.seq}'
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

    def header(self):
        base = Path(os.environ['ORGTREE_DATA']) / 'turnlog' / self.slug / self.nid
        records = sorted(base.glob('*.json'))
        self.assertTrue(records, 'the turn must leave a record')
        return json.loads(records[-1].read_text(encoding='utf-8'))

    def test_2a_the_replayed_turns_row_says_so_while_resumed_stays_false(self):
        """§2a THE MONEY TEST, and the whole reason for the field. This is
        exactly the row the investigation read and could not interpret: a
        turn that IS a restart replay, whose `resumed` is correctly false
        because nothing failed and was retried. Both must be on the row, and
        they must disagree — if `restart_replay` merely tracked `resumed` it
        would be silent here, which is the defect."""
        self.run_turn({'text': '[ORGTREE RESTART] continue where you left off',
                       'view': 'the interrupted view', 'restart_replay': True})
        rec = self.header()
        self.assertIs(rec.get('restart_replay'), True,
                      f'the record cannot say this turn was a replay: {rec}')
        self.assertIs(rec.get('resumed'), False,
                      'a restart replay is not a retry of a failed attempt')

    def test_2b_CONTROL_an_ordinary_turns_row_says_it_was_not_a_replay(self):
        """§2b THE CONTROL for §2a. The field must be false — recorded and
        false, not absent — on a turn that is not a replay, or the row cannot
        be used to separate the two populations."""
        self.run_turn({'text': 'an ordinary turn', 'view': 'an ordinary view'})
        rec = self.header()
        self.assertIn('restart_replay', rec,
                      'the field must be on every row, not only the true ones')
        self.assertIs(rec.get('restart_replay'), False, rec)
        self.assertIs(rec.get('resumed'), False, rec)


# ---------------------------------------------------------- §3 the schema


class TheFieldIsTypedAndDistinct(unittest.TestCase):
    """§3 What the record is allowed to carry."""

    def test_3a_the_field_is_declared_beside_resumed_and_is_a_boolean(self):
        """§3a Two fields, two questions. Coercion keeps declared fields and
        drops everything else, so a boolean is all this one can ever be."""
        self.assertIn('restart_replay', turnread.HEADER_FIELDS)
        self.assertIn('resumed', turnread.HEADER_FIELDS)
        self.assertEqual(turnread.B, turnread.HEADER_FIELDS['restart_replay'])
        spec = turnread.HEADER_FIELDS['restart_replay']
        self.assertIs(turnread.coerce(spec, True), True)
        # prose never survives a declared boolean
        self.assertIs(turnread.coerce(spec, 'C:/Users/someone/secret'), False)
        self.assertIs(turnread.coerce(spec, None), False)

    def test_3b_CONTROL_a_command_carrier_is_never_stamped(self):
        """§3b The stamping site's own claim, held down rather than trusted:
        it spreads into every carrier shape EXCEPT the command one. That is
        correct by construction — `reconcile` drops command markers instead
        of replaying them — and this fails if either half stops being true."""
        slug, nid = 'replay-command-control', 'worker'
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, nid)
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, slug)
        seen = []
        with patch.object(sup, '_start_turn_worker',
                          side_effect=lambda s, n, c: seen.append(c)):
            sup.send_message(slug, nid, '/status', command=True,
                             restart_replay=True)
        self.assertEqual(1, len(seen), f'expected one launch, got {seen}')
        self.assertTrue(seen[0].get('cmd'), seen[0])
        self.assertNotIn('restart_replay', seen[0],
                         'a command turn is never a restart replay')


if __name__ == '__main__':
    unittest.main(verbosity=2)
