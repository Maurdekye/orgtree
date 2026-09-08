"""Stage native rewind backups; publish only a new independent session folder.

Claude resolves these through its selected config profile, not --resume's
transcript directory. Existing profile files, auth and settings are untouched.
"""
from __future__ import annotations

import copy
import os
from pathlib import Path
import re

from .desktop_native import MAX_NATIVE_BYTES, NativeHeld, UUID


def selected_profile(slug: str, nid: str) -> Path:
    from . import supervisor
    from .desktop_import import _plain
    # Only the non-credential environment projection. Do not resolve accounts,
    # probe auth, create a process, or copy settings to determine this path.
    env = supervisor.clean_env()
    env.update(supervisor.env_overrides(slug, nid))
    configured = env.get("CLAUDE_CONFIG_DIR")
    home = env.get("USERPROFILE" if os.name == "nt" else "HOME")
    if not configured and not home:
        raise NativeHeld("Destination Claude profile cannot be resolved")
    profile = Path(configured) if configured else Path(home) / ".claude"
    if not profile.is_absolute():
        raise NativeHeld("Destination Claude profile must resolve to an absolute path")
    _plain(profile)
    return profile.resolve()


def _names(rows: list[dict]) -> set[str]:
    names = set()
    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "backupFileName" and child is not None:
                    # Installed native TUf/vNr requires a 16- or 64-character
                    # lowercase hex digest followed by a version suffix.
                    if not isinstance(child, str) or not re.fullmatch(r"[0-9a-f]{16}(?:[0-9a-f]{48})?@v\d+", child):
                        raise NativeHeld("Native rewind backup filename is invalid")
                    names.add(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(rows)
    return names


def prepare(path: Path, old_sid: str, new_sid: str, rows: list[dict], *,
            source: Path, dest: Path, slug: str, nid: str, sources: dict,
            folder: Path | None = None) -> tuple[list[dict], dict | None]:
    from .desktop_import import _copy_file, _plain, ImportRefused
    names = _names(rows)
    if names != _names([row for row in rows if row.get("type") == "file-history-snapshot"]):
        raise NativeHeld("Native backup references outside file-history snapshots are not supported")
    profile_raw = sources.get("claude_profile")
    if profile_raw:
        source_profile = Path(profile_raw)
    elif path.parent.parent.name == "projects":
        source_profile = path.parent.parent.parent
    else:
        source_profile = None
    if source_profile is None and any(row.get("type") == "file-history-snapshot" for row in rows):
        raise NativeHeld("Select the source Claude profile to validate native rewind targets")
    cloned = _remap_snapshots(rows, source, dest, source_profile, path)
    if not names:
        return cloned, None
    if source_profile is None:
        raise NativeHeld("Select the source Claude profile to locate native rewind backups")
    _plain(source_profile)
    backups = source_profile / "file-history" / old_sid
    _plain(backups)
    total = 0
    for name in names:
        file = backups / name
        _plain(file)
        if not file.is_file():
            raise NativeHeld("A referenced native rewind backup is missing")
        total += file.stat().st_size
    if len(names) > 4096 or total > MAX_NATIVE_BYTES:
        raise NativeHeld("Native rewind backup snapshot exceeds import bounds")
    destination_profile = selected_profile(slug, nid)
    if destination_profile == source or source in destination_profile.parents:
        raise ImportRefused("Destination Claude profile must not be inside the V1 data root")
    target = destination_profile / "file-history" / new_sid
    _plain(target)
    if target.exists():
        raise ImportRefused("Imported native rewind session directory already exists", 409)
    if folder is not None:
        folder.mkdir()
        for name in sorted(names):
            _copy_file(backups / name, folder / name)
    return cloned, {"profile": str(destination_profile), "files": sorted(names), "session_id": new_sid}


def _remap_snapshots(rows: list[dict], source: Path, dest: Path,
                    source_profile: Path | None = None,
                    source_session: Path | None = None) -> list[dict]:
    # Native rewind must not restore files into the old Orgtree data root.
    # External project paths remain external, under the duplicate-work warning.
    cloned = copy.deepcopy(rows)
    def remap(value):
        if not isinstance(value, str):
            return value
        candidate = Path(value)
        if candidate.is_absolute():
            candidate = candidate.resolve()
            if source_profile and candidate.is_relative_to(source_profile.resolve()):
                raise NativeHeld("Native rewind targets the source provider profile")
            try:
                return str(dest / candidate.relative_to(source))
            except ValueError:
                pass
            if source_session is not None:
                native_path = source_session.resolve()
                sidecars = native_path.parent / native_path.stem
                if candidate == native_path or candidate == sidecars or sidecars in candidate.parents:
                    raise NativeHeld("Native rewind would modify the source session or its dependencies")
        return value
    for row in cloned:
        if row.get("type") != "file-history-snapshot":
            continue
        snapshot = row.get("snapshot")
        if not isinstance(snapshot, dict):
            raise NativeHeld("Native file-history snapshot is malformed")
        tracked = snapshot.get("trackedFileBackups")
        if not isinstance(tracked, dict):
            raise NativeHeld("Native file-history tracked backups are malformed")
        snapshot["trackedFileBackups"] = {
            remap(key): {**value, **({"realParentDir": remap(value["realParentDir"])}
                                   if "realParentDir" in value else {})}
            for key, value in tracked.items() if isinstance(value, dict)
        }
        if len(snapshot["trackedFileBackups"]) != len(tracked):
            raise NativeHeld("Native rewind tracked-file records are invalid or collide")
    return cloned


def publish(doc: dict, stage: Path) -> None:
    from .desktop_import import _copy_file, _plain, ImportRefused
    for nid, node in doc["nodes"].items():
        native = node.get("desktop_import", {}).get("native_continuity", {})
        rewind = native.get("rewind")
        if native.get("status") != "ready" or not rewind:
            continue
        sid = str(node["session_id"])
        if not UUID.fullmatch(sid) or rewind.get("session_id") != sid:
            raise ImportRefused("Native rewind publication identity is invalid")
        profile = selected_profile(doc["slug"], nid)
        if profile != Path(rewind["profile"]):
            raise ImportRefused("Destination Claude profile changed before import publication", 409)
        target = profile / "file-history" / sid
        _plain(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive directory ownership: never merge into or overwrite a
        # pre-existing session. A failed partial NEW directory is retained.
        target.mkdir()
        for name in rewind["files"]:
            _copy_file(stage / "native" / nid / "rewind" / name, target / name)


def hold_reason(org: dict, nid: str, rewind: dict) -> str | None:
    from .desktop_import import _plain
    try:
        profile = selected_profile(org["slug"], nid)
        if profile != Path(rewind["profile"]):
            return "Imported native rewind belongs to a different destination profile"
        folder = profile / "file-history" / rewind["session_id"]
        _plain(folder)
        for name in rewind["files"]:
            path = folder / name
            _plain(path)
            if not path.is_file():
                return "Imported native rewind backup is unavailable"
    except (OSError, ValueError, KeyError):
        return "Imported native rewind path failed validation"
    return None


def successor(org, nid: str, native: dict, new_sid: str) -> dict | None:
    """Preserve rewind in a validated native lineage change before ledger save.

The caller must first validate the new native transcript and the actual ledger
operation. Existing successor backups may have been copied by the native CLI;
accept a complete identical set, but never fill/overwrite an existing folder.
"""
    from .desktop_import import _copy_file, _digest, _plain
    doc = org.d if hasattr(org, "d") else org
    rewind = native.get("rewind")
    if not rewind:
        return None
    if (not UUID.fullmatch(new_sid) or new_sid == native.get("session_id")
            or rewind.get("session_id") != native.get("session_id")):
        raise NativeHeld("Native rewind successor identity is invalid")
    reason = hold_reason(doc, nid, rewind)
    if reason:
        raise NativeHeld(reason)
    profile = Path(rewind["profile"])
    source = profile / "file-history" / rewind["session_id"]
    target = profile / "file-history" / new_sid
    _plain(target)
    if target.exists():
        if not target.is_dir():
            raise NativeHeld("Native successor rewind location already exists")
        for name in rewind["files"]:
            copied = target / name
            _plain(copied)
            if not copied.is_file() or _digest(copied) != _digest(source / name):
                raise NativeHeld("Existing native successor rewind backup is missing or differs")
    else:
        target.mkdir()
        for name in rewind["files"]:
            _copy_file(source / name, target / name)
    return {**copy.deepcopy(rewind), "session_id": new_sid}
