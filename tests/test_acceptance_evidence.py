"""W09: acceptance evidence must state what was actually exercised.

These tests use an in-memory ledger only.  They prove the durable boundary:
qualified observations are retained, but cannot be mistaken for a met
condition, while blocked-request controls retain their gate/count and remain
distinct from application crashes.
"""
from __future__ import annotations

import sys
import os
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# The ledger imports the store lazily while constructing an Org.  Give the
# development guard an independent disposable root before that import.
_DATA = tempfile.TemporaryDirectory(prefix="w09-evidence-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402


class AcceptanceEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.org = ledger.Org.create("acceptance-evidence-fixture")
        self.org.hire(USER, None, "haiku", 0, "owner")
        made = self.org.work_create(
            "owner", "Evidence fixture",
            "Problem: qualified evidence was mistaken for completion. "
            "Solution: store explicit evidence classes.",
            acceptance=["the composition is verified"])
        self.wid = str(made["created"])

    def test_known_negative_preserves_gate_and_count_and_acceptance_is_explicit(self):
        self.org.work_check(
            "owner", self.wid, 0, "tests/blocked-control.log",
            classification="known_negative", artifact="tests/blocked-control.log",
            runner="python acceptance", execution="independent",
            result="expected_negative", gate="agent-token", blocked_count=3,
            composition="script")
        check = self.org.work_get("owner", self.wid)["acceptance"][0]
        self.assertEqual(check["checked"]["classification"], "known_negative")
        self.assertEqual(check["checked"]["result"], "expected_negative")
        self.assertEqual(check["checked"]["gate"], "agent-token")
        self.assertEqual(check["checked"]["blocked_count"], 3)
        self.assertEqual(len(check["check_history"]), 1)
        # The control is an explicit, successful negative test (W08's green
        # expected_negative result), so it may satisfy this condition; the
        # separate accept call is still required.
        self.org.work_accept("owner", self.wid)
        self.assertEqual(self.org.work_get("owner", self.wid)["status"], "done")

    def test_crash_is_environment_limited_and_not_a_blocked_control(self):
        self.org.work_check(
            "owner", self.wid, 0, "tests/installer.log",
            classification="environment_limited", artifact="tests/installer.log",
            runner="nsis", execution="independent", result="crashed",
            composition="installer")
        check = self.org.work_get("owner", self.wid)["acceptance"][0]["checked"]
        self.assertEqual(check["classification"], "environment_limited")
        self.assertEqual(check["result"], "crashed")
        self.assertNotIn("gate", check)
        self.assertNotIn("blocked_count", check)
        with self.assertRaises(LedgerError):
            self.org.work_accept("owner", self.wid)

    def test_unexecuted_is_rejected_as_met_and_invalid_batch_is_atomic(self):
        before = self.org.work_get("owner", self.wid)
        with self.assertRaises(LedgerError):
            self.org.work_check(
                "owner", self.wid, 0, "installer.nsi",
                classification="met", artifact="installer.nsi", runner="unit",
                execution="source_inspection", result="not_executed",
                composition="installer")
        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["rev"], before["rev"])
        self.assertIsNone(after["acceptance"][0]["checked"])
        with self.assertRaises(LedgerError):
            self.org.work_check("owner", self.wid, checks=[
                {"index": 0, "evidence_ref": "a", "classification": "not_exercised",
                 "artifact": "a", "runner": "unit", "execution": "independent",
                 "result": "not_executed", "composition": "script"},
                {"index": 9, "evidence_ref": "bad", "classification": "met",
                 "artifact": "bad", "runner": "unit", "execution": "independent",
                 "result": "passed"}])
        self.assertIsNone(self.org.work_get("owner", self.wid)["acceptance"][0]["checked"])

    def test_known_negative_without_exact_gate_is_atomic_refusal(self):
        before = self.org.work_get("owner", self.wid)
        with self.assertRaises(LedgerError) as error:
            self.org.work_check(
                "owner", self.wid, 0, "blocked.log", classification="known_negative",
                artifact="blocked.log", runner="python", execution="independent",
                result="expected_negative")
        self.assertIn("gate and blocked_count", str(error.exception))
        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["rev"], before["rev"])
        self.assertIsNone(after["acceptance"][0]["checked"])

    def test_known_negative_requires_an_executed_or_reported_control(self):
        with self.assertRaises(LedgerError) as error:
            self.org.work_check(
                "owner", self.wid, 0, "blocked.log", classification="known_negative",
                artifact="blocked.log", runner="source reader",
                execution="source_inspection", result="expected_negative",
                gate="agent-token", blocked_count=1)
        self.assertIn("executed or reported", str(error.exception))
        self.assertIsNone(self.org.work_get("owner", self.wid)["acceptance"][0]["checked"])

    def test_met_requires_explicit_pass_and_history_is_append_only(self):
        base = dict(artifact="tests/run.log", runner="python", execution="independent",
                    result="passed", composition="unit")
        self.org.work_check("owner", self.wid, 0, "tests/run.log",
                            classification="met", **base)
        self.org.work_check("owner", self.wid, 0, "tests/run.log",
                            classification="environment_limited", runner="nsis",
                            execution="independent", result="not_executed",
                            artifact="installer.nsi", composition="installer")
        check = self.org.work_get("owner", self.wid)["acceptance"][0]
        self.assertEqual(check["checked"]["classification"], "environment_limited")
        self.assertEqual([h["classification"] for h in check["check_history"]],
                         ["met", "environment_limited"])
        with self.assertRaises(LedgerError):
            self.org.work_accept("owner", self.wid)

        # A later explicit met observation is the only way to make the
        # condition complete, and final acceptance remains a separate call.
        self.org.work_check("owner", self.wid, 0, "tests/run.log",
                            classification="met", **base)
        self.org.work_accept("owner", self.wid)
        self.assertEqual(self.org.work_get("owner", self.wid)["status"], "done")
        self.assertEqual(len(self.org.work_get("owner", self.wid)["acceptance"][0]["check_history"]), 3)


if __name__ == "__main__":
    unittest.main()
