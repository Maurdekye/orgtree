"""Accidental storage-access guard for desktop agent descendants, not a sandbox.

Transport variables remain available to authorized MCP tools. Generic repository
scripts must explicitly choose independent storage before importing store.
"""
from __future__ import annotations

import os
from collections.abc import Mapping

LIVE = "ORGTREE_AGENT_PARENT_DATA"
LEGACY = "ORGTREE_AGENT_LEGACY_DATA"


def _canonical(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def child_env(env: dict[str, str], parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """Tag only desktop children; never mutate the engine's environment."""
    parent = os.environ if parent is None else parent
    if parent.get("ORGTREE_DESKTOP_MANAGED") == "1" or parent.get(LIVE):
        env[LIVE] = parent.get(LIVE) or _canonical(parent.get("ORGTREE_DATA") or os.path.expanduser("~/orgtree"))
        env[LEGACY] = parent.get(LEGACY) or _canonical(os.path.expanduser("~/orgtree"))
    return env


def validate_root(root: str, env: Mapping[str, str] | None = None) -> None:
    env = os.environ if env is None else env
    if not env.get(LIVE):
        return
    selected = env.get("ORGTREE_DATA", "").strip()
    problem = not selected or not os.path.isabs(selected)
    candidate = _canonical(root)
    # LEGACY is canonicalized by child_env in the parent process. Do not
    # evaluate ~/orgtree again in a child whose HOME is a test root.
    for protected in (env[LIVE], env.get(LEGACY)):
        if not protected:
            continue
        protected = _canonical(protected)
        try:
            common = os.path.commonpath((candidate, protected))
        except ValueError:  # different Windows volumes
            continue
        if common in (candidate, protected):
            problem = True
    if problem:
        raise RuntimeError(
            "Desktop agent development storage requires an explicit independent "
            "ORGTREE_DATA before importing store. Select a throwaway directory "
            "outside the installation data and ~/orgtree; inherited live storage "
            "and implicit fallback are refused. Authorized MCP tools are unaffected."
        )
