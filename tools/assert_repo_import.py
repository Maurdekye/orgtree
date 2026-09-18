"""Prove which checkout an ad-hoc probe imported, and refuse to report otherwise.

An ad-hoc harness -- a benchmark, a one-off probe, a script in an agent's
scratch folder -- lives outside the repository and reaches it by hand::

    sys.path.insert(0, os.path.join(REPO, "engine", "backend"))
    from orgtree import store

That pattern is correct and it wins **while REPO is right**.  The defect is what
happens when REPO is *wrong* -- a typo, a shell-quoting slip, a worktree since
removed.  The insert then points at nothing, and the packaged runtime's
``python313._pth`` (at ``C:\\Program Files\\Orgtree\\resources\\engine\\runtime\\``)
lists ``../backend``, so the **installed** build silently supplies ``orgtree``
instead.  No ``ImportError`` is raised.  The probe measures the shipped code and
prints a plausible number.  Two arms of a real performance A/B were lost to
exactly this; the only thread that caught it was an empty provenance field in a
result file.

Two guards that look sufficient and are not:

* ``-I`` drops ``PYTHONPATH`` but does **not** touch ``._pth`` entries, so the
  installed backend is still on ``sys.path`` in isolated mode.
* Hashing the module files at ``REPO`` proves those files are correct.  It
  cannot detect an import that bypassed the location it hashed.

Only the imported module's own ``__file__`` settles it.  That is the whole
content of this check.

Usage -- two lines at the top of a probe, before the engine is imported::

    sys.path.insert(0, os.path.join(REPO, "tools"))
    from assert_repo_import import assert_repo_import
    provenance = assert_repo_import(REPO)           # raises, loudly, if wrong
    from orgtree import store                       # now provably this checkout
    ...
    provenance.write_result(out_path, {"ms": 8.2})  # carries a non-empty sha

and from the shell, which is also how both directions are demonstrated::

    python tools/assert_repo_import.py --repo <path> [--result out.json] [names...]

Relationship to ``tests/import_provenance.py``
----------------------------------------------
That module guards ``tests/test_*.py``, derives the checkout from **its own
location**, and deliberately **refuses rather than repairs**: a bare test run
that has been quietly made to work is the same defect one step further along,
and the sanctioned runner ``tools/run-python-verification.py`` already puts the
roots on ``sys.path`` for it.

This module guards scripts that live **outside** the checkout, cannot derive it
from their own location, and have nothing to put the roots on ``sys.path`` at
all.  For those, placing the roots is the job, so this one **does** repair --
but only after proving that the root it was handed is a real orgtree checkout,
which is the step that catches the wrong path before the silent fallback can
answer in its place.  Pass ``insert_path=False`` for refuse-only behaviour.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

__all__ = [
    "ProvenanceError",
    "RepoRootError",
    "ForeignImportError",
    "Provenance",
    "GUARDED",
    "assert_repo_import",
    "import_roots",
    "expected_locations",
    "repo_commit",
    "origin_of",
    "main",
]

# The same two roots ``tools/run-python-verification.py`` makes visible, in the
# same order, so a probe and the sanctioned runner resolve the engine alike.
GUARDED = ("orgtree", "engine")

BANNER = "IMPORT PROVENANCE FAILED"
OK = "provenance OK:"


class ProvenanceError(RuntimeError):
    """The code that got imported cannot be shown to be this checkout's."""


class RepoRootError(ProvenanceError):
    """The repo root handed in is not an orgtree checkout at all."""


class ForeignImportError(ProvenanceError, ImportError):
    """A guarded package resolved to a path outside the repo root."""


def _normal(path: object) -> str:
    """Case-fold and resolve; Windows paths differ in case and in junctions."""
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def _within(path: object, root: object) -> bool:
    candidate, parent = _normal(path), _normal(root)
    return candidate == parent or candidate.startswith(parent + os.sep)


def expected_locations(name: str, roots: list[Path]) -> list[Path]:
    """Every path ``name`` may legitimately have come from, exactly.

    Mere containment under the repo root is not enough, and this is not
    hypothetical: worktrees live at ``<repo>/.worktrees/<agent>``, so a probe
    handed the MAIN root while its import resolves inside a worktree is
    "within the repo" and would pass a containment test while measuring a
    different tree.  That is the same wrong-code-measured defect one level
    down, so the origin must match the module's dotted name against a root.
    """
    relative = name.split(".")
    candidates: list[Path] = []
    for root in roots:
        base = root.joinpath(*relative)
        candidates += [base / "__init__.py", base.with_suffix(".py"), base]
    return candidates


def import_roots(repo_root: object) -> list[Path]:
    """Return the only checkout roots a probe should make visible."""
    repo = Path(str(repo_root))
    return [repo, repo / "engine" / "backend"]


def repo_commit(repo_root: object) -> tuple[str | None, bool | None, str | None]:
    """Return ``(sha, dirty, problem)`` for the checkout at ``repo_root``.

    ``sha`` is the full 40-character HEAD.  ``dirty`` says whether tracked files
    differ from it, because a sha alone describes a tree that may not be the one
    that ran.  ``problem`` is the reason both are ``None`` -- git missing, not a
    repository, an unborn HEAD -- so a caller records *why* rather than writing
    an empty field and losing the only thread that ever caught this.
    """
    repo = str(repo_root)

    def _git(*args: str) -> str:
        return subprocess.run(
            ("git", "-C", repo, *args),
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()

    try:
        sha = _git("rev-parse", "HEAD")
        # Untracked files count: a stray module in the tree can shadow an
        # import and change what ran, which is the whole subject here.
        # ``.gitignore``d paths still do not, so build output stays quiet.
        dirty = bool(_git("status", "--porcelain"))
    except FileNotFoundError:
        return None, None, "git executable not found"
    except subprocess.TimeoutExpired:
        return None, None, "git timed out"
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        return None, None, (detail[0] if detail else "git exited %d" % exc.returncode)
    if len(sha) != 40 or any(character not in "0123456789abcdef" for character in sha):
        return None, None, "git returned an unusable HEAD: %r" % (sha,)
    return sha, dirty, None


def origin_of(name: str) -> str | None:
    """Where ``name`` DID come from, or failing that where it WOULD come from.

    An already-imported module is authoritative: that is the code this process
    is actually running, and no later ``sys.path`` repair can change it.  That
    is the case a prospective-only check misses.  ``None`` means the package is
    not importable at all, which this guard reports as its own failure rather
    than leaving to a later ``ModuleNotFoundError`` in the caller.
    """
    imported = sys.modules.get(name)
    if imported is not None:
        origin = getattr(imported, "__file__", None)
        if origin:
            return origin
        return next(iter(getattr(imported, "__path__", ()) or ()), None)
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None
    if spec is None:
        return None
    return spec.origin or next(iter(spec.submodule_search_locations or ()), None)


class Provenance:
    """The evidence that a probe loaded the code it says it loaded."""

    def __init__(self, repo: Path, roots: list[Path], origins: dict[str, str],
                 commit: str | None, dirty: bool | None,
                 commit_problem: str | None) -> None:
        self.repo = repo
        self.roots = roots
        self.origins = origins
        self.commit = commit
        self.dirty = dirty
        self.commit_problem = commit_problem

    @property
    def short_commit(self) -> str:
        return self.commit[:12] if self.commit else "unknown"

    def receipt(self) -> list[str]:
        """Lines proving the check RAN.

        A guard that is silent when it passes is indistinguishable from a guard
        that was never called, which is the exact failure class this module
        exists to close.
        """
        head = "%s repo %s @ %s" % (OK, self.repo, self.short_commit)
        if self.dirty:
            head += "+dirty"
        if not self.commit:
            head += " (%s)" % self.commit_problem
        return [head] + ["%s %s <- %s" % (OK, name, origin)
                         for name, origin in self.origins.items()]

    def as_dict(self) -> dict[str, object]:
        return {
            "repo": str(self.repo),
            "commit": self.commit,
            "commit_short": self.short_commit,
            "dirty": self.dirty,
            "commit_problem": self.commit_problem,
            "import_roots": [str(item) for item in self.roots],
            "import_provenance": dict(self.origins),
            "checked_by": "tools/assert_repo_import.py",
        }

    def stamp(self, payload: object = None, key: str = "provenance") -> dict[str, object]:
        """Return ``payload`` with a non-empty provenance block attached."""
        result: dict[str, object] = dict(payload) if isinstance(payload, dict) else {}
        if payload is not None and not isinstance(payload, dict):
            result["result"] = payload
        result[key] = self.as_dict()
        return result

    def write_result(self, path: object, payload: object = None,
                     key: str = "provenance") -> Path:
        """Write a stamped result file.

        Reaching this call at all is the proof: ``assert_repo_import`` raises
        before a caller can get here.
        """
        target = Path(str(path))
        if str(target.parent) and not target.parent.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.stamp(payload, key), indent=2), encoding="utf-8")
        return target


def _repo_report(repo: Path, raw: object, marker: object) -> str:
    return (
        "%s -- the repo root is not an orgtree checkout, so nothing was "
        "imported and no result was produced.\n"
        "    repo root given : %r\n"
        "    resolved to     : %s\n"
        "    expected file   : %s  (missing)\n"
        "A wrong root does NOT raise ImportError on this machine: the packaged "
        "runtime's python313._pth lists ../backend, so the INSTALLED build "
        "would have supplied `orgtree` silently and this probe would have "
        "measured the shipped code. Check the path -- a typo, a quoting slip, "
        "or a worktree that has since been removed."
        % (BANNER, raw, repo, marker)
    )


def _foreign_report(name: str, origin: str | None, repo: Path, roots: list[Path]) -> str:
    return (
        "%s -- refusing to produce a result.\n"
        "    %s was imported from : %s\n"
        "    this checkout would give  : %s\n"
        "    repo root                 : %s\n"
        "    PYTHONPATH                : %s\n"
        "Whatever this run would have reported describes that other code and "
        "says nothing about this checkout. If the path above is under Program "
        "Files, the installed build answered the import. If `%s` was already "
        "imported before this check ran, no sys.path repair can undo it -- call "
        "assert_repo_import BEFORE importing the engine."
        % (BANNER, name, origin if origin else "(not importable at all)",
           " or ".join(str(item) for item in expected_locations(name, roots)[:2]),
           repo, os.environ.get("PYTHONPATH") or "(not set)", name)
    )


def assert_repo_import(repo_root: object, *names: str, insert_path: bool = True,
                       require_commit: bool = True, stream: object = None,
                       quiet: bool = False) -> Provenance:
    """Raise unless every guarded package resolves inside ``repo_root``.

    Prints a positive receipt on success (to ``stream``, default ``sys.stderr``
    so a probe's JSON stdout stays clean) and prints the failure *before*
    raising, so a caller that swallows the exception still cannot hide it.

    ``insert_path`` puts the checkout roots at the front of ``sys.path`` once
    the root is proven real.  ``require_commit`` makes an unreadable HEAD a
    failure, because a result file with an empty provenance field is not a
    result.
    """
    handle = sys.stderr if stream is None else stream

    def _fail(error: ProvenanceError) -> ProvenanceError:
        print(str(error), file=handle, flush=True)
        return error

    raw = repo_root
    if raw is None or not str(raw).strip():
        raise _fail(RepoRootError(_repo_report(
            Path(str(raw or "")), raw, "<no repo root given>")))
    repo = Path(os.path.realpath(os.path.abspath(str(raw))))
    roots = import_roots(repo)
    # THE step that catches a wrong path. Proving the root is a real checkout
    # before importing anything is what stops the _pth fallback from answering
    # in its place; without it a typo is indistinguishable from a good run.
    marker = roots[-1] / "orgtree" / "__init__.py"
    if not marker.is_file():
        raise _fail(RepoRootError(_repo_report(repo, raw, marker)))

    if insert_path:
        wanted = [str(item) for item in roots]
        sys.path[:] = wanted + [item for item in sys.path if item not in wanted]

    origins: dict[str, str] = {}
    for name in (names or GUARDED):
        origin = origin_of(name)
        allowed = {_normal(item) for item in expected_locations(name, roots)}
        if origin is None or _normal(origin) not in allowed:
            raise _fail(ForeignImportError(_foreign_report(name, origin, repo, roots)))
        origins[name] = os.path.abspath(origin)

    commit, dirty, problem = repo_commit(repo)
    if require_commit and not commit:
        raise _fail(ProvenanceError(
            "%s -- imports are correct but the repo commit could not be read, "
            "so no result could carry a non-empty provenance field.\n"
            "    repo root : %s\n"
            "    git says  : %s\n"
            "An empty provenance field in a result file was the only thread "
            "that ever caught this class of error. Pass require_commit=False "
            "only if you accept a result nobody can trace to a commit."
            % (BANNER, repo, problem)))

    provenance = Provenance(repo, roots, origins, commit, dirty, problem)
    if not quiet:
        for line in provenance.receipt():
            print(line, file=handle, flush=True)
    return provenance


def main(argv: list[str] | None = None) -> int:
    """Check a repo root from the shell.

    Exit 0 with a receipt, or exit 2 with the failure and -- deliberately -- no
    result file written.
    """
    parser = argparse.ArgumentParser(
        prog="python tools/assert_repo_import.py",
        description="Prove which checkout `orgtree` resolves to, or refuse to report.")
    parser.add_argument("--repo", required=True, help="repo root to prove imports come from")
    parser.add_argument("--result", help="write a stamped result JSON here (only on success)")
    parser.add_argument("--no-insert-path", action="store_true",
                        help="check only; do not put the checkout roots on sys.path")
    parser.add_argument("--allow-missing-commit", action="store_true",
                        help="permit a result with no commit sha (not recommended)")
    parser.add_argument("names", nargs="*",
                        help="modules to prove (default: %s)" % " ".join(GUARDED))
    args = parser.parse_args(argv)

    try:
        provenance = assert_repo_import(
            args.repo, *args.names,
            insert_path=not args.no_insert_path,
            require_commit=not args.allow_missing_commit,
        )
    except ProvenanceError:
        return 2
    if args.result:
        written = provenance.write_result(args.result, {"checked": True})
        print("%s result written %s" % (OK, written), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
