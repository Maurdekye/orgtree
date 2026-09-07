"""Actual UsageModal/PinFrame browser layout; every API is local fixture data."""
import functools,http.server,json,threading
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-usagewrap'
assert (OUT/'usagewrap-fixture.js').is_file(),'INERT: build fixture first'

def account(key,label,pct=47):
 return dict(account=key,label=label,available=True,plan='Subscription with a descriptive plan name',limits=[dict(kind='session',group='fixture',percent=pct,severity='normal',resets_at='2027-09-07T08:00:00Z',is_active=False,model=None,label='A longer session usage label '+key*4)])
primary=account('primary','primary-'+('LongAccountLabel'*12)+'@example.test')
fallback=account('fallback-1','Fallback account');fallback['tiers']=[dict(tier=t,available=i%2==0,refresh_at='2027-09-07T08:00:00Z') for i,t in enumerate(['haiku','sonnet','opus','fable'])]
other=account('fallback-2','Another account with additional explanatory text');other['unsupported']=True;other['error']='Usage reporting is unavailable for this account. '+('LongExplanationWithoutSpaces'*8)
providers=[dict(id=i,label=i,status=dict(installed=True,connected=True),tiers=[]) for i in ['anthropic','openai','google','openrouter']]
DATA={'/api/providers':dict(providers=providers),'/api/accounts/usage':dict(accounts=[primary,fallback,other]),'/api/codex/usage':dict(account('codex','Codex account',82),provider='Codex'),'/api/antigravity/usage':dict(account('agy','Antigravity account',100),provider='Antigravity'),'/api/openrouter/usage':dict(account('openrouter','OpenRouter credit account',23),provider='OpenRouter')}
blocked=[];errors=[]
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,body,kind='application/json',status=200):
  data=body if isinstance(body,bytes) else json.dumps(body).encode()
  self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  path=urlsplit(self.path).path
  if path=='/':self.send(b'<!doctype html><link rel="stylesheet" href="/usagewrap-fixture.css"><div id="root"></div><script type="module" src="/usagewrap-fixture.js"></script>','text/html')
  elif path in DATA:self.send(DATA[path])
  elif path.startswith('/api/'):blocked.append(path);self.send({},status=404)
  else:super().do_GET()
 def do_POST(self):blocked.append(self.path);self.send({},status=405)
 do_PUT=do_POST
 do_PATCH=do_POST
 do_DELETE=do_POST
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(OUT)))
thread=threading.Thread(target=server.serve_forever);thread.start()
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge');context=browser.new_context(viewport=dict(width=1400,height=900));context.set_default_timeout(12000)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(f'http://127.0.0.1:{server.server_port}')
  page.wait_for_function('document.querySelectorAll(".usage-acct").length===6')
  results=[]
  def measure(owner,name,columns):
   owner.wait_for_timeout(200)
   panel=owner.locator('.usage-modal');grid=owner.locator('.usage-cards');cards=owner.locator('.usage-acct')
   bounds=cards.evaluate_all('es=>es.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,scroll:e.scrollWidth,client:e.clientWidth}))')
   actual=len({round(b['x'],1) for b in bounds});assert actual==columns,(name,actual,bounds)
   gb=grid.bounding_box();assert len(bounds)==6
   assert all(b['x']>=gb['x']-1 and b['x']+b['w']<=gb['x']+gb['width']+1 and b['scroll']<=b['client']+1 for b in bounds),(name,'card overflow',bounds,gb)
   pb=panel.bounding_box()
   assert gb['x']>=pb['x'] and gb['x']+gb['width']<=pb['x']+pb['width'],(name,'grid outside panel',gb,pb)
   assert cards.locator('.u-pct').count()==4,'positive real usage/control content'
   results.append(dict(scene=name,columns=actual,panel=panel.bounding_box(),cards=bounds))
   owner.screenshot(path=str(OUT/(name+'.png')))
  measure(page,'normal',1)
  page.evaluate('window.firstUsageCard=document.querySelector(".usage-acct")')
  page.get_by_role('button',name='pin this to the window',exact=True).click()
  for width,cols in [(1150,3),(440,1)]:
   page.evaluate('(w)=>usageProbe.resize("usage",{x:20,y:20,w,h:650})',width)
   measure(page,'pinned-'+str(width),cols)
  assert page.locator('.usage-modal').evaluate('e=>e.scrollHeight>e.clientHeight+100'),'INERT narrow scrolling fixture'
  with page.expect_popup() as pop:page.get_by_role('button',name='Open in new window',exact=True).click()
  child=pop.value;child.on('pageerror',lambda e:errors.append(str(e)))
  for width,cols in [(420,1),(1250,3),(1650,4)]:
   child.set_viewport_size(dict(width=width,height=880));measure(child,'child-'+str(width),cols)
  child.set_viewport_size(dict(width=420,height=640));measure(child,'child-short',1)
  done=child.get_by_role('button',name='done',exact=True);done.scroll_into_view_if_needed()
  pb=child.locator('.usage-modal').bounding_box();db=done.bounding_box();assert db['y']>=pb['y'] and db['y']+db['height']<=pb['y']+pb['height'],(pb,db)
  child.close();measure(page,'returned',1)
  assert page.evaluate('firstUsageCard===document.querySelector(".usage-acct")'),'native return remounted card'
  page.get_by_role('button',name='done',exact=True).click();assert page.get_by_text('Usage closed',exact=True).is_visible()
  assert not errors and not blocked,(errors,blocked)
  browser.close();print(json.dumps(dict(passed=results,blocked=blocked),indent=2))
finally:server.shutdown();thread.join();server.server_close()
