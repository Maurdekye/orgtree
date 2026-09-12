"""W16 — provider attempt phases and truthful liveness/halt receipts.

THE THREE THINGS THIS SUITE HOLDS DOWN, from the W16 package's own acceptance
conditions (suggestion synthesis, 2026-09-12; sources PR20, PR21,
statereview-04, haltstate-03):

  1. AN ATTEMPT HAS PHASES, AND "SENT" IS ONE OF THEM. A review of the turn
     record could not tell a provider launch from a provider result from a
     successful return, because all three were summarised as "attempt"
     (PR20). Worse, the durable record had no event for the SEND at all: the
     nearest thing, `delivered`, fires when the CLI's first stdout event
     proves it read stdin — a START ACKNOWLEDGEMENT, not a send. Three
     rejection paths sit between spawn and that acknowledgement (the MCP
     surface gate, `halt.check`, and the write itself raising), and a record
     in which all three look identical to "sent, no answer" is what made
     PR21's reviewer read the source to find the rejection path. §1 pins the
     phase vocabulary; §2 drives the real runner over real pipes and proves
     the event appears only on the far side of a successful write.

  2. LIVENESS IS THREE-VALUED, AND UNKNOWN NEVER RENDERS AS DEAD. A boolean
     observation is unsuitable for authorizing destructive recovery
     (statereview-04). `_pid_provably_dead` already got this right for the
     remote-control detach and is NOT re-implemented here — the manifest's
     own note says to expose the tri-state elsewhere rather than touch that
     guard, and §3d pins it unchanged. The watchdog is the elsewhere: its
     probe still answered False for a gone process AND for one it merely
     could not open, and the call site turned that into "(pid:N is DOWN)" and
     a DOWN edge — an announced death that never happened. §3 pins the record
     and the probe, §4 pins the call site.

  3. A PENDING HALT IS NOT A SETTLED ONE — AND THIS SUITE DOES NOT TEST IT,
     ON PURPOSE. Both halt outcomes are successful responses, and a client
     that reduces them to one badge is wrong about the one that matters
     (haltstate-03). That distinction landed with halt-state's own work and
     is ALREADY HELD DOWN at both ends, which this package verified rather
     than assumed:

         tests/test_agent_halt.py::test_timeout_is_halting_never_success
             the backend receipt — halted False, settled False, halting True
         apps/desktop/renderer/tests/haltcontrol.test.tsx
             the desk consumer — "The UI must never label a signalled-but-
             unsettled turn as Halted", driven over both real responses

     W16 adds no test beside those. The only thing it could add is a weaker
     restatement — a grep for the source line, which passes when the
     behaviour is broken and fails when the file is merely reformatted — and
     a redundant brittle fence is worse than the solid one it sits next to.
     W16 introduces no new halt consumer, so there is nothing else to pin.

MEASURED RED ON MAIN (84d217c): §1a, §1b, §1c, §2a, §3a, §3b, §3c, §3e, §4a,
§4b, §4c — main has no `sent` phase in the turn-record vocabulary, no
`liveness` module, and a watchdog process check that reports an undeterminable
target as DOWN. GREEN BEFORE AND AFTER (the controls, which a change that
merely added an event name would still pass): §2b, §2c, §3d, §4d, §6a, §6b.

    python -B tests/test_provider_attempt_and_liveness.py
"""
import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='w16-attempt-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'w16-attempt-only'
os.environ['ORGTREE_WARM'] = '0'
os.environ['ORGTREE_TURNLOG'] = '1'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

from orgtree import (halt, ledger, store,            # noqa: E402
                     supervisor as sup, turnread, warmpool)

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

try:
    from orgtree import liveness                     # noqa: E402
except ImportError:                                  # RED on main: no module
    liveness = None


#: A stand-in CLI that speaks enough of the Claude stream protocol to carry a
#: turn: announce init, block until stdin is read, then answer. The read is
#: what makes `delivered` honest, so the fixture must not answer before it.
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


# ------------------------------------------------------------------ §1 phases


class AttemptPhaseVocabulary(unittest.TestCase):
    """§1 The durable record can NAME the phases of one attempt."""

    def test_1a_sent_is_a_recorded_phase(self):
        """§1a PR20/PR21: the send is its own event, not a summary word."""
        self.assertIn('sent', turnread.KINDS,
                      'the turn record has no phase for the send itself')

    def test_1b_the_four_phases_are_ordered_and_distinct(self):
        """§1b launch, send, start acknowledgement and result are four
        different events — the distinction PR20 asked for."""
        for kind in ('spawn', 'sent', 'delivered', 'result'):
            self.assertIn(kind, turnread.KINDS, kind)
        self.assertEqual(4, len({'spawn', 'sent', 'delivered', 'result'}),
                         'the phases must not collapse onto one another')

    def test_1c_sent_carries_no_prose_and_no_identifier(self):
        """§1c turnlog's standing promise, applied to the new event: coercion
        keeps the declared fields and drops everything else, so a prompt, a
        path or a token cannot ride along in a receipt."""
        self.assertIsNotNone(getattr(turnread, 'FIELDS', None))
        spec = turnread.FIELDS['sent']
        self.assertEqual({'resent'}, set(spec),
                         'the sent event declares exactly one flag')
        coerced = turnread.coerce(spec['resent'], True)
        self.assertIs(coerced, True)
        # a declared boolean never becomes prose
        self.assertNotIsInstance(turnread.coerce(spec['resent'], 'sk-secret'), str)


# -------------------------------------------------------------- §2 real turn


class SendPhaseOverRealPipes(unittest.TestCase):
    """§2 The real runner, real pipes: when is `sent` written?"""

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'w16-{self.seq}'
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
        store._POOL.close_all(self.slug)

    def run_turn(self, *, wait_marker=True):
        cmd = [sys.executable, str(self.script), str(self.marker)]
        self.stack.enter_context(patch.object(sup, '_build_cmd', return_value=cmd))
        self.thread = threading.Thread(target=lambda: sup._run_one_turn(
            self.slug, self.nid, {'cmd': True, 'text': '/fixture'}), daemon=True)
        self.thread.start()
        if wait_marker:
            eventually(self.marker.exists)
        self.thread.join(15)
        self.assertFalse(self.thread.is_alive(), 'the turn runner must settle')

    def kinds(self):
        base = Path(os.environ['ORGTREE_DATA']) / 'turnlog' / self.slug / self.nid
        records = sorted(base.glob('*.json'))
        self.assertTrue(records, 'the turn must leave a record')
        rec = json.loads(records[-1].read_text(encoding='utf-8'))
        return [str(e.get('kind')) for e in (rec.get('events') or [])]

    def test_2a_a_delivered_turn_records_the_send_before_the_acknowledgement(self):
        """§2a The money test. A turn that really wrote to the CLI records
        `sent`, and records it BEFORE `delivered` — the send precedes the
        acknowledgement of the send, which is the ordering PR21 wanted to be
        able to read off the record instead of off the source."""
        self.run_turn()
        kinds = self.kinds()
        self.assertIn('sent', kinds, f'no send phase in {kinds}')
        self.assertIn('delivered', kinds, f'no start acknowledgement in {kinds}')
        self.assertLess(kinds.index('sent'), kinds.index('delivered'),
                        'the send must precede its own acknowledgement')
        self.assertEqual(1, kinds.count('sent'),
                         'one send, one event — duplicates are not receipts')

    def test_2b_a_failure_before_the_write_records_no_send(self):
        """§2b THE CONTROL for §2a, and acceptance condition 1 itself: a turn
        that dies before the write leaves a record that reached `spawn` and
        never reached `sent`. Without this, §2a would pass just as well for an
        event emitted unconditionally at launch — which is exactly the
        undifferentiated "attempt" PR20 complained about."""
        self.stack.enter_context(patch.object(
            sup, '_user_event', side_effect=OSError('pipe closed before the write')))
        self.run_turn(wait_marker=False)
        kinds = self.kinds()
        self.assertIn('spawn', kinds, f'the attempt did reach a launch: {kinds}')
        self.assertNotIn('sent', kinds,
                         'a turn that never wrote must not claim to have sent')
        self.assertNotIn('delivered', kinds,
                         'a turn that never sent cannot be acknowledged')

    def test_2c_a_rejected_turn_has_no_successful_start_acknowledgement(self):
        """§2c CONTROL, the second half of acceptance condition 1. `delivered`
        is emitted from the stdout reader on an event the CLI cannot produce
        without having read stdin; a rejection never produces one. Pinned so a
        later refactor cannot move the acknowledgement to the write."""
        self.stack.enter_context(patch.object(
            sup, '_user_event', side_effect=OSError('rejected')))
        self.run_turn(wait_marker=False)
        self.assertNotIn('delivered', self.kinds())


# ----------------------------------------------------------- §3 the liveness


@unittest.skipIf(liveness is None, 'no liveness module on this tree')
class LivenessRecord(unittest.TestCase):
    """§3 alive / dead / unknown, with the reason that produced it."""

    def test_3a_the_three_states_and_a_closed_reason_vocabulary(self):
        """§3a The record is tri-state and its reasons are a closed set."""
        self.assertEqual(('alive', 'dead', 'unknown'), liveness.STATES)
        for reason in liveness.REASONS:
            self.assertIn(liveness.state_of(reason), liveness.STATES, reason)

    def test_3b_uncertainty_is_unknown_and_is_never_dead(self):
        """§3b THE POINT OF THE PACKAGE. Every reason that means "I could not
        tell" resolves to unknown — never to dead, which is the value that
        would authorize a destructive recovery."""
        for reason in ('access-denied', 'unreachable', 'malformed-target',
                       'probe-error'):
            obs = liveness.record(target='pid:1234', reason=reason)
            self.assertEqual('unknown', obs['state'], reason)
            self.assertNotEqual('dead', obs['state'], reason)
            self.assertEqual(reason, obs['reason'])
        for reason in ('no-such-process', 'exited', 'refused'):
            self.assertEqual('dead', liveness.record(
                target='pid:1234', reason=reason)['state'], reason)

    def test_3c_an_unrecognised_reason_degrades_to_unknown(self):
        """§3c The convention W15's `basis` established: an unrecognised value
        normalises rather than passing through, and it normalises to the
        SAFE state, not to a confident one."""
        obs = liveness.record(target='pid:1', reason='something-new')
        self.assertEqual('unknown', obs['state'])
        self.assertIn(obs['reason'], liveness.REASONS)

    def test_3d_the_recovery_guard_is_untouched(self):
        """§3d CONTROL. `_pid_provably_dead` is the already-correct guard the
        manifest told this package not to reimplement: it must stay decisive
        about death and cautious about everything else."""
        self.assertFalse(sup._pid_provably_dead(0))
        self.assertFalse(sup._pid_provably_dead(os.getpid()),
                         'this very process is not provably dead')

    def test_3e_a_live_process_is_alive_and_a_reaped_one_is_dead(self):
        """§3e The real probe against real processes, both answers."""
        child = subprocess.Popen([sys.executable, '-c', 'import sys;sys.stdin.read()'],
                                 stdin=subprocess.PIPE)
        try:
            obs = liveness.observe(f'pid:{child.pid}')
            self.assertEqual('alive', obs['state'], obs)
            self.assertEqual('still-active', obs['reason'], obs)
        finally:
            child.kill()
            child.wait(timeout=10)
            if child.stdin:
                child.stdin.close()
        self.assertTrue(eventually(
            lambda: liveness.observe(f'pid:{child.pid}')['state'] == 'dead'),
            'a reaped process must read as dead')
        self.assertEqual('unknown', liveness.observe('not-a-target')['state'])


@unittest.skipIf(liveness is None, 'no liveness module on this tree')
class AFailingProbeIsAnAnswer(unittest.TestCase):
    """§3f A PROBE THAT CANNOT RUN MUST STILL ANSWER (review finding,
    worktree-safe, 2026-09-12).

    `observe` is called from the watchdog poll loop, so an exception escaping
    it stops the loop whose whole job is to notice trouble — and it would
    escape exactly when the machine is under the stress that makes noticing
    matter. Every fault below is a REAL failure mode of the probe itself, not
    of the thing being probed, so each must land on `unknown` rather than on
    a confident answer about the target."""

    def test_3f_socket_construction_failure_is_unknown_not_unreachable(self):
        """Descriptor exhaustion. This escaped `observe()` outright before the
        fix, because the socket was built outside the guarded region. It must
        also not be reported as `unreachable`: running out of file handles is
        a fact about this machine, not about the port."""
        with patch('socket.socket', side_effect=OSError(24, 'Too many open files')):
            obs = liveness.observe('port:9')
        self.assertEqual('unknown', obs['state'], obs)
        self.assertEqual('probe-error', obs['reason'], obs)

    def test_3f_a_bad_timeout_is_unknown(self):
        """`settimeout` raises ValueError, not OSError, so it slipped past the
        connection handling and out of the module."""
        obs = liveness.observe('port:9', timeout=-5)
        self.assertEqual('unknown', obs['state'], obs)

    def test_3f_a_number_no_pid_could_be_is_unknown(self):
        """`\\d+` admits it, and `os.kill` answers with OverflowError rather
        than an OSError — a hole that happened to be covered on Windows and
        not on POSIX."""
        obs = liveness.observe('pid:99999999999999999999')
        self.assertEqual('unknown', obs['state'], obs)

    def test_3f_an_unforeseen_probe_failure_is_still_unknown(self):
        """The structural backstop. Whatever the inner handlers failed to
        anticipate, the answer is the same one this module gives everything
        else it cannot determine — never an exception, never `dead`."""
        with patch.object(liveness, '_observe_pid',
                          side_effect=RuntimeError('something new')):
            obs = liveness.observe('pid:1234')
        self.assertEqual('unknown', obs['state'], obs)
        self.assertNotEqual('dead', obs['state'])

    def test_3f_a_close_that_fails_does_not_become_an_answer(self):
        """A connect that reached a verdict keeps it even if tearing the
        socket down then fails."""
        real = socket.socket

        class Brittle(real):                       # type: ignore[misc,valid-type]
            def close(self):                       # noqa: D102
                raise OSError('close failed')

        with patch('socket.socket', Brittle):
            obs = liveness.observe('port:9')
        try:
            self.assertIn(obs['state'], ('alive', 'dead', 'unknown'), obs)
        finally:
            pass


# ------------------------------------------------------- §4 the watchdog site


@unittest.skipIf(liveness is None, 'no liveness module on this tree')
class WatchdogNeverInventsADeath(unittest.TestCase):
    """§4 The call site: what the dog RECORDS and what it FIRES."""

    def dog(self, target, **hw):
        return {'kind': 'process', 'target': target, 'pattern': None,
                'high_water': dict(hw), 'state': 'armed', 'owner': 'someone'}

    def poll(self, w):
        return sup._wd_check_poll('w16', w, None)

    def test_4a_an_undeterminable_target_is_not_reported_down(self):
        """§4a The defect, stated as a test. An observation that could not be
        made must not be written down as DOWN — the word a reader takes as
        evidence the watched thing died."""
        with patch.object(liveness, 'observe', return_value=liveness.record(
                target='pid:4', reason='access-denied')):
            lines, hw, seen = self.poll(self.dog('pid:4', up=True))
        self.assertNotIn('DOWN', seen, seen)
        self.assertEqual([], lines, 'an unknown observation is not an event')

    def test_4b_an_undeterminable_target_does_not_fire_the_down_edge(self):
        """§4b The harm. A dog that has seen its target UP and then cannot
        open it used to announce "went DOWN" — a death that never happened,
        and on a remote-control session the announcement that authorized
        tearing down a live driver."""
        with patch.object(liveness, 'observe', return_value=liveness.record(
                target='pid:4', reason='access-denied')):
            lines, hw, _ = self.poll(self.dog('pid:4', up=True))
        self.assertEqual([], lines, 'unknown must never produce a DOWN edge')
        self.assertIs(True, hw.get('up'),
                      'the last KNOWN state survives an unreadable check')

    def test_4c_unknown_is_not_counted_as_silence(self):
        """§4c A check that could not see is not a check that saw nothing.
        `quiet` is the only input to `wd_subject_lost`, so counting an
        unreadable probe there would let uncertainty accumulate into a
        confident "this subject is gone"."""
        with patch.object(liveness, 'observe', return_value=liveness.record(
                target='pid:4', reason='access-denied')):
            _, hw, _ = self.poll(self.dog('pid:4', up=True, quiet=2))
        self.assertEqual(2, hw.get('quiet'),
                         'uncertainty must not accumulate toward lost')

    def test_4e_an_injected_probe_failure_reaches_the_dog_as_unknown(self):
        """§4e END TO END, and the one test that proves the two halves are
        actually connected. §3f shows `observe` answers unknown when its own
        socket cannot be built; §4a-§4c show the dog handles unknown. Both
        patch at the seam between them, so neither would notice if the real
        fault never produced the record the dog reads. Here the fault is
        injected at `socket.socket` — the bottom of the stack — and the
        assertions are made at the top: no DOWN edge, no DOWN in the record,
        the last known state intact, and `quiet` unmoved.

        Descriptor exhaustion is the realistic cause, and it hits every dog on
        the machine at once. Before the fix this did not merely misreport —
        the exception escaped `_wd_check_poll` entirely."""
        with patch('socket.socket', side_effect=OSError(24, 'Too many open files')):
            lines, hw, seen = self.poll(self.dog('port:9', up=True, quiet=3))
        self.assertEqual([], lines, 'a probe that could not run is not a death')
        self.assertNotIn('DOWN', seen, seen)
        self.assertIs(True, hw.get('up'), 'the last KNOWN state survives')
        self.assertEqual(3, hw.get('quiet'),
                         'an unrunnable probe must not advance the silence count')
        self.assertEqual('unknown', (hw.get('observed') or {}).get('state'))

    def test_4d_a_real_death_still_fires(self):
        """§4d THE OTHER CONTROL, and the one that keeps §4a-§4c honest: a
        target that is decisively gone must still produce the DOWN edge. A
        change that simply stopped firing would pass every test above."""
        with patch.object(liveness, 'observe', return_value=liveness.record(
                target='pid:9', reason='no-such-process')):
            lines, hw, seen = self.poll(self.dog('pid:9', up=True))
        self.assertEqual(['pid:9 went DOWN'], lines)
        self.assertIn('DOWN', seen)
        self.assertIs(False, hw.get('up'))


# ------------------------------------------------------------- §5 halt, §6 no


class ReceiptsCarryNoSecrets(unittest.TestCase):
    """§6 acceptance condition 3, second clause."""

    def test_6a_no_turn_record_field_is_free_text(self):
        """§6a CONTROL. Every declared field is a bounded type — an int, a
        bool or a closed vocabulary — so no receipt has a slot a prompt or a
        credential could be written into."""
        for kind, spec in turnread.FIELDS.items():
            for name, fs in spec.items():
                coerced = turnread.coerce(fs, 'sk-ant-secret-value')
                self.assertNotEqual('sk-ant-secret-value', coerced,
                                    f'{kind}.{name} accepted free text')

    @unittest.skipIf(liveness is None, 'no liveness module on this tree')
    def test_6b_a_liveness_record_carries_no_free_text(self):
        """§6b The same promise for the new record: a target and a reason from
        a closed set, and nothing a caller can smuggle prose through."""
        obs = liveness.record(target='pid:1', reason='access-denied')
        self.assertEqual({'target', 'state', 'reason', 'observed_at'}, set(obs))
        self.assertIn(obs['reason'], liveness.REASONS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
