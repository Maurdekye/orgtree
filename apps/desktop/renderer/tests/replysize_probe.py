"""Real Edge render check for the composer's reply annotation (resize-
reply-annotations-above-the-message-box).

The fixture bundles the REAL ReplyPreview component and REAL styles.css.
jsdom does not lay out flex boxes at all (chatreply.test.tsx's own CSS-value
checks say so), so THIS is the check that answers the actual acceptance
criterion — "verify real composer geometry at default and narrow widths" —
rather than a stylesheet regex standing in for it.

Two widths (900: the desk's own authored virtual-panel width, see
styles.css's `.desk-inner` comment "the desk is authored at natural screen
scale — 900px virtual panel"; 340: below the app's 460px mobile breakpoint).
Three claims per width:
  1. the COMPOSING annotation is (approximately) as wide as the composer
     itself — not the old narrow, inset box.
  2. its DEFAULT height (a short one-line quote) is close to the composer's
     own default height — not the old ~150px box.
  3. a LONG quote still scrolls (does not grow the box past the cap) —
     the fix caps the default shape, it does not truncate reply context.
And the negative control: the SETTLED (non-composing) annotation elsewhere
in the app keeps its ORIGINAL narrow, inset shape — proving the resize is
scoped to the composer instance, per the user's explicit clarification that
sent/settled quoted replies are not in scope.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "replysize-build.mjs"
REPLYPREVIEW = FRONTEND / "src" / "canvas" / "replypreview.tsx"
CSS = FRONTEND / "src" / "styles.css"


def main() -> int:
    src = REPLYPREVIEW.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    # positive control: the markers this probe measures must still exist,
    # or every assertion below would pass by finding nothing
    for marker in ("reply-preview-composing", 'className="reply-preview-head"'):
        if marker not in src:
            raise SystemExit(f"fixture guard: replypreview.tsx no longer emits {marker}")
    for marker in (".reply-preview-composing", ".cc-composer textarea"):
        if marker not in css:
            raise SystemExit(f"fixture guard: styles.css no longer contains {marker}")

    with tempfile.TemporaryDirectory(prefix="orgtree-replysize-") as tmp:
        out = pathlib.Path(tmp)
        subprocess.run(["node", str(BUILD), str(out)], cwd=FRONTEND, check=True)

        results = {}
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True)
            for label, width in (("default", 900), ("narrow", 340)):
                page = browser.new_page(viewport={"width": width, "height": 500}, device_scale_factor=1)
                page.goto((out / "probe.html").as_uri())
                page.wait_for_selector("#composing-short .reply-preview-composing")
                results[label] = page.evaluate("""() => {
                  const box = (el) => { const r = el.getBoundingClientRect();
                    return {x: r.x, y: r.y, w: r.width, h: r.height} }
                  const composer = document.querySelector('#composing-short .cc-composer')
                  const shortPreview = document.querySelector('#composing-short .reply-preview-composing')
                  const shortQuote = shortPreview.querySelector('blockquote')
                  const longPreview = document.querySelector('#composing-long .reply-preview-composing')
                  const longQuote = longPreview.querySelector('blockquote')
                  const settled = document.querySelector('#settled .reply-preview')
                  const settledIsComposing = settled.classList.contains('reply-preview-composing')
                  return {
                    composer: box(composer),
                    shortPreview: box(shortPreview),
                    longPreview: box(longPreview),
                    longQuote: {scrollHeight: longQuote.scrollHeight, clientHeight: longQuote.clientHeight},
                    settled: box(settled),
                    settledIsComposing,
                    removeControlPresent: Boolean(shortPreview.querySelector('[aria-label="Remove reply"]')),
                    locateControlPresent: Boolean(shortPreview.querySelector('.reply-preview-head button')),
                  }
                }""")
                page.close()
            browser.close()

    failures = []
    for label, r in results.items():
        composer_w, preview_w = r["composer"]["w"], r["shortPreview"]["w"]
        # WIDTH: both are 0-margin, border-box, full-width block siblings in
        # the same column — they should match almost exactly. A few px of
        # tolerance for border/subpixel rounding, not for a real gap.
        if abs(composer_w - preview_w) > 3:
            failures.append(f"{label}: composer width {composer_w:.1f} vs reply-preview "
                             f"width {preview_w:.1f} — more than 3px apart")
        # DEFAULT HEIGHT: not pixel-equal (the annotation has its own header
        # row the composer doesn't), but must be in the same neighbourhood —
        # not the old ~150px box, and not degenerate/collapsed either.
        composer_h, preview_h = r["composer"]["h"], r["shortPreview"]["h"]
        if not (composer_h * 0.8 <= preview_h <= composer_h * 2.2):
            failures.append(f"{label}: composer height {composer_h:.1f} vs reply-preview "
                             f"default height {preview_h:.1f} — not in the composer's own "
                             f"proportions (expected within [{composer_h*0.8:.0f}, {composer_h*2.2:.0f}])")
        if preview_h >= 120:
            failures.append(f"{label}: reply-preview default height {preview_h:.1f}px is still "
                             "in the old ~150px range")
        # LONG QUOTE: the short fixture quote is a genuine one-liner (well
        # under the 2-line cap, by design — it is what stands in for "the
        # common case" in the default-height check above), so a long quote
        # correctly growing UP TO the cap is not a regression; growing PAST
        # it (the old ~100px+header behaviour) is. Same bounds as the
        # default-height check, not "must equal the short box".
        long_h = r["longPreview"]["h"]
        if not (composer_h * 0.8 <= long_h <= composer_h * 2.2):
            failures.append(f"{label}: composer height {composer_h:.1f} vs reply-preview "
                             f"LONG-quote height {long_h:.1f} — not in the composer's own "
                             f"proportions (expected within [{composer_h*0.8:.0f}, {composer_h*2.2:.0f}])")
        if long_h >= 120:
            failures.append(f"{label}: reply-preview long-quote height {long_h:.1f}px is "
                             "back in the old ~150px range — the cap did not hold")
        if r["longQuote"]["scrollHeight"] <= r["longQuote"]["clientHeight"]:
            failures.append(f"{label}: the long quote has nothing to scroll — "
                             "positive control for the overflow check failed")
        # NEGATIVE CONTROL: the settled/read-only annotation elsewhere in the
        # app must NOT be resized — proves the fix is scoped, not a blanket
        # change to every ReplyPreview usage (user's explicit clarification).
        if r["settledIsComposing"]:
            failures.append(f"{label}: the settled/read-only annotation picked up the "
                             "composer-sizing class — the scoping leaked")
        settled_w = r["settled"]["w"]
        if abs(settled_w - composer_w) < 3:
            failures.append(f"{label}: the settled annotation is full composer width "
                             f"({settled_w:.1f} vs {composer_w:.1f}) — it should have kept "
                             "its original inset shape (this is the negative control's own "
                             "positive control: it must still be NARROWER for the check above to mean anything)")
        # controls preserved
        if not r["removeControlPresent"]:
            failures.append(f"{label}: the composing annotation lost its remove control")
        if not r["locateControlPresent"]:
            failures.append(f"{label}: the composing annotation lost its locate/context control")

    if failures:
        print("REPLYSIZE PROBE FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("replysize probe: composer-width match, default-height proportion, long-quote "
          "scroll, and settled-annotation scoping all hold at both widths.")
    for label, r in results.items():
        print(f"  {label}: composer {r['composer']['w']:.0f}x{r['composer']['h']:.0f}, "
              f"reply-preview {r['shortPreview']['w']:.0f}x{r['shortPreview']['h']:.0f}, "
              f"settled {r['settled']['w']:.0f}x{r['settled']['h']:.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
