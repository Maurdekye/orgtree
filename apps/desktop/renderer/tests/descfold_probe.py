"""descfold_probe.py — does a ticket description really fold at TEN lines?

The requirement (user 2026-09-12) is stated in RENDERED lines: a description
occupying more than ten of them starts collapsed to ten and can be expanded;
one of ten or fewer is shown whole with no control. Every word of that is a
claim about layout, and jsdom has none — it reports every box as zero, so the
focused suite (`docketdesc.test.tsx`) has to supply synthetic rects. Synthetic
rects can only confirm the arithmetic I wrote. This asks a real engine whether
that arithmetic is measuring the right thing.

    python -B tests/descfold_probe.py                 # the shipped sheet
    python -B tests/descfold_probe.py --json out.json # ...and keep the numbers
    python -B tests/descfold_probe.py --mutant all    # KNOWN-NEGATIVE CONTROLS
    python -B tests/descfold_probe.py --shot out.png  # look at it

WHAT IT CHECKS
  ten-visible   a folded description shows EXACTLY ten rendered lines: the
                tenth line's ink is inside the clip and the eleventh's is not.
                Not "about ten" — the count is the requirement.
  wraps-count   a description that is ONE paragraph with no newlines, wrapped
                by the browser past ten lines, folds. This is the case source-
                line counting gets wrong and no jsdom test can catch.
  short-clean   at ten lines and under: no control in the DOM at all, and the
                content is not clipped (scrollHeight == clientHeight).
  reveals-all   after expanding, nothing is clipped and the LAST line of the
                description is inside the visible box — "expansion must reveal
                the complete description".
  control-usable the toggle has a real box and is the topmost element at its
                own centre, i.e. a click actually lands on it.
  markdown      the markdown blocks are laid out as blocks: the heading is on
                its own line and larger than body text, list items stack, and
                the code fence is a block. Rendering as `<h1>` in the DOM is
                not the same claim as occupying a line.
  no-spill      nothing inside the clip is PAINTED below its bottom edge.
                `scrollHeight > clientHeight` stays true when overflow is
                visible, so geometry alone reports a perfect fold while every
                line is on screen; this hit-tests the pixels.
  pitch         the folded box is text rather than blank space — a body forced
                back to pre-wrapped plain text keeps its row count and doubles
                every gap, which no line count can see.
  mail-five     the received-mail preview still folds at FIVE. Its measurement
                was extracted into the shared `foldAt` by this work, and it
                has no jsdom test of its own — only this.

THE POSITIVE CONTROL IS IN THE PAGE. The `short` panel must measure as
unclipped and controlless. If a run reports EVERY panel as unclipped then the
fold never ran at all — the bundle is wrong, not the feature — and the probe
says so and fails rather than reporting a clean sheet.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "descfold_build.mjs"

FOLD_LINES = 10
MAIL_LINES = 5

#: Known negatives. Each is a way the fold silently degrades while every DOM
#: test still passes, and the probe must FAIL every one of them.
MUTANTS = {
    # ⚠ THE CLIP ITSELF REMOVED — BOTH halves of it. The measured maxHeight is
    # still set, but nothing hides what overflows, so all forty lines are on
    # screen under a box that claims to be showing ten.
    #
    # Taking `overflow` away ALONE is not a negative at all, which is worth
    # recording rather than rediscovering: the mask is sized to the border box,
    # so it goes on hiding the overflow — and hit-testing follows it — even
    # with `overflow: visible`. The fold has two independent enforcers and
    # either one holds, so a control that removed just one would have "passed"
    # while proving nothing.
    "noclip": (
        ".docket-desc-fold.folded .docket-desc-clip {\n  overflow: hidden;\n"
        "  mask-image: linear-gradient(to bottom, #000 70%, transparent 100%);\n}",
        ".docket-desc-fold.folded .docket-desc-clip {\n  overflow: visible;\n}"),
    # the markdown body forced back to pre-wrapped plain text: every source
    # newline becomes a line and the blocks stop being blocks
    "preplain": (
        ".docket-desc-body.md { white-space: normal; }",
        ".docket-desc-body.md { white-space: pre-wrap; }"),
    # the control made invisible while still in the DOM — a fold with no way
    # out, which every presence-based test would call fine
    "hidetoggle": (
        ".docket-desc-toggle.docket-desc-toggle {\n  display: block;",
        ".docket-desc-toggle.docket-desc-toggle {\n  display: none;"),
    # ⚠ THE DEFECT THIS PROBE ACTUALLY FOUND, put back. Undoubling the class
    # drops the rule to (0,1,0), which loses to `.settings button` (0,1,1) —
    # and the quiet "show all N lines" link becomes a 34px padded control with
    # a 6px radius sitting under every long description. Every jsdom test
    # passes either way; only a browser can see it.
    "settingsbutton": (
        ".docket-desc-toggle.docket-desc-toggle {\n  display: block;",
        ".docket-desc-toggle {\n  display: block;"),
}

MEASURE = r"""
() => {
  const out = {}
  // ONE definition of "a rendered line", and it is the browser's: the client
  // rects of the text, merged where they share a row. Deliberately NOT the
  // app's own helper — a probe that imported the code under test would agree
  // with it by construction.
  const rowsOf = (el) => {
    const frags = []
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) frags.push({ top: r.top, bottom: r.bottom })
      }
    }
    frags.sort((a, b) => a.top - b.top)
    const rows = []
    for (const r of frags) {
      const last = rows[rows.length - 1]
      if (last && r.top < last.bottom - 1 && r.bottom > last.top + 1) {
        last.top = Math.min(last.top, r.top)
        last.bottom = Math.max(last.bottom, r.bottom)
      } else rows.push({ top: r.top, bottom: r.bottom })
    }
    return rows
  }
  for (const panel of document.querySelectorAll('[data-panel]')) {
    const id = panel.dataset.panel
    const mail = id.startsWith('mail-')
    const clip = panel.querySelector(mail ? '.turn-mail-preview-content' : '.docket-desc-clip')
    const body = panel.querySelector(mail ? '.turn-mail-body' : '.docket-desc-body')
    const btn = panel.querySelector(mail ? '.turn-mail-toggle' : '.docket-desc-toggle')
    if (!clip || !body) { out[id] = { missing: true }; continue }
    // ⚠ SCROLLED INTO VIEW BEFORE ANY OF IT. Every measurement below is
    // viewport-relative, and `elementsFromPoint` answers null for anything
    // off-screen — so on a page of stacked panels the hit tests would report
    // "nothing painted here" for every panel below the first, which is the
    // reassuring answer and the wrong one. One scroll per panel, then read.
    clip.scrollIntoView({ block: 'center' })
    const cb = clip.getBoundingClientRect()
    const rows = rowsOf(body)
    // a row counts as SHOWN when its ink is fully inside the clip box
    const shown = rows.filter((r) => r.bottom <= cb.bottom + 0.5).length
    const rec = {
      rows: rows.length,
      shown,
      clipped: clip.scrollHeight > clip.clientHeight + 1,
      scrollH: clip.scrollHeight,
      clientH: clip.clientHeight,
      maxHeight: clip.style.maxHeight || '',
      hasToggle: !!btn,
      expanded: btn ? btn.getAttribute('aria-expanded') : null,
      controls: btn ? btn.getAttribute('aria-controls') : null,
      clipId: clip.id || '',
      lastRowBottom: rows.length ? rows[rows.length - 1].bottom : null,
      clipBottom: cb.bottom,
    }
    if (btn) {
      // the panel was scrolled into view above, so the control is on screen
      // and `elementFromPoint` can answer for it
      const bb = btn.getBoundingClientRect()
      const cs = getComputedStyle(btn)
      rec.btnBox = [Math.round(bb.width), Math.round(bb.height)]
      rec.btnChrome = {
        font: parseFloat(cs.fontSize),
        padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft),
        radius: parseFloat(cs.borderTopLeftRadius),
        display: cs.display,
      }
      const hit = document.elementFromPoint(bb.left + bb.width / 2,
                                            bb.top + bb.height / 2)
      rec.btnHit = !!(hit && (hit === btn || btn.contains(hit)))
      rec.btnText = (btn.textContent || '').trim()
    }
    // ⚠ IS ANYTHING ACTUALLY PAINTED BELOW THE CLIP? `scrollHeight >
    // clientHeight` only says the CONTENT is taller than the box; it stays
    // true when `overflow` is `visible` and the overflowing lines are on
    // screen for all to read. So this hit-tests a point just under the clip's
    // own bottom edge and asks whether anything inside the clip is there.
    // A geometry-only probe reports a perfect ten-line fold while forty lines
    // are visible (the `noclip` control).
    {
      const probeY = cb.bottom + 6
      const probeX = cb.left + Math.min(30, cb.width / 4)
      const hits = document.elementsFromPoint(probeX, probeY) || []
      rec.spill = hits.some((h) => clip.contains(h) && h !== clip)
    }
    // ⚠ AND HOW MUCH OF THE BOX IS INK? A body forced back to pre-wrapped
    // plain text keeps the same number of TEXT rows — the blank lines between
    // markdown blocks are whitespace-only nodes, which no line count sees —
    // while every gap doubles. Pitch catches what a row count cannot.
    rec.lineHeight = parseFloat(getComputedStyle(body).lineHeight) || null
    rec.pitch = rows.length ? clip.scrollHeight / rows.length : null
    // the bare `<button>` planted in the same modal — the environment control
    const ctl = panel.querySelector('.descfold-control')
    if (ctl) {
      const cs = getComputedStyle(ctl)
      rec.control = {
        font: parseFloat(cs.fontSize), padLeft: parseFloat(cs.paddingLeft),
        radius: parseFloat(cs.borderTopLeftRadius),
      }
    }
    // markdown geometry, only where it is being asked about
    if (id === 'rich') {
      const h1 = body.querySelector('h1'), p = body.querySelector('p')
      const lis = [...body.querySelectorAll('ul li')]
      const pre = body.querySelector('pre')
      const chip = body.querySelector('.docket-ref')
      rec.md = {
        h1Font: h1 ? parseFloat(getComputedStyle(h1).fontSize) : null,
        pFont: p ? parseFloat(getComputedStyle(p).fontSize) : null,
        h1Own: !!(h1 && p && h1.getBoundingClientRect().bottom
                  <= p.getBoundingClientRect().top + 0.5),
        liStacked: lis.length >= 2
          && lis[0].getBoundingClientRect().bottom <= lis[1].getBoundingClientRect().top + 0.5,
        preBlock: pre ? getComputedStyle(pre).display === 'block' : null,
        chipInline: chip ? getComputedStyle(chip).display === 'inline' : null,
      }
    }
    out[id] = rec
  }
  return out
}
"""

EXPAND = r"""
(id) => {
  const panel = document.querySelector(`[data-panel="${id}"]`)
  const btn = panel && panel.querySelector('.docket-desc-toggle')
  if (!btn) return false
  btn.click()
  return true
}
"""


def check(obs: dict) -> list[str]:
    bad: list[str] = []
    need = ("short", "exactly-ten", "eleven", "long", "wrap", "rich",
            "mail-long", "mail-short")
    for name in need:
        if name not in obs:
            bad.append(f"{name}: panel did not render")
        elif obs[name].get("missing"):
            bad.append(f"{name}: panel rendered without a body")
    if bad:
        return bad

    # ---- THE ENVIRONMENT CONTROL, FIRST. If nothing on the page is clipped,
    # the fold never ran and no measurement below means anything.
    if not any(obs[n]["clipped"] for n in ("eleven", "long", "wrap", "mail-long")):
        return ["CONTROL FAILED: no panel on the page is clipped at all — the "
                "fold never ran, so this run says nothing about it"]

    # ---- THE CASCADE CONTROL. The docket pane is a `.settings` modal, so
    # `.settings button` applies to anything the description draws. If the
    # bare button planted beside it is NOT wearing that chrome, this run
    # cannot say whether the toggle beats it.
    ctl = obs["eleven"].get("control")
    if not ctl:
        bad.append("CONTROL FAILED: the bare button did not render")
    elif ctl["padLeft"] < 10 or ctl["radius"] < 4:
        return [f"CONTROL FAILED: the bare button measured padding-left "
                f"{ctl['padLeft']}px radius {ctl['radius']}px — `.settings "
                f"button` did not apply, so nothing here measures the cascade"]

    # ---- toggle-chrome: the quiet link is a quiet link, not a padded control
    for name in ("eleven", "long", "wrap"):
        ch = obs[name].get("btnChrome")
        if not ch:
            continue
        if ctl and ch["font"] >= ctl["font"]:
            bad.append(f"{name}: the expand control is {ch['font']}px, the same "
                       f"size as a real button — `.settings button` won the "
                       f"cascade and this is not the quiet link it should be")
        if ch["padTop"] > 3 or ch["radius"] > 0:
            bad.append(f"{name}: the expand control kept button chrome "
                       f"(padding-top {ch['padTop']}px, radius {ch['radius']}px)")
        h = obs[name].get("btnBox", [0, 0])[1]
        if h > 24:
            bad.append(f"{name}: the expand control is {h}px tall — a padded "
                       f"button, not a line of text under the description")

    # ---- short-clean: at and under the threshold, no control, no clipping
    for name in ("short", "exactly-ten"):
        r = obs[name]
        if r["hasToggle"]:
            bad.append(f"{name}: a {r['rows']}-line description was given an "
                       f"expand control it does not need")
        if r["clipped"]:
            bad.append(f"{name}: a {r['rows']}-line description is clipped "
                       f"({r['scrollH']} > {r['clientH']})")
        if r["maxHeight"]:
            bad.append(f"{name}: maxHeight {r['maxHeight']} on an unfolded body")
    if obs["exactly-ten"]["rows"] != FOLD_LINES:
        bad.append(f"exactly-ten: the boundary panel measured "
                   f"{obs['exactly-ten']['rows']} rendered lines, not {FOLD_LINES} "
                   f"— the fixture no longer sits on the boundary it is testing")

    # ---- ten-visible and wraps-count
    for name in ("eleven", "long", "wrap"):
        r = obs[name]
        if not r["hasToggle"]:
            bad.append(f"{name}: {r['rows']} rendered lines and no expand control")
            continue
        if r["expanded"] != "false":
            bad.append(f"{name}: did not start collapsed (aria-expanded="
                       f"{r['expanded']})")
        if not r["clipped"]:
            bad.append(f"{name}: {r['rows']} lines but nothing is clipped")
        if r["shown"] != FOLD_LINES:
            bad.append(f"{name}: {r['shown']} lines visible while folded, "
                       f"expected exactly {FOLD_LINES} (of {r['rows']})")
        if r["controls"] != r["clipId"] or not r["clipId"]:
            bad.append(f"{name}: aria-controls={r['controls']!r} does not name "
                       f"the clipped region ({r['clipId']!r})")
        if not r.get("btnHit"):
            bad.append(f"{name}: the expand control is not the topmost element "
                       f"at its own centre — a click would not reach it")
        if r.get("btnBox", [0, 0])[1] <= 0:
            bad.append(f"{name}: the expand control has no height")
        if r.get("spill"):
            bad.append(f"{name}: description text is painted BELOW the clip — "
                       f"the fold is not hiding anything, it is only measuring")

    # ---- pitch: the box is text, not blank space. A pre-wrapped body keeps
    # its row COUNT and doubles every gap, which a line count cannot see.
    for name in ("exactly-ten", "short", "eleven", "long"):
        r = obs[name]
        lh, pitch = r.get("lineHeight"), r.get("pitch")
        if not lh or not pitch:
            continue
        if pitch > lh * 1.9:
            bad.append(f"{name}: {pitch:.1f}px per rendered line against a "
                       f"{lh:.1f}px line-height — the body is mostly blank "
                       f"space, so the ten lines it shows are not ten lines "
                       f"of description")

    # the wrapping panel is the one that separates rendered lines from source
    # lines, so say plainly if the fixture stopped wrapping
    if obs["wrap"]["rows"] <= FOLD_LINES:
        bad.append(f"wrap: the single-paragraph fixture rendered only "
                   f"{obs['wrap']['rows']} lines — it is no longer wrapping past "
                   f"the threshold, so it tests nothing")

    # ---- markdown geometry
    m = obs["rich"].get("md") or {}
    if not m.get("h1Own"):
        bad.append("markdown: the heading does not occupy its own line")
    if not (m.get("h1Font") and m.get("pFont") and m["h1Font"] > m["pFont"]):
        bad.append(f"markdown: heading {m.get('h1Font')}px is not larger than "
                   f"body {m.get('pFont')}px — it is not rendering as a heading")
    if not m.get("liStacked"):
        bad.append("markdown: list items do not stack on separate lines")
    if m.get("preBlock") is not True:
        bad.append("markdown: the code fence is not a block")
    if m.get("chipInline") is not True:
        bad.append("markdown: a bare item name is not inline in its sentence")

    # ---- mail-five: the shared measurement still answers five for mail
    ml, ms = obs["mail-long"], obs["mail-short"]
    if not ml["hasToggle"]:
        bad.append(f"mail-five: a {ml['rows']}-line mail body got no control")
    elif ml["shown"] != MAIL_LINES:
        bad.append(f"mail-five: {ml['shown']} lines visible in a folded mail "
                   f"body, expected exactly {MAIL_LINES} (of {ml['rows']})")
    if ms["hasToggle"] or ms["clipped"]:
        bad.append(f"mail-five: a {ms['rows']}-line mail body was folded")
    return bad


def check_expanded(obs: dict) -> list[str]:
    bad: list[str] = []
    for name in ("eleven", "long", "wrap"):
        r = obs[name]
        if r["expanded"] != "true":
            bad.append(f"{name}: still collapsed after clicking the control")
            continue
        if r["clipped"]:
            bad.append(f"{name}: still clipped after expanding "
                       f"({r['scrollH']} > {r['clientH']})")
        if r["maxHeight"]:
            bad.append(f"{name}: maxHeight {r['maxHeight']} survived expansion")
        # reveals-all: the LAST rendered line is inside the visible box
        if r["lastRowBottom"] is None:
            bad.append(f"{name}: no text measured after expanding")
        elif r["lastRowBottom"] > r["clipBottom"] + 0.5:
            bad.append(f"{name}: the last line is still below the visible box "
                       f"({r['lastRowBottom']:.1f} > {r['clipBottom']:.1f}) — "
                       f"expansion did not reveal the whole description")
        if r["shown"] != r["rows"]:
            bad.append(f"{name}: {r['shown']} of {r['rows']} lines visible "
                       f"after expanding")
    return bad


def build(outdir: pathlib.Path, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
    if mutant:
        old, new = MUTANTS[mutant]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                          encoding="utf-8")
        json.dump([{"old": old, "new": new}], tmp)
        tmp.close()
        args += ["--subst", tmp.name]
    try:
        subprocess.run(["node", *args], check=True, cwd=str(FRONTEND))
    finally:
        if tmp:
            pathlib.Path(tmp.name).unlink(missing_ok=True)


def run(html: pathlib.Path, shot: str | None = None,
        verbose: bool = True) -> tuple[list[str], dict]:
    errors: list[str] = []
    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge")
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(html.as_uri(), wait_until="load")
        pg.wait_for_selector(".docket-desc-body", state="attached", timeout=8000)
        # the fold is measured in a layout effect and again by a ResizeObserver;
        # let both settle before reading anything
        pg.wait_for_timeout(300)
        folded = pg.evaluate(MEASURE)
        if shot:
            pg.screenshot(path=shot, full_page=True)
        for name in ("eleven", "long", "wrap"):
            pg.evaluate(EXPAND, name)
        pg.wait_for_timeout(200)
        expanded = pg.evaluate(MEASURE)
        br.close()
    fails = check(folded) + check_expanded(expanded)
    if errors:
        fails.append(f"page errors: {errors}")
    if verbose:
        for name, rec in folded.items():
            print(f"  {name:<12} {json.dumps(rec)}")
    return fails, {"folded": folded, "expanded": expanded, "errors": errors}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--shot")
    ap.add_argument("--mutant", help="a known-negative control, or 'all'")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="descfold-") as tmp:
        out = pathlib.Path(tmp)
        if a.mutant == "all":
            worst = 0
            for name in MUTANTS:
                build(out, name)
                fails, _ = run(out / "probe.html", verbose=False)
                if fails:
                    print(f"  {name:<12} CAUGHT  ({fails[0][:88]})")
                else:
                    print(f"  {name:<12} NOT CAUGHT — the probe would miss this")
                    worst = 1
            print("mutants: all caught" if not worst
                  else "mutants: A CONTROL SLIPPED THROUGH")
            return worst
        build(out, a.mutant)
        fails, obs = run(out / "probe.html", shot=a.shot)
        if a.json:
            pathlib.Path(a.json).write_text(json.dumps(obs, indent=2),
                                            encoding="utf-8")
        if fails:
            print(f"\ndescfold: {len(fails)} problem(s)")
            for f in fails:
                print(f"  - {f}")
            return 1
        print("\ndescfold: the description folds at ten rendered lines, expands "
              "to the whole of itself, and mail still folds at five")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
