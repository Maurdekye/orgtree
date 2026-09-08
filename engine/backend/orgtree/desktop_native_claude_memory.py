"""Carry Claude project auto-memory across a V1 copy import.

Claude Code 2.1.241 reads project memory from ``<config>/projects/<key>/memory``
where ``<key>`` derives from the process working directory (or the canonical
root of the git checkout containing it). The engine spawns every agent in
``scratch/<slug>/<base node id>``, so an imported organization gets new keys and
would otherwise start with empty memory. This module stages the source memory
directory once per base scratch folder, publishes it exclusively under the
destination key, and records an explicit unavailable state that holds native
continuation whenever the memory cannot be carried faithfully.

The lookup below is a port of the installed binary's functions (``kLu``/``$ft``
for the key, ``E8u``/``A8u`` for the git root, ``OEa.resolve`` for overrides);
``tests/fixtures/claude_memory_key.cjs`` runs the extracted JavaScript as the
control for the key port. No provider starts and no source profile is written.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any
import uuid

from .desktop_native import NativeHeld

MAX_KEY_LENGTH = 200
MAX_MEMORY_BYTES = 64 * 1024 * 1024
MAX_MEMORY_FILES = 5000
MEMORY_DIR = "memory"
OVERRIDE_ENV = "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"
REMOTE_ENV = "CLAUDE_CODE_REMOTE_MEMORY_DIR"
_ALNUM = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


# ---- key derivation (port of kLu / $ft) -----------------------------------

def _utf16_units(text: str) -> list[int]:
    raw = text.encode("utf-16-le")
    return [int.from_bytes(raw[i:i + 2], "little") for i in range(0, len(raw), 2)]


def _js_hash(text: str) -> int:
    value = 0
    for unit in _utf16_units(text):
        value = ((value << 5) - value + unit) & 0xFFFFFFFF
    return value - (1 << 32) if value >= (1 << 31) else value


def _base36(number: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if number == 0:
        return "0"
    out = []
    while number:
        number, rem = divmod(number, 36)
        out.append(digits[rem])
    return "".join(reversed(out))


def project_key(path_text: str) -> str:
    """Claude's project directory name for a working directory string."""
    units = _utf16_units(path_text)
    sanitized = "".join(chr(u) if chr(u) in _ALNUM else "-" for u in units)
    if len(units) <= MAX_KEY_LENGTH:
        return sanitized
    return f"{sanitized[:MAX_KEY_LENGTH]}-{_base36(abs(_js_hash(path_text)))}"


# ---- git checkout root (port of E8u / A8u) --------------------------------

def _entry(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None


def _git_marker(path: Path) -> bool:
    info = _entry(path)
    if info is None:
        return False
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise NativeHeld(f"Linked .git entry is not supported for memory lookup: {path}")
    return stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)


def _checkout_root(cwd: str) -> Path | None:
    current = Path(os.path.abspath(cwd))
    for candidate in [current, *current.parents]:
        if _git_marker(candidate / ".git"):
            return candidate
    return None


def _canonical_root(root: Path, published: Path | None = None) -> Path:
    """``published`` is the path ``root`` will occupy after publication when
    ``root`` is a staged copy; the worktree pointer chain is evaluated as the
    CLI will see it there."""
    marker = root / ".git"
    if not stat.S_ISREG(marker.lstat().st_mode):
        return published or root
    text = marker.read_text(encoding="utf-8").strip()
    if not text.startswith("gitdir:"):
        return published or root
    where = published or root
    gitdir = Path(os.path.abspath(os.path.join(where, text[7:].strip())))
    common_file = gitdir / "commondir"
    pointer = gitdir / "gitdir"
    if not (common_file.is_file() and pointer.is_file()):
        return where
    for probe in (common_file, pointer):
        if stat.S_ISLNK(probe.lstat().st_mode):
            raise NativeHeld(f"Linked worktree pointer is not supported for memory lookup: {probe}")
    common = Path(os.path.abspath(os.path.join(gitdir, common_file.read_text(encoding="utf-8").strip())))
    if Path(os.path.abspath(gitdir.parent)) != common / "worktrees":
        return where
    back = Path(os.path.abspath(os.path.join(gitdir, pointer.read_text(encoding="utf-8").strip())))
    try:
        if os.path.realpath(back) != os.path.realpath(where / ".git"):
            return where
    except OSError:
        return where
    return common if common.name != ".git" else common.parent


def memory_root(cwd: str, staged: Path | None = None) -> str:
    """The path Claude keys memory on for a process started in ``cwd``.

    ``staged`` is the not-yet-published copy of ``cwd`` (the base scratch
    folder). Its own ``.git`` entry is evaluated as it will read once it sits
    at ``cwd``; ancestors are read from ``cwd``'s real parents."""
    if staged is not None and _git_marker(staged / ".git"):
        return str(_canonical_root(staged, Path(os.path.abspath(cwd))))
    root = _checkout_root(cwd)
    if root is None:
        return cwd
    return str(_canonical_root(root))


# ---- override detection (port of OEa.resolve inputs) ----------------------

def _managed_settings() -> Path:
    if os.name == "nt":
        base = os.environ.get("PROGRAMDATA") or "C:\\ProgramData"
        return Path(base) / "ClaudeCode" / "managed-settings.json"
    if os.uname().sysname == "Darwin":  # pragma: no cover - platform branch
        return Path("/Library/Application Support/ClaudeCode/managed-settings.json")
    return Path("/etc/claude-code/managed-settings.json")  # pragma: no cover


def _setting(path: Path) -> tuple[str, Any] | None:
    info = _entry(path)
    if info is None:
        return None
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise NativeHeld(f"Linked settings file is not supported for memory lookup: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise NativeHeld(f"Settings file could not be read for memory lookup: {path} ({exc})") from exc
    if not isinstance(data, dict) or "autoMemoryDirectory" not in data:
        return None
    return str(path), data.get("autoMemoryDirectory")


def detect_override(env: dict[str, str], config: Path, cwd: str) -> str | None:
    """Return a description of any memory-directory override that applies.

    Precedence in the binary is policy > flag > local > project > user. Flag
    settings are delivered remotely and cannot be read here; only inputs that
    actually exist on this machine are consulted.
    """
    if env.get(OVERRIDE_ENV, "").strip():
        return f"environment {OVERRIDE_ENV}"
    for label, path in (("managed", _managed_settings()),
                        ("local", Path(cwd) / ".claude" / "settings.local.json"),
                        ("project", Path(cwd) / ".claude" / "settings.json"),
                        ("user", config / "settings.json")):
        found = _setting(path)
        if found is not None and found[1]:
            return f"{label} settings autoMemoryDirectory in {found[0]}"
    return None


def config_dir(env: dict[str, str], fallback: Path) -> Path:
    remote = env.get(REMOTE_ENV, "").strip()
    return Path(remote) if remote else fallback


# ---- staging ---------------------------------------------------------------

def _plain(path: Path) -> None:
    from .desktop_import import _plain as check
    check(path)


def _walk(root: Path) -> list[tuple[Path, int]]:
    """Regular files below ``root`` in stable order; reparse points refuse."""
    from .desktop_import import ImportRefused
    out: list[tuple[Path, int]] = []
    pending = [root]
    while pending:
        folder = pending.pop()
        for child in sorted(folder.iterdir(), key=lambda p: p.name):
            try:
                _plain(child)
            except ImportRefused as exc:
                raise NativeHeld(str(exc)) from exc
            info = child.lstat()
            if stat.S_ISDIR(info.st_mode):
                pending.append(child)
            elif stat.S_ISREG(info.st_mode):
                out.append((child, info.st_size))
            else:
                raise NativeHeld(f"Unsupported entry in memory directory: {child}")
            if len(out) > MAX_MEMORY_FILES:
                raise NativeHeld(f"Memory directory exceeds {MAX_MEMORY_FILES} files")
    return out


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _manifest(root: Path) -> dict[str, str]:
    return {file.relative_to(root).as_posix(): _digest(file) for file, _ in _walk(root)}


def source_memory(source_profile: Path, source_cwd: str, env: dict[str, str]) -> Path | None:
    """The memory directory Claude used for a V1 agent, or None when absent."""
    config = config_dir(env, source_profile)
    override = detect_override(env, config, source_cwd)
    if override:
        raise NativeHeld(f"Unsupported memory override at source: {override}")
    folder = config / "projects" / project_key(memory_root(source_cwd)) / MEMORY_DIR
    _plain(folder)
    info = _entry(folder)
    if info is None:
        return None
    if not stat.S_ISDIR(info.st_mode):
        raise NativeHeld(f"Memory path is not a directory: {folder}")
    return folder


def destination_memory(destination_profile: Path, destination_cwd: str,
                       env: dict[str, str], settings_cwd: str,
                       staged_scratch: Path | None = None) -> tuple[Path, str]:
    """``settings_cwd`` holds the project settings that will land in the
    destination scratch folder (the copied source folder), which does not exist
    yet when this runs; ``staged_scratch`` is that copy for the ``.git`` check."""
    config = config_dir(env, destination_profile)
    override = detect_override(env, config, settings_cwd)
    if override:
        raise NativeHeld(f"Unsupported memory override at destination: {override}")
    key = project_key(memory_root(destination_cwd, staged_scratch))
    folder = config / "projects" / key / MEMORY_DIR
    _plain(folder)
    return folder, key


def prepare(source: Path, dest: Path, slug: str, base: str, stage: Path | None,
            sources: dict, env: dict[str, str], destination_profile: Path) -> dict[str, Any]:
    """Stage one base scratch folder's memory. Never writes outside ``stage``.

    With ``stage=None`` (preview) nothing is copied: the same checks run and
    the manifest is computed from the source only.
    """
    from .desktop_import import _copy_file
    source_cwd = str(source / "scratch" / slug / base)
    destination_cwd = str(dest / "scratch" / slug / base)
    meta: dict[str, Any] = {"status": "held", "base": base, "source_cwd": source_cwd,
                            "destination_cwd": destination_cwd}
    try:
        source_profile = Path(sources.get("claude_profile") or source.parent / ".claude")
        folder = source_memory(source_profile, source_cwd, env)
        staged_scratch = (stage / "files" / "scratch" / slug / base) if stage is not None \
            else Path(source_cwd)
        target, key = destination_memory(destination_profile, destination_cwd, env, source_cwd,
                                         staged_scratch if staged_scratch.is_dir() else None)
        meta.update(key=key, destination=str(target))
        if folder is None:
            meta.update(status="none", reason="No source memory directory")
            return meta
        meta["source"] = str(folder)
        files = _walk(folder)
        total = sum(size for _, size in files)
        if total > MAX_MEMORY_BYTES:
            raise NativeHeld(f"Memory directory exceeds {MAX_MEMORY_BYTES} bytes")
        manifest: dict[str, str] = {}
        if stage is None:
            manifest = {file.relative_to(folder).as_posix(): _digest(file) for file, _ in files}
        else:
            staged = stage / MEMORY_DIR / base
            staged.mkdir(parents=True)
            for file, _ in files:
                rel = file.relative_to(folder).as_posix()
                manifest[rel] = _copy_file(file, staged / rel)
        existing = _entry(target)
        if existing is not None:
            if not stat.S_ISDIR(existing.st_mode):
                raise NativeHeld(f"Destination memory path exists and is not a directory: {target}")
            if _manifest(target) != manifest:
                raise NativeHeld(f"Destination memory already exists with different content: {target}")
            meta["identical"] = True
        meta.update(status="ready", files=len(manifest), bytes=total,
                    archive=str(Path("imports") / slug / MEMORY_DIR / base))
        if stage is not None:
            (staged.parent / f"{base}.manifest.json").write_text(
                json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
        return meta
    except (NativeHeld, OSError, ValueError) as exc:
        meta["reason"] = str(exc)
        return meta


def _groups(doc: dict) -> dict[str, dict[str, Any]]:
    """Base scratch folder -> memory metadata recorded on any node in it."""
    out: dict[str, dict[str, Any]] = {}
    for nid, node in doc.get("nodes", {}).items():
        meta = node.get("desktop_import", {}).get(MEMORY_DIR)
        if isinstance(meta, dict):
            out.setdefault(nid.split("@")[0], meta)
    return out


def hold_shared_destinations(metas: dict[str, dict[str, Any]]) -> None:
    """Claude keys memory on the checkout root when a scratch folder sits inside
    a git checkout, so several base folders can map to ONE destination. That is
    shared, not independent, memory: hold every base in such a set that has
    memory to carry."""
    by_destination: dict[str, list[str]] = {}
    for base, meta in metas.items():
        if meta.get("destination"):
            # Path normalization (case-insensitive on Windows) so two spellings
            # of one directory are held together rather than refused later.
            by_destination.setdefault(os.path.normcase(os.path.normpath(meta["destination"])),
                                      []).append(base)
    for destination, bases in by_destination.items():
        if len(bases) < 2 or not any(metas[b].get("status") == "ready" for b in bases):
            continue
        others = ", ".join(sorted(bases))
        for base in bases:
            if metas[base].get("status") in {"ready", "none"}:
                metas[base].update(status="held", reason=(
                    f"Destination memory directory would be shared by base folders {others}: "
                    f"{destination}"))


def expected_destination(doc: dict, base: str, meta: dict[str, Any],
                         stage: Path | None = None) -> Path:
    """Recompute the destination from live inputs; a document value never steers a write."""
    from . import supervisor
    from .desktop_native_claude_rewind import selected_profile
    env = supervisor.clean_env()
    env.update(supervisor.env_overrides(doc["slug"], base))
    key = str(meta.get("key") or "")
    staged = (stage / "files" / "scratch" / doc["slug"] / base) if stage is not None else None
    if staged is not None and not staged.is_dir():
        staged = None
    if not key or key != project_key(memory_root(str(meta.get("destination_cwd") or ""), staged)):
        raise NativeHeld(f"Recorded memory key for {base} does not match its destination cwd")
    return config_dir(env, selected_profile(doc["slug"], base)) / "projects" / key / MEMORY_DIR


def check_publishable(doc: dict, stage: Path | None = None) -> None:
    """Refuse before any profile write when a destination changed since staging.

    An existing destination accepted as identical is compared again by
    content, so a file edited between staging and publication refuses the
    import and is left exactly as found."""
    from .desktop_import import ImportRefused
    seen: dict[Path, str] = {}
    for base, meta in _groups(doc).items():
        if meta.get("status") != "ready":
            continue
        target = Path(meta["destination"])
        try:
            if expected_destination(doc, base, meta, stage) != target:
                raise ImportRefused(f"Destination memory path for {base} is not the expected profile location", 409)
        except NativeHeld as exc:
            raise ImportRefused(str(exc), 409) from exc
        if target in seen:
            raise ImportRefused(f"Base folders {seen[target]} and {base} share one destination memory directory", 409)
        seen[target] = base
        _plain(target)
        exists = _entry(target) is not None
        if exists != bool(meta.get("identical")):
            raise ImportRefused(f"Destination memory for {base} changed before publication", 409)
        if exists and stage is not None:
            staged = stage / MEMORY_DIR / base
            if _manifest(target) != _manifest(staged):
                raise ImportRefused(
                    f"Destination memory for {base} was identical at staging but its content "
                    "changed before publication; it was left unchanged", 409)


def _discard_partial(folder: Path, manifest: list[str]) -> None:
    """Remove only the files this process wrote into its own temporary folder,
    then the empty directories bottom-up. Anything unexpected stays."""
    for rel in manifest:
        try:
            path = folder / rel
            if stat.S_ISREG(path.lstat().st_mode):
                path.unlink()
        except OSError:
            pass
    for dirpath, dirnames, _ in sorted(os.walk(folder, topdown=False), key=lambda row: -len(row[0])):
        try:
            os.rmdir(dirpath)
        except OSError:
            pass


def publish(doc: dict, stage: Path) -> None:
    """Create each destination memory directory atomically from staging.

    Files are copied into an exclusively created sibling temporary folder and
    the folder is renamed onto the ``memory`` name, which fails if that name
    appeared in the meantime. A failed copy therefore never leaves a partial
    ``memory`` directory in the profile."""
    from .desktop_import import ImportRefused, _copy_file
    check_publishable(doc, stage)
    for base, meta in _groups(doc).items():
        if meta.get("status") != "ready" or meta.get("identical"):
            continue
        target = Path(meta["destination"])
        target.parent.mkdir(parents=True, exist_ok=True)
        building = target.parent / f".{MEMORY_DIR}-import-{uuid.uuid4().hex}"
        building.mkdir()  # exclusive
        staged = stage / MEMORY_DIR / base
        written: list[str] = []
        try:
            for file, _ in _walk(staged):
                rel = file.relative_to(staged)
                # Recorded BEFORE the attempt so a file created and then
                # abandoned mid-write is still discarded on failure.
                written.append(rel.as_posix())
                _copy_file(file, building / rel)
            # Atomic swap onto a name that must not exist. On Windows a rename
            # onto an existing directory fails, which is what keeps this
            # exclusive; POSIX would allow an existing EMPTY directory, and
            # check_publishable has already refused an existing destination.
            os.rename(building, target)
        except (OSError, ImportRefused) as exc:
            _discard_partial(building, written)
            raise ImportRefused(f"Could not publish memory for {base}: {exc}", 409) from exc


def hold_reason(doc: dict, nid: str) -> str | None:
    """Native continuation waits while carried memory is unavailable."""
    node = doc.get("nodes", {}).get(nid, {})
    meta = node.get("desktop_import", {}).get(MEMORY_DIR)
    if not isinstance(meta, dict):
        return None
    status = meta.get("status")
    if status == "none":
        return None
    if status != "ready":
        return f"Imported Claude memory is unavailable: {meta.get('reason') or 'not carried'}"
    try:
        target = Path(meta["destination"])
        _plain(target)
        if not target.is_dir():
            return "Imported Claude memory directory is missing from the destination profile"
        # The scratch folder exists now: the key Claude will use must still be
        # the one the memory was published under (checkout layout can change).
        actual = project_key(memory_root(str(meta["destination_cwd"])))
        if actual != meta.get("key"):
            return (f"Imported Claude memory was published under key {meta.get('key')} but the "
                    f"working directory now keys on {actual}")
    except NativeHeld as exc:
        return f"Imported Claude memory key cannot be verified: {exc}"
    except (OSError, ValueError, KeyError):
        return "Imported Claude memory path failed validation"
    return None
