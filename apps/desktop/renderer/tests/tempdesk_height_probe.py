"""The temporary desk modal's size in the REAL App (Edge), Canvas and Attention.

    node apps/desktop/renderer/tests/appchrome-build.mjs <bundle>
    python -B apps/desktop/renderer/tests/tempdesk_height_probe.py <bundle> <outdir> [--check]

Opens "Open desk temporarily" from an agent card's menu (Canvas) and from the
agents list's menu (Attention) at a tall viewport, measures the panel against
the window, and screenshots both plus a pinned desk for comparison. --check
asserts: the entry is second in the menu, the panel is 85-90% of the window
height and centred, and it is visible (topmost at its centre) in both views.
"""
from __future__ import annotations

import functools
import http.server
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
assert (BUNDLE / 'appchrome-fixture.js').exists(), 'INERT: bundle missing'


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if '.' not in self.path.split('?')[0].rsplit('/', 1)[-1]:
            self.path = '/index.html'
        super().do_GET()


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(BUNDLE)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/o/studio'

MEASURE = """() => {
  const p = document.querySelector('.tempdesk-panel'); if (!p) return null
  const b = p.getBoundingClientRect()
  const top = document.elementFromPoint(b.left + b.width / 2, b.top + 20)
  return { vw: innerWidth, vh: innerHeight, top: b.top, left: b.left, width: b.width, height: b.height,
    ratio: b.height / innerHeight, centredY: Math.abs((b.top + b.height / 2) - innerHeight / 2),
    visibleOnTop: !!(top && p.contains(top)), hasComposer: !!p.querySelector('textarea') }
}"""


def menu_labels(page):
    return [t.strip() for t in page.locator('[role="menu"] [role="menuitem"]').all_inner_texts()]


result = {'cases': {}, 'errors': []}
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge')
        page = browser.new_page(viewport={'width': 1600, 'height': 1300})
        page.on('pageerror', lambda e: result['errors'].append(str(e)))
        page.goto(base)
        page.locator('.shell-header').wait_for(timeout=15000)
        card = page.locator('.sq', has_text='worker-a').first
        card.wait_for(timeout=15000)
        page.wait_for_timeout(1200)
        # ---- Canvas: the card's own menu
        card.click(button='right')
        page.locator('[role="menu"]').wait_for(timeout=5000)
        result['cases']['canvas-menu'] = menu_labels(page)
        page.screenshot(path=str(OUT / 'menu-canvas.png'))
        page.locator('[role="menuitem"]', has_text='Open desk temporarily').first.click()
        page.locator('.tempdesk-panel').wait_for(timeout=5000)
        page.wait_for_timeout(500)
        result['cases']['canvas'] = page.evaluate(MEASURE)
        page.screenshot(path=str(OUT / 'tempdesk-canvas.png'))
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        result['cases']['canvas-closed'] = page.locator('.tempdesk-panel').count() == 0
        # ---- a pinned desk, for the styling comparison
        card.click(button='right')
        page.locator('[role="menuitem"]', has_text='Pin desk as a window').first.click()
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / 'pinned-desk.png'))
        # ---- Attention: the switch, then the agents list's menu
        page.locator('.shell-header [role="switch"]').click()
        page.wait_for_timeout(800)
        toggle = page.locator('.attn-agents-toggle')
        if toggle.count():
            toggle.first.click()
            page.wait_for_timeout(300)
        row = page.locator('[data-attn-agent="worker-a"]').first
        row.wait_for(timeout=5000)
        row.click(button='right')
        page.locator('[role="menu"]').wait_for(timeout=5000)
        result['cases']['attention-menu'] = menu_labels(page)
        page.locator('[role="menuitem"]', has_text='Open desk temporarily').first.click()
        page.locator('.tempdesk-panel').wait_for(timeout=5000)
        page.wait_for_timeout(500)
        result['cases']['attention'] = page.evaluate(MEASURE)
        page.screenshot(path=str(OUT / 'tempdesk-attention.png'))
        page.locator('.tempdesk-close').click()
        page.wait_for_timeout(300)
        result['cases']['attention-closed'] = page.locator('.tempdesk-panel').count() == 0
        browser.close()
finally:
    server.shutdown()

(OUT / 'tempdesk.json').write_text(json.dumps(result, indent=2), encoding='utf8')
print(json.dumps(result, indent=1))

if '--check' in sys.argv:
    bad = []
    c = result['cases']
    for view in ('canvas', 'attention'):
        labels = c.get(view + '-menu') or []
        if len(labels) < 2 or labels[1] != 'Open desk temporarily':
            bad.append((view, 'entry is not second in the menu', labels[:3]))
        m = c.get(view)
        if not m:
            bad.append((view, 'modal did not open')); continue
        if not (0.85 <= m['ratio'] <= 0.90):
            bad.append((view, 'height is not 85-90% of the window', round(m['ratio'], 3)))
        if m['centredY'] > 2:
            bad.append((view, 'not vertically centred', m['centredY']))
        if not m['visibleOnTop']:
            bad.append((view, 'modal is covered by something else'))
        if not m['hasComposer']:
            bad.append((view, 'the desk (composer) is not inside'))
        if not c.get(view + '-closed'):
            bad.append((view, 'did not close'))
    if result['errors']:
        bad.append(('page', 'errors', result['errors'][:3]))
    print('CHECK', 'FAIL' if bad else 'PASS', json.dumps(bad))
    sys.exit(1 if bad else 0)
