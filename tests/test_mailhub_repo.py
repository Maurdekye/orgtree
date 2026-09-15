"""Repository integrity for the orgtree-mailhub integration.

The synchronization design's enforcement half: orgtree-mailhub is the SOLE
authoritative copy of shared hub logic, consumed as a submodule pinned to an
exact commit. These checks fail the build when that stops being true —
a second tracked copy creeping back in, an absent/uninitialized submodule, a
dirty or drifted checkout — and they run the pinned product's OWN
characterization suites so behavioral drift in the embedded copy is caught
by the same tests that define the contract upstream.

    python tests/test_mailhub_repo.py [-v]
"""

from __future__ import annotations

import os
import subprocess
import sys
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
SUB = os.path.join(_ROOT, "engine", "mailhub")

PASS = 0
FAIL: list[tuple[str, str]] = []


def check(label, fn) -> None:
    global PASS
    try:
        fn()
    except Exception:                                            # noqa: BLE001
        FAIL.append((label, traceback.format_exc()))
        print(f"  FAIL     {label}")
        return
    PASS += 1
    print(f"  ok {PASS:3d}  {label}")


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", _ROOT, *args], capture_output=True,
                          text=True, timeout=60).stdout


def _submodule_present() -> None:
    for probe in ("mailhub/app.py", "mailhub/db.py", "mailhub/serve.py",
                  "hubtool.py", "Dockerfile", "docs/PROVENANCE.md",
                  "tests/test_hub.py"):
        assert os.path.isfile(os.path.join(SUB, probe)), (
            f"engine/mailhub/{probe} is missing — the submodule is absent "
            f"or uninitialized. Run: git submodule update --init")


def _submodule_clean_and_pinned() -> None:
    line = ""
    for row in git("submodule", "status").splitlines():
        if row.strip().endswith("engine/mailhub") \
                or " engine/mailhub " in row + " ":
            line = row
            break
    assert line, "engine/mailhub is not a registered submodule"
    marker = line[0]
    assert marker == " ", {
        "-": "the submodule is NOT INITIALIZED (git submodule update "
             "--init)",
        "+": "the submodule checkout DIFFERS from the pinned commit — "
             "adopting a new upstream revision is its own reviewed commit",
        "U": "the submodule has merge conflicts",
    }.get(marker, f"unexpected submodule state {line!r}")
    inner = subprocess.run(["git", "-C", SUB, "status", "--porcelain"],
                           capture_output=True, text=True, timeout=60)
    assert inner.stdout.strip() == "", (
        "the submodule checkout is DIRTY — shared hub changes land in "
        "orgtree-mailhub first, never as local edits under the pin:\n"
        + inner.stdout)


def _no_second_tracked_copy() -> None:
    # the two files that legitimately CONTAIN the fingerprints: this checker
    # (it holds the pattern strings) and the runtime suite (it plants the
    # superseded V2 schema as MIGRATION-INPUT fixture data)
    knows_the_pattern = {"tests/test_mailhub_repo.py",
                         "tests/test_mailhub_runtime.py"}
    tracked = [p for p in git("ls-files").splitlines()
               if p.endswith(".py") and not p.startswith("engine/mailhub")
               and p not in knows_the_pattern]
    assert tracked, "git ls-files returned nothing — run inside the repo"
    offenders: list[str] = []
    for path in tracked:
        try:
            with open(os.path.join(_ROOT, path), encoding="utf-8",
                      errors="ignore") as f:
                src = f.read()
        except OSError:
            continue
        # the hub server's unmistakable fingerprints: its schema and its
        # route table. The org-side CLIENT in net.py legitimately speaks
        # the protocol; only a SERVER copy is a violation.
        if "CREATE TABLE IF NOT EXISTS orgs" in src \
                or '"/api/register"' in src.replace("'", '"') \
                and "FastAPI" in src:
            offenders.append(path)
    assert not offenders, (
        "a second tracked copy of hub-server logic exists outside the "
        f"submodule: {offenders} — orgtree-mailhub is the sole "
        f"authoritative source")
    for gone in ("engine/hub", "engine/hub_runtime.py"):
        assert not any(p == gone or p.startswith(gone + "/")
                       for p in git("ls-files").splitlines()), (
            f"{gone} is tracked again — the superseded V2 hub must stay "
            f"removed")


def _pinned_suite(name: str) -> None:
    r = subprocess.run([sys.executable, os.path.join(SUB, "tests", name)],
                       capture_output=True, text=True, timeout=600,
                       cwd=SUB)
    tail = "\n".join((r.stdout or "").splitlines()[-3:])
    assert r.returncode == 0 and "FAILED" not in tail, (
        f"{name} failed against the PINNED submodule:\n"
        + (r.stdout or "")[-2000:] + (r.stderr or "")[-500:])


print("orgtree-mailhub repository integrity")
check("submodule present and initialized", _submodule_present)
check("submodule clean and exactly at the pinned commit",
      _submodule_clean_and_pinned)
check("no second tracked copy of hub-server logic; V2 hub stays removed",
      _no_second_tracked_copy)
check("pinned product suite: test_hub.py passes in the embedded checkout",
      lambda: _pinned_suite("test_hub.py"))
check("pinned product suite: test_hubtool.py passes in the embedded "
      "checkout", lambda: _pinned_suite("test_hubtool.py"))
check("pinned product suite: test_hubtool_migration.py passes in the "
      "embedded checkout", lambda: _pinned_suite("test_hubtool_migration.py"))

print()
if FAIL:
    for label, tb in FAIL:
        print(f"\n✗ {label}\n{tb}")
    print(f"mailhub-repo: {PASS} passed · {len(FAIL)} FAILED")
    sys.exit(1)
print(f"mailhub-repo: all {PASS} checks passed")
