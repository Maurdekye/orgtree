"""A POPPED-OUT MODAL IS A WINDOW, AND A WINDOW NEEDS A TITLE BAR.

The user's report (2026-09-12): the popped-out Work Docket, Usage, Inbox and
presented documents cannot be dragged at all, while a popped-out agent desk
can. This is what measured it, and it is the only place that can: a frameless
window is moved by a `-webkit-app-region: drag` area, which has no meaning
without a compositor and no geometry without layout, so jsdom can say nothing
about either. Chromium reports the property in `getComputedStyle`, so the same
real browser that does the layout also answers what is draggable.

WHAT IT MEASURES, per panel, in a window opened through the REAL pop-out path
(`window.open`, the surface adopted into the new document):

  * the title bar spans the window rather than huddling in a corner, and is a
    drag region — before the fix the Usage bar measured 46x21 at the far right
    of a 750-wide window, every pixel of it an excluded control
  * a walk across that bar lands on draggable pixels for most of its width,
    and lands on `no-drag` exactly where the controls are, so the window can
    be moved AND its controls still clicked
  * the window says its name once: in the title bar, with the panel's own
    duplicate heading stood down
  * the bar stays at the top when the panel scrolls, so the handle cannot be
    scrolled away
  * the controls really work: Return to main window brings the surface home

  * ...and a popped-out agent DESK measures the same way. That is the passing
    control: it is what already worked, it is untouched by this change, and if
    the measurement did not agree with it the measurement would be wrong.

Every check is then watched fail against a source mutation (--mutation, or all
of them in the default run), including a straight reproduction of the reported
defect.

    python -B tests/popoutdrag_probe.py
    python -B tests/popoutdrag_probe.py --panel docket --keep
    python -B tests/popoutdrag_probe.py --mutation no-detached-bar
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]          # apps/desktop/renderer
os.environ['ORGTREE_DATA'] = str(ROOT / 'tests' / '.popoutdrag-data')
assert Path(os.environ['ORGTREE_DATA']).resolve() != Path.home() / 'orgtree', \
    'the probe must never be pointed at real data'

BUNDLE = ROOT / 'node_modules' / '.orgtree-popoutdrag-probe'

# panel query -> the title the window must show, and the panel's own class
PANELS = {
    'docket': ('Work docket', '.docket-modal'),
    'usage': ('Usage', '.usage-modal'),
    'inbox': ('Your inbox', '.settings.wide'),
    'gallery': ('Presented documents', '.gallery-modal'),
}

# each mutation, and the check it must redden
MUTATIONS = {
    'no-detached-bar': 'the bar spans the window',
    'no-detached-name': 'the window names itself',
    'no-panel-class': 'one title, not two',
    'no-sticky-bar': 'the handle cannot be scrolled away',
    'no-drag-region': 'the bar is a drag region',
    'no-control-exclusions': 'the controls stay clickable',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith(('/o/', '/k/')):
            self.path = '/index.html'
        try:
            super().do_GET()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass        # a child window closing mid-load is the test's own doing


MEASURE = """
(panelSelector) => {
  const region = (el) => el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : 'MISSING'
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const bar = document.querySelector('.modalpin-bar')
  const head = document.querySelector('.cc-head-top')
  const handle = bar || head
  const panel = document.querySelector(panelSelector)
  const out = { win: { w: innerWidth, h: innerHeight }, hasBar: !!bar, hasHead: !!head,
    handle: box(handle), handleRegion: region(handle),
    name: bar && bar.querySelector('.modalpin-name') ? bar.querySelector('.modalpin-name').textContent : null,
    ownHeading: null, panelScroll: null, samples: [], controls: [] }
  if (panel) {
    const h3 = panel.querySelector(':scope > h3, :scope > .gallery-head > h3')
    out.ownHeading = h3 ? { text: h3.textContent, display: getComputedStyle(h3).display } : null
    out.panelScroll = { top: panel.scrollTop, height: panel.scrollHeight, client: panel.clientHeight }
  }
  if (handle) {
    // every STEP px across the bar, so the answer is in PIXELS of grabbable
    // title bar rather than a fraction of however many samples were taken
    const STEP = 8
    const r = handle.getBoundingClientRect()
    for (let x = Math.max(0, Math.round(r.x)); x < Math.min(innerWidth - 1, r.right); x += STEP) {
      const y = Math.round(r.y + r.height / 2)
      const el = document.elementFromPoint(x, y)
      out.samples.push({ x, tag: el ? el.tagName : null,
        cls: el && typeof el.className === 'string' ? el.className : '',
        region: region(el), inHandle: !!(el && handle.contains(el)) })
    }
    out.step = STEP
    for (const el of handle.querySelectorAll('button, a, input, select, textarea')) {
      out.controls.push({ cls: typeof el.className === 'string' ? el.className : '',
        label: el.getAttribute('aria-label') || el.textContent, region: region(el), box: box(el) })
    }
  }
  return out
}
"""

SCROLL = """
(panelSelector) => {
  const panel = document.querySelector(panelSelector)
  const bar = document.querySelector('.modalpin-bar') || document.querySelector('.cc-head-top')
  if (!panel) return { top: Math.round(bar.getBoundingClientRect().top), scrolled: 0, scrollable: 0 }
  // ⚠ THE OVERFLOW IS PLANTED, not waited for. Whether a given panel happens
  // to be taller than the window depends on how much fixture data it was
  // given, and a check that quietly does not run on a short panel is a check
  // that stops holding the moment the fixture changes. A window the user has
  // scrolled must keep its handle, so give it something to scroll.
  const tall = document.createElement('div')
  tall.dataset.probeTall = '1'
  // `flex: 0 0` as well as a height: the panel is a COLUMN FLEX container,
  // where a plain `height` is a base size an item is free to shrink from —
  // which is exactly what it did, leaving nothing to scroll.
  tall.style.cssText = 'height: 2000px; flex: 0 0 2000px'
  panel.appendChild(tall)
  panel.scrollTop = 99999
  const r = bar.getBoundingClientRect()
  const answer = { top: Math.round(r.top), scrolled: panel.scrollTop,
    scrollable: panel.scrollHeight - panel.clientHeight }
  panel.scrollTop = 0
  tall.remove()
  return answer
}
"""


class Failure(Exception):
    pass


def check(ok: bool, name: str, detail: str) -> None:
    if not ok:
        raise Failure(f'{name}: {detail}')


def build(mutation: str | None) -> None:
    args = ['node', 'tests/popoutdrag-build.mjs'] + ([mutation] if mutation else [])
    done = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    if done.returncode:
        raise SystemExit(f'build failed ({mutation}):\n{done.stdout}\n{done.stderr}')


def pop_out(page, base: str, query: str):
    page.goto(f'{base}/?panel={query}')
    page.locator('.modalpin-bar, .cc-head-top').first.wait_for()
    button = page.get_by_role('button', name='Open in new window').first
    with page.expect_popup() as popup:
        button.click()
    child = popup.value
    child.locator('.popout-mount').wait_for()
    child.wait_for_timeout(250)
    return child


def measure_panel(page, base: str, query: str, failures: list[str], verbose: bool):
    """The whole contract for one popped-out panel."""
    title, selector = PANELS.get(query, (None, '.desk-body'))
    child = pop_out(page, base, query)
    child.set_viewport_size({'width': 720, 'height': 420})
    child.wait_for_timeout(150)
    m = child.evaluate(MEASURE, selector)
    if verbose:
        print(f'  {query}: {m["handle"]} region={m["handleRegion"]} name={m["name"]!r}')

    def note(name: str, ok: bool, detail: str):
        if not ok:
            failures.append(f'{query} · {name}: {detail}')

    handle, win = m['handle'], m['win']
    note('the window has a title bar', bool(handle), 'no .modalpin-bar or .cc-head-top at all')
    if not handle:
        child.close()
        return m
    # ⚠ NOT `w >= 0.9 * win`: a popped-out DESK is inset 8px on every side by
    # `.popout-mount:has(.cc-head)`, so its bar is the window's width less
    # that room and starts 8px down. The 46px corner cluster this fix removes
    # fails either way.
    note('the bar spans the window',
         handle['w'] >= win['w'] - 40 and handle['y'] <= 12 and handle['h'] >= 18,
         f'{handle} in a {win["w"]}x{win["h"]} window')
    note('the bar is a drag region', m['handleRegion'] == 'drag',
         f'-webkit-app-region is {m["handleRegion"]!r}')

    # HOW MANY PIXELS OF THE BAR ACTUALLY MOVE THE WINDOW. A fraction is the
    # wrong question: a desk header is packed with controls and still leaves
    # ~270px to grab, which is plenty, while the Usage bar before the fix had
    # about 12px — the gaps between two buttons in a 46px cluster.
    draggable = [s for s in m['samples'] if s['region'] == 'drag']
    grabbable = len(draggable) * m.get('step', 8)
    note('most of the bar moves the window', grabbable >= 120,
         f'only ~{grabbable}px of the {handle["w"]}px bar moves the window')
    swallowed = [c for c in m['controls'] if c['region'] != 'no-drag']
    note('the controls stay clickable', not swallowed,
         f'{[c["label"] for c in swallowed]} would be swallowed by the drag region')

    if query in PANELS:
        note('the window names itself', m['name'] == title, f'title bar says {m["name"]!r}, not {title!r}')
        heading = m['ownHeading']
        note('one title, not two', heading is None or heading['display'] == 'none',
             f'the panel also shows its own heading {heading!r}')

    # ⚠ MODALS ONLY. A modal's title bar lives INSIDE its scrolling panel and
    # stays put by being sticky; a desk's header is a sibling of its message
    # scroller and never moves in the first place, so the same check there
    # would assert a mechanism the desk does not use.
    if query in PANELS:
        scrolled = child.evaluate(SCROLL, selector)
        note('the panel really scrolled', scrolled['scrolled'] > 100,
             f'POSITIVE CONTROL: nothing scrolled, so stickiness was not exercised ({scrolled})')
        # ⚠ BOTH ENDS. `top <= 12` alone is satisfied by a bar that has been
        # scrolled clean off the top of the window (-1864px, measured against
        # the non-sticky mutant) — which is the very failure this is for.
        note('the handle cannot be scrolled away', -6 <= scrolled['top'] <= 12,
             f'the bar sits at {scrolled["top"]}px after scrolling {scrolled["scrolled"]}px')

    # the controls are not decoration: the return control really returns it
    child.get_by_role('button', name='Return to main window').first.click()
    page.locator('.modalpin-bar, .cc-head-top').first.wait_for()
    note('Return to main window works', page.locator('.overlay-detached').count() == 0,
         'the surface stayed detached after its own control was pressed')
    return m


def run(mutation: str | None, panels: list[str], verbose: bool) -> list[str]:
    build(mutation)
    handler = functools.partial(Handler, directory=str(BUNDLE))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    failures: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge')
            context = browser.new_context(viewport={'width': 1200, 'height': 820})
            context.set_default_timeout(10000)
            page = context.new_page()
            errors: list[str] = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            for query in panels:
                measure_panel(page, base, query, failures, verbose)
            if errors:
                failures.append('page errors: ' + ' | '.join(sorted(set(errors))[:3]))
            browser.close()
    finally:
        server.shutdown()
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', action='append', choices=[*PANELS, 'desk'])
    ap.add_argument('--mutation', choices=[*MUTATIONS])
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()
    panels = args.panel or [*PANELS, 'desk']

    if args.mutation:
        failures = run(args.mutation, ['usage'], args.verbose)
        expected = MUTATIONS[args.mutation]
        hit = [f for f in failures if expected in f]
        print(f'MUTATION {args.mutation}: ' + (' | '.join(failures) or 'nothing failed'))
        if not hit:
            print(f'FAIL the mutation must redden "{expected}"')
            return 1
        print(f'OK  "{expected}" caught it')
        return 0

    failures = run(None, panels, True)
    if failures:
        print('FAIL')
        for f in failures:
            print('  ·', f)
        return 1
    print('OK  ' + ', '.join(panels) + ': the title bar spans the window, drags it, keeps its controls '
          'clickable, names the window once and cannot be scrolled away')

    # the fault controls: every check above must be able to go red
    for mutation, expected in MUTATIONS.items():
        found = run(mutation, ['usage'], False)
        if not any(expected in f for f in found):
            print(f'FAIL mutation {mutation} did not redden "{expected}" (saw: {found})')
            return 1
        print(f'OK  mutation {mutation} reddens "{expected}"')
    build(None)
    return 0


if __name__ == '__main__':
    sys.exit(main())
