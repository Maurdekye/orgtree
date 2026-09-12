# pyright: strict
"""VERIFICATION EVIDENCE THAT SAYS WHAT IT ACTUALLY PROVES (package W08).

`workitems.py` answers "is this commit in main / in the running build?". This
module answers the question one layer down, the one agents kept getting wrong
in their own words:

  "Test evidence attached to a review should carry the tested commit and
   file-tree fingerprint automatically. A STALE PRE-EDIT PASSING LOG led to an
   incorrect all-green claim."                          (statereview-01)

  "Reading a shared worktree DURING A REBASE yielded mixed old/new imports; a
   pinned git archive avoids an inaccurate verdict but requires manual setup."
                                                        (statereview-05)

  "A review record should DISTINGUISH INDEPENDENTLY EXECUTED CHECKS from
   owner-reported renderer/live-probe evidence."        (statereview-11)

  "`git range-diff` should be the standard handoff artefact and is not
   mentioned anywhere … a first-class place for 'here is the range-diff
   proving the rebase was clean' would make merge-readiness CHECKABLE RATHER
   THAN ASSERTED."                                      (WE12)

  "PowerShell redirects logs as UTF-16 while Python-written suite logs are
   UTF-8. Evidence tools should detect BOMs or normalize to UTF-8 SO A
   COMPARISON SCRIPT DOES NOT FAIL on otherwise valid results."   (AP17)

  "Unit tests and compiled fixtures all passed while two fatal NSIS compile
   errors sat in the UNTESTED COMPOSITION."             (DI05)

So a receipt here is a RECORD OF AN OBSERVATION, not a verdict, and it is
built from four things that are cheap to capture and impossible to reconstruct
afterwards: WHAT was checked (candidate commit, its base, the exact state of
the tree the check ran in), HOW it was checked (the argv, the interpreter or
runner that executed it, the checkout it ran in), WHAT CAME BACK (a result
class that keeps "an expected negative fired" apart from "the process
crashed" apart from "this check never ran"), and HOW TO RUN IT AGAIN
somewhere else (a replay recipe with an EXPLICIT checkout argument, because a
probe that only works in its author's worktree is prose).

THE FOUR RULES THIS MODULE ENFORCES, each because something went wrong:

  1. A TREE IS PART OF THE IDENTITY. `fingerprint()` covers the commit AND
     every uncommitted path, so a receipt taken on a dirty tree cannot be read
     later as a receipt for the clean commit. A tree mid-rebase (a real
     incident: mixed old/new imports) has neither the old nor the new
     fingerprint, and `disclose()` says so instead of guessing.

  2. A RECEIPT IS IMMUTABLE AND HISTORICAL. Nothing here ever edits a
     receipt. `disclose()` compares an OLD receipt against the state NOW and
     returns the disagreement; it never rewrites the old one to match, because
     "silently relabelled current" is precisely the failure that produced an
     all-green claim from a pre-edit log.

  3. AN ENCODING IS DETECTED, NOT ASSUMED. `decode_log()` reads UTF-8,
     UTF-8-with-BOM and both UTF-16 byte orders (with or without a BOM,
     because `>` in PowerShell writes UTF-16 and `print()` in Python writes
     UTF-8 and the comparison script has to read both) and REPORTS which one
     it found. An undecodable byte is replaced and COUNTED rather than
     crashing the tool that was meant to read the evidence.

  4. NOT RUN IS NOT THE SAME AS PASSED. `RESULTS` has five members and the
     difference between them is the whole point: a check nobody executed is
     `not_executed`, a deliberate negative control that failed as designed is
     `expected_negative` (which is a PASS for the suite), a check that failed
     for real is `failed`, and a check whose process died is `crashed`.

NO SUBPROCESS RUNS AT IMPORT, nothing here writes to the document, and the git
runner is injectable so every rule above is tested against fixed bytes rather
than against whatever the working tree happens to look like.
"""

from __future__ import annotations

import datetime as _dtm
import hashlib
import json
import os
import re
import subprocess
from typing import Any, Callable, Final, Literal, TypedDict

from . import workfields

SCHEMA: Final = "orgtree.verification-receipt/v1"


_SHA_RE: Final = re.compile(r"^[0-9a-f]{7,40}$")


class ShaError(ValueError):
    """The caller-supplied commit reference is not a lowercase 7-40 hex sha."""


def validate_sha(ref: Any) -> str:
    """The submitted commit reference, or a refusal that SAYS WHAT IS WRONG.

    ⚠ THE VALUE IS ECHOED EXACTLY AND THE FAULT IS NAMED. The old message
    printed the first 20 characters of the rejected reference and an ellipsis,
    which hid the very typo the caller was hunting: a 40-character sha with
    one wrong character came back as `'b390277706c7977c1853'…`, indisting-
    uishable from the correct one, and cost a round trip to find. Length and
    character faults are reported separately, and the offending character is
    located, because "must be a lowercase hex sha" is already known to anyone
    who just sent one.

    ⚠ AND NOTHING INVALID IS ACCEPTED TO SAVE THE ROUND TRIP. A short form is
    already legal (7 characters up), so there is no reference worth admitting
    that this refuses; loosening the pattern would only let an unverifiable
    string into a field whose whole purpose is to be checked against git.
    """
    s = str(ref or "").strip()
    if _SHA_RE.match(s):
        return s
    why = "it is empty" if not s else ""
    if not why and len(s) < 7:
        why = (f"it is {len(s)} character(s) long; the shortest accepted "
               f"abbreviation is 7")
    if not why and len(s) > 40:
        why = (f"it is {len(s)} characters long; a full sha is 40, so this is "
               f"{len(s) - 40} too many")
    if not why:
        bad = next(((i, c) for i, c in enumerate(s)
                    if c not in "0123456789abcdef"), None)
        if bad is not None:
            i, c = bad
            why = (f"character {i + 1} is {c!r}, which is not a lowercase hex "
                   f"digit"
                   + (" (it is the uppercase form — git prints shas in "
                      "lowercase)" if c.lower() in "0123456789abcdef" else ""))
        else:                              # unreachable via _SHA_RE, kept honest
            why = "it does not match the accepted form"
    raise ShaError(
        f"a commit reference must be a lowercase hex sha of 7-40 characters "
        f"(no branch names, no ranges, no ref expressions): {why}. You sent "
        f"{workfields.echo(s)} — echoed exactly, so a single wrong character "
        f"is visible here rather than hidden behind a shortened copy")


def _validate_sha(ref: Any) -> str:
    """The one sha rule, under the private name this module calls."""
    return validate_sha(ref)


#: HOW a check reached its conclusion. The distinction is the reviewer's, not
#: a formality: an approval that says "tests pass" when the reviewer read the
#: owner's log rather than running anything overstates its own scope, and
#: statereview-11 asked for exactly this field so it cannot.
EXECUTION: Final = ("independent", "owner_report", "source_inspection")
EXECUTION_MEANS: Final[dict[str, str]] = {
    "independent": "this agent ran the command itself and observed the result",
    "owner_report": "the result was reported by another agent; this record "
                    "carries their claim, not an execution of it",
    "source_inspection": "the conclusion comes from reading code or output, "
                         "with nothing executed",
}

# W09: an acceptance check is not just a string pointing at a log.  The
# classification is deliberately separate from RESULT: a crashed run and an
# intentionally blocked request can both be non-green observations, while
# only an explicit successful ``met`` or ``known_negative`` classification can
# satisfy a docket condition.
ACCEPTANCE_CLASSES: Final = (
    "met", "not_exercised", "environment_limited", "known_negative")
ACCEPTANCE_CLASS_MEANS: Final[dict[str, str]] = {
    "met": "the condition was explicitly verified",
    "not_exercised": "the composition was not run, so it has no verdict",
    "environment_limited": "the check could not run or conclude in this environment",
    "known_negative": "an expected negative control fired; this is evidence, not a met condition",
}


def validate_acceptance_evidence(*, classification: Any = None,
                                 execution: Any = None,
                                 result: Any = None,
                                 artifact: Any = None,
                                 runner: Any = None,
                                 gate: Any = None,
                                 blocked_count: Any = None,
                                 composition: Any = None) -> dict[str, Any]:
    """Validate the metadata attached to a durable acceptance check.

    All fields are optional for legacy checks.  Once ``classification`` is
    supplied, however, the record is self-describing: artifact, runner and
    execution provenance are required, and incompatible result/class pairs
    are refused before the ledger mutates.  ``gate`` and ``blocked_count``
    stay together so an expected blocked-request control cannot be confused
    with an application crash.
    """
    # W08 already permits an execution-only evidence row.  ``execution`` is
    # therefore not, by itself, W20 metadata: keeping it in this predicate
    # would make the new classification requirement reject existing callers.
    # Any other field is an explicit W20 metadata request and must be complete.
    present = any(x is not None for x in (
        classification, result, artifact, runner, gate, blocked_count,
        composition))
    if not present:
        return {}
    if classification is None or str(classification).strip() not in ACCEPTANCE_CLASSES:
        raise ReceiptError(
            "acceptance classification must be one of "
            + "|".join(ACCEPTANCE_CLASSES)
            + "; it is required when acceptance evidence metadata is supplied")
    cls = str(classification).strip()
    if execution is None or str(execution).strip() not in EXECUTION:
        raise ReceiptError("acceptance evidence needs execution: "
                           + "|".join(EXECUTION))
    ex = str(execution).strip()
    def text(name: str, value: Any) -> str:
        s = str(value or "").strip()
        if not s:
            raise ReceiptError(f"acceptance evidence needs {name}")
        return s
    art = text("artifact", artifact)
    run = text("runner", runner)
    if result is None or str(result).strip() not in RESULTS:
        raise ReceiptError("acceptance evidence result must be one of "
                           + "|".join(RESULTS))
    res = str(result).strip()
    expected: dict[str, str] = {
        "met": "passed",
        "not_exercised": "not_executed",
        "known_negative": "expected_negative",
    }
    if cls in expected and res != expected[cls]:
        raise ReceiptError(f"acceptance classification {cls!r} requires "
                           f"result {expected[cls]!r}, not {res!r}")
    if cls == "environment_limited" and res not in ("crashed", "failed", "not_executed"):
        raise ReceiptError("environment_limited acceptance evidence requires "
                           "result crashed, failed, or not_executed")
    if cls == "known_negative" and ex == "source_inspection":
        raise ReceiptError("known_negative acceptance evidence must be an "
                           "executed or reported control, not source_inspection")
    if (gate is None) != (blocked_count is None):
        raise ReceiptError("gate and blocked_count must be supplied together")
    if cls == "known_negative" and gate is None:
        raise ReceiptError("known_negative acceptance evidence needs the exact "
                           "gate and blocked_count")
    out: dict[str, Any] = {
        "classification": cls, "artifact": art, "runner": run,
        "execution": ex, "execution_means": EXECUTION_MEANS[ex],
        "result": res, "classification_means": ACCEPTANCE_CLASS_MEANS[cls],
    }
    if gate is not None:
        out["gate"] = text("gate", gate)
        if isinstance(blocked_count, bool):
            raise ReceiptError("blocked_count must be a non-negative integer")
        try:
            count = int(blocked_count)
        except (TypeError, ValueError, OverflowError):
            raise ReceiptError("blocked_count must be a non-negative integer") from None
        if count < 0 or str(count) != str(blocked_count).strip():
            raise ReceiptError("blocked_count must be a non-negative integer")
        out["blocked_count"] = count
    if composition is not None:
        out["composition"] = text("composition", composition)
    return out

#: WHAT CAME BACK. Five members, because collapsing any two of them is how a
#: suite reports green while a negative control never fired.
RESULTS: Final = ("passed", "expected_negative", "failed", "crashed",
                  "not_executed")
RESULT_MEANS: Final[dict[str, str]] = {
    "passed": "ran to completion and met its condition",
    "expected_negative": "failed exactly as it was designed to fail — a "
                         "negative control firing is a PASS for the suite, and "
                         "its absence is a failure",
    "failed": "ran to completion and did not meet its condition",
    "crashed": "did not reach a verdict: the process died, timed out, or could "
               "not start — this is NOT a failed assertion",
    "not_executed": "never ran. No verdict of any kind, and it must never read "
                    "as a pass",
}
#: the results that let a suite be called green
GREEN: Final = frozenset({"passed", "expected_negative"})

#: A tree that is neither the clean commit nor a known edit of it — the
#: mid-rebase state that produced mixed old/new imports (statereview-05).
TREE_CLEAN: Final = "clean"
TREE_DIRTY: Final = "dirty"
TREE_UNRESOLVED: Final = "unresolved"

GIT_TIMEOUT_S: Final = 15.0
#: dirty paths are listed up to here and then counted, so a fingerprint over a
#: half-migrated tree stays a bounded record instead of a file dump
DIRTY_PATHS_LISTED: Final = 200
#: a captured log is hashed whole and STORED up to here (the hash is of the
#: whole, so a truncated copy can still be checked against the original)
LOG_STORED: Final = 65536

_ENCODINGS: Final = ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-8")


class ReceiptError(ValueError):
    """A receipt could not be built from what the caller supplied."""


class TreeState(TypedDict):
    checkout: str            # the checkout root this was observed in
    commit: str | None       # HEAD oid, or None when git could not say
    base: str | None         # the commit HEAD sits on top of, when asked for
    state: str               # clean | dirty | unresolved
    dirty_paths: list[str]   # up to DIRTY_PATHS_LISTED, sorted
    dirty_count: int         # the real number, even when the list is bounded
    in_progress: str         # "" or the git operation under way (rebase/merge…)
    fingerprint: str         # sha256 over commit + every dirty path and status
    observed_at: str
    detail: str              # why anything above is None/unresolved


class LogText(TypedDict):
    text: str
    encoding: str            # the codec that actually decoded it
    had_bom: bool
    replacements: int        # undecodable code points replaced, not hidden
    bytes: int
    sha256: str              # over the RAW BYTES, before any decoding


class RangeDiff(TypedDict):
    old_base: str
    old_tip: str
    new_base: str
    new_tip: str
    identical: bool | None   # None = git did not answer
    detail: str
    output: str
    observed_at: str


class Receipt(TypedDict):
    schema: str
    candidate: str
    base: str | None
    tree: TreeState
    execution: str
    result: str
    green: bool
    command: list[str]
    runner: dict[str, Any]
    logs: list[LogText]
    replay: dict[str, Any]
    note: str
    observed_at: str
    fingerprint: str


# --------------------------------------------------------------- digests

def digest(value: Any) -> str:
    """A stable sha256 over any JSON-able value, labelled with its algorithm.

    Labelled because an unprefixed 64-hex string is indistinguishable from a
    git object id of the same width, and a receipt that mixes the two invites
    somebody to paste one where the other belongs.
    """
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def file_digest(path: str) -> tuple[str, int]:
    """(sha256 of the bytes on disk, size). Raises OSError — the caller decides
    whether a missing artifact is a refusal or a disclosure."""
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            n += len(chunk)
            h.update(chunk)
    return "sha256:" + h.hexdigest(), n


def _now_iso() -> str:
    return _dtm.datetime.now(_dtm.timezone.utc).isoformat()


# --------------------------------------------------------------- log bytes

def decode_log(raw: bytes) -> LogText:
    """Decode a captured log WITHOUT being told its encoding, and say which.

    The concrete incident (AP17): a release comparison script read a suite log
    that Python had written as UTF-8 next to a log PowerShell had redirected as
    UTF-16, and fell over on the second one — with results that were perfectly
    valid sitting inside it. Guessing wrong is worse than failing, so the
    detected codec is part of the record and the caller can see what happened.

    Order matters. A BOM wins outright. Failing that, a byte stream with NUL
    bytes in every other position is UTF-16 whatever it claims (PowerShell
    writes no BOM when redirecting into an existing handle), and the byte order
    is taken from where the NULs fall. Only then is UTF-8 tried, and its
    undecodable bytes are REPLACED AND COUNTED — a log is evidence, and
    refusing to read it because one byte is malformed loses the other 60 KB.
    """
    if not isinstance(raw, (bytes, bytearray)):    # pyright: ignore[reportUnnecessaryIsInstance]
        raise ReceiptError("decode_log takes raw bytes, not text that has "
                           "already been decoded by something that guessed")
    data = bytes(raw)
    sha = "sha256:" + hashlib.sha256(data).hexdigest()
    if not data:
        return {"text": "", "encoding": "utf-8", "had_bom": False,
                "replacements": 0, "bytes": 0, "sha256": sha}

    had_bom = False
    codec = ""
    body = data
    if data.startswith(b"\xef\xbb\xbf"):
        codec, had_bom, body = "utf-8-sig", True, data
    elif data.startswith(b"\xff\xfe"):
        codec, had_bom, body = "utf-16", True, data
    elif data.startswith(b"\xfe\xff"):
        codec, had_bom, body = "utf-16", True, data
    else:
        # no BOM: look for the alternating NULs that mark UTF-16 text in ASCII
        sample = data[:4096]
        even = sum(1 for i in range(0, len(sample) - 1, 2) if sample[i] == 0)
        odd = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
        pairs = max(1, len(sample) // 2)
        if odd >= pairs * 0.4 and odd > even:
            codec = "utf-16-le"
        elif even >= pairs * 0.4 and even > odd:
            codec = "utf-16-be"
        else:
            codec = "utf-8"

    try:
        text = body.decode(codec)
        replacements = 0
    except (UnicodeDecodeError, LookupError):
        text = body.decode(codec, errors="replace")
        replacements = text.count("�")
    else:
        if "�" in text:                      # the file really contained one
            replacements = text.count("�")
    if text.startswith("﻿"):                 # a BOM decoded as a character
        text, had_bom = text[1:], True
    return {"text": text, "encoding": codec, "had_bom": had_bom,
            "replacements": replacements, "bytes": len(data), "sha256": sha}


def read_log(path: str) -> LogText:
    """`decode_log` over a file, so a caller never has to open it in text mode
    and pick an encoding it cannot know."""
    with open(path, "rb") as f:
        return decode_log(f.read())


def stored_log(log: LogText) -> LogText:
    """The copy that goes into a record: bounded text, unbounded truth.

    The sha256 is over the WHOLE original, so a reader holding the full log can
    prove this is a copy of it even though the stored text stops earlier. The
    marker says so in the reader's language rather than trailing off, which is
    the same rule `workfields.excerpt` applies to prose.
    """
    text = log["text"]
    if len(text) <= LOG_STORED:
        return dict(log)  # type: ignore[return-value]
    out = dict(log)
    out["text"] = (text[:LOG_STORED]
                   + f"\n… [LOG EXCERPT — {len(text)} characters in full; this "
                     f"stores the first {LOG_STORED}. The sha256 above is over "
                     f"the COMPLETE log, so the full copy can be checked "
                     f"against this record]")
    return out  # type: ignore[return-value]


# --------------------------------------------------------------- git facts

GitRunner = Callable[[list[str], str], "tuple[int | None, str, str]"]


def _default_git(argv: list[str], cwd: str) -> tuple[int | None, str, str]:
    """(returncode, stdout, error). returncode None = git did not answer."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        r = subprocess.run(["git", *argv], cwd=cwd, capture_output=True,
                           text=True, timeout=GIT_TIMEOUT_S, shell=False,
                           creationflags=flags)  # type: ignore[call-overload]
        return r.returncode, str(r.stdout or "").strip(), ""
    except FileNotFoundError:
        return None, "", "git is not installed or not on PATH"
    except subprocess.TimeoutExpired:
        return None, "", f"git timed out after {GIT_TIMEOUT_S:g}s"
    except OSError as e:
        return None, "", f"git could not run: {e}"


_git: GitRunner = _default_git


def set_git_for_tests(fn: GitRunner | None) -> None:
    """Swap the git runner (None restores the real one)."""
    global _git
    _git = fn or _default_git


_OP_MARKERS: Final = (("rebase-merge", "rebase"), ("rebase-apply", "rebase"),
                      ("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"),
                      ("BISECT_LOG", "bisect"), ("REVERT_HEAD", "revert"))


def _operation_in_progress(checkout: str) -> str:
    """The git operation half-done in this checkout, or "".

    This is the statereview-05 incident made detectable: a tree in the middle
    of a rebase holds a mixture of the old and new content, so its fingerprint
    describes NEITHER commit and any verdict taken from it is unsound. Asked
    via git, then by looking for the marker files, because a `git status`
    that cannot run must not silently answer "nothing in progress".
    """
    # ⚠ ABSOLUTE, NOT RELATIVE. `--git-path` answers relative to the checkout,
    # and joining that against this PROCESS's cwd looked in the wrong directory
    # and therefore always reported "nothing in progress" — a half-applied
    # rebase then read as an ordinary dirty tree, which is exactly the
    # confusion this function exists to prevent. Caught by the conflicting-
    # rebase test, which is why that test builds a real conflict.
    code, out, _err = _git(["rev-parse", "--absolute-git-dir"], checkout)
    gitdir = out.splitlines()[0].strip() if code == 0 and out else ""
    if not gitdir or not os.path.isdir(gitdir):
        gitdir = os.path.join(checkout, ".git")
    for marker, name in _OP_MARKERS:
        if os.path.exists(os.path.join(gitdir, marker)):
            return name
    return ""


def tree_state(checkout: str, *, base_of: str | None = None) -> TreeState:
    """Everything about this checkout that a later reader needs in order to
    know what the numbers describe.

    `base_of` asks for the parent of a named commit (the "base" a candidate
    sits on), so a receipt records the pair a range-diff will later compare
    rather than leaving the base to be reconstructed from memory.

    Nothing raises: git being absent, a detached and empty repository, or a
    permission error all come back as None/`unresolved` WITH A DETAIL. An
    evidence record whose provenance failed to capture must say that; it must
    not fall back to a confident-looking default.
    """
    st: TreeState = {"checkout": os.path.realpath(os.path.abspath(checkout)),
                     "commit": None, "base": None, "state": TREE_UNRESOLVED,
                     "dirty_paths": [], "dirty_count": 0, "in_progress": "",
                     "fingerprint": "", "observed_at": _now_iso(), "detail": ""}
    details: list[str] = []

    code, out, err = _git(["rev-parse", "--verify", "HEAD"], st["checkout"])
    if code == 0 and out:
        st["commit"] = out.splitlines()[0].strip()
    else:
        details.append(err or "HEAD does not resolve in this checkout")

    code, out, err = _git(["status", "--porcelain", "--untracked-files=normal"],
                          st["checkout"])
    if code == 0:
        rows = [ln for ln in out.splitlines() if ln.strip()]
        st["dirty_count"] = len(rows)
        st["dirty_paths"] = sorted(rows)[:DIRTY_PATHS_LISTED]
        st["state"] = TREE_DIRTY if rows else TREE_CLEAN
    else:
        details.append(err or "git status did not answer; cleanliness unknown")

    st["in_progress"] = _operation_in_progress(st["checkout"])
    if st["in_progress"]:
        # a half-applied operation outranks "dirty": the content is not an edit
        # of the recorded commit, it is a mixture of two of them
        st["state"] = TREE_UNRESOLVED
        details.append(f"a {st['in_progress']} is in progress, so this tree is "
                       f"neither the recorded commit nor a clean edit of it — "
                       f"any result measured here describes a mixture")

    if base_of:
        sha = _validate_sha(base_of)
        code, out, err = _git(["rev-parse", "--verify", f"{sha}^"], st["checkout"])
        if code == 0 and out:
            st["base"] = out.splitlines()[0].strip()
        else:
            details.append(err or f"the parent of {sha} does not resolve here "
                                  f"(a root commit has none)")

    st["detail"] = " · ".join(details)
    st["fingerprint"] = digest({"commit": st["commit"], "state": st["state"],
                                "dirty": st["dirty_paths"],
                                "dirty_count": st["dirty_count"],
                                "in_progress": st["in_progress"]})
    return st


def range_diff(checkout: str, old_base: str, old_tip: str,
               new_base: str, new_tip: str) -> RangeDiff:
    """The handoff artefact WE12 asked for, recorded with all four endpoints.

    A rebase is claimed clean far more often than it is checked, and the check
    is one command. What makes this a record rather than a screenshot is that
    it stores OLD base and tip AND NEW base and tip: "range-diff was clean" is
    unfalsifiable a day later if nobody wrote down which two ranges were
    compared.

    `identical` is True only when git said every commit corresponds with no
    change (`=` on every row). Anything git could not answer is None, never
    False — "the rebase changed something" and "git did not run" are different
    facts and the second must not read as the first.
    """
    shas = {"old_base": _validate_sha(old_base),
            "old_tip": _validate_sha(old_tip),
            "new_base": _validate_sha(new_base),
            "new_tip": _validate_sha(new_tip)}
    rec: RangeDiff = {**shas, "identical": None, "detail": "", "output": "",
                      "observed_at": _now_iso()}  # type: ignore[typeddict-item]
    code, out, err = _git(["range-diff", "--no-color",
                           f"{shas['old_base']}..{shas['old_tip']}",
                           f"{shas['new_base']}..{shas['new_tip']}"], checkout)
    rec["output"] = out[:LOG_STORED]
    if code is None:
        rec["detail"] = err or "git did not answer"
        return rec
    if code != 0:
        rec["detail"] = (f"git range-diff exited {code}; the ranges were not "
                         f"compared, so nothing is known about the rebase")
        return rec
    rows = [ln for ln in out.splitlines() if ln.strip()]
    if not rows:
        rec["detail"] = ("git range-diff printed nothing: both ranges are "
                         "empty, which compares nothing rather than proving "
                         "they match")
        return rec
    marks = [_row_mark(ln) for ln in rows]
    changed = [m for m in marks if m and m != "="]
    rec["identical"] = not changed
    rec["detail"] = (f"{len(marks)} commit row(s); "
                     + ("every row is `=`, so the patches are identical"
                        if not changed else
                        f"{len(changed)} row(s) differ ({', '.join(sorted(set(changed)))})"))
    return rec


_ROW_RE: Final = re.compile(r"^\s*\d*\s*:\s*\S+\s*([=<>!])\s*")


def _row_mark(line: str) -> str:
    """The correspondence mark git prints for one range-diff row."""
    m = _ROW_RE.match(line)
    return m.group(1) if m else ""


# --------------------------------------------------------------- receipts

def _checked_base(base: Any, candidate: str, checkout: str) -> str:
    """A CALLER-SUPPLIED `base`, CHECKED AGAINST GIT — never copied in.

    ⚠ THIS IS THE ONE FIELD A CALLER CHOOSES, so it is the one that has to be
    proved. `candidate` is validated and every other provenance field is
    measured here; a `base` taken verbatim would be a free-text claim sitting
    inside a fingerprinted record and looking exactly as checked as the fields
    beside it. "This ran on top of main" is precisely the assertion a later
    range-diff relies on, so a wrong or invented one is worse than an absent
    one — and absent is a perfectly good answer, because the parent of the
    candidate is read from git when nothing is supplied.

    Three ways to fail, all refusals rather than silent acceptance:
      · it is not a sha at all  → `ShaError`, the same as a bad candidate;
      · it does not resolve in this checkout  → it names nothing here;
      · it resolves but is NOT an ancestor of the candidate  → the candidate
        does not sit on it, which is the false claim this exists to stop.

    Returns the FULL resolved sha, so an abbreviation recorded by one agent
    compares equal to the full one recorded by another.
    """
    want = _validate_sha(base)
    if candidate.startswith(want) or want.startswith(candidate):
        raise ReceiptError(
            f"base {want} and candidate {candidate} are the same commit. A "
            f"commit does not sit on itself — the base is what it was built "
            f"ON TOP OF, and a receipt saying otherwise makes every range-diff "
            f"against it vacuous")
    code, out, err = _git(["rev-parse", "--verify", f"{want}^{{commit}}"],
                          os.path.realpath(os.path.abspath(checkout)))
    if code != 0 or not out.strip():
        raise ReceiptError(
            f"base {want} does not resolve to a commit in {checkout} "
            f"({err.strip() or 'no such object'}). A receipt records the "
            f"commit the candidate ACTUALLY sits on — omit `base` and the "
            f"parent of the candidate is read from git for you")
    full = out.splitlines()[0].strip()
    code, _out, err = _git(["merge-base", "--is-ancestor", full, candidate],
                           os.path.realpath(os.path.abspath(checkout)))
    if code != 0:
        raise ReceiptError(
            f"base {want} is not an ancestor of candidate {candidate}"
            + (f" ({err.strip()})" if err.strip() else "")
            + ". A base the candidate does not sit on describes a history "
              "that did not happen, and a later range-diff would compare "
              "against the wrong endpoint. Omit `base` to record the "
              "candidate's real parent")
    return full


def receipt(*, candidate: str, checkout: str, command: list[str] | None,
            execution: str, result: str, runner: dict[str, Any] | None = None,
            logs: list[LogText] | None = None, note: str = "",
            base: str | None = None, replay: dict[str, Any] | None = None,
            tree: TreeState | None = None) -> Receipt:
    """Build one immutable receipt. Refuses rather than recording a guess.

    Every refusal here is a case somebody actually got wrong: a result class
    outside the five loses the distinction the five exist for; an
    `independent` claim with no command is an execution nobody can replay; and
    a candidate that is not a sha cannot be bound to anything.
    """
    if execution not in EXECUTION:
        raise ReceiptError(
            f"execution must be one of {'|'.join(EXECUTION)} — "
            + "; ".join(f"{k}: {v}" for k, v in EXECUTION_MEANS.items())
            + f". You sent {workfields.echo(execution)}")
    if result not in RESULTS:
        raise ReceiptError(
            f"result must be one of {'|'.join(RESULTS)} — "
            + "; ".join(f"{k}: {v}" for k, v in RESULT_MEANS.items())
            + f". You sent {workfields.echo(result)}")
    sha = _validate_sha(candidate)
    argv = [str(a) for a in (command or [])]
    if execution == "independent" and not argv:
        raise ReceiptError(
            "an `independent` receipt records a command that was actually "
            "run, so `command` cannot be empty. If nothing was executed, the "
            "honest execution class is `source_inspection`, and if the result "
            "came from another agent it is `owner_report`")
    if result == "not_executed" and execution == "independent":
        raise ReceiptError(
            "`not_executed` and `independent` contradict each other: the first "
            "says no check ran, the second says this agent ran one. Record the "
            "unexecuted check as `source_inspection` with result "
            "`not_executed`, which is how a gap is disclosed rather than hidden")
    st = tree if tree is not None else tree_state(checkout, base_of=sha)
    stored = [stored_log(lg) for lg in (logs or [])]
    body: dict[str, Any] = {
        "schema": SCHEMA,
        "candidate": sha,
        "base": (_checked_base(base, sha, checkout) if base
                 else st.get("base")),
        "tree": st,
        "execution": execution,
        "result": result,
        "green": result in GREEN,
        "command": argv,
        "runner": dict(runner or {}),
        "logs": stored,
        "replay": dict(replay or replay_recipe(command=argv, candidate=sha)),
        "note": workfields.prose(note),
        "observed_at": _now_iso(),
    }
    body["fingerprint"] = digest({k: v for k, v in body.items()
                                  if k not in ("observed_at", "fingerprint")})
    return body  # type: ignore[return-value]


def replay_recipe(*, command: list[str], candidate: str,
                  checkout_flag: str = "--repo-root") -> dict[str, Any]:
    """How to run this check somewhere else — the WE07 ask, made mechanical.

    The reported friction was exact: a reviewer's probe imported from a private
    `snapshot-<sha>` export, so the implementer could not run the reviewer's
    own script and had to transcribe it. The snapshot existed only to pin the
    sha. So a recipe names the candidate to check out and the flag that points
    the command at ANY checkout, and states plainly when the command it was
    given carries no such flag — an unportable probe is disclosed, not
    silently promoted to portable.
    """
    argv = [str(a) for a in command]
    portable = any(a == checkout_flag or a.startswith(checkout_flag + "=")
                   for a in argv)
    return {
        "candidate": candidate,
        "checkout_flag": checkout_flag,
        "portable": portable,
        "steps": [
            f"git worktree add <your-path> --detach {candidate}",
            " ".join(argv) if argv else "(no command was recorded)",
        ],
        "detail": ("the recorded command takes an explicit checkout via "
                   f"{checkout_flag}, so it runs against any worktree"
                   if portable else
                   f"the recorded command does NOT take {checkout_flag}, so it "
                   f"reads whatever checkout it is started in — a reader must "
                   f"run it from a worktree pinned at {candidate} rather than "
                   f"trusting it to find one"),
    }


DISCLOSURE = Literal["current", "tree_changed", "commit_changed",
                     "tree_unresolved", "stale_unknown"]


class Disclosure(TypedDict):
    status: str
    current: bool
    says: str
    receipt_fingerprint: str
    now_fingerprint: str
    age_seconds: float | None


def disclose(rec: Receipt, now_tree: TreeState,
             *, observed_at: str | None = None) -> Disclosure:
    """Compare an OLD receipt against the tree NOW, and say the disagreement.

    ⚠ THIS NEVER EDITS THE RECEIPT. The failure it exists to prevent
    (statereview-01) was a passing log from before the edit being read as
    evidence for after it — an all-green claim assembled out of true
    statements about a tree that no longer existed. The fix is not to refresh
    the old record; it is to keep the old record exactly as it was and make
    the difference impossible to miss.
    """
    rt = rec.get("tree") or {}
    rc = str(rt.get("commit") or "")
    nc = str(now_tree.get("commit") or "")
    rf = str(rt.get("fingerprint") or "")
    nf = str(now_tree.get("fingerprint") or "")
    age: float | None = None
    try:
        then = _dtm.datetime.fromisoformat(str(observed_at
                                               or rec.get("observed_at") or ""))
        if then.tzinfo is None:
            then = then.replace(tzinfo=_dtm.timezone.utc)
        age = max(0.0, (_dtm.datetime.now(_dtm.timezone.utc) - then).total_seconds())
    except ValueError:
        age = None

    if now_tree.get("state") == TREE_UNRESOLVED or rt.get("state") == TREE_UNRESOLVED:
        status, says = ("tree_unresolved",
                        "one of the two trees is mid-operation or could not be "
                        "read, so this evidence cannot be matched to a commit "
                        "at all — re-run it on a settled checkout")
    elif not rc or not nc:
        status, says = ("stale_unknown",
                        "a commit is missing on one side, so whether this "
                        "evidence still describes the code is UNKNOWN — which "
                        "is not the same as current")
    elif rc != nc:
        status, says = ("commit_changed",
                        f"recorded against {rc[:12]}, the checkout is now at "
                        f"{nc[:12]} — this evidence is HISTORICAL and says "
                        f"nothing about the current code")
    elif rf != nf:
        status, says = ("tree_changed",
                        f"same commit {rc[:12]}, but the working tree has "
                        f"changed since (uncommitted edits differ) — the "
                        f"result was measured on a tree nobody has now")
    else:
        status, says = ("current",
                        f"commit and tree both still match {rc[:12]} exactly")
    return {"status": status, "current": status == "current", "says": says,
            "receipt_fingerprint": rf, "now_fingerprint": nf,
            "age_seconds": age}


def summarize(receipts: list[Receipt]) -> dict[str, Any]:
    """An honest one-line reading of a set of receipts.

    `green` requires that every check reached a verdict AND that no check is
    `not_executed`, because a suite of ten where two never ran is not a suite
    of eight. The composition gap DI05 reported — unit tests green while the
    packaging step was never built — is exactly this arithmetic, so the
    unexecuted ones are named rather than counted.
    """
    counts: dict[str, int] = {k: 0 for k in RESULTS}
    by_exec: dict[str, int] = {k: 0 for k in EXECUTION}
    unexecuted: list[str] = []
    for r in receipts:
        res = str(r.get("result") or "")
        counts[res] = counts.get(res, 0) + 1
        ex = str(r.get("execution") or "")
        by_exec[ex] = by_exec.get(ex, 0) + 1
        if res == "not_executed":
            unexecuted.append(" ".join(str(a) for a in (r.get("command") or []))
                              or str(r.get("note") or "")[:80] or "(unnamed check)")
    total = len(receipts)
    green = bool(total) and all(str(r.get("result")) in GREEN for r in receipts)
    return {
        "total": total, "by_result": counts, "by_execution": by_exec,
        "green": green, "not_executed": unexecuted,
        "independently_executed": by_exec.get("independent", 0),
        "says": ("no receipts" if not total else
                 ("every check ran and met its condition"
                  if green else
                  f"{counts.get('failed', 0)} failed, "
                  f"{counts.get('crashed', 0)} crashed, "
                  f"{len(unexecuted)} never ran"
                  + (f" ({', '.join(unexecuted[:3])})" if unexecuted else "")))
    }
