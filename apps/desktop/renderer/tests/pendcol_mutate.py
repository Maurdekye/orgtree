#!/usr/bin/env python3
"""pendcol_mutate.py — D-158 proof that pendcol.test.tsx can FAIL.

The first mutation is the one that matters: M1 puts the pending bubble back
exactly as it shipped, thumbnails loose beside the text inside the flex row.
If the suite does not go red on M1 then it never tested the reported bug and
every other green here is decoration.

⚠ THE MUTATION IS PROVEN TO HAVE LANDED BEFORE THE RESULT IS READ (D-158).
Each edit is an exact-string replace that aborts unless it matches EXACTLY
once, and the changed line is printed above the verdict. A replace that
matched nothing would leave the code untouched, the suite would pass, and the
pass would be misread as "the test cannot catch this" when the experiment
never ran at all.

⚠ DID-NOT-RUN IS WIRED TO FAILURE (D-168): a mutation whose suite could not be
run reports BROKEN, never "ok".

Run:  cd frontend && python tests/pendcol_mutate.py
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FE = HERE.parent
DESK = FE / "src" / "canvas" / "desk.tsx"

PEND_NOW = """              <div className="pendbody">
                {m.body && <div className="msgtext md"
                  dangerouslySetInnerHTML={md(m.body, fileBase(slug, node.id))} />}
                {/* a queued image renders viewable (dimmed like the bubble) —
                    the upload already landed, only the MAIL is undelivered */}
                {(m.attachments ?? []).length > 0 && (
                  <div className="attach-row">
                    {(m.attachments ?? []).map((a) => (a.path && isImg(a.name ?? a.path)
                      ? <AttachThumb key={a.path} dim href={fileUrl(slug, node.id, a.path)}
                          name={a.name ?? a.path} meta={a.bytes != null ? fmtBytes(a.bytes) : undefined} />
                      : <span key={a.path ?? a.name} className="attach-chip dim">
                          <FileIcon fontSize="inherit" /> {a.name}</span>))}
                  </div>)}
              </div>
"""

# the markup exactly as it shipped before this fix — the reported bug
PEND_BEFORE = """              <span className="md" dangerouslySetInnerHTML={md(m.body, fileBase(slug, node.id))} />
              {(m.attachments ?? []).map((a) => (a.path && isImg(a.name ?? a.path)
                ? <AttachThumb key={a.path} dim href={fileUrl(slug, node.id, a.path)}
                    name={a.name ?? a.path} meta={a.bytes != null ? fmtBytes(a.bytes) : undefined} />
                : <span key={a.path ?? a.name} className="attach-chip dim">
                    <FileIcon fontSize="inherit" /> {a.name}</span>))}
"""

# each attachment in its OWN row — passes a naive single-image check, splits
# a two-image message across containers
PEND_SPLIT = PEND_NOW.replace(
    """                {(m.attachments ?? []).length > 0 && (
                  <div className="attach-row">
                    {(m.attachments ?? []).map((a) => (a.path && isImg(a.name ?? a.path)""",
    """                {(m.attachments ?? []).map((a) => (
                  <div className="attach-row" key={'r' + (a.path ?? a.name)}>
                    {[a].map((a) => (a.path && isImg(a.name ?? a.path)""",
).replace(
    """                          <FileIcon fontSize="inherit" /> {a.name}</span>))}
                  </div>)}""",
    """                          <FileIcon fontSize="inherit" /> {a.name}</span>))}
                  </div>))}""",
)

# attachments ABOVE the text — a column, but not the same column
PEND_FLIP = """              <div className="pendbody">
                {(m.attachments ?? []).length > 0 && (
                  <div className="attach-row">
                    {(m.attachments ?? []).map((a) => (a.path && isImg(a.name ?? a.path)
                      ? <AttachThumb key={a.path} dim href={fileUrl(slug, node.id, a.path)}
                          name={a.name ?? a.path} meta={a.bytes != null ? fmtBytes(a.bytes) : undefined} />
                      : <span key={a.path ?? a.name} className="attach-chip dim">
                          <FileIcon fontSize="inherit" /> {a.name}</span>))}
                  </div>)}
                {m.body && <div className="msgtext md"
                  dangerouslySetInnerHTML={md(m.body, fileBase(slug, node.id))} />}
              </div>
"""

TAG_BLOCK = """              </div>
              {/* journal-riding mail (drained for a mid-task delivery) shows
                  as queued but is past the point of retraction */}
              {m.delivering
                ? <span className="dim pend-tag">{m.via === 'turn'
                  ? 'delivering…' : 'delivering mid-task…'}</span>
                : m.id && (
                  <button className="chip-x" title="retract (undelivered)"
                    onClick={() => retractMail(slug, node.id, m.id!)
                      .then(() => refresh(true))
                      .catch((e: Error) => toast([`error: ${e.message}`]))}>
                    <CloseIcon fontSize="inherit" /></button>)}
"""

TAG_INSIDE = """              {/* journal-riding mail (drained for a mid-task delivery) shows
                  as queued but is past the point of retraction */}
              {m.delivering
                ? <span className="dim pend-tag">{m.via === 'turn'
                  ? 'delivering…' : 'delivering mid-task…'}</span>
                : m.id && (
                  <button className="chip-x" title="retract (undelivered)"
                    onClick={() => retractMail(slug, node.id, m.id!)
                      .then(() => refresh(true))
                      .catch((e: Error) => toast([`error: ${e.message}`]))}>
                    <CloseIcon fontSize="inherit" /></button>)}
              </div>
"""

# the delivered wrapper, as ONE contiguous block. ⚠ The open tag and its
# closing tag are NOT adjacent in the file — an earlier version of this
# mutation paired them as `OPEN + CLOSE` and matched 0 times, which the hit
# count caught and reported as DID-NOT-LAND rather than letting it read as a
# test that could not catch anything.
DELIV_ROW = """      {files.length > 0 && (
        <div className="attach-row">
          {files.map((f) => {
            const name = f.path.split('/').pop() || f.path
            const href = fileUrl(slug, nid, f.path)
            return isImg(name)
              ? <AttachThumb key={f.path} href={href} name={name} meta={f.size} />
              : <a key={f.path} className="attach-chip" href={href}
                  download={name} title="download">
                  <DownloadIcon fontSize="inherit" /> {name}
                  <span className="dim"> {f.size}</span></a>
          })}
        </div>
      )}"""

DELIV_LOOSE = (DELIV_ROW
               .replace('<div className="attach-row">', '<>')
               .replace('</div>', '</>'))

# (name, find, replace, sections that MUST go red)
MUTATIONS = [
    ("M1 the bubble goes back to how it shipped — thumbs loose beside the text",
     PEND_NOW, PEND_BEFORE, ["§1", "§2", "§3", "§5", "§7", "§9"]),

    # ⚠ NOT §9. Splitting the row leaves `.pendrow` with the same two
    # children (body + tag), so §9 is blind to this BY CONSTRUCTION — it
    # guards the gutter, not the row's membership. §2 is the leg that counts
    # what is inside the one row, and it is the only one that can catch it.
    ("M2 the attachments split one row per attachment",
     PEND_NOW, PEND_SPLIT, ["§2"]),

    ("M3 the attachments render ABOVE the text",
     PEND_NOW, PEND_FLIP, ["§1", "§7"]),

    ("M4 the text block is rendered even when the body is empty",
     "                {m.body && <div className=\"msgtext md\"",
     "                {true && <div className=\"msgtext md\"",
     ["§3"]),

    ("M5 the attachment row is rendered even with no attachments",
     "                {(m.attachments ?? []).length > 0 && (\n"
     "                  <div className=\"attach-row\">",
     "                {true && (\n"
     "                  <div className=\"attach-row\">",
     ["§4"]),

    ("M6 the text block loses the class the delivered bubble uses",
     "                {m.body && <div className=\"msgtext md\"",
     "                {m.body && <div className=\"md\"",
     ["§1", "§7"]),

    ("M7 the delivery tag is folded INTO the message block",
     TAG_BLOCK, TAG_INSIDE, ["§8", "§8b", "§9"]),

    # …and the other side of the parity: break the DELIVERED bubble instead.
    # §7 must notice the two disagreeing whichever one moved.
    ("M8 the DELIVERED bubble loses its attachment row (thumbs loose)",
     DELIV_ROW, DELIV_LOOSE,
     ["§6", "§6b", "§7"]),

    ("M9 the DELIVERED bubble drops its text block class",
     "      {text && <div className=\"msgtext md\" dangerouslySetInnerHTML={md(text, fb)} />}",
     "      {text && <div className=\"md\" dangerouslySetInnerHTML={md(text, fb)} />}",
     ["§6", "§7"]),
]


def sections(out: str, mark: str) -> set[str]:
    """the section labels reported with `mark` (✔ or ✖).

    ⚠ the trailing [a-z] is not decoration: without it `§\\d+` matches the
    "§6" inside "§6b", so §6b is filed as §6 and a mutation only §6b catches
    reads as caught by §6. (That exact bug bit the syspile harness.)"""
    found = set()
    for line in out.splitlines():
        s = line.strip()
        if not s.startswith(mark):
            continue
        m = re.search(r"(§\d+[a-z]?)", s)
        if m:
            found.add(m.group(1))
    return found


def run_suite() -> tuple[bool, str, set[str], set[str]]:
    """(ran_at_all, output, passed, failed). ran_at_all False = the experiment
    never happened, which is BROKEN and not a result."""
    p = subprocess.run(["node", "tests/run.mjs", "pendcol"], cwd=FE,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    ran = re.search(r"ℹ tests \d", out) is not None
    return ran, out, sections(out, "✔"), sections(out, "✖")


def main() -> int:
    original = DESK.read_text(encoding="utf-8")
    bad = 0
    try:
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

        for name, find, repl, expect in MUTATIONS:
            hits = original.count(find)
            if hits != 1:
                print(f"BROKEN {name}\n  pattern matched {hits} times, "
                      f"expected exactly 1 — the mutation DID NOT LAND")
                bad += 1
                continue
            DESK.write_text(original.replace(find, repl), encoding="utf-8")
            # ⚠ PROOF FIRST, RESULT SECOND (D-158)
            after = DESK.read_text(encoding="utf-8")
            assert find not in after and repl in after
            print(f"-- {name}\n   LANDED: {repl.strip().splitlines()[0][:92]}")

            ran, out, passed, failed = run_suite()
            DESK.write_text(original, encoding="utf-8")

            if not ran:
                print("   BROKEN — the suite could not run; this is NOT a pass")
                print("   " + (out.strip().splitlines() or [""])[-1][:200])
                bad += 1
                continue
            missing = set(expect) - failed
            if missing:
                print(f"   x SURVIVED in {sorted(missing)} — those legs are "
                      f"blind to this. (red: {sorted(failed) or 'none'})")
                bad += 1
            else:
                print(f"   ok caught — red: {sorted(failed)}")
                covered |= failed
        idle = every - covered
        if idle:
            print(f"\nx never went red under any mutation: {sorted(idle)}")
            bad += 1
    finally:
        DESK.write_text(original, encoding="utf-8")
    print("\nRESTORED desk.tsx to its committed text.")
    if bad:
        print(f"MUTATION PROOF FAILED — {bad} problem(s)")
        return 1
    print(f"MUTATION PROOF OK — {len(MUTATIONS)} mutations, all caught, "
          f"every section killed at least once")
    return 0


if __name__ == "__main__":
    # the section labels and tick marks are non-ASCII; a cp1252 stdout would
    # crash mid-run and leave a mutated file on disk
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
