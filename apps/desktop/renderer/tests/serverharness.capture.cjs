// Language model server edit dialog's Harness field
// (@item:orgtree/language-model-server-entries-harness-can-be-edi) before
// (base) and after (tip), over serverharness.visual.tsx's synthetic data,
// default dark theme, 1024x768.
// S1 Configure Ollama before any edit (base: no Harness select; tip: Harness
//    select with installed first, uninstalled disabled after separator, and
//    follower/pinned seat counts);
// S2 (tip) choosing Codex in Configure Ollama shows the next-turn fresh-session
//    move notice and follower/pinned counts, and clicking Save sends PATCH
//    {harness:'codex-cli'} and updates the server card row to Codex;
// S3 Configure Custom gateway: at tip, changing the API family (Claude Code ->
//    Codex) clears the old family's base path, disables Save until a base path
//    is entered, and warns that 2 pinned agents on the other API family will be
//    refused at launch until re-pinned.
// No engine, no real clipboard, no OS input: Session 0 only, muted,
// offscreen; clipboard permissions denied and every clipboard path stubbed;
// input is CDP and script in this window alone.
//   electron serverharness.capture.cjs <out>
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process'),http=require('node:http')
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
const pageErrorHook="window.__pageErrors=[];addEventListener('error',e=>{const t=e.target;window.__pageErrors.push(t&&t!==window?'failed to load '+(t.src||t.href||t.tagName):String(e.error&&e.error.stack||e.message).slice(0,4000))},true);addEventListener('unhandledrejection',e=>window.__pageErrors.push('unhandled rejection: '+String(e.reason&&e.reason.stack||e.reason).slice(0,4000)))"
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.eot':'application/vnd.ms-fontobject','.svg':'image/svg+xml','.png':'image/png'}
const serve=dir=>new Promise((resolve,reject)=>{const server=http.createServer((req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1'),file=path.resolve(dir,'.'+decodeURIComponent(u.pathname))
  if(req.method!=='GET'||!file.startsWith(dir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res)}catch{res.writeHead(400).end()}})
  server.on('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server))})
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('serverharness-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:768,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async scene=>{await evalJs(`window.serverHarnessFixture.show('${scene}')`);await paint()}
  wc.debugger.attach('1.3')
  const cdp=(method,params)=>wc.debugger.sendCommand(method,params)
  const centre=sel=>evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  const mouse=(type,x,y,held)=>cdp('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!held?'none':'left',buttons:held?1:0,clickCount:type==='mouseMoved'?0:1,pointerType:'mouse'})
  const click=async sel=>{const p=await centre(sel);if(!p)throw Error('nothing to click: '+sel);await mouse('mousePressed',p.x,p.y,true);await mouse('mouseReleased',p.x,p.y,false);await paint()}
  const choose=(sel,value)=>evalJs(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}))})()`).then(paint)
  const setInput=(sel,value)=>evalJs(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`).then(paint)
  const tag=async(js,label)=>{if(!await evalJs(`(()=>{document.querySelectorAll('[data-cap]').forEach(e=>e.removeAttribute('data-cap'));const e=(${js})();if(!e)return false;e.setAttribute('data-cap','1');return true})()`))throw Error('not found: '+label);return '[data-cap="1"]'}
  const measured=[],bundles={};let current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase),tip=phase==='tip'
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      const server=await serve(dir);bundles[phase]={...bundles[phase],origin:`http://127.0.0.1:${server.address().port}`}
      await within(win.loadURL(`http://127.0.0.1:${server.address().port}/index.html`),15000,'Fixture load timeout')
      await until('window.serverHarnessFixture','fixture not loaded')
      assert.equal(await evalJs('window.__clipboardBlocked'),true)

      const rowFacts=()=>evalJs(`(()=>{const s=document.querySelector('.ls-edit select[aria-label="Harness"]');if(!s)return null;return{value:s.value,disabled:s.disabled,options:[...s.options].map(o=>({value:o.value,text:(o.textContent||'').trim(),disabled:o.disabled,title:o.title||''})),hint:(s.closest('.set-row')?.querySelector('.set-hint')?.textContent||'').trim(),warns:[...document.querySelectorAll('.ls-edit .ask-warn-inline')].map(e=>(e.textContent||'').trim()),helpLink:!!document.querySelector('.ls-edit .harness-help-link')}})()`)
      const openEdit=async scene=>{
        await show(scene)
        await until(`document.querySelector('.ls-server-row button[title="Edit this server"]')`,'no Edit button')
        await click('.ls-server-row button[title="Edit this server"]')
        await until(`document.querySelector('.ls-edit')`,'edit dialog did not open')
        await paint()
      }

      // S1: Configure Ollama before any edit
      await openEdit('ollama')
      const s1={phase,check:'S1',row:await rowFacts(),png:[await shot(`${phase}-s1-ollama-edit`)]}
      if(tip){
        assert.equal(s1.row.value,'claude-code')
        assert.deepEqual(s1.row.options.map(o=>o.value),['claude-code','codex-cli','__harness-separator__','opencode'])
        assert.equal(s1.row.options[3].disabled,true)
        assert.equal(s1.row.options[3].text,'OpenCode (ACP) (not installed)')
        assert.equal(s1.row.helpLink,true)
        assert.match(s1.row.hint,/3 agents follow this server and move at their next turn on a fresh session; 2 pinned agents keep their harness/)
      }else assert.equal(s1.row,null,'before: the server edit dialog has no Harness select')
      measured.push(s1)

      if(tip){
        // S2: choose Codex in Configure Ollama, verify hint + counts, click Save, verify PATCH and updated card
        await choose('.ls-edit select[aria-label="Harness"]','codex-cli')
        const s2={phase,check:'S2',row:await rowFacts(),png:[await shot(`${phase}-s2-ollama-change`)]}
        assert.match(s2.row.hint,/Moves to Codex at the next turn with a summary\. 3 agents follow this server and move at their next turn on a fresh session; 2 pinned agents keep their harness\./)
        await tag(`()=>[...document.querySelectorAll('.ls-edit button')].find(b=>(b.textContent||'').trim()==='Save')`,'no Save button')
        await evalJs(`document.querySelector('[data-cap]').scrollIntoView({block:'center'})`);await paint()
        await click('[data-cap]')
        await until(`!document.querySelector('.ls-edit')`,'Save did not close Configure Ollama')
        s2.patches=await evalJs('window.serverHarnessFixture.patches')
        assert.deepEqual(s2.patches,[{path:'/api/langservers/ollama',body:{harness:'codex-cli'}}])
        s2.head=await evalJs(`(document.querySelector('.ls-server-head')?.textContent||'').trim()`)
        assert.match(s2.head,/Ollama · Ollama · Codex · http:\/\/127\.0\.0\.1:11434\/v1/)
        s2.png.push(await shot(`${phase}-s2-ollama-saved`))
        measured.push(s2)
      }

      // S3: Configure Custom gateway (at tip, switch API family -> requires base path + warns about pinned seats on other family)
      await openEdit('custom')
      if(tip){
        await choose('.ls-edit select[aria-label="Harness"]','codex-cli')
      }
      const s3={phase,check:'S3',row:await rowFacts(),png:[await shot(`${phase}-s3-custom-edit`)]}
      if(tip){
        const customState=await evalJs(`(()=>{const bp=document.querySelector('.ls-edit input[aria-label="Base path"]');const save=[...document.querySelectorAll('.ls-edit button')].find(b=>(b.textContent||'').trim()==='Save');return{basePath:bp?bp.value:null,saveDisabled:save?save.disabled:null}})()`)
        assert.equal(customState.basePath,'','changing API family clears the old family base path')
        assert.equal(customState.saveDisabled,true,'Save is disabled until a base path is given')
        assert.match(s3.row.hint,/1 agent follows this server and moves at its next turn on a fresh session; 2 pinned agents keep their harness/)
        assert.ok(s3.row.warns.some(w=>w.includes('2 pinned agents are on the other API family and will be refused at launch until re-pinned')),`warns: ${JSON.stringify(s3.row.warns)}`)
        await setInput('.ls-edit input[aria-label="Base path"]','v1')
        const afterPath=await evalJs(`(()=>{const save=[...document.querySelectorAll('.ls-edit button')].find(b=>(b.textContent||'').trim()==='Save');return{saveDisabled:save?save.disabled:null}})()`)
        assert.equal(afterPath.saveDisabled,false,'Save is enabled once a base path is given')
        s3.customState={...customState,afterPathSaveDisabled:afterPath.saveDisabled}
      }else assert.equal(s3.row,null,'before: no Harness select on custom server edit dialog')
      measured.push(s3)
      server.close()
    }
    assert.deepEqual(clipboardCalls,[])
    assert.equal(measured.length,5,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const pngs=measured.flatMap(r=>r.png)
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,window:'1024x768',theme:'default dark',nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,input:'CDP Input.dispatchMouseEvent/dispatchKeyEvent/insertText to this window only',bundles,pngs,measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length,pngs:pngs.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    let failure=null;try{failure={png:await within(shot(`${current}-failure`),5000,'no failure shot'),dom:await within(evalJs(`({editOpen:!!document.querySelector('.ls-edit'),row:!!document.querySelector('.ls-edit select[aria-label="Harness"]')})`),3000,'no failure dom')}}catch(e){failure=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,failure,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
