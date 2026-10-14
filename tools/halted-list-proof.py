import json,os,pathlib
from playwright.sync_api import sync_playwright
out=pathlib.Path(os.environ['HALTED_LIST_OUT']);evidence=pathlib.Path(os.environ['HALTED_LIST_EVIDENCE']);evidence.mkdir(parents=True,exist_ok=True)
measure=r'''() => {
 const rows=[...document.querySelectorAll('.tray-row')];
 const token=(el,name)=>{const p=document.createElement('i');p.style.color=`var(${name})`;el.appendChild(p);const colour=getComputedStyle(p).color;p.remove();return colour;};
 return rows.map(el=>{const label=el.querySelector('.tray-status-label'),icon=el.querySelector('.tray-halted');return {id:el.dataset.copyAgentName,height:el.getBoundingClientRect().height,summary:el.querySelector('.tray-sum')?.textContent,summaryHeight:el.querySelector('.tray-sum')?.getBoundingClientRect().height,halted:!!icon,label:label?.textContent,colour:label?getComputedStyle(label).color:null,iconColour:icon?getComputedStyle(icon).color:null,bad:token(el,'--bad'),age:el.querySelector('.tray-status-time')?.textContent,usage:!!el.querySelector('.usage-freeze-status')};});
}'''
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(channel='msedge',headless=True)
 try:
  for phase in ['red','green']:
   for theme in ['dark','light']:
    for host in ['canvas','drawer','superior']:
     for width in [320,480]:
      case=f'{phase}-{theme}-{host}-{width}';page=browser.new_page(viewport={'width':1100,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
      css=(out/(phase+'.css')).read_text(encoding='utf8')
      html=f'<html class="contrast-{theme}"><style>{css}</style><body data-host="{host}" data-width="{width}"><div id="root"></div></body></html>'
      page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html) if r.request.url=='http://fixture.local/' else r.abort())
      bad=[];rows=[]
      def check(ok,name):
       if not ok:bad.append(name)
      try:
       page.goto('http://fixture.local/');page.add_script_tag(content=(out/(phase+'.js')).read_text(encoding='utf8'));page.wait_for_selector('.tray-row');page.wait_for_timeout(100)
       rows=page.evaluate(measure);by={r['id']:r for r in rows}
       check(len(rows)==13,'all state rows rendered')
       heights=[r['height'] for r in rows]
       if phase=='green':
        check(max(heights)-min(heights)<=.5,'canonical row height across all states')
        for name in ['halted','halt-no-status','halt-prev-status','halt-and-frozen']:
         r=by[name];check(r['halted'] and r['label']=='Halted','halt icon/label '+name)
         check(r['colour']==r['bad'] and r['iconColour']==r['bad'],'existing halt colour '+name)
         check(r['age'] and ('m' in r['age'] or 's' in r['age']),'halt timestamp age '+name)
         check(not r['usage'],'halt wins usage freeze '+name)
        check('idle: Retained status text' in by['halted']['summary'] and 'ago' in by['halted']['summary'],'last status and independent age')
        check('idle: Retained status text' in by['halt-prev-status']['summary'],'previous status retained')
        check(by['halt-no-status']['summaryHeight']>0 and not by['halt-no-status']['summary'].strip(),'neutral empty summary reserves height')
       else:
        check(not by['halted']['halted'],'red reproduces plain halted badge')
        check(max(heights)-min(heights)>.5,'red reproduces row-height discrepancy')
       check(by['usage-frozen']['usage'] and not by['usage-frozen']['halted'],'usage-only freeze unchanged')
       check(not errors,'no browser errors')
       page.screenshot(path=str(evidence/(case+'.png')))
      except Exception as e:bad.append(str(e));page.screenshot(path=str(evidence/(case+'-failure.png')))
      finally:page.close()
      results.append({'case':case,'rows':rows,'bad':bad,'errors':errors})
 finally:browser.close()
(evidence/'result.json').write_text(json.dumps({'results':results,'passed':sum(not r['bad'] for r in results),'total':len(results)},indent=2))
assert len(results)==24 and all(not r['bad'] for r in results),'See halted-list result.json/PNGs'
print('24/24 real AgentTray cases passed, red/green, three host contexts, two widths and both themes.')
