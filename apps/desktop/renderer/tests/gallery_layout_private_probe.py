from pathlib import Path
import json, subprocess, tempfile
from playwright.sync_api import sync_playwright
HERE=Path(__file__).resolve().parent; FRONTEND=HERE.parent
with tempfile.TemporaryDirectory(prefix='orgtree-gallery-layout-') as td:
 out=Path(td); subprocess.run(['node',str(HERE/'gallery-layout-build.mjs'),str(out)],cwd=FRONTEND,check=True)
 with sync_playwright() as pw:
  browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1100,'height':700});errors=[];page.on('pageerror',lambda e: (errors.append(str(e)),print('PAGEERROR',e)));page.goto((out/'probe.html').as_uri());page.wait_for_selector('.gallery-agent .mailer-list');page.wait_for_selector('.gallery-modal:not(.gallery-agent) .mailer-list',state='attached')
  page.wait_for_timeout(1000)
  if 'stale copy' in page.locator('body').inner_text():
   print('DEBUG_BODY', page.locator('body').inner_text(), 'CALLS', page.evaluate('window.__calls'))
  guard=page.evaluate("""() => { const e=document.querySelector('.gallery-agent'); return {gallery:!!e,list:!!e?.querySelector('.mailer-list'),read:!!e?.querySelector('.mailer-read'),beta:e?.innerText.includes('Beta private'),stale:e?.innerText.includes('stale copy'),classes:e?.className} }""")
  assert guard['gallery'] and guard['list'] and guard['read'] and not guard['beta'] and not guard['stale'],guard
  page.locator('.gallery-agent .mailrow').filter(has_text='Alpha markdown').click();page.wait_for_timeout(1000)
  if not page.locator('.gallery-agent .mailer-read .doc-pane-head').count(): print('DEBUG_CLICK',page.locator('body').inner_text(),page.evaluate('window.__calls'))
  page.wait_for_selector('.gallery-agent .mailer-read .doc-pane-head');box=page.locator('.gallery-agent .mailer-read').bounding_box();page.evaluate("() => { const e=document.querySelector('.desk-fixture'); e.style.width='390px'; e.style.height='360px' }"); body=page.locator('.gallery-agent .mailer-read');page.screenshot(path=str(HERE.parent.parent/'gallery-layout-before.png'));scroll=body.evaluate('(e)=>{e.scrollTop=e.scrollHeight;return {top:e.scrollTop,scroll:e.scrollHeight,client:e.clientHeight,lastVisible:e.scrollTop+e.clientHeight>=e.scrollHeight}}');assert scroll['scroll']>scroll['client'] and scroll['top']>0 and scroll['lastVisible'],scroll
  html=page.locator('.gallery-agent .mailrow').filter(has_text='Alpha HTML');href=html.get_attribute('href');assert href and '/mockup' in href,href
  page.set_viewport_size({'width':390,'height':600}); narrow=page.locator('.gallery-agent').bounding_box(); assert narrow and narrow['x'] >= 0 and narrow['x']+narrow['width'] <= 390,narrow
  result={'private_bundle':True,'gallery_classes':guard['classes'],'org_modal_classes':page.locator('.gallery-modal:not(.gallery-agent)').get_attribute('class'),'inline_pane':True,'agent_filter':True,'stale_node_excluded':True,'long_body_scroll':scroll,'viewport':box,'html_mockup_href':href,'narrow_gallery_box':narrow,'pageerrors':errors};assert not errors,errors;(HERE.parent.parent/'gallery-layout-results.json').write_text(json.dumps(result,indent=2),encoding='utf-8');page.screenshot(path=str(HERE.parent.parent/'gallery-layout.png'));print(json.dumps(result,indent=2));browser.close()
