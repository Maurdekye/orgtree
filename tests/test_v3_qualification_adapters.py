"""Optional-adapter receipts must not turn missing coverage or wrong refusals green."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))
from v3_qualification import adapters, runner


def migration_payload(scenario="ordinary"):
    source = {"invented.json":{"bytes":1,"sha256":"a"*64}}
    inventory = {"files":1,"organizations":1}
    payload = dict(format="orgtree-synthetic-migration-report",version=1,scenario=scenario,
        synthetic=True,activation_allowed=False,mapping_status="preserved_unmapped",
        not_exercised=sorted(adapters.MIGRATION_GAPS))
    if scenario == "malformed":
        return {**payload,"result":"refused","classification":"known_negative","reason":"invalid JSON"}
    receipt = {"state":"complete","backup_sha256":hashlib.sha256(adapters.encoded(source)).hexdigest(),
        "plan":{"source_manifest":source,"inventory":inventory,"authority":"none",
                "activation_allowed":False,"mapping_status":"preserved_unmapped","operation_key":"fixture-key"}}
    payload.update(result="passed",classification="met",inventory=inventory,
        checks={name:True for name in adapters.MIGRATION_CHECKS},receipt=receipt,
        rollback_receipt={"state":"restored","authority":"none","post_activation":False,
                          "operation_key":"fixture-key","source_manifest":source,"restored_manifest":source},
        receipt_sha256=hashlib.sha256(adapters.encoded(receipt)).hexdigest(),
        source_manifest_sha256=receipt["backup_sha256"],
        fault="python_exception_after_publish" if scenario == "interrupted" else "none")
    return payload


class OptionalAdapterTests(unittest.TestCase):
    def test_migration_positive_contract_and_intended_refusal(self):
        for scenario in adapters.SCENARIOS:
            with self.subTest(scenario=scenario):
                self.assertEqual(adapters.migration_errors(migration_payload(scenario),scenario,
                    1 if scenario == "malformed" else 0),[])

    def test_migration_empty_missing_checks_and_authority_promotion_fail(self):
        good = migration_payload()
        changes = ({"version":True},{"scenario":"sqlite"},{"synthetic":1},{"activation_allowed":0},
            {"mapping_status":"native"},{"not_exercised":[]},{"result":"refused"},{"checks":{}},
            {"checks":{name:1 for name in adapters.MIGRATION_CHECKS}}, {"receipt":None},
            {"rollback_receipt":{}},{"fault":"none_but_not_measured"},{"receipt_sha256":"b"*64})
        self.assertTrue(adapters.migration_errors({},"ordinary",0))
        for change in changes:
            with self.subTest(change=change):
                self.assertTrue(adapters.migration_errors({**good,**change},"ordinary",0))
        self.assertTrue(adapters.migration_errors(good,"ordinary",1))

    def test_migration_manifest_comparison_preserves_json_types(self):
        payload = copy.deepcopy(migration_payload())
        payload["rollback_receipt"]["restored_manifest"] = {"invented.json":{"bytes":True,"sha256":"a"*64}}
        self.assertIn("migration receipt source/restore manifests disagree",
                      adapters.migration_errors(payload,"ordinary",0))

    def test_wrong_refusal_or_crash_is_not_a_malformed_control(self):
        good = migration_payload("malformed")
        for change in ({"reason":"permission denied"},{"classification":"environment_limited"},
                       {"result":"passed"},{"reason":"unknown source layout"}):
            self.assertTrue(adapters.migration_errors({**good,**change},"malformed",1))
        self.assertTrue(adapters.migration_errors(good,"malformed",0))

    def test_interruption_requires_actual_named_fault(self):
        payload = migration_payload("interrupted")
        payload["fault"] = "none"
        self.assertTrue(adapters.migration_errors(payload,"interrupted",0))

    def test_migration_runs_exact_roster_and_requires_passing_baselines(self):
        calls = []
        def process(command, **kwargs):
            scenario = command[-1]
            calls.append(scenario)
            return SimpleNamespace(returncode=1 if scenario == "malformed" else 0,
                stdout=json.dumps(migration_payload(scenario)),stderr="")
        with patch.object(adapters.subprocess,"run",side_effect=process):
            rows, controls, errors = adapters.run_migration(Path.cwd(),sys.executable,{},10)
        self.assertEqual(calls,list(adapters.SCENARIOS))
        self.assertEqual(len(rows),5)
        self.assertEqual(len(controls),1)
        self.assertEqual(errors,[])
        self.assertEqual(controls[0]["classification"],"expected_negative")
        def failed_baseline(command, **kwargs):
            result = process(command,**kwargs)
            if command[-1] == "ordinary":
                result.returncode = 1
            return result
        with patch.object(adapters.subprocess,"run",side_effect=failed_baseline):
            rows, controls, errors = adapters.run_migration(Path.cwd(),sys.executable,{},10)
        self.assertTrue(errors)
        self.assertEqual(controls[0]["classification"],"failed")
        self.assertFalse(controls[0]["baseline_passed"])

    def _wire(self, modules, code=0, cleanup=None):
        def process(command, **kwargs):
            Path(command[command.index("--json-output")+1]).write_text(json.dumps({
                "schema":"orgtree.python-verification/v1","modules":modules,
                "cleanup_errors":cleanup or [],"summary":{"cleanup_errors":len(cleanup or [])}}),encoding="utf-8")
            return SimpleNamespace(returncode=code,stderr="")
        with tempfile.TemporaryDirectory() as folder, patch.object(adapters.subprocess,"run",side_effect=process):
            return adapters.run_wire(Path.cwd(),Path(folder),sys.executable,{},10,runner.component_results)

    def test_wire_coverage_requires_both_reviewed_suites_and_counts(self):
        good = [dict(module=name,phase="pass",tests_ran=count,structured_result=True,
                     exit_code=0,failure_id=None,cleanup_errors=[]) for name,count in zip(adapters.WIRE_MODULES,(11,1))]
        rows, controls, errors = self._wire(good)
        self.assertEqual(errors,[])
        self.assertTrue(all(row["level"] == "composed" for row in rows))
        for modules in ([],good[:1],[good[0],good[0]],[{**good[0],"tests_ran":1},good[1]]):
            rows, controls, errors = self._wire(modules)
            self.assertTrue(errors)
        self.assertTrue(self._wire(good,code=1)[2])
        self.assertTrue(self._wire(good,cleanup=["left a worker"])[2])
        self.assertTrue(self._wire([{**good[0],"stderr":"Ran 11 tests in 1.0s\n\nOK (skipped=1)\n"},good[1]])[2])
        self.assertEqual(self._wire([{**good[0],"stderr":"test_skipped_word still passed\nOK\n"},good[1]])[2],[])

    def test_failed_requested_adapter_is_visible_and_does_not_hide_other_adapter(self):
        options = SimpleNamespace(concurrency=[1],operations=2,rate=24,demand_multipliers=[1],
                                  python=None,timeout=10,components=False,wire=True,migration=True)
        verification = SimpleNamespace(select_interpreter=lambda *a:SimpleNamespace(path=sys.executable,version="test"))
        passed = {"classification":"passed","observed":{}}
        exercise = {"workloads":[passed],"controls":passed,"provenance":[]}
        with patch.object(runner,"identity",return_value={"commit":"a"*40}), \
             patch.object(runner,"verification_module",return_value=verification), \
             patch.object(runner,"run_child",side_effect=[exercise,{"recovery":passed}]), \
             patch.object(runner,"negative_controls",return_value=[{"classification":"expected_negative"}]), \
             patch.object(runner,"run_wire",side_effect=RuntimeError("no wire receipt")), \
             patch.object(runner,"run_migration",return_value=([{**passed,"id":"migration.ordinary"}],[],[])) as migration:
            report = runner.run(Path.cwd(),options)
        self.assertFalse(report["slice_passed"])
        self.assertTrue(report["cleanup"]["completed"])
        self.assertTrue(report["config"]["wire"])
        self.assertTrue(report["config"]["migration"])
        self.assertEqual(migration.call_count,1)
        self.assertTrue(any(row.get("id") == "wire-compatibility" and row["classification"] == "failed" for row in report["adapters"]))
        self.assertTrue(any(row.get("id") == "migration.ordinary" for row in report["adapters"]))

    def test_real_migration_cli_timeout_fixtures_are_owned_and_cleaned_by_parent(self):
        # Run the real CLI, pausing only after its real fixture was created.
        # A separate test-owned outer directory contains old-behavior leaks too.
        options = SimpleNamespace(concurrency=[1],operations=2,rate=24,demand_multipliers=[1],
                                  python=None,timeout=3,components=False,wire=False,migration=True)
        verification = SimpleNamespace(select_interpreter=lambda *a:SimpleNamespace(path=sys.executable,version="test"))
        passed = {"classification":"passed","observed":{}}
        exercise = {"workloads":[passed],"controls":passed,"provenance":[]}
        real_process = adapters.subprocess.run
        script = '''import os,runpy,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from tools.migration_harness import fixtures
original = fixtures.create_fixture
def paused(root, scenario):
    original(root, scenario)
    with Path(os.environ["QUALIFICATION_TIMEOUT_PATHS"]).open("a",encoding="utf-8") as stream:
        stream.write(str(root)+"\\n")
    time.sleep(60)
fixtures.create_fixture = paused
sys.argv = sys.argv[2:]
runpy.run_module("tools.migration_harness",run_name="__main__")
'''
        with tempfile.TemporaryDirectory(prefix="qualification-timeout-test-") as directory:
            outer = Path(directory).resolve()
            paths = outer/"created-paths.txt"
            owned_roots = []
            def process(command, **kwargs):
                command = list(command)
                command[command.index("-c")+1] = script
                kwargs["env"] = {**kwargs["env"],"QUALIFICATION_TIMEOUT_PATHS":str(paths)}
                owned_roots.append(Path(kwargs["env"]["ORGTREE_DATA"]).parent)
                return real_process(command,**kwargs)
            with patch.dict(os.environ,{"TEMP":str(outer),"TMP":str(outer),"TMPDIR":str(outer)}), \
                 patch.object(runner,"identity",return_value={"commit":"a"*40}), \
                 patch.object(runner,"verification_module",return_value=verification), \
                 patch.object(runner,"run_child",side_effect=[exercise,{"recovery":passed}]), \
                 patch.object(runner,"negative_controls",return_value=[{"classification":"expected_negative"}]), \
                 patch.object(adapters.subprocess,"run",side_effect=process):
                report = runner.run(Path(__file__).resolve().parents[1],options)
            created = [Path(path) for path in paths.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(created),6,"Each real CLI must create its fixture before timing out")
            self.assertFalse(report["slice_passed"])
            self.assertTrue(report["cleanup"]["completed"])
            self.assertEqual(len(report["errors"]),6)
            for fixture,owner in zip(created,owned_roots):
                self.assertTrue(fixture.is_relative_to(owner),f"Fixture escaped parent cleanup: {fixture}")
                self.assertFalse(fixture.exists(),f"Timed-out CLI fixture remained: {fixture}")


if __name__ == "__main__":
    unittest.main()
