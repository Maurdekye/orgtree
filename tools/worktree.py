"""Small, fail-closed worktree lifecycle helper.

This module intentionally does not call ``git config`` or mutate a repository.
It is used by the host operator to inspect checkouts, describe dependency
setup, repair registered paths after an agent rename, and preview cleanup.
Cleanup is opt-in and can only unlink a junction/reparse point that has been
validated as an owned link; it never follows the link or removes its target.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat
import subprocess
from typing import Any, Iterable, Mapping


REPARSE = 0x400
DEFAULT_HIDDEN = {".git", ".worktree", ".worktree-state.json"}


def canonical(path: str | os.PathLike[str]) -> str:
    """Return a case-normalized absolute path without following links."""
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def contained(path: str | os.PathLike[str], root: str | os.PathLike[str]) -> bool:
    """Check lexical containment; unlike ``realpath`` this never traverses."""
    try:
        return os.path.commonpath((canonical(path), canonical(root))) == canonical(root)
    except ValueError:
        return False


def is_reparse(path: str | os.PathLike[str]) -> bool:
    """Inspect a directory entry without following it."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE)


def _entry_kind(path: str) -> str:
    try:
        info = os.lstat(path)
    except OSError:
        return "missing"
    if stat.S_ISLNK(info.st_mode):
        return "symlink"
    if getattr(info, "st_file_attributes", 0) & REPARSE:
        return "reparse"
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    return "file"


def _entry_identity(path: str) -> tuple[str, int | None] | None:
    """Return link kind plus Windows reparse tag without following it."""
    try:
        info = os.lstat(path)
    except OSError:
        return None
    kind = "symlink" if stat.S_ISLNK(info.st_mode) else "reparse" if getattr(info, "st_file_attributes", 0) & REPARSE else "file"
    return kind, getattr(info, "st_reparse_tag", None)


def _git(root: str, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", root, *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git operation failed")
    return result.stdout


def parse_worktree_porcelain(raw: str) -> list[dict[str, Any]]:
    """Parse ``git worktree list --porcelain`` output without path traversal."""
    rows: list[dict[str, Any]] = []
    row: dict[str, Any] = {}
    for line in raw.replace("\x00", "\n").splitlines() + [""]:
        if not line:
            if row:
                rows.append(row)
                row = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            row["path"] = value
        elif key == "HEAD":
            row["head"] = value
        elif key == "branch":
            row["branch"] = value
        elif key in {"bare", "detached", "locked", "prunable"}:
            row[key] = value or True
    return rows


def _status(root: str) -> tuple[bool, bool, bool]:
    """Return dirty, unmerged, and readable status flags."""
    try:
        raw = _git(root, "status", "--porcelain=v2", "--untracked-files=all")
    except (OSError, RuntimeError):
        return True, True, False
    dirty = bool(raw.strip())
    unmerged = any(line.startswith("u ") or line.startswith("UU ") for line in raw.splitlines())
    return dirty, unmerged, True


def inventory(
    repository: str,
    *,
    owners: Mapping[str, str] | None = None,
    active_refs: Mapping[str, Iterable[str]] | None = None,
    query: str | None = None,
    include_hidden: bool = False,
    limit: int = 60,
) -> dict[str, Any]:
    """Return a compact, filterable inventory and honest omitted counts.

    ``owners`` and ``active_refs`` are deliberately caller-supplied. Git does
    not know which application identity owns a checkout or which external
    reference is active, so inventing those values would make cleanup unsafe.
    """
    if limit < 1:
        raise ValueError("limit must be positive")
    rows = parse_worktree_porcelain(_git(repository, "worktree", "list", "--porcelain"))
    owners = owners or {}
    active_refs = active_refs or {}
    visible: list[dict[str, Any]] = []
    hidden = 0
    for row in rows:
        path = str(row.get("path", ""))
        branch = str(row.get("branch", ""))
        owner = owners.get(path) or owners.get(canonical(path))
        refs = list(active_refs.get(branch, ()))
        dirty, unmerged, readable = (False, False, True)
        if not row.get("bare"):
            dirty, unmerged, readable = _status(path)
        item = {
            "repository": canonical(repository),
            "path": path,
            "branch": branch or None,
            "owner": owner,
            "dirty": dirty,
            "unmerged": unmerged,
            "readable": readable,
            "active_references": refs,
            "active": bool(refs),
            "bare": bool(row.get("bare")),
            "locked": bool(row.get("locked")),
            "prunable": bool(row.get("prunable")),
        }
        if not include_hidden and path and os.path.basename(path) in DEFAULT_HIDDEN:
            hidden += 1
            continue
        if query and query.casefold() not in json.dumps(item, sort_keys=True).casefold():
            hidden += 1
            continue
        visible.append(item)
    omitted = max(0, len(visible) - limit)
    shown = visible[:limit]
    return {
        "repository": canonical(repository),
        "worktrees": shown,
        "total": len(rows),
        "visible": len(visible),
        "hidden": hidden,
        "omitted": omitted,
        "complete": omitted == 0,
        "dirty": sum(bool(r["dirty"]) for r in visible),
        "unmerged": sum(bool(r["unmerged"]) for r in visible),
        "active": sum(bool(r["active"]) for r in visible),
    }


def dependency_setup(worktree: str, *, package_manager: str | None = None,
                     dependency_source: str | None = None,
                     apply: bool = False) -> dict[str, Any]:
    """Describe deterministic local setup without granting Git metadata writes.

    The returned command is intentionally data only. A caller may execute it
    after review; this helper never runs package managers or writes ``.git``.
    """
    root = canonical(worktree)
    if _entry_kind(root) != "directory":
        raise ValueError("worktree must be a real directory")
    link: dict[str, Any] | None = None
    if dependency_source:
        source = canonical(dependency_source)
        destination = os.path.join(root, "node_modules")
        if _entry_kind(source) != "directory":
            raise ValueError("dependency source must be a real directory")
        existing = _entry_kind(destination)
        if existing not in {"missing", "directory", "symlink", "reparse"}:
            raise ValueError("node_modules destination is not a directory")
        if existing in {"symlink", "reparse"}:
            raise ValueError("node_modules is already a link; refusing to replace it")
        if existing == "directory":
            raise ValueError("node_modules directory already exists; refusing to replace it")
        link = {"source": source, "destination": destination,
                "command": ["cmd", "/c", "mklink", "/J", destination, source],
                "ready": True}
        if apply:
            if os.name != "nt":
                raise ValueError("junction setup is supported on Windows only")
            result = subprocess.run(link["command"], check=False,
                                    capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or "dependency junction creation failed")
            if not is_reparse(destination):
                raise RuntimeError("dependency junction was not created; refusing to continue")
            link["applied"] = True
        else:
            link["applied"] = False
    package_json = os.path.isfile(os.path.join(root, "package.json"))
    lockfile = next((n for n in ("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml")
                     if os.path.isfile(os.path.join(root, n))), None)
    manager = package_manager or ("npm" if package_json else None)
    if manager not in {None, "npm", "yarn", "pnpm"}:
        raise ValueError("unsupported package manager")
    command = None
    if package_json and manager == "npm":
        command = [manager, "ci"] if lockfile else [manager, "install"]
    elif package_json and manager == "yarn":
        command = [manager, "install", "--frozen-lockfile"] if lockfile else [manager, "install"]
    elif package_json and manager == "pnpm":
        command = [manager, "install", "--frozen-lockfile"] if lockfile else [manager, "install"]
    result = {
        "worktree": root,
        "package_manager": manager,
        "lockfile": lockfile,
        "command": command,
        "git_metadata_write": False,
        "ready": bool(command),
        "note": "Run this explicitly in the fresh worktree; no generic Git write is granted.",
    }
    if link is not None:
        result["dependency_link"] = link
    return result


def _replace_contained(value: str, old_root: str, new_root: str) -> tuple[str, bool]:
    old = canonical(old_root)
    current = canonical(value)
    if current == old or contained(current, old):
        suffix = current[len(old):].lstrip("\\/")
        return os.path.join(canonical(new_root), suffix), True
    return value, False


def repair_registered_worktrees(
    registry: Mapping[str, Any], old_root: str, new_root: str
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Repair only registered paths contained by ``old_root``.

    No old-path alias is created. Unrelated paths, including similarly named
    siblings, remain byte-for-byte unchanged.
    """
    old = canonical(old_root)
    new = canonical(new_root)
    repaired = json.loads(json.dumps(registry))
    moved: list[dict[str, str]] = []
    repos = repaired.get("repositories", {})
    if not isinstance(repos, dict):
        raise ValueError("registry repositories must be an object")
    for repo in repos.values():
        if not isinstance(repo, dict):
            continue
        agents = repo.get("worktree_agents")
        if not isinstance(agents, dict):
            continue
        for agent, paths in list(agents.items()):
            if isinstance(paths, str):
                paths = [paths]
            if not isinstance(paths, list):
                continue
            updated = []
            for path in paths:
                if not isinstance(path, str):
                    updated.append(path)
                    continue
                value, changed = _replace_contained(path, old, new)
                updated.append(value)
                if changed:
                    moved.append({"agent": str(agent), "old": path, "new": value})
            agents[agent] = updated
    return repaired, moved


def _owned_link(path: str, root: str, owned: Iterable[str]) -> tuple[bool, str]:
    if not contained(path, root):
        return False, "outside cleanup root"
    if canonical(path) not in {canonical(p) for p in owned}:
        return False, "not registered as an owned link"
    kind = _entry_kind(path)
    if kind not in {"symlink", "reparse"}:
        return False, "not a junction or reparse point"
    return True, "validated owned link"


def cleanup_preview(root: str, candidates: Iterable[str], *, owned: Iterable[str] = ()) -> dict[str, Any]:
    """Preview cleanup targets; optionally callers may unlink approved entries.

    This function only reads directory entries. It does not walk candidates,
    resolve targets, or remove anything. Unknown reparse points are blocked.
    """
    root = canonical(root)
    entries = []
    for candidate in candidates:
        path = canonical(candidate if os.path.isabs(candidate) else os.path.join(root, candidate))
        ok, reason = _owned_link(path, root, owned)
        entry: dict[str, Any] = {"path": path, "action": "unlink" if ok else "preserve", "reason": reason}
        if ok:
            entry["owned"] = True
            entry["kind"] = _entry_kind(path)
            entry["identity"] = _entry_identity(path)
            try:
                entry["target"] = os.readlink(path)
            except OSError:
                entry["action"] = "preserve"
                entry["reason"] = "reparse target could not be validated"
                entry["target"] = None
        entries.append(entry)
    return {
        "root": root,
        "targets": entries,
        "unlinkable": sum(e["action"] == "unlink" for e in entries),
        "preserved": sum(e["action"] != "unlink" for e in entries),
        "retirement_authorized": False,
        "applied": False,
    }


def apply_cleanup(preview: Mapping[str, Any], *, confirm: bool = False) -> dict[str, Any]:
    """Unlink only a previously previewed, validated link itself."""
    if not confirm:
        raise ValueError("cleanup requires explicit confirmation after preview")
    result = json.loads(json.dumps(preview))
    removed: list[str] = []
    for entry in result.get("targets", []):
        path = entry.get("path")
        if (entry.get("action") != "unlink" or entry.get("owned") is not True
                or not isinstance(path, str)):
            continue
        expected_identity = entry.get("identity")
        identity_changed = ("identity" in entry and
                            (not isinstance(expected_identity, (list, tuple)) or
                             _entry_identity(path) != tuple(expected_identity)))
        if (_entry_kind(path) != entry.get("kind") or entry.get("kind") not in {"symlink", "reparse"}
                or identity_changed):
            entry["action"], entry["reason"] = "preserve", "changed since preview"
            continue
        try:
            current_target = os.readlink(path)
        except OSError:
            current_target = None
        if entry.get("target") is None or current_target != entry.get("target"):
            entry["action"], entry["reason"] = "preserve", "link target changed since preview"
            continue
        try:
            os.unlink(path)
        except (IsADirectoryError, PermissionError):
            # On Windows a directory junction is removed with rmdir. lstat
            # was already used for validation; do not call isdir(), which
            # would follow an unvalidated target.
            try:
                info = os.lstat(path)
            except OSError:
                entry["action"], entry["reason"] = "preserve", "changed since preview"
                continue
            if not stat.S_ISDIR(info.st_mode):
                entry["action"], entry["reason"] = "preserve", "unlink refused"
                continue
            os.rmdir(path)
        removed.append(path)
        entry["action"] = "unlinked"
    result["removed"] = removed
    result["applied"] = True
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="safe worktree inventory and cleanup preview")
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("inventory")
    inv.add_argument("repository")
    inv.add_argument("--query")
    inv.add_argument("--limit", type=int, default=60)
    inv.add_argument("--include-hidden", action="store_true")
    setup = sub.add_parser("setup")
    setup.add_argument("worktree")
    setup.add_argument("--package-manager")
    setup.add_argument("--dependency-source")
    setup.add_argument("--apply", action="store_true")
    preview = sub.add_parser("cleanup-preview")
    preview.add_argument("root")
    preview.add_argument("candidates", nargs="+")
    args = parser.parse_args(argv)
    if args.command == "inventory":
        value = inventory(args.repository, query=args.query, limit=args.limit, include_hidden=args.include_hidden)
    elif args.command == "setup":
        value = dependency_setup(args.worktree, package_manager=args.package_manager,
                                 dependency_source=args.dependency_source, apply=args.apply)
    else:
        value = cleanup_preview(args.root, args.candidates)
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
