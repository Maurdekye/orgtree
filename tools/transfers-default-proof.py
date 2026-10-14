"""Run in rig-opus batch with TRANSFERS_OUT and TRANSFERS_EVIDENCE paths."""
import json, os, pathlib
from playwright.sync_api import sync_playwright
out = pathlib.Path(os.environ['TRANSFERS_OUT'])
evidence = pathlib.Path(os.environ['TRANSFERS_EVIDENCE'])
evidence.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
 browser = p.chromium.launch(channel='msedge', headless=True)
 try:
  for app in ['org-red', 'org-green', 'hub']:
   for theme in ['dark', 'light']:
    for surface in (['org', 'user', 'agent'] if app.startswith('org') else ['desktop', 'android']):
     for completed in ([False, True] if app.startswith('org') else [False]):
      case = f'{app}-{theme}-{surface}-'+('complete' if completed else 'active')
      page = browser.new_page(viewport={'width':390 if surface=='android' else 1100,'height':850})
      errors=[];checks=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      def check(name,ok):
       checks.append({'name':name,'ok':bool(ok)})
       if not ok: raise AssertionError(case+': '+name)
      css=(out/(app+'.css' if app.startswith('org') else 'hub-'+surface+'.css')).read_text(encoding='utf8')
      cls='contrast-'+theme if app.startswith('org') else 'theme-'+theme
      html=f'<html class="{cls}" data-theme="{theme}" data-platform="{surface}"><style>{css}</style><body data-surface="{surface}" data-platform="{surface}" data-completed="{str(completed).lower()}"><div id="root"></div></body></html>'
      page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html) if r.request.url=='http://fixture.local/' else r.abort())
      try:
       page.goto('http://fixture.local/');page.add_script_tag(content=(out/(app+'.js')).read_text(encoding='utf8'))
       header=page.locator('.mail-transfers .linkish' if app.startswith('org') else '.tb-xfer' if surface=='desktop' else '.xstrip .strip')
       rows=page.locator('.transfer-card' if app.startswith('org') else '.xrow')
       header.wait_for(state='visible',timeout=5000)
       red=app=='org-red'
       check('initial rows follow expected default',rows.count()==(1 if red else 0))
       if app.startswith('org'):
        check('disclosure accessibility matches default',header.get_attribute('aria-expanded')==str(red).lower())
        check('completed-only header has no count', ('unfinished' not in header.inner_text()) if completed else '1 unfinished' in header.inner_text())
       else:
        check('active header has compact progress', '40%' in header.inner_text())
       page.screenshot(path=str(evidence/(case+'-initial.png')))
       if red:
        # The old product is expanded: this is the red control for the requested default.
        check('red baseline exhibits requested bug',rows.count()==1)
       else:
        header.click();rows.wait_for(state='visible')
        check('one click expands retained rows',rows.count()==1 and 'retained.txt' in rows.inner_text())
        page.screenshot(path=str(evidence/(case+'-expanded.png')))
        if not completed:
         page.evaluate('window.proof.confirmed=70')
         if app=='hub':page.evaluate('window.proof.refresh()')
         page.wait_for_function("() => document.querySelector('.transfer-card progress')?.value===70 || document.querySelector('.xrow .tb-bar b')?.style.width==='70%'",timeout=5000)
         check('poll/update preserves open rows',rows.count()==1)
        if app.startswith('org'):
         check('no disclosure mutation calls',page.evaluate("window.proof.requests.every(u=>!u.includes('/fixture-transfer'))"))
        header.click();check('one click collapses',rows.count()==0)
        header.click();rows.wait_for(state='visible')
        page.evaluate('window.proof.reopen()')
        page.wait_for_function("() => !document.querySelector('.transfer-card,.xrow')",timeout=5000)
        check('reopened view collapsed',rows.count()==0)
       check('no browser errors',not errors)
       results.append({'case':case,'checks':checks,'errors':errors})
      except Exception as e:
       page.screenshot(path=str(evidence/(case+'-failure.png')))
       results.append({'case':case,'checks':checks,'errors':errors,'failure':str(e)})
      finally:page.close()
 finally:browser.close()
(evidence/'result.json').write_text(json.dumps({'results':results,'passed':sum('failure' not in r for r in results),'total':len(results)},indent=2))
assert len(results)==28 and all('failure' not in r for r in results), 'See result.json and failure PNGs'
print('28/28 Transfers fixture cases passed: Orgtree red/green, Hubchat desktop/Android, dark/light.')
