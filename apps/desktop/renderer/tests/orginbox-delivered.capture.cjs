// The org inbox window's received-mail detail listing every agent the mail was delivered to, beside
// the outbox's own "@agent as @org -> @recipient" line (USER 2026-10-29 ma660da825904), dark and
// light, over orginbox-delivered.visual.tsx's synthetic data. No engine, no real clipboard, no OS
// input: Session 0 only, muted, offscreen; clipboard permissions denied and every clipboard path
// stubbed; input is CDP to this window alone.
//   electron orginbox-delivered.capture.cjs <out>
// <out> is below C:\orgtree-build\<ORGTREE_AGENT>\ and holds tip\ with probe.js and probe.css from
// the visual bundle (orginbox-delivered-build.mjs). A fixture that never starts leaves
// capture-error.json with the page's own errors and the bundle's source.json receipt.
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
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('delivered-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:860,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async(surface,theme)=>{await evalJs(`window.deliveredFixture.show('${surface}','${theme}')`)}
  const themed=async(theme,what)=>assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`${what} drawn in ${theme}`)
  const measured=[],bundles={};let current='tip'
  const WANT_SOME=['coordinator-opus','liaison-opus','old-reviewer','gone-agent']
  const WANT_MANY=['coordinator-opus','liaison-opus','rig-sol-b','build-sol','app-net-opus','desk-parity-opus','old-reviewer','old-builder','gone-agent']
  const LIVE=new Set(['coordinator-opus','liaison-opus','rig-sol-b','build-sol','app-net-opus','desk-parity-opus'])
  try{
    const dir=path.join(out,'tip')
    if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no bundle in ${dir}: nothing to capture`)
    const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles.tip={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
    fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
    await within(win.loadFile(path.join(dir,'index.html')),15000,'Fixture load timeout')
    await until('window.deliveredFixture','fixture not loaded')
    assert.equal(await evalJs('window.__clipboardBlocked'),true)
    for(const theme of ['dark','light']){
      for(const surface of ['some','many','none','sent']){
        await show(surface,theme)
        await until(`document.querySelector('.mailer-head')&&document.querySelector('.mailer-body')`,`${surface} detail not drawn`);await paint()
        await themed(theme,surface)
        const facts=await evalJs(`(()=>{const h=document.querySelector('.mailer-head');const g=h.querySelector('.org-mail-attribution');const rec=g&&g.querySelector('.org-mail-recipient')
          const chips=rec?[...rec.querySelectorAll('.ref-agent')].map(c=>({name:c.dataset.copyAgentName,tag:c.tagName,nav:c.dataset.agentNav||null,ready:c.classList.contains('ref-ready'),color:getComputedStyle(c).color})):[]
          const r=h.getBoundingClientRect();return{headText:h.textContent,group:!!g,recipients:!!rec,recipientText:rec?rec.textContent:null,chips,hubs:[...h.querySelectorAll('[data-hub-address]')].map(e=>e.dataset.hubAddress),
            overflow:h.scrollWidth>h.clientWidth+1,headHeight:Math.round(r.height),headWidth:Math.round(r.width),listRowRecipients:document.querySelectorAll('.mailrow .org-mail-recipient').length}})()`)
        const record={phase:'tip',surface,theme,png:await shot(`tip-${surface}-${theme}`),facts}
        assert.equal(facts.overflow,false,`${surface} head overflows sideways`)
        assert.equal(facts.listRowRecipients,0,'the list row names only the sender')
        if(surface==='some'||surface==='many'){
          const want=surface==='some'?WANT_SOME:WANT_MANY
          assert.equal(facts.group,true,'one attribution group');assert.equal(facts.recipients,true,'the outbox recipient markup')
          assert.ok(facts.hubs.includes('@net:alice.fixture'),'the outside sender stays the hub contact link')
          assert.deepEqual(facts.chips.map(c=>c.name),want,'every agent, in delivery order')
          assert.match(facts.recipientText,/^\u2192/,'the arrow leads the recipients')
          for(const c of facts.chips){
            if(LIVE.has(c.name)){assert.equal(c.tag,'BUTTON',`${c.name} is the shared AgentLink`);assert.ok(c.nav,`${c.name} navigates`);assert.equal(c.ready,true)}
            else{assert.equal(c.tag,'SPAN',`${c.name} is inert`);assert.equal(c.nav,null,`${c.name} does not navigate`);assert.equal(c.ready,false,`${c.name} wears the dim chip`)}
          }
          const liveColor=facts.chips.find(c=>LIVE.has(c.name)).color,deadColors=new Set(facts.chips.filter(c=>!LIVE.has(c.name)).map(c=>c.color))
          assert.equal(deadColors.size,1,'every retired or removed name is drawn alike');assert.ok(!deadColors.has(liveColor),`retired is dimmer than live (${[...deadColors]} vs ${liveColor})`)
        }else if(surface==='none'){
          assert.equal(facts.group,false,'no record, no group');assert.equal(facts.recipients,false)
          assert.ok(facts.hubs.includes('@net:alice.fixture'))
        }else{
          assert.equal(facts.group,true);assert.equal(facts.recipients,true)
          assert.match(facts.headText,/@coordinator-opus.*as @org:fixture.*\u2192.*@net:peer\.fixture/s,'the outbox line is unchanged')
        }
        measured.push(record)
      }
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: every surface, both themes
    assert.equal(measured.length,8,`${measured.length} records`)
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,bundles,measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
