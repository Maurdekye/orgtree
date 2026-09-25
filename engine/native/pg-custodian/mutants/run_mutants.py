"""Mutation pass for pg-custodian's safety checks.

Each mutant breaks ONE check by an exact text replacement, runs the named
test target(s), and must make at least one test FAIL. A replacement that
matches nothing is itself a failure (the mutant never ran), so a stale mutant
cannot report "caught". The source is restored from git after every mutant,
so the crate must be committed and clean first.

    python mutants/run_mutants.py [--db]        # --db adds the database mutants

--db mutants start real clusters: run them only under the P03 run lock, with
ORGTREE_P03_PG_BIN set. Output: one JSON line per mutant, then a summary.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

CRATE = Path(__file__).resolve().parents[1]

# (id, file, old, new, cargo test args, needs_db)
MUTANTS = [
    ("guard.no_ancestor_check", "src/guard.rs",
     "            if within(&form, candidate) {",
     "            if false && within(&form, candidate) {",
     ["--test", "guard"], False),
    ("guard.no_inside_check", "src/guard.rs",
     "            if within(candidate, &form) {",
     "            if false && within(candidate, &form) {",
     ["--test", "guard"], False),
    ("guard.no_resolved_check", "src/guard.rs",
     "    refuse_protected(&real, &protected, true)?;",
     "    let _ = &real;",
     ["--test", "guard"], False),
    ("guard.case_sensitive", "src/guard.rs",
     ".trim_end_matches(['.', ' ']).to_lowercase();",
     ".trim_end_matches(['.', ' ']).to_string();",
     ["--test", "guard"], False),
    ("guard.no_trailing_dot_trim", "src/guard.rs",
     ".trim_end_matches(['.', ' ']).to_lowercase();",
     ".to_lowercase();",
     ["--test", "guard"], False),
    ("guard.no_marker_path_binding", "src/guard.rs",
     "    if marker.root_path != real {",
     "    if false && marker.root_path != real {",
     ["--test", "guard"], False),
    ("guard.no_disposable_flag", "src/guard.rs",
     "    if !marker.disposable {",
     "    if false {",
     ["--test", "guard"], False),
    ("guard.no_parent_data_var", "src/guard.rs",
     '    push("ORGTREE_AGENT_PARENT_DATA", var("ORGTREE_AGENT_PARENT_DATA"));',
     "",
     ["--test", "guard"], False),
    ("guard.no_unc_refusal", "src/guard.rs",
     '                _ => return Err(CustodianError::new("root.device_or_unc", format!("unsupported path prefix: {raw}"))),',
     '                _ => prefix = Some("unc:".into()),',
     ["--test", "guard"], False),
    ("guard.init_root_accepts_nonempty", "src/guard.rs",
     "        if entries.next().is_some() {",
     "        if false && entries.next().is_some() {",
     ["--test", "guard"], False),
    ("dev.agent_allows_separators", "src/dev.rs",
     "b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')",
     "b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'/' || b == b'\\\\' || b == b'.' || b == b':')",
     ["--test", "dev"], False),
    ("readiness.no_prepared_check", "src/cluster.rs",
     'need(get("max_prepared_transactions") == "0",',
     'need(true || get("max_prepared_transactions") == "0",',
     ["--test", "readiness"], False),
    ("readiness.unlimited_keep_accepted", "src/cluster.rs",
     'need(keep != "-1" && keep != "<missing>",',
     'need(keep != "<missing>",',
     ["--test", "readiness"], False),
    ("readiness.wildcard_listen_accepted", "src/cluster.rs",
     'need(get("listen_addresses") == LOOPBACK,',
     'need(get("listen_addresses").contains(LOOPBACK) || get("listen_addresses") == "*",',
     ["--test", "readiness"], False),
    ("roles.runtime_may_be_superuser", "src/cluster.rs",
     '            RUNTIME_ROLE => ["f", "f", "f", "f", "t", "f", "t"],',
     '            RUNTIME_ROLE => ["t", "f", "f", "f", "t", "f", "t"],',
     ["--test", "readiness"], False),
    ("roles.check_skipped", "src/cluster.rs",
     "                if got != expect(role) {",
     "                if false && got != expect(role) {",
     ["--test", "readiness"], False),
    ("qual.check_skips_bind_setting", "src/cluster.rs",
     '            ("log_parameter_max_length", "0"),\n            ("log_parameter_max_length_on_error", "0"),\n        ] {\n            if get(k) != want {',
     '            ("log_parameter_max_length_on_error", "0"),\n        ] {\n            if get(k) != want {',
     ["--test", "readiness"], False),
    ("family.ignore_creation_time", "src/win.rs",
     "&& c >= p && child.pid != parent.pid,",
     "&& child.pid != parent.pid && (c, p) == (c, p),",
     ["--test", "family"], False),
    ("family.any_parent_is_shim", "src/win.rs",
     'if parent.exe_name.eq_ignore_ascii_case("cmd.exe") && links(pm, parent) {',
     'if links(pm, parent) {',
     ["--test", "family"], False),
    ("migrate.no_checksum_check", "src/migrate.rs",
     "        if &got != want {",
     "        if false && &got != want {",
     ["--test", "migrate"], False),
    ("migrate.unlisted_files_ignored", "src/migrate.rs",
     "    if let Some(f) = on_disk.iter().find(|f| !manifest.contains_key(*f)) {",
     "    if let Some(f) = on_disk.iter().find(|f| false && !manifest.contains_key(*f)) {",
     ["--test", "migrate"], False),
    ("migrate.gaps_allowed", "src/migrate.rs",
     "!(v == p + 1 && range_start(v) == range_start(p))",
     "!(v > p)",
     ["--test", "migrate"], False),
    ("migrate.history_sha_ignored", "src/migrate.rs",
     "        if m.sha256 != a.sha256 || m.file != a.file {",
     "        if m.file != a.file {",
     ["--test", "migrate"], False),
    ("migrate.writer_check_skipped", "src/migrate.rs",
     "    if let Some(m) = pending.iter().find(|m| m.min_writer > writer_version) {",
     "    if let Some(m) = pending.iter().find(|m| false && m.min_writer > writer_version) {",
     ["--test", "migrate"], False),
    ("migrate.cr_kept", "src/migrate.rs",
     "    text.replace('\\r', \"\")",
     "    text.to_string()",
     ["--test", "migrate"], False),
    # --- database mutants (run under the P03 run lock) ---
    ("migrate.not_one_transaction", "src/migrate.rs",
     "        cluster::psql_stdin(bin, rt, APP_DB, &script, true)",
     "        cluster::psql_stdin(bin, rt, APP_DB, &script, false)",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "migrations"], True),
    ("init.commit_before_instance_record", "src/cluster.rs",
     "    if std::env::var_os(ABORT_BEFORE_COMMIT_ENV).is_some() {",
     "    let _ = fs::rename(&staging, &layout.cluster);\n    if std::env::var_os(ABORT_BEFORE_COMMIT_ENV).is_some() {",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "init_killed"], True),
    ("stop.family_without_postmaster", "src/cluster.rs",
     "    let set = win::family_pids(&snap, postmaster);",
     "    let set: Vec<u32> = win::family_pids(&snap, postmaster).into_iter().filter(|p| *p != postmaster).collect();",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cluster"], True),
    # Expected SURVIVOR in a clean stop: pg_ctl -w already waits for every
    # child, so the custodian's own wait is defence in depth that only an
    # abnormal stop (G5 drills) can exercise. Kept to keep that visible.
    ("stop.skip_family_wait", "src/cluster.rs",
     "                let ex = h.wait_exit(left);",
     "                let ex = { let _ = left; true };",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cluster"], True),
    ("start.pipe_inherited", "src/cluster.rs",
     "    win::stop_std_handle_inheritance();\n",
     "",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cli"], True),
    ("qual.bind_values_logged", "src/cluster.rs",
     '        ("log_parameter_max_length", "0".to_string()),',
     '        ("log_parameter_max_length", "-1".to_string()),',
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cluster"], True),
    # Misconfigures the real cluster; the smoke test's `ready()` must notice.
    ("config.prepared_transactions_5", "src/cluster.rs",
     "    s.insert(\"max_prepared_transactions\".into(), \"0\".into());",
     "    s.insert(\"max_prepared_transactions\".into(), \"5\".into());",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cluster"], True),
    ("hba.trust", "src/cluster.rs",
     "host    all          all   127.0.0.1/32  scram-sha-256\\r\\n\\",
     "host    all          all   127.0.0.1/32  trust\\r\\n\\",
     ["--test", "smoke_cluster", "--", "--ignored", "--test-threads=1", "dev_cluster"], True),
]


# Survivors that are understood and documented next to their mutant above.
# The run passes only if every OTHER mutant is caught.
EXPECTED_SURVIVORS = {"stop.skip_family_wait"}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=CRATE, capture_output=True, text=True, check=True).stdout.strip()


def main() -> int:
    with_db = "--db" in sys.argv[1:]
    if git("status", "--porcelain", "--", "."):
        print("refusing: crate has uncommitted changes (restore uses git checkout)", file=sys.stderr)
        return 2
    head = git("rev-parse", "HEAD")
    results = []
    for mid, rel, old, new, targs, needs_db in MUTANTS:
        if needs_db and not with_db:
            continue
        path = CRATE / rel
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        crlf = "\r\n" in text
        norm = text.replace("\r\n", "\n")
        count = norm.count(old)
        if count != 1:
            results.append({"mutant": mid, "verdict": "NOT_APPLIED", "matches": count})
            print(json.dumps(results[-1]), flush=True)
            continue
        mutated = norm.replace(old, new)
        if crlf:
            mutated = mutated.replace("\n", "\r\n")
        path.write_bytes(mutated.encode("utf-8"))
        try:
            # Output goes to a FILE, not a pipe: a postmaster a failing test
            # leaves behind must not be able to hold our pipe open (that hung
            # the gated run at b50745c). The timeout turns any hang into a
            # recorded verdict.
            out_path = CRATE.parent.parent.parent / "artifacts" / f"mutant-{mid}.log"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with open(out_path, "w", encoding="utf-8") as fh:
                    proc = subprocess.run(["cargo", "test", *targs], cwd=CRATE, stdout=fh, stderr=subprocess.STDOUT,
                                          stdin=subprocess.DEVNULL, timeout=900)
            except subprocess.TimeoutExpired:
                results.append({"mutant": mid, "verdict": "TIMEOUT", "log": str(out_path)})
                continue
            out = out_path.read_text(encoding="utf-8", errors="replace")
            compiled = "error[" not in out and "could not compile" not in out
            failed = [l.split(" ")[1] for l in out.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")]
            if not compiled:
                verdict = "COMPILE_ERROR"
            elif proc.returncode != 0 and failed:
                verdict = "CAUGHT"
            elif proc.returncode == 0:
                verdict = "SURVIVED"
            else:
                verdict = "CRASHED"
            results.append({"mutant": mid, "verdict": verdict, "failed_tests": failed, "exit": proc.returncode})
        finally:
            git("checkout", "HEAD", "--", rel)
        print(json.dumps(results[-1]), flush=True)
    summary = {
        "schema": "orgtree.p03.ws1-mutants/v1",
        "commit": head,
        "with_db": with_db,
        "total": len(results),
        "caught": sum(r["verdict"] == "CAUGHT" for r in results),
        "not_caught": [r["mutant"] for r in results if r["verdict"] != "CAUGHT"],
        "expected_survivors": sorted(EXPECTED_SURVIVORS),
    }
    summary["unexpected"] = [m for m in summary["not_caught"]
                             if not (m in EXPECTED_SURVIVORS and any(r["mutant"] == m and r["verdict"] == "SURVIVED" for r in results))]
    print("P03-WS1-MUTANTS " + json.dumps(summary), flush=True)
    return 0 if not summary["unexpected"] else 1


if __name__ == "__main__":
    sys.exit(main())
