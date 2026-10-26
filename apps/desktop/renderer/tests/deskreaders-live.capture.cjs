'use strict'
const {app,BrowserWindow,session,clipboard,nativeImage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {createRequire}=require('node:module'),{execFileSync}=require('node:child_process')
const repo=path.resolve(__dirname,'../../../..'),out=process.env.DESK_READERS_CAPTURE
assert.match(out||'',/^C:\/orgtree-build\/native-tools-sol\/desk-readers-live\/capture-[0-9]+$/)
const deps=createRequire(process.env.ORGTREE_TEST_DEPS||path.join(repo,'package.json'))
const measure=pid=>{
  const session=Number(execFileSync('powershell.exe',['-NoProfile','-Command','(Get-Process -Id '+pid+').SessionId'],{encoding:'utf8',windowsHide:true}).trim())
  assert.equal(session,0,'capture process must be in Session 0')
  return {pid,session}
}
fs.mkdirSync(out,{recursive:true})
const receipt={source:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),parent:measure(process.pid),
  clipboard:'Empty private reads; native clipboard writes and edit methods blocked; all session permissions denied',
  input:'CDP Runtime.evaluate in owned Session 0 window; synthetic feed commits only',
  limits:'Real DeskChat/ProjectDesk, RecordFeed and styles with synthetic fetch; no engine, live data, native clipboard or desktop timing proof'}
for(const key of ['userData','sessionData','logs','crashDumps']){const p=path.join(out,'profile',key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}
for(const key of ['readText','readHTML','readRTF','readBookmark','readFindText'])clipboard[key]=()=>''
clipboard.readImage=()=>nativeImage.createEmpty();clipboard.availableFormats=()=>[]
for(const key of ['write','writeText','writeHTML','writeRTF','clear','writeImage','writeBookmark','writeFindText'])clipboard[key]=()=>{throw Error('Clipboard denied')}
app.disableHardwareAcceleration()
let win,timer
app.whenReady().then(async()=>{
  timer=setTimeout(()=>finish(Error('capture deadline')),45000)
  const esbuild=deps('esbuild'),nodePaths=[path.dirname(path.dirname(deps.resolve('esbuild/package.json')))]
  try{
    await esbuild.build({entryPoints:[path.join(__dirname,'deskreaders-live.visual.tsx')],outfile:path.join(out,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths,define:{'process.env.NODE_ENV':'"production"'}})
    await esbuild.build({stdin:{contents:'@import "./styles.css";\n@import "./shell.css";',resolveDir:path.join(repo,'apps/desktop/renderer/src'),loader:'css'},outfile:path.join(out,'fixture.css'),bundle:true,nodePaths,loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'}})
  }finally{esbuild.stop()}
  fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const ses=session.fromPartition('desk-readers-'+process.pid)
  ses.setPermissionRequestHandler((_a,_b,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false)
  ses.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file:')&&!/^(data:|about:blank|blob:)/.test(d.url)}))
  win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,focusable:false,
    webPreferences:{session:ses,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  for(const method of ['copy','cut','paste','pasteAndMatchStyle','selectAll'])win.webContents[method]=()=>{throw Error('Native edit denied')}
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  await win.loadFile(path.join(out,'index.html'))
  receipt.renderer=measure(win.webContents.getOSProcessId())
  win.webContents.debugger.attach('1.3')
  const js=async expression=>{
    const answer=await win.webContents.debugger.sendCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
    if(answer.exceptionDetails)throw Error(JSON.stringify(answer.exceptionDetails))
    return answer.result.value
  }
  const painted=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))')
  const state=()=>js(`({...window.deskReaderFixture.state(),now:performance.now(),size:{width:innerWidth,height:innerHeight},desks:[...document.querySelectorAll('[data-reader]')].map(el=>({kind:el.dataset.reader,active:el.querySelector('.cc-tabs button.on')?.dataset.tab,tabs:[...el.querySelectorAll('.cc-tabs button')].map(b=>({id:b.dataset.tab,box:b.getBoundingClientRect().toJSON()}))}))})`)
  await painted()
  receipt.before=await state()
  assert.equal(receipt.before.desks.length,2);assert.equal(receipt.before.reads.length,2)
  for(const desk of receipt.before.desks)assert(!desk.tabs.some(t=>t.id==='presented'||t.id==='docket'),'empty tabs initially hidden')
  const presentedAt=await js('window.deskReaderFixture.arrive("presented")')
  await painted();receipt.presented=await state()
  for(const desk of receipt.presented.desks){assert(desk.tabs.some(t=>t.id==='presented'));assert(!desk.tabs.some(t=>t.id==='docket'))}
  const workAt=await js('window.deskReaderFixture.arrive("work")')
  await painted();receipt.after=await state()
  for(const desk of receipt.after.desks){
    assert.equal(desk.active,desk.kind==='agent'?'chat':'desk')
    for(const id of ['presented','docket']){
      const tab=desk.tabs.find(t=>t.id===id);assert(tab,'first arrival tab '+id)
      const b=tab.box;assert(b.width>0&&b.height>0&&b.left>=0&&b.top>=0&&b.right<=receipt.after.size.width&&b.bottom<=receipt.after.size.height,'tab has visible on-screen geometry')
    }
  }
  receipt.presentedMs=receipt.presented.now-presentedAt;receipt.workMs=receipt.after.now-workAt
  assert(receipt.presentedMs<1500&&receipt.workMs<1500,'event refresh finishes well before 15 s fallback')
  assert.equal(receipt.after.reads.length,6);assert.equal(receipt.after.liveRevision,receipt.before.liveRevision,'no legacy live bump')
  const png=await win.webContents.capturePage();assert(!png.isEmpty());receipt.image=png.getSize()
  fs.writeFileSync(path.join(out,'desk-first-arrivals.png'),png.toPNG())
  finish()
}).catch(finish)
function finish(error){
  if(receipt.finished)return
  receipt.finished=new Date().toISOString();clearTimeout(timer)
  if(win&&!win.isDestroyed())win.destroy()
  receipt.status=error?1:0;if(error)receipt.error=String(error.stack||error)
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));app.exit(receipt.status)
}
