// The agents tray, a retired pile's rows and the card, map, zoom-card and desk-header clocks,
// before (base) and after (tip) "every age in Orgtree uses one scale" (USER 2026-10-29
// m1baa42b32cb6), dark and light, over agefmt.visual.tsx's synthetic data. No engine, no real
// clipboard, no OS input: Session 0 only, muted, offscreen; clipboard permissions denied and
// every clipboard path stubbed; input is CDP to this window alone.
//   electron agefmt.capture.cjs <out>
// <out> is below C:\orgtree-build\<ORGTREE_AGENT>\ and holds base\ and tip\, each with probe.js
// and probe.css from the visual bundle (agefmt-build.mjs). A fixture that never starts leaves
// capture-error.json with the page's own errors and each bundle's source.json receipt. Native
// tooltips are drawn by Windows and an offscreen capture cannot hold them: a hover shot draws the
// hovered element's own title in an overlay.
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
// how long ago, one scale (the tip); the dense month-day stamp (the base)
const AGE=/^\d+(s|m|h|d|w|mo|y)$/,SHORT=/^\d\d-\d\d \d\d:\d\d$/,FULL=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d( \S+)?$/
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('agefmt-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:860,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async(surface,theme)=>{await evalJs(`window.ageFixture.show('${surface}','${theme}')`)}
  const themed=async(theme,what)=>assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`${what} drawn in ${theme}`)
  // a hover overlay: the pointer over the element (CDP to this window), its own title drawn under it
  let attached=false
  const hoverShot=async(selector,name)=>{
    if(!attached){wc.debugger.attach('1.3');attached=true}
    const at=await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x,y:at.y});await paint()
    const title=await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();const tip=document.createElement('div');tip.id='hover-text';tip.textContent=e.title;
      const light=document.documentElement.classList.contains('contrast-light');Object.assign(tip.style,{position:'fixed',left:Math.max(4,r.right-320)+'px',top:(r.bottom+6)+'px',zIndex:99999,whiteSpace:'pre',font:'12px Segoe UI, sans-serif',padding:'5px 8px',borderRadius:'3px',border:'1px solid '+(light?'#c5ccd4':'#454545'),background:light?'#ffffff':'#252526',color:light?'#2d333b':'#cccccc',boxShadow:'0 2px 8px rgba(0,0,0,.35)'});document.body.append(tip);return e.title})()`)
    await paint();const png=await shot(name)
    await evalJs(`document.getElementById('hover-text').remove()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});await paint()
    return {title,png}
  }
  const measured=[],bundles={};let current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase),tip=phase==='tip'
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      await within(win.loadFile(path.join(dir,'index.html')),15000,'Fixture load timeout')
      await until('window.ageFixture','fixture not loaded')
      assert.equal(await evalJs('window.__clipboardBlocked'),true)
      for(const theme of tip?['dark','light']:['dark']){
        const FULL=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d( \S+)?$/,STAMP=/^\d{4}-\d\d-\d\d \d\d:\d\d$/
        const full=(title,prefix,suffix='')=>{assert.ok(title&&title.startsWith(prefix+' ')&&title.endsWith(suffix),`${title} starts ${prefix}`);assert.match(title.slice(prefix.length+1,title.length-suffix.length),FULL,`${title} carries the full date and time`)}
        const stamp=(title,prefix)=>{assert.ok(title&&title.startsWith(prefix+' '),`${title} starts ${prefix}`);assert.match(title.slice(prefix.length+1).replace(/ \(killed\)$/,''),STAMP,`${title} carries the minute stamp`)}
        // 1. the agents tray: a turn of 3 days, a halt of 20 days, a turn running for 2 days, a status 3 days old
        await show('tray',theme)
        await until(`document.querySelectorAll('.tray-row').length>=4`,'tray not drawn');await paint()
        await themed(theme,'tray')
        const tray=await evalJs(`(()=>[...document.querySelectorAll('.tray-row')].map(r=>{const t=r.querySelector('.tray-status-time'),s=r.querySelector('.tray-sum-at');return{name:r.querySelector('.tray-name')?.textContent,time:t?.textContent?.trim()??null,timeTitle:t?.getAttribute('title')??null,timeLabel:t?.getAttribute('aria-label')??null,sum:s?.textContent??null,sumTitle:s?.getAttribute('title')??null}}))()`)
        const trayRecord={phase,surface:'tray',theme,png:await shot(`${phase}-tray-${theme}`),rows:tray}
        const row=n=>tray.find(r=>r.name===n)
        assert.equal(tray.length,4)
        if(tip){
          assert.deepEqual(['idle-three-days','halted-three-weeks','running-two-days','idle-minutes'].map(n=>row(n).time),['3d','3w','2d','12m'])
          full(row('idle-three-days').timeTitle,'last turn ended');full(row('halted-three-weeks').timeTitle,'Halted since');full(row('running-two-days').timeTitle,'active since')
          for(const n of ['idle-three-days','halted-three-weeks','running-two-days'])assert.equal(row(n).timeLabel,row(n).timeTitle,'the accessible name is the hover')
          assert.equal(row('idle-three-days').sum,' \u00b7 3d ago');assert.match(row('idle-three-days').sumTitle,FULL)
          trayRecord.hover=await hoverShot('.tray-row .tray-status-time',`tip-tray-${theme}-hover`)
          assert.match(trayRecord.hover.title,/^last turn ended \d{4}-/)
        }else{
          assert.deepEqual(['idle-three-days','halted-three-weeks','running-two-days','idle-minutes'].map(n=>row(n).time),['72h','480h','48h','12m'],'before: hours without end')
          stamp(row('idle-three-days').timeTitle,'last turn ended');stamp(row('halted-three-weeks').timeTitle,'Halted since')
          assert.equal(row('running-two-days').timeTitle,null,'before: nothing on hover');assert.equal(row('idle-three-days').sum,' \u00b7 72h ago');assert.equal(row('idle-three-days').sumTitle,null)
        }
        measured.push(trayRecord)
        // 2. a retired pile: the last turn of four members, minutes to weeks ago
        await show('pile',theme)
        await until(`document.querySelectorAll('.pile-row .pile-ago').length>=4`,'pile not drawn');await paint()
        await themed(theme,'pile')
        const pile=await evalJs(`(()=>[...document.querySelectorAll('.pile-row')].map(r=>({name:r.querySelector('.pile-name')?.textContent,text:r.querySelector('.pile-ago')?.textContent,title:r.querySelector('.pile-ago')?.getAttribute('title')})))()`)
        const pileRecord={phase,surface:'pile',theme,png:await shot(`${phase}-pile-${theme}`),rows:pile}
        assert.deepEqual(pile.map(r=>r.name),['reviewer-one','builder-two','tester-three','scribe-four'])
        if(tip){
          assert.deepEqual(pile.map(r=>r.text),['10m ago','26h ago','3d ago','3w ago'])
          for(const r of pile)full(r.title,'last turn ended',r.name==='tester-three'?' (killed)':'')
          pileRecord.hover=await hoverShot('.pile-row .pile-ago',`tip-pile-${theme}-hover`)
        }else{
          assert.deepEqual(pile.map(r=>r.text),['10m ago','26h ago','72h ago','504h ago'],'before: hours without end')
          for(const r of pile)stamp(r.title,'last turn ended')
        }
        measured.push(pileRecord)
        // 3. the clocks of one card, map, zoom card and desk header
        await show('clocks',theme)
        await until(`document.querySelector('.turn-status-banner')&&document.querySelector('.turnago')&&document.querySelectorAll('.map-ago').length>=2&&document.querySelectorAll('.sq-idle-time').length>=3`,'clocks not drawn');await paint()
        await themed(theme,'clocks')
        const clocks=await evalJs(`(()=>[...document.querySelectorAll('#root > div > div')].map(r=>{const c=r.querySelector('.turnago,.map-ago,.sq-idle-time,.turn-status-time');return{label:r.firstChild.textContent,text:c?.textContent?.trim()??null,title:c?.getAttribute('title')??null}}))()`)
        const clocksRecord={phase,surface:'clocks',theme,png:await shot(`${phase}-clocks-${theme}`),rows:clocks}
        assert.equal(clocks.length,9)
        if(tip){
          assert.deepEqual(clocks.map(c=>c.text),['3d','3d','2d','3d','3w','2d','3d','3w','2d'])
          full(clocks[0].title,'last turn ended',' (killed)');full(clocks[1].title,'last turn ended',' (killed)');full(clocks[2].title,'running since');full(clocks[3].title,'last turn ended',' (killed)')
          full(clocks[4].title,'Halted since');full(clocks[5].title,'active since')
        }else{
          assert.deepEqual(clocks.map(c=>c.text),['72h','72h','48h','72h','480h','48h','72h','480h','48h'],'before: hours without end')
          stamp(clocks[0].title,'last turn ended');stamp(clocks[3].title,'last turn ended')
        }
        measured.push(clocksRecord)
      }
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: both phases, every surface, every theme
    assert.equal(measured.length,9,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,bundles,
      tooltipNote:'hover shots draw the hovered element\'s own title attribute in an overlay; native tooltips are not capturable offscreen',measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
