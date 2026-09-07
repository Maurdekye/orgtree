"""orrkey_probe.py — does the OpenRouter key row actually lay out?

The user's 2026-09-02 screenshot of App settings → Providers showed the
OpenRouter key row's three buttons (refresh · replace · clear) painted over
each other and over the wrapped standing text ("$0.16efreeplacclear"). The
cause was one class: the text buttons wore `.acct-btn`, which the accounts
panel sizes as a 27x27 ICON button, so each label spilled out of a box a
quarter its width. jsdom cannot see any of that — it implements no CSS box
model, every rect it reports is zero — so this probe measures in Edge
(headless, via Playwright, the same channel="msedge" recipe every other
`*_probe.py` here uses; no browser download).

    python -B tests/orrkey_probe.py [--shot PNG] [--orr-nofavs | --orr-empty]
    python -B tests/orrkey_probe.py --markup OLD.html --expect-fail

The markup is the REAL <AccountsPanel/> render dumped by `setrows_dump.mjs`
(extended 2026-09-03 with an OpenRouter fixture), so what is measured is the
component's own output. `--markup` measures a saved dump instead — that is
how the KNOWN-NEGATIVE CONTROL runs: the pre-fix markup through the identical
probe, which must FAIL. Without that control a green run proves only that
the probe can print OK, not that it can notice anything.

WHAT IT CHECKS, in the OpenRouter section only
  1. no two buttons overlap, and no button's content spills out of its box
  2. no button overlaps a run of text outside a button (the "buttons over the
     wrapped standing line" failure)
  3. the standing line is ONE line
  4. the row's buttons end on the Claude rows' delete column — the row is the
     same object as the account rows above it, not a lookalike
  5. the panel does not overflow sideways (a too-wide child is silently
     unreachable under `.settings`'s overflow-x: hidden)
at 900, 700 and 380px viewports — the panel's natural 660px, a laptop, and
the narrow collapse where the rail goes to 0.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"

# what emotion injects for MuiSvgIcon-fontSizeInherit at runtime; without it
# the icons render at the SVG default 300x150 and the screenshot is unreadable
ICON_SHIM = """
svg.MuiSvgIcon-root { width: 1em; height: 1em; font-size: inherit;
  fill: currentColor; user-select: none; flex-shrink: 0; }
"""

EPS = 1.0

MEASURE = r"""({width}) => {
  const bad = [];
  const panel = document.getElementById('app-settings-panel-providers');
  if (!panel) return ['providers panel absent from the dump'];
  panel.hidden = false;
  const head = panel.querySelector('.acct-provider-head.prov-openrouter');
  if (!head) return ['no OpenRouter section in the dump'];
  const section = head.parentElement;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (r) => r.width > 0 && r.height > 0;
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPS
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;
  const label = (el) => (el.getAttribute('title') || el.textContent || el.className || el.tagName).trim().slice(0, 40);

  // the row's own controls: every button in the section except the favorites
  // row (a button that IS a row) and the head's switch cluster
  const buttons = [...section.querySelectorAll('button')]
    .filter((b) => !b.classList.contains('orr-favs') && !b.closest('.set-head-right')
      && !b.closest('.orr-favs') && visible(rect(b)));

  // 1. buttons keep to their boxes and to themselves
  for (const b of buttons) {
    if (b.scrollWidth > b.clientWidth + EPS) {
      bad.push(`@${width}: button "${label(b)}" spills its content `
        + `(${b.scrollWidth}px in a ${b.clientWidth}px box)`);
    }
  }
  for (let i = 0; i < buttons.length; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      if (overlap(rect(buttons[i]), rect(buttons[j]))) {
        bad.push(`@${width}: buttons "${label(buttons[i])}" and `
          + `"${label(buttons[j])}" overlap`);
      }
    }
  }

  // 2. no button sits on VISIBLE text that is not its own. A text node's
  //    range rect spans the whole glyph run, including the part an
  //    `overflow: hidden; text-overflow: ellipsis` field has clipped away —
  //    that part is not painted, so clip each run to its clipping ancestor
  //    before asking whether a button covers it.
  const clipBox = (el) => {
    for (let a = el; a && a !== section; a = a.parentElement) {
      const ov = getComputedStyle(a).overflowX;
      if (ov === 'hidden' || ov === 'clip' || ov === 'auto' || ov === 'scroll') return rect(a);
    }
    return null;
  };
  const clip = (r, c) => !c ? r : {
    left: Math.max(r.left, c.left), right: Math.min(r.right, c.right),
    top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom),
  };
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || n.parentElement.closest('button')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const c = clipBox(n.parentElement);
    for (const raw of range.getClientRects()) {
      const r = clip(raw, c);
      if (r.right - r.left > EPS && r.bottom - r.top > EPS) {
        texts.push({ r, text: n.textContent.trim().slice(0, 30) });
      }
    }
  }
  for (const b of buttons) {
    const br = rect(b);
    for (const t of texts) {
      if (overlap(br, t.r)) {
        bad.push(`@${width}: button "${label(b)}" is painted over the text `
          + `"${t.text}"`);
        break;
      }
    }
  }

  // 3. the standing line is one line (present only once a key is set)
  const standing = section.querySelector('.orr-standing');
  if (standing) {
    const sr = rect(standing);
    const lh = parseFloat(getComputedStyle(standing).lineHeight) || 20;
    if (sr.height > lh * 1.6) {
      bad.push(`@${width}: the standing line wraps (${sr.height.toFixed(1)}px `
        + `tall at line-height ${lh.toFixed(1)})`);
    }
  }

  // 4. the row's buttons end on the Claude rows' delete column
  const del = panel.querySelector('.acct-key .acct-del');
  const rowBtns = buttons.filter((b) => b.closest('.acct-row'));
  if (del && rowBtns.length && width > 460) {
    const want = rect(del).right;
    const got = Math.max(...rowBtns.map((b) => rect(b).right));
    if (Math.abs(got - want) > EPS) {
      bad.push(`@${width}: the key row's buttons end at ${got.toFixed(1)}, the `
        + `Claude rows' delete column at ${want.toFixed(1)} — off column by `
        + `${(got - want).toFixed(1)}px`);
    }
  }

  // 5. nothing overflows sideways
  if (panel.scrollWidth > panel.clientWidth + 1) {
    bad.push(`@${width}: horizontal overflow (${panel.scrollWidth} > `
      + `${panel.clientWidth})`);
  }
  return bad;
}""".replace("EPS", str(EPS))


def dump(dest: pathlib.Path, extra: list[str]) -> None:
    subprocess.run(["node", str(HERE / "setrows_dump.mjs"), str(dest), *extra],
                   cwd=str(FRONTEND), check=True, stdout=subprocess.DEVNULL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--markup", help="measure this saved dump instead of dumping")
    ap.add_argument("--orr-nofavs", action="store_true")
    ap.add_argument("--orr-empty", action="store_true")
    ap.add_argument("--orr-replacing", action="store_true")
    ap.add_argument("--shot", help="screenshot of the Providers tab at 900px")
    ap.add_argument("--shot-narrow", help="…and at 380px, the stacked layout")
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.markup:
        html = pathlib.Path(a.markup).read_text(encoding="utf-8")
    else:
        flags = (["--orr-nofavs"] if a.orr_nofavs else []) \
            + (["--orr-empty"] if a.orr_empty else []) \
            + (["--orr-replacing"] if a.orr_replacing else [])
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="orrkey-")) / "app.html"
        dump(tmp, flags)
        html = tmp.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8") + ICON_SHIM

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        for width in (900, 700, 380):
            page = browser.new_page(viewport={"width": width, "height": 1200})
            page.set_content(
                f"<style>{css}\nbody{{margin:0;padding:16px}}"
                f".settings{{max-height:none}}</style>"
                f"<div class='overlay' style='position:static;"
                f"background:none;display:block'>{html}</div>")
            failures.extend(page.evaluate(MEASURE, {"width": width}))
            if a.shot and width == 900:
                page.locator(".acct-panel").screenshot(path=a.shot)
                print("saved", a.shot)
            if a.shot_narrow and width == 380:
                page.locator(".acct-panel").screenshot(path=a.shot_narrow)
                print("saved", a.shot_narrow)
            page.close()
        browser.close()

    seen, uniq = set(), []
    for f in failures:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    if a.json:
        print(json.dumps(uniq, indent=1))
    if a.expect_fail:
        if not uniq:
            print("⚠ CONTROL BROKEN: the pre-fix markup PASSED this probe — it is "
                  "not measuring what it claims to; every green run is vacuous")
            return 1
        print(f"CONTROL OK — the pre-fix markup fails, as it must ({len(uniq)}):")
        print("\n".join("   · " + f for f in uniq[:10]))
        return 0
    if uniq:
        print("\n".join("FAIL: " + f for f in uniq))
        return 1
    print("OK — the OpenRouter key row: buttons in their boxes and off the text, "
          "one standing line, on the delete column, no sideways overflow, at "
          "900/700/380px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
