"""P03 WS7: what does the server statement log (jsonlog) actually contain?

p03-lead's ruling (decision 3 on p03-ws7-contact-tracing-and-the-qualification-ha)
makes the qualification cluster's jsonlog the ground truth for Q-C5 hidden access,
and requires this to be VERIFIED before ``serverlog.reconcile`` relies on "one log
line per traced statement". This probe runs, on a WS1 dev cluster started with
``--qual-logging on``:

- session A (one psql connection): a simple-protocol statement; an
  extended-protocol statement with an unnamed prepared statement (``\\bind``);
  a NAMED prepared statement (``\\parse``) executed twice (``\\bind_named``), as a
  driver reusing a prepared statement would; a bind value that must NOT reach the
  log (a distinctive number); transaction control;
- session B (a second, separate psql connection): one statement, standing in for
  an untraced connection.

It then reads the cluster's jsonlog files for its own sessions (by
``application_name``) and reports, per session, every statement-severity line
exactly as logged; whether ``serverlog.statement_text`` parses each; whether a
reused named statement logs one line per execution; whether the distinctive bind
value appears anywhere; and the session ids. It interprets nothing into a pass:
``findings`` states what was seen.

Run under the P03 run lock with the URL in an environment variable (never on the
command line):

    p03-run.ps1 -Agent <you> -Candidate <sha> -Run "python -I -B tools/p03/probes/serverlog_probe.py --psql <psql.exe> --url-env P03_PG_ADMIN_URL --log-dir <qual-logs dir> --out <json>"
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from p03.harness import serverlog  # noqa: E402

SECRET = "918273645501"   # a bind value that must never reach the log


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


def psql(exe: str, url: str, app: str, script: str) -> list[str]:
    p = subprocess.run([exe, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], input=script,
                       capture_output=True, text=True, encoding="utf-8", timeout=60,
                       env=pg_env(url, app))
    if p.returncode:
        raise RuntimeError(f"psql failed ({p.returncode}): {p.stderr.strip()[-800:]}")
    return p.stdout.splitlines()


SESSION_A = f"""
SELECT 'simple-protocol' AS probe;
SELECT 'extended-unnamed', $1::bigint \\bind {SECRET} \\g
SELECT 'extended-named', $1::bigint AS v \\parse p03_named
\\bind_named p03_named {SECRET} \\g
\\bind_named p03_named {SECRET} \\g
BEGIN;
SELECT 'inside-a-transaction';
COMMIT;
SELECT pg_backend_pid(), to_hex(floor(extract(epoch FROM backend_start))::bigint) || '.' || to_hex(pg_backend_pid())
  FROM pg_stat_activity WHERE pid = pg_backend_pid();
"""
SESSION_B = "SELECT 'untraced-second-session';\n"


def read_logs(log_dir: Path, apps: set[str], since: float) -> list[dict]:
    out = []
    for f in sorted(log_dir.glob("*.json")):
        if f.stat().st_mtime < since - 5:
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("application_name") in apps:
                out.append(e)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--psql", required=True)
    ap.add_argument("--url-env", required=True)
    ap.add_argument("--log-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    url = os.environ.get(args.url_env) or ""
    if not url:
        raise SystemExit(f"environment variable {args.url_env} is empty")
    nonce = uuid.uuid4().hex[:8]
    app_a, app_b = f"p03-ws7-logprobe-a-{nonce}", f"p03-ws7-logprobe-b-{nonce}"
    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    started = time.time()
    out_a = psql(args.psql, url, app_a, SESSION_A)
    psql(args.psql, url, app_b, SESSION_B)
    time.sleep(1.5)   # let the logging collector write
    entries = read_logs(Path(args.log_dir), {app_a, app_b}, started)
    lines = [{"app": e.get("application_name"), "session_id": e.get("session_id"),
              "pid": e.get("pid"), "severity": e.get("error_severity"),
              "message": e.get("message"), "detail": e.get("detail"),
              "parsed_sql": serverlog.statement_text(e),
              "session_key": serverlog.session_key(str(e.get("session_id")))}
             for e in entries]
    a_lines = [ln for ln in lines if ln["app"] == app_a]
    named = [ln for ln in a_lines if ln["message"] and "extended-named" in ln["message"]]
    raw = json.dumps(entries)
    pid_line = out_a[-1:]    # the last query: pid|session id
    report = {
        "schema": "orgtree.p03-serverlog-probe/v1", "probe_commit": commit,
        "session_a_psql_pid_and_session_id": pid_line,
        "log_entries": len(entries), "lines": lines,
        "findings": {
            "every statement line parses": str(all(
                ln["parsed_sql"] is not None for ln in lines
                if str(ln["message"] or "").startswith(("statement", "execute")))),
            "message prefixes seen": str(sorted({str(ln["message"] or "").split(":")[0]
                                                 for ln in lines})),
            "named prepared statement: log lines for two executions": str(len(named)),
            "bind value reached the log": str(SECRET in raw),
            "session B logged under its own session_id": str(
                len({ln["session_id"] for ln in lines if ln["app"] == app_b}) == 1
                and not ({ln["session_id"] for ln in lines if ln["app"] == app_b}
                         & {ln["session_id"] for ln in a_lines})),
            "session_id matches pg_stat_activity backend_start/pid for session A": str(
                bool(pid_line) and pid_line[0].split("|")[1] in {ln["session_id"] for ln in a_lines}),
        },
    }
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["findings"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
