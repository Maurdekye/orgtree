"""Tests for orgtree_work check and evidence batch refusal reporting and schema.

Verifies:
1. A refused check or checks batch reports every missing or invalid field at
   once, with the element index for each.
2. A valid batch validates entirely before writing and writes ONE history row.
3. Single check reports all missing/invalid fields at once.
4. Batch evidence items reports all missing/invalid fields across elements at once.
5. Every field a check actually requires is documented as required in the tool schema.
6. The artifact parameter's description describes what it means for a check.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_DATA = tempfile.TemporaryDirectory(prefix="check-errors-test-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

assert os.environ.get("ORGTREE_DATA") == _DATA.name, "ORGTREE_DATA isolation guard failed"

from orgtree import ledger, mcptool, workevidence  # noqa: E402
from orgtree.ledger import LedgerError, USER       # noqa: E402


class WorkCheckBatchErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.org = ledger.Org.create("batch-check-fixture")
        self.org.hire(USER, None, "haiku", 0, "owner")
        made = self.org.work_create(
            "owner", "Batch check fixture",
            "Problem: acceptance check validator reports one fault per refusal. "
            "Solution: report all faults at once across all elements.",
            acceptance=["condition zero", "condition one", "condition two"])
        self.wid = str(made["created"])

    def test_batch_check_three_faults_in_three_elements_reported_at_once(self):
        """Submit a batch with three different faults in three different elements

        and show a single refusal naming all three with their indices.
        """
        before = self.org.work_get("owner", self.wid)
        before_rev = before["rev"]

        batch = [
            # Element 0: missing artifact
            {"index": 0, "evidence_ref": "tests/test0.log",
             "classification": "met", "runner": "python",
             "execution": "independent", "result": "passed"},
            # Element 1: missing runner
            {"index": 1, "evidence_ref": "tests/test1.log",
             "classification": "met", "artifact": "tests/test1.log",
             "execution": "independent", "result": "passed"},
            # Element 2: invalid result for classification 'met'
            {"index": 2, "evidence_ref": "tests/test2.log",
             "classification": "met", "artifact": "tests/test2.log",
             "runner": "python", "execution": "independent",
             "result": "failed"},
        ]

        with self.assertRaises(LedgerError) as ctx:
            self.org.work_check("owner", self.wid, checks=batch)

        msg = str(ctx.exception)
        # All three faults are named with their element indices:
        self.assertIn("checks[0]: acceptance evidence needs artifact", msg)
        self.assertIn("checks[1]: acceptance evidence needs runner", msg)
        self.assertIn(
            "checks[2]: acceptance classification 'met' requires result 'passed', not 'failed'",
            msg)

        # Atomicity: nothing was written, rev is untouched, no checks marked
        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["rev"], before_rev)
        for acc in after["acceptance"]:
            self.assertIsNone(acc.get("checked"))
            self.assertEqual(len(acc.get("check_history", [])), 0)
        # No history row written
        check_hist = [h for h in after.get("history", []) if h.get("op") == "check"]
        self.assertEqual(len(check_hist), 0)

    def test_valid_batch_validates_entirely_and_writes_one_history_row(self):
        """A valid batch still validates entirely before writing and still writes

        one history row.
        """
        before = self.org.work_get("owner", self.wid)
        before_hist_len = len(before.get("history", []))

        batch = [
            {"index": 0, "evidence_ref": "tests/test0.log",
             "classification": "met", "artifact": "tests/test0.log",
             "runner": "python unittest", "execution": "independent",
             "result": "passed"},
            {"index": 1, "evidence_ref": "tests/test1.log",
             "classification": "met", "artifact": "tests/test1.log",
             "runner": "pytest", "execution": "independent",
             "result": "passed"},
            {"index": 2, "evidence_ref": "tests/test2.log",
             "classification": "known_negative", "artifact": "tests/test2.log",
             "runner": "python suite", "execution": "independent",
             "result": "expected_negative", "gate": "auth-gate",
             "blocked_count": 5},
        ]

        res = self.org.work_check("owner", self.wid, checks=batch)
        self.assertEqual(res["checked"], [0, 1, 2])
        self.assertEqual(res["indexes"], [0, 1, 2])

        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["acceptance"][0]["checked"]["result"], "passed")
        self.assertEqual(after["acceptance"][1]["checked"]["result"], "passed")
        self.assertEqual(after["acceptance"][2]["checked"]["result"], "expected_negative")

        # History: exactly ONE row was appended for the batch check
        after_hist = after.get("history", [])
        self.assertEqual(len(after_hist), before_hist_len + 1)
        last_hist = after_hist[-1]
        self.assertEqual(last_hist["op"], "check")
        self.assertEqual(last_hist["batch"], 3)
        self.assertEqual(last_hist["indexes"], [0, 1, 2])

    def test_single_check_multiple_faults_reported_at_once(self):
        """A single check with multiple faults reports all of them at once."""
        before = self.org.work_get("owner", self.wid)
        with self.assertRaises(LedgerError) as ctx:
            self.org.work_check("owner", self.wid, index=0,
                                evidence_ref="tests/run.log",
                                classification="met", result="failed")
        msg = str(ctx.exception)
        self.assertIn("acceptance evidence needs artifact", msg)
        self.assertIn("acceptance evidence needs runner", msg)
        self.assertIn("acceptance evidence needs execution", msg)
        self.assertIn("acceptance classification 'met' requires result 'passed', not 'failed'", msg)

        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["rev"], before["rev"])
        self.assertIsNone(after["acceptance"][0].get("checked"))

    def test_checks_batch_duplicate_index_reported_alongside_other_faults(self):
        """Repeated index in a checks batch is reported alongside faults in other elements."""
        batch = [
            {"index": 0, "evidence_ref": "tests/test0.log",
             "classification": "met", "artifact": "a0", "runner": "r0",
             "execution": "independent", "result": "passed"},
            {"index": 0, "evidence_ref": "tests/test0b.log",
             "classification": "met", "artifact": "a0b", "runner": "r0b",
             "execution": "independent", "result": "passed"},
            {"index": 99, "evidence_ref": "",
             "classification": "met"},
        ]
        with self.assertRaises(LedgerError) as ctx:
            self.org.work_check("owner", self.wid, checks=batch)
        msg = str(ctx.exception)
        self.assertIn("checks[1]: marks acceptance index 0 again", msg)
        self.assertIn("checks[2]: acceptance index 99 out of range", msg)
        self.assertIn("checks[2]: checking a condition needs an evidence_ref", msg)

    def test_evidence_batch_reports_all_faults_with_element_indices(self):
        """Batch evidence items reports all missing and invalid fields across elements."""
        before = self.org.work_get("owner", self.wid)
        items = [
            # Element 0: invalid kind
            {"kind": "bogus_kind", "ref": "ref0"},
            # Element 1: missing ref
            {"kind": "note", "ref": ""},
            # Element 2: invalid receipt schema and result
            {"kind": "note", "ref": "ref2", "receipt": {"schema": "wrong", "result": "unknown"}},
        ]
        with self.assertRaises(LedgerError) as ctx:
            self.org.work_evidence("owner", self.wid, "", "", items=items)
        msg = str(ctx.exception)
        self.assertIn("items[0]: evidence kind must be one of", msg)
        self.assertIn("items[1]: evidence needs a ref", msg)
        self.assertIn("items[2]: receipt schema must be", msg)
        self.assertIn("items[2]: receipt.result must be one of", msg)

        after = self.org.work_get("owner", self.wid)
        self.assertEqual(after["rev"], before["rev"])
        self.assertEqual(len(after.get("evidence", [])), len(before.get("evidence", [])))

    def test_schema_documents_required_fields_for_check_and_describes_artifact(self):
        """Every field a check actually requires is documented as required in the

        tool schema, and artifact's description describes what it means for a check.
        """
        spec = next(t for t in mcptool.TOOLS if t["name"] == "orgtree_work")
        props = spec["inputSchema"]["properties"]

        # Check required fields are documented:
        self.assertIn("REQUIRED", props["index"]["description"])
        self.assertIn("REQUIRED", props["evidence_ref"]["description"])
        self.assertIn("REQUIRED", props["classification"]["description"])
        self.assertIn("REQUIRED", props["artifact"]["description"])
        self.assertIn("REQUIRED", props["runner"]["description"])
        self.assertIn("REQUIRED", props["execution"]["description"])
        self.assertIn("REQUIRED", props["result"]["description"])
        self.assertIn("REQUIRED", props["gate"]["description"])
        self.assertIn("REQUIRED", props["blocked_count"]["description"])

        # The artifact parameter's description describes what it means for a check:
        art_desc = props["artifact"]["description"]
        self.assertIn("check/evidence", art_desc)
        self.assertIn("exact artifact name or path measured", art_desc)
        self.assertIn("REQUIRED when classification is supplied", art_desc)
        self.assertIn("not an r1 id", art_desc)
        self.assertIn("artifact_read/grant/revoke", art_desc)

        # Runner parameter's description:
        runner_desc = props["runner"]["description"]
        self.assertIn("check/evidence", runner_desc)
        self.assertIn("REQUIRED when classification is supplied", runner_desc)
        self.assertIn("receipt", runner_desc)

        # Checks batch description notes error reporting:
        checks_desc = props["checks"]["description"]
        self.assertIn("every missing or invalid field across every element at once", checks_desc)


if __name__ == "__main__":
    unittest.main()
