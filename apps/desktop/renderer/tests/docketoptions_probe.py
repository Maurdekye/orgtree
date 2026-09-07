import functools,http.server,json,threading
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-docketoptions'
assert (OUT/'docketoptions-fixture.js').exists(),'INERT build fixture first'
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/':
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<!doctype html><link rel="stylesheet" href="/docketoptions-fixture.css"><div id="root"></div><script type="module" src="/docketoptions-fixture.js"></script>')
  else:super().do_GET()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(OUT)));thread=threading.Thread(target=server.serve_forever);thread.start()
errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge');context=browser.new_context(viewport=dict(width=1400,height=1000));context.set_default_timeout(7000)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(f'http://127.0.0.1:{server.server_port}')
  panel=page.locator('.docket-modal');panel.locator('.mailrow').first.wait_for()
  toggle=page.get_by_role('button',name='View options')
  assert not toggle.is_visible(),'wide should stay inline'
  group=page.get_by_label('Arrange',exact=True);sort=page.get_by_label('Sort',exact=True)
  options_group=page.get_by_role('group',name='Docket view options')
  assert options_group.count()==1,'options disclosure needs an accessible group label'
  group.select_option('status');sort.select_option('created')
  page.evaluate('window.savedGroup=document.querySelector("#docket-group")')
  page.evaluate('optionsProbe.pin()');toggle.wait_for()
  assert not group.is_visible(),'narrow controls must start collapsed'
  toggle.focus();page.keyboard.press('Enter');group.wait_for()
  assert toggle.get_attribute('aria-expanded')=='true'
  assert group.input_value()=='status' and sort.input_value()=='created'
  page.get_by_label('Show archived',exact=False).check();page.get_by_label('Show backlogged',exact=False).check()
  assert page.locator('.mailrow').count()==3,'filter actions must reveal archived and backlog'
  page.keyboard.press('Escape');group.wait_for(state='hidden');assert panel.count()==1,'Escape closed docket instead of options'
  assert toggle.evaluate('e=>e.ownerDocument.activeElement===e'),'Escape focus must return to toggle'
  toggle.press('Space');group.wait_for()
  for width,height in [(360,300),(600,650)]:
   page.evaluate('([w,h])=>optionsProbe.size(w,h)',[width,height]);page.wait_for_timeout(80)
   bounds=panel.bounding_box();menu=page.locator('.docket-options').bounding_box()
   assert menu['x']>=bounds['x'] and menu['x']+menu['width']<=bounds['x']+bounds['width']+1,(bounds,menu)
   assert menu['height']<=181,'options menu exceeds the 180px height cap'
   assert page.locator('.docket-options').evaluate('e=>e.scrollWidth<=e.clientWidth+1'),'options overflow horizontally'
   sort.select_option('status');assert sort.input_value()=='status'
   results.append(dict(home='pinned',width=width,panel=bounds,menu=menu))
  page.screenshot(path=str(OUT/'narrow-pinned.png'))
  page.evaluate('optionsProbe.size(1100)');page.wait_for_timeout(80)
  assert not toggle.is_visible() and group.is_visible(),'wide restoration'
  assert page.evaluate('savedGroup===document.querySelector("#docket-group")'),'controls remounted on resize'
  assert page.get_by_label('Show archived',exact=False).is_checked() and page.get_by_label('Show backlogged',exact=False).is_checked()
  with page.expect_popup() as opened:panel.get_by_role('button',name='Open in new window',exact=True).click()
  child=opened.value;child.on('pageerror',lambda e:errors.append(str(e)))
  child.set_viewport_size(dict(width=500,height=700));child.get_by_role('button',name='View options').wait_for()
  child.wait_for_function('[...document.querySelectorAll("link[rel=stylesheet]")].every(e=>e.sheet)')
  assert child.get_by_label('Arrange',exact=True).input_value()=='status'
  child.get_by_role('button',name='View options').click();assert not child.get_by_label('Arrange',exact=True).is_visible()
  child.get_by_role('button',name='View options').click();child.get_by_label('Arrange',exact=True).select_option('agent')
  child.set_viewport_size(dict(width=1100,height=800));child.wait_for_timeout(80)
  assert not child.get_by_role('button',name='View options').is_visible() and child.get_by_label('Arrange',exact=True).is_visible()
  assert child.evaluate('opener.savedGroup===document.querySelector("#docket-group")')
  child.screenshot(path=str(OUT/'wide-child.png'));child.close();group.wait_for()
  assert group.input_value()=='agent' and sort.input_value()=='status'
  page.evaluate('optionsProbe.size(500)');toggle.wait_for();toggle.focus();page.keyboard.press('Escape')
  group.wait_for(state='hidden');assert panel.count()==1,'Escape closed docket instead of options'
  page.keyboard.press('Escape');assert panel.count()==1,'pinned Escape must not close its window'
  page.locator('.docket-header-close').click();page.get_by_text('Closed docket',exact=True).wait_for()
  # Normal unpinned modal follows a narrow main window too.
  page.evaluate('localStorage.removeItem("orgtree-modal-pins")')
  page.set_viewport_size(dict(width=600,height=800));page.reload();page.get_by_role('button',name='View options').wait_for()
  assert not page.get_by_label('Arrange',exact=True).is_visible()
  page.get_by_role('button',name='View options').press('Enter');page.get_by_label('Arrange',exact=True).wait_for()
  page.set_viewport_size(dict(width=1100,height=800));page.wait_for_timeout(100)
  assert not page.get_by_role('button',name='View options').is_visible()
  assert page.get_by_label('Arrange',exact=True).is_visible()
  page.keyboard.press('Escape');page.get_by_text('Closed docket',exact=True).wait_for()
  # Reopen the centered control for the existing narrow Escape regression.
  page.set_viewport_size(dict(width=600,height=800))
  page.reload();page.get_by_role('button',name='View options').wait_for()
  page.get_by_role('button',name='View options').press('Enter');page.get_by_label('Arrange',exact=True).wait_for()
  page.keyboard.press('Escape');page.get_by_label('Arrange',exact=True).wait_for(state='hidden')
  assert page.locator('.docket-modal').count()==1,'centered Escape closed docket before options'
  page.keyboard.press('Escape');page.get_by_text('Closed docket',exact=True).wait_for()
  assert not errors,errors
  browser.close();print(json.dumps(dict(results=results,keyboard=True,same_dom=True,values=True,errors=errors),indent=2))
finally:server.shutdown();thread.join();server.server_close()
