"""Invoke reviewed sibling probes, preserving their actual evidence boundaries."""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time

WIRE_MODULES = ["tests/test_wire_contract.py", "tests/test_wire_contract_controls.py"]
SCENARIOS = ("ordinary", "sqlite", "partial", "large", "interrupted", "malformed")
MIGRATION_CHECKS = {"backup_verified", "source_unchanged", "candidate_conservation",
                    "retry_same_receipt", "rollback_byte_equal", "rollback_readable"}
MIGRATION_GAPS = {"native_schema_import", "live_source_capture", "activation_writer_fences",
                  "post_activation_current_state_rollback", "power_loss_durability",
                  "streaming_memory_bounds", "external_effect_reconciliation"}
MIGRATION_LIMITS = [
    "Schema-neutral synthetic envelope only; no native importer, cutover or activation",
    "Rollback reconstructs pre-activation source; no current-state post-acknowledgment rollback",
    "Interrupted CLI uses an exception after local publication; no abrupt-exit or power-loss claim",
    "Scenario duration is total fixture/rehearsal cost, not native migration latency",
]
WIRE_LIMITS = [
    "Current Python compatibility through synthetic TCP HTTP/WS and real MCP stdio",
    "Application lifespan disabled; no provider execution or installed application",
    "Legacy WebSocket profile; no native v3 durable-feed qualification",
    "Module receipts retain tests_ran; no independent per-subtest outcome ledger",
]


def encoded(value):
    # Public migration receipt format: sorted compact UTF-8 JSON plus newline.
    return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)+"\n").encode("utf-8")


def migration_errors(payload, scenario, returncode):
    """Validate the public report contract; do not reproduce migration semantics."""
    errors = []
    if not isinstance(payload, dict):
        return ["migration report must be an object"]
    if (payload.get("format") != "orgtree-synthetic-migration-report"
            or type(payload.get("version")) is not int or payload["version"] != 1
            or payload.get("scenario") != scenario):
        errors.append("migration report format/version/scenario mismatch")
    if (payload.get("synthetic") is not True or payload.get("activation_allowed") is not False
            or payload.get("mapping_status") != "preserved_unmapped"):
        errors.append("migration evidence authority boundary changed")
    gaps = payload.get("not_exercised")
    if not isinstance(gaps, list) or any(not isinstance(gap, str) for gap in gaps) or not MIGRATION_GAPS.issubset(gaps):
        errors.append("migration native limitations are missing")
    if scenario == "malformed":
        if (returncode != 1 or payload.get("result") != "refused"
                or payload.get("classification") != "known_negative" or payload.get("reason") != "invalid JSON"):
            errors.append("malformed fixture did not produce the expected invalid-JSON refusal")
        return errors
    if returncode != 0 or payload.get("result") != "passed" or payload.get("classification") != "met":
        errors.append("migration scenario did not pass")
    checks = payload.get("checks")
    if not isinstance(checks, dict) or set(checks) != MIGRATION_CHECKS or any(value is not True for value in checks.values()):
        errors.append("migration conservation checks missing or unsuccessful")
    expected_fault = "python_exception_after_publish" if scenario == "interrupted" else "none"
    if payload.get("fault") != expected_fault:
        errors.append("migration interruption mechanism mismatch")
    receipt, rollback = payload.get("receipt"), payload.get("rollback_receipt")
    if not isinstance(receipt, dict) or receipt.get("state") != "complete":
        errors.append("migration complete receipt missing")
    if (not isinstance(rollback, dict) or rollback.get("state") != "restored"
            or rollback.get("authority") != "none" or rollback.get("post_activation") is not False):
        errors.append("migration pre-activation restore receipt missing")
    if isinstance(receipt, dict) and isinstance(rollback, dict):
        plan = receipt.get("plan", {})
        source = plan.get("source_manifest") if isinstance(plan, dict) else None
        if (not source or encoded(source) != encoded(rollback.get("source_manifest"))
                or encoded(source) != encoded(rollback.get("restored_manifest"))):
            errors.append("migration receipt source/restore manifests disagree")
        if not isinstance(plan, dict) or encoded(payload.get("inventory")) != encoded(plan.get("inventory")) or not isinstance(payload.get("inventory"), dict):
            errors.append("migration receipt inventory mismatch")
        if isinstance(plan, dict) and (plan.get("authority") != "none"
                or plan.get("activation_allowed") is not False or plan.get("mapping_status") != "preserved_unmapped"
                or not plan.get("operation_key") or plan.get("operation_key") != rollback.get("operation_key")):
            errors.append("migration receipt authority/operation mismatch")
        source_hash = hashlib.sha256(encoded(source)).hexdigest()
        if source_hash != payload.get("source_manifest_sha256") or source_hash != receipt.get("backup_sha256"):
            errors.append("migration source manifest hash mismatch")
        if hashlib.sha256(encoded(receipt)).hexdigest() != payload.get("receipt_sha256"):
            errors.append("migration receipt hash mismatch")
    for name in ("receipt_sha256", "source_manifest_sha256"):
        if not isinstance(payload.get(name), str) or not re.fullmatch(r"[0-9a-f]{64}", payload[name]):
            errors.append(f"migration {name} missing")
    return errors


def run_migration(repo, interpreter, env, timeout):
    rows, controls, errors = [], [], []
    # Explicit checkout insertion also works with the existing embedded runtime.
    bootstrap = ("import runpy,sys; sys.path.insert(0,sys.argv[1]); "
                 "sys.argv=sys.argv[2:]; runpy.run_module('tools.migration_harness',run_name='__main__')")
    for scenario in SCENARIOS:
        started = time.monotonic()
        row = {"id":f"migration.{scenario}", "level":"component", "limits":MIGRATION_LIMITS,
               "boundary":"reviewed synthetic migration CLI; no backend import or activation"}
        try:
            result = subprocess.run([interpreter,"-I","-B","-c",bootstrap,str(repo),
                "tools.migration_harness","--scenario",scenario],cwd=repo,env=env,
                capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=timeout)
            payload = json.loads(result.stdout)
            row["receipt"], row["exit_code"] = payload, result.returncode
            row["errors"] = migration_errors(payload,scenario,result.returncode)
            if result.stderr:
                row["stderr_tail"] = result.stderr[-2000:]
        except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
            row["errors"] = [f"{type(exc).__name__}: {exc}"]
        row["elapsed_s"] = time.monotonic()-started
        if scenario == "malformed":
            baseline = len(rows) == 5 and all(r["classification"] == "passed" for r in rows)
            row.update(baseline_passed=baseline,detected=not row["errors"],
                       mechanism="generated malformed source through unchanged CLI")
            row["classification"] = "expected_negative" if baseline and not row["errors"] else "failed"
            controls.append(row)
        else:
            row["classification"] = "failed" if row["errors"] else "passed"
            rows.append(row)
        errors.extend(f"{row['id']}: {error}" for error in row["errors"])
    return rows, controls, errors


def run_wire(repo, root, interpreter, env, timeout, component_results):
    receipt = root / "wire.json"
    result = subprocess.run([interpreter,"-B",str(repo/"tools/run-python-verification.py"),
        "--repo-root",str(repo),"--python",interpreter,"--json-output",str(receipt),
        "--timeout",str(timeout),*WIRE_MODULES],cwd=repo,env=env,capture_output=True,
        text=True,encoding="utf-8",errors="replace",timeout=timeout*len(WIRE_MODULES)+30)
    if not receipt.is_file():
        raise RuntimeError(f"wire runner produced no receipt: {result.stderr[-2000:]}")
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    rows, errors = component_results(payload,WIRE_MODULES)
    if result.returncode or payload.get("cleanup_errors") != [] or payload.get("summary",{}).get("cleanup_errors") != 0:
        errors.append("wire runner failed or reported cleanup errors")
    for row in rows:
        row.update(level="composed",limits=WIRE_LIMITS,
                   boundary="production HTTP/WS/MCP with isolated fixture server; no lifespan")
        expected = 11 if row["id"] == WIRE_MODULES[0] else 1
        if row["receipt"].get("tests_ran") != expected:
            row["classification"] = "failed"
            errors.append(f"wire coverage count changed for {row['id']}: expected {expected}")
        # The legacy module receipt has no structured per-test skip count.
        # Recognize unittest's terminal summary, never arbitrary prose 'skip'.
        if re.search(r"^OK \([^\r\n]*\bskipped=[1-9][0-9]*",row["receipt"].get("stderr",""),re.MULTILINE):
            row["classification"] = "failed"
            errors.append(f"wire suite skipped a scenario: {row['id']}")
    return rows, [], errors
