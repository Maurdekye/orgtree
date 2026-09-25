"""Mutation pass for engine/p03_custodian.py (the host bracket).

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
TARGET = "engine/p03_custodian.py"
SUITE = "tests/test_p03_custodian.py"

MUTANTS = [
    ("bracket.no_overlap_check", "                if _within(c, form) or _within(form, c):", "                if False:"),
    ("bracket.ancestor_allowed", "                if _within(c, form) or _within(form, c):", "                if _within(c, form):"),
    ("bracket.variables_without_marker_accepted", "    if not marked:\n        raise BracketError(", "    if False:\n        raise BracketError("),
    ("bracket.marker_without_variables_inert", "    if not marked and not configured:\n        return None", "    if not configured:\n        return None"),
    ("bracket.relative_exe_accepted", "    if not path.is_absolute() or not path.is_file():", "    if not path.is_file() and False:"),
    ("bracket.second_start_when_running", '    if state in ("stopped", "stale_pid"):', '    if state in ("stopped", "stale_pid", "running"):'),
    ("bracket.no_cleanup_on_store_failure", "        except BaseException:\n            self.stop()\n            raise", "        except BaseException:\n            raise"),
    ("bracket.attach_result_ignored", "    if not attach.get(\"ok\"):\n        raise BracketError(f\"pg-custodian attach refused", "    if False:\n        raise BracketError(f\"pg-custodian attach refused"),
    ("bracket.token_passed_on", '    child_env = {k: v for k, v in env.items() if k != "ORGTREE_V2_TOKEN"}', "    child_env = dict(env)"),
    ("bracket.wrong_ready_pid_accepted", 'or value.get("pid") != self.proc.pid:', ':'),
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
    summary = {"schema": "orgtree.p03.ws1-py-mutants/v1", "commit": head, "total": len(results),
               "caught": sum(r["verdict"] == "CAUGHT" for r in results),
               "not_caught": [r["mutant"] for r in results if r["verdict"] != "CAUGHT"]}
    print("P03-WS1-PY-MUTANTS " + json.dumps(summary), flush=True)
    return 0 if not summary["not_caught"] else 1


if __name__ == "__main__":
    sys.exit(main())
