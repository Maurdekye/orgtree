"""Bounded offline analysis of one explicitly supplied schema2, schema3 or schema4 census snapshot.

This module imports no backend code and opens no endpoint or capture control.

Schema 2 is reported exactly as it always was (report_schema v1). Schema 3 adds
the primary store's observed SQLite contacts (`db`); schema 4 adds the listed
sidecar stores' contacts under `db.secondary`, by closed label. Both are
validated against closed field sets and the invariants their producer actually
guarantees, and are reported as report_schema v2 with a `contacts` section.
Any other schema version is refused: a snapshot this module has not been taught
is never read as one it has.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import stat
import sys


MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 16384
MAX_STRING = 4096
MAX_DEPTH = 12
MAX_NODES = 1_000_000
MAX_INTEGER = 2**53 - 1
COUNTERS = (
    "observed", "skipped_disabled", "skipped_self", "recorded", "evicted",
    "rejected", "dropped_stale_window", "dropped_capture_off", "nonterminal",
    "no_response_start", "unclassified_tool", "unclassified_action",
    "unclassified_scope", "unclassified_method",
)
VOCABULARY = {
    "rw": ["read", "write", "mixed", "unknown"],
    "scope": ["self", "other_agent", "subtree", "org", "resource", "external",
              "none", "unknown"],
    "scope_src": ["declared", "table", "route_shape", "unknown"],
    "outcome": ["ok", "client_error", "auth_denied", "not_found", "server_error", "unknown"],
    "method": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "other"],
    "nonterminal_reason": ["managed_yield"],
}
PROFILE_NUMBERS = (
    "load_snapshot_ms", "tree_ms", "annotate_ms", "chat_read_ms", "history_work_ms",
    "org_load_ms", "org_save_ms", "mutate_ms", "org_load_cpu_ms", "org_save_cpu_ms",
    "mutate_cpu_ms", "chat_read_cpu_ms", "history_work_cpu_ms", "lock_wait_ms",
    "lock_hold_ms", "lock_acquires", "lock_contended", "lock_failed", "lock_max_depth",
    "lock_queue_ahead_max", "unattributed_ms",
)
MEASUREMENTS = ("handler_ms", "total_ms", "bytes", "inflight", "targets") + PROFILE_NUMBERS
IDENTITY = ("op", "method", "route", "tool", "action", "action_of", "sub")
ROW_REQUIRED = {"v", "unit", "seq", "t_ms", "method", "route", "op", "rw", "scope",
                "scope_src", "outcome", "terminal", "status"}
ROW_OPTIONAL = set(MEASUREMENTS) | {"tool", "action", "action_of", "sub", "targets_self",
                                  "diagnostic", "no_response_start", "nonterminal_reason"}
TOP_FIELDS = {"schema_version", "instance", "enabled", "capacity", "window_generation",
              "window_started_at", "window_ms", "counters", "evicted_derived", "served",
              "truncated_by_limit", "oldest_seq", "newest_seq", "vocabulary", "provenance",
              "limits", "records"}
LIMITS = [
    "Offline schema2 HTTP attempt evidence only; this is not a complete capture or P02 qualification.",
    "No logical-operation denominator, continuation linkage, or closure/flush evidence is available.",
    "HTTP status and terminal=true do not prove successful logical completion; managed yields remain nonterminal.",
    "t_ms is a completion offset from the supplied window origin. Sequence is ring append order; offsets may decrease. No start timestamps are inferred.",
    "No actual database contact/conflict set or locality percentage is derived. Scope classifications are declarations or source hints, not observed contacts.",
    "Non-HTTP work and later managed completions are unobserved. Snapshot counters do not establish capture completeness.",
    "Statistics use only served attempts with known measurements. Missing and null values are excluded, never replaced with zero.",
    "Cumulative durations sum overlapping attempts; they are not elapsed wall time. CPU, stages and lock durations are not added to handler/total time.",
    "Optional lock fields may be absent at this landed stage; absence does not mean no contention. bytes describes HTTP response size.",
]

# ---- schema 3: the primary store's observed SQLite contacts (P02-A3) --------
# Closed sets copied from the producer (engine/backend/orgtree/census_contacts.py
# and census.py at P02-A3). They are restated here, not imported: this module
# never imports backend code. The producer-to-report round trip in
# tests/test_operation_census_report.py fails if the two ever disagree.
SCHEMAS = (2, 3, 4)
DB_STORES = ["sqlite", "json", "unknown"]
DB_KINDS = ["select", "with", "insert", "update", "delete", "replace", "begin",
            "commit", "rollback", "savepoint", "release", "pragma", "ddl",
            "maintenance", "attach", "other"]
DB_FIELDS = ("connects", "connect_failed", "checkouts", "statements",
             "statement_failed", "statement_busy", "engine_steps", "hidden_steps",
             "linked_threads")
DB_COUNTERS = ("db_unbound", "db_unattributed", "db_late", "db_hidden_unattributed",
               "db_self_recursion", "db_observe_failed")
VOCABULARY_V3 = {**VOCABULARY, "db_store": DB_STORES, "db_kind": DB_KINDS}
MEASURES_V3 = "primary_sqlite_store_only"
# ---- schema 4: the listed sidecar stores (P02-A4b), census_contacts.SIDECAR_STORES
DB_SECONDARY_STORES = ["transcript_records", "reply_events", "chat_window_index",
                       "tool_waits", "file_deliveries"]
VOCABULARY_V4 = {**VOCABULARY_V3, "db_secondary_store": DB_SECONDARY_STORES}
MEASURES_V4 = "primary_and_listed_sidecar_sqlite_stores"
COVERAGE_FIELDS = {"primary_store", "instrumented", "uninstrumented", "other_processes",
                   "complete", "kinds", "fields"}
# Coverage entries name source files and symbols in this repository, never a
# machine path: a relative forward-slash .py path and a dotted identifier.
SOURCE_PATH = re.compile(r"(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.py")
SOURCE_SYMBOL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
PROCESS_NAME = re.compile(r"[a-z0-9_-]+")
LIMITS_V2 = [
    "Offline schema3 HTTP attempt evidence only; this is not a complete capture or P02 qualification.",
    "No logical-operation denominator, continuation linkage, or closure/flush evidence is available.",
    "HTTP status and terminal=true do not prove successful logical completion; managed yields remain nonterminal.",
    "t_ms is a completion offset from the supplied window origin. Sequence is ring append order; offsets may decrease. No start timestamps are inferred.",
    "Contact sums cover ONLY connections the primary SQLite store opened (snapshot contact_coverage); every uninstrumented path and other process is absent. They are not complete storage coverage, a conflict set, rows examined, physical IO, lock wait or a locality percentage, and none is derived.",
    "A served attempt without a db block was not observed (it began before capture was on); it is never counted as zero contacts. Process db_* counters are evidence joined to no record and are not attributed to any operation.",
    "Contact counts are attempt-level API calls (statements) and SQLite engine steps; the two are not expected to be equal, and neither is a duration.",
    "Non-HTTP work and later managed completions are unobserved; contacts after a managed yield are in db_late, not in any record. Snapshot counters do not establish capture completeness.",
    "Statistics use only served attempts with known measurements. Missing and null values are excluded, never replaced with zero.",
    "Cumulative durations sum overlapping attempts; they are not elapsed wall time. CPU, stages and lock durations are not added to handler/total time.",
    "Optional lock fields may be absent; absence does not mean no contention. bytes describes HTTP response size.",
]
LIMITS_V2_SIDECARS = [
    ("Contact sums cover ONLY connections the primary SQLite store opened and those of the listed sidecar stores (snapshot contact_coverage.secondary_stores), kept apart by label; every uninstrumented path and other process is absent. They are not complete storage coverage, a conflict set, rows examined, physical IO, lock wait or a locality percentage, and none is derived."
     if line.startswith("Contact sums cover ONLY") else line.replace("Offline schema3", "Offline schema4"))
    for line in LIMITS_V2
] + ["A sidecar label appears on an attempt only when that sidecar was contacted; an absent label is no observed contact, never a zero row. Sidecar connections are not pooled, so their checkouts and linked_threads are zero."]


class ReportError(ValueError):
    """An input cannot be reported safely under its schema's contract."""


def require(condition, message):
    if not condition:
        raise ReportError(message)


def number(value, name, *, integer=False, minimum=0, nullable=False):
    if value is None and nullable:
        return
    require(type(value) in (int, float), f"{name}: expected a finite non-boolean number")
    require(abs(value) <= MAX_INTEGER and math.isfinite(value), f"{name}: nonfinite or unbounded number")
    require(minimum is None or value >= minimum, f"{name}: negative number")
    if integer:
        require(type(value) is int, f"{name}: expected an integer")


def text_value(value, name):
    require(isinstance(value, str) and 0 < len(value) <= MAX_STRING, f"{name}: expected bounded nonempty text")
    require(not any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in value), f"{name}: control or surrogate character")


def shape(value, required, optional, name):
    require(type(value) is dict, f"{name}: expected an object")
    require(required <= value.keys(), f"{name}: missing required fields")
    require(value.keys() <= required | optional, f"{name}: unsupported fields")


def bounded_tree(value):
    pending = [(value, 0)]
    nodes = 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        require(nodes <= MAX_NODES and depth <= MAX_DEPTH, "input exceeds structural bounds")
        if type(item) is dict:
            require(all(type(k) is str and len(k) <= MAX_STRING for k in item), "invalid object key")
            pending.extend((v, depth + 1) for v in item.values())
        elif type(item) is list:
            require(len(item) <= MAX_RECORDS, "array exceeds record bound")
            pending.extend((v, depth + 1) for v in item)
        elif type(item) in (int, float):
            number(item, "input", minimum=None)
        elif type(item) is str:
            require(len(item) <= MAX_STRING, "string exceeds bound")
        else:
            require(item is None or type(item) is bool, "unsupported value type")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON object key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ReportError("nonfinite JSON literal")


def _local_file(path):
    raw = os.fspath(path)
    require(raw != "-" and not raw.startswith(("\\\\", "//")), "supply one local regular file, not stdin or a network path")
    require("://" not in raw, "URLs and live endpoints are not supported")
    path = Path(raw).absolute()
    # Refuse device paths, alternate streams, remote drives, and indirection
    # before opening the file. Inspect ancestors without following links.
    require(":" not in str(path)[len(path.drive):], "device/stream paths are not supported")
    if os.name == "nt":
        import ctypes
        require(ctypes.windll.kernel32.GetDriveTypeW(path.anchor) == 3, "input must be on a local fixed drive")
    for part in reversed((path, *path.parents)):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
                "links and reparse points are not supported")
    require(stat.S_ISREG(info.st_mode), "input must be a regular file")
    require(info.st_size <= MAX_INPUT_BYTES, "input exceeds byte bound")
    return path


def read_snapshot(path):
    """Read a single fixed-size local file; never import or activate capture."""
    path = _local_file(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "input must remain a regular file")
        raw = stream.read(MAX_INPUT_BYTES + 1)
    require(len(raw) <= MAX_INPUT_BYTES, "input exceeds byte bound")
    try:
        snapshot = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_unique_object,
                              parse_constant=_invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise ReportError("invalid bounded UTF-8 JSON snapshot") from exc
    return snapshot, {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _http_outcome(status):
    if status in (401, 403):
        return "auth_denied"
    if status == 404:
        return "not_found"
    if 200 <= status < 400:
        return "ok"
    if 400 <= status < 500:
        return "client_error"
    return "server_error" if status >= 500 else "unknown"


def schema_of(snapshot):
    """The snapshot's schema version: exactly the int 2 or 3, nothing else.

    Dispatch happens before any other field is read, so a field set is only
    ever judged against the schema that owns it. `type(...) is int` refuses
    bool, float and string spellings of a supported number."""
    require(type(snapshot) is dict, "snapshot: expected an object")
    version = snapshot.get("schema_version")
    require(type(version) is int and version in SCHEMAS,
            "unsupported schema; expected schema2, schema3 or schema4")
    return version


def validate_db_block(db, name="db", *, sidecars=False):
    """One attempt's contact evidence, against the producer's closed sets.

    Only invariants the producer guarantees are enforced. `statements` and its
    kind (and whether it failed) are credited in ONE atomic tally update, so
    the kind sums are exact. `statement_failed`, `statement_busy` and
    `connect_failed` are separate later updates that a seal can fall between,
    so they are only bounded. Engine steps, hidden steps, checkouts and linked
    threads come from independent sources and have no relation to statements."""
    shape(db, {"store", "kinds", "kind_failed", *DB_FIELDS}, {"secondary"} if sidecars else set(), name)
    require(db["store"] in DB_STORES, f"{name}.store: not in db_store vocabulary")
    validate_contact_counts(db, name)
    if "secondary" in db:
        # Schema 4: present only when a sidecar was contacted, keyed only by
        # the closed labels, each block the same counts without `store`, and
        # each carrying at least one contact (an untouched label is absent).
        side = db["secondary"]
        require(type(side) is dict and side, f"{name}.secondary: expected a nonempty object")
        for label, block in side.items():
            require(label in DB_SECONDARY_STORES, f"{name}.secondary: label not in db_secondary_store vocabulary")
            shape(block, {"kinds", "kind_failed", *DB_FIELDS}, set(), f"{name}.secondary")
            validate_contact_counts(block, f"{name}.secondary")
            require(any(block[field] for field in DB_FIELDS), f"{name}.secondary: a label without contact evidence")


def validate_contact_counts(db, name):
    for field in DB_FIELDS:
        number(db[field], f"{name}.{field}", integer=True)
    for group in ("kinds", "kind_failed"):
        require(type(db[group]) is dict, f"{name}.{group}: expected an object")
        for kind, count in db[group].items():
            require(kind in DB_KINDS, f"{name}.{group}: kind not in db_kind vocabulary")
            number(count, f"{name}.{group}", integer=True, minimum=1)
    require(sum(db["kinds"].values()) == db["statements"], f"{name}: kinds do not sum to statements")
    require(all(count <= db["kinds"].get(kind, 0) for kind, count in db["kind_failed"].items()),
            f"{name}: more failures than attempts for a kind")
    require(db["statement_failed"] <= sum(db["kind_failed"].values()), f"{name}: statement_failed exceeds failed kinds")
    require(db["statement_busy"] <= db["statement_failed"], f"{name}: statement_busy exceeds statement_failed")
    require(db["connect_failed"] <= db["connects"], f"{name}: connect_failed exceeds connects")


def validate_contact_coverage(coverage, sidecars=False):
    shape(coverage, COVERAGE_FIELDS | ({"secondary_stores"} if sidecars else set()), set(), "contact_coverage")
    require(coverage["complete"] is False, "contact_coverage must not claim complete coverage")
    require(coverage["primary_store"] in DB_STORES, "contact_coverage.primary_store: not in db_store vocabulary")
    require(coverage["kinds"] == DB_KINDS, "contact_coverage.kinds disagrees with db_kind")
    require(coverage["fields"] == list(DB_FIELDS), "contact_coverage.fields disagrees with db fields")
    for group in ("instrumented", "uninstrumented", "other_processes") + (("secondary_stores",) if sidecars else ()):
        entries = coverage[group]
        require(type(entries) is list, f"contact_coverage.{group}: expected a list")
        extra = {"process"} if group == "other_processes" else {"label"} if group == "secondary_stores" else set()
        for entry in entries:
            shape(entry, {"path", "symbol"} | extra, set(), f"contact_coverage.{group}")
            for field, pattern in (("path", SOURCE_PATH), ("symbol", SOURCE_SYMBOL), ("process", PROCESS_NAME)):
                if field in entry:
                    text_value(entry[field], f"contact_coverage.{group}.{field}")
                    require(pattern.fullmatch(entry[field]), f"contact_coverage.{group}.{field}: not a repository source name")
            if "label" in entry:
                require(entry["label"] in DB_SECONDARY_STORES, "contact_coverage.secondary_stores: label not in db_secondary_store vocabulary")
    require(coverage["instrumented"], "contact_coverage.instrumented is empty")
    if sidecars:
        require(coverage["secondary_stores"], "contact_coverage.secondary_stores is empty")


def validate_snapshot(snapshot):
    bounded_tree(snapshot)
    version = schema_of(snapshot)
    v3 = version >= 3      # the primary store's db contact block and its accounting
    v4 = version == 4      # plus the listed sidecar stores
    shape(snapshot, TOP_FIELDS | ({"contact_coverage"} if v3 else set()), {"ignored_arguments"}, "snapshot")
    number(snapshot["schema_version"], "schema_version", integer=True)
    text_value(snapshot["instance"], "instance")
    require(type(snapshot["enabled"]) is bool, "enabled must be boolean")
    number(snapshot["window_generation"], "window_generation", integer=True, minimum=1)
    started = snapshot["window_started_at"]
    text_value(started, "window_started_at")
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", started), "invalid UTC window origin")
    try:
        datetime.datetime.strptime(started, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise ReportError("invalid UTC window origin") from exc
    number(snapshot["window_ms"], "window_ms")
    for field in ("capacity", "served", "truncated_by_limit", "evicted_derived"):
        number(snapshot[field], field, integer=True)
    require(64 <= snapshot["capacity"] <= 262144, "capacity outside schema2 bounds")
    require(snapshot["vocabulary"] == {2: VOCABULARY, 3: VOCABULARY_V3, 4: VOCABULARY_V4}[version], f"incompatible schema{version} vocabulary")
    for field in ("limits", "ignored_arguments"):
        if field in snapshot:
            require(type(snapshot[field]) is list, f"{field}: expected a list")
            for entry in snapshot[field]:
                text_value(entry, field)
    require(snapshot["limits"], "source coverage limits are missing")
    counters = snapshot["counters"]
    counter_names = COUNTERS + (DB_COUNTERS if v3 else ())
    shape(counters, set(counter_names), set(), "counters")
    for name in counter_names:
        number(counters[name], name, integer=True)
    rows = snapshot["records"]
    require(type(rows) is list and len(rows) <= MAX_RECORDS, "records exceed bounded list")
    require(snapshot["served"] == len(rows), "served does not match records")
    retained = snapshot["served"] + snapshot["truncated_by_limit"]
    recorded = counters["recorded"]
    require(retained == min(recorded, snapshot["capacity"]), "incompatible ring retention")
    require(recorded == retained + counters["evicted"], "incompatible recorded/retained/evicted accounting")
    require(counters["evicted"] == snapshot["evicted_derived"], "eviction derivations disagree")
    require(recorded + counters["skipped_disabled"] + counters["dropped_capture_off"] <= counters["observed"],
            "recorded/disabled/capture-off exceeds observed")
    for name in ("nonterminal", "no_response_start", "unclassified_tool", "unclassified_action", "unclassified_scope", "unclassified_method"):
        require(counters[name] <= recorded, f"{name} exceeds recorded")
    expected_first = recorded - len(rows) + 1
    for index, row in enumerate(rows):
        shape(row, ROW_REQUIRED, ROW_OPTIONAL | ({"db"} if v3 else set()), "record")
        number(row["v"], "record.v", integer=True)
        require(row["v"] == version and row["unit"] == "attempt", "incompatible record schema/unit")
        if "db" in row:
            validate_db_block(row["db"], "record.db", sidecars=v4)
        number(row["seq"], "seq", integer=True, minimum=1)
        require(row["seq"] == expected_first + index, "records must be the contiguous served sequence tail in order")
        number(row["t_ms"], "t_ms")
        require(row["t_ms"] <= snapshot["window_ms"], "completion offset outside snapshot window")
        for field in ("method", "rw", "scope", "scope_src", "outcome"):
            require(row[field] in VOCABULARY[field], f"invalid {field} vocabulary")
        for field in ("op", "route", "tool", "action", "action_of"):
            if field in row:
                text_value(row[field], field)
        if "sub" in row:
            require(type(row["sub"]) is dict and row["sub"], "sub must be a nonempty enum map")
            for key, value in row["sub"].items():
                text_value(key, "sub key")
                text_value(value, "sub value")
        require(("action" in row) == ("action_of" in row), "action/action_of identity mismatch")
        require("tool" in row or not ({"action", "sub"} & row.keys()), "tool identity missing")
        op = ("tool:" + row["tool"] + (":" + row["action"] if "action" in row else "")) if "tool" in row else row["method"] + " " + row["route"]
        require(row["op"] == op, "op disagrees with available operation identity")
        for field in ("terminal", "diagnostic", "no_response_start", "targets_self"):
            if field in row:
                require(type(row[field]) is bool, f"{field}: expected boolean")
        number(row["status"], "status", integer=True)
        for field in MEASUREMENTS:
            if field in row:
                number(row[field], field, nullable=True,
                       integer=field in ("bytes", "inflight", "targets"),
                       minimum=None if field == "unattributed_ms" else 0)
        if not row["terminal"]:
            require(row.get("nonterminal_reason") == "managed_yield" and row["outcome"] == "unknown",
                    "nonterminal managed yield must have unknown outcome")
        else:
            require("nonterminal_reason" not in row, "terminal row carries nonterminal reason")
            require(row["outcome"] == _http_outcome(row["status"]), "outcome disagrees with HTTP evidence")
        if row.get("no_response_start"):
            require(row.get("handler_ms") is None and row.get("unattributed_ms") is None,
                    "no-response-start cannot have handler or unattributed duration")
        self_read = row.get("tool") == "orgtree_operation_census" or (row["route"] == "/api/diagnostics/operation-census" and row["method"] in ("GET", "HEAD", "OPTIONS"))
        require(not self_read, "schema2 excludes census self-reads from records")
        diagnostic = row["route"].startswith(("/api/diagnostics", "/api/desktop/profile-timing"))
        require(bool(row.get("diagnostic")) == diagnostic, "diagnostic flag disagrees with route")
    for field, value in (("oldest_seq", rows[0]["seq"] if rows else None),
                         ("newest_seq", rows[-1]["seq"] if rows else None)):
        number(snapshot[field], field, integer=True, minimum=1, nullable=True)
        require(snapshot[field] == value, f"{field} disagrees with served records")
    for name, predicate in (
        ("nonterminal", lambda r: not r["terminal"]),
        ("no_response_start", lambda r: r.get("no_response_start", False)),
        ("unclassified_scope", lambda r: r["scope"] == "unknown"),
        ("unclassified_method", lambda r: r["method"] == "other"),
        ("unclassified_action", lambda r: "tool" in r and "action" not in r),
    ):
        count = sum(bool(predicate(r)) for r in rows)
        require(count <= counters[name] <= count + recorded - len(rows), f"{name} incompatible with served rows")
    unobserved = sum("db" not in r for r in rows)
    if v3:
        # `db_unbound` is bumped exactly once per RECORDED attempt that carries
        # no db block, so served rows bound it the same way they bound the
        # classification counters above. The other db_* counters are read under
        # the observer's own lock and are tied to no record: no bound exists.
        require(unobserved <= counters["db_unbound"] <= unobserved + recorded - len(rows),
                "db_unbound incompatible with served rows")
        validate_contact_coverage(snapshot["contact_coverage"], v4)
    provenance = snapshot["provenance"]
    provenance_fields = {"scope_src_counts", "declared_coverage", "measures_storage_contacts", "unit", "note"}
    if v3:
        shape(provenance, provenance_fields | {"rows_with_contact_evidence", "rows_without_contact_evidence"}, set(), "provenance")
        require(provenance["unit"] == "attempt" and provenance["measures_storage_contacts"] == (MEASURES_V4 if v4 else MEASURES_V3),
                "provenance must disclose attempt unit and exactly which stores' contacts are measured")
        for field in ("rows_with_contact_evidence", "rows_without_contact_evidence"):
            number(provenance[field], field, integer=True)
        require((provenance["rows_with_contact_evidence"], provenance["rows_without_contact_evidence"])
                == (len(rows) - unobserved, unobserved), "provenance does not account for contact evidence")
    else:
        shape(provenance, provenance_fields, set(), "provenance")
        require(provenance["unit"] == "attempt" and provenance["measures_storage_contacts"] is False,
                "provenance must disclose attempt unit and no storage contacts")
    text_value(provenance["note"], "provenance.note")
    counts = {src: sum(row["scope_src"] == src for row in rows) for src in VOCABULARY["scope_src"]}
    shape(provenance["scope_src_counts"], set(counts), set(), "scope_src_counts")
    for key, value in provenance["scope_src_counts"].items():
        number(value, key, integer=True)
    require(provenance["scope_src_counts"] == counts, "provenance does not account for served rows")
    number(provenance["declared_coverage"], "declared_coverage")
    require(provenance["declared_coverage"] == (round(counts["declared"] / len(rows), 6) if rows else 0.0),
            "declared coverage differs from served declarations")


def statistics(rows, metric):
    values = sorted(row[metric] for row in rows if row.get(metric) is not None)
    n = len(values)
    return {"count": len(rows), "known": n, "missing": len(rows) - n,
            **{f"p{p}": values[(p * n + 99) // 100 - 1] if n else None for p in (50, 90, 99)},
            "max": values[-1] if n else None, "cumulative": math.fsum(values) if n else None}


def build_report(snapshot, source=None):
    validate_snapshot(snapshot)
    rows, counters = snapshot["records"], snapshot["counters"]
    groups = collections.defaultdict(list)
    identities = {}
    for row in rows:
        identity = {field: row.get(field) for field in IDENTITY}
        identity["diagnostic"] = row.get("diagnostic", False)
        key = json.dumps(identity, sort_keys=True, ensure_ascii=True)
        groups[key].append(row)
        identities[key] = identity
    ranks = {}
    for metric in ("handler_ms", "total_ms"):
        ranked = [{"identity": identities[key], **statistics(group, metric)} for key, group in groups.items()]
        ranked.sort(key=lambda item: (item["cumulative"] is None, -(item["cumulative"] or 0),
                                      json.dumps(item["identity"], sort_keys=True)))
        ranks[metric] = [{"rank": i + 1, **item} for i, item in enumerate(ranked)]
    accounted = sum(counters[key] for key in ("recorded", "skipped_disabled", "skipped_self", "rejected", "dropped_capture_off"))
    version = snapshot["schema_version"]
    v3 = version >= 3
    report = {
        "report_schema": "orgtree.operation-census-report/" + ("v2" if v3 else "v1"), "unit": "attempt",
        "source": source or {"kind": "supplied_object"},
        "snapshot": {k: v for k, v in snapshot.items() if k != "records"},
        "coverage": {
            "assessment": "incomplete; complete capture is not established",
            "observed_attempts": counters["observed"], "recorded_attempts": counters["recorded"],
            "retained_in_ring": snapshot["served"] + snapshot["truncated_by_limit"],
            "served_attempts": len(rows), "evicted_attempts": counters["evicted"],
            "retained_not_served": snapshot["truncated_by_limit"],
            "observed_without_served_record": counters["observed"] - len(rows),
            "observed_minus_accounted": counters["observed"] - accounted,
            "accounting_note": "Residual excludes dropped_stale_window: it can count prior-window attempts after reset. Positive residual can include pending observation builds; negative residual can reflect skipped_self/rejected counted across reset. Neither is a logical denominator or an exact pending count.",
            "measurement_coverage": {field: {"known": sum(r.get(field) is not None for r in rows),
                                              "missing": sum(r.get(field) is None for r in rows)} for field in MEASUREMENTS},
            "dimensions": {field: dict(sorted(collections.Counter(r[field] for r in rows).items()))
                           for field in ("method", "rw", "scope", "scope_src", "outcome")},
        },
        "percentile_definition": "Nearest rank: sorted known values x[ceil(p*n)-1], p in {0.50,0.90,0.99}; null when n=0. No interpolation or zero substitution.",
        "ranking_definition": "Descending cumulative known duration per available operation identity, diagnostics split; unknown totals last; canonical identity breaks ties. Both rankings include nonterminal and no-response-start attempts where a duration is known.",
        "ranks": ranks,
        "special_records": {"diagnostic": [r["seq"] for r in rows if r.get("diagnostic")],
                            "nonterminal": [r["seq"] for r in rows if not r["terminal"]],
                            "no_response_start": [r["seq"] for r in rows if r.get("no_response_start")]},
        "timeline": rows,
        "limits": {2: LIMITS, 3: LIMITS_V2, 4: LIMITS_V2_SIDECARS}[version],
    }
    if v3:
        report["contacts"] = contact_summary(snapshot, groups, identities)
    return report


def _contact_totals(dbs):
    totals = {field: sum(db[field] for db in dbs) for field in DB_FIELDS}
    for group in ("kinds", "kind_failed"):
        summed = collections.Counter()
        for db in dbs:
            summed.update(db[group])
        totals[group] = {kind: summed[kind] for kind in DB_KINDS if summed[kind]}
    return totals


def contact_summary(snapshot, groups, identities):
    """Sums of observed primary-store contact counts, by operation identity.

    Only rows WITH a db block are summed; a row without one was not observed
    and is counted as such, never as zero. Nothing here is divided by
    anything: no locality, share or rate is derived."""
    rows = snapshot["records"]
    v4 = snapshot["schema_version"] == 4
    by_operation = []
    for key, group in groups.items():
        dbs = [row["db"] for row in group if "db" in row]
        item = {"identity": identities[key], "attempts": len(group),
                "with_contact_evidence": len(dbs),
                "without_contact_evidence": len(group) - len(dbs),
                **_contact_totals(dbs)}
        if v4:
            item["secondary"] = _sidecar_totals(dbs)
        by_operation.append(item)
    by_operation.sort(key=lambda item: (-item["statements"], -item["with_contact_evidence"],
                                        json.dumps(item["identity"], sort_keys=True)))
    observed = [row["db"] for row in rows if "db" in row]
    summary = {
        "measures": snapshot["provenance"]["measures_storage_contacts"],
        "complete": False,
        "definition": "Sums of per-attempt primary-store SQLite contact counts over served attempts that carry a db block. statements are API-level attempts; engine_steps are statements SQLite began to execute. Rows without a db block are listed, not zero-filled. No locality, share, rate, rows, IO or duration is derived.",
        "served_attempts": len(rows),
        "with_contact_evidence": len(observed),
        "without_contact_evidence": len(rows) - len(observed),
        "without_contact_evidence_seqs": [row["seq"] for row in rows if "db" not in row],
        "totals": _contact_totals(observed),
        "by_operation": [{"rank": index + 1, **item} for index, item in enumerate(by_operation)],
        "process_counters": {name: snapshot["counters"][name] for name in DB_COUNTERS},
        "process_counters_note": "Process-wide contact evidence joined to no record (db_unattributed, db_late, db_hidden_unattributed) or refused by the observer (db_self_recursion, db_observe_failed); db_unbound counts recorded attempts that began before capture. None is attributed to an operation here.",
    }
    if v4:
        # The sidecars, kept apart from the primary store and from each other:
        # per label over all served attempts (and per operation above). The
        # primary counts are unchanged by any of this.
        summary["definition"] = "Sums of per-attempt SQLite contact counts over served attempts that carry a db block: the primary store in the top-level counts, each listed sidecar under secondary by label. statements are API-level attempts; engine_steps are statements SQLite began to execute. Rows without a db block are listed, not zero-filled; a sidecar label is absent where it was not contacted. No locality, share, rate, rows, IO or duration is derived."
        summary["secondary_totals"] = _sidecar_totals(observed)
        summary["secondary_attempts"] = {label: sum(label in db.get("secondary", {}) for db in observed)
                                         for label in DB_SECONDARY_STORES}
    return summary


def _sidecar_totals(dbs):
    """Per-label sums; a label no attempt contacted is absent, not zero."""
    totals = {}
    for label in DB_SECONDARY_STORES:
        blocks = [db["secondary"][label] for db in dbs if label in db.get("secondary", {})]
        if blocks:
            totals[label] = _contact_totals(blocks)
    return totals


def _cell(value):
    if value is None:
        return "missing"
    if type(value) is bool:
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=True, sort_keys=True)
    return html.escape(str(value)).replace("|", "&#124;").replace("`", "&#96;").replace("\n", "&#10;").replace("\r", "&#13;")


def render_markdown(report):
    lines = ["# Offline census attempt report", "", "**Coverage: incomplete; complete capture is not established.**", ""]
    def table(headers, rows):
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("| " + " | ".join("---" for _ in headers) + " |")
        lines.extend("| " + " | ".join(_cell(value) for value in row) + " |" for row in rows)
        lines.append("")
    table(["Source / snapshot", "Value"], [("source", report["source"])] +
          [(k, v) for k, v in report["snapshot"].items() if k not in ("counters", "provenance", "limits", "vocabulary", "contact_coverage")])
    lines.extend(["## Limits", ""] + ["- " + _cell(value) for value in report["limits"]] + [""])
    lines.extend(["### Source limits (preserved)", ""] + ["- " + _cell(v) for v in report["snapshot"]["limits"]] + [""])
    lines.extend(["## Snapshot counters", ""])
    table(["Counter", "Value"], report["snapshot"]["counters"].items())
    lines.extend(["## Coverage and missing measurements", ""])
    table(["Coverage", "Value"], [(k, v) for k, v in report["coverage"].items() if k not in ("measurement_coverage", "dimensions")])
    table(["Measurement", "Known", "Missing"], [(k, v["known"], v["missing"]) for k, v in report["coverage"]["measurement_coverage"].items()])
    table(["Dimension", "Served counts"], report["coverage"]["dimensions"].items())
    table(["Source provenance", "Value"], report["snapshot"]["provenance"].items())
    if "contacts" in report:
        contacts = report["contacts"]
        sidecars = "secondary_totals" in contacts
        lines.extend(["## Observed storage contacts (" + ("primary SQLite store and listed sidecars" if sidecars else "primary SQLite store only") + ")", "",
                      "**Contact coverage: incomplete; " + _cell(contacts["measures"]) + ".**", "",
                      _cell(contacts["definition"]), ""])
        table(["Contacts", "Value"], [(k, contacts[k]) for k in ("served_attempts", "with_contact_evidence", "without_contact_evidence", "without_contact_evidence_seqs")] +
              [("total " + k, v) for k, v in contacts["totals"].items()])
        table(["Rank", "Operation identity", "Attempts", "With db", "Without db", *DB_FIELDS, "kinds", "kind_failed"],
              [(row["rank"], row["identity"], row["attempts"], row["with_contact_evidence"], row["without_contact_evidence"],
                *(row[k] for k in DB_FIELDS), row["kinds"], row["kind_failed"]) for row in contacts["by_operation"]])
        if sidecars:
            lines.extend(["### Sidecar stores (kept apart from the primary store)", ""])
            table(["Sidecar", "Attempts contacting it", *DB_FIELDS, "kinds", "kind_failed"],
                  [(label, contacts["secondary_attempts"][label], *(totals[k] for k in DB_FIELDS), totals["kinds"], totals["kind_failed"])
                   for label, totals in contacts["secondary_totals"].items()])
            table(["Rank", "Operation identity", "Sidecar", *DB_FIELDS, "kinds", "kind_failed"],
                  [(row["rank"], row["identity"], label, *(totals[k] for k in DB_FIELDS), totals["kinds"], totals["kind_failed"])
                   for row in contacts["by_operation"] for label, totals in row["secondary"].items()])
        lines.extend([_cell(contacts["process_counters_note"]), ""])
        table(["Process contact counter", "Value"], contacts["process_counters"].items())
        coverage = report["snapshot"]["contact_coverage"]
        table(["Contact coverage", "Path", "Symbol"],
              [(group, entry["path"], entry["symbol"]) for group in ("instrumented", "uninstrumented", "other_processes") for entry in coverage[group]] +
              [("secondary_stores:" + entry["label"], entry["path"], entry["symbol"]) for entry in coverage.get("secondary_stores", [])])
    lines.extend(["## Duration ranks", "", report["percentile_definition"], "", report["ranking_definition"], ""])
    for metric, ranks in report["ranks"].items():
        lines.extend(["### " + metric + " (milliseconds)", ""])
        table(["Rank", "Operation identity", "Count", "Known", "Missing", "p50", "p90", "p99", "Max", "Cumulative"],
              [(row["rank"], row["identity"], *(row[k] for k in ("count", "known", "missing", "p50", "p90", "p99", "max", "cumulative"))) for row in ranks])
    lines.extend(["## Special records", "", "Sequence references into the timeline; categories may overlap.", ""])
    table(["Category", "Sequences"], report["special_records"].items())
    lines.extend(["## Completion-offset timeline", "", "Original append sequence order; t_ms is not a start timestamp.", ""])
    table(["Seq", "t_ms", "Operation", "HTTP status", "Outcome", "Terminal", "Handler ms", "Total ms", "Flags"],
          [(row["seq"], row["t_ms"], row["op"], row["status"], row["outcome"], row["terminal"],
            row.get("handler_ms"), row.get("total_ms"),
            [name for name in ("diagnostic", "no_response_start") if row.get(name)] +
            ([row["nonterminal_reason"]] if not row["terminal"] else [])) for row in report["timeline"]])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bounded offline schema2/schema3/schema4 HTTP-attempt report from one explicit local snapshot file. Schema3 adds observed primary-store SQLite contact sums; schema4 adds the listed sidecar stores by label. No live endpoint, capture activation, or complete database/contact qualification.")
    parser.add_argument("snapshot", help="local regular UTF-8 JSON file (max 16 MiB / 16384 records); no URL, stdin, links or network paths")
    parser.add_argument("--format", choices=("json", "markdown"), default="json", help="stdout output format (default: json)")
    args = parser.parse_args(argv)
    try:
        snapshot, source = read_snapshot(args.snapshot)
        report = build_report(snapshot, source)
        output = json.dumps(report, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False) if args.format == "json" else render_markdown(report)
        print(output)
    except (ReportError, OSError, ValueError, RecursionError) as exc:
        # Do not echo malformed input or path contents into diagnostic output.
        print(f"census report refused: {exc}" if isinstance(exc, ReportError) else "census report refused: invalid or unreadable local snapshot", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
