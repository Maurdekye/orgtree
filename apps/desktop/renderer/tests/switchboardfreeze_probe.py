"""Exercise a switchboard child window sharing a pinned Attention desk."""
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
subprocess.run(['node', str(HERE / 'attentionlayout_build.mjs'), str(OUT / 'page'), 'switchboardfreeze-probe.tsx'], check=True)
result = {'errors': [], 'tabs': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
        ctx.on('page', lambda page: page.on('pageerror', lambda error: result['errors'].append(str(error))))
        page = ctx.new_page()
        page.set_default_timeout(5000)
        page.goto((OUT / 'page' / 'probe.html').as_uri())
        page.locator('.attn-panel-desk textarea').wait_for()
        page.locator('.attn-panel-desk textarea').fill('keep this unsent draft')
        page.screenshot(path=str(OUT / 'before.png'))
        with page.expect_popup() as popup:
            page.locator('.switchboard-fixture .popout-button').click()
        child = popup.value
        child.set_default_timeout(5000)
        for agent in ['coordinator-opus', 'peer-a', 'peer-b']:
            child.locator('.eye-tab-main').filter(has_text=agent).click()
            child.locator('.eye-panel textarea').wait_for()
            child.locator('[data-heartbeat]').click()
            page.wait_for_timeout(250)
            result['tabs'].append({'agent': agent, **page.evaluate('window.probe')})
            child.screenshot(path=str(OUT / (agent + '.png')))
            child.locator('.eye-tab-main').filter(has_text=agent).click()
        assert not result['errors'], result['errors']
        assert result['tabs'][-1]['heartbeat'] == 3, result
        browser.close()
finally:
    provenance.write_result(OUT / 'result.json', result)
print(json.dumps(result, indent=2))
