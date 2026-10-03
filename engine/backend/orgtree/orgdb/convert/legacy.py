"""The legacy store as the converter sees it: read-only (design §5.2).

3.2.0 never writes, migrates or tidies the legacy database or its markers (rev 4.1, decision
14), so the converter cannot run today's start-up routine (``retire_unmarked``,
``revive_marked``), which rewrites registry rows. ``classify`` decides, without writing, what
that routine would have made of every legacy org:

  active     a live row whose marker in ``orgs/`` names it; or a retired row a marker names
             (today's restore: ``revive_marked`` would bring it back under the marker's name)
  trashed    a row retired by a delete (``<slug>@deleted-<id>``) whose marker is in the trash
             (``<data>/deleted/<slug>-<stamp>.pg``): restore keeps working (design §5.2 rule 2)
  orphaned   any other row: no marker anywhere (``@unmarked-<id>``, a trashed org whose trash
             marker is gone, a live row ``retire_unmarked`` would retire). Not converted; the
             cutover record lists it, and its schema stays in the legacy database
  duplicate  two or more markers name one org_id (``refuse_duplicate``): unavailable, naming
             every marker

``load_document`` reads one org through today's loader on ONE pinned read-only REPEATABLE READ
transaction, so every lazy section shares one snapshot; ``inventory`` hashes every table of the
org's legacy schema, and its rows in ``public.receipts``, for the before/after guard;
``receipts`` reads those rows, which move into the org's own database (design §2.1).

This module runs in the converter's child process, whose ``ORGTREE_DATA`` is a throwaway root
holding one marker per org to load (``prepare_root``): the real data root is never written.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MARKER_EXT = ".pg"


@dataclass
class LegacyOrg:
    org_id: int
    slug: str                        # the name it is converted under
    status: str                      # active | trashed | orphaned | duplicate
    row_slug: str                    # public.orgs.slug as stored
    deleted_at: _dt.datetime | None
    marker: str | None = None        # the marker the loader opens (orgs/ or the trash)
    note: str = ""
    duplicates: list[str] = field(default_factory=list)

    def record(self) -> dict[str, Any]:
        return {"org_id": self.org_id, "slug": self.slug, "status": self.status,
                "row_slug": self.row_slug,
                "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
                "marker": self.marker, "note": self.note, "duplicates": self.duplicates}


def read_marker(path: str) -> int | None:
    """A marker's org_id, or None (pgstore.read_marker's rule, without importing the store)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    v = data.get("org_id") if isinstance(data, dict) else None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _markers(folder: Path) -> dict[int, list[tuple[str, str]]]:
    """{org_id: [(file stem, path), ...]} for every marker in ``folder``."""
    out: dict[int, list[tuple[str, str]]] = {}
    if folder.is_dir():
        for p in sorted(folder.iterdir()):
            if p.is_file() and p.name.endswith(MARKER_EXT):
                org_id = read_marker(str(p))
                if org_id is not None:
                    out.setdefault(org_id, []).append((p.name[:-len(MARKER_EXT)], str(p)))
    return out


def classify(conn: Any, data_root: str) -> list[LegacyOrg]:
    """Every row of the legacy registry, classified (see the module docstring). ``conn`` is
    a psycopg connection to the legacy database; nothing is written."""
    live = _markers(Path(data_root) / "orgs")
    trash = _markers(Path(data_root) / "deleted")
    out = []
    for org_id, slug, deleted_at in conn.execute(
            "SELECT org_id, slug, deleted_at FROM public.orgs ORDER BY org_id").fetchall():
        org_id = int(org_id)
        names = live.get(org_id, [])
        if len(names) > 1:
            out.append(LegacyOrg(org_id, names[0][0], "duplicate", slug, deleted_at,
                                 note="two or more markers in orgs/ name this org",
                                 duplicates=[n + MARKER_EXT for n, _ in names]))
        elif len(names) == 1:
            name, path = names[0]
            how = ("live" if deleted_at is None and name == slug else
                   "restored: revive_marked would bring it back under its marker's name")
            out.append(LegacyOrg(org_id, name, "active", slug, deleted_at, path, note=how))
        elif deleted_at is not None and "@deleted-" in slug and trash.get(org_id):
            original = slug.rsplit("@deleted-", 1)[0]
            stem, path = sorted(trash[org_id], key=lambda t: t[1])[-1]
            out.append(LegacyOrg(org_id, original, "trashed", slug, deleted_at, path,
                                 note=f"trash marker {stem}{MARKER_EXT}"))
        else:
            why = ("live row without a marker (retire_unmarked would retire it)"
                   if deleted_at is None else "retired, and no marker names it")
            out.append(LegacyOrg(org_id, slug.split("@", 1)[0], "orphaned", slug, deleted_at,
                                 note=why))
    return out


def prepare_root(root: str, orgs: list[LegacyOrg]) -> None:
    """The throwaway data root the loader reads: ``orgs/<slug>.pg`` for each org to load,
    naming its org_id (a trashed org's too, under its original name)."""
    folder = Path(root) / "orgs"
    folder.mkdir(parents=True, exist_ok=True)
    for o in orgs:
        if o.status in ("active", "trashed"):
            (folder / f"{o.slug}{MARKER_EXT}").write_text(
                json.dumps({"org_id": o.org_id, "slug": o.slug}), encoding="utf-8")


def inventory(raw: Any, org_id: int) -> dict[str, list[Any]]:
    """{table: [rows, sha256]} over every table of the org's legacy schema (rows in primary
    key order, every column as text) and its public.receipts rows. ``raw`` is a psycopg
    connection; run it in the snapshot to be described."""
    schema = f"org_{int(org_id)}"
    out: dict[str, list[Any]] = {}
    tables = [r[0] for r in raw.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = %s "
        "AND table_type = 'BASE TABLE' ORDER BY table_name", (schema,)).fetchall()]
    # rows ordered by their own text, so the order never depends on a table's key
    queries = [(t, f'SELECT * FROM "{schema}"."{t}" AS r ORDER BY r::text COLLATE "C"')
               for t in tables]
    has_receipts = raw.execute("SELECT to_regclass('public.receipts')").fetchone()[0] is not None
    if has_receipts:
        queries.append(("public.receipts", "SELECT * FROM public.receipts AS r "
                        "WHERE org_id = %s ORDER BY r::text COLLATE \"C\""))
    for name, q in queries:
        h = hashlib.sha256()
        n = 0
        with raw.cursor(name=f"inv_{n}_{abs(hash(name)) % 10**8}") as cur:
            cur.itersize = 2000
            cur.execute(q, (org_id,) if name == "public.receipts" else None)
            for row in cur:
                n += 1
                h.update(json.dumps([None if v is None else str(v) for v in row],
                                    ensure_ascii=False).encode("utf-8"))
                h.update(b"\n")
        out[name] = [n, h.hexdigest()]
    return out


def receipts(raw: Any, org_id: int) -> list[tuple[Any, ...]]:
    """The org's ``public.receipts`` rows, ``(op_key, fingerprint, result, at)`` in op_key
    order: org_tx's operation receipts, which move into the org's ``tx_receipts`` (design
    §2.1 "Idempotency", §5.2 step 3). ``raw`` is a psycopg connection; run it in the snapshot
    the document is read in."""
    if raw.execute("SELECT to_regclass('public.receipts')").fetchone()[0] is None:
        return []
    return [tuple(r) for r in raw.execute(
        "SELECT op_key, fingerprint, result, at FROM public.receipts WHERE org_id = %s "
        "ORDER BY op_key COLLATE \"C\"", (org_id,)).fetchall()]


class SnapshotLost(RuntimeError):
    """The pinned transaction ended while the loader read: the org was not read from one
    snapshot."""


def load_document(org: LegacyOrg) -> tuple[dict[str, Any], dict[str, list[Any]],
                                           list[tuple[Any, ...]]]:
    """One org's whole document, as today's loader builds it, from one read-only snapshot,
    with the inventory and the org's operation receipts (``receipts``) taken in that same
    snapshot. The process's store must point at the root ``prepare_root`` made
    (``ORGTREE_DATA``) and at the legacy database."""
    from ... import pgstore, store   # noqa: PLC0415  the legacy store, in the child only
    marker = os.path.join(store.DATA_ROOT, "orgs", f"{org.slug}{MARKER_EXT}")
    conn = pgstore.open_conn(org.slug, marker)
    try:
        conn.raw.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        before = inventory(conn.raw, org.org_id)
        rcpts = receipts(conn.raw, org.org_id)
        conn.pinned = True
        store._orgtx_local.pinned = {org.slug: conn}      # pyright: ignore[reportPrivateUsage]
        try:
            loaded = store.load_org(org.slug)
            d = loaded.d
            if hasattr(d, "materialize_all"):
                d.materialize_all()
            doc: dict[str, Any] = {}
            for k in list(d.keys()):
                v = d[k]
                if hasattr(v, "materialize"):
                    v.materialize("orgdb-convert")
                doc[k] = v
            if not conn.in_transaction:
                raise SnapshotLost(f"{org.slug}: the read transaction ended during the load")
            # plain dicts and lists: the loader's lazy containers stay behind
            doc = json.loads(json.dumps(doc))
        finally:
            store._orgtx_local.pinned = None              # pyright: ignore[reportPrivateUsage]
            conn.pinned = False
        return doc, before, rcpts
    finally:
        try:
            conn.raw.execute("ROLLBACK")
        finally:
            conn.close()
