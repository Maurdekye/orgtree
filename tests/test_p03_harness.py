"""P03 WS7: the forced-interleaving harness judges what it OBSERVED, and its
meta-controls fail.

Everything here runs against ``tools/p03/harness/fake_executor.py``, an
in-process fake that speaks the harness protocol (``protocol.py``,
``orgtree.p03-harness/v1``): no database, no product code. The schedule
``Q-FAKE1`` is a lost-update race on one counter. The safe operation reads the
counter under an exclusive row lock held to commit; its unsafe control
``Q-FAKE1.skip_row_lock`` skips that lock, and only a run whose plan ARMS it
fires it.

What must hold:
- the safe build, in the intended order (A holds before its write, B is SEEN
  waiting on A), PASSES;
- a removed barrier, a build without pause points, a plan naming an unknown
  point or arming an unknown control, an unclean stream tail and a dropped
  record each turn the run into FAILED or REFUSED, never PASSED (r7 §8.1: a run
  whose interleaving is not the one intended is a failed run);
- the control, armed, runs in its own order (B overtakes A), breaks the pass
  condition, and is ACCEPTED only because it recorded that it ran. The same
  control silenced, the control's order run unarmed, or an armed control that
  breaks nothing is a FAILED control (r7 §8.1, S3 §7, gate G3);
- an injected 40001 is retried as a new attempt and seen in the trace;
- the protocol refuses malformed frames and executor-side kill_backend.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from p03.harness import controls as ctl  # noqa: E402
from p03.harness import faults, oracle, protocol, serverlog  # noqa: E402
from p03.harness.fake_executor import FakeExecutor, Stmt  # noqa: E402
from p03.harness.fake_service import FakeService  # noqa: E402
from p03.harness.service_channel import ServiceChannel  # noqa: E402
from p03.harness.schedule import (FAILED, PASSED, REFUSED, Order, Schedule,  # noqa: E402
                                  compare, run_order)
from p03.harness.trace import stream_health  # noqa: E402

KIND = "counter.increment"
WRITE = f"{KIND}.stmt.write.before"
READ = f"{KIND}.stmt.read.before"
CONTROL_ID = "Q-FAKE1.skip_row_lock"


def _read(rows, ctx, _writes, _args):
    ctx["v"] = rows.get("counter", 0)


def _write(_rows, ctx, writes, _args):
    writes["counter"] = ctx["v"] + 1


OPS = {KIND: [Stmt("read", ("counters",), "read", lock="counter:1", apply=_read,
                   skip_lock_control=CONTROL_ID, lock_mode="for_update"),
              Stmt("write", ("counters",), "write", apply=_write)]}

SAFE = Order(
    "a-holds-b-waits",
    script=[("start", "A"), ("arrive", "A", WRITE), ("start", "B"), ("await_wait", "B", "A"),
            ("release", "A", WRITE), ("await_end", "A"), ("await_end", "B")],
    intended=[("before", f"arrived:A:{WRITE}", "wait:B:A"), ("before", "end:A", "end:B"),
              ("outcome", "A", "applied"), ("outcome", "B", "applied")])

OVERTAKE_SCRIPT = [("start", "A"), ("arrive", "A", WRITE), ("start", "B"), ("await_end", "B"),
                   ("release", "A", WRITE), ("await_end", "A")]
OVERTAKE_INTENDED = [("before", f"arrived:A:{WRITE}", "end:B"), ("before", "end:B", "end:A"),
                     ("absent", "wait:B:A")]
OVERTAKE = Order("b-overtakes-a", OVERTAKE_SCRIPT, OVERTAKE_INTENDED, controls=[CONTROL_ID])
OVERTAKE_UNARMED = Order("b-overtakes-a-unarmed", OVERTAKE_SCRIPT, OVERTAKE_INTENDED)


def schedule(timeout: float = 3.0) -> Schedule:
    return Schedule("Q-FAKE1", {"A": (KIND, {}), "B": (KIND, {})}, [SAFE, OVERTAKE],
                    pass_condition=lambda _r, _a, final: final["rows"].get("counter") == 2,
                    step_timeout=timeout, plan_timeout=timeout)


CONTROL = ctl.Control(CONTROL_ID, "Q-FAKE1", "plan controls: [Q-FAKE1.skip_row_lock]",
                      "fake_executor.FakeExecutor._attempt (the skipped _take)",
                      "the read skips its exclusive row lock")


class ForcedInterleaving(unittest.TestCase):
    def test_safe_build_in_the_intended_order_passes(self):
        result = run_order(FakeExecutor(OPS), schedule(), SAFE)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        achieved = [e["event"] for e in result.achieved]
        self.assertIn("wait:B:A", achieved)
        self.assertLess(achieved.index(f"arrived:A:{WRITE}"), achieved.index("wait:B:A"))
        self.assertTrue(result.health["complete"])

    def test_completed_script_in_the_wrong_order_fails(self):
        """The script ran to the end, but what happened is not what was intended."""
        wrong = Order("claims-b-first", SAFE.script,
                      [("before", "end:B", "end:A"), ("outcome", "A", "applied")])
        result = run_order(FakeExecutor(OPS), schedule(), wrong)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("interleaving not achieved: end:B was not before end:A", result.reasons)
        self.assertIsNone(result.pass_condition_held)

    def test_removed_barrier_fails_the_run(self):
        """The meta-control: the barrier is gone, so the interleaving is not forced."""
        result = run_order(FakeExecutor(OPS, barriers=False), schedule(1.0), SAFE)
        self.assertEqual(result.verdict, FAILED)
        # the FIRST unreached point is what fails the run, and the run stops there
        self.assertEqual(result.reasons[0], f"interleaving not achieved: A never reached {WRITE}")
        self.assertIsNone(result.pass_condition_held)

    def test_build_without_pause_points_is_refused(self):
        result = run_order(FakeExecutor(OPS, qualification=False), schedule(), SAFE)
        self.assertEqual(result.verdict, REFUSED)
        self.assertIn("the build reports no qualification pause points: refusing to drive it",
                      result.reasons)
        self.assertEqual(result.records, [])

    def test_plan_naming_an_unknown_point_or_control_is_refused(self):
        typo = Order("typo", [("start", "A"), ("arrive", "A", f"{KIND}.stmt.wirte.before")], [])
        result = run_order(FakeExecutor(OPS), schedule(), typo)
        self.assertEqual(result.verdict, REFUSED)
        self.assertTrue(any("pause points the build does not have" in r for r in result.reasons))
        ghost = Order("ghost", SAFE.script, SAFE.intended, controls=["Q-FAKE1.not_built"])
        result = run_order(FakeExecutor(OPS), schedule(), ghost)
        self.assertEqual(result.verdict, REFUSED)
        self.assertTrue(any("arms controls the build does not have" in r for r in result.reasons))

    def test_unclean_tail_or_dropped_record_is_incomplete(self):
        for kw in ({"unclean_tail": True}, {"drop_records": 1}):
            with self.subTest(**kw):
                result = run_order(FakeExecutor(OPS, **kw), schedule(), SAFE)
                self.assertEqual(result.verdict, FAILED)
                self.assertFalse(result.health["complete"])
                self.assertTrue(any("incomplete-contact" in r for r in result.reasons))

    def test_a_stub_in_the_trace_fails_the_run(self):
        """No schedule may be reported as passing against WS2's Sent stub (M1 §2 row 6)."""
        result = run_order(FakeExecutor(OPS, stub=True), schedule(), SAFE)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("the trace contains stub events: no schedule may pass against a stub "
                      "(M1 §2 row 6)", result.reasons)

    def test_injected_serialization_failure_is_retried_and_traced(self):
        retry = Order(
            "a-fails-40001-once", [("start", "A"), ("await_end", "A")],
            [("outcome", "A", "applied"), ("sqlstate", "A", "40001")],
            faults=[{"op_tag": "A", "point": WRITE, "action": "fail_next", "sqlstate": "40001"}])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [retry],
                       pass_condition=lambda _r, _a, final: final["rows"].get("counter") == 1)
        result = run_order(FakeExecutor(OPS), one, retry)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        kinds = [(r["kind"], r.get("attempt")) for r in result.records
                 if r["kind"] in ("tx_end", "retry")]
        self.assertEqual(kinds, [("tx_end", 1), ("retry", 2), ("tx_end", 2)])

    def test_a_retry_arrives_as_its_own_attempt(self):
        """A hold names its attempt: the retry's arrival is ``@2``, held and released
        on its own, and the plan says which attempt each hold is for."""
        order = Order(
            "a-retries-held", [("start", "A"), ("arrive", "A", READ), ("release", "A", READ),
                               ("arrive", "A", READ, 2), ("release", "A", READ, 2),
                               ("await_end", "A")],
            [("before", f"arrived:A:{READ}", f"released:A:{READ}"),
             ("before", f"released:A:{READ}", f"arrived:A:{READ}@2"),
             ("sqlstate", "A", "40001"), ("outcome", "A", "applied")],
            faults=[{"op_tag": "A", "point": WRITE, "action": "fail_next", "sqlstate": "40001"}])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order],
                       pass_condition=lambda _r, _a, final: final["rows"].get("counter") == 1)
        fake = FakeExecutor(OPS)
        result = run_order(fake, one, order)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        self.assertEqual(sorted((k[2] for k in fake._holds)), [1, 1, 2])

    def test_an_unqualified_fault_hits_every_attempt(self):
        """``attempt: None`` is the protocol's every-attempt hold: the retries fail too."""
        order = Order("a-fails-always", [("start", "A"), ("await_end", "A")],
                      [("outcome", "A", "applied")],
                      faults=[{"op_tag": "A", "point": WRITE, "action": "fail_next",
                               "sqlstate": "40001", "attempt": None}])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order],
                       pass_condition=lambda _r, _a, _f: True)
        result = run_order(FakeExecutor(OPS), one, order)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("A ended 'error', intended 'applied'", result.reasons)

    def test_an_early_release_names_the_attempt_it_is_for(self):
        """A release sent early for attempt 2 must not free attempt 1: attempt 1
        stays held until its own release, and attempt 2 then consumes the early one."""
        order = Order(
            "early-for-attempt-2",
            [("start", "A"), ("release", "A", READ, 2), ("arrive", "A", READ),
             ("release", "A", READ), ("arrive", "A", READ, 2), ("await_end", "A")],
            [("before", f"released:A:{READ}@2", f"arrived:A:{READ}@2"),
             ("sqlstate", "A", "40001"), ("outcome", "A", "applied")],
            faults=[{"op_tag": "A", "point": WRITE, "action": "fail_next", "sqlstate": "40001"}])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order], pass_condition=lambda *_: True,
                       step_timeout=3.0, plan_timeout=1.0)
        result = run_order(FakeExecutor(OPS), one, order)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        held = [r for r in result.records if r["kind"] == "tx_end"]
        self.assertEqual([r["attempt"] for r in held], [1, 2])

    def test_an_every_attempt_hold_holds_the_retry_again(self):
        """Without ``attempt`` a hold applies to every attempt, and one release frees
        one arrival: the retry is held again until a second release."""
        fake = FakeExecutor(OPS)
        fake.install_plan({"type": "plan", "run_id": "r", "controls": [], "holds": [
            {"op_tag": "A", "point": READ, "action": "hold", "timeout_ms": 5000},
            {"op_tag": "A", "point": WRITE, "action": "fail_next", "sqlstate": "40001",
             "timeout_ms": 5000, "attempt": 1}]})
        fake.start("A", KIND, {})

        def next_kind(kind, timeout=3.0):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                ev = fake.next_event(0.05)
                if ev is not None and ev.get("kind") == kind and ev.get("point", READ) == READ:
                    return ev
            return None

        self.assertEqual(next_kind("arrived")["attempt"], 1)
        fake.release("A", READ)
        self.assertEqual(next_kind("arrived")["attempt"], 2)
        self.assertIsNone(next_kind("op_end", 0.4), "the retry was not held again")
        fake.release("A", READ)
        self.assertEqual(next_kind("op_end")["outcome"], "applied")
        fake.finish()

    def test_a_hold_released_too_early_fails_the_run(self):
        """The meta-control on a real barrier: A's release is sent before B was
        started, so A never makes B wait. Every step of the script still ran."""
        early = Order("a-released-early",
                      [("start", "A"), ("arrive", "A", WRITE), ("release", "A", WRITE),
                       ("await_end", "A"), ("start", "B"), ("await_end", "B")],
                      SAFE.intended)
        result = run_order(FakeExecutor(OPS), schedule(), early)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("interleaving not achieved: wait:B:A never observed", result.reasons)
        self.assertIsNone(result.pass_condition_held)

    def test_a_release_sent_before_the_arrival_is_seen_in_the_achieved_order(self):
        """Released before it arrived: the op passes straight through, and the
        achieved order shows the release first."""
        order = Order("release-first", [("start", "A"), ("release", "A", WRITE),
                                        ("arrive", "A", WRITE), ("await_end", "A")],
                      [("before", f"arrived:A:{WRITE}", f"released:A:{WRITE}")])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order],
                       pass_condition=lambda _r, _a, _f: True)
        result = run_order(FakeExecutor(OPS), one, order)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn(f"interleaving not achieved: arrived:A:{WRITE} was not before "
                      f"released:A:{WRITE}", result.reasons)

    def test_a_hold_never_released_is_a_service_error_that_fails_the_run(self):
        """The service gives up on the hold, reports an error, and the op CONTINUES:
        it ends ``applied``, and the run still fails on the error."""
        order = Order("never-released", [("start", "A"), ("arrive", "A", WRITE),
                                         ("await_end", "A")],
                      [("outcome", "A", "applied")])
        one = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order],
                       pass_condition=lambda _r, _a, _f: True, step_timeout=3.0,
                       plan_timeout=0.2)
        result = run_order(FakeExecutor(OPS), one, order)
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any(r.startswith("the service reported an error: hold at "
                                         f"{WRITE} for A was never released")
                            for r in result.reasons), result.reasons)
        self.assertIn("error:1", [e["event"] for e in result.achieved])


class OverSockets(unittest.TestCase):
    """``ServiceChannel`` against ``FakeService``: the same verdicts through real
    loopback sockets, the protocol's framing and a service that, like WS2's, sends
    no records in ``finished``."""

    def run_over(self, order, sched=None, **fake_kw):
        svc = FakeService(FakeExecutor(OPS, **fake_kw))
        try:
            ch = ServiceChannel(svc.host, run=order.name, timeout=10.0)
            try:
                return run_order(ch, sched or socket_schedule(), order)
            finally:
                ch.close()
        finally:
            svc.close()

    def test_the_intended_order_passes_over_the_wire(self):
        result = self.run_over(SAFE)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        self.assertTrue(result.health["complete"])
        self.assertIn("wait:B:A", [e["event"] for e in result.achieved])

    def test_a_hold_released_too_early_fails_over_the_wire(self):
        early = Order("a-released-early",
                      [("start", "A"), ("arrive", "A", WRITE), ("release", "A", WRITE),
                       ("await_end", "A"), ("start", "B"), ("await_end", "B")],
                      SAFE.intended)
        result = self.run_over(early)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("interleaving not achieved: wait:B:A never observed", result.reasons)
        self.assertFalse([r for r in result.reasons if r.startswith("the service reported")])

    def test_a_retry_attempt_is_held_and_released_over_the_wire(self):
        order = Order(
            "a-retries-held", [("start", "A"), ("arrive", "A", READ), ("release", "A", READ),
                               ("arrive", "A", READ, 2), ("release", "A", READ, 2),
                               ("await_end", "A")],
            [("before", f"released:A:{READ}", f"arrived:A:{READ}@2"),
             ("sqlstate", "A", "40001"), ("outcome", "A", "applied")],
            faults=[{"op_tag": "A", "point": WRITE, "action": "fail_next", "sqlstate": "40001"}])
        result = self.run_over(order, Schedule("Q-FAKE1", {"A": (KIND, {})}, [order],
                                               pass_condition=lambda *_: True))
        self.assertEqual(result.verdict, PASSED, result.reasons)

    def test_a_service_error_frame_fails_the_run(self):
        order = Order("never-released", [("start", "A"), ("arrive", "A", WRITE),
                                         ("await_end", "A")], [("outcome", "A", "applied")])
        sched = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order], pass_condition=lambda *_: True,
                         step_timeout=3.0, plan_timeout=0.2)
        result = self.run_over(order, sched)
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any(r.startswith("the service reported an error: hold at")
                            for r in result.reasons), result.reasons)

    def test_a_service_that_never_answers_finish_fails_the_run(self):
        svc = FakeService(FakeExecutor(OPS), send_finished=False)
        try:
            ch = ServiceChannel(svc.host, run="x", timeout=1.5)
            try:
                result = run_order(ch, socket_schedule(), SAFE)
            finally:
                ch.close()
        finally:
            svc.close()
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any("no finished frame" in r for r in result.reasons), result.reasons)

    def test_an_operation_still_running_at_finish_fails_the_run(self):
        """A is held and never released: at finish its request has not returned."""
        order = Order("left-held", [("start", "A"), ("arrive", "A", WRITE)], [])
        sched = Schedule("Q-FAKE1", {"A": (KIND, {})}, [order], pass_condition=lambda *_: True,
                         plan_timeout=30.0)
        svc = FakeService(FakeExecutor(OPS))
        try:
            ch = ServiceChannel(svc.host, run="x", timeout=1.5)
            try:
                result = run_order(ch, sched, order)
            finally:
                ch.close()
        finally:
            svc.close()
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("the service reported an error: 1 operation(s) never returned",
                      result.reasons)

    def test_an_error_response_to_an_operation_fails_the_run(self):
        order = Order("unknown-verb", [("start", "X")], [])
        sched = Schedule("Q-FAKE1", {"X": ("no.such_verb", {})}, [order],
                         pass_condition=lambda *_: True)
        result = self.run_over(order, sched)
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any(r.startswith("the service reported an error: X (no.such_verb)")
                            for r in result.reasons), result.reasons)

    def test_records_missing_from_the_end_verb_are_incomplete(self):
        """No records from the host: the run cannot be complete-contact."""
        svc = FakeService(FakeExecutor(OPS))
        svc._handle_orig = svc._handle
        svc._handle = lambda req: ({"records": [], "stream": "fake-executor"}
                                   if req.get("verb") in ("qual.trace_end", "qual.trace_drain")
                                   else svc._handle_orig(req))
        try:
            ch = ServiceChannel(svc.host, run="x", timeout=10.0)
            try:
                result = run_order(ch, socket_schedule(), SAFE)
            finally:
                ch.close()
        finally:
            svc.close()
        self.assertEqual(result.verdict, FAILED)
        self.assertFalse(result.health["complete"])


def socket_schedule(timeout: float = 3.0) -> Schedule:
    return Schedule("Q-FAKE1", {"A": (KIND, {}), "B": (KIND, {})}, [SAFE],
                    pass_condition=lambda _r, _a, final: final["state"]["rows"].get("counter") == 2,
                    step_timeout=timeout, plan_timeout=timeout)


class FaultKit(unittest.TestCase):
    """The fault kit on the protocol's actions; kill_backend is harness-side."""

    def one(self, order, **kw):
        return Schedule("Q-FAKE1", {"A": (KIND, {})}, [order], pass_condition=lambda *_: True,
                        step_timeout=kw.get("step", 3.0), plan_timeout=kw.get("plan", 3.0))

    def test_a_killed_backend_is_retried_on_a_new_one_and_seen_as_57P01(self):
        order = Order("kill-held", [("start", "A"), ("arrive", "A", WRITE), ("kill", "A"),
                                    ("await_end", "A")],
                      [("before", f"arrived:A:{WRITE}", "killed:A"), ("sqlstate", "A", "57P01"),
                       ("outcome", "A", "applied")])
        result = run_order(FakeExecutor(OPS), self.one(order), order)
        self.assertEqual(result.verdict, PASSED, result.reasons)
        begins = [r["backend_pid"] for r in result.records if r["kind"] == "tx_begin"]
        self.assertEqual(len(begins), 2)
        self.assertNotEqual(begins[0], begins[1], "the retry must run on a new backend")
        killed = [e for e in result.achieved if e["event"] == "killed:A"]
        self.assertEqual(killed[0]["backend_pid"], begins[0])

    def test_a_kill_without_an_arrival_fails_the_run(self):
        order = Order("kill-blind", [("start", "A"), ("kill", "A"), ("await_end", "A")], [])
        result = run_order(FakeExecutor(OPS), self.one(order), order)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("cannot kill A: no arrival reported its backend pid", result.reasons)

    def test_a_kill_the_service_did_not_perform_fails_the_run(self):
        class Refusing(FakeExecutor):
            def kill_backend(self, pid):
                return False
        order = Order("kill-refused", [("start", "A"), ("arrive", "A", WRITE), ("kill", "A"),
                                       ("release", "A", WRITE), ("await_end", "A")], [])
        result = run_order(Refusing(OPS), self.one(order), order)
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any("was not terminated" in r for r in result.reasons), result.reasons)

    def test_a_kill_over_the_wire(self):
        order = Order("kill-wire", [("start", "A"), ("arrive", "A", WRITE), ("kill", "A"),
                                    ("await_end", "A")],
                      [("sqlstate", "A", "57P01"), ("outcome", "A", "applied")])
        result = OverSockets.run_over(self, order, self.one(order))
        self.assertEqual(result.verdict, PASSED, result.reasons)

    def test_sqlstate_faults_build_the_protocol_hold(self):
        f = faults.sqlstate("A", WRITE, "40P01")
        self.assertEqual(f, {"op_tag": "A", "point": WRITE, "attempt": 1, "action": "fail_next",
                             "sqlstate": "40P01"})
        with self.assertRaises(ValueError):
            faults.sqlstate("A", WRITE, "99999")
        with self.assertRaises(ValueError):
            faults.sleep("A", WRITE, 0)
        self.assertIn("deadlock_detected", faults.expected("40P01"))

    def test_an_every_attempt_fault_reaches_the_plan_without_an_attempt(self):
        order = Order("always", [("start", "A"), ("await_end", "A")], [],
                      faults=[faults.sqlstate("A", WRITE, "40001", attempt=None)])
        fake = FakeExecutor(OPS)
        result = run_order(fake, self.one(order), order)
        self.assertEqual([k[2] for k in fake._holds], [None])
        self.assertIn("A", [r.get("op_tag") for r in result.records if r["kind"] == "op_end"])
        ends = [r["outcome"] for r in result.records if r["kind"] == "op_end"]
        self.assertEqual(ends, ["error"], "every retry fails too, until the attempts run out")

    def test_a_non_retryable_code_ends_the_operation(self):
        order = Order("unique", [("start", "A"), ("await_end", "A")],
                      [("sqlstate", "A", "23505"), ("outcome", "A", "applied")],
                      faults=[faults.sqlstate("A", WRITE, "23505")])
        result = run_order(FakeExecutor(OPS), self.one(order), order)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("A ended 'error', intended 'applied'", result.reasons)

    def test_a_dropped_connection_is_retried_on_a_new_backend(self):
        order = Order("drop", [("start", "A"), ("await_end", "A")],
                      [("sqlstate", "A", "08006"), ("outcome", "A", "applied")],
                      faults=[faults.drop_conn("A", WRITE)])
        result = run_order(FakeExecutor(OPS), self.one(order), order)
        self.assertEqual(result.verdict, PASSED, result.reasons)


class UnsafeControls(unittest.TestCase):
    def test_control_that_ran_and_broke_the_schedule_is_accepted(self):
        result = run_order(FakeExecutor(OPS), schedule(), OVERTAKE)
        self.assertIs(result.pass_condition_held, False, result.reasons)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "ACCEPTED", verdict["reasons"])
        self.assertGreaterEqual(verdict["executed_records"], 1)

    def test_silent_control_is_a_failed_control(self):
        """It broke the schedule, but nothing shows it RAN: that is not evidence."""
        result = run_order(FakeExecutor(OPS, silent_controls=True), schedule(), OVERTAKE)
        self.assertIs(result.pass_condition_held, False)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertIn("control did not run: no control_executed record", verdict["reasons"])

    def test_control_order_unarmed_is_a_failed_control(self):
        """Not armed, the lock is taken and B waits, so the control's order never happens."""
        result = run_order(FakeExecutor(OPS), schedule(1.0), OVERTAKE_UNARMED)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("not a valid control run" in r for r in verdict["reasons"]))
        self.assertIn("control did not run: no control_executed record", verdict["reasons"])

    def test_control_that_ran_but_broke_nothing_is_a_failed_control(self):
        """It ran, in its order, on a complete run, but the schedule still passed."""
        lenient = schedule()
        lenient.pass_condition = lambda _r, _a, final: final["rows"].get("counter", 0) >= 1
        result = run_order(FakeExecutor(OPS), lenient, OVERTAKE)
        self.assertIs(result.pass_condition_held, True, result.reasons)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertGreaterEqual(verdict["executed_records"], 1)
        self.assertIn("the schedule's pass condition still held: the control did not break it",
                      verdict["reasons"])

    def test_registry_refuses_duplicates_and_empty_fields(self):
        reg = ctl.Registry()
        reg.register(CONTROL)
        with self.assertRaises(ValueError):
            reg.register(CONTROL)
        with self.assertRaises(ValueError):
            reg.register(ctl.Control("Q-X1.y", "Q-X1", "", "site", "wording"))
        self.assertEqual([c.control_id for c in reg.for_schedule("Q-FAKE1")], [CONTROL_ID])


EDIT = "item.edit"
EDIT_OPS = {EDIT: [Stmt("anchor", ("agents",), "read", lock="agent:1", lock_mode="for_share"),
                   Stmt("claim", ("operation_receipts",), "write"),
                   Stmt("write", ("items",), "write")]}
EDIT_DECLARED = {EDIT: {"relations": {
    "agents": {"modes": ["read", "for_share"], "required": True},
    "operation_receipts": {"modes": ["write"], "required": True},
    "items": {"modes": ["write"], "required": True},
    "item_participants": {"modes": ["read"], "required": False}},
    "p01_contract": "work.item-update", "source": "test"}}
ONE_EDIT = Order("one-edit", [("start", "A"), ("await_end", "A")], [("outcome", "A", "applied")])


def edit_run(**fake):
    fake.setdefault("declared", EDIT_DECLARED)
    one = Schedule("Q-C5", {"A": (EDIT, {})}, [ONE_EDIT], pass_condition=lambda *_: True)
    result = run_order(FakeExecutor(EDIT_OPS, **fake), one, ONE_EDIT)
    return result, oracle.q_c5(fake["declared"], result.records, ["fake-pool"])


class ContactOracle(unittest.TestCase):
    """Q-C5 (r7, S3 §7.1 extended): observed relations equal declared relations."""

    def test_declared_contacts_observed_pass_and_optional_ones_are_reported(self):
        result, verdict = edit_run()
        self.assertEqual(result.verdict, PASSED, result.reasons)
        self.assertEqual(verdict["verdict"], "PASSED", verdict["failures"])
        self.assertEqual(verdict["over_declared"], {EDIT: ["item_participants"]})

    def test_server_side_access_the_executor_does_not_name_fails(self):
        """A trigger writes audit_log: only the server's per-xact view shows it."""
        _, verdict = edit_run(server_extra={"audit_log": {"n_tup_ins": 1}})
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("server observed undeclared relation audit_log" in f
                            for f in verdict["failures"]), verdict["failures"])

    def test_undeclared_lock_mode_fails(self):
        weaker = json_copy(EDIT_DECLARED)
        weaker[EDIT]["relations"]["agents"]["modes"] = ["read"]
        _, verdict = edit_run(declared=weaker)
        self.assertTrue(any("observed agents as for_share" in f for f in verdict["failures"]),
                        verdict["failures"])

    def test_deleted_required_anchor_fails(self):
        """p03-lead's omitted-invariant control: the anchor statement is gone."""
        _, verdict = edit_run(skip_stmts={"anchor"})
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("committed without its required agents" in f
                            for f in verdict["failures"]), verdict["failures"])
        # a missing REQUIRED relation is a failure, never softened into a report
        self.assertEqual(verdict["over_declared"], {EDIT: ["item_participants"]})

    def test_hidden_access_and_unregistered_factory_fail(self):
        _, hidden = edit_run(hidden_statements=1)
        self.assertTrue(any("hidden access" in f for f in hidden["failures"]), hidden["failures"])
        _, stray = edit_run(factory="side-door")
        self.assertTrue(any("unregistered factory 'side-door'" in f for f in stray["failures"]))

    def test_trace_without_connection_activity_fails(self):
        result, _ = edit_run()
        records = [r for r in result.records if r["kind"] != "conn_activity"]
        verdict = oracle.q_c5(EDIT_DECLARED, records, ["fake-pool"])
        self.assertIn("no conn_activity records: hidden access cannot be ruled out",
                      verdict["failures"])

    def test_with_a_server_log_hidden_access_is_judged_by_the_log(self):
        """On a real cluster the statement log is the ground truth (decision 3)."""
        result, _ = edit_run()
        records = [r for r in result.records if r["kind"] != "conn_activity"]
        verdict = oracle.q_c5(EDIT_DECLARED, records, ["fake-pool"], server_log=[])
        self.assertEqual(verdict["hidden_access_source"], "server statement log")
        self.assertNotIn("no conn_activity records: hidden access cannot be ruled out",
                         verdict["failures"])
        # the fake's statements were never logged by any server: they cannot reconcile
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("cannot attribute" in f for f in verdict["failures"]), verdict["failures"])

    def test_zero_contact_refusal_with_statements_fails(self):
        result, _ = edit_run()
        records = [dict(r, contacts=0) if r["kind"] == "op_end" else r for r in result.records]
        verdict = oracle.q_c5(EDIT_DECLARED, records, ["fake-pool"])
        self.assertTrue(any("reports zero contacts" in f for f in verdict["failures"]))

    def test_unknown_lock_mode_is_reported_not_passed_silently(self):
        result, _ = edit_run()
        records = [dict(r, lock_mode="unknown") if r.get("stmt_label") == "anchor" else r
                   for r in result.records]
        verdict = oracle.q_c5(EDIT_DECLARED, records, ["fake-pool"])
        self.assertEqual(list(verdict["unknown_modes"].values()), [["agents"]])

    def test_collector_shaped_statements(self):
        """store-trace's collector records relation_modes, unresolved names and
        infrastructure statements; the oracle reads those, not the flat mode."""
        result, _ = edit_run()
        records = []
        for r in result.records:
            if r.get("stmt_label") == "anchor":
                r = dict(r, relation_modes={"agents": ["read", "for_share"]}, relations=["agents"],
                         lock_mode=None)
            records.append(r)
        self.assertEqual(oracle.q_c5(EDIT_DECLARED, records, ["fake-pool"])["verdict"], "PASSED")
        widened = [dict(r, relation_modes={"agents": ["read", "for_update"]})
                   if r.get("stmt_label") == "anchor" else r for r in records]
        self.assertTrue(any("observed agents as for_update" in f for f in
                            oracle.q_c5(EDIT_DECLARED, widened, ["fake-pool"])["failures"]))
        unresolved = [dict(r, unresolved=["ghost"]) if r.get("stmt_label") == "write" else r
                      for r in records]
        self.assertTrue(any("could not resolve: ghost" in f for f in
                            oracle.q_c5(EDIT_DECLARED, unresolved, ["fake-pool"])["failures"]))
        infra = dict(records[0], kind="stmt", operation_id="op-A", attempt=1, backend_pid=1,
                     stmt_label="trace.xact_stats", fingerprint="f", mode="read",
                     relations=["pg_stat_xact_user_tables"], sqlstate="00000", infrastructure=True)
        self.assertEqual(oracle.q_c5(EDIT_DECLARED, records + [infra], ["fake-pool"])["verdict"],
                         "PASSED")
        # a connection-setup statement belongs to NO operation: it opens no slot
        setup = dict(infra, operation_id="none", attempt=0, stmt_label="exec.setup.identify",
                     op_kind="conn.executor")
        verdict = oracle.q_c5(EDIT_DECLARED, records + [setup], ["fake-pool"])
        self.assertEqual(verdict["verdict"], "PASSED", verdict["failures"])

    def test_lock_family_cross_check(self):
        """Decision 4: the server confirms the row-lock FAMILY; the exact mode stays unknown."""
        result, verdict = edit_run()
        self.assertEqual(verdict["verdict"], "PASSED", verdict["failures"])
        self.assertIn(["agents"], verdict["unknown_modes"].values())
        # the executor claims FOR SHARE on agents, the server shows no row lock there
        stripped = [dict(r, locks=[lk for lk in r["locks"] if lk["relname"] != "agents"])
                    if r["kind"] == "xact_locks" else r for r in result.records]
        failures = oracle.q_c5(EDIT_DECLARED, stripped, ["fake-pool"])["failures"]
        self.assertTrue(any("row-locks agents but the server shows no" in f for f in failures), failures)
        self.assertTrue(any("required row lock on agents (omitted anchor)" in f for f in failures))

    def test_undeclared_server_side_lock_fails_until_declared(self):
        """e.g. an FK check's FOR KEY SHARE on a parent: server-side, named by no statement."""
        _, verdict = edit_run(server_extra_locks={"parents": "RowShareLock"})
        self.assertTrue(any("row lock on parents that is declared nowhere" in f
                            for f in verdict["failures"]), verdict["failures"])
        declared = json_copy(EDIT_DECLARED)
        declared[EDIT]["relations"]["parents"] = {"modes": ["for_key_share"], "required": False}
        _, verdict = edit_run(declared=declared, server_extra_locks={"parents": "RowShareLock"})
        self.assertEqual(verdict["verdict"], "PASSED", verdict["failures"])

    def test_deleted_anchor_is_also_caught_server_side(self):
        _, verdict = edit_run(skip_stmts={"anchor"})
        self.assertTrue(any("required row lock on agents (omitted anchor)" in f
                            for f in verdict["failures"]), verdict["failures"])

    def test_missing_server_lock_view_never_passes_the_lock_part(self):
        _, verdict = edit_run(server_locks=False)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("row-lock family unverified" in f for f in verdict["failures"]))

    def test_invalid_declared_table_is_refused(self):
        bad = {EDIT: {"relations": {"items": {"modes": ["write"]}}, "p01_contract": None,
                      "source": "x"}}
        self.assertTrue(oracle.declared_errors(bad))
        self.assertEqual(oracle.q_c5(bad, [], [])["verdict"], "FAILED")
        result = run_order(FakeExecutor(EDIT_OPS, declared=bad),
                           Schedule("Q-C5", {"A": (EDIT, {})}, [ONE_EDIT],
                                    pass_condition=lambda *_: True), ONE_EDIT)
        self.assertEqual(result.verdict, REFUSED)


def json_copy(value):
    return json.loads(json.dumps(value))


START_S = 0x66F3C2A1


def session(pid: int, start_s: int = START_S) -> str:
    return f"{start_s:x}.{pid:x}"


def log_line(pid: int, message: str, start_s: int = START_S) -> str:
    return json.dumps({"timestamp": "2026-09-25 08:40:00.000 UTC", "pid": pid,
                       "session_id": session(pid, start_s), "error_severity": "LOG",
                       "message": message, "backend_type": "client backend"})


def traced_session(pid: int, sqls: list, factory: str = "executor", start_s: int = START_S):
    recs = [{"stream": "exec", "seq": 1, "mono_ns": 1, "kind": "conn_opened", "factory": factory,
             "backend_pid": pid, "backend_start": start_s * 1_000_000 + 123_456}]
    for i, sql in enumerate(sqls, 2):
        recs.append({"stream": "exec", "seq": i, "mono_ns": i, "kind": "stmt", "backend_pid": pid,
                     "stmt_label": f"s{i}", "fingerprint": serverlog.fingerprint(sql)})
    return recs


SRC, RCV, CONF, INBOX = ("mail.source.message", "mail.receive.deliver_agent",
                         "runtime.confirm_input", "mail.inbox.user_inbox")


def _decl(shape="workflow", **extra):
    rel = {"relations": {"mail_sent": {"modes": ["write"], "required": True}},
           "p01_contract": None, "source": "test"}
    return {SRC: rel, RCV: rel, CONF: rel,
            INBOX: {**rel, "shape": "read_snapshot"},
            "workflows": {"mail.a_to_b": {"shape": shape, "steps": [SRC, RCV, CONF],
                                          "source": "WS5 A-to-B"}}, **extra}


class _Trace:
    """Collector-shaped records on named streams, with contiguous seqs per stream."""

    def __init__(self):
        self.records, self._seq = [], {}

    def add(self, kind, op_id, stream="s", **kw):
        n = self._seq[stream] = self._seq.get(stream, 0) + 1
        self.records.append({"stream": stream, "seq": n, "kind": kind, "operation_id": op_id,
                             "attempt": 1, **kw})

    def op(self, op_id, kind, refs, stream="s", commit=True, write=True):
        self.begin(op_id, kind, refs, stream)
        self.body(op_id, stream, commit, write)

    def begin(self, op_id, kind, refs, stream="s"):
        self.add("op_begin", op_id, stream, op_kind=kind, op_tag=None, run_id="r")
        if refs is not None:
            self.add("causal_refs", op_id, stream, refs=list(refs))
        self.add("tx_begin", op_id, stream, backend_pid=1, isolation="read_committed")

    def body(self, op_id, stream="s", commit=True, write=True):
        self.add("stmt", op_id, stream, mode="write" if write else "read", relations=["mail_sent"])
        if commit:
            self.add("tx_end", op_id, stream, outcome="commit", backend_pid=1, sqlstate="00000")
        self.add("op_end", op_id, stream, outcome="applied", contacts=1)


def _a_to_b(t, msg="m1", stream_of=lambda _k: "s"):
    t.op(f"src-{msg}", SRC, [msg], stream_of(SRC))
    t.op(f"rcv-{msg}", RCV, [msg], stream_of(RCV))
    t.op(f"conf-{msg}", CONF, [f"batch-{msg}", msg], stream_of(CONF))


class Atomicity(unittest.TestCase):
    """PROFILING test 2: the A-to-B mail workflow is three committed transactions
    linked by the message id; declaring it ONE atomic transaction must fail."""

    def test_the_workflow_declared_as_a_workflow_passes(self):
        t = _Trace()
        _a_to_b(t)
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(v["verdict"], "PASSED", v["failures"])
        self.assertEqual([(i["workflow"], i["commits"], len(i["operations"])) for i in v["instances"]],
                         [("mail.a_to_b", 3, 3)])

    def test_labelling_the_workflow_one_atomic_transaction_fails(self):
        t = _Trace()
        _a_to_b(t)
        v = oracle.atomicity(_decl(shape="native_tx"), t.records)
        self.assertEqual(v["verdict"], "FAILED")
        self.assertEqual(v["failures"], [
            "workflow mail.a_to_b [batch-m1, m1]: declared ONE atomic transaction, observed 3 "
            "committed transactions across 3 operations (mail.receive.deliver_agent, "
            "mail.source.message, runtime.confirm_input)"])

    def test_two_committed_steps_already_break_one_atomic_transaction(self):
        t = _Trace()
        t.op("src-m1", SRC, ["m1"])
        t.op("rcv-m1", RCV, ["m1"])
        v = oracle.atomicity(_decl(shape="native_tx"), t.records)
        self.assertTrue(any("observed 2 committed transactions across 2 operations" in f
                            for f in v["failures"]), v["failures"])

    def test_a_single_committed_transaction_is_consistent_with_native_tx(self):
        t = _Trace()
        t.op("src-m1", SRC, ["m1"])
        t.op("rcv-m1", RCV, ["m1"], commit=False)
        self.assertEqual(oracle.atomicity(_decl(shape="native_tx"), t.records)["verdict"], "PASSED")

    def test_a_step_without_causal_refs_cannot_be_claimed(self):
        t = _Trace()
        t.op("src-m1", SRC, ["m1"])
        t.op("rcv-m1", RCV, None)
        t.op("conf-m1", CONF, ["m1"])
        v = oracle.atomicity(_decl(shape="native_tx"), t.records)
        self.assertIn("workflow mail.a_to_b: mail.receive.deliver_agent rcv-m1 carries no "
                      "causal_refs: it cannot be placed in an instance", v["failures"])

    def test_a_receiver_that_began_before_the_source_committed_fails(self):
        t = _Trace()
        t.begin("src-m1", SRC, ["m1"])
        t.begin("rcv-m1", RCV, ["m1"])
        t.body("src-m1")
        t.body("rcv-m1")
        t.op("conf-m1", CONF, ["m1"])
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(v["failures"], [
            "workflow mail.a_to_b [m1]: mail.receive.deliver_agent began before "
            "mail.source.message committed"])

    def test_an_incomplete_instance_fails(self):
        t = _Trace()
        t.op("src-m1", SRC, ["m1"])
        t.op("rcv-m1", RCV, ["m1"])
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(v["failures"], ["workflow mail.a_to_b [m1]: incomplete instance, "
                                         "missing steps ['runtime.confirm_input']"])

    def test_instances_are_separated_by_id_and_joined_by_a_batch(self):
        t = _Trace()
        for m in ("m1", "m2"):
            t.op(f"src-{m}", SRC, [m])
            t.op(f"rcv-{m}", RCV, [m])
        t.op("conf-b", CONF, ["b1"])
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(sorted(i["refs"] for i in v["instances"]), [["b1"], ["m1"], ["m2"]])
        t.op("conf-both", CONF, ["b2", "m1", "m2"])   # one input batch confirms both messages
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(sorted(i["refs"] for i in v["instances"]),
                         [["b1"], ["b2", "m1", "m2"]])

    def test_order_across_streams_is_reported_unknown_not_passed_or_failed(self):
        t = _Trace()
        _a_to_b(t, stream_of=lambda k: "receiver" if k == RCV else "s")
        v = oracle.atomicity(_decl(), t.records)
        self.assertEqual(v["verdict"], "PASSED", v["failures"])
        self.assertEqual(len(v["unknown_order"]), 2)

    def test_a_read_snapshot_that_writes_fails(self):
        t = _Trace()
        t.op("inbox-1", INBOX, None, write=False)
        self.assertEqual(oracle.atomicity(_decl(), t.records)["failures"], [])
        t.op("inbox-2", INBOX, None, write=True)
        self.assertEqual(oracle.atomicity(_decl(), t.records)["failures"],
                         ["mail.inbox.user_inbox inbox-2: declared read_snapshot but wrote"])
        t2 = _Trace()
        t2.op("inbox-3", INBOX, None, write=False)
        t2.add("xact_stats", "inbox-3", tables=[{"relname": "mail_sent", "n_tup_upd": 1}])
        self.assertEqual(oracle.atomicity(_decl(), t2.records)["failures"],
                         ["mail.inbox.user_inbox inbox-3: declared read_snapshot but wrote"])

    def test_an_attempt_that_committed_twice_fails(self):
        t = _Trace()
        t.op("src-m1", SRC, ["m1"])
        t.add("tx_end", "src-m1", outcome="commit", backend_pid=1, sqlstate="00000")
        self.assertIn("mail.source.message src-m1: an attempt committed more than once",
                      oracle.atomicity(_decl(), t.records)["failures"])

    def test_a_declared_workflow_never_observed_is_reported(self):
        v = oracle.atomicity(_decl(), [])
        self.assertEqual((v["verdict"], v["not_observed"]), ("PASSED", ["mail.a_to_b"]))

    def test_invalid_workflow_declarations_are_refused(self):
        bad = [
            {"mail.a_to_b": {"shape": "saga", "steps": [SRC], "source": "x"}},
            {"mail.a_to_b": {"shape": "workflow", "steps": [], "source": "x"}},
            {"mail.a_to_b": {"shape": "workflow", "steps": [SRC, SRC], "source": "x"}},
            {"mail.a_to_b": {"shape": "workflow", "steps": [SRC, "no.such"], "source": "x"}},
            {"mail.a_to_b": {"shape": "workflow", "steps": [SRC], "source": " "}},
            [],
        ]
        for w in bad:
            with self.subTest(w=w):
                d = {**_decl(), "workflows": w}
                self.assertTrue(oracle.declared_errors(d))
                self.assertEqual(oracle.atomicity(d, [])["verdict"], "FAILED")
        d = _decl()
        d[SRC] = {**d[SRC], "shape": "eventually"}
        self.assertTrue(oracle.declared_errors(d))
        self.assertEqual(oracle.declared_errors(_decl()), [])
        self.assertTrue(oracle.declared_errors({"workflows": {}}))   # workflows alone is empty

    def test_q_c5_ignores_the_workflows_key(self):
        d = _decl()
        t = _Trace()
        t.add("op_begin", "o-w", op_kind="workflows", op_tag=None, run_id="r")
        v = oracle.q_c5(d, t.records, ["executor"])
        self.assertIn("workflows o-w#1: operation kind has no declared contacts", v["failures"])
        v = oracle.q_c5(d, [], ["executor"])
        self.assertNotIn("workflows", v["over_declared"])
        self.assertFalse([f for f in v["failures"] if "workflows" in f], v["failures"])


class ServerLog(unittest.TestCase):
    """Q-C5 hidden access from the server's statement log (lead ruling, decision 3)."""
    A = "SELECT 1 FROM agents WHERE id = $1 FOR SHARE"
    B = "INSERT INTO items (id) VALUES ($1)"

    def clean_log(self):
        return [log_line(501, "statement: BEGIN"), log_line(501, f"execute <unnamed>: {self.A}"),
                log_line(501, f"execute s3/p1: {self.B}"), log_line(501, "statement: COMMIT")]

    def test_fingerprint_parity_with_store_trace(self):
        """engine/native/store-trace tests/sink.rs asserts the same three vectors."""
        self.assertEqual(serverlog.fingerprint("SELECT  1\n\tFROM items"), "fnv1a64:6158a631b7695032")
        self.assertEqual(serverlog.fingerprint("  INSERT INTO items (id) VALUES ($1) "),
                         "fnv1a64:fb85c40311a61d66")
        self.assertEqual(serverlog.fingerprint("SELECT été FROM Items"),
                         "fnv1a64:4b522fed6fb592eb")
        # measured on a dev cluster: extended-protocol log lines keep a trailing space
        self.assertEqual(serverlog.fingerprint("SELECT 1 "), serverlog.fingerprint("SELECT 1"))

    def test_a_clean_session_reconciles(self):
        verdict = serverlog.reconcile(traced_session(501, [self.A, self.B]), self.clean_log(),
                                      ["executor"])
        self.assertEqual(verdict["verdict"], "PASSED", verdict["failures"])
        self.assertIn("trigger", verdict["limit"])

    def test_hidden_statement_on_a_registered_pooled_session_is_flagged(self):
        """Q-C5's own control: a statement on a registered connection, between two traced ops."""
        log = self.clean_log()[:2] + [log_line(501, "statement: SELECT * FROM mailbox_heads")] \
            + self.clean_log()[2:]
        verdict = serverlog.reconcile(traced_session(501, [self.A, self.B]), log, ["executor"])
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any(f.startswith(f"session ({START_S}, 501): hidden access")
                            for f in verdict["failures"]), verdict["failures"])

    def test_untraced_second_session_is_flagged(self):
        log = self.clean_log() + [log_line(777, "statement: SELECT 1")]
        verdict = serverlog.reconcile(traced_session(501, [self.A, self.B]), log, ["executor"])
        self.assertTrue(any("(unregistered connection)" in f and "777" in f
                            for f in verdict["failures"]), verdict["failures"])

    def test_a_session_running_only_transaction_control_must_be_registered(self):
        log = self.clean_log() + [log_line(778, "statement: BEGIN"), log_line(778, "statement: COMMIT")]
        verdict = serverlog.reconcile(traced_session(501, [self.A, self.B]), log, ["executor"])
        self.assertTrue(any("778" in f for f in verdict["failures"]), verdict["failures"])

    def test_a_traced_statement_the_server_never_ran_is_flagged(self):
        verdict = serverlog.reconcile(traced_session(501, [self.A, "SELECT 2", self.B]),
                                      self.clean_log(), ["executor"])
        self.assertTrue(any("never logged" in f for f in verdict["failures"]), verdict["failures"])

    def test_no_log_or_an_unregistered_factory_fails(self):
        self.assertEqual(serverlog.reconcile(traced_session(501, []), None, ["executor"])["verdict"],
                         "FAILED")
        verdict = serverlog.reconcile(traced_session(501, [self.A, self.B], factory="side-door"),
                                      self.clean_log(), ["executor"])
        self.assertTrue(any("unregistered factory 'side-door'" in f for f in verdict["failures"]))

    def test_a_reused_pid_is_refused_not_guessed(self):
        recs = traced_session(501, [self.A]) + [
            dict(r, stream="exec2") for r in traced_session(501, [self.B], start_s=START_S + 60)]
        log = [log_line(501, f"statement: {self.A}"),
               log_line(501, f"statement: {self.B}", start_s=START_S + 60)]
        verdict = serverlog.reconcile(recs, log, ["executor"])
        # the pid maps to two sessions: attribution is refused, never guessed
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("several sessions for that pid" in f for f in verdict["failures"]))

    def test_session_ids_parse(self):
        self.assertEqual(serverlog.session_key("66f3c2a1.1f5"), (0x66F3C2A1, 0x1F5))
        self.assertIsNone(serverlog.session_key("nonsense"))


class Protocol(unittest.TestCase):
    PLAN = {"type": "plan", "run_id": "r", "controls": [CONTROL_ID],
            "holds": [{"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1000}]}

    def test_frames_round_trip(self):
        frame, rest = protocol.decode(protocol.encode(self.PLAN) + b"xx")
        self.assertEqual((frame, rest), (self.PLAN, b"xx"))
        self.assertEqual(protocol.decode(protocol.encode(self.PLAN)[:-1])[0], None)

    def test_malformed_frames_are_refused(self):
        bad = [
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "kill_backend", "timeout_ms": 1}]},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "fail_next", "timeout_ms": 1}]},
            {"type": "plan", "run_id": "r", "controls": ["not-a-control"], "holds": []},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1},
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1}]},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1,
                 "attempt": 0}]},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1,
                 "attempt": True}]},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1, "attempt": 2},
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1, "attempt": 2}]},
            {"type": "plan", "run_id": "r", "controls": [], "holds": [
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1},
                {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1, "attempt": 2}]},
            {"type": "release", "op_tag": "A", "point": WRITE, "attempt": "2"},
            {"type": "arrived", "point": WRITE, "op_tag": "A", "operation_id": "o",
             "attempt": 0, "backend_pid": 1, "txid_if_assigned": None, "seq": 0},
            {"type": "hello", "token": "t", "protocol": "something-else"},
            {"type": "handshake", "protocol": protocol.PROTOCOL, "qualification": "yes",
             "build_sha": "x", "points": [], "controls": []},
            {"type": "nonsense"},
        ]
        for frame in bad:
            with self.subTest(frame=frame):
                self.assertTrue(protocol.frame_errors(frame))
                with self.assertRaises(ValueError):
                    protocol.encode(frame)

    def test_holds_on_different_attempts_of_one_point_are_valid(self):
        plan = {"type": "plan", "run_id": "r", "controls": [], "holds": [
            {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1, "attempt": 1},
            {"op_tag": "A", "point": WRITE, "action": "hold", "timeout_ms": 1, "attempt": 2}]}
        self.assertEqual(protocol.frame_errors(plan), [])
        self.assertEqual(protocol.frame_errors(
            {"type": "release", "op_tag": "A", "point": WRITE, "attempt": 2}), [])

    def test_every_operation_has_the_generic_points(self):
        self.assertEqual(protocol.generic_points("staffing.hire")[:2],
                         ["staffing.hire.admitted", "staffing.hire.begin"])
        self.assertIn("staffing.hire.stmt.probe.before",
                      protocol.generic_points("staffing.hire", ["probe"]))


class Checkers(unittest.TestCase):
    def rec(self, seq, kind="flush", **kw):
        return {"stream": "s", "seq": seq, "mono_ns": seq, "kind": kind,
                **({"upto_seq": seq} if kind == "flush" else {}), **kw}

    def test_stream_health(self):
        ok = [self.rec(1), self.rec(2, "stream_end", last_seq=2, clean=True)]
        self.assertTrue(stream_health(ok, ["s"])["complete"])
        gap = [self.rec(1), self.rec(3, "stream_end", last_seq=3, clean=True)]
        self.assertFalse(stream_health(gap, ["s"])["complete"])
        self.assertFalse(stream_health(ok, [])["complete"])            # manifest names nothing
        silent = stream_health(ok, ["s", "silent"])                  # a stream never spoke
        self.assertFalse(silent["complete"])
        self.assertIn("no records at all", silent["streams"]["silent"]["problems"])
        self.assertFalse(stream_health(ok + [dict(self.rec(1), stream="stray")], ["s"])["complete"])

    def test_backend_pids_are_learned_from_collector_records(self):
        """The native collector's op_begin carries no pid; tx_begin and stmt do."""
        from p03.harness.schedule import _absorb, _Recorder
        rec = _Recorder()
        _absorb(rec, {"kind": "op_begin", "op_tag": "A", "operation_id": "o"})
        _absorb(rec, {"kind": "tx_begin", "op_tag": "A", "backend_pid": 17})
        _absorb(rec, {"kind": "stmt", "op_tag": "B", "backend_pid": 18})
        _absorb(rec, {"kind": "stmt", "op_tag": None, "backend_pid": 19})
        self.assertEqual(rec.pids, {17: "A", 18: "B"})

    def test_compare_catches_a_reversed_order(self):
        achieved = [{"hseq": 1, "event": "end:B"}, {"hseq": 2, "event": "end:A"}]
        self.assertEqual(compare([("before", "end:B", "end:A")], achieved, []), [])
        self.assertTrue(compare([("before", "end:A", "end:B")], achieved, []))
        self.assertTrue(compare([("present", "wait:B:A")], achieved, []))


if __name__ == "__main__":
    unittest.main()
