# pyright: strict
"""Delivery-stage evidence for work items — the part that talks to git.

This module answers ONE kind of question for the docket: "does the orgtree
repository at REPO_ROOT hold commit X, and is X contained in <target>?" It
never reads or writes the org document (the ledger owns the item; `api.py`
sequences lock → capture → this module → revalidate → save, see
`docs/work-items.md`). Keeping git out of the ledger is what keeps git out of
`DOC_LOCK`.

What a stage result MEANS is deliberately narrow and is written into the
record (`method`/`detail`) rather than left to the reader:

  committed  the commit object resolves in REPO_ROOT. Not "is on main".
  pushed     the commit is an ancestor of the LOCAL tracking ref
             refs/remotes/origin/main — last-observed remote evidence, as of
             the moment this process looked at the ref. No network is used
             and NO fetch time is claimed: git keeps no reliable record of
             when a tracking ref was last fetched (`reflog --format=%cd` is
             the COMMIT date, not the ref update), so `fetched_at` is None.
  in_build   the commit is an ancestor of the commit this backend BOOTED from
             (restart_wake.get_boot_build_info). That is inclusion by git
             ancestry, NOT a functional check — and only when the boot tree
             was clean; a dirty boot cannot prove what code is serving. The
             build identity compared against is commit+dirty, so a later
             dirty boot at the SAME sha does not retain a verified inclusion.

Three-valued on purpose. `verified` is True/False only when git actually
answered the ancestry question; every other outcome — git missing, timeout,
a sha that does not resolve uniquely HERE (it may exist in another
repository), a dirty boot — is None with a `detail` that says which. A commit
that is not in this repository is UNKNOWN, not nonexistent (Astra ruling
2026-09-05).

Every subprocess is a list argv with shell=False, cwd=REPO_ROOT and a
timeout; the only caller-supplied string that reaches argv is a sha that
matched `_SHA_RE`, and the record stores the exact OID git resolved it to
(an ambiguous or unknown prefix stays unknown). Results are cached for 60 s
keyed by (repo, stage, sha, target identity) so a target that moves (a
fetch, a restart, a dirty tree) is never served a stale answer under the old
key.
"""

from __future__ import annotations

import datetime as _dtm
import os
import re
import subprocess
import threading
import time
from typing import Any, Callable, Final, TypedDict

from . import sandbox as sbx

STAGES: Final = ("implemented", "committed", "pushed", "deployed", "in_build")
#: the stages this module can evaluate; the other two are claims by design
VERIFIABLE: Final = frozenset({"committed", "pushed", "in_build"})
REMOTE_REF: Final = "refs/remotes/origin/main"
CACHE_TTL_S: Final = 60.0
GIT_TIMEOUT_S: Final = 10.0

_SHA_RE: Final = re.compile(r"^[0-9a-f]{7,40}$")


class StageResult(TypedDict):
    verified: bool | None
    method: str
    detail: str
    repo: str
    resolved_oid: str | None    # the exact commit git resolved `ref` to
    target: str                 # build/ref identity compared against ("" = none)
    ref_as_of: str              # what `target` is: "local tracking ref" | "boot build"
    fetched_at: None            # never derived; git records no fetch time
    observed_at: str            # when this process ran the comparison


class ShaError(ValueError):
    """The caller-supplied commit reference is not a lowercase 7-40 hex sha."""


def repo_label() -> str:
    return f"orgtree@{sbx.REPO_ROOT}"


def validate_sha(ref: Any) -> str:
    s = str(ref or "").strip()
    if not _SHA_RE.match(s):
        raise ShaError(
            "a commit reference must be a lowercase hex sha of 7-40 characters "
            "(no branch names, no ranges); got "
            f"{s[:20]!r}{'…' if len(s) > 20 else ''}")
    return s


def _default_runner(argv: list[str]) -> tuple[int, str]:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
    r = subprocess.run(["git", *argv], cwd=sbx.REPO_ROOT, capture_output=True,
                       text=True, timeout=GIT_TIMEOUT_S, shell=False,
                       creationflags=flags)
    return r.returncode, r.stdout.strip()


_runner: Callable[[list[str]], tuple[int, str]] = _default_runner
_cache: dict[tuple[str, str, str, str], tuple[float, StageResult]] = {}
_cache_lock = threading.Lock()


def set_runner_for_tests(fn: Callable[[list[str]], tuple[int, str]] | None) -> None:
    """Swap the git runner (None restores the real one) and drop the cache."""
    global _runner
    _runner = fn or _default_runner
    with _cache_lock:
        _cache.clear()


def _now_iso() -> str:
    return _dtm.datetime.now(_dtm.timezone.utc).isoformat()


def _run(argv: list[str]) -> tuple[int | None, str, str]:
    """(returncode, stdout, error). returncode None = git did not answer."""
    try:
        code, out = _runner(argv)
        return code, out, ""
    except FileNotFoundError:
        return None, "", "git is not installed or not on PATH"
    except subprocess.TimeoutExpired:
        return None, "", f"git timed out after {GIT_TIMEOUT_S:g}s"
    except OSError as e:
        return None, "", f"git could not run: {e}"


def _resolve_commit(sha: str) -> tuple[str | None, str]:
    """Full OID if `sha` names exactly one commit in REPO_ROOT, else (None,
    why). An ambiguous prefix fails `--verify` and therefore stays unknown."""
    code, out, err = _run(["rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"])
    if code is None:
        return None, err
    if code != 0 or not out:
        return None, (f"does not resolve to a unique commit in the orgtree repository "
                      f"at {sbx.REPO_ROOT}; other repositories are not checked")
    return out.splitlines()[0].strip(), ""


def _is_ancestor(sha: str, target: str) -> tuple[bool | None, str]:
    code, _out, err = _run(["merge-base", "--is-ancestor", sha, target])
    if code is None:
        return None, err
    if code == 0:
        return True, ""
    if code == 1:
        return False, ""
    return None, f"git merge-base exited {code}"


def _tracking_ref_oid() -> tuple[str | None, str]:
    """(current OID of REMOTE_REF, error). No fetch time is derived."""
    code, oid, err = _run(["rev-parse", "--verify", "--quiet", REMOTE_REF])
    if code is None:
        return None, err
    if code != 0 or not oid:
        return None, f"{REMOTE_REF} does not exist in this checkout"
    return oid.splitlines()[0].strip(), ""


def boot_commit() -> tuple[str, bool]:
    """(full boot commit or 'unknown', dirty) — frozen at process start."""
    from . import restart_wake  # noqa: PLC0415  — avoids an import cycle at load
    info = restart_wake.get_boot_build_info()
    return str(info.get("commit") or "unknown"), bool(info.get("dirty"))


def build_identity() -> str:
    """The running build as compared against: '<commit>' or '<commit>+dirty',
    '' when the boot commit is unknown. Dirty is part of the identity on
    purpose — the same sha booted dirty is a different build for evidence."""
    commit, dirty = boot_commit()
    if commit == "unknown":
        return ""
    return commit + ("+dirty" if dirty else "")


def evaluate(stage: str, ref: Any, *, now: float | None = None) -> StageResult:
    """Evaluate one verifiable stage for one sha. Never raises on git trouble;
    raises ShaError/ValueError only on caller input that must not reach argv."""
    if stage not in VERIFIABLE:
        raise ValueError(f"stage {stage!r} is a claim, not a verifiable stage")
    sha = validate_sha(ref)
    now = time.time() if now is None else now

    # the target is captured FIRST so the cache key names what was compared
    target = ""
    ref_as_of = ""
    pre_detail = ""
    if stage == "pushed":
        oid, err = _tracking_ref_oid()
        target, pre_detail, ref_as_of = (oid or ""), err, "local tracking ref"
    elif stage == "in_build":
        target, ref_as_of = build_identity(), "boot build"
        if target.endswith("+dirty"):
            pre_detail = "boot was dirty; inclusion unknown"
        elif not target:
            pre_detail = "boot commit unknown"

    key = (sbx.REPO_ROOT, stage, sha, target)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_S:
            return dict(hit[1])  # type: ignore[return-value]

    method = {"committed": "object-exists", "pushed": "tracking-ref-ancestry",
              "in_build": "boot-ancestry"}[stage]
    res: StageResult = {"verified": None, "method": method, "detail": "",
                        "repo": repo_label(), "resolved_oid": None,
                        "target": target, "ref_as_of": ref_as_of,
                        "fetched_at": None, "observed_at": _now_iso()}

    full, why = _resolve_commit(sha)
    res["resolved_oid"] = full
    if full is None:
        res["detail"] = why
    elif stage == "committed":
        res["verified"] = True
        res["detail"] = f"commit {full[:12]} exists in REPO_ROOT (not a statement about main)"
    elif pre_detail:
        res["detail"] = pre_detail
    else:
        anc, err = _is_ancestor(full, target.split("+", 1)[0])
        res["verified"] = anc
        if anc is None:
            res["detail"] = err
        elif stage == "pushed":
            res["detail"] = (f"{'contained in' if anc else 'not contained in'} "
                             f"{REMOTE_REF} @ {target[:12]} as observed locally at "
                             f"{res['observed_at']} — last-observed remote evidence; "
                             "fetch time unknown")
        else:
            res["detail"] = (f"{'included in' if anc else 'not included in'} the running "
                             f"build {target[:12]} by git ancestry — not a functional check")

    with _cache_lock:
        _cache[key] = (now, dict(res))  # type: ignore[arg-type]
    return res


def current_target(stage: str) -> str:
    """What `evaluate` would compare against right now, for the read-path
    "evaluated against the current build/ref?" flag — commit+dirty identity
    for in_build (no subprocess), one rev-parse for pushed, "" otherwise."""
    if stage == "in_build":
        return build_identity()
    if stage == "pushed":
        oid, _err = _tracking_ref_oid()
        return oid or ""
    return ""
