"""P03 WS7: the live checks' verdict code, judged over SAVED live outputs.

``tools/p03/probes/order_live_check.py`` and ``qc5_live_check.py`` decide the
live Q-C4 order/kill and Q-C5 verdicts, but a live run needs a database and the
run lock. These tests replay what the fcb83e9 live run actually produced
(``tests/fixtures/p03_live_fcb83e9``: order summaries and trace records, the
Q-C5 trace records and metas, and the server jsonlog lines between each
scenario's markers) and then doctor copies of it: every doctored copy must come
back with the problem that names what was broken (review N2, native-design-review).
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tools" / "p03" / "probes"))

import order_live_check as olc  # noqa: E402
import qc5_live_check as qlc  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "p03_live_fcb83e9"
HOST_LOG = ("running 1 test\ntest order_host ... serving\nok\n\n"
            "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")


def records(name: str) -> list[dict]:
    text = (FIX / "order" / f"{name}.records.jsonl").read_text(encoding="utf-8")
    return [json.loads(ln) for ln in text.splitlines() if ln]


class OrderCheck(unittest.TestCase):
    def setUp(self):
        self.real = json.loads((FIX / "order" / "summaries.json").read_text(encoding="utf-8"))

    def doctored(self, order: str, **changes) -> dict:
        s = copy.deepcopy(self.real)
        s[order].update(changes)
        return s

    def test_the_saved_live_run_passes(self):
        self.assertEqual(olc.check(self.real, HOST_LOG), [])

    def test_a_missing_order_fails(self):
        s = copy.deepcopy(self.real)
        del s["kill_held"]
        self.assertEqual(olc.check(s, HOST_LOG), ["an order did not run"])

    def test_a_passing_meta_control_fails(self):
        s = self.doctored("early_release", verdict="PASSED", reasons=[])
        self.assertEqual(olc.check(s, HOST_LOG), [
            "early_release: the meta-control came back PASSED, not FAILED",
            "early_release: it did not fail on the interleaving: []"])

    def test_a_meta_control_failing_for_another_reason_fails(self):
        why = ["the service reported an error: boom", "interleaving not achieved: x"]
        s = self.doctored("early_release", reasons=why)
        self.assertEqual(olc.check(s, HOST_LOG), [
            "early_release: it failed for a reason other than the order: "
            "['the service reported an error: boom']"])

    def test_the_achieved_order_must_pass_with_its_condition_held(self):
        s = self.doctored("achieved", verdict="FAILED", reasons=["r"], pass_condition_held=None)
        self.assertEqual(olc.check(s, HOST_LOG), [
            "achieved: the intended order did not pass on the real service: ['r']",
            "achieved: the pass condition was not evaluated as held"])

    def test_kill_held_must_pass_with_its_condition_held(self):
        s = self.doctored("kill_held", pass_condition_held=None)
        self.assertEqual(len(olc.check(s, HOST_LOG)), 1)
        self.assertTrue(olc.check(s, HOST_LOG)[0].startswith("kill_held:"))

    def test_kill_unreleased_must_fail_on_the_error_frame(self):
        s = self.doctored("kill_unreleased", reasons=["interleaving not achieved: A never ended"])
        p = olc.check(s, HOST_LOG)
        self.assertEqual(len(p), 1)
        self.assertTrue(p[0].startswith("kill_unreleased: the control did not fail on the "
                                        "endpoint's error frame"))
        s = self.doctored("kill_unreleased", verdict="PASSED")
        self.assertEqual(len(olc.check(s, HOST_LOG)), 1)

    def test_the_host_test_must_report_its_summary(self):
        for log in ("", HOST_LOG.replace("1 passed; 0 failed", "0 passed; 1 failed"),
                    HOST_LOG.replace("test order_host ...", "test other ...")):
            self.assertEqual(olc.check(self.real, log), [
                "the host test did not report order_host and "
                "'test result: ok. 1 passed; 0 failed'"])


class PassConditions(unittest.TestCase):
    TWO = {"state": {"version": 2, "applied_receipts": 2, "intents": 2}}
    ONE = {"state": {"version": 1, "applied_receipts": 1, "intents": 1}}

    def test_q_c4_pass_condition_on_the_saved_records(self):
        recs = records("achieved")
        self.assertTrue(olc.pass_condition(recs, [], self.TWO))
        for k in ("version", "applied_receipts", "intents"):
            bad = copy.deepcopy(self.TWO)
            bad["state"][k] = 1
            self.assertFalse(olc.pass_condition(recs, [], bad), k)
        self.assertFalse(olc.pass_condition(recs, [], {}))
        # B's commit removed: only A committed
        b_ops = {r["operation_id"] for r in recs if r.get("kind") == "op_begin"
                 and r.get("op_tag") == "B"}
        no_b = [r for r in recs if not (r.get("kind") == "tx_end"
                                        and r.get("operation_id") in b_ops)]
        self.assertFalse(olc.pass_condition(no_b, [], self.TWO))

    def test_kill_condition_on_the_saved_records(self):
        recs = records("kill_held")
        self.assertTrue(olc.kill_condition(recs, [], self.ONE))
        self.assertFalse(olc.kill_condition(recs, [], self.TWO))
        # the retry on the SAME backend is not a kill that forced a new one
        pid = next(r["backend_pid"] for r in recs if r.get("kind") == "tx_begin")
        same = [dict(r, backend_pid=pid) if r.get("kind") == "tx_begin" else r for r in recs]
        self.assertFalse(olc.kill_condition(same, [], self.ONE))
        # two commits for one operation
        commit = next(r for r in recs if r.get("kind") == "tx_end" and r.get("op_tag") == "A"
                      and r.get("outcome") == "commit")
        self.assertFalse(olc.kill_condition(recs + [commit], [], self.ONE))


class Qc5Check(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="p03-qc5-"))
        shutil.copytree(FIX / "qc5", self.tmp / "qc5")
        self.out = self.tmp / "qc5"
        self.log = self.out / "log" / "window.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def check(self) -> dict:
        return qlc.check(self.out, self.out / "log")

    def edit_records(self, name: str, fn) -> None:
        f = self.out / f"{name}.records.jsonl"
        recs = [json.loads(ln) for ln in f.read_text(encoding="utf-8").splitlines() if ln]
        f.write_text("".join(json.dumps(r) + "\n" for r in fn(recs)), encoding="utf-8")

    def edit_log(self, keep) -> int:
        lines = self.log.read_text(encoding="utf-8").splitlines()
        kept = [ln for ln in lines if keep(ln)]
        self.log.write_text("\n".join(kept) + "\n", encoding="utf-8")
        return len(lines) - len(kept)

    def test_the_saved_live_run_passes(self):
        r = self.check()
        self.assertEqual((r["verdict"], r["problems"]), ("PASSED", []))
        self.assertEqual(r["scenarios"]["hidden"]["reconcile"]["verdict"], "FAILED")

    def test_an_undetected_hidden_statement_fails(self):
        self.assertEqual(self.edit_log(lambda ln: not ln.rstrip().endswith('SELECT 1"}')
                                       and ': SELECT 1"' not in ln), 2)
        p = self.check()["problems"]
        self.assertIn("hidden: the hidden pooled statement was NOT detected", p)

    def test_a_control_that_did_not_run_fails(self):
        self.edit_records("hidden", lambda rs: [r for r in rs if r.get("kind") != "control_executed"])
        self.assertIn("hidden: control did not run: no control_executed record",
                      self.check()["problems"])
        self.edit_records("mixed_nobaseline",
                          lambda rs: [r for r in rs if r.get("kind") != "control_executed"])
        self.assertIn("mixed_nobaseline: control did not run: no control_executed record",
                      self.check()["problems"])

    def test_a_control_firing_unarmed_fails(self):
        fired = next(r for r in (json.loads(ln) for ln in
                     (self.out / "hidden.records.jsonl").read_text(encoding="utf-8").splitlines())
                     if r.get("kind") == "control_executed")
        for name in ("clean", "mixed"):
            self.edit_records(name, lambda rs: rs + [fired])
        p = self.check()["problems"]
        self.assertIn("clean: a control fired although none was armed", p)
        self.assertIn("mixed: a control fired although none was armed", p)

    def test_a_missing_marker_fails(self):
        meta = json.loads((self.out / "clean.meta.json").read_text(encoding="utf-8"))
        self.assertEqual(self.edit_log(
            lambda ln: f"p03-ws7-qc5-end-clean-{meta['nonce']}" not in ln), 1)
        self.assertIn("clean: markers not found exactly once in order (start 1, end 0)",
                      self.check()["problems"])

    def test_an_empty_window_fails(self):
        meta = json.loads((self.out / "clean.meta.json").read_text(encoding="utf-8"))
        lines = self.log.read_text(encoding="utf-8").splitlines()
        s = next(i for i, ln in enumerate(lines) if f"qc5-start-clean-{meta['nonce']}" in ln)
        e = next(i for i, ln in enumerate(lines) if f"qc5-end-clean-{meta['nonce']}" in ln)
        self.log.write_text("\n".join(lines[:s + 1] + lines[e:]) + "\n", encoding="utf-8")
        self.assertIn("clean: no server-log lines in the window: the run left no evidence",
                      self.check()["problems"])

    def test_the_nobaseline_mutation_must_be_charged(self):
        """If the second operation's server-side stats come back clean (as they do WITH
        the baseline difference, in the ``mixed`` scenario), the mutation control has
        not shown anything and must fail."""
        def clean(name):
            return next(json.loads(ln) for ln in
                        (self.out / f"{name}.records.jsonl").read_text(encoding="utf-8").splitlines()
                        if '"xact_stats"' in ln and "probe.read_agent" in ln)
        tables = clean("mixed")["tables"]
        self.edit_records("mixed_nobaseline", lambda rs: [
            dict(r, tables=tables) if r.get("kind") == "xact_stats"
            and r.get("op_kind") == "probe.read_agent" else r for r in rs])
        self.assertEqual([x for x in self.check()["problems"] if x.startswith("mixed_nobaseline")],
                         ["mixed_nobaseline: without the baseline the second operation was NOT "
                          "charged with the first operation's relations: the mutation survived"])

    def test_a_duplicated_marker_fails(self):
        meta = json.loads((self.out / "clean.meta.json").read_text(encoding="utf-8"))
        lines = self.log.read_text(encoding="utf-8").splitlines()
        start = next(ln for ln in lines if f"qc5-start-clean-{meta['nonce']}" in ln)
        self.log.write_text("\n".join([start] + lines) + "\n", encoding="utf-8")
        self.assertIn("clean: markers not found exactly once in order (start 2, end 1)",
                      self.check()["problems"])

if __name__ == "__main__":
    unittest.main()
