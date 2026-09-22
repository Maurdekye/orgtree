"""Read the supported 2.x fixture shapes without importing the live backend.

All input files are retained as bytes in the transfer bundle. Decoding is an
additional conservation check, not permission to discard an unknown field.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import sqlite3
import stat
from pathlib import Path

from .formats import LEDGER_DDL, SIDECAR_DDL


class Refused(ValueError):
    """Unsupported, changed, ambiguous, or corrupt rehearsal input."""


DICT_LOGS = ("mail_log", "steered_log", "turn_error_log", "steer_attempts")
LIST_LOGS = ("events", "org_inbox", "notice_log", "user_mail_log", "user_outbox",
             "documents", "watchdog_history", "op_receipts", "work_items_archive")
TABLE_COLUMNS = {
    "doc": ["key", "val"], "nodes": ["id", "ord", "val"],
    "log_d": ["seq", "sect", "owner", "at", "val"],
    "log_l": ["seq", "sect", "at", "val"], "meta": ["key", "val"],
}


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    def pairs(rows):
        out = {}
        for key, value in rows:
            if key in out:
                raise Refused("duplicate JSON key")
            out[key] = value
        return out

    def constant(_):
        raise Refused("non-finite JSON number")

    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise Refused("non-finite JSON number")
        return parsed

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant, parse_float=number)
    except (ValueError, UnicodeError, TypeError) as exc:
        raise Refused("invalid JSON") from exc


def plain_tree(root, *, skip_contents=()):
    """Never follow links/junctions or accept devices/hardlinked payloads."""
    root = Path(root).absolute()
    for parent in (root, *root.parents):
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise Refused("linked path refused")
    if not root.is_dir():
        raise Refused("expected directory")
    files = {}
    pending = [root]
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise Refused("linked entry refused")
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                name = path.relative_to(root).as_posix()
                files[name] = b"" if name in skip_contents else path.read_bytes()
            else:
                raise Refused("nonordinary file refused")
    return dict(sorted(files.items()))


def manifest(files):
    return {name: {"sha256": digest(body), "bytes": len(body)}
            for name, body in sorted(files.items())}


def readonly_db(path):
    # Only closed synthetic copies: no WAL/journal sidecars are accepted.
    conn = sqlite3.connect(path.absolute().as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        conn.execute("PRAGMA query_only=ON")
        if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise Refused("SQLite integrity check failed")
        return conn
    except Exception:
        conn.close()
        raise


def read_sqlite(path):
    try:
        conn = readonly_db(path)
        try:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if tables != set(TABLE_COLUMNS):
                raise Refused("unsupported ledger tables")
            if conn.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('view','trigger')").fetchone()[0]:
                raise Refused("unsupported ledger view/trigger")
            expected = sqlite3.connect(":memory:")
            try:
                expected.executescript(LEDGER_DDL)
                for table in TABLE_COLUMNS:
                    if conn.execute(f"PRAGMA table_info({table})").fetchall() != expected.execute(f"PRAGMA table_info({table})").fetchall():
                        raise Refused("unsupported ledger columns/constraints")
            finally:
                expected.close()
            meta = dict(conn.execute("SELECT key,val FROM meta"))
            if meta.get("schema_version") != "1":
                raise Refused("unsupported ledger schema version")
            allowed_meta = {"schema_version", "key_order", "migrated_at",
                            "source_json_sha256", "source_json_bytes"}
            allowed_meta.update("owners:" + key for key in DICT_LOGS)
            if set(meta) - allowed_meta:
                raise Refused("unsupported ledger metadata")
            order = decode(meta.get("key_order", "null"))
            if not isinstance(order, list) or not all(isinstance(k, str) for k in order) or len(set(order)) != len(order):
                raise Refused("invalid or missing ledger key order")
            doc = {key: decode(value) for key, value in conn.execute("SELECT key,val FROM doc")}
            nodes = list(conn.execute("SELECT id,ord,val FROM nodes ORDER BY ord"))
            if len({row[1] for row in nodes}) != len(nodes) or "nodes" in doc:
                raise Refused("ambiguous node ordering/storage")
            doc["nodes"] = {key: decode(value) for key, _, value in nodes}
            dict_rows = list(conn.execute("SELECT sect,owner,val FROM log_d ORDER BY seq"))
            list_rows = list(conn.execute("SELECT sect,val FROM log_l ORDER BY seq"))
            if {r[0] for r in dict_rows} - set(DICT_LOGS) or {r[0] for r in list_rows} - set(LIST_LOGS):
                raise Refused("unsupported rowed section")
            for key in DICT_LOGS:
                rows = [r for r in dict_rows if r[0] == key]
                owner_key = "owners:" + key
                if key in doc:
                    if rows or owner_key in meta:
                        raise Refused("ambiguous eager/rowed section")
                    continue
                if key not in order:
                    if rows or owner_key in meta:
                        raise Refused("unaccounted dict-log rows/owners")
                    continue
                owners = decode(meta.get(owner_key, "null"))
                if not isinstance(owners, list) or not all(isinstance(o, str) for o in owners) or len(set(owners)) != len(owners):
                    raise Refused("invalid or missing owner order")
                if {r[1] for r in rows} - set(owners):
                    raise Refused("unaccounted log owner")
                doc[key] = {}
                for owner in owners:
                    values = [decode(r[2]) for r in rows if r[1] == owner]
                    if key == "steer_attempts":
                        entries = {}
                        for row in values:
                            if not isinstance(row, list) or len(row) != 2 or not isinstance(row[0], str) or row[0] in entries:
                                raise Refused("invalid/duplicate keyed log identity")
                            entries[row[0]] = row[1]
                        doc[key][owner] = entries
                    else:
                        doc[key][owner] = values
            for key in LIST_LOGS:
                values = [decode(r[1]) for r in list_rows if r[0] == key]
                if key in doc:
                    if values:
                        raise Refused("ambiguous eager/rowed section")
                elif key in order:
                    doc[key] = values
                elif values:
                    raise Refused("unaccounted list-log rows")
            if set(doc) != set(order):
                raise Refused("unaccounted ledger keys")
            return {key: doc[key] for key in order}
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise Refused("invalid SQLite ledger") from exc


def validate_org(doc, slug):
    if not isinstance(doc, dict) or doc.get("slug") != slug or (type(doc.get("version")) is not int or doc["version"] != 1):
        raise Refused("unsupported org identity/version")
    nodes = doc.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise Refused("missing nodes")
    for key, node in nodes.items():
        if not isinstance(node, dict) or not isinstance(key, str) or not key:
            raise Refused("node identity mismatch")
        if node.get("parent") not in (None, "user") and node.get("parent") not in nodes:
            raise Refused("missing parent")
        seen = {key}
        parent = node.get("parent")
        while parent not in (None, "user"):
            if parent in seen:
                raise Refused("parent cycle")
            seen.add(parent)
            parent = nodes[parent].get("parent")
    for section in ("mail", "mail_log", "delivering", "steered_log", "turn_error_log"):
        for owner, rows in doc.get(section, {}).items():
            if owner not in nodes or not isinstance(rows, list):
                raise Refused("invalid mail/log owner or rows")
    item_ids = []
    for item in doc.get("work_items", []) + doc.get("work_items_archive", []):
        identity = item.get("slug") or item.get("id")
        if not isinstance(identity, str) or identity in item_ids:
            raise Refused("missing/duplicate docket identity")
        item_ids.append(identity)
        owner = item.get("owner", {})
        if owner.get("node") not in nodes:
            raise Refused("invalid docket owner")


def _read_source(source):
    files = plain_tree(source)
    orgs, sidecars, backups = {}, {}, {}
    for name, body in files.items():
        path = Path(name)
        if len(path.parts) == 2 and path.parts[0] == "orgs":
            if name.endswith(".json.premigration"):
                backups[name] = decode(body)
                continue
            if path.suffix not in (".json", ".db"):
                raise Refused("unsupported org file")
            slug = path.stem
            if slug in orgs:
                raise Refused("ambiguous duplicate org sources")
            doc = decode(body) if path.suffix == ".json" else read_sqlite(source / name)
            validate_org(doc, slug)
            orgs[slug] = {"document": doc, "key_order": list(doc),
                          "node_order": list(doc["nodes"])}
        elif name in SIDECAR_DDL:
            sidecars[name] = read_sidecar(source / name, SIDECAR_DDL[name])
        elif name in ("app-settings.json", "desktop-settings.json", "accounts-registry.json"):
            value = decode(body)
            if not isinstance(value, dict):
                raise Refused("invalid settings/registry")
            sidecars[name] = value
        elif len(path.parts) == 4 and path.parts[0] == "transcripts" and path.suffix == ".jsonl":
            if not body.endswith(b"\n"):
                raise Refused("incomplete transcript tail")
            rows = [decode(line) for line in body.splitlines()]
            if not all(isinstance(row, dict) for row in rows):
                raise Refused("invalid transcript row")
            sidecars[name] = rows
        elif len(path.parts) == 4 and path.parts[0] == "content":
            sidecars[name] = {"sha256": digest(body), "bytes": len(body)}
        else:
            raise Refused("unsupported source file: " + name)
    if not orgs:
        raise Refused("no organizations")
    for name in sidecars:
        parts = Path(name).parts
        if parts[0] in ("transcripts", "content"):
            if parts[1] not in orgs or parts[2] not in orgs[parts[1]]["document"]["nodes"]:
                raise Refused("orphan sidecar")
    inventory = {"organizations": len(orgs), "agents": 0, "mail": 0,
                 "docket": 0, "docket_history": 0, "transcript_records": 0,
                 "files": len(files), "bytes": sum(map(len, files.values()))}
    for entry in orgs.values():
        doc = entry["document"]
        inventory["agents"] += len(doc["nodes"])
        inventory["mail"] += sum(len(rows) for key in ("mail", "mail_log", "delivering")
                                  for rows in doc.get(key, {}).values())
        items = doc.get("work_items", []) + doc.get("work_items_archive", [])
        inventory["docket"] += len(items)
        inventory["docket_history"] += sum(len(item.get("history", [])) + len(item.get("scope", [])) for item in items)
    inventory["transcript_jsonl_records"] = sum(len(value) for name, value in sidecars.items() if name.endswith(".jsonl"))
    inventory["transcript_records"] = len(sidecars.get("transcript-records.sqlite3", {}).get("transcript_records", {}).get("rows", []))
    inventory["sidecar_rows"] = {name: {table: len(value["rows"]) for table, value in tables.items()}
                                  for name, tables in sidecars.items() if name in SIDECAR_DDL}
    if manifest(plain_tree(source)) != manifest(files):
        raise Refused("source changed during inventory")
    return {"orgs": orgs, "sidecars": sidecars, "legacy_backups": backups,
            "files": {name: base64.b64encode(body).decode("ascii") for name, body in files.items()},
            "inventory": inventory}


def read_sidecar(path, ddl):
    """Preserve every table/column/cell; no claim of native field mapping."""
    expected = sqlite3.connect(":memory:")
    conn = None
    try:
        expected.executescript(ddl)
        conn = readonly_db(path)
        def shapes(db):
            names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            return {name: db.execute('PRAGMA table_info("' + name.replace('"', '""') + '")').fetchall() for name in names}
        if shapes(conn) != shapes(expected):
            raise Refused("unsupported sidecar schema")
        if conn.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('view','trigger')").fetchone()[0]:
            raise Refused("unsupported sidecar view/trigger")
        out = {}
        for name, columns in shapes(expected).items():
            # Names come from the fixed schema, not unchecked SQL identifiers.
            rows = conn.execute(f'SELECT * FROM "{name}"').fetchall()
            def cell(value):
                if isinstance(value, bytes):
                    return {"sqlite_blob_base64": base64.b64encode(value).decode("ascii")}
                return value
            values = [[cell(value) for value in row] for row in rows]
            out[name] = {"columns": [column[1] for column in columns], "rows": sorted(values, key=encode)}
        return out
    except sqlite3.Error as exc:
        raise Refused("invalid SQLite sidecar") from exc
    finally:
        expected.close()
        if conn is not None:
            conn.close()


def read_source(source):
    try:
        return _read_source(source)
    except (KeyError, TypeError, AttributeError, RecursionError) as exc:
        raise Refused("malformed legacy record") from exc
