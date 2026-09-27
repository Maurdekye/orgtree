"""Restore a verified history bundle into a NEW disposable PG org.

No process is started here. The caller owns PG and supplies scrubbed fixture
environment, launch guard, memory guard and process cleanup. The same intended
workspace/home paths are reused sequentially across arms; no text is rewritten.
"""
from __future__ import annotations

import hashlib
import copy
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from history_fixture import (FAMILIES, FORMAT, PREFIX, compact, digest, read_rows,
                             regular_file, safe_relative, safe_root, sha_file, verify_pair)

TAIL_OFFSET = 1 << 40


def frozen_source_hash(base):
    """Expected stored original rows, derived only from frozen input.

    The only added fields are the two declared PG singleton defaults. Physical
    splitting and compact ASCII JSON are storage representations, not omissions
    from the active comparison. Log sequence positions are excluded but order
    within each section/owner is retained. Never call the creating writer here.
    """
    from orgtree import store
    base = dict(base)
    for key, value in store.ALWAYS_ROWS.items():
        base.setdefault(key, json.loads(value))
    encode = lambda value: json.dumps(value, separators=(",", ":"), allow_nan=False)
    docs = {}
    owners = {}
    for key, value in base.items():
        if key == "nodes":
            continue
        if key in store.DICT_LOGS and isinstance(value, dict):
            owners["owners:" + key] = encode(list(value))
            continue
        if key in store.LIST_LOGS and isinstance(value, list):
            continue
        if key == "work_items":
            docs[key] = encode({"format": "orgtree.work-items/v1", "ids": [v["slug"] for v in value]})
            docs.update((key + "\x1f" + v["slug"], encode(v)) for v in value)
        elif key in store.SPLIT_SECTIONS and isinstance(value, dict) and all(
                isinstance(v, list) for v in value.values()):
            docs[key] = "{}"
            docs.update((key + "\x1f" + owner, encode(rows)) for owner, rows in value.items())
        else:
            docs[key] = encode(value)
    meta = {"key_order": encode(list(base)), **owners}
    h = hashlib.sha256()
    counts = {}
    table_hashes = {}
    def add(table, rows):
        counts[table] = 0
        table_hash = hashlib.sha256()
        for row in rows:
            encoded = (compact([table, *row]) + "\n").encode()
            h.update(encoded)
            table_hash.update(encoded)
            counts[table] += 1
        table_hashes[table] = table_hash.hexdigest()
    add("doc", ((k, docs[k]) for k in sorted(docs)))
    node_order = {nid: i for i, nid in enumerate(base["nodes"])}
    add("nodes", ((nid, node_order[nid], encode(base["nodes"][nid])) for nid in sorted(node_order)))
    def logs(dict_log):
        sections = store.DICT_LOGS if dict_log else store.LIST_LOGS
        for section in sorted(sections):
            value = base.get(section)
            if dict_log and isinstance(value, dict):
                for owner in sorted(value):
                    entries = value[owner]
                    if section in store.KEYED_DICT_LOGS and isinstance(entries, dict):
                        entries = ([k, v] for k, v in entries.items())
                    for entry in entries:
                        at = entry.get("at") if isinstance(entry, dict) else None
                        yield section, owner, at if isinstance(at, str) else None, encode(entry)
            elif not dict_log and isinstance(value, list):
                for entry in value:
                    at = entry.get("at") if isinstance(entry, dict) else None
                    yield section, at if isinstance(at, str) else None, encode(entry)
    add("log_d", logs(True))
    add("log_l", logs(False))
    add("meta", ((k, meta[k]) for k in sorted(meta)))
    return dict(sha256=h.hexdigest(), rows=counts, table_sha256=table_hashes)


def destination(root, slug, url):
    root = safe_root(root)
    target = urlsplit(url)
    if target.hostname not in ("localhost", "127.0.0.1", "::1") or not target.path.lstrip("/").startswith(
            ("orgtree_scale_", "orgtree_pg0_t")):
        raise ValueError("only an explicitly disposable loopback database is supported")
    marker = root / "history-destination.json"
    expected = dict(format=FORMAT, root=str(root.resolve()), slug=slug,
                    database_sha256=hashlib.sha256(url.encode()).hexdigest())
    if not marker.is_file() or json.loads(marker.read_text(encoding="utf-8")) != expected:
        raise ValueError("destination ownership receipt missing or mismatched")
    return root


def authorize_empty_destination(root, slug, url):
    """Explicit preparation of an owned empty directory; never infer live ownership."""
    root = safe_root(root, new=True)
    root.mkdir(parents=True, exist_ok=True)
    (root / "history-destination.json").write_text(json.dumps(dict(
        format=FORMAT, root=str(root.resolve()), slug=slug,
        database_sha256=hashlib.sha256(url.encode()).hexdigest())), encoding="utf-8")
    destination(root, slug, url)


def source_hash(raw):
    """All original source rows, streamed. Derived indexes are verified separately.

    log sequence IDs are storage positions, not record identities. Base rows are
    moved by the SAME fixed offset in both arms; hashes preserve their ordering
    and every body byte, excluding only that declared internal position.
    """
    h = hashlib.sha256()
    queries = {
        "doc": "SELECT key,val FROM doc ORDER BY key",
        "nodes": "SELECT id,ord,val FROM nodes WHERE id NOT LIKE 'hist-%' ORDER BY id",
        "log_d": "SELECT sect,owner,at,val FROM log_d WHERE seq>=%s ORDER BY sect,owner,seq",
        "log_l": "SELECT sect,at,val FROM log_l WHERE seq>=%s ORDER BY sect,seq",
        "meta": "SELECT key,val FROM meta WHERE key='key_order' OR key LIKE 'owners:%%' ORDER BY key",
    }
    counts = {}
    table_hashes = {}
    for table, query in queries.items():
        count = 0
        table_hash = hashlib.sha256()
        # Server-side cursor keeps verification bounded even when the fixed
        # original fixture itself carries substantial historical tails.
        with raw.cursor(name="history_source_" + table) as cursor:
            cursor.execute(query, (TAIL_OFFSET,) if table.startswith("log_") else None)
            for row in cursor:
                encoded = (compact([table, *row]) + "\n").encode()
                h.update(encoded)
                table_hash.update(encoded)
                count += 1
        counts[table] = count
        table_hashes[table] = table_hash.hexdigest()
    return dict(sha256=h.hexdigest(), rows=counts, table_sha256=table_hashes)


def statistics(raw, *, analyze):
    from psycopg import sql
    tables = [r[0] for r in raw.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")]
    before = raw.execute("SELECT clock_timestamp()::text").fetchone()[0]
    if analyze:
        for table in tables:
            raw.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(table)))
    stats = raw.execute("SELECT relname,n_live_tup,last_analyze::text,last_autoanalyze::text "
                        "FROM pg_stat_all_tables WHERE schemaname=current_schema() ORDER BY relname").fetchall()
    estimates = raw.execute("SELECT c.relname,c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                            "WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname").fetchall()
    prior_analyze = any(row[2] or row[3] for row in stats)
    return dict(statistics_state="analyzed_after_seed" if analyze else
                ("seeded_before_explicit_analyze" if prior_analyze else "fresh_unanalyzed"),
                started_at=before, ended_at=raw.execute("SELECT clock_timestamp()::text").fetchone()[0],
                server_version=raw.execute("SHOW server_version").fetchone()[0],
                autovacuum=raw.execute("SHOW autovacuum").fetchone()[0],
                default_statistics_target=raw.execute("SHOW default_statistics_target").fetchone()[0],
                tables=tables, activity=stats, estimates=estimates)


def restore(bundle, arm, root, *, guard=lambda: None):
    from orgtree import ledger, pgstore, store, workread
    from psycopg import sql
    bundle = safe_root(bundle)
    manifest = verify_pair(bundle, require_complete=True)
    if arm not in ("small", "large"):
        raise ValueError("unknown arm")
    base = json.loads((bundle / "base.json").read_text(encoding="utf-8"))
    expected_source = frozen_source_hash(base)
    slug = base["slug"]
    root = destination(root, slug, pgstore.url())
    if (root / "RESTORING").exists() or (root / "RESTORE_COMPLETE").exists():
        raise ValueError("destination already contains a restore attempt")
    if Path(store.DATA_ROOT).resolve() != (root / "data").resolve() or store.STORE_BACKEND != "postgres":
        raise ValueError("store is outside the owned destination")
    if Path(os.environ.get("HOME", "")).resolve() != (root / "home").resolve():
        raise ValueError("HOME is outside the owned destination")
    if ledger.slugify(base.get("name", slug)) != slug:
        raise ValueError("base name/slug mismatch")
    if Path(store.org_path(slug)).exists():
        raise ValueError("destination org already exists; restore never overwrites it")
    with pgstore.connect() as check:
        if check.execute("SELECT 1 FROM public.orgs WHERE slug=%s", (slug,)).fetchone():
            raise ValueError("database already contains destination org")
    guard()
    (root / "RESTORING").write_text(arm, encoding="ascii")
    start = time.perf_counter()
    def prepare(org):
        org.d.clear()
        org.d.update(copy.deepcopy(base))
    org = store.create_org(base.get("name", slug), prepare=prepare)
    if org.d["slug"] != slug:
        raise ValueError("base name/slug mismatch")
    del org
    with store._POOL.acquire(slug) as conn:
        conn.use()
        raw = conn.raw
        raw.execute("BEGIN")
        oid = raw.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (slug,)).fetchone()[0]
        for table in ("log_d", "log_l"):
            maximum = raw.execute(sql.SQL("SELECT coalesce(max(seq),0) FROM {}").format(sql.Identifier(table))).fetchone()[0]
            if maximum >= TAIL_OFFSET:
                raise ValueError("base log exceeds reserved ordinal domain")
            raw.execute(sql.SQL("UPDATE {} SET seq=seq+%s").format(sql.Identifier(table)), (TAIL_OFFSET,))
        before = source_hash(raw)
        if before != expected_source:
            mismatched = [table for table in before["table_sha256"]
                          if before["table_sha256"][table] != expected_source["table_sha256"][table]]
            raise ValueError(f"persisted active/fixed records changed from frozen base: {mismatched}")
        node_ord = raw.execute("SELECT coalesce(max(ord),-1)+1 FROM nodes").fetchone()[0]
        with raw.cursor().copy("COPY nodes(id,ord,val) FROM STDIN") as cp:
            for i, row in enumerate(read_rows(bundle / arm / "retired_agents.jsonl")):
                if i % 64 == 0: guard()
                cp.write_row((row["id"], node_ord + i, store._dumps(row)))
        with raw.cursor().copy("COPY log_l(seq,sect,at,val) FROM STDIN") as cp:
            for i, row in enumerate(read_rows(bundle / arm / "archived_items.jsonl")):
                if i % 64 == 0: guard()
                cp.write_row((i + 1, "work_items_archive", row["archived_at"], store._dumps(row)))
        with raw.cursor().copy("COPY log_d(seq,sect,owner,at,val) FROM STDIN") as cp:
            for i, row in enumerate(read_rows(bundle / arm / "read_mail.jsonl")):
                if i % 64 == 0: guard()
                cp.write_row((i + 1, "mail_log", row["to"], row["at"], store._dumps(row)))
        for table in ("log_d", "log_l"):
            raw.execute(sql.SQL("SELECT setval(pg_get_serial_sequence(%s,'seq'),coalesce(max(seq),1),true) FROM {}").format(
                sql.Identifier(table)), (table,))
        # Derivative dirty markers are settled by the normal importer seam.
        if not workread.refresh(raw, oid):
            raise ValueError("normal work-count refresh refused generated history")
        after = source_hash(raw)
        if after != before:
            raise ValueError("history changed a fixed source record")
        raw.commit()
    files = {}
    for name, expected in manifest["current_files"].items():
        target = root / "home" / safe_relative(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        with (bundle / "current-files" / name).open("rb") as src, target.open("xb") as dst:
            for block in iter(lambda: src.read(1024 * 1024), b""):
                guard()
                dst.write(block)
        files[name] = expected
    for row in read_rows(bundle / arm / "old_transcripts.jsonl"):
        guard()
        name = f".claude/projects/history-{slug}/{row['session']}.jsonl"
        target = root / "home" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            for event in row["records"]:
                stream.write((compact(event) + "\n").encode())
        files[name] = dict(bytes=target.stat().st_size, sha256=sha_file(target))
    with store._POOL.acquire(slug) as conn:
        conn.use()
        fresh = statistics(conn.raw, analyze=False)
        analyzed = statistics(conn.raw, analyze=True)
        conn.raw.commit()
    with store._POOL.acquire(slug) as conn:
        conn.use()
        database_bytes = conn.raw.execute("SELECT pg_database_size(current_database())").fetchone()[0]
    receipt = dict(format=FORMAT, arm=arm, slug=slug, bundle=str(bundle),
                   active_sha256=manifest["active_sha256"], fixed_source=before,
                   files=files, statistics=analyzed, cold_statistics=fresh,
                   restore_seconds=time.perf_counter() - start,
                   database_bytes=database_bytes,
                   capture_state="source files present; normal transcript ingestion still required")
    (root / "history-restore.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    verify_restored(bundle, arm, root)
    (root / "RESTORE_COMPLETE").write_text(sha_file(root / "history-restore.json"), encoding="ascii")
    (root / "RESTORING").unlink()
    return receipt


def verify_restored(bundle, arm, root, *, require_complete=False):
    """Independent fresh transaction, callable from a separate interpreter."""
    from orgtree import store, pgstore
    manifest = verify_pair(bundle, require_complete=True)
    base = json.loads((Path(bundle) / "base.json").read_text(encoding="utf-8"))
    expected_source = frozen_source_hash(base)
    receipt = json.loads((Path(root) / "history-restore.json").read_text(encoding="utf-8"))
    root = destination(root, receipt["slug"], pgstore.url())
    if Path(store.DATA_ROOT).resolve() != (root / "data").resolve():
        raise ValueError("verifier store is outside owned destination")
    if require_complete and ((root / "RESTORING").exists() or
            not (root / "RESTORE_COMPLETE").is_file() or
            (root / "RESTORE_COMPLETE").read_text() != sha_file(root / "history-restore.json")):
        raise ValueError("incomplete or changed restoration")
    if (receipt["active_sha256"] != manifest["active_sha256"] or receipt["arm"] != arm
            or receipt["slug"] != base["slug"]):
        raise ValueError("wrong restored base or arm")
    with store._POOL.acquire(receipt["slug"]) as conn:
        conn.use()
        conn.raw.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        if source_hash(conn.raw) != expected_source or receipt["fixed_source"] != expected_source:
            raise ValueError("persisted active/fixed records changed from frozen base")
        selectors = {
            "retired_agents": "SELECT val FROM nodes WHERE id LIKE 'hist-%' ORDER BY ord",
            "archived_items": "SELECT val FROM log_l WHERE seq<%s ORDER BY seq",
            "read_mail": "SELECT val FROM log_d WHERE seq<%s ORDER BY seq",
        }
        for family, query in selectors.items():
            expected = iter(read_rows(Path(bundle) / arm / (family + ".jsonl")))
            count = 0
            with conn.raw.cursor(name="verify_history_" + family) as cursor:
                cursor.execute(query, (TAIL_OFFSET,) if family != "retired_agents" else None)
                for value, in cursor:
                    if json.loads(value) != next(expected, None):
                        raise ValueError("stored historical row differs from bundle")
                    count += 1
            if next(expected, None) is not None or count != manifest["arms"][arm][family]["count"]:
                raise ValueError("stored history missing")
        conn.raw.rollback()
    # Derive the expected inventory from the frozen bundle, not the restore
    # writer's receipt (an omitted file must not disappear from verification).
    files = dict(manifest["current_files"])
    for row in read_rows(Path(bundle) / arm / "old_transcripts.jsonl"):
        encoded = "".join(compact(event) + "\n" for event in row["records"]).encode()
        name = f".claude/projects/history-{receipt['slug']}/{row['session']}.jsonl"
        files[name] = dict(bytes=len(encoded), sha256=hashlib.sha256(encoded).hexdigest())
    if files != receipt["files"]:
        raise ValueError("restored file inventory differs from bundle")
    home = safe_root(root / "home")
    actual = set()
    for folder, directories, names in os.walk(home, followlinks=False):
        for name in directories:
            safe_root(Path(folder) / name)  # Reject links/junctions, even empty ones.
        for name in names:
            path = regular_file(Path(folder) / name)
            actual.add(path.relative_to(home).as_posix())
    if actual != set(files):
        raise ValueError("restored file inventory contains missing or undeclared files")
    for name, expected in files.items():
        path = regular_file(root / "home" / safe_relative(name))
        if path.stat().st_size != expected["bytes"] or sha_file(path) != expected["sha256"]:
            raise ValueError("restored transcript changed")
    return dict(active_sha256=receipt["active_sha256"], fixed_source=receipt["fixed_source"], verified=True)


def main():
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("restore", "verify"))
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--arm", choices=("small", "large"), required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    # The controller must configure the owned destination and environment.
    # This command never creates a database, starts PG or authorizes a root.
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / "tools"))
    from assert_repo_import import assert_repo_import
    provenance = assert_repo_import(repo)
    from control import free_commit_gb
    def guard():
        if free_commit_gb() < 10:
            raise RuntimeError("free commit below10GiB; restore stopped")
    guard()
    result = (restore(args.bundle, args.arm, args.root, guard=guard) if args.action == "restore" else
              verify_restored(args.bundle, args.arm, args.root, require_complete=True))
    provenance.write_result(args.result, result)


if __name__ == "__main__":
    main()
