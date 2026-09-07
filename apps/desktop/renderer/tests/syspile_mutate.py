#!/usr/bin/env python3
"""syspile_mutate.py — D-158 proof that syspile.test.tsx can FAIL.

A green suite proves nothing on its own: it is equally consistent with a
correct implementation and with a test that asserts nothing. So each mutation
below breaks the implementation in one specific way and the suite must go RED.

⚠ THE MUTATION IS PROVEN TO HAVE LANDED BEFORE THE RESULT IS READ (D-158). An
exact-string replace that matched nothing would leave the code untouched, the
suite would pass, and that pass would be read as "the test cannot catch this"
when in fact the experiment never ran. Here the replace COUNTS its hits and
aborts on anything but exactly one, and the changed line is printed above the
verdict. (The previous incident: a `$`-anchored perl pattern silently matched
nothing on these CRLF files and reported "ok".)

⚠ DID-NOT-RUN IS WIRED TO FAILURE (D-168). A mutation whose suite could not be
run at all — bundler error, missing node — reports BROKEN, never "ok".

Run:  cd frontend && python tests/syspile_mutate.py
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FE = HERE.parent
SHARED = FE / "src" / "canvas" / "shared.ts"
MAIL = FE / "src" / "canvas" / "mail.tsx"

# (name, file, find, replace, sections that MUST go red)
MUTATIONS = [
    ("M1 nothing ever folds — every row is its own entry",
     SHARED,
     "if (run && foldable && isSystemNotice(run[0]!) && !run[0]!._wait) run.push(m)",
     "if (false && run && foldable) run.push(m)",
     ["§0", "§1", "§2", "§6", "§7"]),

    ("M2 the SENDER half of the predicate is dropped (any notice folds)",
     SHARED,
     "  !m._ask && m.kind === 'notice' && m.from === SYSTEM",
     "  !m._ask && m.kind === 'notice'",
     ["§0c", "§4"]),

    ("M3 the KIND half is dropped — a @system DECISION could be buried",
     SHARED,
     "  !m._ask && m.kind === 'notice' && m.from === SYSTEM",
     "  !m._ask && m.from === SYSTEM",
     ["§0c", "§3"]),

    ("M4 the ask guard is dropped",
     SHARED,
     "  !m._ask && m.kind === 'notice' && m.from === SYSTEM",
     "  m.kind === 'notice' && m.from === SYSTEM",
     ["§0c"]),

    ("M5 a pending notice is folded in anyway",
     SHARED,
     "    const foldable = isSystemNotice(m) && !m._wait",
     "    const foldable = isSystemNotice(m)",
     ["§6b"]),

    ("M6 a one-hour recency bound is added to 'consecutive'",
     SHARED,
     "    if (run && foldable && isSystemNotice(run[0]!) && !run[0]!._wait) run.push(m)",
     "    if (run && foldable && isSystemNotice(run[0]!) && !run[0]!._wait\n"
     "      && (run[0]!.at ?? '').slice(0, 13) === (m.at ?? '').slice(0, 13))"
     " run.push(m)",
     ["§0"]),

    ("M12 EVERYTHING folds — the run has no membership test at all",
     SHARED,
     "    const foldable = isSystemNotice(m) && !m._wait",
     "    const foldable = true",
     ["§0", "§0b", "§3", "§4", "§5"]),

    ("M7 the folded row loses its count — the chip just says 'notice'",
     MAIL,
     "                  {pile ? `${g.length} notices` : 'notice'}</span>}",
     "                  {'notice'}</span>}",
     ["§1", "§6"]),

    ("M8 the folded row grows a preview line back",
     MAIL,
     "            {!isSystemNotice(m)\n"
     "              && <div className=\"l2\">{brief(m.body)}</div>}",
     "            {<div className=\"l2\">{brief(m.body)}</div>}",
     ["§1"]),

    ("M9 opening a run shows only the newest, not the list",
     MAIL,
     "              : curPile && curPile.length > 1",
     "              : false && curPile && curPile.length > 1",
     ["§2"]),

    ("M10 the opened list is newest-first, not chronological",
     MAIL,
     "                    {curPile.slice().reverse().map((n) => (",
     "                    {curPile.slice().map((n) => (",
     ["§2"]),

    ("M11 the reading-pane head loses the count",
     MAIL,
     "                {curPile && curPile.length > 1\n"
     "                  ? `${curPile.length} notices` : cur.kind}</span>",
     "                {cur.kind}</span>",
     ["§2"]),
]

# node prints `✔ §1 …` / `✖ §1 …`; the marker is what we key on
OK_RE = re.compile(r"^\s*(?:✔|ok)\s", re.M)


def sections(out: str, mark: str) -> set[str]:
    """the section labels reported with `mark` (✔ or ✖)."""
    found = set()
    for line in out.splitlines():
        s = line.strip()
        if not s.startswith(mark):
            continue
        # ⚠ the trailing [a-z] is not optional decoration: without it
        # §\d+ matches the "§6" INSIDE "§6b", so §6b is filed as §6 and a
        # mutation it alone catches reads as caught by §6.
        m = re.search(r"(§\d+[a-z]?)", s)
        if m:
            found.add(m.group(1))
    return found


def run_suite() -> tuple[bool, str, set[str], set[str]]:
    """(ran_at_all, output, passed, failed). `ran_at_all` False means the
    experiment never happened — that is BROKEN, not a result."""
    p = subprocess.run([r"node", "tests/run.mjs", "syspile"], cwd=FE,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    ran = "# tests " in out or re.search(r"ℹ tests \d", out) is not None
    return ran, out, sections(out, "✔"), sections(out, "✖")


def main() -> int:
    originals = {f: f.read_text(encoding="utf-8") for f in (SHARED, MAIL)}
    bad = 0
    try:
        # ── baseline: the suite must be GREEN before any of this means anything
        ran, out, passed, failed = run_suite()
        if not ran:
            print("BROKEN: the suite did not run at all at baseline")
            print(out[-3000:])
            return 1
        if failed or not passed:
            print(f"BROKEN: baseline is not green (failed={sorted(failed)})")
            return 1
        print(f"baseline GREEN — {len(passed)} sections: {sorted(passed)}\n")
        every = set(passed)
        covered: set[str] = set()

        for name, path, find, repl, expect in MUTATIONS:
            src = originals[path]
            hits = src.count(find)
            if hits != 1:
                print(f"BROKEN {name}\n  pattern matched {hits} times, "
                      f"expected exactly 1 — the mutation DID NOT LAND")
                bad += 1
                continue
            path.write_text(src.replace(find, repl), encoding="utf-8")
            # ⚠ PROOF FIRST, RESULT SECOND (D-158)
            after = path.read_text(encoding="utf-8")
            assert find not in after and repl in after
            snippet = repl.strip().splitlines()[0][:96]
            print(f"-- {name}\n   LANDED in {path.name}: {snippet}")

            ran, out, passed, failed = run_suite()
            path.write_text(src, encoding="utf-8")

            if not ran:
                print("   BROKEN — the suite could not run; this is NOT a pass")
                print("   " + out.strip().splitlines()[-1][:200])
                bad += 1
                continue
            missing = set(expect) - failed
            if missing:
                print(f"   ✗ SURVIVED in {sorted(missing)} — those legs are "
                      f"blind to this. (red: {sorted(failed) or 'none'})")
                bad += 1
            else:
                print(f"   ✓ caught — red: {sorted(failed)}")
                covered |= failed
        # every section must be killed by at least one mutation, or it is
        # asserting something nothing can break
        idle = every - covered
        if idle:
            print(f"\n✗ never went red under any mutation: {sorted(idle)}")
            bad += 1
    finally:
        for f, s in originals.items():
            f.write_text(s, encoding="utf-8")
    print("\nRESTORED both files to their committed text.")
    if bad:
        print(f"MUTATION PROOF FAILED — {bad} problem(s)")
        return 1
    print(f"MUTATION PROOF OK — {len(MUTATIONS)} mutations, all caught, "
          f"every section killed at least once")
    return 0


if __name__ == "__main__":
    # the section labels and the tick marks are non-ASCII; a cp1252 stdout
    # would crash the harness mid-run and leave a mutated file on disk
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
