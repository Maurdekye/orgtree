"""Mutation pass for engine/pg_process.py (the engine's PostgreSQL bracket, PYPG PG-1).

Same rules as run_mutants.py: each mutant is one exact replacement that must
match exactly once (else NOT_APPLIED), the suite runs through the safe runner
tools/run-python-verification.py (import provenance recorded), and the file is
restored from git afterwards, so the tree must be committed and clean.

    python engine/native/pg-custodian/mutants/run_py_mutants.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
TARGET = "engine/pg_process.py"
SUITE = "tests/test_pg_process.py"

MUTANTS = [
    ("pg1.no_overlap_check", "                if _within(c, form) or _within(form, c):", "                if False:"),
    ("pg1.ancestor_allowed", "                if _within(c, form) or _within(form, c):", "                if _within(c, form):"),
    ("pg1.unmarked_root_accepted", "    if not (root / MARKER_FILE).is_file():\n        raise", "    if False:\n        raise"),
    ("pg1.unc_root_touched", '    if str(root).replace("/", "\\\\").startswith("\\\\\\\\"):\n        raise', '    if False:\n        raise'),
    ("pg1.relative_exe_accepted", "    if not path.is_absolute() or not path.is_file():", "    if not path.is_file() and False:"),
    ("pg1.inert_check_loose", '    return env.get(STORE_ENV, "").strip().lower() == "postgres"', '    return bool(env.get(STORE_ENV, "").strip())'),
    ("pg1.stale_conninfo_kept", "        env.pop(CONNINFO_ENV, None)  # never a stale connection from a parent\n", ""),
    ("pg1.second_start_when_running", '    if state in ("stopped", "stale_pid"):', '    if state in ("stopped", "stale_pid", "running"):'),
    ("pg1.unidentified_served", "    elif state != \"running\":\n        raise BracketError(f\"the database is {state}", "    elif False:\n        raise BracketError(f\"the database is {state}"),
    ("pg1.attach_result_ignored", "    if not attach.get(\"ok\"):\n        raise BracketError(f\"pg-custodian attach refused", "    if False:\n        raise BracketError(f\"pg-custodian attach refused"),
    ("pg1.no_cleanup_on_failure", "        except BaseException:\n            self.stop()\n            raise", "        except BaseException:\n            raise"),
    ("pg1.migration_skipped", "            self.migration = run_migrations(migrator or default_migrator(), admin)\n", ""),
    ("pg1.migration_error_swallowed", "        raise BracketError(f\"migrations failed: {type(exc).__name__}: {exc}\") from exc", "        report = {\"folder\": \".\"}"),
    ("pg1.missing_folder_accepted", "    if not folder or not Path(str(folder)).is_dir():\n        raise", "    if False:\n        raise"),
    ("pg1.missing_pgstore_skipped", "        raise BracketError(f\"{STORE_ENV}=postgres, but orgtree.pgstore (PG-0) is not importable: {exc}\") from exc", "        return lambda c: {\"folder\": \".\"}"),
    ("pg1.engine_gets_admin_role", '            self.conninfo = conninfo(runtime, RUNTIME_ROLE, "orgtree-engine")', '            self.conninfo = admin'),
    ("pg1.scram_not_required", " require_auth=scram-sha-256 sslmode=disable \"", " sslmode=disable \""),
    ("pg1.token_passed_on", '    child_env = {k: v for k, v in env.items() if k not in ("ORGTREE_V2_TOKEN", CONNINFO_ENV)}', "    child_env = dict(env)"),
    ("pg1.no_refusal_line", "        record_refusal(str(exc), root)\n", ""),
    ("pg1.stop_not_idempotent", "            self.database = None\n        return report", "        return report"),
]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()


def main() -> int:
    if git("status", "--porcelain", "--", TARGET, SUITE):
        print("refusing: target or suite has uncommitted changes", file=sys.stderr)
        return 2
    head = git("rev-parse", "HEAD")
    path = REPO / TARGET
    results = []
    for mid, old, new in MUTANTS:
        text = path.read_bytes().decode("utf-8")
        crlf = "\r\n" in text
        norm = text.replace("\r\n", "\n")
        if norm.count(old) != 1:
            results.append({"mutant": mid, "verdict": "NOT_APPLIED", "matches": norm.count(old)})
            print(json.dumps(results[-1]), flush=True)
            continue
        mutated = norm.replace(old, new)
        path.write_bytes((mutated.replace("\n", "\r\n") if crlf else mutated).encode("utf-8"))
        out = REPO / "artifacts" / f"pymutant-{mid}.json"
        try:
            proc = subprocess.run([sys.executable, "tools/run-python-verification.py", "--json-output", str(out), SUITE],
                                  cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
            d = json.loads(out.read_text(encoding="utf-8"))
            m = d["modules"][0]
            prov = (m.get("import_provenance") or {}).get("engine", "")
            ok_prov = str(REPO).lower() in prov.lower()
            verdict = "CAUGHT" if m.get("phase") != "pass" else "SURVIVED"
            if not ok_prov:
                verdict = "BAD_PROVENANCE"
            results.append({"mutant": mid, "verdict": verdict, "phase": m.get("phase"), "engine_from": prov})
        finally:
            git("checkout", "HEAD", "--", TARGET)
        print(json.dumps(results[-1]), flush=True)
    summary = {"schema": "orgtree.pypg.pg1-py-mutants/v1", "commit": head, "total": len(results),
               "caught": sum(r["verdict"] == "CAUGHT" for r in results),
               "not_caught": [r["mutant"] for r in results if r["verdict"] != "CAUGHT"]}
    print("PYPG-PG1-PY-MUTANTS " + json.dumps(summary), flush=True)
    return 0 if not summary["not_caught"] else 1


if __name__ == "__main__":
    sys.exit(main())
