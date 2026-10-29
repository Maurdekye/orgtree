// UX symmetry S6 (#19, #20, #21, #37) before (base) and after (tip), over
// s6symmetry.visual.tsx's synthetic data, default dark theme, 1024x768.
// C1 the centred agent docket: "rel" typed into its search, then Escape.
// C2 a pinned custom app panel: a move and a resize, each cancelled by
//    Escape mid-gesture, then released; the saved placement is read back.
// C3 the Presentations gallery: its search finds a match beyond the loaded
//    page, then Escape clears it.
// C4 the multi-reply composer with four targets, the desk transcript's sent
//    bubble answering four, and a sent mail preview answering four.
// No engine, no real clipboard, no OS input: Session 0 only, muted,
// offscreen; clipboard permissions denied and every clipboard path stubbed;
// input is CDP to this window alone.
//   electron s6symmetry.capture.cjs <out>
// <out> is below C:\orgtree-build\<ORGTREE_AGENT>\ and holds base\ and tip\,
// each with probe.js and probe.css from the visual bundle (fixture
// s6symmetry). A fixture that never starts leaves capture-error.json with the
// page's own errors and each bundle's source.json receipt.
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
  const isolated=session.fromPartition('s6symmetry-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1024,height:768,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const consoleLog=[];wc.on('console-message',d=>{if(d.level==='error'||d.level==='warning'){consoleLog.push({level:d.level,message:String(d.message).slice(0,2000),source:`${d.sourceId}:${d.lineNumber}`});if(consoleLog.length>40)consoleLog.shift()}})
  const evalJs=s=>wc.executeJavaScript(s),paint=()=>evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const shot=async name=>{fs.writeFileSync(path.join(out,name+'.png'),(await wc.capturePage()).toPNG());return name+'.png'}
  const show=async scene=>{await evalJs(`window.s6Fixture.show('${scene}')`);await paint()}
  // CDP input to this window only
  wc.debugger.attach('1.3')
  const cdp=(method,params)=>wc.debugger.sendCommand(method,params)
  const centre=sel=>evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  const mouse=(type,x,y,held)=>cdp('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!held?'none':'left',buttons:held?1:0,clickCount:type==='mouseMoved'?0:1,pointerType:'mouse'})
  const click=async sel=>{const p=await centre(sel);if(!p)throw Error('nothing to click: '+sel);await mouse('mousePressed',p.x,p.y,true);await mouse('mouseReleased',p.x,p.y,false);await paint()}
  const press=async name=>{await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',...KEYS[name]});await cdp('Input.dispatchKeyEvent',{type:'keyUp',...KEYS[name]});await paint()}
  const typeText=async text=>{await cdp('Input.insertText',{text});await paint()}
  const tag=async(js,label)=>{if(!await evalJs(`(()=>{document.querySelectorAll('[data-cap]').forEach(e=>e.removeAttribute('data-cap'));const e=(${js})();if(!e)return false;e.setAttribute('data-cap','1');return true})()`))throw Error('not found: '+label);return '[data-cap="1"]'}
  const fixture=what=>evalJs(`window.s6Fixture.${what}`)
  const measured=[],bundles={};let current=null
  try{
    for(const phase of ['base','tip']){
      current=phase;const dir=path.join(out,phase),tip=phase==='tip'
      if(!fs.existsSync(path.join(dir,'probe.js')))throw Error(`no ${phase} bundle in ${dir}: nothing to capture`)
      const made=path.join(dir,'source.json');if(fs.existsSync(made)){const s=JSON.parse(fs.readFileSync(made,'utf8'));bundles[phase]={root:s.root,fixture:s.fixture??null,inputs:s.inputs,deps:s.deps??null,fingerprint:s.fingerprint??null}}
      fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><script>'+pageErrorHook+'</script><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
      const server=await serve(dir);bundles[phase]={...bundles[phase],origin:`http://127.0.0.1:${server.address().port}`}
      await within(win.loadURL(`http://127.0.0.1:${server.address().port}/index.html`),15000,'Fixture load timeout')
      await until('window.s6Fixture','fixture not loaded')
      assert.equal(await evalJs('window.__clipboardBlocked'),true)

      // C1 #19: the centred agent docket, "rel" in its focused search, then Escape
      await show('docket')
      await until(`document.querySelectorAll('.docket-row').length>=4&&document.querySelector('.docket-search-input')`,'docket not drawn')
      await click('.docket-search-input');await typeText('rel')
      await until(`document.querySelectorAll('.docket-row').length===2`,'the search did not narrow the list')
      const c1={phase,check:'C1',narrowed:await evalJs(`document.querySelectorAll('.docket-row').length`),png:[await shot(`${phase}-c1-search`)]}
      await press('Escape')
      Object.assign(c1,await evalJs(`({closedAfterOne:window.s6Fixture.closed(),box:document.querySelector('.docket-search-input')?.value??null,rowsAfterOne:document.querySelectorAll('.docket-row').length})`))
      c1.png.push(await shot(`${phase}-c1-escape-once`))
      if(tip){
        assert.equal(c1.closedAfterOne,0,'the first Escape keeps the docket open');assert.equal(c1.box,'','and empties the search');assert.equal(c1.rowsAfterOne,4,'the full list is back')
        await press('Escape');c1.closedAfterTwo=await fixture('closed()');assert.equal(c1.closedAfterTwo,1,'the second Escape closes')
        c1.png.push(await shot(`${phase}-c1-escape-twice`))
      }else assert.equal(c1.closedAfterOne,1,'before: the first Escape closes the docket with the search still typed')
      measured.push(c1)

      // C2 #20: a pinned panel's move, then its resize, each cancelled by Escape mid-gesture
      await show('pinned')
      await until(`document.querySelector('[data-custom-panel="one"] .custom-app-title')&&document.querySelector('[data-custom-panel="one"]').style.left`,'pinned panel not drawn')
      const rect=()=>evalJs(`(()=>{const e=document.querySelector('[data-custom-panel="one"]');return[e.style.left,e.style.top,e.style.width,e.style.height]})()`)
      const saves=async()=>(await fixture('appCalls')).filter(c=>c.action==='panel_update'&&c.placement).length
      const c2={phase,check:'C2',png:[],from:await rect()}
      for(const [kind,sel,dx,dy] of [['move','[data-custom-panel="one"] .custom-app-title',120,60],['size','[data-custom-panel="one"] .custom-app-resize',100,80]]){
        const start=await rect(),p=await centre(sel);if(!p)throw Error('no '+kind+' handle')
        await mouse('mousePressed',p.x,p.y,true)
        for(let i=1;i<=4;i++)await mouse('mouseMoved',p.x+Math.round(dx*i/4),p.y+Math.round(dy*i/4),true)
        await paint();const during=await rect();assert.notDeepEqual(during,start,`${kind}: the gesture previews live`)
        c2.png.push(await shot(`${phase}-c2-${kind}-drag`))
        await press('Escape');const escaped=await rect();c2.png.push(await shot(`${phase}-c2-${kind}-escape`))
        await mouse('mouseReleased',p.x+dx,p.y+dy,false);await paint();await new Promise(r=>setTimeout(r,300));await paint()
        const released=await rect(),saved=await saves(),placement=await fixture('placement()')
        c2[kind]={start,during,escaped,released,savesSoFar:saved,placement}
        c2.png.push(await shot(`${phase}-c2-${kind}-release`))
        if(tip){
          assert.deepEqual(escaped,start,`${kind}: Escape puts the panel back`);assert.deepEqual(released,start,`${kind}: the release moves nothing`)
          assert.equal(saved,0,`${kind}: nothing is saved`)
          assert.deepEqual(placement,{mode:'window',x:120,y:80,width:400,height:300},`${kind}: the saved placement is unchanged`)
        }else assert.deepEqual(escaped,during,`before: Escape leaves the ${kind} going`)
      }
      if(!tip)assert.ok(c2.size.savesSoFar>=1,'before: the released gestures are saved')
      measured.push(c2)

      // C3 #21: the gallery's search finds what lies beyond the loaded page; Escape clears it first
      await show('gallery')
      await until(`document.querySelectorAll('.doc-gallery-row').length>=40`,'gallery not drawn')
      const c3={phase,check:'C3',firstPage:await evalJs(`document.querySelectorAll('.doc-gallery-row').length`),
        weeklyLoaded:await evalJs(`[...document.querySelectorAll('.doc-gallery-row')].some(r=>/Weekly digest/.test(r.textContent))`),
        searchBox:await evalJs(`!!document.querySelector('.gallery-head .docket-search-input')`),png:[await shot(`${phase}-c3-gallery`)]}
      assert.equal(c3.weeklyLoaded,false,'fixture: the weekly digest is not on the loaded page')
      if(tip){
        assert.equal(c3.searchBox,true,'the gallery header has the shared list search')
        await click('.gallery-head .docket-search-input');await typeText('weekly')
        await until(`[...document.querySelectorAll('.doc-gallery-row')].length===1&&/Weekly digest of the hub/.test(document.querySelector('.doc-gallery-row').textContent)`,'the search did not find the off-page match')
        c3.searched=(await fixture('reads')).some(r=>/\/documents\?.*search=weekly/.test(r));assert.ok(c3.searched,'the query went to the history search')
        c3.png.push(await shot(`${phase}-c3-search`))
        await press('Escape');await until(`document.querySelectorAll('.doc-gallery-row').length>=40`,'clearing did not restore the list')
        Object.assign(c3,await evalJs(`({closedAfterOne:window.s6Fixture.closed(),box:document.querySelector('.gallery-head .docket-search-input')?.value??null})`))
        assert.equal(c3.closedAfterOne,0,'Escape with text keeps the gallery open');assert.equal(c3.box,'','and empties the search')
        c3.png.push(await shot(`${phase}-c3-escape`))
      }else assert.equal(c3.searchBox,false,'before: the gallery has no search')
      measured.push(c3)

      // C4 #37: the composer's four targets, the transcript's sent bubble answering four
      await show('composer')
      await until(`document.querySelectorAll('.reply-preview-composing').length>=2&&document.querySelectorAll('.reply-preview:not(.reply-preview-composing)').length>=2`,'composer or transcript not drawn')
      const c4facts=()=>evalJs(`(()=>{const leaf=t=>[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&t.test((e.textContent||'').trim())).map(e=>e.textContent.trim())
        const composerMore=[...document.querySelectorAll('button')].filter(b=>/^and \\d+ more$/.test((b.textContent||'').trim())&&b.previousElementSibling?.classList.contains('reply-preview-composing')).map(b=>b.textContent.trim())
        const bubbleMore=[...document.querySelectorAll('button')].filter(b=>/^and \\d+ more$/.test((b.textContent||'').trim())&&!b.previousElementSibling?.classList.contains('reply-preview-composing')).map(b=>b.textContent.trim())
        return{composing:document.querySelectorAll('.reply-preview-composing').length,removes:document.querySelectorAll('.reply-preview-composing [aria-label="Remove reply"]').length,
          count:leaf(/^Replying to \\d+ messages$/),composerMore,bubble:document.querySelectorAll('.reply-preview:not(.reply-preview-composing)').length,bubbleMore,
          showFewer:[...document.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='Show fewer replies')}})()`)
      const c4={phase,check:'C4',folded:await c4facts(),png:[await shot(`${phase}-c4-composer`)]}
      if(tip){
        assert.deepEqual([c4.folded.composing,c4.folded.count,c4.folded.composerMore],[2,['Replying to 4 messages'],['and 2 more']],'folded: two targets, the count and "and 2 more"')
        assert.deepEqual([c4.folded.bubble,c4.folded.bubbleMore],[2,['and 2 more']],'the sent bubble folds the same way, without a count')
        await click(await tag(`()=>[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='and 2 more'&&b.previousElementSibling?.classList.contains('reply-preview-composing'))`,'the composer\'s "and 2 more"'))
        c4.expanded=await c4facts();c4.png.push(await shot(`${phase}-c4-composer-expanded`))
        assert.deepEqual([c4.expanded.composing,c4.expanded.removes,c4.expanded.count,c4.expanded.showFewer],[4,4,['Replying to 4 messages'],false],'expanded: four targets, a remove on each, the count 4')
        await click(await tag(`()=>[...document.querySelectorAll('.reply-preview-composing')].find(p=>/Source message 3/.test(p.textContent))?.querySelector('[aria-label="Remove reply"]')`,'the third target\'s remove'))
        c4.removed={...await c4facts(),stored:await fixture('replies()')};c4.png.push(await shot(`${phase}-c4-composer-removed`))
        assert.deepEqual([c4.removed.composing,c4.removed.count,c4.removed.stored],[3,['Replying to 3 messages'],['e1','e2','e4']],'one removed: the count reads 3, the other identities kept')
      }else{
        assert.equal(c4.folded.composing,4,'before: all four targets at once');assert.deepEqual(c4.folded.count,[],'before: no count')
        assert.equal(c4.folded.bubble,4,'before: the sent bubble lists all four')
      }
      await show('sent')
      await until(`document.querySelectorAll('.settings blockquote').length>=2`,'sent preview not drawn')
      const sent={phase,check:'C4-sent',quotes:await evalJs(`document.querySelectorAll('.settings blockquote').length`),
        more:await evalJs(`[...document.querySelectorAll('.settings button')].map(b=>(b.textContent||'').trim()).filter(t=>/^and \\d+ more$/.test(t))`),png:[await shot(`${phase}-c4-sent`)]}
      if(tip)assert.deepEqual([sent.quotes,sent.more],[2,['and 2 more']],'a sent mail preview: two and "and 2 more"')
      else assert.equal(sent.quotes,4,'before: a sent preview lists all four')
      measured.push(c4,sent)
      server.close()
    }
    assert.deepEqual(clipboardCalls,[])
    // an empty run is not a pass: both phases, every check
    assert.equal(measured.length,10,`${measured.length} records`)
    assert.deepEqual([...new Set(measured.map(r=>r.phase))],['base','tip'])
    const pngs=measured.flatMap(r=>r.png)
    const receipt={status:'PASS',pid:process.pid,sessionId,muted:wc.isAudioMuted(),offscreen:true,window:'1024x768',theme:'default dark',nativeClipboardStubbed:true,rendererClipboardBlocked:true,clipboardPermissionsDenied:true,clipboardCalls,input:'CDP Input.dispatchMouseEvent/dispatchKeyEvent/insertText to this window only',bundles,pngs,measured}
    fs.writeFileSync(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'PASS',sessionId,records:measured.length,pngs:pngs.length}));app.exit(0)
  }catch(error){
    let pageErrors=null;try{pageErrors=await within(evalJs('window.__pageErrors||null'),3000,'page errors unreadable')}catch(e){pageErrors=String(e)}
    // what the page showed when it failed: a picture, the counts the checks read, the fixture's reads
    let failure=null;try{failure={png:await within(shot(`${current}-failure`),5000,'no failure shot'),dom:await within(evalJs(`({composing:document.querySelectorAll('.reply-preview-composing').length,previews:document.querySelectorAll('.reply-preview').length,docketRows:document.querySelectorAll('.docket-row').length,galleryRows:document.querySelectorAll('.doc-gallery-row').length,panel:!!document.querySelector('[data-custom-panel]'),text:(document.body.innerText||'').slice(0,1500),reads:(window.s6Fixture?.reads||[]).slice(-40)})`),3000,'no failure dom')}}catch(e){failure=String(e)}
    console.error(error);console.error(JSON.stringify({phase:current,pageErrors,console:consoleLog.slice(-8)},null,1))
    fs.writeFileSync(path.join(out,'capture-error.json'),JSON.stringify({error:String(error),stack:error.stack,phase:current,pageErrors,failure,console:consoleLog,bundles,measured},null,2));app.exit(1)}
}).catch(error=>{console.error(error);app.exit(1)})
