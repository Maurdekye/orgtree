"""Mutation pass for tools/pypg/pgimport.py (PYPG PG-2; import is risky code).

Each mutant is one exact replacement that must match exactly once (else
NOT_APPLIED). The suite runs through the safe runner
tools/run-python-verification.py (import provenance recorded), and the file is
restored from git afterwards, so the target and suite must be committed and
clean.

    python tools/pypg/run_pgimport_mutants.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = "tools/pypg/pgimport.py"
SUITE = "tests/test_pgimport.py"

MUTANTS = [
    ("read.always_plain_readonly", 'mode = "?mode=ro&immutable=1" if at_rest else "?mode=ro"', 'mode = "?mode=ro"'),
    ("read.always_immutable", 'mode = "?mode=ro&immutable=1" if at_rest else "?mode=ro"', 'mode = "?mode=ro&immutable=1"'),
    ("recognise.extra_tables", '    out += [f"unrecognised table {t!r}" for t in org.extra_tables]\n', ''),
    ("recognise.extra_columns", '    out += [f"table {t!r} has unrecognised or missing columns {c}" for t, c in org.extra_columns.items()]\n', ''),
    ("recognise.unknown_sections", 'for k in doc_keys if k not in KNOWN_DOC_KEYS]', 'for k in doc_keys if False]'),
    ("recognise.lazy_as_doc", '    out += [f"section {k!r} is a lazy log but is stored as a document row" for k in doc_keys\n', '    out += [] and [f"section {k!r} is a lazy log but is stored as a document row" for k in doc_keys\n'),
    ("recognise.dict_log_sections", '        out.append(f"unrecognised dict-log section {sect!r}")', '        pass'),
    ("recognise.list_log_sections", '        out.append(f"unrecognised list-log section {sect!r}")', '        pass'),
    ("recognise.meta_keys", '        if prefix is None or key[len(prefix):] not in DICT_LOGS:', '        if prefix is None and False:'),
    ("recognise.owner_prefix_any_suffix", '        if prefix is None or key[len(prefix):] not in DICT_LOGS:', '        if prefix is None:'),
    ("recognise.values", '                out.append(f"{table} row {row[0]!r}: value {why}")', '                pass'),
    ("recognise.nul", '    if "\\x00" in text:\n        return "contains a NUL character', '    if False:\n        return "contains a NUL character'),
    ("manifest.raw_values", '        out.append(json.loads(value) if name == "val" and parse else value)', '        out.append(value)'),
    ("manifest.meta_always_parsed", '    parse = table != "meta" or _meta_is_json(row[0])', '    parse = True'),
    ("manifest.unsorted", '        ordered = sorted(rows.get(table, []), key=lambda r: r[key])', '        ordered = list(rows.get(table, []))'),
    ("layout.json_beside_db_accepted", '        if ext == "json" and (orgs / f"{stem}.db").exists():\n            out["refused"]', '        if False:\n            out["refused"]'),
    ("layout.unknown_file_accepted", '        if not dot or ext not in ("db", "json") or not _SLUG.match(stem):\n            out["refused"].append(f"orgs/{name}: unrecognised file")\n            continue\n', '        if not dot or ext not in ("db", "json") or not _SLUG.match(stem):\n            continue\n'),
    ("import.dry_run_refusal_ignored", '    if plan["refused"]:\n        raise ImportRefused("the dry run refused: "', '    if False:\n        raise ImportRefused("the dry run refused: "'),
    ("import.no_read_back", '        if back != m:', '        if False:'),
    ("import.resume_trusts_receipt", '                and manifest_digest(manifest(sink.read_org(slug))) == digest:', ':'),
    ("import.resume_ignores_fingerprint", '        if before and before.get("source_fingerprint") == org.source_fingerprint \\\n                and before.get("manifest_sha256") == digest \\\n', '        if before \\\n'),
    ("cutover.dirty_dry_run", '    if dry.get("refused"):\n        raise ImportRefused("cutover refused', '    if False:\n        raise ImportRefused("cutover refused'),
    ("cutover.missing_orgs", '    if missing:\n        raise', '    if False:\n        raise'),
    ("cutover.mismatch", '    if mismatched:\n        raise', '    if False:\n        raise'),
]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()


def main() -> int:
    if git("status", "--porcelain", "--", TARGET, SUITE):
        print("refusing: target or suite has uncommitted changes", file=sys.stderr)
        return 2
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 else None
    head = git("rev-parse", "HEAD")
    path = REPO / TARGET
    results = []
    for mid, old, new in MUTANTS:
        if only and mid not in only:
            continue
        text = path.read_bytes().decode("utf-8")
        crlf = "\r\n" in text
        norm = text.replace("\r\n", "\n")
        if norm.count(old) != 1:
            results.append({"mutant": mid, "verdict": "NOT_APPLIED", "matches": norm.count(old)})
            print(json.dumps(results[-1]), flush=True)
            continue
        mutated = norm.replace(old, new)
        path.write_bytes((mutated.replace("\n", "\r\n") if crlf else mutated).encode("utf-8"))
        out = REPO / "artifacts" / f"pg2-mutant-{mid}.json"
        out.parent.mkdir(exist_ok=True)
        try:
            subprocess.run([sys.executable, "tools/run-python-verification.py", "--json-output", str(out), SUITE],
                           cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
            d = json.loads(out.read_text(encoding="utf-8"))
            m = d["modules"][0]
            prov = (m.get("import_provenance") or {}).get("orgtree", "")
            verdict = "CAUGHT" if m.get("phase") != "pass" else "SURVIVED"
            if str(REPO).lower() not in prov.lower():
                verdict = "BAD_PROVENANCE"
            results.append({"mutant": mid, "verdict": verdict, "phase": m.get("phase"), "orgtree_from": prov})
        finally:
            git("checkout", "HEAD", "--", TARGET)
        print(json.dumps(results[-1]), flush=True)
    summary = {"schema": "orgtree.pypg.pg2-mutants/v1", "commit": head, "total": len(results),
               "caught": sum(r["verdict"] == "CAUGHT" for r in results),
               "not_caught": [r["mutant"] for r in results if r["verdict"] != "CAUGHT"]}
    print("PYPG-PG2-MUTANTS " + json.dumps(summary), flush=True)
    return 0 if not summary["not_caught"] else 1


if __name__ == "__main__":
    sys.exit(main())
