"""Exercise the canvas switchboard sharing a pinned Attention desk."""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)

import json
import subprocess
import time
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.relative_to(REPO / 'artifacts')
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', str(HERE / 'attentionlayout_build.mjs'), str(OUT / 'page'), 'switchboardfreeze-probe.tsx'], check=True)
result = {'errors': [], 'tabs': []}
copied_messages = None
if len(sys.argv) > 2:
    copied_path = Path(sys.argv[2]).resolve()
    copied_path.relative_to(REPO / 'artifacts')
    copied_messages = json.loads(copied_path.read_text(encoding='utf-8'))
    result['copied_rows'] = len(copied_messages)
rows = len(copied_messages) if copied_messages is not None else 3000
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
        if copied_messages is not None:
            ctx.add_init_script('window.copiedMessages = ' + json.dumps(copied_messages, ensure_ascii=True))
        ctx.on('page', lambda page: page.on('pageerror', lambda error: result['errors'].append(str(error))))
        page = ctx.new_page()
        page.set_default_timeout(30000)
        page.goto((OUT / 'page' / 'probe.html').as_uri() + '?rows=3000#long-main')
        page.locator('.attn-panel-desk textarea').wait_for()
        page.locator('.attn-panel-desk textarea').fill('keep this unsent draft')
        page.wait_for_timeout(1200)
        started = time.monotonic()
        assert page.evaluate('window.probe.load()'), 'history load refused'
        page.wait_for_function('(rows) => window.probe.historyRows() >= rows', arg=rows)
        result['history_load_seconds'] = time.monotonic() - started
        result['loaded_rows'] = page.evaluate('window.probe.historyRows()')
        page.screenshot(path=str(OUT / 'before.png'))
        child = page
        for agent in ['coordinator-opus', 'peer-a', 'peer-b']:
            started = time.monotonic()
            child.locator('.eye-tab-main').filter(has_text=agent).click()
            child.locator('.eye-tab.on .eye-tab-main').filter(has_text=agent).wait_for()
            child.locator('[data-heartbeat]').click()
            page.wait_for_timeout(250)
            result['tabs'].append({'agent': agent, 'seconds': time.monotonic() - started,
                **page.evaluate('({commits:window.probe.commits,heartbeat:window.probe.heartbeat,requests:window.probe.requests,rows:window.probe.historyRows(),composers:document.querySelectorAll("textarea").length})')})
            child.screenshot(path=str(OUT / (agent + '.png')))
            child.locator('.eye-tab-main').filter(has_text=agent).click()
        assert not result['errors'], result['errors']
        assert result['tabs'][-1]['heartbeat'] == 3, result
        browser.close()
finally:
    provenance.write_result(OUT / 'result.json', result)
print(json.dumps(result, indent=2))
