"""Exercise Focus with a real Canvas/Attention registry and a long synthetic chat."""
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
subprocess.run(['node', str(HERE / 'attentionlayout_build.mjs'), str(OUT / 'build'),
                'focus-menu-probe.tsx'], check=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
    functools.partial(Handler, directory=str(OUT / 'build')))
threading.Thread(target=server.serve_forever, daemon=True).start()
result = {'errors': [], 'provenance': str(provenance), 'focus': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge')
        page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.set_default_timeout(15000)
        page.on('pageerror', lambda e: result['errors'].append(str(e)))
        scene = '#app' if len(sys.argv) > 2 and sys.argv[2] == 'app' else ''
        page.goto(f'http://127.0.0.1:{server.server_port}/probe.html' + scene)
        page.wait_for_timeout(2200)
        try:
            page.locator('[data-first-use-agent="alpha"]').click()
        except Exception:
            result['startupBody'] = page.locator('body').inner_text()
            page.screenshot(path=str(OUT / 'startup-failure.png'))
            raise
        page.wait_for_selector('[data-first-use-agent="alpha"].desk .cc-composer')
        page.wait_for_timeout(2000)
        result['camera'] = page.locator('.space').get_attribute('style')
        result['canvasMessages'] = page.locator('[data-first-use-agent="alpha"].desk').inner_text().count('Message ')
        page.evaluate("window.changeView('attention')")
        page.wait_for_timeout(400)
        result['attentionOwnsDesk'] = page.locator('.attn-desk .cc-composer').count() == 1
        # Even old code's placeholder must leave the drawer's Focus usable.
        for agent in ['beta', 'alpha', 'beta', 'beta']:
            toggle = page.locator('.attn-agents-toggle')
            if toggle.get_attribute('aria-expanded') != 'true':
                toggle.click()
            page.locator(f'[data-attn-agent="{agent}"]').click(button='right')
            page.get_by_role('menuitem', name='Focus', exact=True).click()
            page.wait_for_timeout(300)
            result['focus'].append({'agent': agent,
                'selected': page.locator('[data-attn-agent][aria-selected="true"]').get_attribute('data-attn-agent'),
                'desk': page.locator('.attn-desk .cc-composer').count(),
                'heartbeat': page.evaluate('1 + 1')})
        page.screenshot(path=str(OUT / 'attention-focus.png'))
        page.locator('.attn-agents-toggle[aria-expanded="true"]').click()
        page.locator('.attn-desk .cc-head-left').click(button='right')
        page.get_by_role('menuitem', name='Focus', exact=True).click()
        result['headerFocusHeartbeat'] = page.evaluate('1 + 1')
        page.locator('.attn-desk .cc-head-left').click(button='right')
        page.get_by_role('menuitem', name='Open desk', exact=True).click()
        page.wait_for_selector('.tempdesk-panel .cc-composer')
        result['temporaryDesk'] = page.locator('.tempdesk-panel .cc-composer').count()
        page.keyboard.press('Escape')
        result['temporaryHeartbeat'] = page.evaluate('1 + 1')
        page.evaluate("window.changeView('canvas')")
        page.wait_for_selector('[data-first-use-agent="alpha"].desk .cc-composer')
        result['cameraAfter'] = page.locator('.space').get_attribute('style')
        browser.close()
finally:
    server.shutdown()
    (OUT / 'measurements.json').write_text(json.dumps(result, indent=2), encoding='utf-8')

assert result['canvasMessages'] > 0, 'positive control: long transcript really loaded'
assert not result['errors'], result['errors']
assert result['camera'] == result['cameraAfter'], 'Focus moved the hidden Canvas camera'
assert all(x['selected'] == x['agent'] and x['heartbeat'] == 2 for x in result['focus']), result
print(json.dumps(result, indent=2))
print('PASS: real Edge Focus remains responsive with a long transcript and a zoomed Canvas desk')
