"""Copy V1 organizations into an explicitly bound V2 root.

Never bind store to the source, open source SQLite with SQLite, or follow links.
Source database/WAL bytes are copied and stability checked before a SQLite
backup is taken from that private copy. Even SQLite's read-only open can create
a missing shared-memory sidecar; keeping all SQLite opens private avoids that.
"""
from __future__ import annotations

import copy
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import threading
import uuid
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

DUPLICATE_WARNING = (
    "V1 can keep running. Imported active agents and enabled automation may "
    "repeat work in the same external projects. The source is copied, never moved."
)
CONTINUITY_WARNING = (
    "Native conversations are cloned where supported. Missing or unsupported "
    "native context remains held; readable history alone does not resume an agent. "
    "Prompt-cache continuity is not guaranteed."
)
_LOCK = threading.RLock()
_on_imported: Callable[[str], Any] | None = None
router = APIRouter(prefix="/api/desktop/import-v1", tags=["desktop-import"])


class ImportRefused(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


class PreviewBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_root: str = Field(min_length=1, max_length=4096)
    native_sources: dict[str, Any] = Field(default_factory=dict)


class ImportBody(PreviewBody):
    organizations: list[str] = Field(min_length=1, max_length=100)
    acknowledge_duplicate_work: StrictBool = False


def configure(*, on_imported: Callable[[str], Any]) -> None:
    """Launcher wires its active-only recovery hook before mounting router.

The desktop TokenGate must wrap this router; it must never be mounted on an
agent or public listener. The callback runs only after publication, once per
organization. A callback error is reported as committed/recovery_pending,
never as a failed copy that the UI should blindly retry.
"""
    global _on_imported
    _on_imported = on_imported


def _store() -> Any:
    explicit = os.environ.get("ORGTREE_DATA", "")
    if not explicit or not Path(explicit).is_absolute():
        raise ImportRefused("An explicit absolute V2 ORGTREE_DATA is required", 503)
    from . import store
    if Path(store.DATA_ROOT).resolve() != Path(explicit).resolve():
        raise ImportRefused("Store is bound to a different data root", 503)
    if store.STORE_BACKEND != "sqlite":
        raise ImportRefused("V2 copy import requires the SQLite backend", 503)
    return store


def _plain(path: Path) -> None:
    """Check every existing ancestor without following Windows reparse points."""
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ImportRefused(f"Links and reparse points are not imported: {part}")


def _roots(source_root: str) -> tuple[Path, Path]:
    store = _store()
    source, dest = Path(source_root), Path(store.DATA_ROOT)
    if not source.is_absolute():
        raise ImportRefused("Choose an absolute V1 data folder")
    _plain(source)
    _plain(dest)
    source, dest = source.resolve(), dest.resolve()
    if source == dest or source in dest.parents or dest in source.parents:
        raise ImportRefused("V1 and V2 data folders must not overlap")
    if not source.is_dir() or not (source / "orgs").is_dir():
        raise ImportRefused("V1 data folder must contain an orgs directory")
    _plain(source / "orgs")
    if not dest.is_dir():
        raise ImportRefused("V2 data folder does not exist", 503)
    return source, dest


def _slug(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}", value):
        raise ImportRefused("Invalid organization slug")
    return value


def _digest(path: Path) -> str:
    _plain(path)
    if not stat.S_ISREG(path.stat().st_mode):
        raise ImportRefused(f"Not a regular file: {path}")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _copy_file(source: Path, dest: Path) -> str:
    before = _digest(source)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # No hardlinks: subsequent destination edits must not reach source bytes.
    with source.open("rb") as src, dest.open("xb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    if _digest(source) != before or _digest(dest) != before:
        raise ImportRefused(f"Source changed while copying; retry preview: {source}", 409)
    return before


def _copy_tree(source: Path, dest: Path) -> None:
    _plain(source)
    if not source.is_dir():
        raise ImportRefused(f"Not a directory: {source}")
    dest.mkdir(parents=True, exist_ok=False)
    before = sorted(p.name for p in source.iterdir())
    for name in before:
        child = source / name
        _plain(child)
        if child.is_dir():
            _copy_tree(child, dest / name)
        else:
            _copy_file(child, dest / name)
    if sorted(p.name for p in source.iterdir()) != before:
        raise ImportRefused(f"Source directory changed while copying: {source}", 409)


def _read_document(source: Path, slug: str, stage: Path) -> dict[str, Any]:
    store = _store()
    db, legacy = source / "orgs" / f"{slug}.db", source / "orgs" / f"{slug}.json"
    if db.exists() and legacy.exists():
        raise ImportRefused(f"{slug}: ambiguous SQLite and JSON source documents")
    if db.exists():
        # Never copy -shm: the private SQLite connection builds its own index.
        paths = [db]
        wal = Path(str(db) + "-wal")
        journal = Path(str(db) + "-journal")
        if journal.exists():
            raise ImportRefused(f"{slug}: rollback journal present; retry after the source transaction", 409)
        if wal.exists():
            paths.append(wal)
        hashes = {p: _digest(p) for p in paths}
        for path in paths:
            _copy_file(path, stage / path.name)
        if (wal.exists() != (wal in paths) or journal.exists()
                or any(_digest(p) != digest for p, digest in hashes.items())):
            raise ImportRefused(f"{slug}: database changed while copying; retry", 409)
        private = stage / db.name
        backup = stage / "snapshot.db"
        with closing(sqlite3.connect(private)) as src, closing(sqlite3.connect(backup)) as dst:
            src.backup(dst)
        with closing(sqlite3.connect(backup)) as conn:
            if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ImportRefused(f"{slug}: SQLite integrity check failed")
            version = conn.execute("SELECT val FROM meta WHERE key='schema_version'").fetchone()
            if version != (store._SCHEMA_VERSION,):
                raise ImportRefused(f"{slug}: unsupported SQLite schema version")
            doc = store.reconstruct_full(conn)
    elif legacy.exists():
        _copy_file(legacy, stage / "source.json")
        doc = json.loads((stage / "source.json").read_text(encoding="utf-8"))
    else:
        raise ImportRefused(f"No source organization: {slug}", 404)
    _validate_document(doc, slug)
    # Exact document before path/session changes is permanently retained.
    (stage / "original.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return doc


def _validate_document(doc: Any, slug: str) -> None:
    if not isinstance(doc, dict) or doc.get("slug") != slug or not isinstance(doc.get("name"), str):
        raise ImportRefused(f"{slug}: malformed organization identity")
    nodes = doc.get("nodes")
    if not isinstance(nodes, dict):
        raise ImportRefused(f"{slug}: nodes must be an object")
    if doc.get("version") != 1 or not isinstance(doc.get("tiers"), dict):
        raise ImportRefused(f"{slug}: unsupported organization schema")
    if doc.get("disk"):
        raise ImportRefused(f"{slug}: disk-backed V1 data must first be exported to a regular data folder; its scratch is not in this root")
    for nid, node in nodes.items():
        # V1 archives append @generation to the current ID, including a
        # rehired archived ID. Keep every component; never flatten lineage.
        if (not isinstance(nid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+(?:@[0-9]+)*", nid)
                or not isinstance(node, dict) or not isinstance(node.get("session_id"), str)
                or node.get("state") not in {"live", "archived", "unrecoverable"}
                or not isinstance(node.get("scope"), dict)):
            raise ImportRefused(f"{slug}: malformed agent {nid}")
        grant = node.get("grant")
        if (not isinstance(grant, (int, float)) or isinstance(grant, bool)
                or not math.isfinite(grant) or grant < 0
                or node.get("model") not in doc["tiers"]):
            raise ImportRefused(f"{slug}: invalid agent grant or model for {nid}")
        scope = node["scope"]
        if scope.get("permission_mode", doc.get("permission_mode", "acceptEdits")) not in {
                "plan", "default", "acceptEdits", "bypassPermissions"}:
            raise ImportRefused(f"{slug}: invalid permission mode for {nid}")
        if scope.get("org_visibility", "full") not in {"self", "team", "subtree", "full"}:
            raise ImportRefused(f"{slug}: invalid visibility for {nid}")
        directories = scope.get("add_dirs", [])
        if (not isinstance(directories, list) or any(
                not (isinstance(d, str) or isinstance(d, dict)
                     and isinstance(d.get("path"), str) and d.get("mode", "rw") in {"rw", "ro"})
                for d in directories)):
            raise ImportRefused(f"{slug}: invalid directory grants for {nid}")
        parent = node.get("parent")
        if parent is not None and parent not in nodes:
            raise ImportRefused(f"{slug}: missing parent for {nid}")
        visited = {nid}
        while parent is not None:
            if parent in visited:
                raise ImportRefused(f"{slug}: cyclic agent hierarchy")
            visited.add(parent)
            if parent not in nodes or not isinstance(nodes[parent], dict):
                raise ImportRefused(f"{slug}: invalid ancestor for {nid}")
            parent = nodes[parent].get("parent")
    store = _store()
    for section in store.DICT_LOGS:
        if section in doc and (not isinstance(doc[section], dict)
                              or any(not isinstance(v, list) for v in doc[section].values())):
            raise ImportRefused(f"{slug}: malformed history section {section}")
    for section in store.LIST_LOGS:
        if section in doc and not isinstance(doc[section], list):
            raise ImportRefused(f"{slug}: malformed history section {section}")


def _areas(slug: str) -> list[Path]:
    return [Path("scratch") / slug, Path("workspaces") / slug,
            Path("journals/projects") / slug, Path("turnlog") / slug]


def _conflicts(dest: Path, slug: str) -> None:
    for rel in [*_areas(slug), Path("imports") / slug]:
        path = dest / rel
        _plain(path)
        if path.exists():
            raise ImportRefused(f"Destination already contains {rel}; choose an unused organization", 409)
    orgs = dest / "orgs"
    _plain(orgs)
    if orgs.exists() and any(orgs.glob(f"{slug}.*")):
        raise ImportRefused(f"Destination organization already exists: {slug}", 409)


def _remap(value: Any, source: Path, dest: Path) -> Any:
    # Only path-valued strings: free-form history/charters remain byte-faithful.
    if isinstance(value, str):
        path = Path(value)
        try:
            if path.is_absolute():
                # Windows short/long names and casing must map to the same
                # root. A lexical prefix misses e.g. NCOLA_~1 versus ncola_... .
                resolved = path.resolve()
                if resolved.is_relative_to(source):
                    return str(dest / resolved.relative_to(source))
        except (OSError, ValueError):
            pass
        return value
    if isinstance(value, list):
        return [_remap(v, source, dest) for v in value]
    if isinstance(value, dict):
        return {k: _remap(v, source, dest) for k, v in value.items()}
    return value


def _history(source: Path, slug: str, sid: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", sid):
        return None
    # V1 journals cover Codex/Antigravity/OpenRouter. Claude's conventional
    # sibling profile is consulted for this exact session only, never auth.
    journal = source / "journals" / "projects" / slug / f"{sid}.jsonl"
    if journal.is_file():
        _plain(journal)
        return journal
    profile = source.parent / ".claude" / "projects"
    if profile.is_dir():
        _plain(profile)
        for project in sorted(profile.iterdir()):
            _plain(project)
            candidate = project / f"{sid}.jsonl"
            if candidate.is_file():
                _plain(candidate)
                return candidate
    return None


def imported_history_path(org: Any, nid: str) -> str | None:
    """Read-only UI/recovery seam; never use this as a provider resume path."""
    doc = org.d if hasattr(org, "d") else org
    metadata = doc.get("nodes", {}).get(nid, {}).get("desktop_import", {})
    rel = metadata.get("history")
    if not isinstance(rel, str):
        return None
    store = _store()
    root = Path(store.DATA_ROOT).resolve()
    path = root / rel
    if not path.is_relative_to(root) or ".." in path.parts:
        return None
    _plain(path)
    return str(path) if path.is_file() else None


def _prepare_document(doc: dict[str, Any], source: Path, dest: Path,
                      stage: Path, native_sources: dict | None = None) -> tuple[dict[str, Any], list[str], list[str]]:
    from . import desktop_native
    slug = doc["slug"]
    original = copy.deepcopy(doc)
    doc = copy.deepcopy(doc)
    # Logs retain original paths as historical evidence. Only present runtime
    # structures and document file references are remapped.
    for key in ("workspace", "dirs", "documents", "watchdogs"):
        if key in doc:
            doc[key] = _remap(doc[key], source, dest)
    active, warnings = [], [CONTINUITY_WARNING]
    history_dir = stage / "history"
    history_dir.mkdir()
    (stage / "native").mkdir()
    for nid, node in doc["nodes"].items():
        old = original["nodes"][nid]
        node["scope"] = _remap(node["scope"], source, dest)
        sid = old["session_id"]
        native = desktop_native.prepare(source, dest, slug, nid, old,
                                        native_sources or {}, stage)
        metadata: dict[str, Any] = {"source_session_id": sid,
                                    "continuity": "native_clone" if native["status"] == "ready" else "native_context_held",
                                    "native_continuity": native}
        history = _history(source, slug, sid)
        if native["status"] == "ready" and native["provider"] in {"claude", "openrouter"}:
            history = stage / "native" / nid / "source.jsonl"
        if history:
            name = f"{nid}.jsonl"
            _copy_file(history, history_dir / name)
            metadata["history"] = str(Path("imports") / slug / "history" / name)
        else:
            warnings.append(f"{nid}: provider transcript unavailable; organization history and scratch retained")
        if native["status"] != "ready":
            warnings.append(f"{nid}: native context held: {native['reason']}")
        if node.get("state") == "live" and node.get("inflight"):
            active.append(nid)
        node["desktop_import"] = metadata
        node["session_id"] = native["session_id"]
        if native["status"] == "ready":
            node.pop("session_unrun", None)
            node.pop("cheap_compacted", None)
        else:
            node["session_unrun"] = True
            node["cheap_compacted"] = True
        node["pid"] = None
        for key in ("remote_controlled", "codex_thread", "antigravity_conversation",
                    "cache_continuity", "codex_usage_total", "cache_keepalive_at", "codex_native_home"):
            node.pop(key, None)
        if native["status"] == "ready" and native["provider"] == "codex":
            node["codex_thread"] = node["session_id"]
            # Rendered chat uses the engine journal; native Codex resumes the
            # independent rollout. Give each new SID its own mutable journal.
            journal = stage / "files" / "journals" / "projects" / slug
            journal.mkdir(parents=True, exist_ok=True)
            if history:
                _copy_file(history, journal / f"{node['session_id']}.jsonl")
                views = history.with_suffix(".views.ndjson")
                if views.is_file():
                    _copy_file(views, journal / f"{node['session_id']}.views.ndjson")
        if isinstance(node.get("inflight"), dict):
            node["inflight"].pop("cache_attempt", None)
            node["inflight"]["text"] = (
                ("[V1 COPY IMPORT] Your native conversation was copied into an independent session. "
                 if native["status"] == "ready" else
                 "[V1 COPY IMPORT] Native context is held and must be established before this work runs. ")
                +
                "Read your copied working files first. The V1 source may "
                "still be working: reconcile completed/uncertain tool effects before "
                "any mutation; do not blindly repeat them. "
                + (f"Copied history: {dest / metadata['history']}. " if metadata.get("history") else "")
                + "Original interrupted request:\n" + str(old.get("inflight", {}).get("text") or ""))
    # Removed MVP mechanisms must not activate just because their flags travel.
    for key in ("kiosk", "sandbox", "disk"):
        if doc.get(key):
            warnings.append(f"{key}: original settings archived; this removed V2 feature stays disabled")
        doc.pop(key, None)
    if (source / "accounts.json").exists():
        warnings.append("accounts.json skipped: V1 account management and fallback are excluded from V2")
    for dog in doc.get("watchdogs", []):
        # An enabled command/stream may contain a path within a shell command,
        # not just a single path. Replace only the explicit source root.
        target = dog.get("target")
        if isinstance(target, str):
            for src, dst in ((str(source), str(dest)), (source.as_posix(), dest.as_posix())):
                target = target.replace(src + os.sep, dst + os.sep).replace(src + "/", dst + "/")
            dog["target"] = target
    # A copied network identity must not impersonate or displace the source.
    if doc.pop("net_identity", None):
        warnings.append("Source network identity archived; reconnect this copy in Connections")
    doc["desktop_import"] = {"source_root": str(source), "active_nodes": active,
                             "warnings": warnings, "recovery_pending": True}
    return doc, active, warnings


def preview_import(source_root: str, native_sources: dict | None = None) -> dict[str, Any]:
    from . import desktop_native
    source, dest = _roots(source_root)
    sources = desktop_native.validate_sources(native_sources, source, dest)
    rows = []
    slugs = sorted({p.stem for p in (source / "orgs").iterdir() if p.suffix in {".db", ".json"}})
    # Preview reads source identity without SQLite side effects; its private
    # evidence remains outside orgs and never becomes a runnable organization.
    base = dest / ".import-staging" / str(uuid.uuid4())
    for slug in slugs:
        _slug(slug)
        stage = base / slug
        _plain(stage)
        stage.mkdir(parents=True)
        doc = _read_document(source, slug, stage)
        conflict = None
        try:
            _conflicts(dest, slug)
        except ImportRefused as exc:
            conflict = str(exc)
        rows.append({"slug": slug, "name": doc["name"], "nodes": len(doc["nodes"]),
                     "conflict": conflict, "native_context": [
                         desktop_native.inspect(source, slug, nid, node, sources)
                         for nid, node in doc["nodes"].items()]})
    return {"organizations": rows, "warnings": [DUPLICATE_WARNING, CONTINUITY_WARNING]}


def _write_candidate(path: Path, doc: dict[str, Any]) -> None:
    store = _store()
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute("PRAGMA synchronous=FULL")
        conn.executescript(store._DDL)
        conn.execute("BEGIN IMMEDIATE")
        try:
            store._write_doc(conn, doc, None)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        store.verify_migration(conn, doc)
        if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ImportRefused("Candidate SQLite integrity check failed")
    finally:
        conn.close()


def copy_import(source_root: str, organizations: list[str], *,
                acknowledge_duplicate_work: bool,
                on_imported: Callable[[str], Any], native_sources: dict | None = None) -> dict[str, Any]:
    from . import desktop_native
    if acknowledge_duplicate_work is not True:
        raise ImportRefused("Acknowledge possible duplicate work before importing")
    if not organizations or len(set(organizations)) != len(organizations):
        raise ImportRefused("Choose unique organizations")
    source, dest = _roots(source_root)
    sources = desktop_native.validate_sources(native_sources, source, dest)
    slugs = [_slug(v) for v in organizations]
    store = _store()
    with _LOCK, store.DOC_LOCK:
        for slug in slugs:
            _conflicts(dest, slug)
        base = dest / ".import-staging" / str(uuid.uuid4())
        _plain(base)
        base.mkdir(parents=True)
        prepared = []
        for slug in slugs:
            stage = base / slug
            stage.mkdir()
            doc = _read_document(source, slug, stage)
            files = stage / "files"
            files.mkdir()
            for rel in _areas(slug):
                if (source / rel).exists():
                    _copy_tree(source / rel, files / rel)
            doc, active, warnings = _prepare_document(doc, source, dest, stage, sources)
            _write_candidate(stage / "candidate.db", doc)
            prepared.append((slug, stage, doc, active, warnings))
        # Files and exact source history land before the ledger publication.
        # Failed/crashed staging is retained for diagnosis; never recursively
        # clean a tree that could contain a Windows junction.
        imported = []
        failed = []
        for slug, stage, doc, active, warnings in prepared:
            try:
                from .desktop_native_claude_rewind import publish as publish_rewind
                publish_rewind(doc, stage)
                _publish(dest, slug, stage)
            except (OSError, ImportRefused) as exc:
                if not imported:
                    raise
                failed.append({"slug": slug, "error": str(exc),
                               "not_attempted": slugs[slugs.index(slug) + 1:]})
                break
            imported.append({"slug": slug, "name": doc["name"], "active_nodes": active,
                             "warnings": warnings, "recovery_pending": True})
    for row in imported:
        try:
            result = on_imported(row["slug"])
            row["recovery_pending"] = False
            row["recovery"] = result
        except Exception as exc:
            row["warnings"].append(f"Copy committed; recovery pending ({type(exc).__name__}). Do not repeat import.")
        try:
            store.on_save(row["slug"])
        except Exception:
            pass  # A notification failure cannot turn a committed copy into a retry.
    return {"imported": imported, "failed": failed,
            "warnings": [DUPLICATE_WARNING, CONTINUITY_WARNING]}


def _publish(dest: Path, slug: str, stage: Path) -> None:
    _conflicts(dest, slug)
    for rel in _areas(slug):
        src = stage / "files" / rel
        if src.exists():
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            src.rename(target)
    archive = dest / "imports" / slug
    archive.parent.mkdir(exist_ok=True)
    archive.mkdir()
    (stage / "original.json").rename(archive / "original.json")
    (stage / "history").rename(archive / "history")
    (stage / "native").rename(archive / "native")
    orgs = dest / "orgs"
    orgs.mkdir(exist_ok=True)
    # Exclusive atomic publication, no overwrites even outside DOC_LOCK.
    os.link(stage / "candidate.db", orgs / f"{slug}.db")
    # No failure after this boundary may imply the copy should be repeated.
    # Only our known regular candidate is unlinked, never a directory.
    try:
        (stage / "candidate.db").unlink()
    except OSError:
        pass


def _http(call: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return call()
    except ImportRefused as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(422, f"Import could not validate or copy source: {exc}") from exc


@router.post("/preview")
def preview_route(body: PreviewBody) -> dict[str, Any]:
    return _http(lambda: preview_import(body.source_root, body.native_sources))


@router.post("")
def import_route(body: ImportBody) -> dict[str, Any]:
    callback = _on_imported
    if callback is None:
        raise HTTPException(503, "Import recovery hook is not configured")
    return _http(lambda: copy_import(body.source_root, body.organizations,
                                    acknowledge_duplicate_work=body.acknowledge_duplicate_work,
                                    on_imported=callback, native_sources=body.native_sources))
