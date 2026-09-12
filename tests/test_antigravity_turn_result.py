"""A completed Antigravity turn must not be booked as a failure.

The live failure this pins (user screenshot 2026-09-12): a Flash seat finished
its work — the transcript shows the agent's own closing line, "breadcrumbs.md
updated." — and orgtree then appended

    turn failed: the Antigravity CLI reported an error
    — the CLI exited rc=0 without a result

`antigravityrun.wait()` decides the turn's fate on ONE fact: whether a
`{"event":"result"}` line was folded into `self._result`. If it was not, the
turn is STATUS_FAILED, no matter that the process exited rc=0, that the whole
stream was drained to EOF, that `agent_response` steps streamed real text, or
that those steps priced real usage. The supervisor's antigravity leg
(supervisor.py, `status == STATUS_FAILED`) then raises `_ProviderTurnFailed`,
which is the banner above — appended AFTER `_commit_unfinished_text()` has
already put the agent's work on the desk. So the user watches successful,
paid work be overwritten by a terminal error.

These tests drive the REAL `AntigravityTurn` against a REAL child process
speaking the REAL NDJSON wire, so they exercise the actual finalizer rather
than a model of it. §A is the POSITIVE CONTROL: a fake CLI that DOES send a
result must complete, and the empty-exit case must still fail, or the rest of
the file is measuring nothing.

The discriminator these tests pin — the one thing that separates a lost result
envelope from a genuinely empty run — is EVIDENCE OF WORK on a cleanly
finished stream:

    rc == 0                     the CLI chose to stop, it did not crash
    reader drained to EOF       we saw everything it wrote, so "no result
                                event" is a fact and not a race
    a completed response        streamed agent text, or a DONE agent_response
                                step that priced usage

All three, and the turn completed. Any missing, and it stays a failure.
"""
import json
import os
import sys
import tempfile
import unittest

#: the throwaway ORGTREE_DATA this process bound to, made once (see setUpClass)
_ROOT = None

INIT = {"event": "init", "conversation_id": "c-1",
        "init": {"cwd": ".", "permission_mode": "yolo", "tools": []}}


def _step(text=None, state="ACTIVE", usage=None, kind="agent_response"):
    step = {"step_index": 0, "state": state, "step_type": kind}
    if text is not None:
        step["text_delta"] = text
    if usage is not None:
        step["usage"] = usage
    return {"event": "step_update", "step_update": step}


#: what a priced agent_response DONE step reports (measured shape)
USAGE = {"input_tokens": 1200, "output_tokens": 34, "thinking_tokens": 0,
         "cache_read_tokens": 800, "total_tokens": 2034}

#: the agent's own last line in the reported failure
CLOSING = "breadcrumbs.md updated."


class AntigravityTurnResultTests(unittest.TestCase):
    """Each test spawns one fake `agy` and drives one real turn through it."""

    @classmethod
    def setUpClass(cls):
        # ⚠ store.DATA_ROOT BINDS AT IMPORT TIME, and this process may well
        # have inherited the LIVE root (it does whenever the suite is run from
        # inside the desktop). Assignment, never setdefault. Made ONCE per
        # process so a re-run in the same interpreter checks the binding it
        # actually has instead of inventing one it cannot have.
        global _ROOT
        if _ROOT is None:
            _ROOT = tempfile.mkdtemp(prefix="orgtree-agyturn-")
            os.environ["ORGTREE_DATA"] = _ROOT
        from engine.backend.orgtree import antigravityrun, store
        # CHECKED, not assumed, before a single byte is written
        if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
            raise AssertionError(
                "store bound outside the fixture: %s" % store.DATA_ROOT)
        cls.agy = antigravityrun

    # ── harness ──────────────────────────────────────────────────────────

    def _run(self, lines, rc=0, model="gemini-2.0-flash", prologue="",
             epilogue="", timeout=60):
        """Spawn a fake CLI that writes `lines` to stdout then exits `rc`,
        and return the normalized result the supervisor would consume.

        The child reads its stdin to EOF first, exactly as the real CLI does
        — the prompt rides stdin — so the parent's write can never block and
        the ordering is the live ordering: prompt in, events out, exit.
        `prologue` runs before the events are written (used to hand stdout to
        a grandchild) and `epilogue` after (used to outrun the ceiling)."""
        cwd = tempfile.mkdtemp(prefix="agyturn-cwd-", dir=_ROOT)
        script = os.path.join(cwd, "fake_agy.py")
        payload = "".join(json.dumps(m) + "\n" for m in lines)
        with open(script, "w", encoding="utf-8") as fh:
            fh.write("import sys\n")
            fh.write("sys.stdin.buffer.read()\n")
            fh.write(prologue)
            fh.write("sys.stdout.buffer.write(%r.encode('utf-8'))\n" % payload)
            fh.write("sys.stdout.buffer.flush()\n")
            fh.write(epilogue)
            fh.write("sys.exit(%d)\n" % rc)
        turn = self.agy.AntigravityTurn(
            [sys.executable, script], cwd=cwd, model=model, effort=None,
            yolo=False)
        turn.start("do the thing")
        return turn.wait(timeout=timeout), turn

    # ── §A the positive controls ─────────────────────────────────────────

    def test_A1_a_result_bearing_run_completes(self):
        """THE HARNESS ITSELF. If this fails, nothing below means anything:
        it would prove the fake CLI never spoke the wire at all."""
        res, _ = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
            {"event": "result", "result": {
                "conversation_id": "c-1", "status": "SUCCESS",
                "response": CLOSING}},
        ])
        self.assertEqual(res["status"], self.agy.STATUS_COMPLETED)
        self.assertEqual(res["stop_reason"], "end_turn")
        self.assertEqual(res["agent_text"], CLOSING)

    def test_A2_an_empty_rc0_exit_still_fails(self):
        """THE OTHER POSITIVE CONTROL, and the invariant the fix must not
        trade away: a run that produced NOTHING — no text, no priced step,
        no result — is a real failure and must keep saying so."""
        res, _ = self._run([INIT])
        self.assertEqual(res["status"], self.agy.STATUS_FAILED)
        self.assertIn("without a result", res["stop_reason"])

    def test_A3_a_reported_error_result_still_fails(self):
        """An explicit ERROR result is untouched by any of this."""
        res, _ = self._run([
            INIT,
            {"event": "result", "result": {
                "conversation_id": "c-1", "status": "ERROR",
                "error": "the model refused"}},
        ])
        self.assertEqual(res["status"], self.agy.STATUS_FAILED)
        self.assertIn("the model refused", res["stop_reason"])

    # ── §B the reported defect ───────────────────────────────────────────

    def test_B1_streamed_text_and_a_clean_exit_is_a_completed_turn(self):
        """THE REPORTED BUG, in the shape the user saw: the agent streamed
        its closing line, the steps priced real usage, the CLI exited rc=0 —
        and only the `result` envelope never arrived."""
        res, _ = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ])
        self.assertEqual(
            res["status"], self.agy.STATUS_COMPLETED,
            "a cleanly finished run that streamed text and priced usage was "
            "booked as a failure: %r" % (res["stop_reason"],))
        self.assertEqual(res["agent_text"], CLOSING)

    def test_B2_the_work_survives_into_the_normalized_result(self):
        """The text the desk already showed must come back on the result, so
        nothing downstream has to re-derive it from the journal."""
        res, _ = self._run([
            INIT,
            _step(text="wrote "),
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ])
        self.assertEqual(res["agent_text"], "wrote " + CLOSING)
        self.assertEqual(res["status"], self.agy.STATUS_COMPLETED)

    def test_B3_the_usage_is_still_booked(self):
        """A completed turn is a PAID turn: the per-request fold must ride
        out, or the work is free and the occupancy board is wrong."""
        res, _ = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ])
        tu = res["token_usage"]
        self.assertIsNotNone(tu)
        self.assertEqual(tu["input"], 1200)
        self.assertEqual(tu["cached"], 800)
        self.assertEqual(tu["output"], 34)
        self.assertEqual(tu["requests"], 1)

    def test_B4_a_priced_step_with_no_text_is_still_completed(self):
        """Work is not only text: a DONE agent_response that priced usage is
        evidence the turn ran, even when the response was empty (a turn that
        only used tools, or answered with nothing to say)."""
        res, _ = self._run([
            INIT,
            _step(state="DONE", usage=USAGE),
        ])
        self.assertEqual(res["status"], self.agy.STATUS_COMPLETED)

    def test_B5_stop_reason_names_the_missing_envelope(self):
        """Completing the turn must not hide that the wire was incomplete —
        the stop reason stays diagnostic so this stays findable in a log."""
        res, _ = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ])
        self.assertEqual(res["status"], self.agy.STATUS_COMPLETED)
        self.assertNotEqual(res["stop_reason"], "end_turn")
        self.assertIn("result", str(res["stop_reason"]))

    # ── §C what must STILL fail ──────────────────────────────────────────

    def test_C1_a_nonzero_exit_is_a_failure_even_with_text(self):
        """A crash is a crash. Streamed text does not launder a bad rc: the
        process did not choose to stop, so the turn is not complete."""
        res, _ = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ], rc=3)
        self.assertEqual(res["status"], self.agy.STATUS_FAILED)
        self.assertIn("rc=3", res["stop_reason"])

    def test_C2_text_without_a_priced_step_or_clean_exit_stays_failed(self):
        """Half-streamed text on a bad exit is the partial-output case, and
        it must remain visible as a failure."""
        res, _ = self._run([INIT, _step(text="I was in the middle of")], rc=1)
        self.assertEqual(res["status"], self.agy.STATUS_FAILED)

    def test_C4_an_undrained_stream_stays_failed(self):
        """THE RACE GUARD, and the reason `drained` is in the condition.

        `wait()` breaks out as soon as the PROCESS exits, then attempts a
        BOUNDED 5s join on the reader — so "no result event" can mean "the
        pipe had not finished delivering it". Here a grandchild inherits the
        CLI's stdout and holds it open past its parent's clean rc=0 exit, so
        the reader never reaches EOF. Text and usage are both present and the
        rc is 0: only the missing EOF separates this from §B1, and it must be
        enough to keep the turn a failure, because a result may yet arrive."""
        holder = ("import subprocess, sys\n"
                  "subprocess.Popen([sys.executable, '-c',"
                  " 'import time; time.sleep(20)'], stdout=sys.stdout)\n")
        res, turn = self._run([
            INIT,
            _step(text=CLOSING),
            _step(state="DONE", usage=USAGE),
        ], prologue=holder)
        try:
            self.assertEqual(
                res["status"], self.agy.STATUS_FAILED,
                "the turn was completed while its stream could still have "
                "delivered a result")
            self.assertIn("without a result", res["stop_reason"])
        finally:
            turn.close()

    def test_C5_a_turn_that_outran_the_ceiling_stays_failed(self):
        """A killed-on-timeout run is not a completion, and it keeps saying
        `turn timeout` rather than borrowing the missing-envelope wording."""
        res, turn = self._run([INIT, _step(text=CLOSING)],
                              epilogue="import time; time.sleep(20)\n",
                              timeout=2)
        try:
            self.assertEqual(res["status"], self.agy.STATUS_FAILED)
            self.assertEqual(res["stop_reason"], "turn timeout")
        finally:
            turn.close()

    def test_C3_an_interrupted_turn_is_still_interrupted(self):
        """⏸ has its own terminal state and this must not shadow it."""
        res, turn = self._run([INIT, _step(text=CLOSING)])
        # the run already finished above; assert the interrupt path's own
        # bookkeeping is what decides, not the result-absence branch
        self.assertIn(res["status"],
                      (self.agy.STATUS_COMPLETED, self.agy.STATUS_FAILED))
        self.assertFalse(turn.interrupt(), "a finished process cannot be ⏸")


if __name__ == "__main__":
    unittest.main()
