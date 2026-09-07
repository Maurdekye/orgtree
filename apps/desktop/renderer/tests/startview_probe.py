"""D-228 — the startup-view settings, exercised in a REAL browser against a
running dev server (vite on :5173 proxying the backend on :7360).

    python -B tests/startview_probe.py [--slug unity] [--base http://localhost:5173]
                                       [--shots DIR]

WHY A BROWSER. The jsdom suite (`tests/startview.test.tsx`) proves WHERE the
camera lands and whether it TRAVELS, but its rAF is a mocked timer and its
`animateTo` completes in one frame — so the 1700ms glide, the real viewport
maths and the settings modal's actual rendering are all unmodelled there.
This probe samples the world transform at ~25ms for the first 2.6s after the
org route renders, in each mode, and reads the switchboard as the eye card
wearing `.desk` — the same readers as the jsdom suite, on real geometry.

The org is READ ONLY: the probe loads the route, moves its own camera in its
own throwaway browser profile, and never posts an op.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

# a Windows console defaults to cp1252, and the findings carry real prose
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

READ = r"""() => {
  const s = document.querySelector('.space');
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(s ? s.style.transform : '');
  if (!m) return null;
  return { x: +m[1], y: +m[2], z: +m[3],
           swb: !!document.querySelector('.sq.desk.user') };
}"""

EYE_Z0 = 1.6


def same_cam(a, b) -> bool:
    """the transform string is the browser's CSS serialization of the camera
    (rounded, e.g. `-11677.5px` for -11677.4919…), while localStorage holds
    the full float — so equality is to serialization precision, not 1e-6"""
    return (abs(a['x'] - b['x']) < 0.01 and abs(a['y'] - b['y']) < 0.01
            and abs(a['z'] - b['z']) < 1e-4)


def sample(page, ms=2600, step=0.025):
    page.wait_for_selector('.space', state='attached', timeout=30000)
    out = []
    t0 = time.time()
    while (time.time() - t0) * 1000 < ms:
        f = page.evaluate(READ)
        if f:
            f['t'] = round((time.time() - t0) * 1000)
            out.append(f)
        time.sleep(step)
    return out


def open_org(ctx, base, slug, prefs, keep=False):
    """a fresh page: land on the welcome route, write the prefs into this
    profile's localStorage (clearing every orgtree-* key first unless `keep`),
    then navigate to the org route and sample the camera."""
    page = ctx.new_page()
    page.goto(base + '/', wait_until='domcontentloaded')
    page.evaluate("""([prefs, keep]) => {
      if (!keep) for (const k of Object.keys(localStorage))
        if (k.startsWith('orgtree-')) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
    }""", [prefs, keep])
    page.goto(f'{base}/o/{slug}', wait_until='domcontentloaded')
    return page


def describe(frames):
    zs = [f['z'] for f in frames]
    return (f"first z={frames[0]['z']:.3f}@{frames[0]['t']}ms  "
            f"last z={frames[-1]['z']:.3f}@{frames[-1]['t']}ms  "
            f"min={min(zs):.3f} max={max(zs):.3f}  "
            f"swb first={frames[0]['swb']} last={frames[-1]['swb']}  "
            f"({len(frames)} samples)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://localhost:5173')
    ap.add_argument('--slug', default='unity')
    ap.add_argument('--shots', default='')
    args = ap.parse_args()
    shots = pathlib.Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)

    fails: list[str] = []
    notes: list[str] = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)

        def fresh():
            return browser.new_context(viewport={'width': 1400, 'height': 900})

        # ── A. defaults: eye park, glide out, no switchboard ────────────────
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug, {})
        fr = sample(page)
        notes.append('A defaults           ' + describe(fr))
        check(fr[0]['z'] > 1.4, f"A: first frame z={fr[0]['z']} — no eye park")
        check(fr[-1]['z'] < fr[0]['z'] - 0.2, 'A: the camera did not glide out')
        check(not fr[-1]['swb'], 'A: switchboard open under the default')
        if shots:
            page.screenshot(path=str(shots / 'A-default-landed.png'))
        ctx.close()

        # ── B. org + zoom off: opens fitted, camera never moves ─────────────
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug, {'orgtree-start-zoom': '0'})
        fr = sample(page, ms=1500)
        notes.append('B org, zoom off      ' + describe(fr))
        zs = [f['z'] for f in fr]
        check(max(zs) - min(zs) < 1e-9, 'B: the camera moved with the zoom off')
        check(fr[0]['z'] < 1.4, f"B: opened at z={fr[0]['z']} — that is the eye park")
        check(not fr[-1]['swb'], 'B: switchboard open under "org"')
        ctx.close()

        # ── C. switchboard + zoom on: eye park, glide IN, switchboard opens ──
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug,
                        {'orgtree-start-view': 'switchboard'})
        fr = sample(page)
        notes.append('C switchboard        ' + describe(fr))
        check(fr[0]['z'] > 1.4, f"C: first frame z={fr[0]['z']} — no eye park")
        check(fr[-1]['swb'], 'C: the switchboard never opened')
        check(fr[-1]['z'] > fr[0]['z'], 'C: the camera did not zoom IN')
        if shots:
            page.screenshot(path=str(shots / 'C-switchboard-landed.png'))
        ctx.close()

        # ── D. switchboard + zoom off: straight there ───────────────────────
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug,
                        {'orgtree-start-view': 'switchboard',
                         'orgtree-start-zoom': '0'})
        fr = sample(page, ms=1500)
        notes.append('D switchboard, off   ' + describe(fr))
        zs = [f['z'] for f in fr]
        check(max(zs) - min(zs) < 1e-9, 'D: the camera moved with the zoom off')
        check(fr[0]['swb'], 'D: the switchboard was not open on the first frame')
        ctx.close()

        # ── E. remember: first open plays the intro; then a move is saved and
        #       comes back exactly on reload, with no glide ─────────────────
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug,
                        {'orgtree-start-view': 'remember'})
        fr = sample(page)
        notes.append('E remember, 1st open ' + describe(fr))
        check(fr[0]['z'] > 1.4, 'E: first open under "remember" did not play the intro')
        check(fr[-1]['z'] < fr[0]['z'] - 0.2, 'E: the first-open intro did not glide out')
        # move the camera with the HUD (two zoom-ins) and let the save settle
        for _ in range(2):
            page.click('.zoomhud button[title="zoom in"]')
            time.sleep(0.3)
        time.sleep(0.6)
        moved = page.evaluate(READ)
        saved = page.evaluate(
            "s => JSON.parse(localStorage.getItem('orgtree-view-' + s) || 'null')",
            args.slug)
        notes.append(f"E moved to z={moved['z']:.4f}; saved={saved}")
        check(saved is not None, 'E: no camera saved after moving')
        if saved:
            check(same_cam(saved, moved),
                  f'E: saved camera {saved} is not the moved camera {moved}')
        # reload the org route: no intro, exactly the saved camera, never moves
        page.goto(f'{args.base}/o/{args.slug}', wait_until='domcontentloaded')
        fr2 = sample(page, ms=1500)
        notes.append('E remember, reload   ' + describe(fr2))
        zs = [f['z'] for f in fr2]
        check(max(zs) - min(zs) < 1e-9, 'E: the restored camera moved (a glide?)')
        if saved:
            check(same_cam(fr2[0], saved),
                  f'E: restored {fr2[0]} != saved {saved}')
        if shots:
            page.screenshot(path=str(shots / 'E-remember-restored.png'))
        ctx.close()

        # ── F. remember + zoom off, no saved camera: the intro still plays ──
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug,
                        {'orgtree-start-view': 'remember',
                         'orgtree-start-zoom': '0'})
        fr = sample(page, ms=1200)
        notes.append('F remember, zoom off ' + describe(fr))
        check(fr[0]['z'] > 1.4, 'F: the zoom toggle suppressed the first-open intro '
              'under "remember"')
        ctx.close()

        # ── G. the settings surface: App settings → Display → Startup ──────
        ctx = fresh()
        page = open_org(ctx, args.base, args.slug, {'orgtree-start-zoom': '0'})
        sample(page, ms=300)
        page.click('.orgbar button.iconbtn')          # the org drawer
        page.click('button[title="App settings"]')
        page.click('#app-settings-tab-display')
        panel = page.locator('#app-settings-panel-display')
        sel = panel.locator('select[aria-label="open an org at"]')
        tog = panel.locator('input[aria-label="play the starting zoom"]')
        check(sel.count() == 1, 'G: no startup-view select in Display')
        check(tog.count() == 1, 'G: no starting-zoom toggle in Display')
        check(sel.input_value() == 'org', f'G: select shows {sel.input_value()!r}, not org')
        check(not tog.is_checked(), 'G: toggle shows on while the key says off')
        if shots:
            page.screenshot(path=str(shots / 'G-settings-display.png'))
        sel.select_option('remember')
        time.sleep(0.1)
        check(tog.is_disabled(), 'G: toggle stayed enabled under "where I left off"')
        check(page.evaluate("() => localStorage.getItem('orgtree-start-view')") == 'remember',
              'G: the select did not write orgtree-start-view')
        if shots:
            page.screenshot(path=str(shots / 'G-settings-remember.png'))
        sel.select_option('switchboard')
        time.sleep(0.1)
        check(not tog.is_disabled(), 'G: toggle still disabled under "switchboard"')
        tog.click()
        time.sleep(0.1)
        check(page.evaluate("() => localStorage.getItem('orgtree-start-zoom')") == '1',
              'G: the toggle did not write orgtree-start-zoom')
        ctx.close()
        browser.close()

    print('\n'.join(notes))
    if fails:
        print('\n'.join('FAIL: ' + f for f in fails))
        return 1
    print('OK — all three startup views and the zoom toggle behave in a real '
          'browser, and the Display tab drives them')
    return 0


if __name__ == '__main__':
    sys.exit(main())
