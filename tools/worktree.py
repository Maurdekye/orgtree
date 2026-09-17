"""Small, fail-closed worktree lifecycle helper.

This module intentionally does not call ``git config`` or rewrite repository
configuration. It is used to create and remove private worktrees in the one
shape that works, to inspect checkouts, describe dependency setup, repair
registered paths after an agent rename, and preview cleanup. Cleanup is opt-in
and can only unlink a junction/reparse point that has been validated as an
owned link; it never follows the link or removes its target.

⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE. A worktree created UNDER THE
REPOSITORY ROOT needs no ``node_modules`` of its own, because Node resolves a
bare specifier by walking the directory chain upward and finds the shared tree
at the root. A worktree created anywhere else does not, which is what makes
people reach for a ``node_modules`` junction back into the real checkout — and
that junction is the cause of every worktree incident this project has had:

  * two checkouts sharing one dependency tree stop being private, so a test
    runner that clears its own scratch directory clears somebody else's too;
  * ``git worktree remove --force`` follows the junction out of the throwaway
    worktree and empties the real checkout behind it.

So ``add`` places the worktree under the repository root and verifies that the
dependencies actually resolve from there before it reports success, ``remove``
refuses ANY removal through a link it can see, and the junction route is
reachable only by asking for it in as many words.

⚠ ``remove`` refuses whether or not ``--force`` was asked for, and that is the
correction that matters. ``--force`` only overrides the dirty/untracked check;
it does not change how Git deletes the tree. A ``node_modules`` junction is
gitignored, so the worktree reads as clean and the *un-forced* removal is the
one an agent actually reaches - and it destroys the junction's target just as
completely. Measured, not assumed: see ``plan_remove``.

``cleanup-scan`` enumerates the links that already exist under a root without
following any of them, and hands back a plan that ``cleanup-apply`` can execute
against a re-validated filesystem. Removal always unlinks the link itself; the
target is never opened, walked or deleted.

⚠ TWO KNOWN LIMITS, both recorded so the next reader gets five minutes rather
than an afternoon, and neither fixed here:

* **An UNREADABLE reparse point deadlocks.** ``removal_scan`` counts a link
  whose target cannot be read as escaping - the safe direction - so ``remove``
  refuses it; ``accept_unscanned`` waives truncation only; ``cleanup_scan``
  declines to select it because its target is unknown; and ``cleanup_preview``
  preserves it as "target could not be validated". So that worktree cannot be
  removed by this tool at all, and the cleanup its refusal points at will not
  clear it. The obstacle is policy, not mechanism: ``os.rmdir`` removes a
  reparse point without following it. Analysis by worktree-setup, from the code
  rather than from a constructed case.
* **This repository is npm, and that is load-bearing.** Its 61,324-entry
  ``node_modules`` contains zero links, so the unconditional escaping-link
  refusal never fires on an ordinary installed tree. Under **pnpm** it would:
  ``node_modules/.pnpm`` is symlinks into a global store outside the repository,
  every one of which reads as escaping, and every worktree would become
  unremovable with no applicable waiver - ``accept_unscanned`` does not cover a
  found link, and ``cleanup-scan`` only selects links NAMED ``node_modules``.
  Changing package manager means revisiting this file.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import Any, Iterable, Mapping


REPARSE = 0x400
DEFAULT_HIDDEN = {".git", ".worktree", ".worktree-state.json"}

#: Where a private worktree belongs. Relative to the repository root, and
#: already ignored by the repository's own ``.gitignore``.
WORKTREES_DIR = ".worktrees"

#: The directory whose upward resolution is the whole point of the rule.
DEPENDENCY_DIR = "node_modules"

#: A scan of a worktree stops here rather than walking an unbounded tree. The
#: number is a safety valve, not a judgement: an honest ``truncated`` flag is
#: reported when it is hit, because a scan that quietly stopped early would
#: make "no links found" mean nothing.
#:
#: ⚠ SIZED SO THE ORDINARY CASE FITS. It was 50000, which a correctly-shaped
#: worktree (measured: 1,248 entries) never approached - but a worktree with a
#: REAL installed ``node_modules`` (measured: 61,324 entries) sails past it. A
#: junctioned ``node_modules`` is a reparse point and is never descended into,
#: so it scans small; only the real one is expensive. Once the truncation
#: refusal stopped being conditional on ``--force``, a limit below that figure
#: would have made every worktree anybody had run ``npm install`` in
#: permanently unremovable by this tool - and those are exactly the checkouts
#: that need cleaning up. Raising the ceiling does not remove the cliff, which
#: is why ``accept_unscanned`` exists as well; it moves the cliff past the case
#: that actually occurs, so the opt-out stays rare rather than routine.
SCAN_LIMIT = 400000

#: How deep ``find_reparse_points`` descends below its root before it stops and
#: SAYS it stopped.
#:
#: ⚠ DEPTH AND BUDGET ARE COUPLED, and getting that backwards produces a scan
#: that undercounts while reporting success. Raising the depth raises the entry
#: count; if the budget does not rise with it the walk truncates early and finds
#: FEWER links than a shallower one would. Measured on the live scratch root at
#: a 50000 budget: depths 3, 4 and 5 each found 77 links, while depth 6 found
#: ELEVEN - not because six was too deep, but because that root is 572,294
#: entries and the budget ran out. Raise the two together or not at all.
#:
#: The default is deliberately deep enough to be exhaustive on the shapes we
#: actually have. An earlier value of 4 was chosen from the observation that
#: junctions sit at ``<scratch>/<agent>/<worktree>/node_modules``; that was
#: wrong. worktree-setup's unbounded walk found links at depth 5 in the primary
#: scratch root and at depth 9 in the second one - 5 and 49 links respectively
#: below a depth-4 bound, none of which a depth-4 scan would have reported while
#: still printing ``complete: true``. A default that silently undercounts a
#: cleanup is worse than a slow one.
#:
#: 12 was still not enough to make the live roots a census - it left 743
#: directories undescended and ``census: false``, which is honest but is not the
#: answer an operator running a cleanup needs. The walk never follows a reparse
#: point, so it cannot cycle and depth is only a cost control; the entry BUDGET
#: is the real bound and it reports itself. So this is set high enough that a
#: real tree comes back exhaustive (measured: the full primary root is 572,301
#: entries and 46 seconds at unbounded depth) and left as a backstop rather than
#: a policy.
DEFAULT_SCAN_DEPTH = 64

#: Never descended into. Recorded instead, so the output still says they were
#: there. A real ``node_modules`` would exhaust the entry budget on its own and
#: truncate the part of the scan that matters; ``.git`` and ``.venv`` are the
#: same problem in smaller form. A link BY these names is still recorded - the
#: link check runs before the descent decision.
SCAN_SKIP_DIRS = {".git", DEPENDENCY_DIR, ".venv"}

#: The entry budget for a WHOLE-ROOT scan, which is a different scale of job
#: from scanning one worktree and needs its own number. The primary scratch root
#: measures 572,294 entries unbounded, so ``SCAN_LIMIT`` would truncate it - and
#: a truncated cleanup scan is the failure mode that leaves junctions behind
#: while the operator reads a count and believes it.
SCAN_ROOT_LIMIT = 2000000


def strip_extended_prefix(path: str) -> str:
    r"""Drop Windows' ``\\?\`` extended-length prefix from a raw link target.

    ⚠ NEEDED BEFORE ANY CONTAINMENT CHECK ON A LINK TARGET. ``os.readlink`` on a
    junction returns the target in extended-length form (``\\?\C:\...``), and
    ``\\?\C:\repo\x`` does not lexically match ``C:\repo`` — so a link pointing
    at a perfectly ordinary directory inside the worktree reads as one escaping
    it. Getting this backwards is not harmless in either direction: it would
    either refuse safe removals or, worse, describe an escaping link as
    contained. Normalize the spelling, never the containment rule.
    """
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def canonical(path: str | os.PathLike[str]) -> str:
    """Return a case-normalized absolute path without following links."""
    return os.path.normcase(os.path.abspath(strip_extended_prefix(os.fspath(path))))


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


def repository_root(path: str | os.PathLike[str]) -> str:
    """The top level of the MAIN checkout, asked of Git rather than guessed.

    ⚠ NOT ``rev-parse --show-toplevel``, which inside a linked worktree answers
    with that worktree. Using it would nest every new worktree under whichever
    one the agent happened to be standing in, so ``.worktrees`` would sprawl
    into a chain instead of being the one flat directory the team shares.
    ``--git-common-dir`` is the main checkout's ``.git`` from anywhere in the
    repository, and its parent is the root this helper means everywhere.
    """
    common = _git(os.fspath(path), "rev-parse", "--path-format=absolute",
                  "--git-common-dir").strip()
    return canonical(os.path.dirname(common))


def dependency_resolution(worktree: str | os.PathLike[str], *,
                          directory: str = DEPENDENCY_DIR) -> dict[str, Any]:
    """Walk the chain Node walks, and report where the dependencies come from.

    This is the check that turns the rule from folklore into something a
    command can assert. It never follows a link: a ``node_modules`` that IS a
    link is reported as one and flagged, because that is the shape that shares
    a dependency tree between two checkouts.
    """
    start = canonical(worktree)
    chain: list[dict[str, Any]] = []
    current = start
    while True:
        candidate = os.path.join(current, directory)
        kind = _entry_kind(candidate)
        if kind != "missing":
            chain.append({"path": candidate, "kind": kind})
            linked = kind in {"symlink", "reparse"}
            return {
                "worktree": start,
                "resolves": True,
                "resolved": candidate,
                "kind": kind,
                "linked": linked,
                "own": canonical(os.path.dirname(candidate)) == start,
                "searched": chain,
                "note": ("dependencies are reached through a link, which shares one tree "
                         "between checkouts - this is the shape that loses data"
                         if linked else
                         "dependencies resolve upward to a real directory; nothing is shared by link"),
            }
        chain.append({"path": candidate, "kind": kind})
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return {
        "worktree": start,
        "resolves": False,
        "resolved": None,
        "kind": "missing",
        "linked": False,
        "own": False,
        "searched": chain,
        "note": (f"no {directory} anywhere on the upward chain - this worktree is not under a "
                 f"checkout that has one, so its suites cannot run without installing "
                 f"dependencies into it"),
    }


def plan_add(repository: str | os.PathLike[str], name: str, *, base: str = "main",
             branch: str | None = None, path: str | None = None,
             allow_outside_root: bool = False) -> dict[str, Any]:
    """Decide where a private worktree goes, and refuse the shapes that hurt.

    The default destination is ``<repository root>/.worktrees/<name>``. A
    destination outside the root is refused unless it is asked for explicitly,
    because outside the root is exactly the case that has no upward
    ``node_modules`` and therefore invites a junction.
    """
    if not name or name.strip() != name or any(c in name for c in "\\/:*?\"<>|"):
        raise ValueError("worktree name must be a single plain path segment")
    root = repository_root(repository)
    destination = canonical(path) if path else os.path.join(root, WORKTREES_DIR, name)
    inside = contained(destination, root) and canonical(destination) != root
    if not inside and not allow_outside_root:
        raise ValueError(
            f"refusing to place a worktree outside the repository root ({root}). "
            f"A worktree under the root resolves {DEPENDENCY_DIR} upward and its suites "
            f"just run; one outside it does not, and the usual next step - junctioning "
            f"{DEPENDENCY_DIR} back into the real checkout - is what deleted 783 MB of "
            f"somebody's checkout. Pass allow_outside_root only if you have another way "
            f"to supply dependencies and accept that this worktree is not private."
        )
    if contained(destination, os.path.join(root, ".git")):
        raise ValueError("refusing to place a worktree inside .git")
    if _entry_kind(destination) != "missing":
        raise ValueError(f"destination already exists: {destination}")
    return {
        "repository": root,
        "name": name,
        "path": destination,
        "branch": branch or name,
        "base": base,
        "inside_repository_root": inside,
        "dependency_junction": False,
        "command": ["git", "-C", root, "worktree", "add", "-b", branch or name,
                    destination, base],
    }


def add(repository: str | os.PathLike[str], name: str, *, base: str = "main",
        branch: str | None = None, path: str | None = None,
        allow_outside_root: bool = False, apply: bool = True) -> dict[str, Any]:
    """Create the worktree, then PROVE its suites can run before reporting success.

    Verification is the point. ``git worktree add`` succeeding says nothing
    about whether the checkout is usable, and an agent that discovers the
    difference does so by debugging its own patch against environmental
    failures.
    """
    plan = plan_add(repository, name, base=base, branch=branch, path=path,
                    allow_outside_root=allow_outside_root)
    if not apply:
        plan["applied"] = False
        return plan
    result = subprocess.run(plan["command"], check=False, capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git worktree add failed")
    if _entry_kind(plan["path"]) != "directory":
        raise RuntimeError("git reported success but the worktree is not a directory")
    plan["applied"] = True
    plan["dependencies"] = dependency_resolution(plan["path"])
    plan["ready"] = bool(plan["dependencies"]["resolves"])
    plan["run_tests"] = ["npm", "test"] if plan["ready"] else None
    plan["next"] = (
        f"cd {plan['path']} && npm test"
        if plan["ready"] else
        f"dependencies do not resolve from {plan['path']}; install them there before "
        f"running the suites, and do NOT link {DEPENDENCY_DIR} in from another checkout"
    )
    return plan


def removal_scan(worktree: str | os.PathLike[str], *, limit: int = SCAN_LIMIT) -> dict[str, Any]:
    """Find every link inside a worktree WITHOUT following a single one.

    ``git worktree remove --force`` deletes the tree, and a directory junction
    inside that tree is a door out of it. This scan is what makes the door
    visible before anything is deleted; it is also why the walk below never
    descends into a reparse point.
    """
    root = canonical(worktree)
    if _entry_kind(root) != "directory":
        raise ValueError("worktree must be a real directory")
    links: list[dict[str, Any]] = []
    seen = 0
    truncated = False
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if seen > limit:
                truncated = True
                pending = []
                break
            kind = _entry_kind(entry.path)
            if kind in {"symlink", "reparse"}:
                try:
                    target = os.readlink(entry.path)
                except OSError:
                    target = None
                links.append({
                    "path": canonical(entry.path),
                    "kind": kind,
                    "target": target,
                    # A link whose target sits outside the worktree is the one
                    # that turns a delete of this tree into a delete of another.
                    # An unreadable target counts as escaping, and so does a
                    # target spelled with an 8.3 short name the root does not
                    # use — both are false alarms in the safe direction, which
                    # costs a refused --force. The unsafe direction, calling an
                    # escaping link contained, is not reachable this way:
                    # respelling a path never moves it inside the root.
                    "escapes": not (target is not None and contained(target, root)),
                })
                continue
            if kind == "directory":
                pending.append(entry.path)
    escaping = [link for link in links if link["escapes"]]
    return {
        "worktree": root,
        "links": links,
        "escaping": escaping,
        "entries_scanned": min(seen, limit),
        "truncated": truncated,
        # ``removal_safe`` is the accurate name: an escaping link makes ANY
        # removal unsafe, not only a forced one. ``force_safe`` is kept as an
        # alias because callers and tests already read it, and it has never
        # meant anything different - only the name was narrower than the fact.
        "removal_safe": not escaping and not truncated,
        "force_safe": not escaping and not truncated,
    }


def plan_remove(repository: str | os.PathLike[str], worktree: str | os.PathLike[str], *,
                force: bool = False, accept_unscanned: bool = False) -> dict[str, Any]:
    """Decide whether this removal is safe, and say exactly why when it is not.

    ``accept_unscanned`` waives ONLY the truncated-scan refusal, and nothing
    else. It exists because "I could not finish looking" and "I looked and found
    a link" are different facts that deserve different answers: the second is a
    measured hazard and is never waivable, while the first is an unknown the
    caller may be entitled to accept. It is a separate word from ``force`` on
    purpose - ``force`` means "discard my changes", and overloading it into
    "and also stop checking for links" is how the original defect happened.
    """
    root = repository_root(repository)
    target = canonical(worktree)
    if canonical(target) == root:
        raise ValueError("refusing to remove the main checkout")
    scan = removal_scan(target)
    dirty, unmerged, readable = _status(target)
    refusals: list[str] = []
    # ⚠ DELIBERATELY NOT `if force`. ``--force`` is not the dangerous ingredient
    # and never was: it overrides the dirty/untracked CHECK, it does not change
    # how Git deletes the tree afterwards. Measured on git 2.52.0.windows.1, in
    # a real worktree under the repository root with a ``node_modules`` junction
    # pointing outside it: ``git worktree remove`` with NO flags exited 0 and
    # emptied the junction's target, exactly as ``--force`` did.
    #
    # The un-forced path was the one actually reached, too. A ``node_modules``
    # junction is gitignored, so ``status`` reports the worktree clean, so none
    # of the force-only refusals below applied and the removal went straight
    # through. Gating the link check on ``force`` therefore guarded the careful
    # route and left the default one open. Both refuse now.
    if scan["escaping"]:
        refusals.append(
            "refusing to remove: this worktree contains {count} link(s) pointing outside it "
            "({paths}). Removing the worktree deletes through them and takes the target with "
            "it - this is the failure that emptied a 783 MB checkout, and it happens WITHOUT "
            "--force just the same. Unlink them first (`python tools/worktree.py cleanup-scan "
            "{worktree}`), then remove the worktree."
            .format(count=len(scan["escaping"]),
                    paths=", ".join(link["path"] for link in scan["escaping"][:4]),
                    worktree=target)
        )
    # The truncation refusal IS waivable, unlike the one above. A truncated scan
    # reports an unknown; an escaping link reports a measured hazard. Waiving
    # the first is a decision a caller can be entitled to make, and refusing it
    # outright would make every worktree containing a real installed
    # node_modules permanently unremovable by this tool - which is the
    # population most in need of cleaning up.
    if scan["truncated"] and not accept_unscanned:
        refusals.append(
            f"refusing to remove: the link scan stopped after {SCAN_LIMIT} entries, so "
            f"'no escaping links' would be a guess rather than a result. If this worktree "
            f"simply has a large real {DEPENDENCY_DIR} installed in it, that is expected - "
            f"pass accept_unscanned (--accept-unscanned) to remove it anyway, which waives "
            f"ONLY this unknown and never a link the scan actually found."
        )
    if (dirty or unmerged) and not force:
        refusals.append("worktree has uncommitted or unmerged changes; commit them or pass force")
    if not readable and not force:
        refusals.append("worktree status could not be read")
    command = ["git", "-C", root, "worktree", "remove", target]
    if force:
        command.insert(-1, "--force")
    return {
        "repository": root,
        "worktree": target,
        "force": force,
        "accept_unscanned": accept_unscanned,
        "dirty": dirty,
        "unmerged": unmerged,
        "links": scan["links"],
        "escaping": scan["escaping"],
        "truncated": scan["truncated"],
        "refusals": refusals,
        "safe": not refusals,
        "command": command,
    }


def remove(repository: str | os.PathLike[str], worktree: str | os.PathLike[str], *,
           force: bool = False, accept_unscanned: bool = False,
           apply: bool = True) -> dict[str, Any]:
    """Remove a worktree, but never remove one through a link that leaves it."""
    plan = plan_remove(repository, worktree, force=force, accept_unscanned=accept_unscanned)
    if not plan["safe"]:
        raise ValueError("; ".join(plan["refusals"]))
    if not apply:
        plan["applied"] = False
        return plan
    result = subprocess.run(plan["command"], check=False, capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "git worktree remove failed")
    plan["applied"] = True
    return plan


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
                     apply: bool = False,
                     accept_shared_dependencies: bool = False) -> dict[str, Any]:
    """Describe deterministic local setup without granting Git metadata writes.

    The returned command is intentionally data only. A caller may execute it
    after review; this helper never runs package managers or writes ``.git``.

    ⚠ ``dependency_source`` is the junction route and it is now GATED. When the
    worktree already reaches a real dependency tree by walking upward — which
    is true of every worktree placed under the repository root — linking one in
    adds nothing and costs privacy, so it is refused outright. When upward
    resolution genuinely is unavailable, the caller must still say
    ``accept_shared_dependencies`` in as many words, because the resulting
    checkout shares the most failure-prone directory in the repository with
    another one and a later ``remove --force`` can delete through the link.
    """
    root = canonical(worktree)
    if _entry_kind(root) != "directory":
        raise ValueError("worktree must be a real directory")
    resolution = dependency_resolution(root)
    link: dict[str, Any] | None = None
    if dependency_source:
        if resolution["resolves"] and not resolution["linked"]:
            raise ValueError(
                f"refusing to link {DEPENDENCY_DIR}: this worktree already resolves it "
                f"upward to {resolution['resolved']}, so its suites run as they stand. "
                f"A junction here would buy nothing and would share one dependency tree "
                f"between two checkouts - the shape that lets one agent's test run delete "
                f"another's bundles and lets `remove --force` delete through the link."
            )
        if not accept_shared_dependencies:
            raise ValueError(
                f"refusing to link {DEPENDENCY_DIR} without accept_shared_dependencies. "
                f"The supported fix is to place the worktree UNDER the repository root "
                f"({WORKTREES_DIR}/<name>), where {DEPENDENCY_DIR} resolves upward and no "
                f"link is needed; the second choice is installing dependencies into this "
                f"worktree. Linking makes the worktree non-private and is opt-in only."
            )
        source = canonical(dependency_source)
        destination = os.path.join(root, DEPENDENCY_DIR)
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
        # Reported whether or not a link was asked for: an agent that can see
        # "already resolves upward to <path>" does not need to be told a rule,
        # and does not go looking for a junction.
        "dependencies": resolution,
        "note": ("Dependencies already resolve upward; no install and no link are needed."
                 if resolution["resolves"] and not resolution["linked"] else
                 "Run this explicitly in the fresh worktree; no generic Git write is granted."),
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


def find_reparse_points(root: str | os.PathLike[str], *, max_depth: int = DEFAULT_SCAN_DEPTH,
                        limit: int = SCAN_ROOT_LIMIT) -> dict[str, Any]:
    """Enumerate every link under a root WITHOUT following a single one.

    This is the half that was missing. ``cleanup_preview`` could always validate
    a candidate, but nothing produced the candidate list, so a cleanup could
    only ever be run against paths somebody had already typed out by hand.

    Both bounds are REPORTED rather than applied quietly. A scan that stopped
    early and said nothing would turn "no links found" into a claim it has not
    earned, and this is a tool whose whole job is to be trusted about what is
    and is not there. ``truncated`` means the entry budget ran out;
    ``depth_limited`` lists directories that were not descended into.

    Directories named in ``SCAN_SKIP_DIRS`` are recorded and not descended.
    A real ``node_modules`` holds tens of thousands of entries and cannot
    contain what this scan is looking for, so walking it would exhaust the
    budget and truncate the part that matters. A ``node_modules`` that IS a
    link is still recorded - the link check happens first.
    """
    start = canonical(root)
    if _entry_kind(start) != "directory":
        raise ValueError("scan root must be a real directory")
    if max_depth < 1:
        raise ValueError("max_depth must be positive")
    links: list[dict[str, Any]] = []
    unreadable: list[str] = []
    depth_limited: list[str] = []
    skipped: list[str] = []
    seen = 0
    truncated = False
    pending: list[tuple[str, int]] = [(start, 0)]
    while pending:
        current, depth = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            unreadable.append(current)
            continue
        for entry in entries:
            seen += 1
            if seen > limit:
                truncated = True
                pending = []
                break
            kind = _entry_kind(entry.path)
            if kind in {"symlink", "reparse"}:
                try:
                    target = os.readlink(entry.path)
                except OSError:
                    target = None
                links.append({
                    "path": canonical(entry.path),
                    "name": os.path.basename(entry.path),
                    "kind": kind,
                    "target": strip_extended_prefix(target) if target is not None else None,
                    # Unreadable counts as escaping, which is the safe
                    # direction: it costs a preserved link, never a followed one.
                    "escapes_root": not (target is not None and contained(target, start)),
                })
                continue
            if kind != "directory":
                continue
            if os.path.basename(entry.path) in SCAN_SKIP_DIRS:
                skipped.append(entry.path)
                continue
            if depth + 1 >= max_depth:
                depth_limited.append(entry.path)
                continue
            pending.append((entry.path, depth + 1))
    return {
        "root": start,
        "links": links,
        "escaping": [link for link in links if link["escapes_root"]],
        "entries_scanned": min(seen, limit),
        "truncated": truncated,
        "depth_limited": depth_limited,
        "skipped_directories": skipped,
        "unreadable": unreadable,
        "max_depth": max_depth,
        # Two different honesties, because they are two different facts and
        # collapsing them makes the useful one useless. ``complete`` means
        # everything WITHIN the requested depth was examined - the scan did what
        # it was asked to. ``exhaustive`` additionally means nothing anywhere
        # was skipped. On any real tree some directory is always deeper than the
        # bound, so a single flag folding them together would read False forever
        # and stop carrying information.
        "complete": not truncated and not unreadable,
        "exhaustive": not truncated and not unreadable and not depth_limited,
    }


def cleanup_scan(root: str | os.PathLike[str], *, name: str | None = DEPENDENCY_DIR,
                 max_depth: int = DEFAULT_SCAN_DEPTH, limit: int = SCAN_ROOT_LIMIT) -> dict[str, Any]:
    """Enumerate the hazard shape and return a plan ``apply_cleanup`` can run.

    Selection is deliberately narrow. A link is marked for unlinking only when
    it is named ``name`` (``node_modules`` by default), its target is readable,
    and that target lies OUTSIDE the scanned root - which is the exact shape
    that turns a worktree removal into somebody else's data loss. Every other
    link found is listed and preserved, with the reason attached, so the output
    documents what was seen and skipped instead of quietly narrowing.

    ⚠ Unlinking one of these leaves that worktree unable to resolve its
    dependencies, because the link was how it resolved them. That is correct
    and intended - the worktree was never private to begin with - but it is a
    consequence to know about rather than discover, so it is stated in ``note``.
    """
    survey = find_reparse_points(root, max_depth=max_depth, limit=limit)
    selected = [
        link["path"] for link in survey["links"]
        if (name is None or link["name"].casefold() == name.casefold())
        and link["escapes_root"] and link["target"] is not None
    ]
    preview = cleanup_preview(survey["root"], [link["path"] for link in survey["links"]],
                              owned=selected)
    # ``cleanup_preview`` can only say "not registered as an owned link", which
    # is true and useless to the person reading the plan: it describes the
    # mechanism rather than the decision. Say which of this function's own
    # criteria the link failed, so a preserved entry can be argued with instead
    # of just wondered about.
    by_path = {link["path"]: link for link in survey["links"]}
    for entry in preview["targets"]:
        link = by_path.get(entry["path"])
        if entry["action"] == "unlink" or link is None:
            continue
        if name is not None and link["name"].casefold() != name.casefold():
            entry["reason"] = f"not selected: named {link['name']!r}, not {name!r}"
        elif link["target"] is None:
            entry["reason"] = "not selected: link target could not be read"
        elif not link["escapes_root"]:
            entry["reason"] = (f"not selected: target {link['target']} is INSIDE the scanned "
                               f"root, so removing this tree does not reach outside it")
    preview["survey"] = survey
    preview["selection"] = {
        "name": name,
        "escaping_only": True,
        "selected": len(selected),
        "links_found": len(survey["links"]),
    }
    preview["complete"] = survey["complete"]
    preview["exhaustive"] = survey["exhaustive"]
    # The order matters and is the whole safe sequence: unlink the junction
    # FIRST, then remove the worktree. Doing it the other way round is the
    # incident. ``rmdir`` on a junction removes the link and does not follow it;
    # a recursive delete follows it and empties the target.
    preview["remediation"] = [
        {"step": 1, "what": "unlink the junction (never follows it)",
         "command": ["cmd", "/c", "rmdir", "<link>"],
         "equivalently": "python tools/worktree.py cleanup-apply <plan.json> --confirm",
         "never": ["rmdir /s", "Remove-Item -Recurse", "rm -rf"]},
        {"step": 2, "what": "remove the worktree, now that nothing leaves it",
         "command": ["python", "tools/worktree.py", "remove", "<worktree>"]},
    ]
    # ⚠ THE WARNING GOES FIRST WHEN IT CHANGES THE NUMBER. Whoever acts on this
    # plan is reading it for a count, and a caveat printed after the remediation
    # steps arrives too late to stop them treating a partial scan as a census.
    # A bounded scan that nonetheless SELECTED something is the dangerous
    # combination: it looks like a completed cleanup and silently leaves
    # junctions behind.
    warnings: list[str] = []
    if not survey["complete"]:
        warnings.append(
            "⚠ THIS SCAN IS INCOMPLETE (see survey.truncated / survey.unreadable). It is not a "
            "census of what exists under this root - raise --limit and rerun before treating "
            "any count here as complete."
        )
    elif not survey["exhaustive"]:
        deeper = len(survey["depth_limited"])
        warnings.append(
            f"⚠ THIS SCAN IS BOUNDED AT --max-depth {max_depth}; {deeper} director"
            f"{'y' if deeper == 1 else 'ies'} below that depth {'was' if deeper == 1 else 'were'}"
            f" not descended into, so links below that "
            f"depth are NOT in this plan and NOT in its counts. Everything within the depth was "
            f"examined ('complete'), which is not the same as everything ('exhaustive'). Raise "
            f"--max-depth AND --limit together - raising depth alone exhausts the budget and "
            f"finds fewer links, not more."
            + (" Links WERE selected at this depth, so applying this plan will clean up some "
               "and leave the deeper ones in place." if selected else "")
        )
    preview["note"] = " ".join(warnings + [
        "Unlinking removes the link itself and never its target. A worktree whose "
        f"{DEPENDENCY_DIR} link is removed can no longer resolve dependencies from it; "
        "the supported fix is to recreate that worktree under the repository root, where "
        f"{DEPENDENCY_DIR} resolves upward and no link is needed."
    ])
    # One word for the only question an operator running a cleanup actually has:
    # "is this everything?" It is true only when nothing was skipped for any
    # reason - not budget, not readability, not depth.
    preview["census"] = survey["exhaustive"]
    return preview


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


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI, separately from running it.

    Separate so the defaults are testable. A CLI default that disagrees with the
    API default it shadows is invisible from either side on its own - you have
    to compare them, and you cannot compare what you cannot construct.
    """
    parser = argparse.ArgumentParser(
        description="create, verify and remove private worktrees safely")
    sub = parser.add_subparsers(dest="command", required=True)
    add_ = sub.add_parser("add", help="create a private worktree under the repository root")
    add_.add_argument("name", help="worktree directory name under .worktrees/")
    add_.add_argument("--repository", default=".", help="any path inside the repository")
    add_.add_argument("--base", default="main", help="commit or branch to start from")
    add_.add_argument("--branch", help="branch to create (defaults to the name)")
    add_.add_argument("--path", help="explicit destination; must be under the repository root")
    add_.add_argument("--allow-outside-root", action="store_true",
                      help="place it outside the root; its suites will not find dependencies")
    add_.add_argument("--dry-run", action="store_true", help="print the plan without creating it")
    rm = sub.add_parser("remove", help="remove a worktree without deleting through a link")
    rm.add_argument("worktree")
    rm.add_argument("--repository", default=".")
    rm.add_argument("--force", action="store_true",
                    help="discard uncommitted changes. It does NOT affect the link check: a "
                         "removal is refused when a link leaves the worktree whether or not "
                         "this is passed, because an un-forced removal deletes through a link "
                         "exactly as a forced one does")
    rm.add_argument("--accept-unscanned", action="store_true",
                    help="proceed when the link scan could not finish (a large real "
                         f"{DEPENDENCY_DIR} does this). Waives only that unknown, never a "
                         "link the scan actually found")
    rm.add_argument("--dry-run", action="store_true")
    verify = sub.add_parser("verify", help="report where an existing worktree gets dependencies")
    verify.add_argument("worktree")
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
    setup.add_argument("--accept-shared-dependencies", action="store_true",
                       help="opt in to a node_modules link and to this worktree not being private")
    preview = sub.add_parser("cleanup-preview")
    preview.add_argument("root")
    preview.add_argument("candidates", nargs="+")
    scan = sub.add_parser(
        "cleanup-scan",
        help="enumerate escaping dependency links under a root and emit a cleanup plan")
    scan.add_argument("root", help="directory to scan; links are never followed")
    scan.add_argument("--name", default=DEPENDENCY_DIR,
                      help=f"only select links with this name (default {DEPENDENCY_DIR}); "
                           f"pass --name '' to consider every name")
    # ⚠ SCAN_ROOT_LIMIT, not SCAN_LIMIT. These defaults must match the ones on
    # ``cleanup_scan`` itself: this is the path an operator actually runs, and a
    # CLI default below the API default makes the command truncate on a real
    # root and emit a short plan while the library call on the same root returns
    # a full one. That shipped once - the whole-root budget is 5x the
    # per-worktree one, and borrowing the smaller number here cut a 572,301-entry
    # scan off at 400,000 and reported 64 links where there are 82.
    scan.add_argument("--max-depth", type=int, default=DEFAULT_SCAN_DEPTH)
    scan.add_argument("--limit", type=int, default=SCAN_ROOT_LIMIT)
    apply_ = sub.add_parser(
        "cleanup-apply",
        help="unlink the links a cleanup-scan plan selected, after re-validating each one")
    apply_.add_argument("plan", help="path to a plan written by cleanup-scan, or - for stdin")
    apply_.add_argument("--confirm", action="store_true",
                        help="required; without it nothing is unlinked")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return _dispatch(args)
    except ValueError as error:
        # A refusal is an ANSWER, not a crash. Printing a traceback buries the
        # one sentence that says what to do next under a stack the reader did
        # not ask for, and the refusals in this file are written to be read -
        # they name the hazard and the command that resolves it.
        print(f"refused: {error}", file=sys.stderr)
        return 2
    except RuntimeError as error:
        # ⚠ A DIFFERENT WORD ON PURPOSE. RuntimeError is raised when git itself
        # failed, which is a breakage; ValueError is this tool declining, which
        # is a decision. Printing "refused" over a git failure would tell the
        # reader their request was judged and rejected when in fact nothing
        # judged it, and they would go looking for a policy to satisfy instead
        # of at the error git actually returned.
        print(f"error: {error}", file=sys.stderr)
        return 1


def _dispatch(args: argparse.Namespace) -> int:
    if args.command == "add":
        value = add(args.repository, args.name, base=args.base, branch=args.branch,
                    path=args.path, allow_outside_root=args.allow_outside_root,
                    apply=not args.dry_run)
    elif args.command == "remove":
        value = remove(args.repository, args.worktree, force=args.force,
                       accept_unscanned=args.accept_unscanned, apply=not args.dry_run)
    elif args.command == "verify":
        value = dependency_resolution(args.worktree)
    elif args.command == "inventory":
        value = inventory(args.repository, query=args.query, limit=args.limit, include_hidden=args.include_hidden)
    elif args.command == "setup":
        value = dependency_setup(args.worktree, package_manager=args.package_manager,
                                 dependency_source=args.dependency_source, apply=args.apply,
                                 accept_shared_dependencies=args.accept_shared_dependencies)
    elif args.command == "cleanup-scan":
        value = cleanup_scan(args.root, name=args.name or None,
                             max_depth=args.max_depth, limit=args.limit)
    elif args.command == "cleanup-apply":
        raw = sys.stdin.read() if args.plan == "-" else Path(args.plan).read_text(encoding="utf-8")
        value = apply_cleanup(json.loads(raw), confirm=args.confirm)
    else:
        value = cleanup_preview(args.root, args.candidates)
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
