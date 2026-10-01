"""Run the four cheap SOURCE AUDITS before landing: about a minute, no database.

Every new or edited test module can break these without touching product code,
and they were the bulk of the 21 python regressions found at v3 34c8649
(fix-the-21-new-python-backend-test-failures-befo):

  tests/test_import_provenance.py        every test module carries the ONE guard line
  tests/test_hub_isolation.py            a file that names the launcher isolates the hub
                                         (or is EXEMPT with a reason)
  tests/test_child_spawn_gate.py         every sys.executable mention is allowlisted
  tests/test_no_duplicate_definitions.py every Python file parses (no U+FEFF BOM) and
                                         defines each name once

plus one in-process check, first and in milliseconds: the NATIVE VECTOR ANCHORS.
Each engine/native/<crate>/vectors/*.json records the sha256 of the Python files
its oracle reads (ledger.py, api.py, ...), so ANY edit to one of those files
fails that crate's vector test until the vectors are regenerated. This check
compares the recorded hashes with the files as checked out, names each stale
one, and prints the regenerate command. It says nothing about the vectors
themselves -- only the crate's vector test does.

Usage (from the checkout you are about to land, after your final rebase):

    python tools/source-audits.py [--json-output PATH]

It checks the anchors, then runs the four modules through
tools/run-python-verification.py (one fresh interpreter each, this checkout's
provenance) one at a time, prints each module's result line and first failure,
and exits 0 only when the anchors and all four modules pass.
It is not a test-baseline run and takes no lock; still check the machine's
test gate first, as for any module run."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
AUDITS = ("tests/test_import_provenance.py", "tests/test_hub_isolation.py",
          "tests/test_child_spawn_gate.py", "tests/test_no_duplicate_definitions.py")


VECTORS = {"backend-codec": "backend-codec-vectors.json", "op-receipt-codec": "op-receipt-vectors.json",
           "funding-core": "funding-vectors.json", "scope-clamp": "scope-clamp-vectors.json"}


def stale_anchors(repo: Path = REPO) -> list[tuple[str, str]]:
    """(crate, path) for every recorded source anchor that no longer matches the file.

    The oracles hash the checked-out bytes (CRLF here), so this does too. Two
    shapes are on disk: a list of {path, sha256} (backend-codec, op-receipt) and a
    {path: sha256} dict (funding-core, scope-clamp). A missing or unreadable
    vector file raises: an audit that silently checked nothing would read as PASS."""
    stale = []
    for crate, name in VECTORS.items():
        doc = json.loads((repo / "engine/native" / crate / "vectors" / name).read_text(encoding="utf-8"))
        anchors = doc["oracle"]["anchors"]
        pairs = (anchors.items() if isinstance(anchors, dict)
                 else ((a["path"], a["sha256"]) for a in anchors))
        pairs = list(pairs)
        if not pairs:
            raise ValueError(f"{crate}: no source anchors recorded")
        for path, recorded in pairs:
            source = repo / path
            if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != recorded:
                stale.append((crate, path))
    return stale


def anchor_audit() -> bool:
    stale = stale_anchors()
    if not stale:
        print(f"PASS native vector anchors: {len(VECTORS)} crates match their source files")
        return True
    print("FAIL native vector anchors: a file an oracle hashes changed since its vectors were written")
    for crate, path in stale:
        print(f"      {crate}: {path}")
    print("      Run the crate's vector test first (tests/test_<crate>_vectors.py). Regenerate ONLY if it")
    print("      fails on the oracle's anchors alone; any other difference means an encoded rule")
    print("      changed -- stop and find out why. To regenerate, per crate:")
    for crate in sorted({c for c, _ in stale}):
        print(f"        engine\\runtime\\python.exe engine/native/{crate}/oracle/generate_vectors.py --write")
    if any(c == "scope-clamp" for c, _ in stale):
        print("      then `git checkout -- engine/native/scope-clamp/src/tables.rs` if its diff is line endings only.")
    return False


def first_failure(stderr: str) -> str:
    """The first FAIL/ERROR block's assertion text, a few lines, for the summary."""
    blocks = stderr.split("=" * 70)[1:]
    if not blocks:
        return ""
    lines = [ln for ln in blocks[0].splitlines() if ln.strip()]
    tail = [ln for ln in lines if ln.startswith(("AssertionError", "SyntaxError", "- ", "+ "))]
    return "\n      ".join([lines[0]] + tail[:6])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json-output", type=Path, help="also write every module's receipt here")
    args = parser.parse_args()
    try:
        ok = anchor_audit()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"CANNOT RUN the native vector anchor check: {type(exc).__name__}: {exc}")
        return 2
    results = []
    with tempfile.TemporaryDirectory(prefix="source-audits-") as tmp:
        for module in AUDITS:
            receipt = Path(tmp) / (Path(module).stem + ".json")
            proc = subprocess.run([sys.executable, "tools/run-python-verification.py", module,
                                   "--timeout", "300", "--json-output", str(receipt)],
                                  cwd=REPO, capture_output=True, text=True, timeout=420)
            try:
                data = json.loads(receipt.read_text(encoding="utf-8"))
                row = data["modules"][0]
            except (OSError, ValueError, KeyError, IndexError):
                print(f"CANNOT RUN {module}: runner exit {proc.returncode}\n{proc.stderr[-800:]}")
                return 2
            stderr = row.get("stderr", "")
            summary = [ln for ln in stderr.splitlines() if ln.startswith(("Ran ", "OK", "FAILED"))]
            passed = proc.returncode == 0 and any(ln.startswith("OK") for ln in summary)
            ok = ok and passed
            print(f"{'PASS' if passed else 'FAIL'} {module}: {' / '.join(summary) or '(no result line)'}")
            if not passed:
                print("      " + first_failure(stderr))
            results.append({"module": module, "passed": passed, "summary": summary,
                            "runner_exit": proc.returncode, "import_provenance": row.get("import_provenance"),
                            "stderr": stderr})
    if args.json_output:
        args.json_output.write_text(json.dumps({"repo": str(REPO), "modules": results}, indent=2) + "\n",
                                    encoding="utf-8")
    print("SOURCE AUDITS: " + ("PASS" if ok else "FAIL (fix these before landing)"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
