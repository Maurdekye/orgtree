"""The converter's run: the one first pass, and Retry of one org (design §5.2, §2.13).

It runs in a child process the engine host starts after the app database's migrations and
before anything serves (``python -m orgtree.orgdb.convert``), the way today's first-launch
import runs ``pgimport``: the loader's caches and its peak memory (about 0.9 GB for the
largest org, measured) never stay in the long-lived host. Its ``ORGTREE_DATA`` is a throwaway
root of markers (``legacy.prepare_root``); the real data root is read and never written.

**One first pass, then never again** (design §5.2 rules 1–5). The pass runs only while
``app_settings.legacy_cutover_at`` is unset. It classifies every legacy org (``legacy``),
registers each one it converts, converts it in a staging database its claim names, and ends by
writing the marker. A crash part-way leaves the marker unset: the next pass skips rows that are
already active, trashed or unavailable, redoes claimed conversions from scratch in a new
staging database, and converts orgs that have no row. After the marker, the converter acts
only on an explicit Retry of an unavailable org.

**Per org** (§5.2 steps 1–7): claim and build a staging database (lifecycle); read the org
through today's loader on one read-only snapshot, with the legacy inventory of that snapshot;
encode every section and the org's side-file rows; COPY them as the runtime role; read every
row back, decode and compare with the loaded document as canonical JSON; take the legacy
inventory again in a new snapshot and require it unchanged; record ``conversion_runs``; then
publish (active, or trashed for a legacy trashed org). Any failure, mismatch or legacy change
abandons the build: the staging database is dropped, the org becomes unavailable with a
one-line reason, the full report is written under the report folder, and the next org goes on
(Q12).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .. import conn, mappers, names, sections
from ..lifecycle import Build, Claim, Lifecycle
from . import legacy, rowio

REPORT_VALUE_LIMIT = 2000      # characters of a value quoted in a mismatch report
MAX_MISMATCHES = 50


@dataclass
class Config:
    data_root: str                  # the real data root: side files, folders (read only)
    work_root: str                  # the loader's throwaway root (markers only)
    report_dir: str                 # <data>/conversion/<time>-<pid>/
    build: str                      # this build's identity (attempted_build)
    legacy_base: str                # runtime conninfo aimed at the legacy database
    runtime_base: str               # runtime conninfo base for the new databases
    side: "SideInputs | None" = None
    legacy_level: str | None = None  # the legacy database's migration level (set by the pass)


@dataclass
class SideInputs:
    """What the side files and the accounts registry give each org (filled by the side-file
    and accounts modules). ``sections_for(org, doc)`` returns the extra Sections (keys=())
    that write the org's side rows, and ``check(org, rows_read)`` returns a list of
    mismatches between the side rows written and the source."""
    sections_for: Callable[[legacy.LegacyOrg, dict[str, Any]], list[sections.Section]]
    check: Callable[[legacy.LegacyOrg, dict[str, list[dict[str, Any]]]], list[dict[str, Any]]]


class Mismatch(Exception):
    """The rows read back differ from the document the loader gave."""

    def __init__(self, details: list[dict[str, Any]]) -> None:
        super().__init__(f"{len(details)} difference(s) between the legacy data and the "
                         f"converted rows, first at {details[0].get('path')!r}" if details else
                         "differences between the legacy data and the converted rows")
        self.details = details


class LegacyChanged(Exception):
    """The legacy inventory changed while the org was converted."""


def canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def _short(v: Any) -> Any:
    s = canon(v)
    return v if len(s) <= REPORT_VALUE_LIMIT else s[:REPORT_VALUE_LIMIT] + "…"


def differences(want: Any, got: Any, path: str = "", out: list[dict[str, Any]] | None = None
                ) -> list[dict[str, Any]]:
    """The first differing places between two JSON values (path, both values)."""
    out = [] if out is None else out
    if len(out) >= MAX_MISMATCHES:
        return out
    if isinstance(want, dict) and isinstance(got, dict):
        for k in list(want) + [k for k in got if k not in want]:
            p = f"{path}/{k}"
            if k not in got:
                out.append({"path": p, "want": _short(want[k]), "got": "<absent>"})
            elif k not in want:
                out.append({"path": p, "want": "<absent>", "got": _short(got[k])})
            elif canon(want[k]) != canon(got[k]):
                differences(want[k], got[k], p, out)
            if len(out) >= MAX_MISMATCHES:
                break
        return out
    if isinstance(want, list) and isinstance(got, list) and len(want) == len(got):
        for i, (a, b) in enumerate(zip(want, got)):
            if canon(a) != canon(b):
                differences(a, b, f"{path}[{i}]", out)
            if len(out) >= MAX_MISMATCHES:
                break
        return out
    out.append({"path": path or "/", "want": _short(want), "got": _short(got)})
    return out


def section_digest(doc: dict[str, Any]) -> dict[str, list[Any]]:
    """{top-level key: [entries, sha256 of its canonical JSON]} for conversion_runs."""
    out = {}
    for k, v in doc.items():
        n = len(v) if isinstance(v, (dict, list)) else 1
        out[k] = [n, hashlib.sha256(canon(v).encode("utf-8")).hexdigest()]
    return out


def write_report(cfg: Config, org: legacy.LegacyOrg, report: dict[str, Any]) -> str:
    folder = Path(cfg.report_dir)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{org.slug}-{org.org_id}.json"
    path.write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return str(path)


def _one_line(e: BaseException) -> str:
    text = " ".join(str(e).split()) or type(e).__name__
    return f"{type(e).__name__}: {text}"[:300]


# ---------------------------------------------------------------- one org

def convert_org(lc: Lifecycle, cfg: Config, org: legacy.LegacyOrg, org_id: int, *,
                claim: Claim | None = None, kind: str = "convert") -> dict[str, Any]:
    """Convert one classified legacy org into its registry row's database (see the module
    docstring). Returns the outcome; never raises for a failure of this org."""
    started = _dt.datetime.now(_dt.timezone.utc)
    build = lc.resume_build(claim) if claim is not None else lc.open_build(org_id, kind)
    state = "trashed" if org.status == "trashed" else "active"
    if build.ready:                      # renamed before a crash: only publishing remains
        lc.publish(build, state=state, trashed_at=org.deleted_at)
        return {"slug": org.slug, "org_id": org_id, "outcome": state, "resumed": "publish"}
    report: dict[str, Any] = {"org": org.record(), "org_id": org_id, "build": cfg.build,
                              "started_at": started.isoformat(), "step": "conversion"}
    try:
        doc, before = legacy.load_document(org)
        report["inventory_before"] = before
        secs = mappers.sections()
        side_secs = cfg.side.sections_for(org, doc) if cfg.side else []
        rows, ctx, rep = sections.encode_document(doc, secs + side_secs,
                                                  ignored=mappers.ignored_keys())
        report["ignored_with_values"] = sorted(k for k, set_ in rep["ignored"].items() if set_)
        report["unregistered_keys"] = rep["extra_keys"]
        report["tombstones"] = len(ctx.tombstones)
        order = rowio.tables(secs + side_secs)
        with conn.connect(cfg.runtime_base, build.database, autocommit=False) as c:
            report["rows_written"] = rowio.write(c, rows, order=order)
            c.commit()
        rows = None   # noqa: F841  free before the read-back
        with conn.connect(cfg.runtime_base, build.database) as c:
            back_rows = rowio.read(c, order=order)
        back = sections.decode_document(back_rows, mappers.sections(), sections.Context())
        ignored = set(mappers.ignored_keys())
        want = {k: v for k, v in doc.items() if k not in ignored}
        if canon(want) != canon(back) or list(want) != list(back):
            raise Mismatch(differences(want, back) or [{"path": "/", "want": "key order",
                                                        "got": "differs"}])
        side_diff = cfg.side.check(org, back_rows) if cfg.side else []
        if side_diff:
            raise Mismatch(side_diff)
        after = _inventory_now(cfg, org)
        if after != before:
            changed = sorted(t for t in set(before) | set(after) if before.get(t) != after.get(t))
            report["inventory_after"] = after
            raise LegacyChanged(f"the legacy data changed during conversion: {changed[:10]}")
        digest = section_digest(want)
        _record_run(cfg, build, org, started, digest, report)
        lc.mark_filled(build)
        lc.publish(build, state=state, trashed_at=org.deleted_at)
        return {"slug": org.slug, "org_id": org_id, "outcome": state,
                "rows": sum(report["rows_written"].values()),
                "ignored_with_values": report["ignored_with_values"],
                "unregistered_keys": report["unregistered_keys"]}
    except Exception as e:   # noqa: BLE001  one org's failure is that org's (Q12)
        report["error"] = _one_line(e)
        report["traceback"] = traceback.format_exc()
        if isinstance(e, Mismatch):
            report["mismatches"] = e.details
        path = write_report(cfg, org, report)
        lc.abandon(build.claim, step="conversion", reason=report["error"], report_path=path)
        return {"slug": org.slug, "org_id": org_id, "outcome": "unavailable",
                "reason": report["error"], "report": path}


def _inventory_now(cfg: Config, org: legacy.LegacyOrg) -> dict[str, list[Any]]:
    with conn.connect(cfg.legacy_base, _legacy_db(cfg), autocommit=False) as c:
        c.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        try:
            return legacy.inventory(c, org.org_id)
        finally:
            c.rollback()


def _legacy_db(cfg: Config) -> str:
    from psycopg.conninfo import conninfo_to_dict   # noqa: PLC0415
    return str(conninfo_to_dict(cfg.legacy_base).get("dbname") or "orgtree")


def _record_run(cfg: Config, build: Build, org: legacy.LegacyOrg, started: _dt.datetime,
                digest: dict[str, list[Any]], report: dict[str, Any]) -> None:
    """conversion_runs + its per-kind counts and checksums, in the staging database. The
    destination side is the decoded document, which equals the source here."""
    with conn.connect(cfg.runtime_base, build.database, autocommit=False) as c:
        level = cfg.legacy_level
        run_id = c.execute(
            "INSERT INTO conversion_runs (started_at, finished_at, build, legacy_database, "
            "legacy_org_id, legacy_level, report_path) VALUES (%s, now(), %s, %s, %s, %s, NULL) "
            "RETURNING id", (started, cfg.build, _legacy_db(cfg), org.org_id, level)).fetchone()[0]
        with c.cursor() as cur:
            cur.executemany(
                "INSERT INTO conversion_run_kinds (run_id, kind, source_count, dest_count, "
                "source_sha256, dest_sha256) VALUES (%s, %s, %s, %s, %s, %s)",
                [(run_id, k, n, n, sha, sha) for k, (n, sha) in digest.items()])
        c.commit()


# ---------------------------------------------------------------- the first pass

def _app(cfg: Config, lc: Lifecycle) -> Any:
    return conn.connect(cfg.runtime_base, names.app(lc.prefix))


def first_pass(lc: Lifecycle, cfg: Config) -> dict[str, Any]:
    """The one first pass (see the module docstring). Returns the run's report."""
    with _app(cfg, lc) as a:
        done = a.execute("SELECT legacy_cutover_at FROM app_settings").fetchone()[0]
    if done is not None:
        return {"skipped": "the first pass finished before", "at": done.isoformat()}
    resumed = {c.org_id: c for c in lc.take_over() if c.kind in ("convert", "retry")}
    with conn.connect(cfg.legacy_base, _legacy_db(cfg)) as legacy_conn:
        orgs = legacy.classify(legacy_conn, cfg.data_root)
        level = (legacy_conn.execute("SELECT max(name) FROM public.schema_migrations")
                 .fetchone()[0])
    cfg.legacy_level = level
    legacy.prepare_root(cfg.work_root, orgs)
    by_legacy = {(r["legacy_database"], r["legacy_org_id"]): r for r in lc.rows()
                 if r["legacy_org_id"] is not None}
    report: dict[str, Any] = {"legacy_database": _legacy_db(cfg), "legacy_level": level,
                              "build": cfg.build, "orgs": [], "not_converted": []}
    for org in orgs:
        if org.status == "orphaned":
            report["not_converted"].append(org.record())
            continue
        row = by_legacy.get((_legacy_db(cfg), org.org_id))
        if row is None:
            org_id = _register(lc, cfg, org)
            row = lc.row(org_id)
        if org.status == "duplicate":
            report["orgs"].append({"slug": org.slug, "org_id": row["org_id"],
                                   "outcome": "unavailable", "reason": org.note})
            continue
        if row["state"] in ("active", "trashed", "unavailable") and row["op_kind"] is None:
            report["orgs"].append({"slug": org.slug, "org_id": row["org_id"],
                                   "outcome": f"already {row['state']}"})
            continue
        out = convert_org(lc, cfg, org, int(row["org_id"]), claim=resumed.get(row["org_id"]))
        report["orgs"].append(out)
    with _app(cfg, lc) as a:
        a.execute("UPDATE app_settings SET legacy_cutover_at = now(), legacy_cutover_database = %s, "
                  "legacy_cutover_level = %s, legacy_cutover_build = %s, legacy_cutover_report = %s, "
                  "row_version = row_version + 1",
                  (_legacy_db(cfg), level, cfg.build, cfg.report_dir))
    report["finished"] = True
    return report


def _register(lc: Lifecycle, cfg: Config, org: legacy.LegacyOrg) -> int:
    common = {"legacy_database": _legacy_db(cfg), "legacy_org_id": org.org_id}
    if org.status == "duplicate":
        reason = f"{org.note}: {', '.join(org.duplicates)}"
        return lc.register_org(f"{org.slug}", state="unavailable", unavailable_step="conversion",
                               state_reason=reason[:300], **common)
    return lc.register_org(org.slug, state="converting",
                           trashed_at=org.deleted_at if org.status == "trashed" else None,
                           **common)


def retry(lc: Lifecycle, cfg: Config, org_id: int) -> dict[str, Any]:
    """Retry an org that is unavailable at step 'conversion' (§2.13): classify its legacy
    org again and convert it in a new staging database. Step 'import' is the first-launch
    import's (it imports the held-back file, then calls this)."""
    row = lc.row(org_id)
    if row["state"] != "unavailable" or row["unavailable_step"] != "conversion":
        raise ValueError(f"org {org_id} is not unavailable at step 'conversion'")
    with conn.connect(cfg.legacy_base, _legacy_db(cfg)) as legacy_conn:
        orgs = {o.org_id: o for o in legacy.classify(legacy_conn, cfg.data_root)}
    org = orgs.get(int(row["legacy_org_id"]))
    if org is None or org.status not in ("active", "trashed"):
        reason = ("the legacy org is gone" if org is None else
                  f"the legacy org is {org.status}: {org.note}")
        claim = lc.claim(org_id, "retry")
        lc.abandon(claim, step="conversion", reason=reason)
        return {"org_id": org_id, "outcome": "unavailable", "reason": reason}
    legacy.prepare_root(cfg.work_root, [org])
    return convert_org(lc, cfg, org, org_id, kind="retry")
