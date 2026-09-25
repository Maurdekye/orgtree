"""P03 WS7: the forced-interleaving harness judges what it OBSERVED, and its
meta-controls fail.

Everything here runs against ``tools/p03/harness/fake_executor.py``, an
in-process fake that speaks the pause-point contract: no database, no product
code. The schedule is a lost-update race on one counter. The safe operation
reads the counter under an exclusive row lock held to commit; its unsafe control
(``FAKE-LU.control``) skips that lock.

What must hold:
- the safe build, in the intended order (A holds before its write, B is SEEN
  waiting on A), PASSES;
- a removed barrier, a build without pause points, a plan naming an unknown
  point, an unclean stream tail and a dropped record each turn the run into
  FAILED or REFUSED, never PASSED (r7 §8.1: a run whose interleaving is not the
  one intended is a failed run);
- the control, switched on, runs in its own order (B overtakes A), breaks the
  pass condition, and is ACCEPTED only because it recorded that it ran. The same
  control silenced, or the control order run on the safe build, is a FAILED
  control (r7 §8.1, S3 §7, gate G3).
"""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from p03.harness import controls as ctl  # noqa: E402
from p03.harness.fake_executor import FakeExecutor, Stmt  # noqa: E402
from p03.harness.schedule import (FAILED, PASSED, REFUSED, Order, Schedule,  # noqa: E402
                                  compare, run_order)
from p03.harness.trace import stream_health  # noqa: E402

KIND = "counter.increment"
WRITE = f"{KIND}.stmt.write.before"
CONTROL_ID = "FAKE-LU.control"


def _read(rows, ctx, _args):
    ctx["v"] = rows.get("counter", 0)


def _write(rows, ctx, _args):
    rows["counter"] = ctx["v"] + 1


OPS = {KIND: [Stmt("read", ("counters",), "read", lock="counter:1", apply=_read,
                   skip_lock_control=CONTROL_ID),
              Stmt("write", ("counters",), "write", apply=_write)]}

SAFE = Order(
    "a-holds-b-waits",
    script=[("start", "A"), ("arrive", "A", WRITE), ("start", "B"), ("await_wait", "B", "A"),
            ("release", "A", WRITE), ("await_end", "A"), ("await_end", "B")],
    intended=[("before", f"arrived:A:{WRITE}", "wait:B:A"), ("before", "end:A", "end:B"),
              ("outcome", "A", "commit"), ("outcome", "B", "commit")])

OVERTAKE = Order(
    "b-overtakes-a",
    script=[("start", "A"), ("arrive", "A", WRITE), ("start", "B"), ("await_end", "B"),
            ("release", "A", WRITE), ("await_end", "A")],
    intended=[("before", f"arrived:A:{WRITE}", "end:B"), ("before", "end:B", "end:A"),
              ("absent", "wait:B:A")])


def schedule(timeout: float = 3.0) -> Schedule:
    return Schedule("FAKE-LU", {"A": (KIND, {}), "B": (KIND, {})}, [SAFE, OVERTAKE],
                    pass_condition=lambda _r, _a, final: final["rows"].get("counter") == 2,
                    step_timeout=timeout, plan_timeout=timeout)


CONTROL = ctl.Control(CONTROL_ID, "FAKE-LU", "fake: controls={'FAKE-LU.control'}",
                      "fake_executor.FakeExecutor._run (the skipped _take)",
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
                      [("before", "end:B", "end:A"), ("outcome", "A", "commit")])
        result = run_order(FakeExecutor(OPS), schedule(), wrong)
        self.assertEqual(result.verdict, FAILED)
        self.assertIn("interleaving not achieved: end:B was not before end:A", result.reasons)
        self.assertIsNone(result.pass_condition_held)

    def test_removed_barrier_fails_the_run(self):
        """The meta-control: the barrier is gone, so the interleaving is not forced."""
        result = run_order(FakeExecutor(OPS, barriers=False), schedule(1.0), SAFE)
        self.assertEqual(result.verdict, FAILED)
        self.assertTrue(any("interleaving not achieved" in r for r in result.reasons),
                        result.reasons)
        self.assertIsNone(result.pass_condition_held)

    def test_build_without_pause_points_is_refused(self):
        result = run_order(FakeExecutor(OPS, qualification=False), schedule(), SAFE)
        self.assertEqual(result.verdict, REFUSED)
        self.assertEqual(result.records, [])

    def test_plan_naming_an_unknown_point_is_refused(self):
        bad = Order("typo", [("start", "A"), ("arrive", "A", f"{KIND}.stmt.wirte.before")], [])
        result = run_order(FakeExecutor(OPS), schedule(), bad)
        self.assertEqual(result.verdict, REFUSED)
        self.assertTrue(any("does not have" in r for r in result.reasons))

    def test_unclean_tail_or_dropped_record_is_incomplete(self):
        for kw in ({"unclean_tail": True}, {"drop_records": 1}):
            with self.subTest(**kw):
                result = run_order(FakeExecutor(OPS, **kw), schedule(), SAFE)
                self.assertEqual(result.verdict, FAILED)
                self.assertFalse(result.health["complete"])
                self.assertTrue(any("incomplete-contact" in r for r in result.reasons))


class UnsafeControls(unittest.TestCase):
    def test_control_that_ran_and_broke_the_schedule_is_accepted(self):
        result = run_order(FakeExecutor(OPS, controls={CONTROL_ID}), schedule(), OVERTAKE)
        self.assertIs(result.pass_condition_held, False, result.reasons)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "ACCEPTED", verdict["reasons"])
        self.assertGreaterEqual(verdict["executed_records"], 1)

    def test_silent_control_is_a_failed_control(self):
        """It broke the schedule, but nothing shows it RAN: that is not evidence."""
        result = run_order(FakeExecutor(OPS, controls={CONTROL_ID}, silent_controls=True),
                           schedule(), OVERTAKE)
        self.assertIs(result.pass_condition_held, False)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertIn("control did not run: no control_executed record", verdict["reasons"])

    def test_control_order_on_the_safe_build_is_a_failed_control(self):
        """Without the unsafe switch B waits, so the control's order is never achieved."""
        result = run_order(FakeExecutor(OPS), schedule(1.0), OVERTAKE)
        verdict = ctl.control_verdict(CONTROL, result)
        self.assertEqual(verdict["verdict"], "FAILED")
        self.assertTrue(any("not a valid control run" in r for r in verdict["reasons"]))

    def test_registry_refuses_duplicates_and_empty_fields(self):
        reg = ctl.Registry()
        reg.register(CONTROL)
        with self.assertRaises(ValueError):
            reg.register(CONTROL)
        with self.assertRaises(ValueError):
            reg.register(ctl.Control("X.control", "X", "", "site", "wording"))
        self.assertEqual([c.control_id for c in reg.for_schedule("FAKE-LU")], [CONTROL_ID])


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
        self.assertFalse(stream_health(ok, ["s", "silent"])["complete"])  # a stream never spoke
        self.assertFalse(stream_health(ok + [dict(self.rec(1), stream="stray")], ["s"])["complete"])

    def test_compare_catches_a_reversed_order(self):
        achieved = [{"hseq": 1, "event": "end:B"}, {"hseq": 2, "event": "end:A"}]
        self.assertEqual(compare([("before", "end:B", "end:A")], achieved, []), [])
        self.assertTrue(compare([("before", "end:A", "end:B")], achieved, []))
        self.assertTrue(compare([("present", "wait:B:A")], achieved, []))


if __name__ == "__main__":
    unittest.main()
