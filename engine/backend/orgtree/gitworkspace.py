"""Repository-qualified Git facts and checked operations for the host operator.

No import-time jobs, subprocesses or writes. Each common Git directory owns
one lock, regardless of how many registered worktrees or tabs address it.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor

from collections import OrderedDict
from copy import deepcopy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any

from . import gitrunner as gr, gitsettings as settings, store, appsettings

_locks: dict[str, threading.RLock] = {}
_guard = threading.RLock()
_snapshots: OrderedDict[str, dict[str, Any]] = OrderedDict()
_batch_support: dict[str, bool] = {}
_cursor_key = secrets.token_bytes(32)
SNAPSHOT_TTL = 600
PAGE_SIZE = 120
MAX_LANES = 40
MAX_FILES = 2000
OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class GitError(ValueError):
    def __init__(self, message: str, *, status: int = 422, code: str = "blocked"):
        super().__init__(gr.redact(message))
        self.status, self.code = status, code


def canonical(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((canonical(path), canonical(root))) == canonical(root)
    except ValueError:
        return False


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def lock(repo: dict[str, Any]) -> threading.RLock:
    with _guard:
        return _locks.setdefault(repo["common"], threading.RLock())


def git(root: str, args: list[str], **kwargs: Any) -> bytes:
    result = gr.run(root, args, **kwargs)
    if result.code != 0:
        raise GitError(result.err or f"Git {args[0]} could not complete", code=result.failure or "git_failed")
    return result.out


def text(root: str, args: list[str], **kwargs: Any) -> str:
    return git(root, args, **kwargs).decode("utf-8", "replace").strip()


def identify(path: str) -> dict[str, Any]:
    if not path or not os.path.isdir(path):
        raise GitError("Choose an existing repository directory")
    path = canonical(path)
    common = canonical(text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    bare = text(path, ["rev-parse", "--is-bare-repository"]) == "true"
    root = common if bare else canonical(text(path, ["rev-parse", "--show-toplevel"]))
    stat = os.stat(common)
    return {"root": root, "common": common, "identity": [stat.st_dev, stat.st_ino], "bare": bare}


def org_facts(slug: str) -> dict[str, Any]:
    # Never call supervisor.scratch_dir here: that accessor creates directories.
    with store.DOC_LOCK:
        org = store.load_org(slug)
        return deepcopy(org.d)


def roots(slug: str, facts: dict[str, Any] | None = None) -> list[str]:
    facts = facts or org_facts(slug)
    values = [facts.get("workspace")]
    values.extend(d.get("path") for d in facts.get("dirs", []) if isinstance(d, dict))
    values.extend(r["root"] for r in settings.load()["repositories"].values() if slug in r["orgs"])
    # Host discovery never crosses into a sandbox's container namespace.
    if not (facts.get("kiosk") or {}).get("sandbox"):
        values.extend(os.path.join(store.scratch_root(slug), n)
                      for n in facts.get("nodes", {}) if "@" not in n)
    return list(dict.fromkeys(canonical(p) for p in values if p and os.path.isdir(p)))


def discover(slug: str, scan: str | None = None) -> dict[str, Any]:
    allowed = roots(slug)
    if scan is not None and not any(within(scan, p) for p in allowed):
        raise GitError("Scan directory is outside this org's registered folder roots", status=403)
    queue = [(canonical(scan), 0)] if scan else [(p, 0) for p in allowed]
    found: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
    visited: set[str] = set()
    while queue and len(visited) < 200:
        path, depth = queue.pop(0)
        if path in visited:
            continue
        visited.add(path)
        try:
            info = identify(path)
            if any(within(info["root"], p) for p in allowed):
                found[info["common"]] = {"path": info["root"], "name": os.path.basename(info["root"])}
        except GitError:
            pass  # Ordinary non-repository folders are valid discovery inputs.
        if scan and depth < 2:
            try:
                for child in os.scandir(path):
                    if child.name in (".git", "node_modules", ".venv"):
                        continue
                    if child.is_dir(follow_symlinks=False) and not child.is_symlink():
                        # Windows junctions are reparse points, even when is_symlink is false.
                        if getattr(child.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400:
                            continue
                        queue.append((canonical(child.path), depth + 1))
            except OSError:
                errors.append({"path": path, "reason": "Directory could not be scanned"})
    return {"candidates": list(found.values()), "scanned": len(visited), "truncated": bool(queue), "errors": errors}


def register(slug: str, path: str) -> dict[str, Any]:
    info = identify(path)
    # Registration is an explicit operator-selected root, not automatic discovery.
    def add(doc: dict[str, Any]) -> dict[str, Any]:
        existing = next((r for r in doc["repositories"].values() if r["common"] == info["common"]), None)
        if existing:
            if existing["identity"] != info["identity"]:
                raise GitError("Repository directory was replaced; remove its registration before registering again")
            if slug not in existing["orgs"]:
                existing["orgs"].append(slug)
            repo = existing
        else:
            repo = {**info, "id": secrets.token_hex(12), "name": os.path.basename(info["root"]),
                    "orgs": [slug], "remote": None, "trunk": None, "auto_fetch": False,
                    "observations": {}, "worktree_agents": {}}
            doc["repositories"][repo["id"]] = repo
        doc["selected_by_org"][slug] = repo["id"]
        return repo
    org_facts(slug)  # Refuse a nonexistent org before persisting a root.
    return settings.change(add)


def repository(slug: str, rid: str) -> dict[str, Any]:
    repo = settings.load()["repositories"].get(rid)
    if not repo or slug not in repo["orgs"]:
        raise GitError("Repository is not registered for this org", status=404)
    current = identify(repo["root"])
    if current["common"] != repo["common"] or current["identity"] != repo["identity"]:
        raise GitError("Repository identity changed; register its new location explicitly", status=409)
    return repo


def remotes(repo: dict[str, Any]) -> list[str]:
    return text(repo["root"], ["remote"]).splitlines()


def refs(repo: dict[str, Any], trunk: str | None = None, *, batch: bool = True, metadata_only: bool = False) -> list[dict[str, Any]]:
    root = repo["root"]
    fmt = "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)%00%(upstream:track)"
    if metadata_only:
        fmt = fmt.replace("%(upstream:track)", "")
    use_batch = bool(batch and trunk)
    if use_batch:
        capability = _batch_support.get(root)
        if capability is None:
            capability = gr.run(root, ["for-each-ref", "--count=1", f"--format=%(ahead-behind:{trunk})", "refs/heads/"]).code == 0
            _batch_support[root] = capability
        use_batch = capability
    if use_batch:
        fmt += f"%00%(ahead-behind:{trunk})"
    raw = git(root, ["for-each-ref", f"--format={fmt}", "refs/heads/", "refs/remotes/"], timeout=30)
    rows = []
    for line in raw.decode("utf-8", "replace").splitlines():
        fields = line.split("\0")
        if len(fields) < 7 or not OID.fullmatch(fields[1]):
            raise GitError("Git returned an invalid reference record")
        row: dict[str, Any] = dict(zip(("ref", "oid", "upstream", "remote", "remote_ref", "symref", "track"), fields[:7]))
        row["trunk_counts"] = [int(x) for x in fields[7].split()] if use_batch and len(fields) == 8 else None
        rows.append(row)
    return rows


def ref_identity(rows: list[dict[str, Any]]) -> str:
    return digest([(r["ref"], r["oid"], r["upstream"], r["remote"], r["remote_ref"]) for r in rows])


def worktrees(repo: dict[str, Any]) -> list[dict[str, Any]]:
    raw = git(repo["root"], ["worktree", "list", "--porcelain", "-z"])
    result: list[dict[str, Any]] = []
    row: dict[str, Any] = {}
    for token in raw.decode("utf-8", "replace").split("\0"):
        if not token:
            if row:
                row["id"] = digest([repo["id"], canonical(row["path"])])[:24]
                result.append(row)
                row = {}
            continue
        key, _, value = token.partition(" ")
        if key == "worktree":
            row["path"] = value
        elif key == "HEAD":
            row["oid"] = value if OID.fullmatch(value) and set(value) != {"0"} else None
        elif key == "branch":
            row["branch"] = value
        elif key in ("detached", "bare", "locked", "prunable"):
            row[key] = value or True
    return result


def _numstat(raw: bytes) -> dict[str, Any]:
    parts = iter(raw.split(b"\0"))
    result = {}
    for part in parts:
        if not part:
            continue
        add, remove, name = part.split(b"\t", 2)
        if not name:  # -z rename: empty path, then old path and new path.
            next(parts)
            name = next(parts)
        result[os.fsdecode(name)] = {"added": int(add) if add != b"-" else None,
                                    "removed": int(remove) if remove != b"-" else None,
                                    "reason": "binary" if add == b"-" else None}
    return result


def changes(repo: dict[str, Any], wt: dict[str, Any]) -> dict[str, Any]:
    root = wt["path"]
    if wt.get("bare"):
        return {"state": "bare", "files": [], "count": 0, "complete": True}
    if not os.path.isdir(root):
        return {"state": "unavailable", "files": [], "count": None, "complete": False, "reason": "Worktree directory is unavailable"}
    try:
        if identify(root)["common"] != repo["common"]:
            raise GitError("Worktree now belongs to another repository")
        raw = git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
        staged = _numstat(git(root, ["diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]))
        unstaged = _numstat(git(root, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]))
        parts = iter(raw.split(b"\0"))
        files = []
        untracked_bytes = 0
        for record in parts:
            if not record:
                continue
            kind = chr(record[0])
            old = None
            if kind == "?":
                name, xy, sub = os.fsdecode(record[2:]), "??", None
            elif kind in ("1", "2", "u"):
                fields = record.split(b" ", {"1": 8, "2": 9, "u": 10}[kind])
                name, xy, sub = os.fsdecode(fields[-1]), fields[1].decode(), fields[2].decode()
                if kind == "2":
                    old = os.fsdecode(next(parts))
            else:
                continue
            row = {"path": name, "old_path": old, "xy": xy, "submodule": sub,
                   "conflicted": kind == "u", "staged": staged.get(name), "unstaged": unstaged.get(name),
                   "untracked": None}
            if kind == "?":
                full = os.path.join(root, name)
                value = {"added": None, "removed": None, "reason": "unavailable"}
                try:
                    if os.path.islink(full) or not within(full, root):
                        value["reason"] = "symlink"
                    elif len(files) >= MAX_FILES or untracked_bytes >= 4 * 1024 * 1024:
                        value["reason"] = "scan limit"
                    elif os.path.getsize(full) > 1024 * 1024:
                        value["reason"] = "large file"
                    else:
                        with open(full, "rb") as f:
                            content = f.read(1024 * 1024 + 1)
                        untracked_bytes += len(content)
                        if b"\0" in content:
                            value["reason"] = "binary"
                        else:
                            content.decode("utf-8")
                            value = {"added": content.count(b"\n") + int(bool(content) and not content.endswith(b"\n")), "removed": 0, "reason": None}
                except (OSError, UnicodeError):
                    pass
                row["untracked"] = value
            files.append(row)
        gitdir = text(root, ["rev-parse", "--absolute-git-dir"])
        operations = [name for name in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD")
                      if os.path.exists(os.path.join(gitdir, name))]
        return {"state": "dirty" if files else "clean", "files": files[:MAX_FILES], "count": len(files),
                "complete": len(files) <= MAX_FILES, "operations": operations,
                "fingerprint": digest([raw.hex(), staged, unstaged]),
                "conflicted": sum(f["conflicted"] for f in files)}
    except (GitError, OSError, ValueError, StopIteration) as e:
        return {"state": "unavailable", "files": [], "count": None, "complete": False, "reason": str(e)}


def comparison(repo: dict[str, Any], a: str, b: str | None, counts: list[int] | None = None,
               *, shallow: bool = False) -> dict[str, Any]:
    if not b:
        return {"state": "unavailable", "ahead": None, "behind": None}
    if a == b:
        return {"state": "in_sync", "ahead": 0, "behind": 0}
    root = repo["root"]
    if shallow:
        return {"state": "shallow", "ahead": None, "behind": None}
    base = gr.run(root, ["merge-base", a, b])
    if base.code == 1:
        return {"state": "unrelated", "ahead": None, "behind": None}
    if base.code != 0:
        return {"state": "unavailable", "ahead": None, "behind": None}
    if counts is None:
        counts = [int(n) for n in text(root, ["rev-list", "--left-right", "--count", f"{a}...{b}"]).split()]
    ahead, behind = counts
    return {"state": "diverged" if ahead and behind else "ahead" if ahead else "behind" if behind else "in_sync",
            "ahead": ahead, "behind": behind}


def configuration(repo: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    names = remotes(repo)
    chosen = repo["remote"] if repo["remote"] is not None else names[0] if len(names) == 1 else None
    trunk = repo["trunk"]
    if trunk is None and chosen:
        default = next((r["symref"] for r in rows if r["ref"] == f"refs/remotes/{chosen}/HEAD"), None)
        candidate = default.replace(f"refs/remotes/{chosen}/", "refs/heads/", 1) if default else None
        if candidate and any(r["ref"] == candidate for r in rows):
            trunk = candidate
    return {"remote": chosen, "remotes": names, "trunk": trunk,
            "trunk_missing": bool(trunk and not any(r["ref"] == trunk for r in rows)),
            "remote_missing": bool(chosen and chosen not in names)}


def remote_config(repo: dict[str, Any], remote: str | None) -> dict[str, Any]:
    if not remote or remote not in remotes(repo) or remote.startswith("-") or any(ord(c) < 32 for c in remote):
        raise GitError("Select an available remote in repository settings")
    urls = text(repo["root"], ["remote", "get-url", "--all", remote]).splitlines()
    push_urls = text(repo["root"], ["remote", "get-url", "--push", "--all", remote]).splitlines()
    specs = gr.run(repo["root"], ["config", "--get-all", f"remote.{remote}.fetch"])
    return {"remote": remote, "urls": urls, "push_urls": push_urls,
            "refspecs": specs.text().splitlines() if specs.code == 0 else [],
            "fingerprint": digest([remote, urls, push_urls, specs.text()])}


def freshness(repo: dict[str, Any], remote: str | None, *, now: float | None = None,
              captured_config: dict[str, Any] | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    observation = deepcopy(repo.get("observations", {}).get(remote or "", {}))
    if remote:
        try:
            if observation.get("fingerprint") != (captured_config or remote_config(repo, remote))["fingerprint"]:
                observation = {}
        except GitError:
            # A selected remote that became unavailable has a real failed
            # attempt too. It cannot inherit success from a prior configuration.
            observation = observation if observation.get("fingerprint") is None else {}
    last = observation.get("success_at")
    age = max(0, now - last) if last else None
    watched = bool(remote and appsettings.git_periodic_fetch_enabled())
    state = ("failing" if observation.get("error") else "not_watched" if not watched
             else "not_yet_observed" if age is None else "stale" if age > 60 else "fresh")
    return {**observation, "state": state, "age_seconds": age, "watched": watched,
            "busy": repo["common"] in _busy}


def associations(slug: str, repo: dict[str, Any], facts: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    items = {it["slug"]: it for it in facts.get("work_items", []) + facts.get("work_items_archive", [])}
    result: dict[str, list[dict[str, Any]]] = {}
    for link in settings.load()["links"]:
        if link["repository_id"] != repo["id"] or link["org_slug"] != slug:
            continue
        item = items.get(link["item_slug"])
        owner = item.get("owner") if item else None
        node = facts.get("nodes", {}).get(owner["node"]) if isinstance(owner, dict) else None
        current = bool(node and node.get("generation", 0) == owner.get("generation", 0))
        target = owner["node"] if current else f"{owner['node']}@{owner.get('generation', 0)}" if owner else None
        if not current:
            node = facts.get("nodes", {}).get(target)
        result.setdefault(link["branch_ref"], []).append({
            "slug": link["item_slug"], "title": item["title"] if item else None,
            "ref": f"@item:{slug}/{link['item_slug']}", "missing": item is None,
            "status": item.get("status") if item else None,
            "owner": {"id": owner["node"], "generation": owner.get("generation", 0),
                      "tier": node.get("model") if node else None,
                      "current": current, "state": node.get("state") if node else "historical",
                      "target": target if node else None,
                      "ref": f"@agent:{slug}/{target}" if node else None} if owner else None})
    return result


def _cursor(token: str, offset: int) -> str:
    value = f"{token}.{offset}"
    return value + "." + hmac.new(_cursor_key, value.encode(), hashlib.sha256).hexdigest()[:24]


def cached(slug: str, rid: str, token: str) -> dict[str, Any]:
    with _guard:
        snapshot = _snapshots.get(token)
        if not snapshot or time.time() - snapshot["created"] > SNAPSHOT_TTL:
            raise GitError("History snapshot expired; refresh this repository", status=409, code="snapshot_expired")
        if snapshot["slug"] != slug or snapshot["repository_id"] != rid:
            raise GitError("Snapshot does not belong to this repository", status=404)
        return snapshot


def history(slug: str, rid: str, cursor: str) -> dict[str, Any]:
    try:
        token, number, signature = cursor.split(".")
        offset = int(number)
        if offset < 0 or offset > 1000000 or not hmac.compare_digest(_cursor(token, offset), cursor):
            raise ValueError()
    except ValueError:
        raise GitError("Invalid history cursor", status=422) from None
    snap = cached(slug, rid, token)
    repo = repository(slug, rid)
    return _history_page(repo, snap, offset)


def _history_page(repo: dict[str, Any], snap: dict[str, Any], offset: int) -> dict[str, Any]:
    token = snap["token"]
    with lock(repo):
        if not snap["tips"]:
            return {"nodes": [], "next_cursor": None, "frontier": [], "offset": offset}
        page_oids = snap["ordered"][offset:offset + PAGE_SIZE]
        if offset == 0:
            page_oids = list(dict.fromkeys(page_oids + snap["tips"]))
        else:
            page_oids = [oid for oid in page_oids if oid not in snap["tips"]]
        # `log --no-walk=unsorted`, NOT `show --no-patch`: both print exactly
        # these fields in the given order (byte-identical on 193 real commits
        # and on 20 merges), but `show` still runs the diff machinery per
        # commit even with --no-patch (trace2: 438 diff regions for 193
        # commits, none for log), reading trees and, for merges, blobs for
        # rename detection. On the real orgtree repository that was the
        # whole of a cold open: 4.27 s of a 4.78 s snapshot, 0.16 s warm
        # (feature-fable, 2026-09-07). log reads only the commit objects.
        raw = git(repo["root"], ["log", "--no-walk=unsorted", "--format=%H%x00%P%x00%at%x00%s%x00%b%x00", *page_oids, "--"], timeout=30) if page_oids else b""
        fields = raw.decode("utf-8", "replace").split("\0")
        nodes = []
        for i in range(0, len(fields) - 4, 5):
            oid, parents, at, subject, body = fields[i:i + 5]
            oid = oid.strip()
            if not OID.fullmatch(oid):
                raise GitError("Invalid commit in history response")
            nodes.append({"oid": oid, "parents": parents.split(), "at": int(at), "subject": subject, "message": body,
                          "rank": snap["ranks"][oid], "lane": snap["lanes"][oid],
                          "comparisons": {b["ref"]: "local" if snap["membership"][oid] & (1 << (2 * j)) else "remote"
                                          for j, b in enumerate(snap["branches"]) if b["classified"]
                                          and bool(snap["membership"][oid] & (1 << (2 * j))) != bool(snap["membership"][oid] & (2 << (2 * j)))}})
        more = offset + PAGE_SIZE < len(snap["ordered"])
        visible = {n["oid"] for n in nodes}
        frontier = sorted({p for n in nodes for p in n["parents"] if p not in visible})
        return {"nodes": nodes, "next_cursor": _cursor(token, offset + PAGE_SIZE) if more else None,
                "frontier": frontier, "offset": offset, "shallow": snap["shallow"]}


def snapshot(slug: str, rid: str, selected: list[str] | None = None, *, batch: bool = True) -> dict[str, Any]:
    repo = repository(slug, rid)
    facts = org_facts(slug)
    links = associations(slug, repo, facts)
    with lock(repo), ThreadPoolExecutor(max_workers=3, thread_name_prefix="git-read") as reads:
        captured_at = time.time()
        first_read = reads.submit(refs, repo, batch=False, metadata_only=batch)
        worktree_read = reads.submit(worktrees, repo)
        shallow_read = reads.submit(text, repo["root"], ["rev-parse", "--is-shallow-repository"])
        first = first_read.result()
        cfg = configuration(repo, first)
        # Normal reads calculate comparisons from the captured topology below.
        # The legacy path remains an independent Git oracle for fixture checks.
        rows = first if batch else refs(repo, cfg["trunk"] if not cfg["trunk_missing"] else None, batch=False)
        by_ref = {r["ref"]: r for r in rows}
        wts = worktree_read.result()
        captured_worktrees = digest(wts)
        shallow = shallow_read.result() == "true"
        remote_read = reads.submit(remote_config, repo, cfg["remote"])
        wt_branches = {w.get("branch") for w in wts}
        active = [r for r in rows if not r["symref"] and (r["ref"] == cfg["trunk"] or r["ref"] in wt_branches
                  or any(it.get("status") not in ("done", "dropped", "superseded") for it in links.get(r["ref"], [])))]
        if selected is not None:
            if any(r not in by_ref for r in selected):
                raise GitError("Selected branch no longer exists; refresh the branch list", status=409)
            active = [by_ref[r] for r in dict.fromkeys(([cfg["trunk"]] if cfg["trunk"] in by_ref else []) + selected)]
        if not active:
            active = [r for r in rows if not r["symref"]][:12]
        active = sorted(active, key=lambda r: (r["ref"] != cfg["trunk"], r["ref"]))
        omitted = max(0, len(active) - MAX_LANES)
        active = active[:MAX_LANES]
        branches = []
        trunk_oid = by_ref.get(cfg["trunk"], {}).get("oid")
        for row in active:
            is_local = row["ref"].startswith("refs/heads/")
            upstream = by_ref.get(row["upstream"])
            counts = None
            if upstream:
                ahead = re.search(r"ahead (\d+)", row["track"])
                behind = re.search(r"behind (\d+)", row["track"])
                counts = [int(ahead[1]) if ahead else 0, int(behind[1]) if behind else 0]
            sync = ({"state": "pending", "ahead": None, "behind": None} if batch else comparison(repo, row["oid"], upstream["oid"], counts, shallow=shallow)) if upstream else {
                "state": "upstream_gone" if row["upstream"] else "no_upstream" if is_local else "remote_only",
                "ahead": None, "behind": None}
            unique: dict[str, list[str]] = {"local": [], "remote": []}
            classified = bool(upstream and sync["state"] not in ("shallow", "unrelated", "unavailable"))
            branches.append({**row, "local": is_local, "tickets": links.get(row["ref"], []),
                             "upstream_oid": upstream["oid"] if upstream else None, "sync": sync,
                             "against_trunk": {} if batch else comparison(repo, row["oid"], trunk_oid, row["trunk_counts"], shallow=shallow),
                             "unique": unique, "classified": classified})
        token = secrets.token_hex(16)
        tips = list(dict.fromkeys([b["oid"] for b in branches] + [b["upstream_oid"] for b in branches if b["upstream_oid"]]
                                 + [w["oid"] for w in wts[:60] if w.get("oid")]))
        skeleton = text(repo["root"], ["rev-list", "--parents", "--topo-order", "--max-count=100001", *tips, "--"], timeout=30, max_bytes=32 * 1024 * 1024).splitlines() if tips else []
        ancestry = {parts[0]: parts[1:] for line in skeleton if (parts := line.split())}
        ordered = list(ancestry)
        if len(ordered) > 100000:
            raise GitError("Selected history exceeds the 100,000-commit snapshot limit; choose fewer branches")
        membership = dict.fromkeys(ordered, 0)
        for index, branch in enumerate(branches):
            membership[branch["oid"]] |= 1 << (2 * index)
            if branch["upstream_oid"]:
                membership[branch["upstream_oid"]] |= 2 << (2 * index)
        for oid, parents in ancestry.items():
            for parent in parents:
                membership[parent] = membership.get(parent, 0) | membership[oid]
        if batch:
            trunk_index = next((i for i, b in enumerate(branches) if b["ref"] == cfg["trunk"]), None)
            def compare_bits(a: str, b: str | None, left: int, right: int) -> dict[str, Any]:
                if not b:
                    return {"state": "unavailable", "ahead": None, "behind": None}
                if a == b:
                    return {"state": "in_sync", "ahead": 0, "behind": 0}
                if shallow:
                    return {"state": "shallow", "ahead": None, "behind": None}
                ahead = behind = 0
                common = False
                for oid in ordered:
                    mask = membership[oid]
                    x, y = bool(mask & left), bool(mask & right)
                    ahead += x and not y
                    behind += y and not x
                    common |= x and y
                if not common:
                    return {"state": "unrelated", "ahead": None, "behind": None}
                return {"state": "diverged" if ahead and behind else "ahead" if ahead else "behind" if behind else "in_sync",
                        "ahead": ahead, "behind": behind}
            for i, branch in enumerate(branches):
                left = 1 << (2 * i)
                if branch["upstream_oid"]:
                    branch["sync"] = compare_bits(branch["oid"], branch["upstream_oid"], left, left << 1)
                branch["against_trunk"] = compare_bits(branch["oid"], trunk_oid, left, 1 << (2 * trunk_index) if trunk_index is not None else 0)
                branch["classified"] = bool(branch["upstream_oid"] and branch["sync"]["state"] not in ("shallow", "unrelated", "unavailable"))
        # Compact per-node comparison facts accompany every loaded page. The
        # first-page shortcut is bounded; classification never stops at that cap.
        for index, branch in enumerate(branches):
            if branch["classified"]:
                for oid in ordered[:PAGE_SIZE]:
                    a, b = bool(membership[oid] & (1 << (2 * index))), bool(membership[oid] & (2 << (2 * index)))
                    if a != b:
                        branch["unique"]["local" if a else "remote"].append(oid)
        # Capture lane ownership from the complete bounded OID/parent skeleton.
        # Only page details cross the wire; later pages cannot reposition old tips.
        lanes: dict[str, dict[str, Any]] = {}
        trunk = next((b for b in branches if b["ref"] == cfg["trunk"]), None)
        oid = trunk["oid"] if trunk else None
        while oid and oid not in lanes:
            lanes[oid] = {"offset": 0, "owner": trunk["ref"]}
            oid = next(iter(ancestry.get(oid, [])), None)
        side = 0
        for branch in branches:
            if branch is trunk:
                offset = 0
            else:
                side += 1
                offset = (-1 if side % 2 else 1) * ((side + 1) // 2) * 330
            lanes.setdefault(branch["oid"], {"offset": offset, "owner": branch["ref"]})
            if branch["upstream_oid"]:
                lanes.setdefault(branch["upstream_oid"], {"offset": offset + (75 if branch["sync"]["state"] == "diverged" else 0), "owner": branch["ref"]})
        for oid, parents in ancestry.items():
            position = lanes.setdefault(oid, {"offset": 165, "owner": None})
            for index, parent in enumerate(parents):
                lanes.setdefault(parent, {"offset": position["offset"] + 75 * index, "owner": position["owner"]})
        # Inventory is captured with the graph; mutable file details are read
        # only when requested, never represented as a clean initial checkout.
        for wt in wts[:60]:
            wt["changes"] = {"state": "not_read", "files": [], "count": None,
                             "complete": False, "reason": "Not read"}
            wt["agents"] = [name for name in facts.get("nodes", {}) if "@" not in name
                            and within(wt["path"], os.path.join(store.scratch_root(slug), name))]
        final_read = reads.submit(refs, repo, batch=False, metadata_only=True)
        final_worktrees = reads.submit(worktrees, repo)
        snap = {"token": token, "slug": slug, "repository_id": rid, "created": time.time(),
                "tips": tips, "shallow": shallow, "branches": branches, "worktrees": wts[:60], "config": cfg,
                "ref_identity": ref_identity(first), "captured_at": captured_at,
                "newer_available": False, "checkouts_changed": False, "unborn_branch": None,
                "ordered": ordered, "ranks": {oid: i for i, oid in enumerate(ordered)}, "lanes": lanes,
                "membership": membership, "total_commits": len(ordered)}
        if not tips:
            unborn = gr.run(repo["root"], ["symbolic-ref", "-q", "HEAD"])
            snap["unborn_branch"] = unborn.text() if unborn.code == 0 else None
        captured_config = None
        try:
            captured_config = remote_read.result()
            snap["remote_fingerprint"] = captured_config["fingerprint"]
        except GitError:
            snap["remote_fingerprint"] = None
        # Detail loading overlaps the final metadata check. Both use captured
        # OIDs; advancing refs cannot invalidate the already captured history.
        first_page = _history_page(repo, snap, 0)
        snap["newer_available"] = ref_identity(first) != ref_identity(final_read.result())
        snap["checkouts_changed"] = captured_worktrees != digest(final_worktrees.result())
        with _guard:
            _snapshots[token] = snap
            while len(_snapshots) > 32:
                _snapshots.popitem(last=False)
        result = {**deepcopy({k: v for k, v in snap.items() if k not in ("ordered", "ranks", "lanes", "membership")}), "name": repo["name"], "root": repo["root"], "bare": repo["bare"],
                  "inventory": [{"ref": r["ref"], "oid": r["oid"], "linked": bool(links.get(r["ref"]))}
                                for r in rows if not r["symref"]],
                  "omitted_active": omitted, "omitted_worktrees": max(0, len(wts) - 60),
                  "freshness": freshness(repo, cfg["remote"], captured_config=captured_config)}
        result["history"] = first_page
        return result


_busy: set[str] = set()


def observation(slug: str, rid: str) -> dict[str, Any]:
    repo = repository(slug, rid)
    mutex = lock(repo)
    if not mutex.acquire(blocking=False):
        return {"busy": True}
    try:
        rows = refs(repo)
        cfg = configuration(repo, rows)
        return {"busy": False, "ref_identity": ref_identity(rows), "freshness": freshness(repo, cfg["remote"])}
    finally:
        mutex.release()


def patch_settings(slug: str, rid: str, values: dict[str, Any], revision: int) -> dict[str, Any]:
    repo = repository(slug, rid)
    if set(values) - {"remote", "trunk"}:
        raise GitError("Unsupported repository setting")
    with lock(repo):
        if "remote" in values and values["remote"] is not None and values["remote"] not in remotes(repo):
            raise GitError("Select a known remote")
        if "trunk" in values and values["trunk"] is not None:
            if values["trunk"] not in {r["ref"] for r in refs(repo) if r["ref"].startswith("refs/heads/")}:
                raise GitError("Select a known local trunk branch")
        return settings.change(lambda d: d["repositories"][rid].update(values), revision=revision)


def link_item(slug: str, rid: str, branch: str, item: str, *, remove: bool = False) -> None:
    repo = repository(slug, rid)
    target = {"repository_id": rid, "branch_ref": branch, "org_slug": slug, "item_slug": item}
    if not remove:
        if branch not in {r["ref"] for r in refs(repo) if not r["symref"]}:
            raise GitError("Select a known branch")
        facts = org_facts(slug)
        if item not in {it["slug"] for it in facts.get("work_items", []) + facts.get("work_items_archive", [])}:
            raise GitError("Select an existing docket item in this org")
    def update(doc: dict[str, Any]) -> None:
        if remove:
            doc["links"] = [r for r in doc["links"] if r != target]
        elif target not in doc["links"]:
            doc["links"].append(target)
    settings.change(update)


def forget(slug: str, rid: str) -> None:
    def update(doc: dict[str, Any]) -> None:
        repo = doc["repositories"].get(rid)
        if not repo or slug not in repo["orgs"]:
            raise GitError("Repository is not registered for this org", status=404)
        repo["orgs"].remove(slug)
        doc["links"] = [link for link in doc["links"] if not (link["repository_id"] == rid and link["org_slug"] == slug)]
        if doc["selected_by_org"].get(slug) == rid:
            doc["selected_by_org"].pop(slug)
        if not repo["orgs"]:
            doc["repositories"].pop(rid)
    # An unavailable/replaced repository must still be removable from settings.
    settings.change(update)


def _transport(config: dict[str, Any], *, pushing: bool = False) -> None:
    urls = config["push_urls"] if pushing else config["urls"]
    if len(urls) != 1:
        raise GitError("This action requires exactly one remote destination")
    url = urls[0]
    scheme = re.match(r"^([A-Za-z][A-Za-z0-9+.-]*)://", url)
    if "::" in url or (scheme and scheme[1] not in ("https", "http", "ssh", "file")) or url.startswith("-"):
        raise GitError("This remote transport is not supported by the Git workspace")


def _fetch_checked(repo: dict[str, Any], remote: str | None) -> dict[str, Any]:
    config = remote_config(repo, remote)
    _transport(config)
    specs = config["refspecs"]
    if not specs:
        raise GitError("The selected remote has no tracking refspec")
    for spec in specs:
        source, sep, target = spec.lstrip("+").partition(":")
        if (not sep or not source.startswith("refs/heads/")
                or not target.startswith(f"refs/remotes/{remote}/")
                or source.count("*") != target.count("*") or source.count("*") > 1
                or any(c.isspace() for c in spec)):
            raise GitError("Remote fetch mapping must map heads only into this remote's tracking namespace")
    attempt = time.time()
    result = gr.run(repo["root"], ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
                                  "--prune", str(remote), *specs], timeout=45, read=False)
    def observe(doc: dict[str, Any]) -> None:
        current = doc["repositories"].get(repo["id"])
        if not current:
            return
        previous = current["observations"].get(remote, {})
        if previous.get("fingerprint") != config["fingerprint"]:
            previous = {}
        value = {**previous, "fingerprint": config["fingerprint"], "attempt_at": attempt,
                 "error": None if result.code == 0 else result.err or "Fetch failed"}
        if result.code == 0:
            value["success_at"] = time.time()
        current["observations"][remote] = value
    settings.change(observe)
    if result.code != 0:
        raise GitError(result.err or "Fetch failed", code=result.failure or "fetch_failed")
    return {"state": "success", "message": "Fetched remote history", "observed_at": time.time()}


def _fetch(repo: dict[str, Any], remote: str | None) -> dict[str, Any]:
    try:
        return _fetch_checked(repo, remote)
    except GitError as error:
        # Validation/transport errors occur before Git starts, but are still
        # failed observation attempts. A watcher must not silently stay healthy.
        try:
            fingerprint = remote_config(repo, remote)["fingerprint"]
        except GitError:
            fingerprint = None
        def record(doc: dict[str, Any]) -> None:
            current = doc["repositories"].get(repo["id"])
            if not current:
                return
            key = remote or ""
            previous = current["observations"].get(key, {})
            if previous.get("fingerprint") != fingerprint:
                previous = {}
            current["observations"][key] = {**previous, "fingerprint": fingerprint,
                                          "attempt_at": time.time(), "error": str(error)}
        settings.change(record)
        raise


def fetch(slug: str, rid: str) -> dict[str, Any]:
    repo = repository(slug, rid)
    mutex = lock(repo)
    if not mutex.acquire(blocking=False):
        raise GitError("A repository operation is already running", status=409, code="busy")
    try:
        with _guard:
            _busy.add(repo["common"])
        cfg = configuration(repo, refs(repo))
        return _fetch(repo, cfg["remote"])
    finally:
        with _guard:
            _busy.discard(repo["common"])
        mutex.release()


def operate(slug: str, rid: str, action: str, token: str, branch_ref: str,
            worktree_id: str | None = None) -> dict[str, Any]:
    if action not in ("push", "pull"):
        raise GitError("Unsupported Git action")
    snap = cached(slug, rid, token)
    branch = next((r for r in snap["branches"] if r["ref"] == branch_ref and r["local"]), None)
    if not branch:
        raise GitError("Select a local branch in the current snapshot")
    repo = repository(slug, rid)
    mutex = lock(repo)
    if not mutex.acquire(blocking=False):
        raise GitError("A repository operation is already running", status=409, code="busy")
    try:
        with _guard:
            _busy.add(repo["common"])
        current = next((r for r in refs(repo) if r["ref"] == branch_ref), None)
        if not current or any(current[k] != branch[k] for k in ("oid", "upstream", "remote", "remote_ref")):
            raise GitError("Branch changed since the graph was read; refresh before acting", status=409)
        cfg = configuration(repo, refs(repo))
        if not current["upstream"] or current["remote"] != cfg["remote"]:
            raise GitError("This branch must track the selected remote before this action is available")
        config = remote_config(repo, cfg["remote"])
        if config["fingerprint"] != snap["remote_fingerprint"]:
            raise GitError("Remote configuration changed; refresh before acting", status=409)
        _transport(config, pushing=action == "push")
        destination = current["remote_ref"]
        if not destination.startswith("refs/heads/") or gr.run(repo["root"], ["check-ref-format", destination]).code != 0:
            raise GitError("Upstream destination is not a valid branch ref")
        if action == "push":
            if branch["sync"]["state"] != "ahead":
                raise GitError("Push requires unpushed commits and a non-diverged upstream")
            observed = text(repo["root"], ["ls-remote", "--heads", config["push_urls"][0], destination], timeout=30)
            remote_oid = next((line.split("\t")[0] for line in observed.splitlines()
                               if line.partition("\t")[2] == destination), None)
            if remote_oid != branch["upstream_oid"]:
                raise GitError("Remote branch changed; fetch and refresh before pushing", status=409)
            # The source is the captured BRANCH TIP, never the clicked commit.
            result = gr.run(repo["root"], ["-c", f"remote.{cfg['remote']}.mirror=false", "push", "--porcelain",
                                           "--no-follow-tags", "--recurse-submodules=no", str(cfg["remote"]),
                                           f"{branch['oid']}:{destination}"], timeout=45, read=False)
            actual = gr.run(repo["root"], ["ls-remote", "--heads", config["push_urls"][0], destination], timeout=15)
            after = next((line.split("\t")[0] for line in actual.text().splitlines()
                          if line.partition("\t")[2] == destination), None) if actual.code == 0 else None
            return {"state": "success" if result.code == 0 and after == branch["oid"] else "blocked" if result.code not in (0, None) and after == remote_oid else "unknown",
                    "message": "Pushed branch history" if result.code == 0 and after == branch["oid"] else result.err or "Push outcome could not be confirmed; refresh",
                    "before": remote_oid, "after": after, "target": branch["oid"]}
        candidates = [w for w in worktrees(repo) if w.get("branch") == branch_ref and not w.get("bare")]
        if worktree_id:
            candidates = [w for w in candidates if w["id"] == worktree_id]
        if len(candidates) != 1:
            raise GitError("Select exactly one checkout for this branch before pulling")
        wt = candidates[0]
        if wt.get("oid") != branch["oid"]:
            raise GitError("Checkout moved; refresh before pulling", status=409)
        state = changes(repo, wt)
        if not state["complete"] or state["state"] == "unavailable":
            raise GitError("Checkout changes could not be read completely; pull is blocked")
        if state.get("operations"):
            raise GitError("Finish the current Git operation before pulling: " + ", ".join(state["operations"]))
        if state["count"]:
            def category(f: dict[str, Any]) -> str:
                return "untracked" if f["xy"] == "??" else "conflicted" if f["conflicted"] else "staged/unstaged" if "." not in f["xy"] else "staged" if f["xy"][0] != "." else "unstaged"
            paths = [f"{category(f)}: {f['path']}" for f in state["files"][:20]]
            raise GitError(f"Pull blocked by {state['count']} changed paths: " + "; ".join(paths)
                           + (f"; and {state['count'] - 20} more" if state["count"] > 20 else ""))
        _fetch(repo, cfg["remote"])
        after_fetch = {r["ref"]: r for r in refs(repo)}
        checkout_now = next((w for w in worktrees(repo) if w["id"] == wt["id"]), None)
        branch_now = after_fetch.get(branch_ref, {})
        if (not checkout_now or checkout_now.get("branch") != branch_ref or checkout_now.get("oid") != branch["oid"]
                or any(branch_now.get(k) != current[k] for k in ("oid", "upstream", "remote", "remote_ref"))
                or changes(repo, checkout_now).get("fingerprint") != state["fingerprint"]
                or remote_config(repo, cfg["remote"])["fingerprint"] != config["fingerprint"]):
            raise GitError("Checkout changed during fetch; refresh before pulling", status=409)
        target = after_fetch.get(current["upstream"], {}).get("oid")
        if not target:
            raise GitError("Upstream branch is missing after fetch")
        if gr.run(wt["path"], ["merge-base", "--is-ancestor", branch["oid"], target]).code != 0:
            raise GitError("Branch histories diverged or are incomplete; fast-forward pull is blocked")
        result = gr.run(wt["path"], ["merge", "--ff-only", target], timeout=45, read=False)
        after_result = gr.run(wt["path"], ["rev-parse", "--verify", "HEAD"])
        after = after_result.text() if after_result.code == 0 else None
        return {"state": "success" if result.code == 0 and after == target else "changed" if after == target else "blocked" if after == branch["oid"] and result.code is not None else "unknown",
                "message": "Pulled upstream history" if result.code == 0 and after == target else result.err or "Pull outcome needs refresh",
                "before": branch["oid"], "after": after, "target": target, "changes": changes(repo, wt)}
    finally:
        with _guard:
            _busy.discard(repo["common"])
        mutex.release()


class FetchScheduler:
    """Open views request ticks; no registry sweep or automatic future jobs.

    The common directory owns the cadence across orgs, worktrees and tabs.
    Closing the last view stops requests; an already started fetch may finish.
    """
    def __init__(self) -> None:
        self.jobs: dict[str, threading.Thread] = {}
        self.last: dict[str, float] = {}
        self.guard = threading.Lock()

    def request(self, slug: str, rid: str, now: float | None = None) -> bool:
        repo = repository(slug, rid)
        now = time.monotonic() if now is None else now
        with self.guard:
            self.jobs = {k: t for k, t in self.jobs.items() if t.is_alive()}
            key = repo["common"]
            if (not appsettings.git_periodic_fetch_enabled() or key in self.jobs
                    or now - self.last.get(key, float("-inf")) < 30 or len(self.jobs) >= 2):
                return False
            self.last[key] = now
            def job() -> None:
                try:
                    if appsettings.git_periodic_fetch_enabled():
                        fetch(slug, rid)
                except (GitError, settings.SettingsError, OSError):
                    pass  # Fetch records its failure for the observation response.
            thread = threading.Thread(target=job, name="git-fetch", daemon=True)
            self.jobs[key] = thread
            thread.start()
            return True

    def stop(self) -> None:
        for thread in list(self.jobs.values()):
            thread.join(timeout=50)


scheduler = FetchScheduler()
