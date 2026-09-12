"""Side-effect-free diagnostics for effective agent scope.

This module is deliberately a small adapter between the stored scope and a
failed provider/tool invocation.  It does not grant access, execute a command,
read credentials, or treat a provider error as an entitlement.  Callers pass
the already-authoritative grants and provider observations, and receive a
stable explanation of which layer made a request succeed or fail.

The output is suitable for a support report and for a minimal reproduction.
Paths are canonicalized with :mod:`gitworkspace`; MCP expansion uses the same
pure ceiling intersection as the launcher.
"""
from __future__ import annotations

import os
import re
import stat
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from . import gitworkspace
from .ledger import expand_mcp, norm_dirs


OPERATIONS = frozenset({"read", "write", "execute", "shell", "mcp"})
_PATH_OPERATIONS = frozenset({"read", "write", "execute"})
_MCP_RE = re.compile(r"^mcp__([^_].*?)__(.+)$")
_NET_MARKERS = frozenset({
    "econnrefused", "econnreset", "etimedout", "enetunreach",
    "ehostunreach", "enotfound", "socket hang up", "fetch failed",
    "network error", "connection refused", "connection reset",
})
_SCHEMA_KEYS = frozenset({"inputSchema", "input_schema", "schema"})


def _norm(path: str) -> str:
    """Use the Git adapter's platform-aware canonical path policy."""
    return gitworkspace.canonical(os.fspath(path))


def _lexical(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(os.fspath(path))))


def _under(path: str, root: str) -> bool:
    # Real-path containment rejects a link/junction which escapes its grant;
    # commonpath avoids the ``/tmp/org`` vs ``/tmp/org-other`` prefix bug.
    return gitworkspace.within(path, root)


def _lexically_under(path: str, root: str) -> bool:
    """Check the spelling's containment before resolving links."""
    try:
        return os.path.commonpath((_lexical(path), _lexical(root))) == _lexical(root)
    except ValueError:
        return False


def _entry_kind(path: str) -> str:
    try:
        info = os.lstat(path)
    except OSError:
        return "missing"
    if os.path.islink(path):
        return "symlink"
    if getattr(info, "st_file_attributes", 0) & gitworkspace.REPARSE_ATTRIBUTE:
        return "reparse"
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    return "file"


def _reparse_components(path: str) -> list[dict[str, str]]:
    """Return link/reparse entries on the path without traversing their targets."""
    absolute = os.path.abspath(path)
    drive, tail = os.path.splitdrive(absolute)
    current = drive + os.sep if drive else os.sep
    parts = [p for p in tail.replace("\\", os.sep).split(os.sep) if p]
    found: list[dict[str, str]] = []
    for part in parts:
        current = os.path.join(current, part)
        kind = _entry_kind(current)
        if kind in {"symlink", "reparse"}:
            found.append({"path": current, "kind": kind})
    return found


def _nearest_git(path: str) -> str | None:
    """Find the nearest visible ``.git`` marker without running Git."""
    current = _lexical(path)
    if _entry_kind(current) != "directory":
        current = os.path.dirname(current)
    while current and current != os.path.dirname(current):
        marker = os.path.join(current, ".git")
        if _entry_kind(marker) in {"directory", "file"}:
            return current
        current = os.path.dirname(current)
    return None


def _grant_for(path: str, scratch: str, grants: Iterable[Any]) -> dict[str, Any]:
    """Resolve the most-specific explicit grant; scratch is an effective root."""
    target = _norm(path)
    own = _norm(scratch)
    if _under(target, own):
        return {"source": "own_scratch", "path": own, "mode": "rw", "explicit": True}
    matches: list[tuple[int, str, str]] = []
    for raw in norm_dirs(grants):
        root = _norm(raw["path"])
        if _under(target, root):
            matches.append((len(root), root, raw["mode"]))
    if not matches:
        return {"source": "none", "path": None, "mode": None, "explicit": False}
    # Equal-length aliases may occur on a case-insensitive host.  If their
    # declarations disagree, retain the restrictive answer; a diagnostic must
    # never turn a duplicate read-only grant into write access by tuple order.
    _, root, mode = max(matches, key=lambda item: (item[0], item[1], item[2] == "ro"))
    return {"source": "directory_grant", "path": root, "mode": mode, "explicit": True}


def _restriction(value: Any, operation: str) -> dict[str, Any]:
    """Normalize an explicit restriction map without guessing from provider."""
    if not isinstance(value, Mapping):
        return {"status": "none", "reason": None}
    raw = value.get(operation)
    if raw in (None, False, "", "none"):
        return {"status": "none", "reason": None}
    if raw is True:
        return {"status": "restricted", "reason": "provider or OS policy"}
    return {"status": "restricted", "reason": str(raw)}


def diagnose_target(
    target: str,
    operation: str,
    *,
    scratch: str,
    grants: Iterable[Any] = (),
    provider: str | None = None,
    provider_restrictions: Mapping[str, Any] | None = None,
    sandboxed: bool = False,
    sandbox_roots: Iterable[str] = (),
    tool_grants: Mapping[str, Any] | None = None,
    git_owner: str | None = None,
) -> dict[str, Any]:
    """Explain the effective decision for one target and one operation.

    ``provider_restrictions`` and ``sandbox_roots`` are observations supplied
    by the caller.  They are intentionally not inferred from a provider name,
    an environment variable, or a failed command.  A read-only grant blocks a
    write, while the agent's own scratch remains writable even when an ancestor
    folder was also supplied as read-only.
    """
    if operation not in OPERATIONS:
        raise ValueError(f"unsupported scope operation: {operation!r}")
    requested = os.fspath(target)
    absolute = _lexical(requested)
    resolved = _norm(requested)
    reparse = _reparse_components(requested)
    scratch_reparse = _reparse_components(scratch)
    grant = _grant_for(requested, scratch, grants)
    scratch_root = _norm(scratch)
    # Check both spellings.  An alias to the parent can reach
    # ``alias\\scratch\\file`` without being lexically under ``scratch``;
    # comparing resolved paths catches that alternate spelling too.
    scratch_escape = bool(
        scratch_reparse and
        (_lexically_under(requested, scratch)
         or _under(requested, scratch)
         or _under(resolved, scratch_root)))
    if scratch_escape:
        # A junction/symlink at the scratch root is not an own-scratch grant:
        # canonicalizing it first would turn a live-data target into a writable
        # seat.  Keep the refusal separate from ordinary grant absence below.
        grant = {"source": "none", "path": None, "mode": None, "explicit": False}
    provider_limit = _restriction(provider_restrictions, operation)
    if operation == "shell" and provider_limit["status"] == "none":
        provider_limit = _restriction(provider_restrictions, "bash")
    sandbox_limit = {"status": "none", "reason": None}
    if sandboxed and operation in _PATH_OPERATIONS:
        roots = [_norm(scratch), *(_norm(p) for p in sandbox_roots)]
        if not any(_under(requested, root) for root in roots):
            sandbox_limit = {"status": "restricted", "reason": "target is not mounted in the sandbox"}
    tool_limit = {"status": "none", "reason": None}
    if operation in {"shell", "mcp"} and isinstance(tool_grants, Mapping):
        # The stored grant calls the shell capability ``bash`` while the
        # diagnostic operation is intentionally shell-neutral.
        key = "bash" if operation == "shell" and "bash" in tool_grants else operation
        raw = tool_grants.get(key)
        missing_mcp = False
        if operation == "mcp" and isinstance(raw, (list, tuple, set)):
            server = str(target).split("__", 2)[1] if str(target).startswith("mcp__") and "__" in str(target)[5:] else ""
            granted_servers = {str(x) for x in raw}
            # ``*`` is the same effective wildcard accepted by ledger's
            # expand_mcp helper; a diagnostic must not report a false refusal
            # for a server that the launcher would deliver.
            missing_mcp = bool(server and "*" not in granted_servers and server not in granted_servers)
        if raw is False or raw is None and key in tool_grants or missing_mcp:
            tool_limit = {"status": "restricted", "reason": f"{operation} tool is not granted"}

    org_allowed = operation not in _PATH_OPERATIONS or (
        grant["mode"] == "rw" or operation == "read" and grant["mode"] == "ro"
    )
    if operation in {"shell", "mcp"} and tool_limit["status"] == "restricted":
        org_allowed = False
    reasons: list[str] = []
    if grant["source"] == "none" and operation in _PATH_OPERATIONS:
        reasons.append("target is outside the own scratch folder and explicit directory grants")
    if scratch_escape:
        reasons.append("own scratch root is a symlink or junction and cannot be trusted")
    if not org_allowed and grant["mode"] == "ro" and operation == "write":
        reasons.append("applicable directory grant is read-only")
    if reparse and not _under(resolved, grant["path"] or scratch):
        reasons.append("link or junction resolves outside the applicable grant")
        org_allowed = False
    restrictions = [provider_limit, sandbox_limit, tool_limit]
    for item in restrictions:
        if item["status"] == "restricted" and item["reason"]:
            reasons.append(str(item["reason"]))
    allowed = org_allowed and all(x["status"] == "none" for x in restrictions)
    if allowed:
        code = "allowed"
    elif sandbox_limit["status"] == "restricted":
        code = "sandbox_restricted"
    elif provider_limit["status"] == "restricted":
        code = "provider_restricted"
    elif tool_limit["status"] == "restricted":
        code = "tool_not_granted"
    elif scratch_escape or reparse:
        code = "path_escape"
    else:
        code = "org_grant_missing_or_read_only"
    return {
        "target": {"requested": requested, "absolute": absolute, "resolved": resolved,
                    "exists": os.path.exists(requested), "kind": _entry_kind(requested),
                    "reparse_components": reparse},
        "scratch": {"root": scratch_root, "reparse_components": scratch_reparse,
                    "trusted": not bool(scratch_reparse)},
        "operation": {"name": operation, "allowed": allowed},
        "org_grant": grant,
        "provider": {"name": provider, **provider_limit},
        "sandbox": {"enabled": bool(sandboxed), **sandbox_limit},
        "tool": tool_limit,
        "git": {"root": _nearest_git(requested), "owner": git_owner,
                "owner_source": "explicit" if git_owner else "unknown"},
        "decision": {"allowed": allowed, "reason_code": code,
                      "reasons": reasons or (["request is within the effective scope"] if allowed else [])},
    }


def shell_result(returncode: int | None, stdout: str = "", stderr: str = "",
                 *, started: bool = True, boundary: bool = False) -> dict[str, Any]:
    """Classify shell evidence without retrying or hiding stderr.

    A nonzero exit with stderr is an observed harness/provider result. An empty
    nonzero result is only a possible in-flight external fault when the command
    started and never reached its boundary; it is never treated as permission.
    """
    err = str(stderr or "")
    lower = err.casefold()
    if returncode == 0:
        outcome, owner = "success", "none"
    elif not started:
        outcome, owner = "not_started", "local_harness"
    elif any(marker in lower for marker in _NET_MARKERS):
        outcome, owner = "external_network_fault", "external_tool"
    elif returncode is not None and err:
        outcome, owner = "command_failed", "provider_or_os"
    elif not boundary:
        outcome, owner = "in_flight_external_fault", "external_tool"
    else:
        outcome, owner = "command_failed", "provider_or_os"
    return {"returncode": returncode, "stdout": str(stdout or ""), "stderr": err,
            "started": bool(started), "boundary": bool(boundary),
            "outcome": outcome, "owner": owner,
            "blocked": outcome != "success"}


def mcp_tool_names(
    registry: Iterable[str] | Mapping[str, Any],
    granted: Iterable[str] = (),
    ceiling: Iterable[str] | None = None,
    observed: Mapping[str, Iterable[str]] | None = None,
) -> list[str]:
    """Derive exact ``mcp__server__tool`` names from active configuration.

    ``registry`` contains server names or server mappings.  When runtime
    ``observed`` tools are available they are authoritative; otherwise this
    returns server prefixes only through :func:`mcp_prefixes`, avoiding a
    fabricated tool name.  Grant expansion delegates to the ledger helper.
    """
    if isinstance(registry, Mapping):
        server_names = [str(k) for k in registry]
    else:
        server_names = [str(k) for k in registry if k]
    active = expand_mcp(granted, ceiling, server_names)
    result: set[str] = set()
    for server in active:
        tools = (observed or {}).get(server)
        if tools is None and isinstance(registry, Mapping):
            config = registry.get(server)
            if isinstance(config, Mapping):
                tools = config.get("tools") if isinstance(config.get("tools"), (list, tuple, set)) else None
        if tools is not None:
            result.update(f"mcp__{server}__{tool}" for tool in tools if str(tool))
    return sorted(result)


def mcp_prefixes(names: Iterable[str]) -> list[str]:
    """Return Grep-safe server prefixes, preserving only parsed MCP names."""
    servers: set[str] = set()
    for name in names:
        match = _MCP_RE.fullmatch(str(name))
        if match:
            servers.add(f"mcp__{match.group(1)}__")
    return sorted(servers)


def schema_names(tool_cards: Iterable[Mapping[str, Any]]) -> dict[str, list[str]]:
    """Expose active MCP card names and their actual schema field spelling.

    MCP uses ``inputSchema`` on the wire.  ``ArtifactMetadata`` is accepted as
    an application object only when a card declares it; this prevents a
    diagnostic from inventing a schema merely because a tool name resembles it.
    """
    cards: list[str] = []
    fields: set[str] = set()
    artifact: list[str] = []
    def declared_artifact(value: Any) -> set[str]:
        found: set[str] = set()
        if isinstance(value, Mapping):
            for key, child in value.items():
                if str(key) == "ArtifactMetadata":
                    found.add("ArtifactMetadata")
                found.update(declared_artifact(child))
        elif isinstance(value, (list, tuple)):
            for child in value:
                found.update(declared_artifact(child))
        return found

    for card in tool_cards:
        name = card.get("name")
        if isinstance(name, str) and name:
            cards.append(name)
        for key in _SCHEMA_KEYS:
            if key in card:
                fields.add(key)
        if card.get("name") == "ArtifactMetadata" or card.get("object") == "ArtifactMetadata":
            artifact.append(str(name or "ArtifactMetadata"))
        for key in _SCHEMA_KEYS:
            artifact.extend(sorted(declared_artifact(card.get(key))))
    return {"tools": sorted(set(cards)), "schema_fields": sorted(fields),
            "artifact_metadata": sorted(set(artifact))}


def reproduction_report(result: Mapping[str, Any], *, command: Sequence[str],
                        owner: str, environment: Mapping[str, Any] | None = None
                        ) -> dict[str, Any]:
    """Build a bounded, honest external-harness reproduction record."""
    return {"owner": owner, "command": [str(x) for x in command],
            "environment": {str(k): str(v) for k, v in (environment or {}).items()},
            "result": {k: result.get(k) for k in
                       ("returncode", "outcome", "owner", "started", "boundary", "blocked")},
            "reproducible": result.get("outcome") not in {"success", "in_flight_external_fault"},
            "bypass": "none: reproduce in the reported shell/provider; changing shells does not alter the grant",
    }


__all__ = ["OPERATIONS", "diagnose_target", "shell_result", "mcp_tool_names",
           "mcp_prefixes", "schema_names", "reproduction_report"]
