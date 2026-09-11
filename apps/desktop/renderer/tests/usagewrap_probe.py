"""Actual UsageModal/PinFrame browser layout; every API is local fixture data."""
import functools,http.server,json,threading
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-usagewrap'
assert (OUT/'usagewrap-fixture.js').is_file(),'INERT: build fixture first'

# ⚠ SERVE WHAT THE MODAL ACTUALLY READS. This fixture drifted once: the
# modal moved to /api/usage plus the account registry (2026-09-10) while
# this file went on answering the old combined route, so the probe sat
# waiting for six cards in front of a modal showing four cards and two
# failures. A route the modal asks for and this file does not know lands in
# `blocked`, which is asserted empty at the end — that is the guard.
# The reading is stamped SEVEN MINUTES OLD so the age line has a real
# elapsed value to render rather than "0s".
stamp=(datetime.now(timezone.utc)-timedelta(minutes=7)).isoformat().replace('+00:00','Z')
def limits(key,pct):
 return [dict(kind='session',group='fixture',percent=pct,severity='normal',resets_at='2027-09-07T08:00:00Z',is_active=False,model=None,label='A longer session usage label '+key*4)]
def account(key,label,pct=47):
 return dict(account=key,label=label,available=True,observed_at=stamp,plan='Subscription with a descriptive plan name',limits=limits(key,pct))
def row(rid,label,email,ambient=False):
 return dict(id=rid,provider='claude',harness='claude-code',label=label,credential=dict(kind='managed',path='C:/data/profiles/'+rid),identity=dict(email=email),auth='authenticated',tint_ordinal=2,ambient=ambient,standing=dict(auth='authenticated',state='ready',marks={}),bound=[])
# the PRIMARY lane: /api/usage, whose identity is an email long enough to
# wrap at the narrow width the user's screenshot was taken at
primary=dict(available=True,observed_at=stamp,plan='Subscription with a descriptive plan name',email='primary-'+('LongAccountLabel'*12)+'@example.test',limits=limits('primary',65))
# two REGISTERED accounts, one answering with tier standings and one that
# cannot report usage at all — the two branches that render no bars
fallback=account('claude-4','Fallback account');fallback['tiers']=[dict(tier=t,available=i%2==0,refresh_at='2027-09-07T08:00:00Z') for i,t in enumerate(['haiku','sonnet','opus','fable'])]
other=account('claude-9','Another account with additional explanatory text');other['unsupported']=True;other['error']='Usage reporting is unavailable for this account. '+('LongExplanationWithoutSpaces'*8)
REGISTRY=dict(primary='claude-1',accounts=[row('claude-1','claude (machine login)','primary@example.test',True),row('claude-4','claude-0-'+('LongManagedProfileLabel'*2),'second.account.with.a.long.address@example.test'),row('claude-9','claude-9','third@example.test')])
providers=[dict(id=i,label=i,status=dict(installed=True,connected=True),tiers=[]) for i in ['anthropic','openai','google','openrouter']]
DATA={'/api/providers':dict(providers=providers),'/api/usage':primary,'/api/accounts':REGISTRY,'/api/accounts/claude-4/usage':fallback,'/api/accounts/claude-9/usage':other,'/api/codex/usage':dict(account('codex','Codex account',82),provider='Codex'),'/api/antigravity/usage':dict(account('agy','Antigravity account',100),provider='Antigravity'),'/api/openrouter/usage':dict(account('openrouter','OpenRouter credit account',23),provider='OpenRouter')}
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
   # THE HEAD (user screenshot 2026-09-11). Two cards in one modal sat
   # differently: a short identity kept its refresh button and time on one
   # row, a long one wrapped and left the time stranded under the button.
   # Every card is measured, so "they match" cannot be true of a pair and
   # false of the card below it.
   heads=cards.evaluate_all('''es=>es.map(e=>{const r=x=>x&&x.getBoundingClientRect();const h=e.querySelector('.usage-acct-head');const s=h.querySelector('.usage-updated');return {card:r(e),head:r(h),who:r(h.querySelector('.usage-acct-who')),line:r(h.querySelector('.usage-refresh-line')),btn:r(h.querySelector('.usage-refresh-button')),stamp:r(s),text:s&&s.textContent.trim()}})''')
   assert len(heads)==6 and all(h['stamp'] and h['line'] and h['who'] for h in heads),(name,'a card head is missing a part',heads)
   for i,h in enumerate(heads):
    assert h['text'] and h['text'].startswith('updated ') and h['text'].endswith(' ago') and ':' not in h['text'],(name,i,'not an elapsed age',h['text'])
    assert h['stamp']['x']>=h['btn']['x']+h['btn']['width']-1,(name,i,'the age wrapped under its button',h)
    assert abs((h['stamp']['y']+h['stamp']['height']/2)-(h['btn']['y']+h['btn']['height']/2))<=2,(name,i,'the age and its button are not on one row',h)
    assert h['line']['x']>=h['who']['x']+h['who']['width']-1,(name,i,'the control sits over the identity',h)
    assert abs(h['line']['y']-h['head']['y'])<=1,(name,i,'the control is not at the top of its head',h)
    assert h['line']['x']+h['line']['width']<=h['card']['x']+h['card']['width']+1,(name,i,'the control is outside its card',h)
   assert len({h['text'] for h in heads})==1,(name,'cards disagree about how old the same fixture reading is',[h['text'] for h in heads])
   assert len({round(h['card']['x']+h['card']['width']-(h['line']['x']+h['line']['width']),1) for h in heads})==1,(name,'cards right-align their refresh controls differently',heads)
   assert len({round(h['line']['y']-h['head']['y'],1) for h in heads})==1,(name,'cards place the control at different heights',heads)
   results.append(dict(scene=name,columns=actual,panel=panel.bounding_box(),cards=bounds))
   owner.screenshot(path=str(OUT/(name+'.png')))
  measure(page,'normal',1)
  # the exact age of the fixture's reading, read once while it is still
  # young: later scenes only require every card to agree, because the
  # probe itself takes long enough for a real minute to pass
  assert page.locator('.usage-updated').first.text_content().strip()=='updated 7m ago',page.locator('.usage-updated').first.text_content()
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
  # the bottom of the list is still reachable in a short window and stays
  # inside the frame. This used to check a 'done' button in the modal's
  # own footer; the surface lost that footer to PinFrame's title bar, so
  # the check moved to the last thing the panel scrolls to.
  last=child.locator('.usage-acct').last;last.scroll_into_view_if_needed()
  pb=child.locator('.usage-modal').bounding_box();db=last.bounding_box();assert db['y']>=pb['y']-1 and db['y']+db['height']<=pb['y']+pb['height']+1,(pb,db)
  child.close();measure(page,'returned',1)
  assert page.evaluate('firstUsageCard===document.querySelector(".usage-acct")'),'native return remounted card'
  # and the way out of a PINNED window is its own ×, not a footer button
  page.locator('.modalpin-x').click();page.get_by_text('Usage closed',exact=True).wait_for()
  assert not errors and not blocked,(errors,blocked)
  browser.close();print(json.dumps(dict(passed=results,blocked=blocked),indent=2))
finally:server.shutdown();thread.join();server.server_close()
