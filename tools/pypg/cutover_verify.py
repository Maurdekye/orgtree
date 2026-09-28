"""Independent check of an Orgtree SQLite -> PostgreSQL cutover. READS ONLY.

Written for an outside agent that did NOT run the transfer. It compares the
backup taken before the transfer with the data folder after it, and it does
not use pgimport or Orgtree's own code to do so: only the Python standard
library, psycopg and the pg-custodian executable (to start and stop the
private PostgreSQL). See docs/state-system/pypg-cutover-verification.md.

    python cutover_verify.py --backup <backup data folder> --data <data folder>
        --custodian <pg-custodian.exe> --out <report.json> [--samples 3]

Two parts:

1. Files. Every file in the backup must be in the data folder with the same
   SHA-256, except the org files in ``orgs/``, which must be in
   ``pre-postgres/orgs/`` unchanged. The only files allowed to be new are the
   ones the cutover writes (``orgs/<slug>.pg``, ``store-backend.json``,
   ``orgtree-product-root.json``, and the folders ``pg/``, ``conversion/``
   and ``host-logs/``). This covers everything the
   transfer does not move: transcripts, attachments (uploads, outbox), trash.
2. Database. Every org in the backup's ``orgs/*.db`` must be in PostgreSQL
   with exactly the same rows in its five tables (doc, nodes, log_d, log_l,
   meta). The one intended change is the work-item list: SQLite keeps it as
   one ``work_items`` JSON list; PostgreSQL keeps a header naming the item
   order plus one row per item. The script rebuilds the list from those rows
   and requires it to equal the SQLite list, item for item and in order.

``--after-launch`` is for a data folder that Orgtree has already run on
after the switch, where new writes are expected. Then nothing from the backup
may be missing (every agent, every log row unchanged, every work item still
open or archived, every attachment and moved org file), but additions and
changes to live documents are listed as ``changed_since_backup`` instead of
failing. Without it, the comparison is exact.

Exit 0 = PASS, 1 = FAIL (differences listed), 2 = could not run the check.
The private PostgreSQL is started only if it is stopped, and stopped again
afterwards. Every database session is read-only.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator

TABLES = {
    "doc": ("key", "val"),
    "nodes": ("id", "ord", "val"),
    "log_d": ("seq", "sect", "owner", "at", "val"),
    "log_l": ("seq", "sect", "at", "val"),
    "meta": ("key", "val"),
}
ORDER = {"doc": "key", "nodes": "id", "log_d": "seq", "log_l": "seq", "meta": "key"}
WORK = "work_items"
WORK_ROW = WORK + "\x1f"
WORK_FORMAT = "orgtree.work-items/v1"
ORG_SUFFIXES = (".db", ".db-wal", ".db-shm", ".json")
#: Files the cutover itself writes at the top of the data folder.
NEW_TOP_FILES = {"store-backend.json", "orgtree-product-root.json"}
#: Folders the cutover and the engine's database start write their logs to:
#: ``pg/`` (the database itself), ``conversion/`` (the first-launch
#: conversion's reports and status) and ``host-logs/`` (the database start).
NEW_TOP_DIRS = {"pg", "conversion", "host-logs"}
#: The data folder's lock file: opened (and possibly created) by every engine
#: and by pgimport to lock one byte. Its content is not data.
LOCK_FILE = ".owner"


class CannotRun(RuntimeError):
    """The check itself could not run (exit 2). Not a verdict."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(root: Path) -> dict[str, Path]:
    """Every file under root, keyed by its path relative to root ('/')."""
    out: dict[str, Path] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in filenames:
            p = Path(dirpath) / name
            out[p.relative_to(root).as_posix()] = p
    return out


# ---------------------------------------------------------------- part 1: files

def is_attachment(rel: str) -> bool:
    low = "/" + rel.lower()
    return "/uploads/" in low or "/outbox/" in low


def compare_files(backup: Path, data: Path, after_launch: bool = False) -> dict[str, Any]:
    before, after = walk(backup), walk(data)
    problems: list[str] = []
    changed: list[str] = []
    checked = 0
    org_files: list[str] = []
    categories = {"transcripts": 0, "attachments": 0, "trash": 0, "other": 0}
    for rel, src in sorted(before.items()):
        if rel == LOCK_FILE:
            continue
        top, _, rest = rel.partition("/")
        if top == "orgs" and "/" not in rest:
            org_files.append(rest)
            if rel in after and not rel.endswith(".pg"):
                problems.append(f"{rel}: still in orgs/ (the cutover should have moved it to pre-postgres/orgs/)")
            target_rel = "pre-postgres/orgs/" + rest
        else:
            target_rel = rel
        # after a launch, only the moved org files and attachments must be untouched
        strict = not after_launch or target_rel != rel or is_attachment(rel)
        dst = after.get(target_rel)
        if dst is None:
            (problems if strict else changed).append(f"{rel}: missing from the data folder (expected at {target_rel})")
            continue
        if src.stat().st_size != dst.stat().st_size or sha256_file(src) != sha256_file(dst):
            (problems if strict else changed).append(f"{rel}: content differs from the backup (at {target_rel})")
        checked += 1
        low = rel.lower()
        if "transcript" in low or top == "turnlog":
            categories["transcripts"] += 1
        elif is_attachment(rel):
            categories["attachments"] += 1
        elif top == "deleted":
            categories["trash"] += 1
        elif top != "orgs":
            categories["other"] += 1
    expected_targets = {("pre-postgres/orgs/" + n) for n in org_files}
    unexpected: list[str] = []
    markers: list[str] = []
    for rel in sorted(after):
        if rel in before or rel in expected_targets or rel == LOCK_FILE:
            continue
        top, _, rest = rel.partition("/")
        if rel in NEW_TOP_FILES or (top in NEW_TOP_DIRS and rest):
            continue
        if top == "orgs" and "/" not in rest and rest.endswith(".pg"):
            markers.append(rest[:-3])
            continue
        unexpected.append(rel)
    new = [f"{rel}: new file that the cutover does not write" for rel in unexpected]
    (changed if after_launch else problems).extend(new)
    return {"backup_files": len(before), "data_files": len(after), "compared": checked,
            "org_files_moved": sorted(org_files), "markers": sorted(markers),
            "compared_by_kind": categories, "changed_since_backup_count": len(changed),
            "changed_since_backup": changed[:200], "problems": problems}


# ---------------------------------------------------------------- part 2: database

@contextlib.contextmanager
def sqlite_rows(path: Path) -> Iterator[sqlite3.Connection]:
    """A read-only view of one backup org database. With no -wal/-shm beside
    it the file is complete and is opened immutable (nothing is created next
    to it); otherwise it is copied first with SQLite's online backup."""
    at_rest = not any(Path(str(path) + s).exists() for s in ("-wal", "-shm"))
    if at_rest:
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            yield conn
        finally:
            conn.close()
        return
    folder = Path(tempfile.mkdtemp(prefix="orgtree-verify-"))
    try:
        src = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(folder / "copy.db")
        try:
            src.backup(dst)
        finally:
            src.close()
        try:
            yield dst
        finally:
            dst.close()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def read_sqlite(conn: sqlite3.Connection) -> dict[str, list[tuple[Any, ...]]]:
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    out: dict[str, list[tuple[Any, ...]]] = {}
    for table, cols in TABLES.items():
        out[table] = [] if table not in names else [tuple(r) for r in conn.execute(
            f"SELECT {', '.join(cols)} FROM {table} ORDER BY {ORDER[table]}")]
    return out


def read_pg(cur: Any, schema: str) -> dict[str, list[tuple[Any, ...]]]:
    out: dict[str, list[tuple[Any, ...]]] = {}
    for table, cols in TABLES.items():
        # ORDER BY with the "C" collation: the byte order SQLite uses for text keys
        order = ORDER[table] + (' COLLATE "C"' if ORDER[table] in ("key", "id") else "")
        cur.execute(f'SELECT {", ".join(cols)} FROM "{schema}".{table} ORDER BY {order}')
        out[table] = [tuple(r) for r in cur.fetchall()]
    return out


def work_list_sqlite(doc: dict[str, str]) -> tuple[list[Any] | None, list[str]]:
    """(the work-item list, problems) from a SQLite doc table."""
    rows = {k: v for k, v in doc.items() if k == WORK or k.startswith(WORK_ROW)}
    if not rows:
        return None, []
    if set(rows) != {WORK}:
        # an engine that already wrote per-item rows to SQLite: rebuild the same way
        return work_list_pg(doc)
    value = json.loads(rows[WORK])
    if not isinstance(value, list):
        return None, ["SQLite work_items is not a list"]
    return value, []


def work_list_pg(doc: dict[str, str]) -> tuple[list[Any] | None, list[str]]:
    """(the work-item list, problems) rebuilt from the header + one row per item."""
    rows = {k: v for k, v in doc.items() if k == WORK or k.startswith(WORK_ROW)}
    if not rows:
        return None, []
    if WORK not in rows:
        return None, ["work-item rows without a work_items header"]
    header = json.loads(rows[WORK])
    if not isinstance(header, dict) or header.get("format") != WORK_FORMAT or not isinstance(header.get("ids"), list):
        return None, [f"work_items header is not the {WORK_FORMAT} layout"]
    ids = header["ids"]
    problems: list[str] = []
    if len(set(ids)) != len(ids):
        problems.append("work_items header names a slug twice")
    extra = sorted(set(rows) - {WORK} - {WORK_ROW + s for s in ids})
    problems += [f"work-item row {k[len(WORK_ROW):]!r} is not named in the header" for k in extra]
    items: list[Any] = []
    for slug in ids:
        text = rows.get(WORK_ROW + slug)
        if text is None:
            problems.append(f"work item {slug!r} is in the header but has no row")
            continue
        item = json.loads(text)
        if not isinstance(item, dict) or item.get("slug") != slug:
            problems.append(f"work item row {slug!r} holds a different slug")
        items.append(item)
    return items, problems


def canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def table_digest(rows: list[tuple[Any, ...]]) -> str:
    h = hashlib.sha256()
    for row in rows:
        h.update(canon(list(row)).encode("utf-8") + b"\n")
    return h.hexdigest()


def summarize(rows: dict[str, list[tuple[Any, ...]]], work: list[Any] | None) -> dict[str, Any]:
    doc = {k: v for k, v in rows["doc"]}

    def doc_len(key: str) -> int | None:
        if key not in doc:
            return None
        with contextlib.suppress(ValueError):
            v = json.loads(doc[key])
            return len(v) if isinstance(v, (list, dict)) else None
        return None

    def sect_count(table: str, sect: str) -> int:
        return sum(1 for r in rows[table] if r[1] == sect)

    archived = sect_count("log_l", "work_items_archive") + (doc_len("work_items_archive") or 0)
    return {
        "agents": len(rows["nodes"]),
        "open_work_items": len(work) if work is not None else 0,
        "archived_work_items": archived,
        "mail_log": sect_count("log_d", "mail_log"),
        "user_mail_log": sect_count("log_l", "user_mail_log"),
        "mail_queued": doc_len("mail"),
        "turn_log": sect_count("log_d", "turn_log"),
        "rows": {t: len(v) for t, v in rows.items()},
    }


def samples(rows: dict[str, list[tuple[Any, ...]]], work: list[Any] | None, n: int) -> dict[str, Any]:
    """A few named records, picked by position (first, middle, last) so both
    sides pick the same ones and a rerun picks them again."""
    def pick(seq: list[Any]) -> list[Any]:
        if len(seq) <= n:
            return list(seq)
        step = (len(seq) - 1) / max(n - 1, 1)
        return [seq[round(i * step)] for i in range(n)]

    def brief(text: str, keys: tuple[str, ...]) -> dict[str, Any]:
        with contextlib.suppress(ValueError):
            v = json.loads(text)
            if isinstance(v, dict):
                return {k: v.get(k) for k in keys if k in v}
        return {"val_start": text[:80]}

    agents = [{"id": r[0], **brief(r[2], ("name", "tier", "model", "parent"))} for r in pick(rows["nodes"])]
    items = [{k: it.get(k) for k in ("slug", "title", "status", "owner") if isinstance(it, dict)}
             for it in pick(work or [])]
    mail = [{"seq": r[0], "owner": r[2], "at": r[3], **brief(r[4], ("from", "to", "kind", "subject"))}
            for r in [r for r in rows["log_d"] if r[1] == "mail_log"][-n:]]
    return {"agents": agents, "work_items": items, "recent_mail": mail}


def archived_slugs(rows: dict[str, list[tuple[Any, ...]]]) -> set[str]:
    out: set[str] = set()
    for r in rows["log_l"]:
        if r[1] == "work_items_archive":
            with contextlib.suppress(ValueError):
                v = json.loads(r[3])
                if isinstance(v, dict) and isinstance(v.get("slug"), str):
                    out.add(v["slug"])
    return out


def still_present(src: dict[str, list[tuple[Any, ...]]], dst: dict[str, list[tuple[Any, ...]]],
                  src_work: list[Any] | None, dst_work: list[Any] | None) -> tuple[list[str], list[str]]:
    """--after-launch: (problems, changes). Nothing from the backup may be
    missing; live documents may have changed."""
    problems: list[str] = []
    changes: list[str] = []
    dst_nodes = {r[0]: r for r in dst["nodes"]}
    gone = [r[0] for r in src["nodes"] if r[0] not in dst_nodes]
    if gone:
        problems.append(f"{len(gone)} agent(s) from the backup are missing: {gone[:5]}")
    moved = sum(1 for r in src["nodes"] if r[0] in dst_nodes and dst_nodes[r[0]] != r)
    if moved:
        changes.append(f"{moved} agent record(s) changed since the backup")
    for table in ("log_d", "log_l"):
        have = {r[0]: r for r in dst[table]}
        lost = [r[0] for r in src[table] if have.get(r[0]) != r]
        if lost:
            problems.append(f"table {table}: {len(lost)} history row(s) from the backup are missing or "
                            f"changed; first seq: {lost[:5]}")
        added = len(dst[table]) - (len(src[table]) - len(lost))
        if added:
            changes.append(f"table {table}: {added} row(s) added since the backup")
    open_now = {it.get("slug") for it in dst_work or [] if isinstance(it, dict)}
    archived = archived_slugs(dst)
    lost_items = [it.get("slug") for it in src_work or [] if isinstance(it, dict)
                  and it.get("slug") not in open_now and it.get("slug") not in archived]
    if lost_items:
        problems.append(f"{len(lost_items)} work item(s) from the backup are neither open nor archived: "
                        f"{lost_items[:5]}")
    for table in ("doc", "meta"):
        a = {r[0]: r for r in src[table] if r[0] != WORK and not r[0].startswith(WORK_ROW)}
        b = {r[0]: r for r in dst[table] if r[0] != WORK and not r[0].startswith(WORK_ROW)}
        diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        if diff:
            changes.append(f"table {table}: {len(diff)} key(s) differ from the backup: {diff[:10]}")
    return problems, changes


def compare_org(slug: str, src: dict[str, list[tuple[Any, ...]]], dst: dict[str, list[tuple[Any, ...]]],
                n: int, after_launch: bool = False) -> dict[str, Any]:
    problems: list[str] = []
    src_doc, dst_doc = dict(src["doc"]), dict(dst["doc"])
    src_work, p1 = work_list_sqlite(src_doc)
    dst_work, p2 = work_list_pg(dst_doc)
    problems += [f"SQLite: {p}" for p in p1] + [f"PostgreSQL: {p}" for p in p2]
    if after_launch:
        lost, changes = still_present(src, dst, src_work, dst_work)
        return {"slug": slug, "mode": "after-launch",
                "counts": {"sqlite": summarize(src, src_work), "postgres": summarize(dst, dst_work)},
                "samples": {"sqlite": samples(src, src_work, n), "postgres": samples(dst, dst_work, n)},
                "changed_since_backup": changes, "problems": problems + lost}
    if (src_work is None) != (dst_work is None):
        problems.append("work items exist on one side only")
    elif src_work is not None and canon(src_work) != canon(dst_work):
        problems.append(f"work-item lists differ ({len(src_work)} in SQLite, {len(dst_work or [])} in PostgreSQL, "
                        "or the same count with different content or order)")
    digests: dict[str, Any] = {}
    for table in TABLES:
        a, b = src[table], dst[table]
        if table == "doc":
            # the work-item rows are compared above, as one logical list
            a = [r for r in a if r[0] != WORK and not r[0].startswith(WORK_ROW)]
            b = [r for r in b if r[0] != WORK and not r[0].startswith(WORK_ROW)]
            a.append((WORK, canon(src_work)))
            b.append((WORK, canon(dst_work)))
            a.sort(key=lambda r: r[0].encode("utf-8"))
            b.sort(key=lambda r: r[0].encode("utf-8"))
        da, db = table_digest(a), table_digest(b)
        digests[table] = {"sqlite": da, "postgres": db, "rows_sqlite": len(a), "rows_postgres": len(b)}
        if da != db:
            ka = {r[0]: r for r in a}
            kb = {r[0]: r for r in b}
            only_a = [k for k in ka if k not in kb]
            only_b = [k for k in kb if k not in ka]
            changed = [k for k in ka if k in kb and ka[k] != kb[k]]
            problems.append(f"table {table}: {len(only_a)} row(s) only in SQLite, {len(only_b)} only in "
                            f"PostgreSQL, {len(changed)} changed; first keys: "
                            f"{[repr(k) for k in (only_a + only_b + changed)[:5]]}")
    return {"slug": slug, "mode": "exact",
            "counts": {"sqlite": summarize(src, src_work), "postgres": summarize(dst, dst_work)},
            "sha256": digests, "samples": {"sqlite": samples(src, src_work, n), "postgres": samples(dst, dst_work, n)},
            "problems": problems}


# ---------------------------------------------------------------- the private PostgreSQL

def custodian(exe: Path, args: list[str], workdir: Path, timeout: float = 180) -> dict[str, Any]:
    """Run pg-custodian with its output going to FILES (a started PostgreSQL
    inherits the handles, so a pipe would never close) and return its JSON."""
    out_path, err_path = workdir / f"{args[0]}.out", workdir / f"{args[0]}.err"
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        proc = subprocess.run([str(exe), *args], stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                              timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        value = json.loads(out_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {"ok": False, "code": "no-json", "message": err_path.read_text(encoding="utf-8", errors="replace")[:2000]}
    value["_exit"] = proc.returncode
    return value


@contextlib.contextmanager
def database(exe: Path, data: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    workdir = Path(tempfile.mkdtemp(prefix="orgtree-verify-custodian-"))
    r = ["--root", str(data), "--product"]
    started = False
    try:
        status = custodian(exe, ["status", *r], workdir)
        if not status.get("ok"):
            raise CannotRun(f"pg-custodian status refused: {status.get('code')}: {status.get('message')}")
        state = status["cluster"]["state"]
        if state in ("stopped", "stale_pid"):
            start = custodian(exe, ["start", *r], workdir)
            if not start.get("ok"):
                raise CannotRun(f"pg-custodian start refused: {start.get('code')}: {start.get('message')}")
            started = True
        elif state != "running":
            raise CannotRun(f"the private PostgreSQL is {state!r}; nothing to verify")
        attach = custodian(exe, ["attach", *r], workdir)
        if not attach.get("ok"):
            raise CannotRun(f"pg-custodian attach refused: {attach.get('code')}: {attach.get('message')}")
        rt = attach["runtime"]
        passfile = str(rt["pgpass_file"]).replace("\\", "\\\\").replace("'", "\\'")
        conninfo = (f"host={rt['host']} port={int(rt['port'])} dbname=orgtree user={rt['admin_role']} "
                    f"passfile='{passfile}' require_auth=scram-sha-256 sslmode=disable connect_timeout=10 "
                    "application_name=orgtree-cutover-verify options='-c default_transaction_read_only=on'")
        yield conninfo, {"state_before": state, "started_by_verifier": started}
    finally:
        if started:
            stop = custodian(exe, ["stop", *r], workdir)
            if not stop.get("ok"):
                print(f"WARNING: pg-custodian stop did not report ok: {stop}", file=sys.stderr)
        shutil.rmtree(workdir, ignore_errors=True)


def compare_database(backup: Path, data: Path, exe: Path, n: int, after_launch: bool = False) -> dict[str, Any]:
    import psycopg  # noqa: PLC0415  (the installed app's own driver)

    orgs_dir = backup / "orgs"
    sources = sorted(p for p in orgs_dir.iterdir() if p.is_file() and p.suffix in (".db", ".json")) \
        if orgs_dir.is_dir() else []
    result: dict[str, Any] = {"orgs": {}, "problems": [], "not_compared": []}
    with database(exe, data) as (conninfo, how):
        result["database"] = how
        with psycopg.connect(conninfo) as conn:
            conn.read_only = True
            with conn.transaction(), conn.cursor() as cur:
                cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                cur.execute("SHOW transaction_read_only")
                if cur.fetchone()[0] != "on":
                    raise CannotRun("the database session is not read-only; refusing to continue")
                cur.execute("SELECT slug, org_id FROM public.orgs WHERE deleted_at IS NULL ORDER BY slug")
                in_pg = dict(cur.fetchall())
                slugs = []
                for path in sources:
                    slug = path.stem
                    slugs.append(slug)
                    if path.suffix == ".json":
                        result["not_compared"].append(f"{path.name}: a legacy JSON org (check it by hand)")
                        continue
                    if slug not in in_pg:
                        result["problems"].append(f"org {slug!r} is in the backup but not in PostgreSQL")
                        continue
                    with sqlite_rows(path) as sconn:
                        src = read_sqlite(sconn)
                    dst = read_pg(cur, f"org_{int(in_pg[slug])}")
                    org = compare_org(slug, src, dst, n, after_launch)
                    result["orgs"][slug] = org
                    result["problems"] += [f"org {slug!r}: {p}" for p in org["problems"]]
                result["problems"] += [f"org {s!r} is in PostgreSQL but not in the backup" for s in in_pg
                                       if s not in slugs]
                result["orgs_backup"], result["orgs_postgres"] = len(sources), len(in_pg)
    return result


# ---------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="cutover_verify", description=__doc__.split("\n\n")[0])
    ap.add_argument("--backup", required=True, type=Path, help="the data folder as backed up BEFORE the transfer")
    ap.add_argument("--data", required=True, type=Path, help="the data folder AFTER the transfer")
    ap.add_argument("--custodian", required=True, type=Path, help="the installed pg-custodian.exe")
    ap.add_argument("--out", required=True, type=Path, help="where to write the JSON report")
    ap.add_argument("--samples", type=int, default=3, help="records shown per kind per org (default 3)")
    ap.add_argument("--after-launch", action="store_true",
                    help="Orgtree has already run on the result: allow new writes, require nothing lost")
    a = ap.parse_args(argv)
    started = time.time()
    report: dict[str, Any] = {"schema": "orgtree.cutover-verify/v1", "tool_sha256": sha256_file(Path(__file__)),
                              "mode": "after-launch" if a.after_launch else "exact",
                              "backup": str(a.backup), "data": str(a.data), "custodian": str(a.custodian),
                              "python": sys.executable}
    try:
        for p, what in ((a.backup, "--backup"), (a.data, "--data")):
            if not p.is_absolute() or not p.is_dir():
                raise CannotRun(f"{what} {p} is not an existing absolute folder")
        if a.backup.resolve() == a.data.resolve():
            raise CannotRun("--backup and --data are the same folder")
        if not a.custodian.is_absolute() or not a.custodian.is_file():
            raise CannotRun(f"--custodian {a.custodian} is not an existing absolute file")
        if os.path.normcase(os.environ.get("ORGTREE_DATA", "")) != os.path.normcase(str(a.data)):
            raise CannotRun("ORGTREE_DATA must name exactly the --data folder (pg-custodian's product mode needs it)")
        if not (a.data / "store-backend.json").is_file():
            raise CannotRun("the data folder has no store-backend.json: the cutover has not happened")
        print("part 1: comparing files (this can take a while on a large data folder)...", flush=True)
        report["files"] = compare_files(a.backup, a.data, a.after_launch)
        print("part 2: comparing the database...", flush=True)
        report["database"] = compare_database(a.backup, a.data, a.custodian, a.samples, a.after_launch)
    except CannotRun as exc:
        report["verdict"], report["error"] = "CANNOT RUN", str(exc)
        a.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"VERDICT: CANNOT RUN - {exc}")
        return 2
    problems = report["files"]["problems"] + report["database"]["problems"]
    problems += [f"not compared: {x}" for x in report["database"]["not_compared"]]
    report["problems"], report["seconds"] = problems, round(time.time() - started, 1)
    report["verdict"] = "PASS" if not problems else "FAIL"
    a.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    f = report["files"]
    print(f"files: {f['backup_files']} in the backup, {len(f['org_files_moved'])} org file(s) moved, "
          f"{len(f['markers'])} marker(s); compared by kind: {f['compared_by_kind']}; "
          f"changed since the backup (allowed only with --after-launch): {f['changed_since_backup_count']}")
    for slug, org in report["database"]["orgs"].items():
        s, p = org["counts"]["sqlite"], org["counts"]["postgres"]
        keys = ("agents", "open_work_items", "archived_work_items", "mail_log", "user_mail_log", "turn_log")
        print(f"org {slug}: " + ", ".join(f"{k} {s[k]}/{p[k]}" for k in keys) + "  (backup/PostgreSQL)")
    for line in problems:
        print(f"PROBLEM: {line}")
    print(f"VERDICT: {report['verdict']} ({len(problems)} problem(s)); report: {a.out}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
