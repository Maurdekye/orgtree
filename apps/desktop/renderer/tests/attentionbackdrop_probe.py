"""Measure the Attention backdrop text in the application's CSS cascade."""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)

import json
import subprocess
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.relative_to(REPO / 'artifacts')
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', str(HERE / 'attentionlayout_build.mjs'), str(OUT / 'build')], check=True)
result = {'errors': [], 'sizes': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page()
        page.on('pageerror', lambda error: result['errors'].append(str(error)))
        page.goto((OUT / 'build' / 'probe.html').as_uri() + '#attention-both-pinned')
        page.locator('.attn-backdrop-message').wait_for()
        for width, height in [(1600, 900), (1000, 700)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(100)
            measured = page.locator('.attn-backdrop-message').evaluate("""e => {
                const box = e.parentElement.getBoundingClientRect();
                const lines = [...e.querySelectorAll('p')].map(p => p.getBoundingClientRect());
                const top = lines[0].top, bottom = lines.at(-1).bottom;
                return {text: e.textContent, xError: Math.max(...lines.map(r => Math.abs((r.left+r.right)/2-(box.left+box.right)/2))),
                    yError: Math.abs((top+bottom)/2-(box.top+box.bottom)/2),
                    color: getComputedStyle(e).color,
                    pins: document.querySelectorAll('.attn-panel.modalpin-win').length};
            }""")
            result['sizes'].append({'width': width, 'height': height, **measured})
            assert measured['xError'] <= 1 and measured['yError'] <= 1, measured
            assert measured['pins'] == 2, measured
            page.screenshot(path=str(OUT / f'backdrop-{width}.png'))
        page.evaluate('window.returnAttentionQueue()')
        page.wait_for_selector('.attn-backdrop-message', state='detached')
        assert page.locator('.attn-panel-queue').count() == 1
        result['returned_queue_removes_message'] = True
        assert not result['errors'], result['errors']
        browser.close()
finally:
    provenance.write_result(OUT / 'result.json', result)
print(json.dumps(result, indent=2))
