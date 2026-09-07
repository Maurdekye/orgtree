"""Independent native conversation snapshots for desktop copy import.

Source locations are file/profile locators, never credentials or account setup.
Claude resumes an explicit destination JSONL path; no profile is copied or linked.
Unsupported native state stays held rather than becoming an empty conversation.
"""
from __future__ import annotations

import copy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import uuid
from typing import Any

MAX_NATIVE_BYTES = 128 * 1024 * 1024
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


class NativeHeld(ValueError):
    """The copied organization is valid, but native resumption is unavailable."""


def provider_for(node: dict) -> str:
    from . import providers
    tier = str(node.get("model") or "")
    if tier in providers.CODEX_TIERS:
        return "codex"
    if tier in providers.ANTIGRAVITY_TIERS:
        return "antigravity"
    if tier.startswith("or-"):
        return "openrouter"
    return "claude"


def validate_sources(value: dict | None, source: Path, dest: Path) -> dict:
    from .desktop_import import ImportRefused, _plain
    value = value or {}
    if not isinstance(value, dict) or set(value) - {"claude_profile", "codex_profile", "sessions"}:
        raise ImportRefused("Invalid native source locators")
    sessions = value.get("sessions") or {}
    if not isinstance(sessions, dict) or len(sessions) > 10000:
        raise ImportRefused("Invalid native session map")
    out: dict[str, Any] = {"sessions": {}}
    for key, raw in [(k, v) for k, v in value.items() if k != "sessions"] + list(sessions.items()):
        profile = key in {"claude_profile", "codex_profile"}
        if not profile and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}/[A-Za-z0-9_@.-]{1,160}", key):
            raise ImportRefused("Native session keys must be organization/node")
        if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096:
            raise ImportRefused("Native source paths must be nonempty absolute paths")
        path = Path(raw)
        if not path.is_absolute():
            raise ImportRefused("Native source paths must be absolute")
        _plain(path)
        path = path.resolve()
        if path == dest or path in dest.parents or dest in path.parents:
            raise ImportRefused("Native source and V2 destination must not overlap")
        if profile:
            if not path.is_dir():
                raise ImportRefused("Native source profile must be an existing directory")
            out[key] = str(path)
        else:
            if not path.is_file() or path.suffix != ".jsonl":
                raise ImportRefused("Native session locator must name an existing JSONL file")
            out["sessions"][key] = str(path)
    return out


def locate(source: Path, slug: str, nid: str, node: dict, sources: dict) -> Path:
    from .desktop_import import _plain
    provider, sid = provider_for(node), str(node.get("session_id") or "")
    if not UUID.fullmatch(sid):
        raise NativeHeld("No valid native session ID was recorded")
    exact = sources.get("sessions", {}).get(f"{slug}/{nid}")
    if exact:
        return Path(exact)
    if provider in {"claude", "openrouter"}:
        profile = Path(sources.get("claude_profile") or source.parent / ".claude")
        _plain(profile)
        projects = profile / "projects"
        _plain(projects)
        hits = []
        if projects.is_dir():
            for project in projects.iterdir():
                _plain(project)
                path = project / f"{sid}.jsonl"
                _plain(path)
                if path.is_file():
                    hits.append(path)
        if len(hits) == 1:
            return hits[0]
        if hits:
            raise NativeHeld("More than one native session matches; supply its exact source file")
        raise NativeHeld("Native Claude transcript missing; select its source profile or exact file")
    if provider == "codex":
        if node.get("codex_thread") != sid:
            raise NativeHeld("Codex native thread and recorded session identity differ")
        profile = Path(sources.get("codex_profile") or source.parent / ".codex")
        _plain(profile)
        hits, pending, scanned = [], [profile / "sessions", profile / "archived_sessions"], 0
        while pending:
            folder = pending.pop()
            _plain(folder)
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                _plain(path)
                scanned += 1
                if scanned > 100000:
                    raise NativeHeld("Native profile search exceeds limit; select an exact session file")
                if path.is_dir():
                    pending.append(path)
                elif path.name.endswith(f"{sid}.jsonl"):
                    hits.append(path)
        if len(hits) == 1:
            return hits[0]
        if hits:
            raise NativeHeld("More than one native session matches; supply its exact source file")
        raise NativeHeld("Native Codex rollout missing; select its source profile or exact file")
    raise NativeHeld("Native conversation cloning is not yet verified for this provider")


def _read_native(path: Path) -> tuple[list[dict], bytes]:
    from .desktop_import import _digest, _plain
    _plain(path)
    if path.stat().st_size > MAX_NATIVE_BYTES:
        raise NativeHeld("Native conversation exceeds the supported snapshot size")
    before = _digest(path)
    raw = path.read_bytes()
    if before != _digest(path):
        raise NativeHeld("Native conversation changed during snapshot; retry preview when stable")
    if not raw.endswith(b"\n"):
        raise NativeHeld("Native conversation has an incomplete final record")
    try:
        rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    except (UnicodeError, ValueError) as exc:
        raise NativeHeld("Native conversation contains an invalid record") from exc
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise NativeHeld("Native conversation must contain object records")
    return rows, raw


def claude_records(rows: list[dict], source_sid: str, new_sid: str, cwd: str) -> list[dict]:
    """Preserve native content and UUID/parent chains, rebind runtime identity.

The installed Claude 2.1.241 loader chooses the last native message's sessionId,
even when resuming an explicit file. Merely renaming a file is insufficient.
"""
    messages = [r for r in rows if r.get("type") in {"user", "assistant"}]
    if not messages:
        raise NativeHeld("No native conversation messages exist")
    known: set[str] = set()
    for row in rows:
        rid = row.get("uuid")
        if rid:
            if not isinstance(rid, str) or not UUID.fullmatch(rid) or rid in known:
                raise NativeHeld("Invalid or duplicate native message UUID")
            known.add(rid)
    for row in messages:
        msg = row.get("message")
        if (not row.get("uuid") or row.get("sessionId") != source_sid
                or not isinstance(msg, dict) or msg.get("role") != row["type"]
                or not isinstance(msg.get("content"), (str, list))):
            raise NativeHeld("Transcript is not the selected provider's native conversation")
        try:
            datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
        except (KeyError, AttributeError, TypeError, ValueError) as exc:
            raise NativeHeld("Native message timestamp is missing or invalid") from exc
        parent = row.get("parentUuid")
        if parent is not None and parent not in known:
            raise NativeHeld("Native conversation parent chain is incomplete")
    by_id = {r["uuid"]: r for r in rows if r.get("uuid")}
    walked: set[str] = set()
    for row in messages:
        seen: set[str] = set()
        current = row
        while current:
            rid = current.get("uuid")
            if rid in walked:
                break
            if rid in seen:
                raise NativeHeld("Native conversation parent chain contains a cycle")
            seen.add(rid)
            current = by_id.get(current.get("parentUuid"))
        walked.update(seen)
    # A source worktree/remote session restoration can reconnect to V1 paths.
    # Hold these known special layouts until their complete clone is supported.
    if any(r.get("type") in {"worktree-session", "bridge-session-id", "relocated-cwd"}
           or r.get("worktreeSession") or r.get("bridgeSessionId") for r in rows):
        raise NativeHeld("Native worktree/remote relocation needs a verified clone path")
    out = copy.deepcopy(rows)
    for row in out:
        if "sessionId" in row:
            if row["sessionId"] != source_sid:
                raise NativeHeld("Native transcript mixes session identities")
            row["sessionId"] = new_sid
        if "cwd" in row:
            row["cwd"] = cwd
    return out


def _check_dependencies(path: Path, sid: str, rows: list[dict]) -> None:
    from .desktop_native_claude_dependencies import copy_outputs
    copy_outputs(path, sid, rows, Path("preview-only"))


def inspect(source: Path, slug: str, nid: str, node: dict, sources: dict) -> dict:
    row = {"node": nid, "provider": provider_for(node), "status": "held"}
    try:
        path = locate(source, slug, nid, node, sources)
        records, _ = _read_native(path)
        if row["provider"] == "codex":
            from .desktop_native_codex import validate
            if node.get("codex_thread") != node["session_id"]:
                raise NativeHeld("Codex native thread and recorded session identity differ")
            validate(records, node["session_id"])
        elif row["provider"] in {"claude", "openrouter"}:
            _check_dependencies(path, node["session_id"], records)
            claude_records(records, node["session_id"], str(uuid.uuid4()), "preview-only")
        else:
            raise NativeHeld("This native provider clone is not configured yet")
        return {**row, "status": "available", "source_path": str(path)}
    except (NativeHeld, OSError) as exc:
        return {**row, "reason": str(exc)}


def prepare(source: Path, dest: Path, slug: str, nid: str, node: dict,
            sources: dict, stage: Path) -> dict:
    """Write a native clone into private staging, never any source/profile path."""
    meta = {"status": "held", "provider": provider_for(node),
            "session_id": str(uuid.uuid4())}
    try:
        path = locate(source, slug, nid, node, sources)
        records, raw = _read_native(path)
        folder = stage / "native" / nid
        folder.mkdir(parents=True)
        cwd = str(dest / "scratch" / slug / nid)
        if meta["provider"] == "codex":
            from .desktop_native_codex import fork_snapshot
            if node.get("codex_thread") != node["session_id"]:
                raise NativeHeld("Codex native thread and recorded session identity differ")
            meta["session_id"], encoded = fork_snapshot(records, node["session_id"], folder, cwd)
        elif meta["provider"] in {"claude", "openrouter"}:
            from .desktop_native_claude_dependencies import copy_outputs
            cloned = claude_records(records, node["session_id"], meta["session_id"], cwd)
            cloned = copy_outputs(path, node["session_id"], cloned,
                                  dest / "imports" / slug / "native" / nid / meta["session_id"],
                                  folder / meta["session_id"])
            encoded = "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in cloned).encode("utf-8")
        else:
            raise NativeHeld("This native provider clone is not configured yet")
        clone = folder / f"{meta['session_id']}.jsonl"
        with clone.open("xb") as f:
            f.write(encoded)
            f.flush()
            os.fsync(f.fileno())
        # Original native bytes are evidence and remain separate from both the
        # mutable clone and the rendered provider-neutral archive.
        with (folder / "source.jsonl").open("xb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        return {**meta, "status": "ready", "source_session_id": node["session_id"],
                "storage_node": nid,
                "path": str(Path("imports") / slug / "native" / nid / clone.name),
                "source_path": str(path)}
    except (NativeHeld, OSError) as exc:
        return {**meta, "reason": str(exc)}


def native_session_path(org: Any, nid: str) -> str | None:
    from .desktop_import import _plain, _store
    doc = org.d if hasattr(org, "d") else org
    node = doc.get("nodes", {}).get(nid, {})
    native = node.get("desktop_import", {}).get("native_continuity", {})
    if native.get("status") != "ready" or native.get("session_id") != node.get("session_id"):
        return None
    if node["session_id"] in native_conflicts():
        return None
    root = Path(_store().DATA_ROOT).resolve()
    storage_node = native.get("storage_node") or nid
    if not isinstance(storage_node, str) or not re.fullmatch(r"[A-Za-z0-9_@.-]{1,160}", storage_node) or storage_node in {".", ".."}:
        return None
    expected = Path("imports") / doc["slug"] / "native" / storage_node / f"{node['session_id']}.jsonl"
    if Path(native.get("path") or "") != expected:
        return None
    path = root / expected
    _plain(path)
    return str(path) if path.is_file() else None


def native_hold_reason(org: Any, nid: str) -> str | None:
    doc = org.d if hasattr(org, "d") else org
    node = doc.get("nodes", {}).get(nid, {})
    imported = node.get("desktop_import")
    if not imported:
        return None
    native = imported.get("native_continuity") or {}
    if native.get("status") == "transitioned":
        if (native.get("session_id") == node.get("session_id")
                and native.get("generation") == node.get("generation")
                and native.get("provider") == provider_for(node)):
            return None
        return "Imported successor identity changed without a recorded native transition"
    if native.get("status") != "ready":
        return native.get("reason") or "Imported native session continuity has not been established"
    if native.get("provider") != provider_for(node):
        return "Imported native session belongs to a different provider"
    try:
        if not native_session_path(org, nid):
            return "Imported native session identity or independent file is unavailable"
    except (ValueError, OSError):
        return "Imported native session path failed validation"
    return None


def retire_native_binding(org: Any, nid: str, predecessor: str) -> bool:
    """Called inside the real lineage transaction after a sanctioned transition.

An arbitrary SID edit cannot bypass a native hold. Require the actual archived
predecessor and its old binding; preserve that predecessor's metadata/file.
Rename alone needs no retirement because storage_node stays stable.
"""
    doc = org.d if hasattr(org, "d") else org
    node = doc.get("nodes", {}).get(nid, {})
    old = doc.get("nodes", {}).get(predecessor, {})
    imported = node.get("desktop_import") or {}
    native = imported.get("native_continuity") or {}
    if not imported:
        return False
    if (native.get("status") not in {"ready", "transitioned"}
            or old.get("state") != "archived" or old.get("successor") != nid
            or node.get("predecessor") != predecessor
            or old.get("session_id") != native.get("session_id")
            or old.get("lineage") != node.get("lineage")
            or node.get("generation", 0) != old.get("generation", 0) + 1
            or node.get("session_id") == old.get("session_id")
            or not UUID.fullmatch(str(node.get("session_id") or ""))):
        raise NativeHeld("Native binding can only retire after a verified ledger lineage transition")
    if not node.get("session_unrun"):
        if provider_for(node) in {"claude", "openrouter"}:
            from . import supervisor
            target = supervisor.transcript_path(node["session_id"])
            if not target:
                raise NativeHeld("Compacted successor has no validated native transcript")
            rows, _ = _read_native(Path(target))
            claude_records(rows, node["session_id"], node["session_id"], "validation-only")
        elif provider_for(node) == "codex":
            from . import providers
            from .desktop_native_codex import validate
            if node.get("codex_thread") != node["session_id"]:
                raise NativeHeld("Successor has no matching provider resume handle")
            profile = Path(providers._codex_home())
            target = locate(profile, doc["slug"], nid, node, {"codex_profile": str(profile)})
            validate(_read_native(target)[0], node["session_id"])
        else:
            raise NativeHeld("Native successor validation is not yet supported for this provider")
    # Ledger copies can be shallow; rebinding must not change the predecessor.
    node["desktop_import"] = copy.deepcopy(imported)
    node["desktop_import"]["native_continuity"] = {
        "status": "transitioned", "provider": provider_for(node),
        "session_id": node["session_id"], "generation": node["generation"],
        "predecessor": predecessor, "predecessor_session_id": old["session_id"],
        "reason": "Native import binding retired by an explicit ledger lineage transition",
    }
    return True


def _native_inventory() -> tuple[dict[str, str], set[str]]:
    """Destination-only SID lookup for existing supervisor transcript readers.

No source profile or org database is consulted. Unexpected paths/duplicates
refuse rather than selecting a plausible file belonging to somebody else.
"""
    from .desktop_import import _plain, _store
    root = Path(_store().DATA_ROOT).resolve() / "imports"
    _plain(root)
    found: dict[str, str] = {}
    conflicts: set[str] = set()
    if not root.exists():
        return found, conflicts
    for orgdir in root.iterdir():
        _plain(orgdir)
        folder = orgdir / "native"
        _plain(folder)
        if not folder.is_dir():
            continue
        for node in folder.iterdir():
            _plain(node)
            if not node.is_dir():
                continue
            for path in node.iterdir():
                _plain(path)
                if path.suffix == ".jsonl" and UUID.fullmatch(path.stem) and path.is_file():
                    if path.stem in found:
                        conflicts.add(path.stem)
                    found[path.stem] = str(path)
    return {sid: path for sid, path in found.items() if sid not in conflicts}, conflicts


def native_conflicts() -> set[str]:
    """IDs which must not fall through to a provider's unrelated global file."""
    return _native_inventory()[1]


def native_index() -> dict[str, str]:
    found, _ = _native_inventory()
    display = {}
    for sid, path in found.items():
        # Codex native rollouts count toward identity collisions, but its chat
        # reader consumes the separate engine journal, not raw rollout rows.
        try:
            with open(path, "r", encoding="utf-8") as stream:
                first = json.loads(stream.readline())
        except (OSError, ValueError):
            continue
        if isinstance(first, dict) and first.get("type") != "session_meta":
            display[sid] = path
    return display


def native_path_for_session(sid: str) -> str | None:
    if not isinstance(sid, str) or not UUID.fullmatch(sid):
        return None
    if sid in native_conflicts():
        raise NativeHeld("Duplicate native session ID in imported storage")
    return native_index().get(sid)
