import functools,http.server,json,threading
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-windowchrome'
assert (OUT/'windowchrome-fixture.js').exists(),'INERT missing bundle'
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/':
   data=b'<!doctype html><link rel="stylesheet" href="/windowchrome-fixture.css"><div id="root"></div><script type="module" src="/windowchrome-fixture.js"></script>'
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(data)
  else:super().do_GET()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(OUT)))
thread=threading.Thread(target=server.serve_forever);thread.start()
errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge');context=browser.new_context(viewport=dict(width=1400,height=900));context.set_default_timeout(10000)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(f'http://127.0.0.1:{server.server_port}')
  page.locator('.test-beta').wait_for();page.locator('.test-beta').get_by_role('button',name='Done beta').click()
  page.evaluate('chromeProbe.pin()');panel=page.locator('.test-alpha');panel.locator('input').fill('same draft')
  page.evaluate('window.draftNode=document.querySelector(".test-alpha input")')
  def corners(agent=False):
   selector='.pinwin' if agent else '.test-alpha';handle='.pinwin-rs' if agent else '.modalpin-rs'
   for edge in ['nw','ne','sw','se']:
    page.evaluate('(agent)=>chromeProbe.reset(agent)',agent);page.wait_for_timeout(70)
    box=page.locator(selector);box.evaluate('e=>e.scrollTop=e.scrollHeight')
    b=box.bounding_box();x=b['x']+(-6 if 'w' in edge else b['width']+6);y=b['y']+(-6 if 'n' in edge else b['height']+6)
    hit=page.evaluate('([x,y])=>document.elementFromPoint(x,y)?.className',[x,y]);assert handle[1:] in str(hit),(agent,edge,'corner unreachable',hit,b)
    dx=-55 if 'w' in edge else 55;dy=-35 if 'n' in edge else 35
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y+dy,steps=8);page.mouse.up();page.wait_for_timeout(70)
    after=box.bounding_box();expected=dict(x=b['x']+(dx if 'w' in edge else 0),y=b['y']+(dy if 'n' in edge else 0),width=b['width']+55,height=b['height']+35)
    assert all(abs(after[k]-v)<2 for k,v in expected.items()),(agent,edge,b,after,expected)
    results.append(dict(agent=agent,edge=edge,before=b,after=after))
  corners()
  page.evaluate('chromeProbe.reset()');panel.evaluate('e=>e.scrollTop=0')
  page.wait_for_timeout(100);b=panel.bounding_box();page.mouse.move(b['x']+180,b['y']+18);page.mouse.down();page.mouse.move(b['x']+220,b['y']+48,steps=6);page.mouse.up();page.wait_for_timeout(70)
  moved=panel.bounding_box();assert abs(moved['x']-b['x']-40)<2 and abs(moved['y']-b['y']-30)<2,'modal title drag blocked'
  page.get_by_role('button',name='unpin this window',exact=True).click();assert not panel.evaluate('e=>e.classList.contains("modalpin-win")')
  page.get_by_role('button',name='pin this to the window',exact=True).click();assert panel.locator('input').input_value()=='same draft'
  marker=page.locator('#flow-marker').bounding_box()
  with page.expect_popup() as opened:panel.get_by_role('button',name='Open in new window',exact=True).click()
  child=opened.value;child.on('pageerror',lambda e:errors.append(str(e)))
  notice=page.locator('.popout-notices .popout-placeholder');notice.wait_for();b=notice.bounding_box()
  assert b['height']<55 and b['width']<600 and b['x']==12 and abs(b['y']+b['height']-888)<2,('notice position',b)
  assert page.locator('#flow-marker').bounding_box()==marker
  assert page.locator('.movable-anchor').evaluate_all('es=>es.every(e=>e.getBoundingClientRect().height===0)')
  page.evaluate('window.focusCalls=0');child.evaluate('window.focus=()=>{opener.focusCalls++}')
  notice.get_by_role('button',name='Show window').click();assert page.evaluate('focusCalls')>=1,('show action inert',page.evaluate('focusCalls'))
  child.get_by_label('Draft alpha').fill('child edit')
  page.screenshot(path=str(OUT/'compact-notice.png'))
  notice.get_by_role('button',name='Return here').click();page.wait_for_timeout(150)
  assert page.evaluate('draftNode===document.querySelector(".test-alpha input")') and panel.locator('input').input_value()=='child edit'
  assert page.locator('.popout-placeholder').count()==0
  # Two different surfaces: notices share one stack and native close removes only its own.
  page.evaluate('localStorage.clear()');page.reload();page.locator('.test-beta').wait_for()
  children=[]
  for name in ['beta','alpha']:
   with page.expect_popup() as opened:page.locator('.test-'+name).get_by_role('button',name='Open in new window',exact=True).click()
   children.append(opened.value)
  page.wait_for_timeout(200);assert page.locator('.popout-notices').count()==1
  notices=page.locator('.popout-placeholder');assert notices.count()==2
  a,b=[notices.nth(i).bounding_box() for i in range(2)];assert a['y']+a['height']<=b['y'],(a,b)
  children[0].close();page.wait_for_timeout(150);assert notices.count()==1
  children[1].close();page.wait_for_timeout(150);assert notices.count()==0
  assert page.locator('.popout-notices').count()==0,'orphan notice host after final close'
  with page.expect_popup() as reopened:page.locator('.test-beta').get_by_role('button',name='Open in new window',exact=True).click()
  page.locator('.popout-notices .popout-placeholder').wait_for();assert page.locator('.popout-notices').count()==1,'notice host not recreated'
  reopened.value.close();page.wait_for_timeout(150);assert page.locator('.popout-notices').count()==0
  # Front-window corners intentionally own a narrow band outside that frame.
  # Record the overlap tradeoff and prove the back window still accepts its
  # own title/control actions away from the front window's resize band.
  page.evaluate('chromeProbe.pinAt("alpha",{x:300,y:180,w:600,h:460});chromeProbe.pinAt("beta",{x:800,y:400,w:600,h:460})')
  page.wait_for_timeout(100)
  overlap=page.evaluate('() => {const e=document.elementFromPoint(794,394);return {class:e?.className,owner:e?.closest(".overlay")?.querySelector("h3")?.textContent}}')
  assert overlap=={'class':'modalpin-rs nw','owner':'beta'},('front resize overlap priority',overlap)
  alpha=page.locator('.test-alpha').bounding_box()
  page.mouse.move(794,394);page.mouse.down();page.mouse.move(764,374,steps=6);page.mouse.up();page.wait_for_timeout(70)
  beta=page.locator('.test-beta').bounding_box();assert beta==dict(x=770,y=380,width=630,height=480),('outer band drag',beta)
  assert page.locator('.test-alpha').bounding_box()==alpha,'front corner moved back window'
  page.locator('.test-alpha .modalpin-name').click();page.wait_for_timeout(100)
  front=page.evaluate('document.elementFromPoint(794,394)?.closest(".overlay")?.querySelector("h3")?.textContent')
  assert front=='alpha','back titlebar failed to raise its window'
  page.locator('.test-beta').get_by_role('button',name='close this window',exact=True).click();assert page.locator('.test-beta').count()==0 and page.locator('.test-alpha').count()==1,'overlap close control failed'
  page.evaluate('chromeProbe.agent()');page.locator('.pinwin').wait_for();page.wait_for_timeout(350)
  corners(True)
  win=page.locator('.pinwin');names=win.locator('.cc-head-left > .cc-name');assert names.count()==1,'INERT missing inner identity'
  assert not names.is_visible() and win.locator('.pinwin-name').is_visible(),'duplicate identity'
  assert win.locator('.cc-context-seat').is_visible() and win.locator('.cc-head-right').is_visible(),'status/actions lost'
  page.evaluate('chromeProbe.reset(true)');page.wait_for_timeout(100)
  b=win.bounding_box();page.mouse.move(b['x']+230,b['y']+14);page.mouse.down();page.mouse.move(b['x']+270,b['y']+44,steps=6);page.mouse.up();page.wait_for_timeout(70)
  moved=win.bounding_box();assert abs(moved['x']-b['x']-40)<2 and abs(moved['y']-b['y']-30)<2,'agent title drag blocked'
  win.locator('.pinwin-name').click();assert page.locator('#jumps').inner_text()=='1','name pointer action'
  win.locator('.pinwin-name').focus();page.keyboard.press('Enter');assert page.locator('#jumps').inner_text()=='2','name keyboard action'
  page.screenshot(path=str(OUT/'single-identity.png'))
  with page.expect_popup() as opened:win.get_by_role('button',name='Open in new window',exact=True).click()
  child=opened.value;child.wait_for_timeout(200);assert child.locator('.cc-head-left > .cc-name').is_visible(),'detached identity not restored'
  child.close();page.wait_for_timeout(150);assert not win.locator('.cc-head-left > .cc-name').is_visible()
  win.get_by_role('button',name='unpin builder',exact=True).click();assert page.locator('.pinwin').count()==0,'unpin control blocked'
  assert not errors,errors
  browser.close();print(json.dumps(dict(passed=results,notices='compact/actions/sameDOM/multiple/nativeclose',identity='single/pointer/keyboard/detach/return',errors=errors),indent=2))
finally:server.shutdown();thread.join();server.server_close()
