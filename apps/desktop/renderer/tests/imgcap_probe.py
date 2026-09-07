"""imgcap_probe.py — STEP 2: does the presented-image caption stay ONE line?

User report 2026-08-28: "issue here with presented images, lines wrapping onto
two rows and causing layout issues". The screenshot showed
`kyo_spotlight_fixed_front.png` broken mid-word across two rows and `· 190 KB`
split across both, doubling the caption's height.

The repo's frontend suite runs in jsdom, which implements NO CSS box model:
every height it reports is 0, so a wrap assertion written there would abstain —
and an abstention reads exactly like a pass. This measures in a real layout
engine instead: system Edge, headless, via Playwright (the channel="msedge"
recipe tools/ui_probe.py and acctcols_probe.py already use, so no download).

    python tests/imgcap_probe.py <cap.html> [--css PATH] [--expect-fail]

<cap.html> is the markup dumped by `tests/imgcap_dump.mjs`, i.e. the REAL
<ImgCardCaption/> render — not a hand-copy that could drift from img.tsx.

⚠ THE CONTROL IS NOT OPTIONAL. `--css` + `--expect-fail` runs the SAME markup
against the PRE-fix stylesheet and REQUIRES this probe to fail. Without it,
"no wrapping found" and "this probe cannot detect wrapping" are the same
output. Pairing today's markup with the old sheet is sound here because the
markup change shipped alongside (extracting ImgCardCaption, adding the
head/tail spans) is inert under the old sheet: `.fcn-head`/`.fcn-tail` match
no rule there, so the name renders as one text run exactly as it did before.

Touches no orgtree backend, no port, no user data: it opens a file:// URL.

RUNNING IT (from frontend/)
    node tests/imgcap_dump.mjs /tmp/cap.html
    python tests/imgcap_probe.py /tmp/cap.html --shot /tmp/after.png
and the control:
    git show <ref>:frontend/src/styles.css > /tmp/old.css
    python tests/imgcap_probe.py /tmp/cap.html --css /tmp/old.css --expect-fail
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_CSS = HERE.parent / "src" / "styles.css"

# widths to check: the card's natural width, and a genuinely cramped window —
# a one-line row usually breaks in a NEW way when it runs out of room, which
# is the case a fix verified at one width alone would miss
WIDTHS = [(520, "roomy"), (360, "narrow"), (240, "cramped")]

MEASURE = """(el) => {
  const row = el.querySelector('.fc-row') || el.querySelector('.fc-body');
  const name = el.querySelector('.fc-name');
  const size = el.querySelector('.fc-row > .dim, .fc-body > .dim');
  const dl = el.querySelector('.fdl');
  const note = el.querySelector('.fc-note');
  const h = (n) => n ? n.getBoundingClientRect().height : null;
  const r = (n) => { const b = n.getBoundingClientRect();
                     return {x: b.x, y: b.y, w: b.width, h: b.height}; };
  // one text line's height, measured from a probe in the same row context so
  // it tracks the sheet's font-size instead of being hard-coded here
  const probe = document.createElement('span');
  probe.textContent = 'Mg'; probe.style.whiteSpace = 'nowrap';
  row.appendChild(probe);
  const line = probe.getBoundingClientRect().height;
  probe.remove();
  return {
    line,
    nameH: h(name), sizeH: h(size), dlH: h(dl),
    nameR: r(name), sizeR: r(size), dlR: r(dl),
    noteR: note ? r(note) : null,
    rowR: r(row),
    nameText: name ? name.innerText : '',
    title: name ? name.getAttribute('title') : null,
    dlVisible: dl ? (dl.offsetParent !== null
                     && dl.getBoundingClientRect().width > 0) : false,
  };
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--css", default=str(DEFAULT_CSS))
    ap.add_argument("--shot")
    ap.add_argument("--expect-fail", action="store_true")
    a = ap.parse_args()

    css_url = pathlib.Path(a.css).resolve().as_uri()
    src = pathlib.Path(a.html).read_text(encoding="utf-8")
    tmp = pathlib.Path(a.html).with_suffix(".resolved.html")
    tmp.write_text(src.replace("__CSS__", css_url), encoding="utf-8")

    fails: list[str] = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = b.new_page()
        for width, label in WIDTHS:
            pg.set_viewport_size({"width": width, "height": 900})
            pg.goto(tmp.as_uri())
            pg.wait_for_selector(".filecard.imgcard")
            for el in pg.query_selector_all(".case"):
                case = el.get_attribute("data-case")
                full = el.get_attribute("data-name")
                m = el.eval_on_selector(".filecard.imgcard", MEASURE)
                where = f"[{label} {width}px] {case}"
                line = m["line"]
                tol = line * 1.6      # one line + generous slack

                if m["nameH"] > tol:
                    fails.append(
                        f"{where}: the FILENAME wrapped — {m['nameH']:.0f}px "
                        f"tall against a {line:.0f}px line "
                        f"(text={m['nameText']!r})")
                if m["sizeH"] > tol:
                    fails.append(
                        f"{where}: the SIZE wrapped — {m['sizeH']:.0f}px tall "
                        f"against a {line:.0f}px line")
                # name, size and download must share ONE row: same top, within
                # a line of each other
                tops = [m["nameR"]["y"], m["sizeR"]["y"], m["dlR"]["y"]]
                if max(tops) - min(tops) > line * 0.75:
                    fails.append(
                        f"{where}: name/size/download are not on one row "
                        f"(tops {[round(t) for t in tops]})")
                # the download control must stay reachable at every width
                if not m["dlVisible"]:
                    fails.append(f"{where}: the DOWNLOAD control vanished")
                # the note is allowed its own row, but must be BELOW the name
                if m["noteR"] and m["noteR"]["y"] < m["nameR"]["y"] + line / 2:
                    fails.append(
                        f"{where}: the note is sharing the caption row")
                # the full name must remain recoverable when elided
                if case != "short" and m["title"] != full:
                    fails.append(
                        f"{where}: title is {m['title']!r}, not the full name")
                # nothing may spill outside the card
                if (m["nameR"]["x"] + m["nameR"]["w"]
                        > m["rowR"]["x"] + m["rowR"]["w"] + 1):
                    fails.append(f"{where}: the name overflows the card")
        if a.shot:
            pg.set_viewport_size({"width": 520, "height": 900})
            pg.goto(tmp.as_uri())
            pg.screenshot(path=a.shot, full_page=True)
            print(f"screenshot → {a.shot}")
        b.close()

    for f in fails:
        print("  FAIL " + f)
    if a.expect_fail:
        if fails:
            print(f"\nCONTROL OK — the probe FOUND {len(fails)} problem(s) "
                  f"against the pre-fix sheet, so it can detect this defect.")
            return 0
        print("\n☠ CONTROL FAILED: the probe reported a clean sheet against "
              "the PRE-FIX css. It cannot detect the defect it exists for, "
              "so a pass on the fixed sheet proves nothing.")
        return 1
    if fails:
        print(f"\n{len(fails)} PROBLEM(S)")
        return 1
    print(f"\nCAPTION OK — one line at every width {[w for w, _ in WIDTHS]}, "
          f"download reachable, full name in title.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
