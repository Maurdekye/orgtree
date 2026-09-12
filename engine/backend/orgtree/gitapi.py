"""Operator-only Git workspace routes. Public projection is no data, uniformly 403."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
import time
from typing import Any, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import gitworkspace as gw, gitsettings as settings
from .ledger import LedgerError


def operator(request: Request) -> None:
    if getattr(request.state, "public_slug", None) or getattr(request.state, "bridge_slug", None):
        raise HTTPException(403, "Git workspace is available only to the host operator")


router = APIRouter(prefix="/api/orgs/{slug}/git", dependencies=[Depends(operator)])


@contextmanager
def errors() -> Iterator[None]:
    try:
        yield
    except gw.GitError as e:
        raise HTTPException(e.status, str(e)) from None
    except settings.SettingsError as e:
        raise HTTPException(409, str(e)) from None
    except LedgerError as e:
        raise HTTPException(404, str(e)) from None
    except (OSError, ValueError) as e:
        raise HTTPException(422, gw.gr.redact(str(e))) from None


class PathBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class DiscoveryBody(BaseModel):
    path: str | None = Field(default=None, min_length=1, max_length=4096)


class SettingsBody(BaseModel):
    revision: int
    values: dict[str, Any]


class LinkBody(BaseModel):
    branch: str = Field(min_length=1, max_length=1024)
    item: str = Field(min_length=1, max_length=300)


class ActionBody(BaseModel):
    snapshot: str = Field(min_length=1, max_length=64)
    branch: str = Field(min_length=1, max_length=1024)
    worktree: str | None = None


class SetupBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    package_manager: str | None = Field(default=None, max_length=32)
    dependency_source: str | None = Field(default=None, max_length=4096)
    apply: bool = False


class CleanupBody(BaseModel):
    root: str = Field(min_length=1, max_length=4096)
    candidates: list[str] = Field(min_length=1, max_length=200)
    preview: dict[str, Any] | None = None
    confirm: bool = False


def _worktree_maps(slug: str, repo: dict[str, Any]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Build display-only owner/reference facts from explicit registrations."""
    owners: dict[str, str] = {}
    for owner, paths in (repo.get("worktree_agents") or {}).items():
        values = [paths] if isinstance(paths, str) else paths
        if not isinstance(values, list):
            continue
        for path in values:
            if isinstance(path, str):
                owners[path] = str(owner)
    facts = gw.org_facts(slug)
    links = gw.associations(slug, repo, facts)
    active: dict[str, list[str]] = {}
    for branch, items in links.items():
        refs = [item["ref"] for item in items
                if item.get("status") not in ("done", "dropped", "superseded")]
        if refs:
            active[branch] = refs
    return owners, active


@router.get("/repositories")
def repositories(slug: str) -> dict[str, Any]:
    with errors():
        facts = gw.org_facts(slug)
        doc = settings.load()
        rows = []
        for r in doc["repositories"].values():
            if slug not in r["orgs"]:
                continue
            links = gw.associations(slug, r, facts)
            rows.append({"id": r["id"], "name": r["name"], "path": r["root"],
                         "links": [{"branch": branch, "item": item["slug"],
                                    "agent": item["owner"]["id"] if item["owner"] and item["owner"]["current"] else None}
                                   for branch, items in links.items() for item in items]})
        # Listing saved registrations must never wait for filesystem/Git discovery.
        return {"repositories": rows, "selected": doc["selected_by_org"].get(slug)}


@router.post("/discover")
def discover(slug: str, body: DiscoveryBody) -> dict[str, Any]:
    with errors():
        return gw.discover(slug, body.path)


@router.post("/repositories")
def register(slug: str, body: PathBody) -> dict[str, str]:
    with errors():
        repo = gw.register(slug, body.path)
        return {"id": repo["id"], "name": repo["name"]}


@router.delete("/{rid}/registration")
def forget(slug: str, rid: str) -> dict[str, bool]:
    with errors():
        gw.forget(slug, rid)
        return {"removed": True}


@router.post("/{rid}/selection")
def select(slug: str, rid: str) -> dict[str, bool]:
    with errors():
        gw.repository(slug, rid)
        settings.change(lambda d: d["selected_by_org"].update({slug: rid}))
        return {"selected": True}


@router.get("/{rid}/observation")
def observation(slug: str, rid: str) -> dict[str, Any]:
    with errors():
        return gw.observation(slug, rid)


@router.get("/{rid}/inventory")
def inventory(slug: str, rid: str, query: str | None = None,
              limit: int = 60) -> dict[str, Any]:
    with errors():
        repo = gw.repository(slug, rid)
        owners, active = _worktree_maps(slug, repo)
        return gw.worktree_inventory(repo, owners=owners, active_refs=active,
                                     query=query, limit=limit)


@router.post("/{rid}/setup")
def setup(slug: str, rid: str, body: SetupBody) -> dict[str, Any]:
    with errors():
        return gw.worktree_setup(gw.repository(slug, rid), body.path,
                                 package_manager=body.package_manager,
                                 dependency_source=body.dependency_source,
                                 apply=body.apply)


@router.post("/{rid}/cleanup-preview")
def cleanup_preview(slug: str, rid: str, body: CleanupBody) -> dict[str, Any]:
    with errors():
        repo = gw.repository(slug, rid)
        owners, active = _worktree_maps(slug, repo)
        all_worktrees = gw.worktrees(repo)
        root = os.path.normcase(os.path.abspath(body.root))
        row = next((w for w in all_worktrees
                    if os.path.normcase(os.path.abspath(w.get("path", ""))) == root), None)
        if not row:
            raise gw.GitError("Cleanup root is not a registered Git worktree", status=404)
        state = gw.changes(repo, row) if not row.get("bare") else {"state": "bare"}
        protected = gw.worktree_protected(
            state, active=bool(active.get(row.get("branch") or "")))
        owned: list[str] = []
        for paths in (repo.get("worktree_agents") or {}).values():
            values = [paths] if isinstance(paths, str) else paths
            if isinstance(values, list):
                owned.extend(p for p in values if isinstance(p, str))
        return gw.preview_worktree_cleanup(body.root, body.candidates, owned=owned,
                                           protected=protected)


@router.post("/{rid}/cleanup-unlink")
def cleanup_unlink(slug: str, rid: str, body: CleanupBody) -> dict[str, Any]:
    with errors():
        if body.preview is None:
            raise gw.GitError("Provide the cleanup preview before unlinking")
        # Validate the root and protection state again at the mutation boundary.
        repo = gw.repository(slug, rid)
        row = next((w for w in gw.worktrees(repo)
                    if os.path.normcase(os.path.abspath(w.get("path", ""))) ==
                    os.path.normcase(os.path.abspath(body.root))), None)
        if not row:
            raise gw.GitError("Cleanup root is not a registered Git worktree", status=404)
        state = gw.changes(repo, row) if not row.get("bare") else {"state": "bare"}
        _, active = _worktree_maps(slug, repo)
        if gw.worktree_protected(state, active=bool(active.get(row.get("branch") or ""))):
            raise gw.GitError("Cleanup is blocked because the worktree changed or is dirty")
        preview_root = os.path.normcase(os.path.abspath(str(body.preview.get("root") or "")))
        if preview_root != os.path.normcase(os.path.abspath(body.root)):
            raise gw.GitError("Cleanup preview belongs to another worktree")
        paths = [entry.get("path") for entry in body.preview.get("targets", [])
                 if isinstance(entry, dict) and isinstance(entry.get("path"), str)]
        owned: list[str] = []
        for values in (repo.get("worktree_agents") or {}).values():
            values = [values] if isinstance(values, str) else values
            if isinstance(values, list):
                owned.extend(p for p in values if isinstance(p, str))
        # Recompute the authorization at the mutation boundary. A submitted
        # preview is evidence of intent, not permission to unlink an entry
        # that became ordinary, moved outside the root, or changed ownership.
        fresh = gw.preview_worktree_cleanup(body.root, paths, owned=owned)
        return gw.unlink_validated_reparse_point(fresh, confirm=body.confirm)


@router.get("/{rid}/settings")
def get_settings(slug: str, rid: str) -> dict[str, Any]:
    with errors():
        repo = gw.repository(slug, rid)
        doc = settings.load()
        rows = gw.refs(repo)
        facts = gw.org_facts(slug)
        return {"revision": doc["revision"],
                **gw.configuration(repo, rows), "saved_trunk": repo["trunk"], "saved_remote": repo["remote"],
                "branches": [r["ref"] for r in rows if not r["symref"]],
                "items": [{"slug": i["slug"], "title": i["title"]} for i in facts.get("work_items", []) + facts.get("work_items_archive", [])],
                "links": [r for r in doc["links"] if r["repository_id"] == rid and r["org_slug"] == slug]}


@router.patch("/{rid}/settings")
def patch_settings(slug: str, rid: str, body: SettingsBody) -> dict[str, bool]:
    with errors():
        gw.patch_settings(slug, rid, body.values, body.revision)
        return {"saved": True}


@router.post("/{rid}/links")
def link(slug: str, rid: str, body: LinkBody) -> dict[str, bool]:
    with errors():
        gw.link_item(slug, rid, body.branch, body.item)
        return {"saved": True}


@router.delete("/{rid}/links")
def unlink(slug: str, rid: str, body: LinkBody) -> dict[str, bool]:
    with errors():
        gw.link_item(slug, rid, body.branch, body.item, remove=True)
        return {"removed": True}


@router.get("/{rid}/snapshot")
def snapshot(slug: str, rid: str, branches: str | None = None) -> dict[str, Any]:
    with errors():
        selected = json.loads(branches) if branches is not None else None
        if selected is not None and (not isinstance(selected, list) or any(not isinstance(r, str) for r in selected)):
            raise gw.GitError("Branch selection must be a list of full refs")
        if selected is not None and len(selected) > gw.MAX_LANES:
            raise gw.GitError(f"Choose up to {gw.MAX_LANES} branches at a time")
        return gw.snapshot(slug, rid, selected)


@router.get("/{rid}/history")
def history(slug: str, rid: str, cursor: str) -> dict[str, Any]:
    with errors():
        return gw.history(slug, rid, cursor)


@router.get("/{rid}/worktrees/{wid}/changes")
def changes(slug: str, rid: str, wid: str) -> dict[str, Any]:
    with errors():
        repo = gw.repository(slug, rid)
        with gw.lock(repo):
            wt = next((w for w in gw.worktrees(repo) if w["id"] == wid), None)
            if not wt:
                raise gw.GitError("Worktree no longer exists", status=404)
            value = gw.changes(repo, wt)
            current = next((w for w in gw.worktrees(repo) if w["id"] == wid), None)
            if not current or any(current.get(k) != wt.get(k) for k in ("oid", "branch")):
                raise gw.GitError("Checkout changed while reading details; read its changes again", status=409)
            return {**value, "read_at": time.time(), "head_oid": wt.get("oid"), "branch": wt.get("branch")}


@router.post("/{rid}/fetch")
def fetch(slug: str, rid: str) -> dict[str, Any]:
    with errors():
        return gw.fetch(slug, rid)


@router.post("/{rid}/watch")
def watch(slug: str, rid: str) -> dict[str, bool]:
    with errors():
        return {"started": gw.scheduler.request(slug, rid)}


@router.post("/{rid}/push")
def push(slug: str, rid: str, body: ActionBody) -> dict[str, Any]:
    with errors():
        return gw.operate(slug, rid, "push", body.snapshot, body.branch, body.worktree)


@router.post("/{rid}/pull")
def pull(slug: str, rid: str, body: ActionBody) -> dict[str, Any]:
    with errors():
        return gw.operate(slug, rid, "pull", body.snapshot, body.branch, body.worktree)
