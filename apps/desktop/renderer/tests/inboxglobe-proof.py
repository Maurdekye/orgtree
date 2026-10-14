"""Synthetic real-canvas before/after far-zoom captures; no live app or data."""
import json, os, pathlib
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(os.environ['INBOX_GLOBE_OUT'])
EVIDENCE = pathlib.Path(os.environ['INBOX_GLOBE_EVIDENCE'])
EVIDENCE.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        for phase in ['before', 'after']:
            for theme in ['dark', 'light']:
                case = phase + '-' + theme
                errors = []
                page = browser.new_page(viewport={'width': 1600, 'height': 1000})
                page.on('pageerror', lambda e: errors.append(str(e)))
                css = (OUT / (phase + '.css')).read_text(encoding='utf-8')
                html = f'''<!doctype html><html class="contrast-{theme}"><style>{css}</style>
                <body><div id="root"></div><script>window.proofZoom=.24;window.proofHide=false;
                window.proofRequests=[];</script></body></html>'''
                page.route('**/*', lambda r: r.fulfill(status=200, content_type='text/html', body=html)
                           if r.request.url == 'http://fixture.local/' else r.abort())
                page.goto('http://fixture.local/')
                page.add_script_tag(content=(OUT / (phase + '.js')).read_text(encoding='utf-8'))
                tile = page.locator('.orginbox-far')
                tile.wait_for()
                page.wait_for_timeout(500)
                measure = tile.evaluate('''e => ({title:e.title,aria:e.getAttribute('aria-label'),
                  box:e.getBoundingClientRect().toJSON(),icon:e.querySelector('svg')?.getAttribute('data-testid'),
                  glyph:e.querySelectorAll('.oi-far-icon').length,paths:e.querySelector('svg')?.innerHTML})''')
                page.screenshot(path=str(EVIDENCE / (case + '-far.png')))
                tile.screenshot(path=str(EVIDENCE / (case + '-tile.png')))
                tile.click()
                header = page.locator('h3 [data-testid="PublicIcon"]')
                header.wait_for()
                modal_paths = header.evaluate('e => e.innerHTML')
                page.screenshot(path=str(EVIDENCE / (case + '-modal.png')))
                expected = 'OutboxOutlinedIcon' if phase == 'before' else 'PublicIcon'
                bad = []
                if measure['icon'] != expected: bad.append('wrong icon: ' + str(measure['icon']))
                if (measure['paths'] == modal_paths) != (phase == 'after'): bad.append('SVG artwork parity/control failed')
                if measure['glyph'] != 1: bad.append('far sizing class missing')
                if measure['aria'] != 'org inbox': bad.append('aria changed')
                if measure['title'] != 'the org inbox — outside mail addressed to this organization': bad.append('title changed')
                if errors: bad.append('page errors: ' + str(errors))
                results.append({'case':case,'measurements':measure,'modal_paths':modal_paths,'bad':bad})
                page.close()
    finally:
        browser.close()
for theme in ['dark', 'light']:
    pair = [r for r in results if r['case'].endswith(theme)]
    if pair[0]['measurements']['box'] != pair[1]['measurements']['box']:
        pair[1]['bad'].append('tile geometry changed')
(EVIDENCE / 'result.json').write_text(json.dumps({'results':results,
    'passed':sum(not r['bad'] for r in results),'total':len(results)}, indent=2), encoding='utf-8')
assert len(results) == 4 and all(not r['bad'] for r in results), 'see result.json'
print('4/4 far-zoom before/after globe cases passed')
