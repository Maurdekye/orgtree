// The hire dialog's (Draft settings) Harness row
// (@item:orgtree/harness-everywhere-harness-row-in-the-hire-dialo) before
// (base) and after (tip), over hireharness.visual.tsx's synthetic data,
// default dark theme, 1024x768.
// D1 an OpenRouter draft following its key; D2 the same draft with a harness
//    of its own staged; D5 (tip) choosing one stages it for this model; D3 a
//    draft on a custom language model server: Follow server, and the other
//    API family disabled with its reason; D4 a Claude draft: no row, no read.
// No engine, no real clipboard, no OS input: Session 0 only, muted,
// offscreen; clipboard permissions denied and every clipboard path stubbed;
// input is CDP and script in this window alone.
//   electron hireharness.capture.cjs <out>
// <out> is below S:\orgtree\build\<ORGTREE_AGENT>\ and holds base\ and tip\,
// each with probe.js and probe.css from the visual bundle (fixture
// hireharness). A fixture that never starts leaves capture-error.json with
// the page's own errors and each bundle's source.json receipt.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process'),http=require('node:http')
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
const KEYS={Escape:{key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27}}
// The page is served over http on 127.0.0.1, as the app's renderer is: a custom
// app panel builds its media URL from location.href and refuses file:. GET of a
// file inside the phase folder only; one server per phase, so base and tip get
// separate origins (and separate storage).
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.eot':'application/vnd.ms-fontobject','.svg':'image/svg+xml','.png':'image/png'}
const serve=dir=>new Promise((resolve,reject)=>{const server=http.createServer((req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1'),file=path.resolve(dir,'.'+decodeURIComponent(u.pathname))
  if(req.method!=='GET'||!file.startsWith(dir+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res)}catch{res.writeHead(400).end()}})
  server.on('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server))})
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('hireharness-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:768,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async scene=>{await evalJs(`window.harnessFixture.show('${scene}')`);await paint()}
  // CDP input to this window only
  wc.debugger.attach('1.3')
  const cdp=(method,params)=>wc.debugger.sendCommand(method,params)
  const centre=sel=>evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  const mouse=(type,x,y,held)=>cdp('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!held?'none':'left',buttons:held?1:0,clickCount:type==='mouseMoved'?0:1,pointerType:'mouse'})
  const click=async sel=>{const p=await centre(sel);if(!p)throw Error('nothing to click: '+sel);await mouse('mousePressed',p.x,p.y,true);await mouse('mouseReleased',p.x,p.y,false);await paint()}
  const press=async name=>{await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',...KEYS[name]});await cdp('Input.dispatchKeyEvent',{type:'keyUp',...KEYS[name]});await paint()}
  const typeText=async text=>{await cdp('Input.insertText',{text});await paint()}
  const tag=async(js,label)=>{if(!await evalJs(`(()=>{document.querySelectorAll('[data-cap]').forEach(e=>e.removeAttribute('data-cap'));const e=(${js})();if(!e)return false;e.setAttribute('data-cap','1');return true})()`))throw Error('not found: '+label);return '[data-cap="1"]'}
  const fixture=what=>evalJs(`window.harnessFixture.${what}`)
  const measured=[],bundles={};let current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase),tip=phase==='tip'
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      const server=await serve(dir);bundles[phase]={...bundles[phase],origin:`http://127.0.0.1:${server.address().port}`}
      await within(win.loadURL(`http://127.0.0.1:${server.address().port}/index.html`),15000,'Fixture load timeout')
      await until('window.harnessFixture','fixture not loaded')
      assert.equal(await evalJs('window.__clipboardBlocked'),true)

      // the draft's Model tab and its Harness row, as the checks read them
      const row=`document.querySelector('select[aria-label="Agent harness"]')`
      const modelTab=`document.querySelector('[role="tabpanel"]:not([hidden]) select[aria-label="Model tier"]')`
      const rowFacts=()=>evalJs(`(()=>{const s=${row};if(!s)return null;return{value:s.value,disabled:s.disabled,options:[...s.options].map(o=>({value:o.value,text:(o.textContent||'').trim(),disabled:o.disabled,title:o.title||''})),hint:(s.closest('.set-row')?.querySelector('.set-hint')?.textContent||'').trim()}})()`)
      const choose=(sel,value)=>evalJs(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`).then(paint)
      const drawn=async(scene,withRow)=>{await show(scene);await until(modelTab,'the draft Model tab is not drawn');if(withRow)await until(row,'no Harness row');await paint()}

      // D1: an OpenRouter draft following its key
      await drawn('or-follow',tip)
      const d1={phase,check:'D1',row:await rowFacts(),png:[await shot(`${phase}-d1-openrouter-follow`)]}
      if(tip){
        assert.equal(d1.row.value,'','a draft follows its key by default')
        assert.equal(d1.row.options[0].text,'Follow key (Codex)','Follow names the key harness')
        assert.deepEqual(d1.row.options.filter(o=>o.disabled&&o.value!=='__harness-separator__').map(o=>o.value),['opencode'],'only the uninstalled harness is disabled')
        assert.equal(d1.row.hint,'Follows its key (team budget).')
      }else assert.equal(d1.row,null,'before: the draft Model tab has no Harness row')
      measured.push(d1)

      // D2: the same draft with a harness of its own staged
      await drawn('or-own',tip)
      const d2={phase,check:'D2',row:await rowFacts(),png:[await shot(`${phase}-d2-openrouter-own`)]}
      if(tip){
        assert.equal(d2.row.value,'claude-code','the staged harness is the value')
        assert.equal(d2.row.hint,'Its own choice: it starts on Claude Code and keeps it when its key (team budget) changes harness.')
      }else assert.equal(d2.row,null,'before: no Harness row')
      measured.push(d2)

      if(tip){
        // D5: choosing a harness stages it in the draft, for this model only
        await drawn('or-follow',true)
        await choose('select[aria-label="Agent harness"]','codex-cli')
        await until(`window.harnessFixture.staged.some(s=>s.harness==='codex-cli')`,'the choice was not staged')
        const d5={phase,check:'D5',row:await rowFacts(),png:[await shot(`${phase}-d5-openrouter-choose`)]}
        const last=(await fixture('staged')).at(-1)
        d5.staged={harness:last.harness,harness_tier:last.harness_tier}
        assert.deepEqual(d5.staged,{harness:'codex-cli',harness_tier:'or-moonshotai-kimi-k3'},'staged for this model')
        assert.equal(d5.row.hint,'Its own choice: it starts on Codex and keeps it when its key (team budget) changes harness.')
        measured.push(d5)
      }

      // D3: a draft on a custom language model server
      await drawn('server',tip)
      const d3={phase,check:'D3',row:await rowFacts(),png:[await shot(`${phase}-d3-server-follow`)]}
      if(tip){
        assert.equal(d3.row.options[0].text,'Follow server (Claude Code)','Follow names the server harness')
        const codex=d3.row.options.find(o=>o.value==='codex-cli')
        assert.equal(codex.disabled,true,'the other API family is disabled');assert.match(codex.title,/base path/,'and says why')
        assert.match(codex.text,/unavailable/);assert.equal(d3.row.hint,'Follows its server (Gateway).')
      }else assert.equal(d3.row,null,'before: no Harness row')
      measured.push(d3)

      // D4: a Claude draft has no harness choice, before or after, and reads nothing
      await drawn('claude',false)
      await paint()
      const d4={phase,check:'D4',row:await rowFacts(),png:[await shot(`${phase}-d4-claude-none`)]}
      assert.equal(d4.row,null,'a Claude draft has no Harness row')
      d4.reads=(await fixture('reads')).filter(r=>r.includes('hire-harness')&&r.includes('tier=opus'))
      assert.deepEqual(d4.reads,[],'and reads nothing for it')
      measured.push(d4)
      server.close()
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: both phases, every check
    assert.equal(measured.length,9,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const pngs=measured.flatMap(r=>r.png)
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,window:'1024x768',theme:'default dark',nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,input:'CDP Input.dispatchMouseEvent/dispatchKeyEvent/insertText to this window only',bundles,pngs,measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length,pngs:pngs.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    // what the page showed when it failed: a picture, the counts the checks read, the fixture's reads
    let failure=null;try{failure={png:await within(shot(`${current}-failure`),5000,'no failure shot'),dom:await within(evalJs(`({row:!!document.querySelector('select[aria-label="Agent harness"]'),modelSwitch:!!document.querySelector('.model-switch'),tabs:document.querySelectorAll('[role="tab"]').length,panels:document.querySelectorAll('[role="tabpanel"]').length})`),3000,'no failure dom')}}catch(e){failure=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,failure,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
