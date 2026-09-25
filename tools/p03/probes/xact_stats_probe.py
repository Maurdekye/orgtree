"""P03 WS7: what can the server itself tell us about one transaction's contacts?

M1-INTERFACE-CONTRACT §3 adopted ``trace.xact_stats`` (``pg_stat_xact_user_tables``
read just before COMMIT) PROVISIONALLY, until WS7 shows on a WS1 dev cluster that
it catches reads, row locks and writes per transaction. p03-lead also asked
whether LOCK MODES are observable at all. This probe measures, for each case, in
ONE transaction, just before COMMIT:

- ``pg_stat_xact_user_tables`` for the case's tables (scans, tuples changed);
- the backend's own relation-level locks from ``pg_locks`` (pid = pg_backend_pid());
- the row-level lock modes ``pgrowlocks`` reports for the case's rows, when that
  extension can be created (it is optional; its absence is reported, not hidden).

Cases: a plain read; SELECT ... FOR KEY SHARE / FOR SHARE / FOR NO KEY UPDATE /
FOR UPDATE; an UPDATE whose trigger inserts an audit row (a server-side write the
statement text does not name); an INSERT whose foreign key makes the server read
and lock the parent row (RI check); a read that matches no row; and a
negative control: a transaction that touches NOTHING must show no table activity.

Everything lives in a fresh schema ``p03_ws7_probe_<nonce>`` that the probe
drops at the end. It refuses a non-loopback URL. It never reads or writes
anything else. Run it under the P03 run lock (it is a PostgreSQL-backed test):

    p03-run.ps1 -Agent <you> -Candidate <sha> -Run "python -I -B tools/p03/probes/xact_stats_probe.py --psql <psql.exe> --url-env P03_PG_ADMIN_URL --out <json>"

The JSON it writes records the probe's commit, the psql and server versions, and
per case what each source observed. It interprets nothing into a pass: the
``findings`` section lists, per question, what was and was not observable.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[3]
TABLES = ("plain", "audit", "parent", "child")
ROW_LOCKS = {"for_key_share": "FOR KEY SHARE", "for_share": "FOR SHARE",
             "for_no_key_update": "FOR NO KEY UPDATE", "for_update": "FOR UPDATE"}


def setup_sql(schema: str) -> str:
    return f"""
CREATE SCHEMA {schema};
SET search_path = {schema};
CREATE TABLE plain (id int PRIMARY KEY, v int NOT NULL);
CREATE TABLE audit (id bigserial PRIMARY KEY, note text NOT NULL);
CREATE TABLE parent (id int PRIMARY KEY);
CREATE TABLE child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES parent(id));
CREATE FUNCTION audit_plain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO audit(note) VALUES ('plain ' || NEW.id); RETURN NEW; END $$;
CREATE TRIGGER plain_audit AFTER UPDATE ON plain FOR EACH ROW EXECUTE FUNCTION audit_plain();
INSERT INTO plain SELECT g, 0 FROM generate_series(1, 200) g;
INSERT INTO parent SELECT g FROM generate_series(1, 200) g;
ANALYZE plain; ANALYZE parent; ANALYZE child; ANALYZE audit;
"""


def cases(schema: str) -> dict[str, str]:
    out = {"read": "SELECT v FROM plain WHERE id = 7;",
           "read_no_match": "SELECT v FROM plain WHERE id = -1;",
           "update_with_trigger": "UPDATE plain SET v = v + 1 WHERE id = 7;",
           "fk_insert": "INSERT INTO child(id, parent_id) VALUES (nextval('child_ids'), 7);",
           "nothing": "SELECT 1;"}
    for name, clause in ROW_LOCKS.items():
        out[name] = f"SELECT v FROM plain WHERE id = 7 {clause};"
    return out


def observe_sql(schema: str, body: str, rowlocks: bool) -> str:
    tables = ", ".join(f"'{t}'" for t in TABLES)
    rl = (f"(SELECT coalesce(json_agg(json_build_object('modes', r.modes)), '[]'::json) "
          f"FROM {schema}.pgrowlocks('{schema}.plain') r)" if rowlocks else "'null'::json")
    return f"""
SET search_path = {schema};
BEGIN;
{body}
SELECT '@@' || json_build_object(
  'xact_stats', (SELECT coalesce(json_agg(json_build_object(
      'relname', relname, 'seq_scan', seq_scan, 'idx_scan', coalesce(idx_scan, 0),
      'n_tup_ins', n_tup_ins, 'n_tup_upd', n_tup_upd, 'n_tup_del', n_tup_del,
      'n_tup_hot_upd', n_tup_hot_upd) ORDER BY relname), '[]'::json)
      FROM pg_stat_xact_user_tables WHERE schemaname = '{schema}' AND relname IN ({tables})),
  'locks', (SELECT coalesce(json_agg(json_build_object('relation', c.relname, 'mode', l.mode)
      ORDER BY c.relname, l.mode), '[]'::json)
      FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND n.nspname = '{schema}'),
  'rowlocks', {rl})::text;
COMMIT;
"""


def pg_env(url: str) -> dict[str, str]:
    """The URL's parts as libpq environment variables: the password never appears
    on a command line (the run-lock wrapper logs command lines to runs.jsonl)."""
    u = urllib.parse.urlparse(url)
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update(PGHOST=u.hostname or "", PGPORT=str(u.port or 5432),
               PGUSER=urllib.parse.unquote(u.username or ""),
               PGPASSWORD=urllib.parse.unquote(u.password or ""),
               PGDATABASE=(u.path or "/").lstrip("/"), PGSSLMODE="disable",
               PGAPPNAME="p03-ws7-xact-stats-probe")
    return env


def psql(exe: str, url: str, sql: str) -> list[str]:
    p = subprocess.run([exe, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
                       input=sql, capture_output=True, text=True, encoding="utf-8", timeout=60,
                       env=pg_env(url))
    if p.returncode:
        raise RuntimeError(f"psql failed ({p.returncode}): {p.stderr.strip()[-800:]}")
    return p.stdout.splitlines()


def loopback_only(url: str) -> None:
    host = urllib.parse.urlparse(url).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(f"refusing a non-loopback PostgreSQL URL (host {host!r})")


def findings(results: dict[str, dict]) -> dict[str, str]:
    def stats(case):
        return {t["relname"]: t for t in results[case]["xact_stats"]}

    def read_seen(case, rel):
        t = stats(case).get(rel, {})
        return bool(t.get("seq_scan") or t.get("idx_scan"))

    def write_seen(case, rel):
        t = stats(case).get(rel, {})
        return bool(t.get("n_tup_ins") or t.get("n_tup_upd") or t.get("n_tup_del"))

    def lockmodes(case, rel):
        return sorted({lk["mode"] for lk in results[case]["locks"] if lk["relation"] == rel})

    rows = {case: results[case]["rowlocks"] for case in ROW_LOCKS}
    return {
        "plain read shows as a read": str(read_seen("read", "plain")),
        "read matching no row still shows as a read": str(read_seen("read_no_match", "plain")),
        "row-lock SELECTs show as reads": str({c: read_seen(c, "plain") for c in ROW_LOCKS}),
        "row-lock SELECTs: relation lock modes": str({c: lockmodes(c, "plain") for c in ROW_LOCKS}),
        "row-lock SELECTs: pgrowlocks modes": str(rows),
        "update shows as a write": str(write_seen("update_with_trigger", "plain")),
        "trigger's audit insert shows as a write": str(write_seen("update_with_trigger", "audit")),
        "fk insert: child written": str(write_seen("fk_insert", "child")),
        "fk insert: parent read by the RI check": str(read_seen("fk_insert", "parent")),
        "fk insert: parent relation lock": str(lockmodes("fk_insert", "parent")),
        # pg_stat_xact_user_tables lists EVERY user table, activity or not: "no
        # activity" means every counter is zero, not that the view is empty
        "negative control: an empty transaction shows no table activity": str(
            not any(read_seen("nothing", t["relname"]) or write_seen("nothing", t["relname"])
                    for t in results["nothing"]["xact_stats"])
            and not results["nothing"]["locks"]),
        "the view lists tables with zero activity too": str(bool(results["nothing"]["xact_stats"])),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--psql", required=True)
    ap.add_argument("--url-env", required=True,
                    help="NAME of the environment variable holding the URL (never the URL itself)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    args.url = os.environ.get(args.url_env) or ""
    if not args.url:
        raise SystemExit(f"environment variable {args.url_env} is empty")
    loopback_only(args.url)
    schema = f"p03_ws7_probe_{uuid.uuid4().hex[:10]}"
    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    dirty = bool(subprocess.check_output(["git", "-C", str(ROOT), "status", "--porcelain"],
                                         text=True).strip())
    report: dict = {"schema": "orgtree.p03-xact-stats-probe/v1", "probe_commit": commit,
                    "probe_dirty": dirty,
                    "psql": subprocess.check_output([args.psql, "--version"], text=True).strip(),
                    "cases": {}}
    try:
        report["server_version"] = psql(args.psql, args.url, "SHOW server_version;")[0]
        psql(args.psql, args.url, setup_sql(schema)
             + f"CREATE SEQUENCE {schema}.child_ids;")
        try:
            # inside the probe's own schema, so DROP SCHEMA ... CASCADE removes it; if
            # it already exists elsewhere (or is not shipped) this fails and is reported
            psql(args.psql, args.url, f"CREATE EXTENSION pgrowlocks SCHEMA {schema};")
            rowlocks = True
        except RuntimeError as exc:
            rowlocks = False
            report["pgrowlocks_unavailable"] = str(exc)[-300:]
        for name, body in cases(schema).items():
            lines = psql(args.psql, args.url, observe_sql(schema, body, rowlocks))
            payload = [ln for ln in lines if ln.startswith("@@")]
            if len(payload) != 1:
                raise RuntimeError(f"case {name}: expected one observation line, got {lines}")
            report["cases"][name] = {"sql": body, **json.loads(payload[0][2:])}
        report["findings"] = findings(report["cases"])
    finally:
        try:
            psql(args.psql, args.url, f"DROP SCHEMA IF EXISTS {schema} CASCADE;")
            report["cleanup"] = "dropped"
        except RuntimeError as exc:
            report["cleanup"] = f"FAILED: {exc}"
        Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report.get("findings", {}), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
