from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import threading, json
from playwright.sync_api import sync_playwright
root = Path('node_modules/.agentgallery-fixture.js').resolve().parents[1]
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(root), **k)
    def do_GET(self):
        if '.' not in self.path.rsplit('/', 1)[-1]: self.path = '/tests/agentgallery-fixture.html'
        super().do_GET()
    def log_message(self, *a): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
(root / 'tests').mkdir(exist_ok=True)
(root / 'tests/agentgallery-fixture.html').write_text('<link rel="stylesheet" href="/src/styles.css"><div id="root"></div><script type="module" src="/node_modules/.agentgallery-fixture.js"></script>', encoding='utf8')
out = {'url': f'http://127.0.0.1:{port}/o/fixture', 'cases': [], 'errors': []}
try:
  with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for pinned in (False, True):
      page = browser.new_page(viewport={'width': 4000, 'height': 3000})
      page.on('pageerror', lambda e: out['errors'].append(str(e)))
      page.set_default_timeout(5000)
      if pinned:
        page.add_init_script("localStorage.setItem('orgtree-pins-fixture', JSON.stringify([{id:'alpha',rect:{x:40,y:40,w:400,h:300},z:0,snap:null}]))")
      page.goto(out['url']); page.wait_for_timeout(1200)
      b = page.locator('button.presentedbtn').first
      if not b.count():
        page.close()
        raise AssertionError(f'presentedbtn absent for pinned={pinned}: {page.locator("body").inner_text()[:500]}')
      b.wait_for(timeout=5000)
      geom = page.evaluate("""() => { const b=document.querySelector('.presentedbtn'), row=document.querySelector('.sq-actions'), card=b.closest('.sq'); const x=b.getBoundingClientRect(), r=row.getBoundingClientRect(), k=card.getBoundingClientRect(), c=getComputedStyle(b); const siblings=[...row.querySelectorAll('button')].map(e=>{const q=e.getBoundingClientRect();return {class:e.className,top:q.top,height:q.height,center:q.top+q.height/2,left:q.left,right:q.right}}); return {borderWidth:c.borderWidth,borderStyle:c.borderStyle,padding:c.padding,button:{top:x.top,height:x.height,center:x.top+x.height/2,left:x.left,right:x.right},row:{top:r.top,height:r.height,left:r.left,right:r.right,scrollWidth:row.scrollWidth},card:{top:k.top,height:k.height,left:k.left,right:k.right},siblings,lines:[...new Set(siblings.map(e=>e.top))].length}; }""")
      if pinned and not page.locator('.pinwin[data-id="alpha"]').count():
        raise AssertionError('pinned fixture did not mount a real alpha desk')
      b = page.locator('button.presentedbtn').first
      try:
        b.click(timeout=3000); page.wait_for_timeout(700)
        outcome = {'modal': page.locator('.modalpin-win').count(), 'agent': page.locator('[aria-label="presented documents for alpha"]').count(), 'body': 'Alpha plan' in page.locator('body').inner_text()}
      except Exception as exc:
        raise AssertionError(f'presentedbtn click failed for pinned={pinned}: {exc}') from exc
      outcome['gallery_agent'] = page.locator('.gallery-agent').count()
      outcome['classes'] = page.locator('[aria-label="presented documents for alpha"]').evaluate_all('els => els.map(e => e.className)')
      if 'error' not in outcome:
        if outcome['gallery_agent'] != 1 or not outcome['body']:
          raise AssertionError(f'agent gallery modal missing content: {outcome}')
      if geom['borderWidth'] != '0px' or geom['borderStyle'] != 'none' or geom['padding'] != '0px':
        raise AssertionError(f'presentation shortcut chrome changed: {geom}')
      if geom['lines'] != 1 or any(abs(e['center'] - geom['button']['center']) > 0.5 for e in geom['siblings']):
        raise AssertionError(f'presentation shortcut is not aligned with its action row: {geom}')
      out['cases'].append({'pinned': pinned, **outcome, 'pinwin': page.locator('.pinwin[data-id="alpha"]').count(), 'geometry': geom})
      page.screenshot(path=f'agentgallery-{"pinned"}.png', full_page=True)
      page.close()
    browser.close()
finally: server.shutdown()
if out['errors']:
  raise AssertionError(f'page errors: {out["errors"]}')
Path('agentgallery-browser-result.json').write_text(json.dumps(out, indent=2), encoding='utf8')
print(json.dumps(out, indent=2))
