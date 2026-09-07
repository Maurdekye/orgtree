"""D-222 — STEP 2 of the settings-layout probe: the measured half.

Loads the REAL settings markup (dumped by `tests/setrows_dump.mjs`, so it is
the components' own output rather than a hand-copied approximation) plus the
REAL `src/styles.css` into a browser, and measures where things actually land.

    python -B tests/settings_layout_probe.py
    python -B tests/settings_layout_probe.py --expect-fail

WHY A BROWSER. jsdom implements no CSS box model — every rect it reports is
zero — so the sibling jsdom suite (`tests/setrows.test.tsx`) can only check
that the rows are the same KIND of object. That is the cause; this is the
effect. Both halves are needed: markup can be uniform and still land wrong (a
stray `margin-left: auto`), and geometry can be right today for markup that is
one careless row away from drifting.

WHAT THIS EXISTS TO CATCH — the state of the panel on 2026-09-01, measured:

  · Runtime's three on/off words sat at x=1253, x=682 and x=510 in ONE
    1320px panel. `.app-pref-state { margin-left: auto }` only reaches the
    panel edge when nothing follows it, and two of the three rows had a
    trailing hint, so the word parked wherever the prose left it.
  · At a 360px viewport the three Runtime checkboxes rendered ~6px, ~4px and
    effectively invisible: an unstyled checkbox is a shrinkable flex item, and
    a long label on a narrow row simply ate it. That is an accessibility
    failure, not a cosmetic one — a control below about 15px is not reliably
    hittable.
  · The Providers head gave `margin-left: auto` to BOTH the preview tag and
    the switch. Two auto margins split the free space between them, so the tag
    floated at x=686 — beside neither the name it qualifies nor the control it
    belongs with.
  · Provider heads and notes rendered at x=53 while the account rows they
    describe started at x=215, so the tab had two competing left edges.

The assertions below are stated as COLUMNS, not as pixel values: rows must
agree with each other, at whatever width. A layout that is uniformly 4px off
is fine; one row disagreeing with its neighbours is the bug.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"

# Planted defect for --expect-fail. Each line restores one of the four
# measured failures above, so a probe that cannot see them is a probe that
# would not have caught the original bug either.
MUTANT = """
.set-row { display: flex !important; align-items: center !important; }
.set-state { margin-left: auto !important; }
.set-hint { margin-left: 8px !important; }
.settings .set-lead input[type="checkbox"] { flex: 1 1 auto !important;
  width: auto !important; min-width: 0 !important; }
.acct-preview-tag { margin-left: auto !important; }
.acct-prov-note, .acct-prov-tiers { margin-left: 0 !important; }
"""

# the panel ids each dump carries, and the id prefix they share
SCENES = {
    "app": ("app-settings", ["providers", "runtime", "display"]),
    "org": ("org-settings",
            ["basic", "policies", "orgtype", "mailserver", "autonomy"]),
}

# one CSS px of tolerance: sub-pixel rounding is not a misalignment
EPS = 1.0
# below this a control is not reliably hittable
MIN_HIT = 15.0

MEASURE = r"""({panelId, width}) => {
  const bad = [];
  const panel = document.getElementById(panelId);
  if (!panel) return [`${panelId}: panel absent from the dump`];
  panel.hidden = false;
  const spread = (els, side) => {
    const v = els.map((e) => e.getBoundingClientRect()[side]);
    return v.length < 2 ? 0 : Math.max(...v) - Math.min(...v);
  };
  const q = (sel) => [...panel.querySelectorAll(sel)]
    // an element inside a hidden sub-region has a zero rect and would drag
    // every spread to "misaligned" for reasons that are not layout
    .filter((e) => e.getBoundingClientRect().width > 0
                || e.getBoundingClientRect().height > 0);

  // ── 1. ONE LABEL RAIL. Every row's label, and every block's content,
  //       starts at the same x. This is the ragged-left-edge check.
  const labels = q('.set-row > .set-label');
  if (spread(labels, 'left') > EPS) {
    bad.push(`${panelId}: ${labels.length} row labels span `
      + `${spread(labels, 'left').toFixed(1)}px of left edge — not one rail`);
  }
  // blocks keep the rail too (their padding-left must equal the grid's
  // first column + gap)
  const blocks = q('.set-block');
  if (labels.length && blocks.length) {
    const railX = labels[0].getBoundingClientRect().left;
    for (const b of blocks) {
      const kid = [...b.children].find((c) =>
        c.getBoundingClientRect().width > 0);
      if (!kid) continue;
      const dx = kid.getBoundingClientRect().left - railX;
      if (Math.abs(dx) > EPS) {
        bad.push(`${panelId}: a .set-block sits ${dx.toFixed(1)}px off the `
          + `label rail (${kid.className || kid.tagName})`);
      }
    }
  }

  // ── 2. ONE CONTROL COLUMN. At desktop width every trailing control ends
  //       at the same x. This is the on/off-words-at-three-x-positions bug.
  const narrow = width <= 460;
  const controls = q('.set-row > .set-control');
  if (!narrow && spread(controls, 'right') > EPS) {
    const at = controls.map((c) =>
      Math.round(c.getBoundingClientRect().right)).join(', ');
    bad.push(`${panelId}: ${controls.length} controls end at [${at}] — `
      + `${spread(controls, 'right').toFixed(1)}px apart, not a column`);
  }
  // narrow: they drop below the label but STAY ON THE RAIL rather than
  // returning to the panel edge
  if (narrow && labels.length && controls.length) {
    const railX = labels[0].getBoundingClientRect().left;
    for (const c of controls) {
      const dx = c.getBoundingClientRect().left - railX;
      if (Math.abs(dx) > EPS) {
        bad.push(`${panelId}@${width}: a stacked control left the rail by `
          + `${dx.toFixed(1)}px`);
      }
    }
  }

  // ── 3. THE HINT IS UNDER ITS LABEL, not beside it. A hint that shares the
  //       label's baseline is the "second column of unrelated prose" the
  //       redesign removed.
  for (const row of q('.set-row')) {
    const label = row.querySelector(':scope > .set-label');
    const hint = row.querySelector(':scope > .set-hint');
    if (!label || !hint) continue;
    const lr = label.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    if (hr.top < lr.bottom - EPS) {
      bad.push(`${panelId}: a hint sits beside its label, not under it`);
    }
    if (Math.abs(hr.left - lr.left) > EPS) {
      bad.push(`${panelId}: a hint is ${Math.abs(hr.left - lr.left).toFixed(1)}`
        + `px off its own label's rail`);
    }
  }

  // ── 4. HIT TARGETS SURVIVE A NARROW PANEL. The checkbox-shrunk-to-a-dot
  //       failure was invisible at desktop width and total at 360px.
  for (const box of q('.set-lead input, .provider-switch input')) {
    const r = box.getBoundingClientRect();
    if (r.width < MIN_HIT || r.height < MIN_HIT) {
      bad.push(`${panelId}@${width}: a control shrank to `
        + `${r.width.toFixed(1)}x${r.height.toFixed(1)}px — not hittable`);
    }
  }

  // ── 5. ONE AUTO MARGIN PER HEAD. The preview tag and the switch belong to
  //       the same right-hand cluster, and that cluster ends where the head
  //       ends.
  for (const head of q('.set-group-head')) {
    const right = head.querySelector('.set-head-right');
    if (!right) continue;
    const dx = head.getBoundingClientRect().right
      - right.getBoundingClientRect().right;
    if (Math.abs(dx) > EPS) {
      bad.push(`${panelId}: a head's right cluster is ${dx.toFixed(1)}px `
        + `from the head's own right edge — something else claimed the space`);
    }
    for (const item of right.querySelectorAll(
      '.acct-preview-tag, .provider-switch')) {
      const ir = item.getBoundingClientRect();
      const rr = right.getBoundingClientRect();
      if (ir.left < rr.left - EPS || ir.right > rr.right + EPS) {
        bad.push(`${panelId}: ${item.className} escaped the head cluster`);
      }
    }
  }

  // ── 6. THE PROVIDERS RAIL. Notes and tier strips line up with the account
  //       rows they describe, rather than with the panel edge.
  const anyRow = panel.querySelector('.acct-line .acct-row');
  if (anyRow) {
    const rowX = anyRow.getBoundingClientRect().left;
    for (const note of q('.acct-prov-note, .acct-prov-tiers')) {
      const dx = note.getBoundingClientRect().left - rowX;
      if (Math.abs(dx) > EPS) {
        bad.push(`${panelId}@${width}: a provider note is ${dx.toFixed(1)}px `
          + `off the account rows' rail`);
      }
    }
  }

  // ── 7. NOTHING OVERFLOWS SIDEWAYS. `.settings` hides overflow-x, so a
  //       too-wide child is silently unreachable rather than scrollable.
  if (panel.scrollWidth > panel.clientWidth + 1) {
    bad.push(`${panelId}@${width}: horizontal overflow `
      + `(${panel.scrollWidth} > ${panel.clientWidth})`);
  }
  return bad;
}""".replace("EPS", str(EPS)).replace("MIN_HIT", str(MIN_HIT))


def dump(dest: pathlib.Path, org: bool) -> None:
    args = [str(dest)] + (["--org"] if org else [])
    subprocess.run(["node", str(HERE / "setrows_dump.mjs"), *args],
                   cwd=str(FRONTEND), check=True,
                   stdout=subprocess.DEVNULL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--json", action="store_true",
                    help="print the raw failure list")
    args = ap.parse_args()

    css = CSS.read_text(encoding="utf-8") + (MUTANT if args.expect_fail else "")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="setrows-"))
    html = {}
    for kind in SCENES:
        path = tmp / f"{kind}.html"
        dump(path, org=(kind == "org"))
        html[kind] = path.read_text(encoding="utf-8")

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        # 900 = the panel at its natural 660px; 700 = a laptop; 380 = the
        # narrow collapse, which is where the shrunk-checkbox bug lived
        for width in (900, 700, 380):
            for kind, (base, panels) in SCENES.items():
                page = browser.new_page(viewport={"width": width,
                                                  "height": 1200})
                page.set_content(
                    f"<style>{css}\nbody{{margin:0;padding:16px}}"
                    f".settings{{max-height:none}}</style>"
                    f"<div class='overlay' style='position:static;"
                    f"background:none;display:block'>{html[kind]}</div>")
                for panel in panels:
                    failures.extend(page.evaluate(
                        MEASURE, {"panelId": f"{base}-panel-{panel}",
                                  "width": width}))
                page.close()
        browser.close()

    # dedupe while keeping order — the same structural fault repeats across
    # widths and would otherwise bury everything else
    seen, uniq = set(), []
    for f in failures:
        if f not in seen:
            seen.add(f)
            uniq.append(f)

    if args.json:
        print(json.dumps(uniq, indent=1))

    if args.expect_fail:
        if not uniq:
            print("CONTROL FAILED — the planted layout mutant escaped: this "
                  "probe would not have caught the 2026-09-01 defects")
            return 1
        print(f"CONTROL OK — planted mutant detected ({len(uniq)} findings):")
        print("\n".join("  " + item for item in uniq[:8]))
        return 0

    if uniq:
        print("\n".join("FAIL: " + item for item in uniq))
        return 1
    print("OK — one label rail, one control column, hints under their labels, "
          "hit targets intact and no sideways overflow, across App settings "
          "and org settings at 900/700/380px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
