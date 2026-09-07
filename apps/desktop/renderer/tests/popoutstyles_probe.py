"""Real linked stylesheet lifecycle, isolated HTTP fixture, no backend or routing."""
import functools,http.server,json,threading
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path(__file__).resolve().parents[1]/'node_modules/.orgtree-popoutstyles'
control=dict(path=None,entered=threading.Event(),release=threading.Event(),error=False)
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path in ['/popoutstyles-fixture.css','/last.css']:
   if self.path==control['path']:
    control['entered'].set()
    assert control['release'].wait(15),'INERT held CSS not released'
    if control['error']:self.send_error(503);return
   data=(OUT/'popoutstyles-fixture.css').read_bytes()+b'.styles-scroll{width:750px;height:500px;overflow:auto}' if self.path.endswith('fixture.css') else b'.fixture-ready{color:inherit}'
   self.send_response(200);self.send_header('Content-Type','text/css');self.send_header('Cache-Control','no-store');self.end_headers()
   try:self.wfile.write(data)
   except (ConnectionAbortedError,ConnectionResetError,BrokenPipeError):pass
  elif self.path=='/':
   data=b'<!doctype html><link rel="stylesheet" href="/popoutstyles-fixture.css"><link rel="stylesheet" href="/last.css"><div id="root"></div><script type="module" src="/popoutstyles-fixture.js"></script>'
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(data)
  else:super().do_GET()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(OUT)))
thread=threading.Thread(target=server.serve_forever);thread.start();errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge')
  for scene in ['ready','inline','delayed','wheel','keyboard','pointer','closed','error']:
   control.update(path=None,entered=threading.Event(),release=threading.Event(),error=scene=='error')
   context=browser.new_context(viewport=dict(width=1200,height=900));page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(f'http://127.0.0.1:{server.server_port}');page.get_by_label('Styles draft').fill('same draft '+scene)
   box=page.locator('.styles-scroll');box.evaluate('e=>{e.scrollTop=700;e.scrollLeft=350}')
   assert box.evaluate('e=>[e.scrollTop,e.scrollLeft]')==[700,350],'INERT pre-detach pan'
   page.evaluate('() => { window.savedBox=document.querySelector(".styles-scroll");window.savedInput=document.querySelector("input") }')
   if scene=='inline':page.evaluate('() => { for(const link of document.querySelectorAll("link[rel=stylesheet]")){const style=document.createElement("style");style.textContent=[...link.sheet.cssRules].map(r=>r.cssText).join(" ");link.replaceWith(style)} }')
   if scene not in ['ready','inline']:control['path']='/last.css' if scene in ['wheel','keyboard','pointer'] else '/popoutstyles-fixture.css'
   with page.expect_popup() as pop:page.get_by_role('button',name='Open in new window',exact=True).click()
   child=pop.value;child.on('pageerror',lambda e:errors.append(str(e)))
   if scene not in ['ready','inline']:assert control['entered'].wait(5),'INERT CSS hold'
   if scene=='closed':
    child.close();page.wait_for_function('savedBox.ownerDocument===document');control['release'].set()
    assert box.evaluate('e=>[e.scrollTop,e.scrollLeft]')==[700,350],'close before styles lost saved pan'
   elif scene=='error':
    control['release'].set();page.get_by_role('alert').filter(has_text='Window styling failed').wait_for()
    assert box.evaluate('e=>[e.scrollTop,e.scrollLeft]')==[700,350],'stylesheet failure lost saved pan'
   else:
    if scene in ['wheel','keyboard','pointer']:
     child.wait_for_function('!!document.querySelector("link[rel=stylesheet]").sheet',polling=50)
     b=child.locator('.styles-scroll').bounding_box()
     if scene=='wheel':
      child.mouse.move(b['x']+100,b['y']+180);child.mouse.wheel(180,260)
      child.wait_for_function('document.querySelector(".styles-scroll").scrollTop>0',polling=50)
     elif scene=='keyboard':
      child.get_by_label('Styles draft').focus();child.keyboard.type(' user edit')
     else:child.mouse.click(b['x']+100,b['y']+180)
     chosen=child.locator('.styles-scroll').evaluate('e=>[e.scrollTop,e.scrollLeft]')
     assert chosen!=[700,350],'INERT user pan differs from saved pan'
    control['release'].set()
    child.wait_for_function('[...document.querySelectorAll("link[rel=stylesheet]")].every(e=>e.sheet)',polling=50)
    child.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    expected=chosen if scene in ['wheel','keyboard','pointer'] else [700,350]
    assert child.locator('.styles-scroll').evaluate('e=>[e.scrollTop,e.scrollLeft]')==expected,(scene,expected,child.locator('.styles-scroll').evaluate('e=>[e.scrollTop,e.scrollLeft]'))
    child.close();page.wait_for_function('savedBox.ownerDocument===document')
    assert box.evaluate('e=>[e.scrollTop,e.scrollLeft]')==expected,(scene,'native return pan')
   assert page.evaluate('savedBox===document.querySelector(".styles-scroll") && savedInput===document.querySelector("input")'),'remounted DOM'
   assert page.get_by_label('Styles draft').input_value().startswith('same draft '+scene),'lost draft'
   results.append(scene);context.close()
  assert not errors,errors
  browser.close();print(json.dumps(dict(passed=results,axes=[700,350],errors=errors),indent=2))
finally:control['release'].set();server.shutdown();thread.join();server.server_close()
