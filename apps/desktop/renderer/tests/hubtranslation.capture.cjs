// App settings › Mail hub › Hosting's Translation group (Mail hub 2.4.0;
// docket mail-hub-hubchat-automatic-translation-between-u), dark and light,
// over hubtranslation.visual.tsx's synthetic hub in three states: off, on at
// 84% of the month's limit, and on with the key refused. Tip only (the group
// is new). No engine, no real clipboard, no OS input: Session 0 only, muted,
// offscreen; clipboard permissions denied and every clipboard path stubbed.
//   electron hubtranslation.capture.cjs <out>
// <out> is below S:\orgtree\build\<ORGTREE_AGENT>\ and holds tip\ with probe.js
// and probe.css from the visual bundle (bundle-visual.mjs ... hubtranslation).
// A fixture that never starts leaves capture-error.json with the page's own errors.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]||'')
const owner=process.env.ORGTREE_AGENT||''
if(!/^[A-Za-z0-9_-]{1,64}$/.test(owner))throw Error('ORGTREE_AGENT required')
if(!out.toLowerCase().startsWith(('s:\\orgtree\\build\\'+owner+'\\').toLowerCase()))throw Error('Output outside the owner\'s build scope')
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
  const isolated=session.fromPartition('hubtranslation-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:900,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const measured=[];let bundle=null
  try{
    const dir=path.join(out,'tip')
    if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no tip bundle in ${dir}: nothing to capture`)
    const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundle={root:s.root,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
    fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
    await within(win.loadFile(path.join(dir,'index.html')),15000,'Fixture load timeout')
    await until('window.trFixture','fixture not loaded')
    assert.equal(await evalJs('window.__clipboardBlocked'),true)
    const group=`[...document.querySelectorAll('.set-group')].find(g=>g.querySelector('.set-group-head')?.textContent==='Translation')`
    for(const theme of ['dark','light'])for(const scene of ['off','on','refused']){
      await evalJs(`window.trFixture.show('${scene}','${theme}')`)
      await until(`/Running at/.test(document.querySelector('.host-hub')?.textContent||'')&&${group}`,'translation group not drawn');await paint()
      await evalJs(`${group}.scrollIntoView({block:'start'})`);await paint()
      assert.equal(await evalJs(`document.documentElement.classList.contains('contrast-light')`),theme==='light',`drawn in ${theme}`)
      const facts=await evalJs(`(()=>{const g=${group};const r=g.getBoundingClientRect();const q=s=>g.querySelector(s);const warn=[...g.querySelectorAll('.ask-warn')].map(p=>p.textContent);
        const row=q('.set-row');const kit=document.querySelector('.host-hub .set-group .set-row');
        return{text:g.textContent,toggle:q('[aria-label="Translate messages between people"]')?.checked??null,language:q('[aria-label="Default language"]')?.value??null,
          model:q('[aria-label="Translation model"]')?.value??null,limit:q('[aria-label="Monthly translation limit (USD)"]')?.value??null,
          keyType:q('[aria-label="Anthropic API key"]')?.type??null,keyPlaceholder:q('[aria-label="Anthropic API key"]')?.placeholder??null,forget:!!q('[aria-label="Forget the Anthropic API key"]'),
          spend:[...g.querySelectorAll('[role="status"]')].map(p=>p.textContent),warn,inView:r.top>=0&&r.top<innerHeight,
          rowFont:getComputedStyle(row).fontSize,kitFont:getComputedStyle(kit).fontSize}})()`)
      const record={scene,theme,png:await shot(`tip-translation-${scene}-${theme}`),...facts}
      assert.equal(facts.keyType,'password');assert.equal(facts.model,'claude-haiku-5-5');assert.equal(facts.limit,'5');assert.equal(facts.inView,true)
      assert.equal(facts.rowFont,facts.kitFont,"its rows use the Hosting rows' type")
      assert.match(facts.text,/Message text leaves this computer/)
      if(scene==='off'){assert.equal(facts.toggle,false);assert.equal(facts.language,'en');assert.equal(facts.keyPlaceholder,'None');assert.equal(facts.forget,false);assert.deepEqual(facts.warn,[]);assert.deepEqual(facts.spend,[])}
      if(scene==='on'){assert.equal(facts.toggle,true);assert.equal(facts.keyPlaceholder,'Stored');assert.equal(facts.forget,true)
        assert.deepEqual(facts.spend,['$4.20 of $5.00 this month · 7,012 messages translated']);assert.deepEqual(facts.warn,["This month's translation spend is at 84% of its limit."])}
      if(scene==='refused'){assert.equal(facts.toggle,true);assert.equal(facts.language,'he')
        assert.deepEqual(facts.warn,['Translation stopped: Anthropic refused the API key. Paste a working key.']);assert.deepEqual(facts.spend,['$0.31 of $5.00 this month · 240 messages translated'])}
      measured.push(record)
    }
    assert.deepEqual(clipboardCalls,[])
    assert.equal(measured.length,6,`${measured.length} records`)
    const reads=await evalJs('window.trFixture.reads')
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,bundle,reads:reads.length,measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,shots:measured.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    console.error(error);console.error(JSON.stringify({pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,pageErrors,console:consoleLog,bundle,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
