// Org settings › Connections and App settings › Mail hub, before (base) and
// after (tip), dark and light, over connectionlist.visual.tsx's synthetic data
// (USER 2026-10-29 Connections lists). No engine, no real clipboard, no OS
// input: Session 0 only, muted, offscreen; clipboard permissions denied and
// every clipboard path stubbed; input is CDP to this window alone.
//   electron connectionlist.capture.cjs <out>
// <out> is below C:\orgtree-build\<ORGTREE_AGENT>\ and holds base\ and/or tip\,
// each with index.html, probe.js and probe.css from the visual bundle.
// A fixture that never starts leaves capture-error.json with the page's own
// errors (uncaught errors, failed loads, console errors and warnings) and each
// bundle's source.json receipt, so a bounce names its cause.
// Native tooltips are drawn by Windows and an offscreen capture cannot hold
// them: a hover shot draws the hovered element's own title text in an overlay.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]||'')
const owner=process.env.ORGTREE_AGENT||''
if(!/^[A-Za-z0-9_-]{1,64}$/.test(owner))throw Error('ORGTREE_AGENT required')
if(!out.toLowerCase().startsWith(('c:\\orgtree-build\\'+owner+'\\').toLowerCase()))throw Error('Output outside the owner\'s build scope')
const sessionId=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sessionId,0,'Session 0 required before any window')
app.setPath('userData',path.join(out,'profile-'+process.pid));app.setPath('sessionData',path.join(out,'session-'+process.pid))
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio')
const clipboardCalls=[]
for(const key of Object.keys(clipboard))if(typeof clipboard[key]==='function')Object.defineProperty(clipboard,key,{value:()=>{clipboardCalls.push(key);return key==='availableFormats'?[]:key==='has'?false:''}})
fs.writeFileSync(path.join(out,'clipboard.preload.cjs'),`Object.defineProperty(navigator,'clipboard',{value:Object.freeze({read:()=>Promise.reject(Error('Clipboard denied')),readText:()=>Promise.reject(Error('Clipboard denied')),write:()=>Promise.reject(Error('Clipboard denied')),writeText:()=>Promise.reject(Error('Clipboard denied'))})});window.__clipboardBlocked=true;`)
// index.html's first script: the page's uncaught errors and failed loads, read back when the fixture never starts
const pageErrorHook="window.__pageErrors=[];addEventListener('error',e=>{const t=e.target;window.__pageErrors.push(t&&t!==window?'failed to load '+(t.src||t.href||t.tagName):String(e.error&&e.error.stack||e.message).slice(0,4000))},true);addEventListener('unhandledrejection',e=>window.__pageErrors.push('unhandled rejection: '+String(e.reason&&e.reason.stack||e.reason).slice(0,4000)))"
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
// The order rule, written again here from the ruling, to check the page by.
const expectedOrder=(rows,recent)=>{const col=new Intl.Collator('en',{sensitivity:'base',numeric:true});const name=p=>(p.org_name||p.username||'').trim()||p.slug
  return rows.map(p=>({p,on:!!p.online,at:recent[p.slug]?Date.parse(recent[p.slug]):null})).sort((a,b)=>(b.on-a.on)||(a.at===b.at?0:a.at===null?1:b.at===null?-1:b.at-a.at)||col.compare(name(a.p),name(b.p))||(a.p.slug<b.p.slug?-1:a.p.slug>b.p.slug?1:0)).map(x=>'@net:'+x.p.slug)}
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('connectionlist-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:860,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const measured=[],bundles={};let attached=false,current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase)
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      await within(win.loadFile(path.join(dir,'index.html')),15000,'Fixture load timeout')
      await until('window.connFixture','fixture not loaded')
      const data=await evalJs('({roster:window.connFixture.roster,recent:window.connFixture.recent,hubRows:window.connFixture.hubRows,clipboard:window.__clipboardBlocked})')
      assert.equal(data.clipboard,true)
      for(const theme of phase==='base'?['dark']:['dark','light']){
        // Org settings › Connections
        await evalJs(`window.connFixture.show('connections','${theme}')`)
        await until(`document.querySelector('[data-hub-address]')`,'connections not drawn');await paint()
        assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`connections drawn in ${theme}`)
        await evalJs(`(document.querySelector('.connection-row [role="list"]')||document.querySelector('.connection-row ul')).scrollIntoView({block:'start'})`);await paint()
        const facts=await evalJs(`(()=>{const l=document.querySelector('.connection-row [role="list"]');const rows=l?[...l.querySelectorAll('[role="listitem"]')]:[];const dot=c=>{const d=document.querySelector('.presence-dot.'+c);if(!d)return null;const s=getComputedStyle(d);return{background:s.backgroundColor,border:s.borderTopWidth+' '+s.borderTopStyle+' '+s.borderTopColor,halo:s.boxShadow,width:s.width,height:s.height,title:d.title}};
          return{bullets:document.querySelectorAll('.connection-row li').length,listText:(l||document.querySelector('.connection-row ul'))?.textContent.slice(0,400),
            setsize:rows[0]?.getAttribute('aria-setsize')??null,mounted:rows.length,listHeight:l?l.getBoundingClientRect().height:null,rowHeight:rows[0]?rows[0].getBoundingClientRect().height:null,scrolls:l?l.classList.contains('scrolls'):null,
            words:l?/Online|Offline|independent Claude Code chat|Waiting to be linked/.test(l.textContent):null,online:dot('online'),offline:dot('offline'),
            first:rows.slice(0,12).map(r=>({pos:r.getAttribute('aria-posinset'),dot:r.querySelector('.presence-dot')?.classList.contains('online')?'online':'offline',address:r.querySelector('[data-hub-address]').dataset.hubAddress,hover:r.querySelector('[data-hub-address]').title.split('\\n')[0]}))}})()`)
        const record={phase,surface:'connections',theme,png:await shot(`${phase}-connections-${theme}`),...facts}
        if(phase==='tip'){
          assert.equal(facts.bullets,0);assert.equal(facts.words,false);assert.equal(facts.setsize,'200');assert.equal(facts.scrolls,true)
          assert(facts.mounted>=10&&facts.mounted<=20,'only the rows near the view are mounted')
          assert.deepEqual(facts.first.map(r=>r.address),expectedOrder(data.roster,data.recent).slice(0,12),'online first, newest mail, then A-Z')
          // online sorts first, so the top window holds online dots and the middle offline ones
          assert(facts.online&&facts.online.title==='Online','an online dot at the top')
          // the window follows a scroll to the middle
          await evalJs(`(()=>{const l=document.querySelector('.connection-row [role="list"]');l.scrollTop=Math.round(l.scrollHeight/2);l.dispatchEvent(new Event('scroll'))})()`);await paint()
          record.scrolled=await evalJs(`(()=>{const rows=[...document.querySelectorAll('.connection-row [role="listitem"]')];const d=document.querySelector('.connection-row .presence-dot.offline');const s=d&&getComputedStyle(d);
            return{mounted:rows.length,from:rows[0]?.getAttribute('aria-posinset'),to:rows.at(-1)?.getAttribute('aria-posinset'),
              offline:d?{background:s.backgroundColor,border:s.borderTopWidth+' '+s.borderTopStyle+' '+s.borderTopColor,halo:s.boxShadow,width:s.width,height:s.height,title:d.title}:null}})()`)
          assert(Number(record.scrolled.from)>80&&record.scrolled.mounted<=25,'scrolled window')
          const off=record.scrolled.offline
          assert(off&&off.title==='Offline','an offline dot in the middle')
          assert.notEqual(facts.online.background,off.background);assert.match(off.border,/^2px solid/);assert.doesNotMatch(facts.online.border,/^2px solid/)
          record.scrolledPng=await shot(`tip-connections-${theme}-scrolled`)
          await evalJs(`(()=>{const l=document.querySelector('.connection-row [role="list"]');l.scrollTop=0;l.dispatchEvent(new Event('scroll'))})()`);await paint()
          // a hovered chip: the pointer over a chat's chip (CDP to this window), its title drawn
          if(!attached){wc.debugger.attach('1.3');attached=true}
          const target=await evalJs(`(()=>{const c=[...document.querySelectorAll('.connection-row [role="listitem"] [data-net-kind="chat"]')][0];const r=c.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,address:c.dataset.hubAddress}})()`)
          await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});await paint()
          record.hover=await evalJs(`(()=>{const c=document.querySelector('[data-hub-address="${target.address}"]');const row=c.closest('[role="listitem"]');const r=c.getBoundingClientRect();const tip=document.createElement('div');tip.id='hover-text';tip.textContent=c.title;
            const light=document.documentElement.classList.contains('contrast-light');Object.assign(tip.style,{position:'fixed',left:r.left+'px',top:(r.bottom+6)+'px',zIndex:99999,whiteSpace:'pre',font:'12px Segoe UI, sans-serif',padding:'5px 8px',borderRadius:'3px',border:'1px solid '+(light?'#c5ccd4':'#454545'),background:light?'#ffffff':'#252526',color:light?'#2d333b':'#cccccc',boxShadow:'0 2px 8px rgba(0,0,0,.36)'});document.body.append(tip);
            return{address:c.dataset.hubAddress,title:c.title,dotTitle:row.querySelector('.presence-dot').title,underline:getComputedStyle(c).textDecorationLine}})()`)
          assert.match(record.hover.title,/^(Online|Offline) · independent chat\n/);assert.match(record.hover.underline,/underline/)
          await paint();record.hoverPng=await shot(`tip-connections-${theme}-hover`)
          await evalJs(`document.getElementById('hover-text').remove()`)
          await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await paint()
        }
        measured.push(record)
        // App settings › Mail hub
        await evalJs(`window.connFixture.show('mailhub','${theme}')`)
        await until(`/Running at/.test(document.querySelector('.host-hub')?.textContent||'')`,'mail hub not drawn')
        if(phase==='tip')await until(`document.querySelector('.host-hub [role="listitem"]')`,'hub list not drawn')
        await paint()
        await evalJs(`document.querySelector('.host-hub').scrollIntoView({block:'start'})`);await paint()
        assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`mail hub drawn in ${theme}`)
        const hub=await evalJs(`(()=>{const h=document.querySelector('.host-hub');const t=h.textContent;const l=h.querySelector('[role="list"]');const rows=l?[...l.querySelectorAll('[role="listitem"]')]:[];const after=(a,b)=>!!a&&!!b&&(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)!==0;
          const status=h.querySelector('[role="status"]'),phone=document.querySelector('.phone-settings'),hosting=document.querySelector('[aria-label="Mail hub name"]');
          return{intro:/carries correspondence/.test(t),migrated:/was migrated/.test(t),v2import:/moved into its new database/.test(t),status:status?.textContent,
            setsize:rows[0]?.getAttribute('aria-setsize')??null,mounted:rows.length,first:rows.slice(0,8).map(r=>({dot:r.querySelector('.presence-dot')?.classList.contains('online')?'online':'offline',address:r.querySelector('[data-hub-address]').dataset.hubAddress,hover:r.querySelector('[data-hub-address]').title.split('\\n')[0]})),
            phoneAfterStatus:after(status,phone),listBeforePhone:after(l,phone),phoneBeforeHosting:after(phone,hosting)}})()`)
        const hubRecord={phase,surface:'mailhub',theme,png:await shot(`${phase}-mailhub-${theme}`),...hub}
        if(phase==='tip'){
          assert.deepEqual([hub.intro,hub.migrated,hub.v2import],[false,false,false])
          assert.equal(hub.setsize,String(data.hubRows.length));assert(hub.listBeforePhone&&hub.phoneBeforeHosting)
          const recent={...data.recent,[data.hubRows[0].slug]:new Date(Date.parse('2026-10-29T12:00:00.000Z')-3*60000).toISOString()}
          assert.deepEqual(hub.first.map(r=>r.address),expectedOrder(data.hubRows,recent).slice(0,8))
        }else{assert.equal(hub.intro,true);assert.equal(hub.migrated,true);assert.equal(hub.v2import,true)}
        measured.push(hubRecord)
      }
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: both phases, both surfaces, every theme
    assert.equal(measured.length,6,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,bundles,
      tooltipNote:'hover shots draw the hovered chip\'s own title attribute in an overlay; native tooltips are not capturable offscreen',measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,shots:measured.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
