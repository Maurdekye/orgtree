// Real renderer drawer width regression, with a synthetic hierarchical org
// (agentdrawerwidth-probe.tsx). Ported from agentdrawerwidth_probe.py (Python
// Playwright driving Edge) in 4.6.1. Same measurements, same assertions.
// No engine, no real clipboard, no OS input: Session 0 only, muted, offscreen;
// clipboard permissions denied and every clipboard path stubbed; input is CDP
// to this window alone.
//   node tests/attentionlayout_build.mjs <out>/build agentdrawerwidth-probe.tsx
//   electron tests/agentdrawerwidth.capture.cjs <out>
// <out> is below S:\orgtree\build\<ORGTREE_AGENT>\. Writes measurements.json,
// attention.png, canvas.png and pinned.png there; exits 0 only when every
// assertion holds.
const {app,BrowserWindow,session,clipboard}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const out=path.resolve(process.argv[2]||'')
const owner=process.env.ORGTREE_AGENT||''
if(!/^[A-Za-z0-9_-]{1,64}$/.test(owner))throw Error('ORGTREE_AGENT required')
if(!out.toLowerCase().startsWith(('s:\\orgtree\\build\\'+owner+'\\').toLowerCase()))throw Error('Output outside the owner\'s build scope')
const sessionId=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{encoding:'utf8',windowsHide:true}).trim())
assert.equal(sessionId,0,'Session 0 required before any window')
const page=path.join(out,'build','probe.html')
if(!fs.existsSync(page))throw Error(`no bundle at ${page}: run tests/attentionlayout_build.mjs first`)
app.setPath('userData',path.join(out,'profile-'+process.pid));app.setPath('sessionData',path.join(out,'session-'+process.pid))
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio')
const clipboardCalls=[]
for(const key of Object.keys(clipboard))if(typeof clipboard[key]==='function')Object.defineProperty(clipboard,key,{value:()=>{clipboardCalls.push(key);return key==='availableFormats'?[]:key==='has'?false:''}})
fs.writeFileSync(path.join(out,'clipboard.preload.cjs'),`Object.defineProperty(navigator,'clipboard',{value:Object.freeze({read:()=>Promise.reject(Error('Clipboard denied')),readText:()=>Promise.reject(Error('Clipboard denied')),write:()=>Promise.reject(Error('Clipboard denied')),writeText:()=>Promise.reject(Error('Clipboard denied'))})});window.__clipboardBlocked=true;window.__pageErrors=[];addEventListener('error',e=>window.__pageErrors.push(String(e.error&&e.error.stack||e.message)));`)

const MEASURE=`root => {
  const host = document.querySelector(root);
  const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right}};
  return [...host.querySelectorAll('.tray-row')].map(row => {
    const name=row.querySelector('.tray-name'),status=row.querySelector('.tray-status'),sum=row.querySelector('.tray-sum');
    const s=getComputedStyle(row);
    return {id:name.textContent,row:rect(row),name:rect(name),nameScroll:name.scrollWidth,
      tier:rect(row.querySelector('.tier')),status:status?rect(status):null,
      statusText:status?.textContent,summary:sum?.textContent,
      font:s.fontSize,padding:s.padding,summaryFont:sum?getComputedStyle(sum).fontSize:null};
  });
}`

/** Clearance is two-dimensional: the toggle may sit below the filter. */
const separated=(a,b)=>a.x>=b.x+b.width||b.x>=a.x+a.width||a.y>=b.y+b.height||b.y>=a.y+a.height

app.whenReady().then(async()=>{
  const isolated=session.fromPartition('agentdrawerwidth-'+process.pid)
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_wc,_p,done)=>done(false))
  const win=new BrowserWindow({width:1600,height:900,useContentSize:true,show:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:false,sandbox:false,nodeIntegration:false,preload:path.join(out,'clipboard.preload.cjs'),session:isolated}})
  const wc=win.webContents;wc.setAudioMuted(true);wc.setWindowOpenHandler(()=>({action:'deny'}))
  for(const method of ['cut','copy','paste','pasteAndMatchStyle'])wc[method]=()=>{throw Error('Clipboard command forbidden')}
  const evalJs=s=>wc.executeJavaScript(s)
  const wait=ms=>new Promise(r=>setTimeout(r,ms))
  const until=(expr,label)=>evalJs(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function poll(){try{if(${expr})return resolve(true)}catch(e){}if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(poll,40)})()})`)
  const box=selector=>evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
  const attr=(selector,name)=>evalJs(`document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(name)})`)
  const shot=async name=>fs.writeFileSync(path.join(out,name),(await wc.capturePage()).toPNG())
  wc.debugger.attach('1.3')
  // A real pointer click (CDP, to this window only), at an offset inside the element.
  const click=async(selector,at)=>{
    const r=await box(selector)
    const x=r.x+(at?at.x:r.width/2),y=r.y+(at?at.y:r.height/2)
    for(const type of ['mouseMoved','mousePressed','mouseReleased'])
      await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})
  }
  const button=name=>`button[aria-label=${JSON.stringify(name)}]`
  // A hash-only change is a same-document navigation and would leave the old
  // scene mounted: each scene starts from a blank document and shows its hash.
  const load=async hash=>{await win.loadURL('about:blank');await win.loadFile(page,{hash});await until(`location.hash===${JSON.stringify('#'+hash)}&&document.querySelector("#root")?.childElementCount>0`,'the probe page never rendered scene '+hash)}
  const result={errors:[],session:sessionId}
  try{
    await load('attention')
    await until(`document.querySelector(${JSON.stringify(button('Open the agents list'))})`,'no agents-list button')
    await click(button('Open the agents list'))
    await wait(250)
    result.drawer=await evalJs(`(${MEASURE})('.attn-agents')`)
    result.bounds=await box('.attn-agents-wrap')
    result.filter=await box('.attn-agents .tray-filter')
    result.toggle=await box('.attn-agents-toggle')
    await shot('attention.png')
    // Rows in the reclaimed space remain clickable; the rail cannot cover them.
    const child='[data-attn-agent="p03-ws1-pgservice"]'
    await click(child,{x:2,y:8})
    await wait(100)
    result.childSelected=await attr(child,'aria-selected')
    result.closedAfterPick=await attr('.attn-agents-wrap','class')
    assert.ok(!result.closedAfterPick.includes('list-open'),'picking an agent leaves the drawer open')
    await click(button('Open the agents list'))
    await wait(100)
    // Resize while open: the measured rail follows zoom/font changes.
    await evalJs(`document.querySelector('.attn-agents-toggle').style.width='50px'`)
    await wait(100)
    result.wideToggleFilter=await box('.attn-agents .tray-filter')
    result.wideToggle=await box('.attn-agents-toggle')
    await click(button('Close the agents list'))
    await wait(100)
    result.closed=await attr('.attn-agents-wrap','class')
    await load('canvas')
    await click('.tray-toggle')
    await until(`document.querySelector('.tray-wrap .tray-row')`,'the canvas tray never listed a row')
    result.canvas=await evalJs(`(${MEASURE})('.tray-wrap')`)
    await shot('canvas.png')
    await load('pinned')
    await until(`document.querySelector('.pinwin .desk-body')`,'no pinned desk')
    result.pinned=await evalJs(`(()=>{const e=document.querySelector('.pinwin');const r=e.getBoundingClientRect();const h=e.querySelector('.desk-body');return {width:r.width,height:r.height,bodyFont:getComputedStyle(h).fontSize,text:h.textContent}})()`)
    await shot('pinned.png')
    result.errors=await evalJs('window.__pageErrors')
  }catch(error){
    result.failure=String(error&&error.stack||error)
  }finally{
    result.clipboardCalls=clipboardCalls
    fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(result,null,2))
  }
  try{
    if(result.failure)throw Error(result.failure)
    const rows=result.drawer
    // Controls for the geometry instrument: an overlap must fail even when the
    // rectangles have different origins; vertical separation is valid clearance.
    const square={x:0,y:0,width:20,height:20}
    assert.ok(!separated(square,{...square,x:10,y:10}))
    assert.ok(separated(square,{...square,y:30}))
    assert.equal(rows.length,4,JSON.stringify(rows))
    assert.ok(rows[0].row.x<=result.bounds.x+5,'rows still waste the toggle rail')
    assert.deepEqual(rows.slice(0,3).map(r=>r.tier.x-rows[0].tier.x),[0,14,28],JSON.stringify(rows))
    assert.ok(separated(result.filter,result.toggle),JSON.stringify(result))
    assert.ok(separated(result.wideToggleFilter,result.wideToggle),JSON.stringify(result))
    // Widening the toggle must still update the measured rail and usable list
    // width, even when the filter is vertically clear of the toggle.
    const railGrowth=result.wideToggle.width-result.toggle.width
    const filterGrowth=result.wideToggleFilter.width-result.filter.width
    assert.ok(railGrowth>0&&Math.abs(filterGrowth-railGrowth)<1,JSON.stringify(result))
    assert.equal(result.childSelected,'true',JSON.stringify(result))
    assert.ok(!result.closed.includes('list-open'),JSON.stringify(result))
    assert.deepEqual(result.errors,[],JSON.stringify(result.errors))
    assert.deepEqual(clipboardCalls,[],'the clipboard was touched')
    console.log('PASS: rail reclaimed; hierarchy, filter clearance, resize, row click, collapse, Canvas and pin measured')
    app.exit(0)
  }catch(error){
    console.error(String(error&&error.stack||error))
    app.exit(1)
  }
}).catch(error=>{console.error(error);app.exit(1)})
