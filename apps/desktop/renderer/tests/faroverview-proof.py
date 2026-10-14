import json,pathlib,os
from playwright.sync_api import sync_playwright
OUT=pathlib.Path(os.environ.get('FAR_OVERVIEW_OUT','C:/orgtree-build/frozenlabel-sol/far-overview'))
EVIDENCE=pathlib.Path(os.environ.get('FAR_OVERVIEW_EVIDENCE','D:/orgtree-work/far-overview-evidence'))
EVIDENCE.mkdir(exist_ok=True,parents=True)
results=[]
MEASURE=r'''() => {
const q=s=>document.querySelector(s),n=s=>document.querySelectorAll(s).length;
const resolved=(el,name)=>{const probe=document.createElement('i');probe.style.color=`var(${name})`;el.appendChild(probe);const c=getComputedStyle(probe).color;probe.remove();return c;};
const accent=id=>{const el=q(`[data-copy-agent-name="${id}"].sq`);if(!el)return null;return {edge:getComputedStyle(el,'::before').backgroundColor,tier:resolved(el,'--tier-accent'),provider:resolved(el,'--provider-accent')};};
return {zoom:new DOMMatrixReadOnly(getComputedStyle(q('.space')).transform).a,mini:n('.sq.mini'),dogs:n('.wd-chip'),dogWires:n('.edge.wd'),docs:n('.doc-chips .doc-chip'),bar:n('.cbar-inf-wrap'),retired:n('.retired-token'),mailbox:!!q('.sq.orginbox'),glyph:n('.orginbox-far .oi-far-icon'),globe:n('.orginbox-far [data-testid="PublicIcon"]'),mailText:q('.sq.orginbox')?.textContent||'',head:n('.sq.orginbox .oi-head'),last:n('.sq.orginbox .oi-last'),blue:accent('model-blue'),green:accent('model-green'),unknown:accent('no-model-colour')};
}'''
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge',headless=True)
  try:
   for phase in ['before','after']:
    client=(OUT/(phase+'.js')).read_text(encoding='utf-8')
    css=(OUT/(phase+'.css')).read_text(encoding='utf-8')
    for theme in ['dark','light']:
     for far,z in [(False,.8),(True,.24)]:
      for hide in [False,True]:
       case=f'{phase}-{theme}-'+('far' if far else 'normal')+('-hide-retired' if hide else '-show-retired')
       if os.environ.get('FAR_OVERVIEW_CASE') and os.environ['FAR_OVERVIEW_CASE']!=case:continue
       print('CASE '+case,flush=True)
       errors=[];console=[];page=browser.new_page(viewport={'width':1600,'height':1000})
       page.on('pageerror',lambda e:errors.append({'message':str(e),'stack':e.stack}))
       page.on('console',lambda m:console.append({'type':m.type,'text':m.text}))
       html=f'<!doctype html><html class="contrast-{theme}"><style>{css}</style><body><div id="root"></div><script>window.proofZoom={z};window.proofHide={str(hide).lower()};window.proofRequests=[];</script></body></html>'
       page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html) if r.request.url=='http://fixture.local/' else r.abort())
       page.goto('http://fixture.local/');page.add_script_tag(content=client);page.wait_for_selector('.sq.orginbox')
       page.wait_for_timeout(600)
       m=page.evaluate(MEASURE);bad=[];roundtrip=None
       def check(ok,message):
        if not ok:bad.append(message)
       check(m['mailbox'],'mailbox missing')
       check((m['mini']>0)==far,'camera does not use requested LOD')
       if phase=='after' and far:
        check(m['dogs']==0 and m['dogWires']==0,'watchdogs or wires remain')
        check(m['docs']==0,'side presentation hit targets remain')
        check(m['bar']==0,'infinite bar remains')
        check(not hide or m['retired']==0,'hidden-retired marker remains')
        check(m['glyph']==1 and m['head']==0 and m['last']==0 and not m['mailText'].strip(),'mailbox not glyph-only')
        check(m['globe']==1,'far mailbox must use the modal header globe')
        for key in ['blue','green']:
         check(m[key] is not None and m[key]['edge']==m[key]['tier'],key+' accent is not model colour')
        check(m['unknown'] is not None and m['unknown']['edge']==m['unknown']['provider'],'unknown model has no provider fallback')
       else:
        check(m['dogs']==1 and m['dogWires']==1,'normal/baseline watchdog control missing')
        check(m['docs']==2,'normal/baseline document control missing')
        check(m['bar']==1,'normal/baseline infinite bar missing')
        check(m['head']==1 and m['last']==1 and 'org inbox' in m['mailText'],'normal mailbox details missing')
        check(not hide or m['retired']==1,'normal/baseline retired control missing')
       page.screenshot(path=str(EVIDENCE/(case+'.png')))
       if phase=='after' and far:
        def zoom_steps(name,factor):
         steps=[]
         for _ in range(4):
          previous=page.evaluate(MEASURE)['zoom'];expected=max(.24,previous*factor)
          page.get_by_role('button',name=name,exact=True).click()
          # zoomStep animates for 220ms; another click cancels that animation.
          # Observe its actual target before issuing the next step.
          page.wait_for_function("z => Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.space')).transform).a-z)<0.00001",arg=expected,timeout=3000)
          steps.append(page.evaluate(MEASURE)['zoom'])
         return steps
        in_steps=zoom_steps('zoom in',1.3)
        page.wait_for_timeout(700);normal=page.evaluate(MEASURE)
        check(normal['dogs']==1 and normal['docs']==2 and normal['bar']==1 and normal['head']==1,'zoom in fails to restore retained surfaces')
        check(not hide or normal['retired']==1,'zoom in fails to restore retired marker')
        out_steps=zoom_steps('zoom out',1/1.3)
        page.wait_for_timeout(700);again=page.evaluate(MEASURE)
        roundtrip={'in_steps':in_steps,'restored':normal,'out_steps':out_steps,'again':again}
        check(normal['zoom']>=.55 and again['zoom']<.55,'round trip did not cross shared LOD threshold')
        page.screenshot(path=str(EVIDENCE/(case+'-roundtrip.png')))
        check(again['dogs']==0 and again['docs']==0 and again['bar']==0 and again['glyph']==1,'zoom back out leaves stale surfaces')
        check(page.evaluate('window.proofTree.roots[0].documents.length===2&&window.proofTree.watchdogs.length===1'),'zoom discarded tree data')
       page.locator('.sq.orginbox').click()
       page.wait_for_timeout(250)
       check(page.evaluate("window.proofRequests.some(url=>url.includes('/org_inbox'))"),'mailbox click did not open existing viewer')
       check(not errors,'browser errors: '+str(errors))
       results.append({'case':case,'measurements':m,'roundtrip':roundtrip,'bad':bad,'errors':errors,'console':console});page.close()
  finally:browser.close()
finally:
 (EVIDENCE/'result.json').write_text(json.dumps({'results':results,'passed':sum(not r['bad'] for r in results),'total':len(results),'diagnostic_only':bool(os.environ.get('FAR_OVERVIEW_CASE'))},indent=2),encoding='utf-8')
for r in results:
 if r['bad']:print(r['case'],r['bad'])
assert len(results)==(1 if os.environ.get('FAR_OVERVIEW_CASE') else 16) and all(not r['bad'] for r in results),'rendered proof failed; see result.json'
print('16/16 real OrgCanvas cases passed, including fixed far/normal round trips.')
