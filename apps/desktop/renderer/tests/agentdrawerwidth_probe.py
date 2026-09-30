"""Real renderer drawer width regression, with a synthetic hierarchical org."""
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
                'agentdrawerwidth-probe.tsx'], check=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
    functools.partial(Handler, directory=str(OUT / 'build')))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}/probe.html'
MEASURE = """root => {
  const host = document.querySelector(root);
  const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right}};
  return [...host.querySelectorAll('.tray-row')].map(row => {
    const name=row.querySelector('.tray-name'),status=row.querySelector('.tray-status'),sum=row.querySelector('.tray-sum');
    const s=getComputedStyle(row);
    return {id:name.textContent,row:rect(row),name:rect(name),nameScroll:name.scrollWidth,
      tier:rect(row.querySelector('.tier')),status:status?rect(status):null,
      statusText:status?.textContent,summary:sum?.textContent,
      font:s.fontSize,padding:s.padding,summaryFont:sum?getComputedStyle(sum).fontSize:null};
  });
}"""
result = {'errors': [], 'provenance': str(provenance)}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge')
        page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: result['errors'].append(str(e)))
        page.goto(URL + '#attention')
        page.get_by_role('button', name='Open the agents list', exact=True).click()
        page.wait_for_timeout(250)
        result['drawer'] = page.evaluate(MEASURE, '.attn-agents')
        result['bounds'] = page.locator('.attn-agents-wrap').bounding_box()
        result['filter'] = page.locator('.attn-agents .tray-filter').bounding_box()
        result['toggle'] = page.locator('.attn-agents-toggle').bounding_box()
        page.screenshot(path=str(OUT / 'attention.png'))
        # Rows in the reclaimed space remain clickable; the rail cannot cover them.
        child = page.locator('[data-attn-agent="p03-ws1-pgservice"]')
        child.click(position={'x': 2, 'y': 8})
        result['childSelected'] = child.get_attribute('aria-selected')
        # Resize while open: the measured rail follows zoom/font changes.
        page.locator('.attn-agents-toggle').evaluate("e => e.style.width='50px'")
        page.wait_for_timeout(100)
        result['wideToggleFilter'] = page.locator('.attn-agents .tray-filter').bounding_box()
        result['wideToggle'] = page.locator('.attn-agents-toggle').bounding_box()
        page.get_by_role('button', name='Close the agents list', exact=True).click()
        result['closed'] = page.locator('.attn-agents-wrap').get_attribute('class')
        page.goto(URL + '#canvas')
        page.reload()
        page.locator('.tray-toggle').click()
        page.wait_for_selector('.tray-wrap .tray-row')
        result['canvas'] = page.evaluate(MEASURE, '.tray-wrap')
        page.screenshot(path=str(OUT / 'canvas.png'))
        page.goto(URL + '#pinned')
        page.reload()
        page.wait_for_selector('.pinwin .desk-body')
        result['pinned'] = page.locator('.pinwin').evaluate("e => {const r=e.getBoundingClientRect(); const h=e.querySelector('.desk-body'); return {width:r.width,height:r.height,bodyFont:getComputedStyle(h).fontSize,text:h.textContent}}")
        page.screenshot(path=str(OUT / 'pinned.png'))
        browser.close()
finally:
    server.shutdown()
    (OUT / 'measurements.json').write_text(json.dumps(result, indent=2), encoding='utf-8')

rows = result['drawer']
assert len(rows) == 4, rows
assert rows[0]['row']['x'] <= result['bounds']['x'] + 5, 'rows still waste the toggle rail'
assert [r['tier']['x'] - rows[0]['tier']['x'] for r in rows[:3]] == [0, 14, 28], rows
assert result['filter']['x'] >= result['toggle']['x'] + result['toggle']['width'], result
assert result['wideToggleFilter']['x'] >= result['wideToggle']['x'] + result['wideToggle']['width'], result
assert result['childSelected'] == 'true', result
assert 'list-open' not in result['closed'], result
assert not result['errors'], result['errors']
print('PASS: rail reclaimed; hierarchy, filter clearance, resize, row click, collapse, Canvas and pin measured')
