import functools,http.server,json,threading
from pathlib import Path
from playwright.sync_api import sync_playwright
# Idiom coverage only; this copied-handler fixture is not production wiring.
# Production behavior is checked by the built-App probe.
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-toggle'; OUT.mkdir(exist_ok=True)
class H(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*a): pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(H,directory=str(OUT))); t=threading.Thread(target=server.serve_forever); t.start()
try:
 with sync_playwright() as p:
  b=p.chromium.launch(channel='msedge'); page=b.new_page(viewport={'width':900,'height':700}); page.set_default_timeout(3000); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='domcontentloaded')
  page.locator('button').first.wait_for()
  result=[]
  for kind in ['usage','defaults','git:fixture','common']:
   page.close(); page=b.new_page(viewport={'width':900,'height':700}); page.set_default_timeout(3000); page.on('pageerror',lambda e:errors.append(str(e))); page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='domcontentloaded'); page.locator('button').first.wait_for()
   opener=page.get_by_role('button',name=f'{kind} opener'); opener.click(); page.get_by_test_id(f'{kind}-body').wait_for()
   pin=page.locator(f'.settings:has([data-testid="{kind}-body"]) .modalpin-btn').first; pin.click(); page.wait_for_timeout(80)
   page.evaluate('(kind)=>window.movePinned(kind)',kind); page.wait_for_timeout(80)
   opener.click(); page.get_by_test_id(f'{kind}-body').wait_for(state='detached'); opener.click(); page.get_by_test_id(f'{kind}-body').wait_for()
   result.append({'kind':kind,'reopened':True,'pin_buttons':page.locator(f'[data-testid="{kind}-body"]').count()})
  page.screenshot(path=str(OUT/'toggle-open-close-open.png')); print(json.dumps({'result':result,'errors':errors},indent=2)); b.close()
finally: server.shutdown(); t.join(); server.server_close()
