"""P03 WS7: do a backend's pending table statistics flush while its transaction is open?

Decision 6 (p03-lead, 2026-09-25) makes trace.xact_stats per-transaction only as
a BASELINE DIFFERENCE (after-read minus a read taken after the transaction's first
statement), and asks WS7 to VERIFY that the difference is exact: that nothing
flushes the backend's pending counters while its transaction is open.

Session A, on a table only this probe touches:
  1. an autocommit statement (1 scan) - leaves a PENDING count behind;
  2. BEGIN; the baseline read (shows whether step 1's count is still pending);
  3. a scan; ~3 s IDLE IN TRANSACTION (client-side wait, beyond the 1 s minimum
     stats-flush interval); a scan; ~3 s idle again; the after-read; COMMIT.
Session B runs statements throughout, so the server is not idle.

Expected if nothing flushes inside the transaction: after - baseline == 2 exactly.
The probe reports baseline, after and the difference, and whether step 1's count
was still pending at the baseline (it reproduces the pooled-connection finding
when it is). It interprets nothing into a pass beyond those numbers.

Child output goes to FILES, never pipes, and every child has a timeout (WS1's
Windows handle-inheritance lesson). Run under the P03 run lock, URL by name:
    python -I -B tools/p03/probes/xact_flush_probe.py --psql <psql.exe> --url-env P03_PG_ADMIN_URL --work <dir> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[3]


def pg_env(url: str, app: str) -> dict[str, str]:
    u = urllib.parse.urlparse(url)
    if u.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(f"refusing a non-loopback PostgreSQL URL (host {u.hostname!r})")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update(PGHOST=u.hostname or "", PGPORT=str(u.port or 5432),
               PGUSER=urllib.parse.unquote(u.username or ""),
               PGPASSWORD=urllib.parse.unquote(u.password or ""),
               PGDATABASE=(u.path or "/").lstrip("/"), PGSSLMODE="disable", PGAPPNAME=app)
    return env


def run_psql(exe: str, url: str, app: str, script: str, work: Path, name: str,
             timeout: float = 90) -> str:
    sql = work / f"{name}.sql"
    out = work / f"{name}.out"
    sql.write_text(script, encoding="utf-8")
    with open(out, "w", encoding="utf-8") as fh:
        p = subprocess.run([exe, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", str(sql)],
                           stdout=fh, stderr=subprocess.STDOUT, env=pg_env(url, app),
                           timeout=timeout, stdin=subprocess.DEVNULL)
    text = out.read_text(encoding="utf-8")
    if p.returncode:
        raise RuntimeError(f"{name}: psql failed ({p.returncode}): {text[-800:]}")
    return text


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--psql", required=True)
    ap.add_argument("--url-env", required=True)
    ap.add_argument("--work", required=True, help="a directory for the child scripts and outputs")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    url = os.environ.get(args.url_env) or ""
    if not url:
        raise SystemExit(f"environment variable {args.url_env} is empty")
    work = Path(tempfile.mkdtemp(prefix="xact-flush-", dir=args.work))
    schema = f"p03_ws7_flush_{uuid.uuid4().hex[:10]}"
    rel = f"{schema}.probe_t"
    stat = (f"SELECT '@@' || coalesce((SELECT seq_scan + coalesce(idx_scan, 0) FROM "
            f"pg_stat_xact_user_tables WHERE relid = '{rel}'::regclass), 0);")
    wait = "\\! ping -n 4 127.0.0.1 > NUL\n"      # ~3 s client-side: the backend is idle in transaction
    report: dict = {"schema": "orgtree.p03-xact-flush-probe/v1",
                    "probe_commit": subprocess.check_output(
                        ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()}
    try:
        run_psql(args.psql, url, "p03-ws7-flush-setup",
                 f"CREATE SCHEMA {schema}; CREATE TABLE {rel} (id int); "
                 f"INSERT INTO {rel} SELECT generate_series(1, 50);", work, "setup")
        time.sleep(1.5)   # let the setup session's own counts flush before the measurement
        session_a = (f"SELECT count(*) FROM {rel};\n"          # 1: autocommit, leaves a pending count
                     f"BEGIN;\n{stat}\n"                         # 2: baseline
                     f"SELECT count(*) FROM {rel};\n{wait}"      # 3: +1, idle in transaction
                     f"SELECT count(*) FROM {rel};\n{wait}"      #    +1, idle in transaction
                     f"{stat}\nCOMMIT;\n")                       #    after
        session_b = "".join("SELECT count(*) FROM pg_class; SELECT pg_sleep(0.1);\n" for _ in range(90))
        b_out = open(work / "b.out", "w", encoding="utf-8")
        (work / "b.sql").write_text(session_b, encoding="utf-8")
        b = subprocess.Popen([args.psql, "-X", "-q", "-A", "-t", "-f", str(work / "b.sql")],
                             stdout=b_out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             env=pg_env(url, "p03-ws7-flush-b"))
        try:
            time.sleep(0.5)
            t0 = time.monotonic()
            a = run_psql(args.psql, url, "p03-ws7-flush-a", session_a, work, "a")
            held = time.monotonic() - t0
            b_active = b.poll() is None
        finally:
            try:
                b.wait(timeout=30)
            except subprocess.TimeoutExpired:
                b.kill()
            b_out.close()
        vals = [int(ln[2:]) for ln in a.splitlines() if ln.startswith("@@")]
        if len(vals) != 2:
            raise RuntimeError(f"expected two stats reads, got {vals}: {a[-400:]}")
        baseline, after = vals
        report.update({
            "baseline": baseline, "after": after, "difference": after - baseline,
            "expected_difference": 2, "session_a_seconds": round(held, 2),
            "session_b_active_throughout": b_active,
            "findings": {
                "difference is exact (== 2) across ~6 s idle in transaction":
                    str(after - baseline == 2),
                "the autocommit statement's count was still pending at the baseline":
                    str(baseline >= 1),
                "the transaction was held beyond the 1 s flush interval": str(held > 2.0),
                "another backend was active throughout": str(b_active),
            }})
    finally:
        try:
            run_psql(args.psql, url, "p03-ws7-flush-cleanup", f"DROP SCHEMA IF EXISTS {schema} CASCADE;",
                     work, "cleanup")
            report["cleanup"] = "dropped"
        except Exception as exc:  # noqa: BLE001 - reported, never hidden
            report["cleanup"] = f"FAILED: {exc}"
        Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report.get("findings", report), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
