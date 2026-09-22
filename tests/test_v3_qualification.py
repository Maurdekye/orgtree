"""Discriminating report checks and runner safety; product probes live in the CLI."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from v3_qualification import evidence, runner


class QualificationEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.append = {"expected_refs":["a","b"],"actual_refs":["b","a"],
            "initial_rev":1,"final_rev":3,"completed":2,"failed":0}
        self.control = {"retry_effects":1,"retry_attempts":4,"replayed_attempts":3,
            "changed_payload_status":409,"changed_payload_detail":"op_key conflict",
            "stale_authorization_status":403,"stale_authorization_detail":"credential is stale",
            "revoked_effects":0,"fresh_authorization_status":200,"expected_control_rev":4,"actual_control_rev":4,
            "ordered_values":["first","second"],"stale_revision_status":422,
            "stale_revision_detail":"expected_rev 2, but this item is at rev 3", "value_after_stale":"second"}
        self.recovery = {"before_pid":100,"after_pid":101,"actual_refs":["a"],"expected_refs":["a"],
            "actual_rev":3,"expected_rev":3,"receipt_state":"applied","unknown_old_epoch_status":422,
            "unknown_old_epoch_detail":"op_key refused (epoch)","refs_after_refusal":["a"],"rev_after_refusal":3}

    def test_success_requires_exact_effects_revisions_and_completions(self):
        self.assertEqual(evidence.check_append(self.append),[])
        mutations = [dict(actual_refs=["a"]),dict(actual_refs=["a","a"]),dict(actual_refs=["a","b","b"]),
                     dict(final_rev=2),dict(completed=1),dict(failed=1),dict(expected_refs=[])]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.assertTrue(evidence.check_append({**self.append,**mutation}))

    def test_controls_require_successful_baseline_before_counting_detected_faults(self):
        rows = evidence.negative_controls(self.append,self.control,self.recovery)
        self.assertEqual(len(rows),9)
        self.assertTrue(all(r["classification"] == "expected_negative" for r in rows))
        self.assertTrue(all(r["mechanism"] == "observation mutation" for r in rows))
        broken = {**self.control,"fresh_authorization_status":500}
        rows = evidence.negative_controls(self.append,broken,self.recovery)
        self.assertTrue(all(r["classification"] == "failed" for r in rows if r["id"] in
                            ("retry-duplicate","stale-authorization","ordering","stale-revision")))

    def test_wrong_refusal_reason_does_not_count_as_authority_or_epoch_proof(self):
        self.assertTrue(evidence.check_control({**self.control,"stale_revision_detail":"unknown action"}))
        self.assertTrue(evidence.check_recovery({**self.recovery,"unknown_old_epoch_detail":"unknown tool"}))
        self.assertTrue(evidence.check_control({**self.control,"revoked_effects":1}))
        self.assertTrue(evidence.check_recovery({**self.recovery,"after_pid":100}))
        self.assertTrue(evidence.check_recovery({**self.recovery,"refs_after_refusal":["a","b"]}))
        self.assertTrue(evidence.check_control({**self.control,"actual_control_rev":5}))
        self.assertTrue(evidence.check_control({**self.control,"stale_authorization_detail":"wrong seat"}))
        self.assertTrue(evidence.check_control({**self.control,"replayed_attempts":0}))

    def test_controls_do_not_mutate_positive_evidence(self):
        before = copy.deepcopy([self.append,self.control,self.recovery])
        evidence.negative_controls(self.append,self.control,self.recovery)
        self.assertEqual(before,[self.append,self.control,self.recovery])

    def test_empty_latency_is_missing_not_zero_and_tail_keeps_denominator(self):
        self.assertIsNone(evidence.distribution([])["p99_ms"])
        self.assertEqual(evidence.distribution(list(range(1,101))),
                         {"n":100,"p50_ms":50,"p95_ms":95,"p99_ms":99,"max_ms":100})

    def test_live_selectors_are_removed_before_worker_import(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(os.environ,{"ORGTREE_DATA":"live","ORGTREE_AGENT_PARENT_DATA":"live-parent",
                "ORGTREE_DESKTOP_MANAGED":"1","OPENAI_API_KEY":"fixture-secret","APPDATA":"live-profile"}):
                env = runner.child_env(root)
            self.assertEqual(env["ORGTREE_DATA"],str(root/"data"))
            self.assertEqual(env["APPDATA"],str(root/"home"))
            for name in ("ORGTREE_AGENT_PARENT_DATA","ORGTREE_DESKTOP_MANAGED","OPENAI_API_KEY"):
                self.assertNotIn(name,env)

    def test_worker_refuses_wrong_owner_marker_before_importing_product(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root/"qualification-root.json").write_text(json.dumps(
                {"schema":runner.SCHEMA,"nonce":"owner","root":str(root)}),encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError,"runner-owned"):
                runner.worker(Path.cwd(),root,"exercise","intruder",{})

    def test_worker_forbids_provider_or_desktop_process_launch(self):
        for event in ("subprocess.Popen","os.system","os.startfile","os.posix_spawn","os.spawn"):
            with self.assertRaisesRegex(RuntimeError,"forbids external process"):
                runner.forbid_external_process(event,())
        runner.forbid_external_process("open",())
        runner.forbid_external_process("subprocess.Popen",("git",["git","rev-parse","HEAD"]))
        runner.forbid_external_process("subprocess.Popen",("git",'git -C "C:\\fixture repo" rev-parse HEAD'))
        with self.assertRaisesRegex(RuntimeError,"forbids external process"):
            runner.forbid_external_process("subprocess.Popen",("git",["git","push"]))
        with self.assertRaisesRegex(RuntimeError,"forbids external process"):
            runner.forbid_external_process("subprocess.Popen",("cmd.exe","git status --porcelain"))

    def test_absent_native_and_full_product_adapters_remain_visible(self):
        for key in ("migration-rollback","multi-window","attention-desk","native-postgresql","full-product"):
            self.assertIn(key,runner.MISSING)


if __name__ == "__main__":
    unittest.main()
