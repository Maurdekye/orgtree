"""PYPG PG-2 (tools/pypg/pgimport.py): import every org from its SQLite ``.db`` (or legacy ``.json``)
into PostgreSQL, with counts and checksums, keeping the old files byte for byte.

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
   org, and reads the org back: the manifests AND the raw rows must match
   (PG-0 stores ``val`` as text, so a faithful import is byte-identical). An
   org whose recorded import already matches its source is skipped, so a
   crashed run is simply run again (RT10). The real sink is :class:`PgSink`
   (PG-0's layout); the import holds the root's owner lock, so it refuses
   while the engine runs and the engine cannot start during it.

The dry run (:func:`dry_run`) does 1-3 for every org and changes nothing.

WHY A TOOL, NOT ENGINE CODE. The import runs once, offline, with the engine
STOPPED, and only coordinator-opus runs it against a real root. Nothing in
the engine imports it, so it adds no runtime storage path.
The cutover (:func:`write_cutover`) happens only after a complete, verified
import with no refusals. It writes ``store-backend.json`` (decision 18.1: the
engine then chooses postgres) and then MOVES the old files, unchanged, to
``pre-postgres/orgs``: PG-0's postgres start-up refuses while ``orgs/`` still
holds a ``.db`` or ``.json``. Until the cutover the old files are not touched
at all; the import only adds PG-0's ``<slug>.pg`` markers beside them.

THE REAL ROOT (decision 18.1). The engine's own data root is served by the
custodian's PRODUCT mode: ``prepare`` runs ``pg-custodian bind-product``
(which refuses in an agent session or inside the installed app), then
``import --cutover`` does the rest. See :func:`main`.

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
# The tool READS SQLite/JSON sources through the store's SQLite code; an
# operator shell that already says postgres must not change how it reads.
os.environ["ORGTREE_STORE"] = "sqlite"
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
#: PG-0's per-org marker file under orgs/ (``pgstore.MARKER_EXT``).
MARKER_EXT = ".pg"

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
    # a split section's owner rows (store.SPLIT_SECTIONS, PG-3d) are part of
    # their section, and are recognised only beside its container row
    split = {k: store.split_section_of(k) for k in doc_keys}
    out += [f"unrecognised section {k!r}" for k in doc_keys
            if split[k] is None and k not in KNOWN_DOC_KEYS]
    out += [f"owner row {k!r} has no {s!r} container row" for k, s in split.items()
            if s is not None and s not in doc_keys]
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
    out: dict[str, Any] = {"orgs": {}, "ignored": [], "refused": [], "markers": []}
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
        if name.endswith(MARKER_EXT):
            # PG-0's marker, left by an earlier (possibly interrupted) run of
            # this import. It belongs to a source beside it; alone it is an
            # org whose only copy is in PostgreSQL, which we did not expect.
            stem = name[:-len(MARKER_EXT)]
            if (orgs / f"{stem}.db").exists() or (orgs / f"{stem}.json").exists():
                out["markers"].append(f"orgs/{name}")
            else:
                out["refused"].append(f"orgs/{name}: a PostgreSQL marker with no SQLite/JSON source beside it")
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


def cut_over(root: Path) -> bool:
    """True when ``root``'s cutover record already chooses postgres."""
    try:
        record = json.loads((root / CUTOVER_FILE).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except (OSError, ValueError) as exc:
        raise ImportRefused(f"{root / CUTOVER_FILE} exists but cannot be read: {exc}") from exc
    return isinstance(record, dict) and record.get("backend") == "postgres"


def dry_run(root: Path) -> dict[str, Any]:
    """Every org: source, counts, checksums, problems. Writes nothing."""
    if cut_over(root):
        raise ImportRefused(f"{root} is already cut over to PostgreSQL ({CUTOVER_FILE}); "
                            "there is nothing to import (run `import` again only to finish an interrupted cutover)")
    layout = classify_orgs_dir(root)
    report: dict[str, Any] = {"schema": SCHEMA, "kind": "dry_run", "root": str(root),
                              # which store did the JSON->rows work: the bundled
                              # runtime's ._pth can otherwise supply another checkout's
                              "provenance": {"store": str(Path(store.__file__).resolve()),
                                             "pgimport": str(Path(__file__).resolve())},
                              "orgs": {}, "ignored": layout["ignored"], "markers": layout["markers"],
                              "refused": list(layout["refused"])}
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
    commit. A crash anywhere inside leaves the previous state whole.
    ``finish_org`` runs after an org is imported or found already imported
    (the real sink writes PG-0's ``orgs/<slug>.pg`` marker there)."""

    def recorded(self, slug: str) -> Mapping[str, Any] | None: ...
    def replace_org(self, slug: str, rows: Mapping[str, list[tuple[Any, ...]]], receipt: Mapping[str, Any]) -> None: ...
    def read_org(self, slug: str) -> dict[str, list[tuple[Any, ...]]]: ...
    def finish_org(self, slug: str) -> None: ...


def _ordered(rows: Mapping[str, list[tuple[Any, ...]]]) -> dict[str, list[tuple[Any, ...]]]:
    out: dict[str, list[tuple[Any, ...]]] = {}
    for table in TABLES:
        key = COLUMNS[table].index(ORDER[table])
        out[table] = sorted((tuple(r) for r in rows.get(table, [])), key=lambda r: r[key])
    return out


def import_root(root: Path, sink: Sink, *, only: Iterable[str] | None = None) -> dict[str, Any]:
    """Import every org (or ``only``). Refuses up front if the dry run finds
    anything unrecognised. Resumable: an org whose recorded receipt matches
    its source fingerprint AND whose rows read back to the same manifest is
    skipped; anything else is replaced whole. After every import the rows are
    read back and must match the source BYTE FOR BYTE (PG-0 stores ``val`` as
    text, exactly as SQLite held it) as well as by manifest. Returns the
    per-org record."""
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
            sink.finish_org(slug)
            result["orgs"][slug] = {"action": "already_imported", "manifest_sha256": digest}
            continue
        sink.replace_org(slug, org.rows, receipt)
        read = sink.read_org(slug)
        back = manifest(read)
        if back != m:
            bad = sorted(k for k in set(m["sections"]) | set(back["sections"])
                         if m["sections"].get(k) != back["sections"].get(k))
            raise ImportRefused(f"{slug}: read-back does not match the source in {bad[:10] or list(m['tables'])}")
        exact_src, exact_back = _ordered(org.rows), _ordered(read)
        if exact_src != exact_back:
            bad_tables = [t for t in TABLES if exact_src[t] != exact_back[t]]
            raise ImportRefused(f"{slug}: read-back is not byte-identical to the source in {bad_tables}")
        sink.finish_org(slug)
        result["orgs"][slug] = {"action": "imported", "manifest_sha256": digest,
                                "tables": {t: v["count"] for t, v in m["tables"].items()}}
    return result


class PgSink:
    """PG-0's layout (``engine/backend/orgtree/pg_migrations``): the org's
    row in ``public.orgs`` (slug -> org_id), its rows in schema
    ``org_<org_id>`` (the seam's five tables, ``val`` as text), and the
    ``orgs/<slug>.pg`` marker holding the org_id that ``store._db_path``
    names under the postgres backend.

    ``replace_org`` is one transaction: create the org and its schema if new
    (through PG-0's own ``orgtree_create_org_schema``), empty its five tables,
    COPY the rows in with their original ``seq`` values, move each log's
    identity past the highest ``seq`` (so the engine's next INSERT cannot
    collide), upsert the receipt under op_key ``pg2-import``, bump
    ``orgs.revision`` and NOTIFY ``org_rev``, commit. The marker is written
    only AFTER that commit (``finish_org``): a crash between the two leaves a
    receipt and no marker, and the rerun finds the receipt, checks the rows
    and writes the marker. Connect as the ADMIN role (the migrations and the
    org schemas are the admin's)."""

    OP_KEY = "pg2-import"

    def __init__(self, conninfo: str, orgs_dir: Path) -> None:
        from orgtree import pgstore  # noqa: PLC0415  only when the real sink is used
        self.pgstore = pgstore
        self.orgs_dir = orgs_dir
        self.conn = pgstore.connect(conninfo)
        self.migrations = pgstore.migrate(self.conn)

    def close(self) -> None:
        self.conn.close()

    def _org_id(self, slug: str) -> int | None:
        row = self.conn.execute("SELECT org_id FROM public.orgs WHERE slug = %s AND deleted_at IS NULL",
                                (slug,)).fetchone()
        return int(row[0]) if row else None

    def recorded(self, slug: str) -> Mapping[str, Any] | None:
        org_id = self._org_id(slug)
        if org_id is None:
            return None
        row = self.conn.execute("SELECT result FROM public.receipts WHERE org_id = %s AND op_key = %s",
                                (org_id, self.OP_KEY)).fetchone()
        return json.loads(row[0]) if row and row[0] else None

    def replace_org(self, slug: str, rows: Mapping[str, list[tuple[Any, ...]]], receipt: Mapping[str, Any]) -> None:
        with self.conn.transaction():
            org_id = self._org_id(slug)
            if org_id is None:
                org_id = int(self.conn.execute("INSERT INTO public.orgs(slug) VALUES (%s) RETURNING org_id",
                                               (slug,)).fetchone()[0])
                self.conn.execute("SELECT orgtree_create_org_schema(%s)", (org_id,))
            schema = f"org_{org_id}"
            for table in TABLES:
                self.conn.execute(f"DELETE FROM {schema}.{table}")
            cur = self.conn.cursor()
            for table in TABLES:
                if not rows.get(table):
                    continue
                with cur.copy(f"COPY {schema}.{table} ({', '.join(COLUMNS[table])}) FROM STDIN") as copy:
                    for row in rows[table]:
                        copy.write_row(row)
            for table in ("log_d", "log_l"):
                self.conn.execute(
                    f"SELECT setval(pg_get_serial_sequence('{schema}.{table}', 'seq'), "
                    f"COALESCE((SELECT max(seq) FROM {schema}.{table}), 0) + 1, false)")
            self.conn.execute(
                "INSERT INTO public.receipts(org_id, op_key, fingerprint, result) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (org_id, op_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, "
                "result = EXCLUDED.result, at = now()",
                (org_id, self.OP_KEY, str(receipt.get("source_fingerprint", "")), json.dumps(dict(receipt), sort_keys=True)))
            rev = self.conn.execute("UPDATE public.orgs SET revision = revision + 1 WHERE org_id = %s RETURNING revision",
                                    (org_id,)).fetchone()[0]
            self.conn.execute("SELECT pg_notify('org_rev', %s)", (f"{slug}:{rev}",))

    def read_org(self, slug: str) -> dict[str, list[tuple[Any, ...]]]:
        org_id = self._org_id(slug)
        if org_id is None:
            return {t: [] for t in TABLES}
        return {t: [tuple(r) for r in self.conn.execute(
            f"SELECT {', '.join(COLUMNS[t])} FROM org_{org_id}.{t} ORDER BY {ORDER[t]}").fetchall()]
            for t in TABLES}

    def finish_org(self, slug: str) -> None:
        org_id = self._org_id(slug)
        if org_id is None:
            raise ImportRefused(f"{slug}: no PostgreSQL row after its import")
        marker = self.orgs_dir / f"{slug}{MARKER_EXT}"
        have = self.pgstore.read_marker(str(marker))
        if have is not None and have != org_id:
            raise ImportRefused(f"{marker} names org_id {have}, but PostgreSQL holds {slug!r} as {org_id}")
        if have is None:
            self.pgstore._write_marker(str(marker), slug, org_id)


# ---------------------------------------------------------------- the engine is stopped

@contextlib.contextmanager
def engine_stopped(root: Path) -> Iterator[None]:
    """Hold the data root's owner lock (``store.owner_file``, the same byte
    the engine's ``claim_data_root`` takes) for the whole import: a running
    engine refuses the import, and an engine starting during it refuses to
    start."""
    fd = os.open(store.owner_file(str(root)), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if not store._try_lock(fd):
            raise ImportRefused(f"{root} is in use (its owner lock is held): stop the engine first")
        try:
            yield
        finally:
            os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt  # noqa: PLC0415
                with contextlib.suppress(OSError):
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


# ---------------------------------------------------------------- the cutover

CUTOVER_FILE = "store-backend.json"
CUTOVER_SCHEMA = "orgtree.store-backend/v1"
PROTOTYPE_MARKER = "orgtree-p03-prototype-root.json"
PRODUCT_BINDING = "orgtree-product-root.json"
#: Where the cutover moves the SQLite/JSON files (bytes untouched): PG-0's
#: postgres backend refuses to start while orgs/ still holds any of them.
ROLLBACK_DIR = Path("pre-postgres") / "orgs"


def write_cutover(root: Path, dry: Mapping[str, Any], imported: Mapping[str, Any]) -> dict[str, Any]:
    """Record that ``root`` now runs on PostgreSQL (decision 18.1: the engine
    reads this record when ``ORGTREE_STORE`` is unset) and move the old files
    aside. Refuses unless the dry run was clean and EVERY org in it was
    imported or already imported with the same manifest, and unless the root
    can actually be served (a prototype marker, or the product binding that
    ``prepare`` writes).

    Order: the record FIRST, then the moves (:func:`complete_cutover`). A
    crash between them leaves the engine refusing loudly (postgres chosen,
    SQLite files still in orgs/), never starting on a half-moved SQLite root;
    running ``import`` again finishes the moves. The rollback is to move the
    files back from ``pre-postgres/orgs`` and delete this record; writes made
    after the switch are then lost (accepted, decision 30 (4))."""
    if dry.get("refused"):
        raise ImportRefused("cutover refused: the dry run was not clean")
    missing = [s for s in dry.get("orgs", {}) if s not in imported.get("orgs", {})]
    if missing:
        raise ImportRefused(f"cutover refused: orgs not imported: {missing}")
    mismatched = [s for s, v in imported["orgs"].items()
                  if v.get("manifest_sha256") != dry["orgs"].get(s, {}).get("manifest_sha256")]
    if mismatched:
        raise ImportRefused(f"cutover refused: imported manifests differ from the dry run: {mismatched}")
    markers = [s for s in dry.get("orgs", {}) if not (root / "orgs" / f"{s}{MARKER_EXT}").is_file()]
    if markers:
        raise ImportRefused(f"cutover refused: no PostgreSQL marker for {markers}")
    if not ((root / PROTOTYPE_MARKER).is_file() or (root / PRODUCT_BINDING).is_file()):
        raise ImportRefused(f"cutover refused: {root} has neither a prototype marker nor the product binding "
                            f"({PRODUCT_BINDING}); run `pgimport prepare` first")
    record = {"schema": CUTOVER_SCHEMA, "backend": "postgres",
              "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "orgs": {s: v["manifest_sha256"] for s, v in sorted(imported["orgs"].items())},
              "moved_to": ROLLBACK_DIR.as_posix(),
              "rollback": f"move the files in {ROLLBACK_DIR.as_posix()} back into orgs/ and delete this file; "
                          "writes made after the switch are lost"}
    target = root / CUTOVER_FILE
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    record["moved"] = complete_cutover(root)
    return record


def complete_cutover(root: Path) -> list[str]:
    """Move every file in orgs/ except PG-0's markers into
    ``pre-postgres/orgs`` (a rename: the bytes are not touched). Idempotent;
    refuses to overwrite a file already there. Only after the record exists."""
    if not cut_over(root):
        raise ImportRefused(f"{root} has no cutover record choosing postgres; nothing is moved without one")
    orgs, dest = root / "orgs", root / ROLLBACK_DIR
    dest.mkdir(parents=True, exist_ok=True)
    moved: list[str] = []
    for p in sorted(orgs.iterdir()) if orgs.is_dir() else []:
        if p.is_dir() or p.name.endswith(MARKER_EXT):
            continue
        target = dest / p.name
        if target.exists():
            raise ImportRefused(f"{target} already exists; refusing to overwrite a rollback copy with {p}")
        os.rename(p, target)
        moved.append(p.name)
    return moved


# ---------------------------------------------------------------- the database

def _pg_process() -> Any:
    if str(_REPO) not in sys.path:
        sys.path.insert(0, str(_REPO))
    from engine import pg_process  # noqa: PLC0415
    return pg_process


def root_mode(root: Path) -> str:
    """How the custodian serves ``root``: its prototype marker, else the
    product binding ``prepare`` wrote. Anything else refuses."""
    if (root / PROTOTYPE_MARKER).is_file():
        return "prototype"
    if (root / PRODUCT_BINDING).is_file():
        return "product"
    raise ImportRefused(f"{root} has neither a prototype marker nor the product binding; run `pgimport prepare` first")


@contextlib.contextmanager
def database(root: Path, custodian: Path, env: Mapping[str, str]) -> Iterator[str]:
    """The root's own database, up for the import (init/start/attach through
    pg-custodian, as the engine bracket does), yielding the ADMIN conninfo.
    Stopped again afterwards unless it was already running."""
    pp = _pg_process()
    product = root_mode(root) == "product"
    workdir = Path(tempfile.mkdtemp(prefix="orgtree-pgimport-custodian-"))
    child = {k: v for k, v in env.items() if k not in ("ORGTREE_V2_TOKEN", pp.CONNINFO_ENV)}
    up = pp.database_up(custodian, root, child, workdir, product)
    try:
        runtime = up["runtime"]
        if not runtime.get("admin_role"):
            raise ImportRefused("pg-custodian attach gave no admin_role")
        yield pp.conninfo(runtime, str(runtime["admin_role"]), "orgtree-pgimport")
    finally:
        if up["action"] != "attached":
            pp.database_down(custodian, root, child, workdir, product)
        with contextlib.suppress(OSError):
            for p in workdir.iterdir():
                p.unlink()
            workdir.rmdir()


def _custodian(path: Path) -> Path:
    if not path.is_absolute() or not path.is_file():
        raise ImportRefused(f"--custodian {path} is not an existing absolute file")
    return path


# ---------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    """Three commands, all run by coordinator-opus alone, with the engine
    stopped:

    ``dry-run --root R [--out f]``: counts, checksums and refusals; reads only;
    exit 0 importable, 3 refused.

    ``prepare --root R --custodian EXE``: bind the engine's OWN data root for
    the custodian's product mode (``pg-custodian bind-product``). The
    custodian refuses unless R is ``ORGTREE_DATA`` and no agent variable or
    install folder overlaps it. Not needed for a prototype root.

    ``import --root R --custodian EXE [--cutover] [--out f]``: under the
    root's owner lock, bring the root's database up, import every org, read
    each back byte for byte, write the markers; with ``--cutover`` also write
    ``store-backend.json`` and move the SQLite/JSON files to
    ``pre-postgres/orgs``. Rerunning skips orgs already imported and finishes
    an interrupted cutover. Exit 0 done, 3 refused."""
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(prog="pgimport", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    dry = sub.add_parser("dry-run", help="counts, checksums and refusals for every org; writes nothing")
    dry.add_argument("--root", type=Path, required=True)
    dry.add_argument("--out", type=Path)
    prep = sub.add_parser("prepare", help="bind the engine's own data root for the custodian's product mode")
    prep.add_argument("--root", type=Path, required=True)
    prep.add_argument("--custodian", type=Path, required=True)
    imp = sub.add_parser("import", help="import every org into the root's own PostgreSQL")
    imp.add_argument("--root", type=Path, required=True)
    imp.add_argument("--custodian", type=Path, required=True)
    imp.add_argument("--cutover", action="store_true")
    imp.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if not (root / "orgs").is_dir():
        print(f"pgimport: {root} has no orgs/ folder", file=sys.stderr)
        return 2
    try:
        if args.command == "dry-run":
            report = dry_run(root)
            code = 0 if report["importable"] else 3
            summary = {"orgs": len(report["orgs"]), "importable": report["importable"], "refused": len(report["refused"])}
        elif args.command == "prepare":
            pp = _pg_process()
            workdir = Path(tempfile.mkdtemp(prefix="orgtree-pgimport-custodian-"))
            out = pp._run_custodian(_custodian(args.custodian), ["bind-product", "--root", str(root)],
                                    dict(os.environ), pp.STATUS_TIMEOUT, workdir)
            with contextlib.suppress(OSError):
                workdir.rmdir()
            if not out.get("ok"):
                raise ImportRefused(f"pg-custodian bind-product refused: {out.get('code')}: {out.get('message')}")
            report = {"schema": SCHEMA, "kind": "prepare", "root": str(root), "root_id": out.get("root_id")}
            code, summary = 0, {"bound": True}
        else:
            with engine_stopped(root):
                if cut_over(root):
                    report = {"schema": SCHEMA, "kind": "cutover_completed", "root": str(root),
                              "moved": complete_cutover(root)}
                    code, summary = 0, {"cutover_completed": True, "moved": len(report["moved"])}
                else:
                    plan = dry_run(root)
                    with database(root, _custodian(args.custodian), os.environ) as admin:
                        sink = PgSink(admin, root / "orgs")
                        try:
                            report = import_root(root, sink)
                            report["migrations"] = sink.migrations
                        finally:
                            sink.close()
                    report["provenance"] = plan["provenance"]
                    if args.cutover:
                        report["cutover"] = write_cutover(root, plan, report)
                    code = 0
                    summary = {"orgs": len(report["orgs"]), "cutover": bool(args.cutover)}
    except ImportRefused as exc:
        print(f"pgimport {args.command}: REFUSED: {exc}", file=sys.stderr)
        return 3
    text = json.dumps(report, indent=2, sort_keys=True)
    if getattr(args, "out", None):
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    print(f"pgimport {args.command}: " + json.dumps(summary), file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
