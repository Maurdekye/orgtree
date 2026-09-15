# pyright: strict
"""Resolve the identity of the artifact that started this backend.

The source checkout and an installed package have different identity sources.
Git is authoritative only when the Python files are running from a verified
checkout.  A packaged runtime has no repository to inspect, so it uses the
build-info file copied into its resources.  There is deliberately no fallback
to the process cwd: a nearby repository is not evidence about this artifact.

The installed VERSION follows the same rule and is reported only where there is
an authoritative answer: the packaged metadata generated with the build.  Git
knows commits, not releases, so a source checkout reports no version rather than
quoting a package.json that any checkout can change.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
from typing import Any, Callable


UNKNOWN = "unknown"
_SHA = re.compile(r"^[0-9a-f]{40}$")
# A semantic version with an optional prerelease/build label, bounded in length.
# This is deliberately narrow: the value is rendered into a notice delivered to
# every live agent, so a metadata file carrying a newline, a filesystem path or
# a paragraph of text would otherwise reach them verbatim.
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,48})?$")


def _unknown() -> dict[str, Any]:
    return {
        "commit": UNKNOWN,
        "commit_short": UNKNOWN,
        "branch": None,
        "dirty": False,
        "provenance": UNKNOWN,
        # There is no installed version to report when the artifact cannot be
        # identified at all.  None means "no authoritative answer", never "0".
        "version": None,
    }


def _version_of(value: dict[str, Any]) -> str | None:
    """The version a packaged build recorded for itself, or ``None``.

    Validated rather than trusted.  A version that does not survive validation
    is reported as absent — it must never suppress the commit and provenance
    beside it, which are the part of the notice that always has to arrive.
    """
    version: Any = value.get("version")
    if not isinstance(version, str):
        return None
    version = version.strip()
    return version if _VERSION.fullmatch(version) else None


def _read_metadata(path: Path) -> dict[str, Any] | None:
    """Read and validate the generated package metadata, without trusting it."""
    try:
        value: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    commit = value.get("commit") if isinstance(value, dict) else None
    if not isinstance(commit, str) or not _SHA.fullmatch(commit):
        return None
    # A package metadata file must be generated build output, not an arbitrary
    # JSON file that happens to contain a hash.  These fields are emitted by
    # tools/build.mjs and keep malformed/partial fixtures on the honest path.
    if value.get("channel") not in ("release", "dev"):
        return None
    if not isinstance(value.get("dirty"), bool):
        return None
    return {
        "commit": commit,
        "commit_short": commit[:7],
        "branch": None,
        "dirty": value["dirty"],
        "provenance": "packaged",
        # The one authoritative statement of which release is installed. A dev
        # channel package carries its own `-dev.g<commit>` label here, so the
        # string says what it is without anybody inferring it.
        "version": _version_of(value),
    }


def _verified_checkout(root: Path, run: Callable[..., subprocess.CompletedProcess[str]]) -> bool:
    """Return true only when *root* itself is a real Git checkout."""
    try:
        marker = root / ".git"
        if not marker.exists():
            return False
        result = run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return False
        output = result.stdout if isinstance(result.stdout, str) else ""
        return Path(output.strip()).resolve() == root.resolve()
    except (OSError, subprocess.SubprocessError):
        return False


def resolve_build_identity(
    artifact_root: Path,
    *,
    packaged_info: Path | None = None,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    """Resolve the build identity for code loaded from ``artifact_root``.

    ``artifact_root`` is derived from this module's own path by the caller.
    It is never replaced with cwd or another repository.  A verified checkout
    uses Git; otherwise the packaged metadata beside the installed resources
    is used.  Every failure returns the same explicit unknown identity.
    """
    root = artifact_root.resolve()
    if _verified_checkout(root, run):
        try:
            commit_result = run(
                ["git", "-C", str(root), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
            commit = commit_result.stdout if isinstance(commit_result.stdout, str) else ""
            commit = commit.strip()
            if commit_result.returncode != 0 or not _SHA.fullmatch(commit):
                return _unknown()
            branch_result = run(
                ["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
            dirty_result = run(
                ["git", "-C", str(root), "status", "--porcelain", "-uno"],
                capture_output=True, text=True, timeout=10,
            )
            branch_output = branch_result.stdout if isinstance(branch_result.stdout, str) else ""
            dirty_output = dirty_result.stdout if isinstance(dirty_result.stdout, str) else ""
            branch = branch_output.strip() if branch_result.returncode == 0 else ""
            return {
                "commit": commit,
                "commit_short": commit[:7],
                "branch": branch if branch not in ("", "HEAD", "main") else None,
                "dirty": bool(dirty_output.strip()) if dirty_result.returncode == 0 else False,
                "provenance": "source",
                # ⚠ DELIBERATELY NONE, and not package.json's version. A source
                # checkout has no installed release: the number in package.json
                # is whatever the working tree currently says, it changes with a
                # checkout, and reporting it would make a notice about what is
                # RUNNING quote something nobody installed.
                "version": None,
            }
        except (OSError, subprocess.SubprocessError):
            return _unknown()

    info = packaged_info or (root / "build-info.json")
    return _read_metadata(info) or _unknown()


def artifact_root_for(module_file: str) -> Path:
    """Find resources/source root relative to this module, never relative cwd."""
    return Path(module_file).resolve().parents[3]
