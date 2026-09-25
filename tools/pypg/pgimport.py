"""PYPG PG-2 (tools/pypg/pgimport.py): import every org from its SQLite ``.db`` (or legacy ``.json``)
into PostgreSQL, with counts and checksums, leaving the old files untouched.

THE PROBLEM. The alpha switches org storage to PostgreSQL (user decision 31).
Nothing may be lost or silently altered on the way, and the old files must
stay exactly as they were so the switch back is a real rollback.

THE SHAPE. The seam's row layout moves as it is (PYPG-PLAN §1): per org the
five SQLite tables ``doc``, ``nodes``, ``log_d``, ``log_l`` and ``meta``
(``store.py`` §3.1). This module

1. EXTRACTS those rows without writing to the data root: a ``.db`` is copied
   with SQLite's online-backup API into a temporary file and read there; a
   legacy ``.json`` goes through the store's own JSON->rows writer
   (``store._write_doc``) and verifier (``store.verify_migration``) in a
   temporary file, exactly as ``store.migrate_org`` would, minus the renames;
2. CHECKS that every table, column, section, meta key and value is one this
   importer knows how to carry (:func:`problems`) — anything else REFUSES;
3. MEASURES a manifest: per table and per section, the row count and a
   sha256 over the CANONICAL rows (values compared as parsed JSON with sorted
   keys, so a store that normalises key order, like ``jsonb``, still matches);
4. IMPORTS through a :class:`Sink` (the PostgreSQL side), one transaction per
   org, and reads the org back to compare manifests. An org whose recorded
   import already matches its source is skipped, so a crashed run is simply
   run again (RT10).

The dry run (:func:`dry_run`) does 1-3 for every org and changes nothing.

WHY A TOOL, NOT ENGINE CODE. The import runs once, offline, with the engine
STOPPED, and only coordinator-opus runs it against a real root. Nothing in
the engine imports it, so it adds no runtime storage path.
The cutover (:func:`write_cutover`) happens only after a complete, verified
import with no refusals.

NOT COVERED (stated where a reader will look): the side stores outside
``orgs/`` (reply events, tool waits, file deliveries, chat-window index, the
census) are not org documents and are not imported here; each is reported by
the dry run as ``side_stores`` so nothing is skipped silently.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from typing import Any, Iterable, Iterator, Mapping, Protocol

_REPO = Path(__file__).resolve().parents[2]
if str(_REPO / "engine" / "backend") not in sys.path:
    sys.path.insert(0, str(_REPO / "engine" / "backend"))
from orgtree import store  # noqa: E402  (after the backend is on the path)

SCHEMA = "orgtree.pgimport/v1"
TABLES: tuple[str, ...] = ("doc", "nodes", "log_d", "log_l", "meta")
COLUMNS: dict[str, tuple[str, ...]] = {
    "doc": ("key", "val"),
    "nodes": ("id", "ord", "val"),
    "log_d": ("seq", "sect", "owner", "at", "val"),
    "log_l": ("seq", "sect", "at", "val"),
    "meta": ("key", "val"),
}
#: The column that orders a table's rows for the checksum (its primary key).
ORDER: dict[str, str] = {"doc": "key", "nodes": "id", "log_d": "seq", "log_l": "seq", "meta": "key"}
#: SQLite's own bookkeeping tables and the store's indexes are expected.
SQLITE_INTERNAL = frozenset({"sqlite_sequence", "sqlite_stat1", "sqlite_stat4"})
KNOWN_META = frozenset({"schema_version", "migrated_at", "source_json_sha256", "source_json_bytes",
                        store._META_KEY_ORDER})
KNOWN_META_PREFIXES = (store._META_OWNERS,)
DICT_LOGS = frozenset(store.DICT_LOGS)
LIST_LOGS = frozenset(store.LIST_LOGS)
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")

#: The top-level document keys (``doc`` rows) this importer recognises. A key
#: outside this list REFUSES the cutover until someone has looked at it and
#: added it here: the rows would carry it faithfully, but the ticket requires
#: that nothing unrecognised is switched over unseen. Built from ``Org.create``
#: and every top-level access in the backend at bb44eb3 (see the tests).
KNOWN_DOC_KEYS = frozenset("""
version slug name created tiers models workspace dirs permission_mode default_tools
default_visibility max_top_grant default_top_grant credit_requests compact_at
fable_limit_policy fable_filter_policy fable_filter_model nodes
external_inbox_multi_holder org_inbox_multi_holder audiences audience_requests
account_fallback_default api_cost_usd api_fallback api_key asks auto_cheap_compact
auto_resume auto_resume_compact auto_resume_last bridge_credential_generation
bridge_credential_rotated_at cascade_alloc cascade_hire cred_warned_at default_account
default_effort deleted_cost_usd deleted_cost_usd_unknown delivering desktop_import disk
documents events fable_lock headless killswitch kiosk mail mail_log mail_transitions
manual_attempts net_autoconnect net_hubs net_identity net_spool net_state notice_log
notices org_inbox org_inbox_read sandbox spend_frozen steer_attempts steered_log
storage_blocked storage_full storage_warned turn_error_log user_inbox user_mail_log
watchdogs watchdog_history watchdog_tombs work_items work_items_archive work_identity
work_deleted_names user_outbox op_receipts scope_requests reservations repositories
wakes executing max_depth max_children running_commit running_backend_pid
_migrations _actors_typed whole_grants_v1
""".split())


class ImportRefused(RuntimeError):
    """The import (or the cutover) must not proceed. Nothing was switched."""


# ---------------------------------------------------------------- rows

@dataclasses.dataclass
class OrgRows:
    slug: str
    source: str                       # "sqlite" | "json"
    source_path: str
    source_fingerprint: str           # sha256 of the source file's bytes
    rows: dict[str, list[tuple[Any, ...]]]
    extra_tables: list[str] = dataclasses.field(default_factory=list)
    extra_columns: dict[str, list[str]] = dataclasses.field(default_factory=dict)


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_tables(conn: sqlite3.Connection) -> tuple[dict[str, list[tuple[Any, ...]]], list[str], dict[str, list[str]]]:
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    extra = sorted(n for n in names if n not in TABLES and n not in SQLITE_INTERNAL)
    rows: dict[str, list[tuple[Any, ...]]] = {}
    extra_cols: dict[str, list[str]] = {}
    for table in TABLES:
        if table not in names:
            rows[table] = []
            continue
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
        unknown = [c for c in cols if c not in COLUMNS[table]]
        missing = [c for c in COLUMNS[table] if c not in cols]
        if unknown or missing:
            extra_cols[table] = unknown + [f"-{c}" for c in missing]
            rows[table] = []
            continue
        rows[table] = [tuple(r) for r in conn.execute(
            f"SELECT {', '.join(COLUMNS[table])} FROM {table} ORDER BY {ORDER[table]}")]
    return rows, extra, extra_cols


@contextlib.contextmanager
def _scratch_db() -> Iterator[Path]:
    folder = Path(tempfile.mkdtemp(prefix="orgtree-pgimport-"))
    try:
        yield folder / "copy.db"
    finally:
        for p in folder.iterdir():
            with contextlib.suppress(OSError):
                p.unlink()
        with contextlib.suppress(OSError):
            folder.rmdir()


def extract_sqlite(slug: str, path: Path) -> OrgRows:
    """Rows of ``orgs/<slug>.db`` via an online-backup COPY: consistent under
    WAL, and the source is opened read-only and never written."""
    fingerprint = _file_sha256(path)
    # At rest (a cleanly closed WAL database has no -wal/-shm) the file is
    # complete, and ``immutable=1`` reads it without creating either sidecar,
    # so the orgs folder stays byte-for-byte as it was. With a sidecar
    # present the WAL may hold committed rows: read-only the ordinary way
    # (the sidecars exist already).
    at_rest = not any(Path(str(path) + s).exists() for s in ("-wal", "-shm"))
    mode = "?mode=ro&immutable=1" if at_rest else "?mode=ro"
    with _scratch_db() as copy:
        src = sqlite3.connect(path.resolve().as_uri() + mode, uri=True, timeout=30)
        try:
            dst = sqlite3.connect(copy)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        conn = sqlite3.connect(copy)
        try:
            rows, extra, extra_cols = _read_tables(conn)
        finally:
            conn.close()
    return OrgRows(slug, "sqlite", str(path), fingerprint, rows, extra, extra_cols)


def extract_json(slug: str, path: Path) -> OrgRows:
    """Rows of a legacy ``<slug>.json`` through the store's own JSON->rows
    writer and its round-trip verifier (``store.migrate_org`` minus the
    renames). ``migrated_at`` is not written, so a rerun is identical."""
    raw = path.read_bytes()
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ImportRefused(f"{path}: not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ImportRefused(f"{path}: not a JSON object")
    with _scratch_db() as copy:
        conn = store._open_conn(str(copy), create=True)
        try:
            conn.execute("BEGIN IMMEDIATE")
            store._write_doc(conn, parsed, None)
            store._meta_set(conn, "schema_version", store._SCHEMA_VERSION)
            store._meta_set(conn, "source_json_sha256", hashlib.sha256(raw).hexdigest())
            store._meta_set(conn, "source_json_bytes", str(len(raw)))
            conn.execute("COMMIT")
            try:
                store.verify_migration(conn, parsed)
            except store.MigrationError as exc:
                raise ImportRefused(f"{path}: the store's JSON->rows round trip failed: {exc}") from exc
            rows, extra, extra_cols = _read_tables(conn)
        finally:
            conn.close()
    return OrgRows(slug, "json", str(path), hashlib.sha256(raw).hexdigest(), rows, extra, extra_cols)


# ---------------------------------------------------------------- what is recognised

def _meta_is_json(key: str) -> bool:
    """``meta`` values are plain TEXT (a sha, a timestamp, "1") except the
    key order and the ``owners:<sect>`` lists, which hold JSON."""
    return key == store._META_KEY_ORDER or key.startswith(store._META_OWNERS)


def _json_problem(text: Any, *, is_json: bool = True) -> str | None:
    """A stored value PostgreSQL cannot hold faithfully: ``jsonb`` for
    values, ``text`` for plain meta. Both refuse the NUL character."""
    if not isinstance(text, str):
        return "not text"
    if "\x00" in text:
        return "contains a NUL character, which PostgreSQL refuses"
    if not is_json:
        return None

    def refuse_constant(name: str) -> Any:
        raise ValueError(f"{name} is not JSON")

    try:
        value = json.loads(text, parse_constant=refuse_constant)
    except ValueError as exc:
        return f"not strict JSON ({exc})"
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, float) and not math.isfinite(v):
            return "a number too large to compare exactly (parses as infinity)"
        if isinstance(v, str) and "\x00" in v:
            return "contains NUL (\\u0000), which jsonb refuses"
        if isinstance(v, dict):
            if any("\x00" in k for k in v):
                return "contains NUL (\\u0000) in a key, which jsonb refuses"
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)
    return None


def problems(org: OrgRows) -> list[str]:
    """Everything that makes this org NOT importable as recognised data.
    Empty means importable."""
    out: list[str] = []
    out += [f"unrecognised table {t!r}" for t in org.extra_tables]
    out += [f"table {t!r} has unrecognised or missing columns {c}" for t, c in org.extra_columns.items()]
    doc_keys = [r[0] for r in org.rows["doc"]]
    out += [f"unrecognised section {k!r}" for k in doc_keys if k not in KNOWN_DOC_KEYS]
    out += [f"section {k!r} is a lazy log but is stored as a document row" for k in doc_keys
            if k in DICT_LOGS or k in LIST_LOGS]
    for sect in sorted({r[1] for r in org.rows["log_d"]} - DICT_LOGS):
        out.append(f"unrecognised dict-log section {sect!r}")
    for sect in sorted({r[1] for r in org.rows["log_l"]} - LIST_LOGS):
        out.append(f"unrecognised list-log section {sect!r}")
    for key in (r[0] for r in org.rows["meta"]):
        if key in KNOWN_META:
            continue
        prefix = next((p for p in KNOWN_META_PREFIXES if key.startswith(p)), None)
        if prefix is None or key[len(prefix):] not in DICT_LOGS:
            out.append(f"unrecognised meta key {key!r}")
    for table in TABLES:
        vcol = COLUMNS[table].index("val")
        for row in org.rows[table]:
            why = _json_problem(row[vcol], is_json=table != "meta" or _meta_is_json(row[0]))
            if why:
                out.append(f"{table} row {row[0]!r}: value {why}")
    return out


# ---------------------------------------------------------------- the manifest

def canonical_row(table: str, row: tuple[Any, ...]) -> str:
    """One row as canonical text: the value parsed and re-serialised with
    sorted keys (``store.canon``), every other column as stored."""
    cols = COLUMNS[table]
    parse = table != "meta" or _meta_is_json(row[0])
    out: list[Any] = []
    for name, value in zip(cols, row):
        out.append(json.loads(value) if name == "val" and parse else value)
    return store.canon(out)


def manifest(rows: Mapping[str, list[tuple[Any, ...]]]) -> dict[str, Any]:
    """Counts and sha256s per table and per section. Rows are ordered by the
    table's key, so the digest does not depend on read order."""
    tables: dict[str, Any] = {}
    sections: dict[str, dict[str, Any]] = {}

    def add(section: str, text: str) -> None:
        s = sections.setdefault(section, {"count": 0, "_h": hashlib.sha256()})
        s["count"] += 1
        s["_h"].update(text.encode("utf-8") + b"\n")

    for table in TABLES:
        key = COLUMNS[table].index(ORDER[table])
        ordered = sorted(rows.get(table, []), key=lambda r: r[key])
        h = hashlib.sha256()
        for row in ordered:
            text = canonical_row(table, row)
            h.update(text.encode("utf-8") + b"\n")
            if table == "doc":
                add(f"doc:{row[0]}", text)
            elif table == "nodes":
                add("nodes", text)
            elif table == "log_d":
                add(f"log_d:{row[1]}", text)
            elif table == "log_l":
                add(f"log_l:{row[1]}", text)
            else:
                add("meta", text)
        tables[table] = {"count": len(ordered), "sha256": h.hexdigest()}
    return {"tables": tables,
            "sections": {k: {"count": v["count"], "sha256": v["_h"].hexdigest()} for k, v in sorted(sections.items())}}


def manifest_digest(m: Mapping[str, Any]) -> str:
    return hashlib.sha256(store.canon(m).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- the data root

def classify_orgs_dir(root: Path) -> dict[str, Any]:
    """Which file is each org's authority, and what else lies in ``orgs/``.

    ``<slug>.db`` is the authority when present (``-wal``/``-shm`` belong to
    it); otherwise ``<slug>.json``. The store's own rollback copies
    (``.json.premigration*``) are listed and ignored. A ``.db`` beside a
    ``.json`` (the store's backend-mismatch shape), an interrupted
    migration (``.db.migrating``) and any other file REFUSE."""
    orgs = root / "orgs"
    out: dict[str, Any] = {"orgs": {}, "ignored": [], "refused": []}
    if not orgs.is_dir():
        return out
    names = sorted(p.name for p in orgs.iterdir())
    for name in names:
        path = orgs / name
        if path.is_dir():
            out["refused"].append(f"orgs/{name}: unexpected folder")
            continue
        if ".json.premigration" in name:
            out["ignored"].append(f"orgs/{name}")
            continue
        if name.endswith((".db-wal", ".db-shm")):
            continue
        if name.endswith(".db.migrating"):
            out["refused"].append(f"orgs/{name}: an interrupted JSON->SQLite migration (start the SQLite engine once to finish it)")
            continue
        stem, dot, ext = name.rpartition(".")
        if not dot or ext not in ("db", "json") or not _SLUG.match(stem):
            out["refused"].append(f"orgs/{name}: unrecognised file")
            continue
        if ext == "json" and (orgs / f"{stem}.db").exists():
            out["refused"].append(f"orgs/{name}: a .json beside {stem}.db (which one is the authority?)")
            continue
        if ext == "db" or not (orgs / f"{stem}.db").exists():
            out["orgs"][stem] = {"source": "sqlite" if ext == "db" else "json", "path": str(path)}
    return out


SIDE_STORES = ("reply_events", "tool_waits", "file_deliveries", "chat_window_index")


def extract(slug: str, entry: Mapping[str, str]) -> OrgRows:
    path = Path(entry["path"])
    return extract_sqlite(slug, path) if entry["source"] == "sqlite" else extract_json(slug, path)


def dry_run(root: Path) -> dict[str, Any]:
    """Every org: source, counts, checksums, problems. Writes nothing."""
    layout = classify_orgs_dir(root)
    report: dict[str, Any] = {"schema": SCHEMA, "kind": "dry_run", "root": str(root),
                              # which store did the JSON->rows work: the bundled
                              # runtime's ._pth can otherwise supply another checkout's
                              "provenance": {"store": str(Path(store.__file__).resolve()),
                                             "pgimport": str(Path(__file__).resolve())},
                              "orgs": {}, "ignored": layout["ignored"], "refused": list(layout["refused"])}
    for slug, entry in layout["orgs"].items():
        try:
            org = extract(slug, entry)
        except ImportRefused as exc:
            report["orgs"][slug] = {"source": entry["source"], "problems": [str(exc)]}
            report["refused"].append(f"{slug}: {exc}")
            continue
        found = problems(org)
        m = manifest(org.rows)
        report["orgs"][slug] = {"source": org.source, "source_fingerprint": org.source_fingerprint,
                                "manifest": m, "manifest_sha256": manifest_digest(m), "problems": found}
        report["refused"] += [f"{slug}: {p}" for p in found]
    report["side_stores"] = sorted(p.name for p in root.iterdir()
                                   if p.is_file() and p.suffix == ".db" and any(s in p.name for s in SIDE_STORES)) \
        if root.is_dir() else []
    report["importable"] = not report["refused"]
    return report


# ---------------------------------------------------------------- the target

class Sink(Protocol):
    """The PostgreSQL side (PG-0's tables). Each call is one org.

    ``replace_org`` must be ONE transaction: delete whatever rows the org has,
    insert these, record ``receipt`` (source fingerprint + manifest digest),
    commit. A crash anywhere inside leaves the previous state whole."""

    def recorded(self, slug: str) -> Mapping[str, Any] | None: ...
    def replace_org(self, slug: str, rows: Mapping[str, list[tuple[Any, ...]]], receipt: Mapping[str, Any]) -> None: ...
    def read_org(self, slug: str) -> dict[str, list[tuple[Any, ...]]]: ...


def import_root(root: Path, sink: Sink, *, only: Iterable[str] | None = None) -> dict[str, Any]:
    """Import every org (or ``only``). Refuses up front if the dry run finds
    anything unrecognised. Resumable: an org whose recorded receipt matches
    its source fingerprint AND whose rows read back to the same manifest is
    skipped; anything else is replaced whole. Returns the per-org record."""
    plan = dry_run(root)
    if plan["refused"]:
        raise ImportRefused("the dry run refused: " + "; ".join(plan["refused"][:20])
                            + (f" (+{len(plan['refused']) - 20} more)" if len(plan["refused"]) > 20 else ""))
    wanted = set(only) if only is not None else None
    layout = classify_orgs_dir(root)
    result: dict[str, Any] = {"schema": SCHEMA, "kind": "import", "root": str(root), "orgs": {}}
    for slug, entry in layout["orgs"].items():
        if wanted is not None and slug not in wanted:
            continue
        org = extract(slug, entry)
        # The source may have changed since the dry run: re-check it.
        found = problems(org)
        if found:
            raise ImportRefused(f"{slug}: {found[0]}")
        m = manifest(org.rows)
        digest = manifest_digest(m)
        receipt = {"schema": SCHEMA, "source": org.source, "source_fingerprint": org.source_fingerprint,
                   "manifest_sha256": digest}
        before = sink.recorded(slug)
        if before and before.get("source_fingerprint") == org.source_fingerprint \
                and before.get("manifest_sha256") == digest \
                and manifest_digest(manifest(sink.read_org(slug))) == digest:
            result["orgs"][slug] = {"action": "already_imported", "manifest_sha256": digest}
            continue
        sink.replace_org(slug, org.rows, receipt)
        back = manifest(sink.read_org(slug))
        if back != m:
            bad = sorted(k for k in set(m["sections"]) | set(back["sections"])
                         if m["sections"].get(k) != back["sections"].get(k))
            raise ImportRefused(f"{slug}: read-back does not match the source in {bad[:10] or list(m['tables'])}")
        result["orgs"][slug] = {"action": "imported", "manifest_sha256": digest,
                                "tables": {t: v["count"] for t, v in m["tables"].items()}}
    return result


# ---------------------------------------------------------------- the cutover

CUTOVER_FILE = "store-backend.json"


def write_cutover(root: Path, dry: Mapping[str, Any], imported: Mapping[str, Any]) -> dict[str, Any]:
    """Record that ``root`` now runs on PostgreSQL (ruling P4: postgres is the
    default after a successful import). Refuses unless the dry run was clean
    and EVERY org in it was imported or already imported with the same
    manifest. The old files are not touched; the rollback is to delete this
    file or set ``ORGTREE_STORE=sqlite`` (writes made after the switch are
    then lost — accepted, decision 30 (4))."""
    if dry.get("refused"):
        raise ImportRefused("cutover refused: the dry run was not clean")
    missing = [s for s in dry.get("orgs", {}) if s not in imported.get("orgs", {})]
    if missing:
        raise ImportRefused(f"cutover refused: orgs not imported: {missing}")
    mismatched = [s for s, v in imported["orgs"].items()
                  if v.get("manifest_sha256") != dry["orgs"].get(s, {}).get("manifest_sha256")]
    if mismatched:
        raise ImportRefused(f"cutover refused: imported manifests differ from the dry run: {mismatched}")
    record = {"schema": "orgtree.store-backend/v1", "backend": "postgres",
              "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "orgs": {s: v["manifest_sha256"] for s, v in sorted(imported["orgs"].items())},
              "rollback": "delete this file or set ORGTREE_STORE=sqlite; writes made after the switch are lost"}
    target = root / CUTOVER_FILE
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    return record


# ---------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    """``dry-run --root <data root> [--out report.json]``: the report on
    stdout (or to ``--out``), exit 0 when importable, 3 when refused. Reads
    only. The import and the cutover need the PostgreSQL sink (PG-0) and are
    run by coordinator-opus alone on a real root."""
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(prog="pgimport", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    dry = sub.add_parser("dry-run", help="counts, checksums and refusals for every org; writes nothing")
    dry.add_argument("--root", type=Path, required=True)
    dry.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if not (root / "orgs").is_dir():
        print(f"pgimport: {root} has no orgs/ folder", file=sys.stderr)
        return 2
    report = dry_run(root)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    summary = {"orgs": len(report["orgs"]), "importable": report["importable"], "refused": len(report["refused"])}
    print("pgimport dry-run: " + json.dumps(summary), file=sys.stderr)
    return 0 if report["importable"] else 3


if __name__ == "__main__":
    sys.exit(main())
