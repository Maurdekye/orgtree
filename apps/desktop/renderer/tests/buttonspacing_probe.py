"""Measure real header badges and the Attention drawer, without an engine.

Run: python apps/desktop/renderer/tests/buttonspacing_probe.py <output-dir>
The output must be under this checkout's artifacts directory.
"""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)

import functools
import http.server
import json
import subprocess
import threading
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.relative_to(REPO / 'artifacts')
OUT.mkdir(parents=True, exist_ok=True)
for builder, folder in [('appchrome-build.mjs', 'header'), ('attentionlayout_build.mjs', 'attention')]:
    subprocess.run(['node', str(HERE / builder), str(OUT / folder)], check=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if '.' not in self.path.split('?')[0].rsplit('/', 1)[-1]:
            self.path = '/index.html'
        super().do_GET()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT / 'header')))
threading.Thread(target=server.serve_forever, daemon=True).start()
result = {'header': [], 'drawer': [], 'errors': []}
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge')
        for width in [640, 700, 1200, 1600]:
            page = browser.new_page(viewport={'width': width, 'height': 900})
            page.on('pageerror', lambda error: result['errors'].append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/o/studio')
            page.locator('.shell-header-actions > button > .eye-count').first.wait_for()
            for counts in [['1', '26', '999'], ['26', '17', '999+']]:
                measurement = page.evaluate('''counts => {
                  const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom} }
                  const overlap = (a,b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
                  const buttons = [...document.querySelectorAll('.shell-header button')];
                  const badges = [...document.querySelectorAll('.shell-header-actions > button > .eye-count')];
                  if (badges.length !== 3) throw Error('fixture must mount all three badges');
                  return badges.map((badge,i) => {
                    badge.textContent = counts[i];
                    const box = rect(badge), range = document.createRange(); range.selectNodeContents(badge);
                    const text = rect({getBoundingClientRect: () => range.getBoundingClientRect()});
                    const covered = buttons.filter(b => b !== badge.parentElement && overlap(box,rect(b))).map(b => b.title || b.className);
                    return {count:counts[i], box, text, covered, fits:box.left >= 0 && box.right <= innerWidth && box.top >= 0 && text.left >= box.left && text.right <= box.right};
                  });
                }''', counts)
                result['header'].append({'width': width, 'badges': measurement})
                assert all(b['fits'] and not b['covered'] for b in measurement), measurement
            page.screenshot(path=str(OUT / f'header-{width}.png'), clip={'x': 0, 'y': 0, 'width': width, 'height': 60})
            page.close()

            page = browser.new_page(viewport={'width': width, 'height': 900})
            page.on('pageerror', lambda error: result['errors'].append(str(error)))
            page.goto((OUT / 'attention' / 'probe.html').as_uri() + '#attention')
            toggle = page.locator('.attn-agents-toggle')
            toggle.wait_for()
            toggle.hover()
            assert toggle.get_attribute('aria-expanded') == 'false'
            toggle.click()
            page.locator('.attn-agents-wrap.list-open .attn-agents').wait_for()
            page.wait_for_timeout(200)
            measurement = page.evaluate('''() => {
              const button = document.querySelector('.attn-agents-toggle'), input = document.querySelector('.attn-agents input');
              const b = button.getBoundingClientRect(), f = input.getBoundingClientRect();
              // Rounded corners deliberately do not hit the button. Test the
              // centre of each border, including the formerly covered right edge.
              const cx = b.left+b.width/2, cy = b.top+b.height/2;
              const points = [[cx,b.top+1],[b.right-1,cy],[cx,b.bottom-1],[b.left+1,cy],[cx,cy]];
              return {button:{left:b.left,right:b.right,top:b.top,bottom:b.bottom}, filter:{left:f.left,right:f.right}, clickable:points.every(([x,y]) => button.contains(document.elementFromPoint(x,y))), scrimOpacity:getComputedStyle(document.querySelector('.attn-agents-scrim')).opacity};
            }''')
            result['drawer'].append({'width': width, **measurement})
            assert measurement['button']['right'] <= measurement['filter']['left'], measurement
            assert measurement['clickable'] and measurement['scrimOpacity'] == '1', measurement
            toggle.click()
            assert toggle.get_attribute('aria-expanded') == 'false'
            page.close()
        assert not result['errors'], result['errors']
        browser.close()
finally:
    server.shutdown()
    provenance.write_result(OUT / 'geometry.json', result)
print(json.dumps(result, indent=2))
